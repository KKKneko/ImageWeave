from __future__ import annotations

import asyncio
import random
import time
from collections import Counter
from pathlib import Path
from typing import Any, Awaitable, Callable

from .classifier import FailureDecision, classify_result
from .config import SchedulerSettings
from .database import Database, TERMINAL_STATUSES
from .gallery import GalleryRunner
from .log_writer import TaskLogWriter
from .process_control import terminate_stale_process
from .proxy import ProxyLease, ProxyPoolAdapter, ProxyPoolUnavailable
from .redaction import redact_text
from .schemas import TaskPolicy


_DISPATCH_REFILL_ROUNDS = 2


class TaskScheduler:
    def __init__(
        self,
        database: Database,
        gallery: GalleryRunner,
        proxy: ProxyPoolAdapter,
        settings: SchedulerSettings,
        log_writer: TaskLogWriter,
        *,
        credential_validator: Callable[[str, str | None], bool] | None = None,
        auth_failure_callback: Callable[[str, str | None, str], Awaitable[bool]] | None = None,
    ) -> None:
        self.db = database
        self.gallery = gallery
        self.proxy = proxy
        self.settings = settings
        self.log_writer = log_writer
        self.credential_validator = credential_validator
        self.auth_failure_callback = auth_failure_callback
        self._loop_task: asyncio.Task | None = None
        self._active: dict[str, tuple[asyncio.Task, str]] = {}
        self._credential_blocked: set[str] = set()
        self._wake = asyncio.Event()
        self._stopping = False

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        await self.log_writer.start()
        self._stopping = False
        stale = self.db.incomplete_processes()
        for item in stale:
            await asyncio.to_thread(
                terminate_stale_process,
                item.get("pid"),
                item.get("process_marker"),
            )
        self.db.recover_incomplete()
        self._loop_task = asyncio.create_task(self._dispatch_loop(), name="gallery-task-dispatcher")
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self._loop_task is not None:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
            self._loop_task = None
        await self.gallery.stop_all()
        tasks = [item[0] for item in self._active.values()]
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=self.settings.shutdown_grace_seconds,
                )
            except asyncio.TimeoutError:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        self._active.clear()
        await self.log_writer.stop()

    def notify(self) -> None:
        self._wake.set()

    def _policy(self, task: dict[str, Any]) -> TaskPolicy:
        return TaskPolicy.model_validate(task.get("policy") or {})

    def _allowed_proxy_ids(self, policy: TaskPolicy) -> set[str] | None:
        if policy.allowed_proxy_ids is not None:
            return set(policy.allowed_proxy_ids)
        if not policy.proxy_probe_scope:
            return None
        probe = self.db.get_crawl_address_proxy_probe(policy.proxy_probe_scope)
        return set(probe["node_ids"]) if probe is not None else set()

    async def _dispatch_loop(self) -> None:
        while not self._stopping:
            try:
                self._wake.clear()
                self._reap_finished()
                if self._credential_blocked:
                    blocked_snapshot = set(self._credential_blocked)
                    queued_blocked = await asyncio.to_thread(
                        self.db.queued_task_ids,
                        blocked_snapshot,
                    )
                    self._credential_blocked.intersection_update(queued_blocked)
                capacity = self.settings.max_concurrent_tasks - len(self._active)
                if capacity > 0:
                    active_sites = Counter(site for _, site in self._active.values())
                    saturated_sites: set[str] = set()
                    for _dispatch_round in range(_DISPATCH_REFILL_ROUNDS + 1):
                        queued = self.db.queued_tasks(
                            limit=200,
                            exclude_sites=saturated_sites or None,
                        )
                        if not queued:
                            break
                        hit_site_limit = False
                        for task in queued:
                            if capacity <= 0:
                                break
                            task_id = task["id"]
                            policy = self._policy(task)
                            site = task["site"]
                            if self.credential_validator and not self.credential_validator(
                                site,
                                task.get("cookies_file"),
                            ):
                                if task_id not in self._credential_blocked:
                                    recorded = await asyncio.to_thread(
                                        self.db.mark_task_credentials_unavailable,
                                        task_id,
                                        site,
                                    )
                                    if recorded:
                                        self._credential_blocked.add(task_id)
                                continue
                            self._credential_blocked.discard(task_id)
                            if active_sites[site] >= policy.max_concurrency:
                                saturated_sites.add(site)
                                hit_site_limit = True
                                continue
                            if not self.db.claim_task(task_id):
                                continue
                            worker = asyncio.create_task(
                                self._execute(task_id),
                                name=f"gallery-task-{task_id}",
                            )
                            self._active[task_id] = (worker, site)
                            active_sites[site] += 1
                            capacity -= 1
                            worker.add_done_callback(
                                lambda _done, task_id=task_id: self._worker_done(task_id)
                            )
                        if capacity <= 0 or not hit_site_limit:
                            break
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self.settings.poll_interval_seconds)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(self.settings.poll_interval_seconds)

    def _worker_done(self, task_id: str) -> None:
        self._active.pop(task_id, None)
        self._wake.set()

    def _reap_finished(self) -> None:
        for task_id, (worker, _) in list(self._active.items()):
            if worker.done():
                self._active.pop(task_id, None)

    async def cancel(self, task_id: str) -> dict[str, Any] | None:
        task = self.db.request_cancel(task_id)
        if task is None:
            return None
        if task["status"] == "cancelling":
            await self.gallery.cancel(task_id)
        self._wake.set()
        return self.db.get_task(task_id)

    def retry(self, task_id: str, additional_attempts: int) -> dict[str, Any] | None:
        task = self.db.retry_task(task_id, additional_attempts)
        self._wake.set()
        return task

    def active_summary(self) -> dict[str, Any]:
        active = list(self._active.values())
        sites = Counter(site for _, site in active)
        return {
            "running": not self._stopping and self._loop_task is not None,
            "active": len(active),
            "max_concurrent": self.settings.max_concurrent_tasks,
            "sites": dict(sites),
        }

    @staticmethod
    def _scan_artifacts(output_dir: str) -> tuple[int, int]:
        root = Path(output_dir)
        if not root.is_dir():
            return 0, 0
        count = 0
        total = 0
        for path in root.rglob("*"):
            try:
                if path.is_file() and not path.name.lower().endswith(".part") and not path.name.startswith(".gdl-activity-"):
                    count += 1
                    total += path.stat().st_size
            except OSError:
                continue
        return count, total

    @staticmethod
    def _artifact_from_output(line: str, output_dir: str) -> Path | None:
        value = str(line or "").strip()
        if value.startswith("# "):
            value = value[2:].strip()
        if not value:
            return None
        path = Path(value)
        if not path.is_absolute():
            return None
        try:
            resolved = path.resolve()
            root = Path(output_dir).resolve()
            if not resolved.is_relative_to(root) or not resolved.is_file():
                return None
        except (OSError, ValueError):
            return None
        if resolved.name.lower().endswith(".part") or resolved.name.startswith(".gdl-activity-"):
            return None
        return resolved

    @staticmethod
    def _artifact_totals(paths: set[Path]) -> tuple[int, int]:
        count = 0
        total = 0
        for path in paths:
            try:
                if path.is_file():
                    count += 1
                    total += path.stat().st_size
            except OSError:
                continue
        return count, total

    @staticmethod
    def _artifact_size(path: Path) -> int | None:
        try:
            if path.is_file():
                return int(path.stat().st_size)
        except OSError:
            return None
        return None

    async def _execute(self, task_id: str) -> None:
        attempt_id = ""
        attempt_no = 0
        lease: ProxyLease | None = None
        decision = FailureDecision("backend_error", False, False, "后端任务初始化失败")
        exit_code: int | None = None
        task: dict[str, Any] | None = None
        policy: TaskPolicy | None = None
        auth_failure_context = ""
        task_artifacts: set[Path] = set()
        artifact_progress = {"count": 0, "bytes": 0, "last_write": 0.0}
        try:
            attempt = self.db.begin_attempt(task_id)
            attempt_id = attempt["id"]
            attempt_no = int(attempt["attempt_no"])
            task = attempt["task"]
            policy = self._policy(task)
            async def log(stream: str, line: str) -> None:
                self.log_writer.push(task_id, attempt_id, stream, line)
                if stream == "stdout" and task is not None:
                    artifact = self._artifact_from_output(line, task["output_dir"])
                    if artifact is not None and artifact not in task_artifacts:
                        task_artifacts.add(artifact)
                        # Stat only the newly seen file and accumulate, instead of
                        # re-stat'ing the whole set on every output line (that was
                        # O(N²) stats + N DB writes for a multi-file task). Throttle
                        # the DB write to ~1/s; the finally block recomputes the exact
                        # total once at the end.
                        size = await asyncio.to_thread(self._artifact_size, artifact)
                        if size is not None:
                            artifact_progress["count"] += 1
                            artifact_progress["bytes"] += size
                            now = time.monotonic()
                            if now - artifact_progress["last_write"] >= 1.0:
                                artifact_progress["last_write"] = now
                                await asyncio.to_thread(
                                    self.db.update_artifacts,
                                    task_id,
                                    artifact_progress["count"],
                                    artifact_progress["bytes"],
                                )

            async def started(pid: int, marker: str) -> None:
                self.db.set_process(task_id, attempt_id, pid, marker)

            proxy_mode = task["proxy_mode"]
            if proxy_mode != "direct":
                tried = set(task.get("tried_proxy_ids") or [])
                allowed_proxy_ids = self._allowed_proxy_ids(policy)
                try:
                    lease = await asyncio.to_thread(
                        self.proxy.acquire,
                        task_id,
                        node_tags=policy.node_tags,
                        exclude_ids=tried,
                        allowed_ids=allowed_proxy_ids,
                        probe_before_use=policy.probe_before_use,
                        probe_url=policy.probe_url,
                    )
                except ProxyPoolUnavailable as exc:
                    # mihomo core startup failure must never degrade to a direct
                    # connection, not even in prefer mode: remind and terminate
                    # the task (non-retryable) until the core is fixed and the
                    # pool restarted. Other acquire errors keep the branch below.
                    decision = FailureDecision(
                        "proxy_unavailable",
                        False,
                        False,
                        f"代理不可用，任务已终止（不会回退直连）：{redact_text(exc, limit=500)}",
                    )
                    await log("backend", decision.message)
                    raise _ExecutionFinished
                except Exception as exc:
                    if proxy_mode == "required":
                        decision = FailureDecision(
                            "proxy_unavailable",
                            True,
                            True,
                            "required 模式下代理租约获取失败："
                            f"{redact_text(exc, limit=500)}",
                        )
                        await log("backend", decision.message)
                        raise _ExecutionFinished
                    await log("backend", f"代理池降级，本次任务使用直连：{redact_text(exc, limit=500)}")
                    lease = None
                if lease is not None:
                    public_endpoint = redact_text(lease.endpoint, limit=500)
                    self.db.set_lease(task_id, attempt_id, lease.node_id, public_endpoint, task["site"])
                    await log("backend", f"已分配代理节点 {lease.name} ({lease.protocol}) -> {public_endpoint}")
                elif proxy_mode == "required":
                    decision = FailureDecision("proxy_unavailable", True, False, "当前没有符合站点策略的健康代理节点")
                    await log("backend", decision.message)
                    raise _ExecutionFinished
                else:
                    await log("backend", "代理池当前无可租用节点，本次任务使用直连")

            current = self.db.get_task(task_id)
            if current and current.get("cancel_requested"):
                decision = FailureDecision("cancelled", False, False, "任务已取消")
                raise _ExecutionFinished

            extra_args = [*policy.extra_args, *(task.get("extra_args") or [])]
            result = await self.gallery.run(
                task_id,
                url=task["url"],
                output_dir=task["output_dir"],
                proxy_url=lease.endpoint if lease else None,
                http_timeout=policy.http_timeout,
                gallery_retries=policy.gallery_retries,
                task_timeout=policy.task_timeout_seconds,
                stall_timeout=(
                    policy.download_stall_timeout_seconds
                    if task["site"] == "exhentai"
                    else 0.0
                ),
                cookies_file=task.get("cookies_file"),
                config_file=task.get("config_file"),
                credentials_ref=task.get("credentials_ref"),
                extra_args=extra_args,
                on_line=log,
                on_started=started,
                site=task["site"],
                eh_download=policy.eh_download,
            )
            exit_code = result.exit_code
            auth_failure_context = result.output_tail
            latest = self.db.get_task(task_id)
            cancelled = bool(latest and latest.get("cancel_requested"))
            if self._stopping and not cancelled:
                decision = FailureDecision("backend_shutdown", True, False, "后端停止，任务将重新排队")
            else:
                decision = classify_result(
                    result.exit_code,
                    result.output_tail,
                    cancelled=cancelled,
                    timed_out=result.timed_out,
                )
                # gallery-dl's exit status is an OR-accumulated bitmask, so a multi-file
                # task that saved most files but failed on one still exits with bit 4 set
                # and classifies as a non-retryable extraction_error — silently dropping
                # the missing files. A non-empty task_artifacts (parsed from stdout during
                # the run) means some files did land = partial success, so upgrade to a
                # bounded retry (capped by max_attempts): gallery-dl skips already-saved
                # files and re-fetches only what is missing. Zero artifacts = a pure
                # extraction failure that downloaded nothing, which stays terminal.
                if (
                    decision.error_class == "extraction_error"
                    and not decision.retryable
                    and task_artifacts
                ):
                    decision = FailureDecision(
                        "extraction_partial", True, decision.proxy_fault, decision.message
                    )
        except _ExecutionFinished:
            pass
        except asyncio.CancelledError:
            decision = FailureDecision("backend_shutdown", True, False, "后端停止，任务将重新排队")
        except FileNotFoundError as exc:
            decision = FailureDecision("backend_configuration", False, False, redact_text(exc, limit=1000))
        except ValueError as exc:
            decision = FailureDecision("backend_configuration", False, False, redact_text(exc, limit=1000))
        except Exception as exc:
            decision = FailureDecision("backend_error", True, False, redact_text(exc, limit=1000))
        finally:
            try:
                if lease is not None:
                    await asyncio.to_thread(
                        self.proxy.release,
                        task_id,
                        proxy_fault=decision.proxy_fault,
                        reason=decision.message,
                    )
            except Exception as exc:
                if attempt_id:
                    self.log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        f"释放代理租约异常：{redact_text(exc, limit=500)}",
                    )
            finally:
                if attempt_id:
                    self.db.clear_lease(task_id, attempt_id)

        if (
            decision.error_class == "authentication"
            and task is not None
            and self.auth_failure_callback is not None
        ):
            try:
                invalidated = await self.auth_failure_callback(
                    task["site"],
                    task.get("cookies_file"),
                    auth_failure_context or decision.message,
                )
                if invalidated and attempt_id:
                    self.log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        "托管登录凭证已标记失效；后续排队任务等待重新授权。",
                    )
            except Exception as exc:
                if attempt_id:
                    self.log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        f"更新托管授权状态失败：{redact_text(exc, limit=500)}",
                    )

        if not attempt_id:
            current = self.db.get_task(task_id)
            if current and (current.get("cancel_requested") or current.get("status") == "cancelling"):
                self.db.complete_task(task_id, "cancelled", error_class="cancelled", error_message="任务已取消")
            elif current and current.get("status") not in TERMINAL_STATUSES:
                self.db.complete_task(
                    task_id,
                    "failed",
                    error_class=decision.error_class,
                    error_message=decision.message,
                )
            return
        await self.log_writer.flush()
        self.db.finish_attempt(
            attempt_id,
            exit_code=exit_code,
            status="succeeded" if decision.error_class == "success" else "cancelled" if decision.error_class == "cancelled" else "failed",
            error_class=decision.error_class,
            error_message=decision.message,
            retryable=decision.retryable,
            proxy_node_id=lease.node_id if lease else None,
            proxy_endpoint=redact_text(lease.endpoint, limit=500) if lease else None,
        )
        if task is not None and task_artifacts:
            count, total = await asyncio.to_thread(self._artifact_totals, task_artifacts)
            self.db.update_artifacts(task_id, count, total)

        latest = self.db.get_task(task_id)
        if (latest and latest.get("cancel_requested")) or decision.error_class == "cancelled":
            self.db.complete_task(
                task_id,
                "cancelled",
                exit_code=exit_code,
                error_class="cancelled",
                error_message="任务已取消",
                expected_attempt_id=attempt_id,
            )
            return
        if decision.error_class == "success":
            self.db.complete_task(task_id, "succeeded", exit_code=exit_code, expected_attempt_id=attempt_id)
            return

        max_attempts = int((latest or task or {}).get("max_attempts", 1))
        tried = list((latest or task or {}).get("tried_proxy_ids") or [])
        if lease is not None and decision.proxy_fault and lease.node_id not in tried:
            tried.append(lease.node_id)
        if decision.retryable and attempt_no < max_attempts:
            base = policy.backoff_base_seconds if policy else 2.0
            # A manual retry round pins backoff_anchor_attempt to the attempt_count it
            # inherited, so this round's exponent restarts at 0 instead of compounding
            # the task's whole history. Automatic requeues leave the anchor untouched,
            # so retries within a single round keep escalating. The exponential term is
            # then capped so a deep sequence can never schedule an absurd delay.
            anchor = int((latest or task or {}).get("backoff_anchor_attempt", 0) or 0)
            exponent = max(0, attempt_no - 1 - anchor)
            delay = min(base * (2 ** exponent), self.settings.retry_backoff_cap_seconds)
            delay += random.uniform(0.0, self.settings.retry_jitter_seconds)
            self.db.requeue_task(
                task_id,
                next_run_at=time.time() + delay,
                exit_code=exit_code,
                error_class=decision.error_class,
                error_message=decision.message,
                tried_proxy_ids=tried,
                expected_attempt_id=attempt_id,
            )
            self._wake.set()
            return
        self.db.complete_task(
            task_id,
            "failed",
            exit_code=exit_code,
            error_class=decision.error_class,
            error_message=decision.message,
            expected_attempt_id=attempt_id,
        )


class _ExecutionFinished(Exception):
    pass
