from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import DedupSettings
from .database import Database


AnalysisRunner = Callable[[dict[str, Any]], Awaitable[tuple[dict[str, Any], str]]]


def resolve_review_file(root: Path, relative_path: str) -> Path:
    root = root.resolve()
    relative = Path(relative_path)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ValueError("审核图片路径无效")
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("审核图片路径包含符号链接")
    target = cursor.resolve()
    if target == root or not target.is_relative_to(root):
        raise ValueError("审核图片路径超出批次目录")
    return target


class DedupReviewManager:
    def __init__(
        self,
        db: Database,
        settings: DedupSettings,
        runtime_dir: Path,
        *,
        runner: AnalysisRunner | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.runtime_dir = (runtime_dir / "reviews").resolve()
        self.runner = runner
        self._loop_task: asyncio.Task | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._wake = asyncio.Event()
        self._current_batch_id = ""

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        # Recover crashed analyzing/applying reviews even when dedup is now disabled:
        # otherwise a review left mid-flight by a crash stays stuck forever (the loop
        # below never runs to advance it, and retry only accepts 'failed').
        self.db.recover_crawl_reviews()
        if not self.settings.enabled:
            return
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self._loop_task = asyncio.create_task(self._loop(), name="dedup-review-manager")

    async def stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
            self._loop_task = None
        await self._terminate_process()

    def notify(self) -> None:
        self._wake.set()

    async def _loop(self) -> None:
        while True:
            try:
                if await self.run_once():
                    continue
                self._wake.clear()
                try:
                    await asyncio.wait_for(
                        self._wake.wait(),
                        timeout=self.settings.poll_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(self.settings.poll_interval_seconds)

    async def run_once(self) -> bool:
        if not self.settings.enabled:
            return False
        automatic = self.db.next_crawl_review_automatic()
        if automatic is not None:
            self._current_batch_id = str(automatic["batch_id"])
            try:
                # Off-loop: this does per-image shutil.move + DB writes; running it
                # inline would freeze the whole backend (HTTP + scheduler) for the
                # duration. The manual apply path already uses to_thread (app.py).
                await asyncio.to_thread(self._apply_automatic_rejections, automatic)
            finally:
                self._current_batch_id = ""
            return True
        claimed = self.db.claim_next_crawl_review()
        if claimed is None:
            return False
        batch_id = str(claimed["batch_id"])
        self._current_batch_id = batch_id
        try:
            if self.runner is not None:
                manifest, log_path = await self.runner(claimed)
            else:
                manifest, log_path = await self._run_worker(claimed)
            await asyncio.to_thread(self._validate_manifest, claimed, manifest)
            self.db.replace_crawl_review_manifest(batch_id, manifest, log_path=log_path)
            if self.db.get_crawl_review(batch_id)["status"] == "auto_applying":
                await asyncio.to_thread(self._apply_automatic_rejections, claimed)
        except asyncio.CancelledError:
            await self._terminate_process()
            self.db.requeue_crawl_review(batch_id)
            raise
        except Exception as exc:
            # Only point at the worker log if it was actually created; a startup-time
            # failure (missing python/worker/core) never produced one, and a dangling
            # path just gives the UI a 404 link.
            log_file = self.runtime_dir / f"{batch_id}.log"
            log_path = str(log_file) if log_file.is_file() else ""
            self.db.fail_crawl_review(batch_id, str(exc), log_path=log_path)
        finally:
            self._current_batch_id = ""
        return True

    async def _run_worker(self, claimed: dict[str, Any]) -> tuple[dict[str, Any], str]:
        batch_id = str(claimed["batch_id"])
        python = self.settings.python_executable.resolve()
        worker = self.settings.worker_script.resolve()
        core = self.settings.core_script.resolve()
        if not python.is_file():
            raise FileNotFoundError(f"去重 Python 环境不存在: {python}")
        if not worker.is_file():
            raise FileNotFoundError(f"去重审核 worker 不存在: {worker}")
        if not core.is_file():
            raise FileNotFoundError(f"去重核心脚本不存在: {core}")

        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = self.runtime_dir / f"{batch_id}.json"
        log_path = self.runtime_dir / f"{batch_id}.log"
        manifest_path.unlink(missing_ok=True)
        command = [
            str(python),
            str(worker),
            str(claimed["output_dir"]),
            "--output",
            str(manifest_path),
            "--core-script",
            str(core),
            "--model-dir",
            str(self.settings.model_dir.resolve()),
            "--device",
            self.settings.device,
            "--workers",
            str(self.settings.workers),
        ]
        if self.settings.no_sscd:
            command.append("--no-sscd")
        if self.settings.no_dino:
            command.append("--no-dino")
        environment = os.environ.copy()
        environment.setdefault("PYTHONUTF8", "1")
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with log_path.open("wb") as log_file:
            self._process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(worker.parent),
                env=environment,
                stdout=log_file,
                stderr=asyncio.subprocess.STDOUT,
                creationflags=creation_flags,
            )
            return_code = await self._process.wait()
            self._process = None
        if return_code != 0:
            raise RuntimeError(
                f"去重分析进程退出码 {return_code}: {self._log_tail(log_path)}"
            )
        if not manifest_path.is_file():
            raise RuntimeError("去重分析进程未生成审核清单")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"读取去重审核清单失败: {exc}") from exc
        return manifest, str(log_path)

    async def _terminate_process(self) -> None:
        process = self._process
        if process is None or process.returncode is not None:
            self._process = None
            return
        process.terminate()
        try:
            await asyncio.wait_for(
                process.wait(),
                timeout=self.settings.shutdown_grace_seconds,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        self._process = None

    @staticmethod
    def _log_tail(path: Path, limit: int = 4000) -> str:
        try:
            data = path.read_bytes()
        except OSError:
            return ""
        return data[-limit:].decode("utf-8", "replace").strip()

    @staticmethod
    def _validate_manifest(claimed: dict[str, Any], manifest: dict[str, Any]) -> None:
        if int(manifest.get("schema_version") or 0) not in {1, 2}:
            raise ValueError("去重审核清单版本无效")
        root = Path(claimed["output_dir"]).resolve()
        if Path(str(manifest.get("root") or "")).resolve() != root:
            raise ValueError("去重审核清单的批次目录不匹配")
        groups = manifest.get("groups")
        if not isinstance(groups, list):
            raise ValueError("去重审核清单缺少 groups")
        seen_groups: set[str] = set()
        seen_images: set[str] = set()
        seen_paths: set[str] = set()
        manual_paths: set[str] = set()

        def validate_image(image: Any, *, count: bool) -> str:
            if not isinstance(image, dict):
                raise ValueError("去重审核图片格式无效")
            image_id = str(image.get("id") or "")
            relative_path = str(image.get("relative_path") or "")
            if not image_id:
                raise ValueError("去重审核图片 ID 无效")
            if not relative_path:
                raise ValueError("去重审核图片路径无效")
            resolve_review_file(root, relative_path)
            if count:
                if image_id in seen_images:
                    raise ValueError("去重审核图片 ID 重复")
                if relative_path in seen_paths:
                    raise ValueError("去重审核图片路径重复")
                seen_images.add(image_id)
                seen_paths.add(relative_path)
            return relative_path

        for group in groups:
            if not isinstance(group, dict):
                raise ValueError("去重审核组格式无效")
            group_id = str(group.get("id") or "")
            if not group_id or group_id in seen_groups:
                raise ValueError("去重审核组 ID 无效")
            seen_groups.add(group_id)
            items = group.get("items")
            if not isinstance(items, list) or not items:
                raise ValueError("去重审核组没有图片")
            if group.get("kind") == "duplicate" and len(items) < 2:
                raise ValueError("重复组至少需要两张图片")
            for image in items:
                manual_paths.add(validate_image(image, count=True))

        for group in manifest.get("auto_groups") or []:
            if not isinstance(group, dict):
                raise ValueError("自动去重组格式无效")
            group_id = str(group.get("id") or "")
            if not group_id or group_id in seen_groups:
                raise ValueError("自动去重组 ID 无效")
            seen_groups.add(group_id)
            if group.get("kind") not in {"exact", "compression"}:
                raise ValueError("自动去重组类型无效")
            winner_path = validate_image(group.get("winner"), count=False)
            rejected_items = group.get("rejected_items")
            if not isinstance(rejected_items, list) or not rejected_items:
                raise ValueError("自动去重组没有淘汰图片")
            for image in rejected_items:
                validate_image(image, count=True)
            if winner_path not in manual_paths:
                raise ValueError("自动去重组的保留图未进入人工审核")
        expected = int((manifest.get("counts") or {}).get("images") or 0)
        if expected != len(seen_images):
            raise ValueError("去重审核清单的图片计数不一致")

    def start_analysis(self, batch_id: str) -> dict[str, Any]:
        if not self.settings.enabled:
            raise RuntimeError("去重功能未启用")
        review = self.db.start_crawl_review(batch_id)
        if review["status"] == "pending":
            self.notify()
        return review

    def retry_analysis(self, batch_id: str) -> bool:
        retried = self.db.retry_crawl_review(batch_id)
        if retried:
            self.notify()
        return retried

    def _apply_automatic_rejections(self, claimed: dict[str, Any]) -> dict[str, Any]:
        batch_id = str(claimed["batch_id"])
        root = Path(claimed["output_dir"]).resolve()
        root.mkdir(parents=True, exist_ok=True)
        for image in self.db.crawl_review_automatic_images(batch_id):
            try:
                self._reject_image(batch_id, image, root)
            except Exception as exc:
                self.db.finish_crawl_review_image(
                    batch_id,
                    image["id"],
                    "failed",
                    final_relative_path=str(image.get("final_relative_path") or ""),
                    error=str(exc),
                )
        result = self.db.finish_crawl_review_automatic(batch_id)
        if result is None:
            raise RuntimeError("严格自动淘汰完成后读取审核状态失败")
        return result

    def apply(self, batch_id: str) -> dict[str, Any]:
        if not self.db.begin_crawl_review_apply(batch_id):
            raise RuntimeError("当前审核状态不允许应用选择")
        batch = self.db.get_crawl_batch(batch_id)
        if batch is None:
            raise KeyError(batch_id)
        root = Path(batch["output_dir"]).resolve()
        root.mkdir(parents=True, exist_ok=True)
        for image in self.db.crawl_review_apply_images(batch_id):
            try:
                if image["selected"]:
                    self._keep_image(batch_id, image, root)
                else:
                    self._reject_image(batch_id, image, root)
            except Exception as exc:
                self.db.finish_crawl_review_image(
                    batch_id,
                    image["id"],
                    "failed",
                    final_relative_path=str(image.get("final_relative_path") or ""),
                    error=str(exc),
                )
        result = self.db.finish_crawl_review_apply(batch_id)
        if result is None:
            raise RuntimeError("审核结果应用后读取失败")
        return result

    def _keep_image(self, batch_id: str, image: dict[str, Any], root: Path) -> None:
        source = resolve_review_file(root, image["relative_path"])
        if not source.is_file():
            raise FileNotFoundError(f"保留图片不存在: {image['relative_path']}")
        self.db.finish_crawl_review_image(
            batch_id,
            image["id"],
            "kept",
            final_relative_path=image["relative_path"],
        )

    def _reject_image(self, batch_id: str, image: dict[str, Any], root: Path) -> None:
        source = resolve_review_file(root, image["relative_path"])
        staged_relative = str(image.get("final_relative_path") or "")
        staged = resolve_review_file(root, staged_relative) if staged_relative else None
        source_txt = source.with_suffix(".txt")
        if staged is not None and staged.is_file() and not source.exists():
            destination_txt = staged.with_suffix(".txt")
            if source_txt.is_file() and not source_txt.is_symlink():
                if destination_txt.exists():
                    raise FileExistsError(f"淘汰图片的 TXT 目标已存在: {staged_relative}")
                shutil.move(str(source_txt), str(destination_txt))
            self.db.finish_crawl_review_image(
                batch_id,
                image["id"],
                "rejected",
                final_relative_path=staged.relative_to(root).as_posix(),
            )
            return
        if not source.is_file():
            raise FileNotFoundError(f"待淘汰图片不存在: {image['relative_path']}")

        destination = staged
        if destination is None or destination.exists() or destination.with_suffix(".txt").exists():
            destination = self._available_destination(root, image["relative_path"])
        self._ensure_safe_directory(root, destination.parent)
        destination = resolve_review_file(root, destination.relative_to(root).as_posix())
        destination_relative = destination.relative_to(root).as_posix()
        self.db.stage_crawl_review_image_move(batch_id, image["id"], destination_relative)

        destination_txt = destination.with_suffix(".txt")
        moved_image = False
        try:
            shutil.move(str(source), str(destination))
            moved_image = True
            if source_txt.is_file() and not source_txt.is_symlink():
                shutil.move(str(source_txt), str(destination_txt))
        except Exception:
            if destination_txt.exists() and not source_txt.exists():
                source_txt.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(destination_txt), str(source_txt))
            if moved_image and destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(destination), str(source))
            raise
        self.db.finish_crawl_review_image(
            batch_id,
            image["id"],
            "rejected",
            final_relative_path=destination_relative,
        )

    @staticmethod
    def _available_destination(root: Path, relative_path: str) -> Path:
        relative = Path(relative_path)
        original = root / "duplicates" / relative
        candidate = original
        suffix = 1
        while candidate.exists() or candidate.with_suffix(".txt").exists():
            candidate = original.with_name(
                f"{original.stem}_{suffix}{original.suffix}"
            )
            suffix += 1
        return candidate

    @staticmethod
    def _ensure_safe_directory(root: Path, directory: Path) -> None:
        root = root.resolve()
        try:
            relative = directory.relative_to(root)
        except ValueError as exc:
            raise ValueError("审核目标目录超出批次目录") from exc
        cursor = root
        for part in relative.parts:
            cursor = cursor / part
            if cursor.exists():
                if cursor.is_symlink() or not cursor.is_dir():
                    raise ValueError("审核目标目录包含符号链接或非目录项")
            else:
                cursor.mkdir()
            if cursor.is_symlink():
                raise ValueError("审核目标目录包含符号链接")
        resolved = cursor.resolve()
        if resolved != root and not resolved.is_relative_to(root):
            raise ValueError("审核目标目录超出批次目录")
