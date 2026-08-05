from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from .crawl import CrawlPlanError, CrawlPlanner, CrawlUnit
from .database import Database, TERMINAL_BATCH_STATUSES
from .discovery import DiscoveryError, DiscoveryService
from .proxy import ProxyPoolAdapter
from .redaction import redact_text
from .scheduler import TaskScheduler
from .schemas import (
    CrawlTaskLinkMetadata,
    SitePolicy,
    TaskCreate,
    TaskPolicy,
)
from .source_keys import candidate_source_key


EnqueueBatch = Callable[
    [list[TaskCreate], list[str], int],
    Awaitable[list[dict]],
]
PolicyProvider = Callable[[str], SitePolicy]
_TWITTER_MEDIA_HOSTS = {"pbs.twimg.com", "video.twimg.com"}
_ENQUEUE_CHUNK_SIZE = 50


class EnqueueBatchCancelled(asyncio.CancelledError):
    def __init__(self, results: list[dict]) -> None:
        super().__init__("批量任务写入完成后收到取消请求")
        self.results = results


def _is_twitter_media_url(site: str, url: str) -> bool:
    return site == "twitter" and (urlsplit(url).hostname or "").lower() in _TWITTER_MEDIA_HOSTS


class OrderedCrawlManager:
    """Run one selected address at a time and fan that address out to media tasks."""

    def __init__(
        self,
        database: Database,
        discovery: DiscoveryService,
        planner: CrawlPlanner,
        scheduler: TaskScheduler,
        proxy: ProxyPoolAdapter,
        policy_for: PolicyProvider,
        *,
        poll_interval: float = 0.25,
        max_concurrent_batches: int = 4,
    ) -> None:
        self.db = database
        self.discovery = discovery
        self.planner = planner
        self.scheduler = scheduler
        self.proxy = proxy
        self.policy_for = policy_for
        self.poll_interval = max(0.05, float(poll_interval))
        self.max_concurrent_batches = max(1, int(max_concurrent_batches))
        self._enqueue: EnqueueBatch | None = None
        self._loop_task: asyncio.Task | None = None
        self._batch_tasks: dict[str, asyncio.Task] = {}
        self._batch_wakes: dict[str, asyncio.Event] = {}
        self._site_planning_locks: dict[str, asyncio.Lock] = {}
        self._wake = asyncio.Event()
        self._stopping = False

    def set_enqueue(self, callback: EnqueueBatch) -> None:
        self._enqueue = callback

    def notify(self) -> None:
        self._wake.set()
        for wake in list(self._batch_wakes.values()):
            wake.set()

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        if self._enqueue is None:
            raise RuntimeError("顺序爬取管理器尚未绑定任务入队器")
        self.db.recover_ordered_crawls()
        self._stopping = False
        self._loop_task = asyncio.create_task(
            self._supervisor_loop(),
            name="ordered-crawl-supervisor",
        )
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        supervisor = self._loop_task
        if supervisor is not None:
            supervisor.cancel()
        batch_tasks = list(self._batch_tasks.values())
        for task in batch_tasks:
            task.cancel()
        await asyncio.gather(
            *([supervisor] if supervisor is not None else []),
            *batch_tasks,
            return_exceptions=True,
        )
        self._loop_task = None
        self._batch_tasks.clear()
        self._batch_wakes.clear()
        self._site_planning_locks.clear()

    def status(self) -> dict:
        return {
            "running": self._loop_task is not None and not self._stopping,
            "active_batches": len(self.db.active_crawl_batch_ids()),
            "running_batch_loops": len(self._batch_tasks),
            "max_concurrent_batches": self.max_concurrent_batches,
            "site_planning_locked": sorted(
                site
                for site, lock in self._site_planning_locks.items()
                if lock.locked()
            ),
            "execution_order": "source_then_address",
            "address_parallelism": "media_tasks",
        }

    async def _supervisor_loop(self) -> None:
        while not self._stopping:
            try:
                self._wake.clear()
                batch_ids = await asyncio.to_thread(
                    self.db.active_crawl_batch_ids
                )
                for batch_id in batch_ids:
                    if self._stopping:
                        break
                    if batch_id in self._batch_tasks:
                        continue
                    if len(self._batch_tasks) >= self.max_concurrent_batches:
                        break
                    wake = asyncio.Event()
                    self._batch_wakes[batch_id] = wake
                    task = asyncio.create_task(
                        self._batch_loop(batch_id),
                        name=f"ordered-crawl-{batch_id}",
                    )
                    self._batch_tasks[batch_id] = task
                try:
                    await asyncio.wait_for(
                        self._wake.wait(),
                        timeout=self.poll_interval,
                    )
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(self.poll_interval)

    async def _batch_loop(self, batch_id: str) -> None:
        current_task = asyncio.current_task()
        wake = self._batch_wakes[batch_id]
        try:
            while not self._stopping:
                wake.clear()
                try:
                    if not await self._tick_batch(batch_id):
                        return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await asyncio.sleep(self.poll_interval)
                    continue
                try:
                    await asyncio.wait_for(
                        wake.wait(),
                        timeout=self.poll_interval,
                    )
                except asyncio.TimeoutError:
                    pass
        finally:
            if self._batch_tasks.get(batch_id) is current_task:
                self._batch_tasks.pop(batch_id, None)
                self._batch_wakes.pop(batch_id, None)
            if not self._stopping:
                self._wake.set()

    async def run_once(self) -> None:
        """兼容测试和调用方的一次推进入口；生产监督循环不经由此方法。"""
        batch_ids = await asyncio.to_thread(self.db.active_crawl_batch_ids)
        for batch_id in batch_ids:
            await self._tick_batch(batch_id)

    async def _read_batch_tick_view(self, batch_id: str) -> dict | None:
        return await asyncio.to_thread(self.db.crawl_batch_tick_view, batch_id)

    @staticmethod
    def _batch_no_longer_plannable(batch: dict | None) -> bool:
        return bool(
            batch is None
            or batch["cancel_requested"]
            or batch["status"] in TERMINAL_BATCH_STATUSES
        )

    async def _tick_batch(self, batch_id: str) -> bool:
        batch = await self._read_batch_tick_view(batch_id)
        if batch is None or batch["status"] in TERMINAL_BATCH_STATUSES:
            return False
        address = await asyncio.to_thread(self.db.next_crawl_address, batch_id)
        if batch["cancel_requested"]:
            if address and address["status"] == "running":
                tasks = await asyncio.to_thread(
                    self.db.crawl_address_tasks,
                    address["id"],
                )
                for task in tasks:
                    if task["status"] not in {"succeeded", "failed", "cancelled"}:
                        await self.scheduler.cancel(task["id"])
                self.db.finish_crawl_address_if_terminal(address["id"])
            return not self.db.finish_crawl_batch_if_ready(batch_id)
        if address is None:
            return not self.db.finish_crawl_batch_if_ready(batch_id)
        if address["status"] == "pending":
            await self._activate_address(batch, address)
            return True
        if address["status"] == "running":
            if self.db.finish_crawl_address_if_terminal(address["id"]):
                return not self.db.finish_crawl_batch_if_ready(batch_id)
        return True

    async def _activate_address(self, batch: dict, address: dict) -> None:
        if self._enqueue is None:
            raise RuntimeError("顺序爬取管理器尚未绑定任务入队器")
        if not self.db.begin_crawl_address_planning(address["id"]):
            return
        linked_tasks: list[str] = []

        async def cancel_linked() -> None:
            await asyncio.gather(
                *(
                    self.scheduler.cancel(task_id)
                    for task_id in dict.fromkeys(linked_tasks)
                ),
                return_exceptions=True,
            )

        try:
            # Re-planning keeps this address's already-linked tasks (reset does not delete
            # them) and re-enqueues them idempotently under the same key, so they consume
            # no NEW budget. crawl_batch_task_count still counts them, understating the
            # room left by exactly this address's own linked count — add it back so a large
            # partially-planned address can be fully re-discovered. On first planning this
            # address has 0 linked tasks, so the budget is unchanged.
            already_linked = self.db.crawl_address_task_count(address["id"])
            remaining = (
                int(batch["max_tasks"])
                - self.db.crawl_batch_task_count(batch["id"])
                + already_linked
            )
            if remaining <= 0:
                raise CrawlPlanError(
                    "crawl_plan_too_large",
                    f"批次媒体任务达到 max_tasks={batch['max_tasks']}",
                )
            base_policy = self.policy_for(address["site"])
            site = str(address["site"])
            planning_lock = self._site_planning_locks.get(site)
            if planning_lock is None:
                planning_lock = asyncio.Lock()
                self._site_planning_locks[site] = planning_lock
            async with planning_lock:
                policy = await self._probe_address_policy(address, base_policy)
                # 探活与发现之间只做一次轻量取消视图检查；同站临界区仍连续，
                # 且会在任何去重或分块入队开始前释放。
                latest = await self._read_batch_tick_view(batch["id"])
                if self._batch_no_longer_plannable(latest):
                    return
                units, skipped_count = await self._plan_address(
                    address,
                    batch_id=batch["id"],
                    policy=policy,
                    max_tasks=remaining,
                )
            self.db.set_crawl_address_pre_dedup_skipped_count(
                address["id"],
                skipped_count,
            )
            deduplicated = self._deduplicate(units)
            if not deduplicated:
                if skipped_count and self.db.finish_crawl_address_as_pre_deduplicated(
                    address["id"],
                    skipped_count,
                ):
                    self.db.finish_crawl_batch_if_ready(batch["id"])
                    self.notify()
                    return
                raise CrawlPlanError("empty_crawl_plan", "该地址没有发现可下载图片")
            if len(deduplicated) > remaining:
                raise CrawlPlanError(
                    "crawl_plan_too_large",
                    f"该地址媒体数超过批次剩余额度 {remaining}",
                )

            latest = await self._read_batch_tick_view(batch["id"])
            if self._batch_no_longer_plannable(latest):
                return
            address_output = (
                Path(batch["output_dir"])
                / f"{int(address['source_order']):02d}-{address['site']}"
                / f"{int(address['address_order']):04d}"
            )
            for chunk_start in range(0, len(deduplicated), _ENQUEUE_CHUNK_SIZE):
                # 热路径每块只读取一次取消标记，避免按媒体单元重复查询。
                cancelled = await asyncio.to_thread(
                    self.db.crawl_batch_cancel_requested,
                    batch["id"],
                )
                if cancelled is None or cancelled:
                    await cancel_linked()
                    return

                bodies: list[TaskCreate] = []
                idempotency_keys: list[str] = []
                chunk = deduplicated[
                    chunk_start : chunk_start + _ENQUEUE_CHUNK_SIZE
                ]
                for chunk_offset, (unit, digest) in enumerate(chunk):
                    sequence_no = chunk_start + chunk_offset + 1
                    unit_site = unit.site or address["site"]
                    direct_twitter_media = _is_twitter_media_url(unit_site, unit.url)
                    task_body = TaskCreate(
                        url=unit.url,
                        site=unit_site,
                        output_dir=str(address_output),
                        proxy_mode=address["proxy_mode"],
                        max_attempts=address["max_attempts"],
                        priority=address["priority"],
                        credentials_ref=address.get("credentials_ref"),
                        cookies_file=(
                            None
                            if direct_twitter_media
                            else address.get("cookies_file")
                        ),
                        config_file=address.get("config_file"),
                        eh_download=(address.get("download_options") or {}).get("eh"),
                        extra_args=[*address.get("extra_args", []), *unit.extra_args],
                    )
                    task_body._policy_override = policy
                    task_body._skip_managed_credentials = direct_twitter_media
                    task_body._crawl_link = CrawlTaskLinkMetadata(
                        address_id=address["id"],
                        sequence_no=sequence_no,
                        source_key=unit.source_key,
                        source_url=unit.source_url,
                    )
                    bodies.append(task_body)
                    idempotency_keys.append(
                        f"crawl:{batch['id']}:{address['id']}:{digest[:48]}"
                    )

                try:
                    chunk_results = await self._enqueue(
                        bodies,
                        idempotency_keys,
                        int(batch["concurrency"]),
                    )
                except EnqueueBatchCancelled as exc:
                    # 数据库 worker 可能已在取消到达前提交；先接回 ID，外层取消
                    # 分支才能将这些已链接任务一并取消并保留在当前地址上排空。
                    linked_tasks.extend(
                        str(result["task_id"]) for result in exc.results
                    )
                    raise
                linked_tasks.extend(
                    str(result["task_id"]) for result in chunk_results
                )
                if len(chunk_results) != len(bodies):
                    raise RuntimeError("批量任务入队返回数量不匹配")
                await asyncio.sleep(0)
            latest = await self._read_batch_tick_view(batch["id"])
            if self._batch_no_longer_plannable(latest):
                await cancel_linked()
                return
            if not self.db.mark_crawl_address_running(address["id"]):
                latest = await self._read_batch_tick_view(batch["id"])
                if not self._batch_no_longer_plannable(latest):
                    raise RuntimeError("媒体任务已创建，但地址状态切换失败")
            self.scheduler.notify()
        except asyncio.CancelledError:
            await asyncio.shield(cancel_linked())
            error = "顺序管理器停止，已创建的媒体任务已取消"
            if linked_tasks and self.db.mark_crawl_address_running(
                address["id"],
                last_error=error,
                planning_error=error,
            ):
                # Keep linked tasks attached to this address. On the next start the
                # scheduler recovers them and strict sequencing drains this address
                # before another one is planned.
                self.scheduler.notify()
            else:
                self.db.reset_crawl_address_planning(
                    address["id"],
                    "顺序管理器停止，地址等待重新规划",
                )
            raise
        except Exception as exc:
            await cancel_linked()
            latest = await self._read_batch_tick_view(batch["id"])
            if not self._batch_no_longer_plannable(latest):
                error = redact_text(exc, limit=2000)
                if linked_tasks and self.db.mark_crawl_address_running(
                    address["id"],
                    last_error=error,
                    planning_error=error,
                ):
                    # Keep the address active until every partially-created task reaches
                    # a terminal state. This preserves strict address sequencing.
                    self.scheduler.notify()
                    return
                self.db.fail_crawl_address(address["id"], error)
                self.db.finish_crawl_batch_if_ready(batch["id"])

    @staticmethod
    def _probe_target(address: dict, policy: SitePolicy) -> str:
        if policy.probe_url:
            return policy.probe_url
        parsed = urlsplit(str(address["url"]))
        host = parsed.hostname
        if not host:
            raise CrawlPlanError("invalid_probe_target", "图站地址缺少可探活的主机名")
        authority = f"[{host}]" if ":" in host else host
        if parsed.port and parsed.port != 443:
            authority = f"{authority}:{parsed.port}"
        return f"https://{authority}/"

    async def _probe_address_policy(
        self,
        address: dict,
        policy: SitePolicy,
    ) -> TaskPolicy:
        scoped = TaskPolicy.model_validate(policy.model_dump())
        if address["proxy_mode"] == "direct":
            return scoped

        target = self._probe_target(address, policy)
        try:
            result = await asyncio.to_thread(self.proxy.probe_for_target, target)
            healthy_node_ids = sorted(
                {
                    str(item["id"])
                    for item in result.get("results", [])
                    if item.get("healthy") and item.get("id")
                }
            )
            self.db.save_crawl_address_proxy_probe(
                address["id"],
                target_url=target,
                total_count=int(result.get("total") or 0),
                healthy_node_ids=healthy_node_ids,
            )
        except Exception as exc:
            error = redact_text(exc, limit=1000)
            healthy_node_ids = []
            self.db.save_crawl_address_proxy_probe(
                address["id"],
                target_url=target,
                total_count=0,
                healthy_node_ids=[],
                error=error,
            )
            if address["proxy_mode"] == "required":
                raise CrawlPlanError(
                    "proxy_probe_failed",
                    f"{address['site']} 代理探活失败: {error}",
                ) from exc

        if address["proxy_mode"] == "required" and not healthy_node_ids:
            raise CrawlPlanError(
                "proxy_unavailable",
                f"{address['site']} 图站探活后没有可用代理节点",
            )
        return scoped.model_copy(
            update={
                "probe_url": target,
                "proxy_probe_scope": address["id"],
                "allowed_proxy_ids": healthy_node_ids,
            }
        )

    async def _plan_address(
        self,
        address: dict,
        *,
        batch_id: str,
        policy: SitePolicy,
        max_tasks: int,
    ) -> tuple[list[CrawlUnit], int]:
        site = str(address["site"])
        mode = address["proxy_mode"]
        if site == "exhentai":
            candidates = [
                {
                    "id": address["id"],
                    "site": site,
                    "kind": "gallery",
                    "url": address["url"],
                }
            ]
        else:
            dedup_scan_allowance = self.db.succeeded_danbooru_source_key_count(
                batch_id,
                site,
            )
            result = await self.discovery.discover_url(
                site=site,
                url=address["url"],
                keyword=None,
                # Ask for one extra post/work so the task ceiling becomes an explicit
                # error instead of a silently truncated account or tag crawl.
                limit=max_tasks + dedup_scan_allowance + 1,
                range_kind=None,
                policy=policy,
                proxy_mode=mode,
                credentials_ref=address.get("credentials_ref"),
                cookies_file=address.get("cookies_file"),
                config_file=address.get("config_file"),
                extra_args=address.get("discovery_args", []),
                timeout_seconds=float(address.get("timeout_seconds") or 180.0),
            )
            candidates = result.get("candidates") or []
            if not candidates:
                raise DiscoveryError(
                    "address_empty",
                    f"该地址没有发现作品: {address['url']}",
                )
        candidates, skipped_count = self._filter_previously_downloaded_danbooru_sources(
            batch_id,
            site,
            candidates,
        )
        units, _planner_proxies = await self.planner.plan_media(
            candidates,
            policy=policy,
            proxy_mode=mode,
            cookies_file=address.get("cookies_file"),
            max_tasks=max_tasks,
        )
        return units, skipped_count

    def _filter_previously_downloaded_danbooru_sources(
        self,
        batch_id: str,
        site: str,
        candidates: list[dict],
    ) -> tuple[list[dict], int]:
        normalized_site = "twitter" if site == "x" else site
        if normalized_site not in {"pixiv", "twitter"}:
            return candidates, 0
        keyed = [
            (
                item,
                candidate_source_key(
                    normalized_site,
                    item.get("id"),
                    item.get("download_url") or item.get("works_url") or item.get("url"),
                ),
            )
            for item in candidates
        ]
        matched = self.db.succeeded_danbooru_source_keys(
            batch_id,
            {key for _item, key in keyed if key},
        )
        if not matched:
            return candidates, 0
        kept: list[dict] = []
        skipped_count = 0
        for item, key in keyed:
            if key not in matched:
                kept.append(item)
                continue
            try:
                skipped_count += max(1, int(item.get("media_count") or 1))
            except (TypeError, ValueError):
                skipped_count += 1
        return kept, skipped_count

    @staticmethod
    def _deduplicate(units: list[CrawlUnit]) -> list[tuple[CrawlUnit, str]]:
        result: list[tuple[CrawlUnit, str]] = []
        seen: set[str] = set()
        for unit in units:
            material = json.dumps(
                [unit.site, unit.url, unit.extra_args],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
            if digest not in seen:
                seen.add(digest)
                result.append((unit, digest))
        return result
