from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from gdl_backend.database import Database
from gdl_backend.gallery import GalleryRunResult
from gdl_backend.proxy import ProxyLease, ProxyPoolUnavailable
from gdl_backend.scheduler import TaskScheduler
from gdl_backend.schemas import EHDownloadOptions, SitePolicy, TaskPolicy

from tests.helpers import make_settings


class FakeGallery:
    def __init__(self, results: list[GalleryRunResult]):
        self.results = list(results)
        self.cancelled: list[str] = []
        self.calls: list[dict] = []

    async def run(self, task_id: str, **kwargs):
        self.calls.append({"task_id": task_id, **kwargs})
        await kwargs["on_started"](100 + len(self.results), f"marker-{task_id}")
        result = self.results.pop(0)
        if result.output_tail:
            await kwargs["on_line"]("stderr", result.output_tail)
        return result

    async def cancel(self, task_id: str) -> bool:
        self.cancelled.append(task_id)
        return True

    async def stop_all(self):
        return None


class ArtifactGallery(FakeGallery):
    """FakeGallery that also emits stdout file paths so the scheduler records
    them as downloaded artifacts (task_artifacts is populated from stdout only)."""

    def __init__(self, results: list[GalleryRunResult], stdout_paths):
        super().__init__(results)
        self.stdout_paths = [str(p) for p in stdout_paths]

    async def run(self, task_id: str, **kwargs):
        self.calls.append({"task_id": task_id, **kwargs})
        await kwargs["on_started"](100 + len(self.results), f"marker-{task_id}")
        result = self.results.pop(0)
        for path in self.stdout_paths:
            await kwargs["on_line"]("stdout", path)
        if result.output_tail:
            await kwargs["on_line"]("stderr", result.output_tail)
        return result


class FakeProxy:
    def __init__(self, with_nodes: bool = False):
        self.with_nodes = with_nodes
        self.releases: list[tuple[str, bool]] = []
        self.acquisitions: list[dict] = []
        self.counter = 0

    def acquire(self, task_id: str, **kwargs):
        self.acquisitions.append({"task_id": task_id, **kwargs})
        if not self.with_nodes:
            return None
        self.counter += 1
        node_id = f"node-{self.counter}"
        return ProxyLease(
            task_id=task_id,
            node_id=node_id,
            endpoint=f"http://127.0.0.1:{28000 + self.counter}",
            name=node_id,
            protocol="vless",
            tags=["jp"],
            acquired_at=time.time(),
        )

    def release(self, task_id: str, *, proxy_fault: bool, reason: str = ""):
        self.releases.append((task_id, proxy_fault))


class UnavailableProxy(FakeProxy):
    """Models the mihomo-core-startup-failure state: acquire hard-fails."""

    def acquire(self, task_id: str, **kwargs):
        super().acquire(task_id, **kwargs)
        raise ProxyPoolUnavailable("代理池未运行（隧道核心启动失败）")


class ReleaseFailingProxy(FakeProxy):
    def release(self, task_id: str, *, proxy_fault: bool, reason: str = ""):
        super().release(task_id, proxy_fault=proxy_fault, reason=reason)
        raise RuntimeError("release failed")


class CredentialProxy(FakeProxy):
    def acquire(self, task_id: str, **kwargs):
        lease = super().acquire(task_id, **kwargs)
        if lease is not None:
            lease.endpoint = "http://proxy-user:proxy-secret@127.0.0.1:28000"
        return lease


def values(root: Path, *, proxy_mode: str, attempts: int) -> dict:
    policy = SitePolicy(
        max_concurrency=1,
        retry_limit=attempts - 1,
        backoff_base_seconds=0,
        proxy_mode=proxy_mode,
        gallery_retries=0,
    )
    return {
        "id": "task-1",
        "url": "https://example.com/gallery/1",
        "site": "example.com",
        "subcategory": "",
        "extractor": "",
        "output_dir": str(root / "out"),
        "proxy_mode": proxy_mode,
        "max_attempts": attempts,
        "policy": policy.model_dump(),
        "extra_args": [],
    }


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.db = Database(self.settings.database_path)

    async def asyncTearDown(self):
        self.db.close()
        self.temp.cleanup()

    async def wait_terminal(self, task_id: str, timeout: float = 3.0):
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            task = self.db.get_task(task_id)
            if task and task["status"] in {"succeeded", "failed", "cancelled"}:
                return task
            await asyncio.sleep(0.03)
        self.fail("task did not reach terminal state")

    async def test_direct_success(self):
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=1))
        gallery = FakeGallery([GalleryRunResult(0, "saved file", False, "m", 101)])
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")
        self.assertTrue(self.db.get_logs("task-1"))

    async def test_eh_download_policy_reaches_gallery_runner(self):
        task_values = values(self.root, proxy_mode="direct", attempts=1)
        task_values.update(
            {
                "url": "https://e-hentai.org/s/aaaaaaaaaa/123-1",
                "site": "exhentai",
                "policy": SitePolicy(
                    max_concurrency=1,
                    proxy_mode="direct",
                    eh_download=EHDownloadOptions(
                        image_mode="original",
                        gp_policy="stop",
                    ),
                ).model_dump(),
            }
        )
        self.db.create_task(task_values)
        gallery = FakeGallery([GalleryRunResult(0, "saved file", False, "m", 101)])
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()

        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(gallery.calls[0]["site"], "exhentai")
        self.assertEqual(gallery.calls[0]["eh_download"].image_mode, "original")
        self.assertEqual(gallery.calls[0]["eh_download"].gp_policy, "stop")
        self.assertEqual(gallery.calls[0]["stall_timeout"], 180.0)

    async def test_artifact_scan_ignores_partial_and_activity_files(self):
        output = self.root / "artifacts"
        output.mkdir()
        (output / "complete.png").write_bytes(b"ok")
        (output / "complete.png.part").write_bytes(b"partial")
        (output / ".gdl-activity-marker").write_bytes(b"heartbeat")
        self.assertEqual(TaskScheduler._scan_artifacts(str(output)), (1, 2))

    async def test_artifact_output_is_scoped_to_the_current_task(self):
        output = self.root / "shared"
        output.mkdir()
        own = output / "own.png"
        other = output / "other.png"
        own.write_bytes(b"own")
        other.write_bytes(b"other")
        self.assertEqual(TaskScheduler._artifact_from_output(str(own), str(output)), own.resolve())
        self.assertIsNone(TaskScheduler._artifact_from_output("not a path", str(output)))
        self.assertEqual(TaskScheduler._artifact_totals({own.resolve()}), (1, 3))

    async def test_prefer_uses_proxy_when_a_node_is_available(self):
        self.db.create_task(values(self.root, proxy_mode="prefer", attempts=1))
        gallery = FakeGallery([GalleryRunResult(0, "saved file", False, "m", 101)])
        proxy = FakeProxy(with_nodes=True)
        scheduler = TaskScheduler(self.db, gallery, proxy, self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(gallery.calls[0]["proxy_url"], "http://127.0.0.1:28001")
        self.assertEqual(proxy.releases, [("task-1", False)])

    async def test_ordered_task_uses_persisted_address_probe_allowlist(self):
        self.db.create_crawl_batch(
            {
                "id": "batch-1",
                "output_dir": str(self.root / "batch"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-1",
                    "site": "example.com",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://example.com/gallery/1",
                    "proxy_mode": "required",
                    "max_attempts": 1,
                }
            ],
        )
        self.db.save_crawl_address_proxy_probe(
            "address-1",
            target_url="https://example.com/",
            total_count=3,
            healthy_node_ids=["node-a", "node-b"],
        )
        task_values = values(self.root, proxy_mode="required", attempts=1)
        task_values["policy"] = TaskPolicy(
            max_concurrency=1,
            retry_limit=0,
            proxy_mode="required",
            proxy_probe_scope="address-1",
        ).model_dump()
        self.db.create_task(task_values)

        gallery = FakeGallery([GalleryRunResult(0, "done", False, "m", 101)])
        proxy = FakeProxy(with_nodes=True)
        scheduler = TaskScheduler(self.db, gallery, proxy, self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()

        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(proxy.acquisitions[0]["allowed_ids"], {"node-a", "node-b"})

    async def test_prefer_falls_back_to_direct_when_pool_is_empty(self):
        self.db.create_task(values(self.root, proxy_mode="prefer", attempts=1))
        gallery = FakeGallery([GalleryRunResult(0, "saved file", False, "m", 101)])
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")
        self.assertIsNone(gallery.calls[0]["proxy_url"])
        self.assertTrue(
            any("本次任务使用直连" in row["line"] for row in self.db.get_logs("task-1"))
        )

    async def test_pool_down_terminates_task_without_direct_fallback(self):
        # Core startup failure / pool down: both prefer and required tasks must
        # terminate with a reminder instead of silently downloading direct.
        for mode in ("prefer", "required"):
            with self.subTest(mode=mode):
                task_id = f"task-pool-down-{mode}"
                task_values = values(self.root, proxy_mode=mode, attempts=3)
                task_values["id"] = task_id
                self.db.create_task(task_values)
                gallery = FakeGallery([GalleryRunResult(0, "unused", False, "m", 101)])
                proxy = UnavailableProxy()
                scheduler = TaskScheduler(self.db, gallery, proxy, self.settings.scheduler)
                await scheduler.start()
                task = await self.wait_terminal(task_id)
                await scheduler.stop()
                self.assertEqual(task["status"], "failed")
                self.assertEqual(task["last_error_class"], "proxy_unavailable")
                self.assertEqual(task["attempt_count"], 1)
                self.assertEqual(gallery.calls, [])
                logs = [row["line"] for row in self.db.get_logs(task_id)]
                self.assertTrue(any("不会回退直连" in line for line in logs))
                self.assertFalse(any("本次任务使用直连" in line for line in logs))

    async def test_proxy_failure_switches_node_then_succeeds(self):
        self.db.create_task(values(self.root, proxy_mode="required", attempts=2))
        gallery = FakeGallery(
            [
                GalleryRunResult(4, "ProxyError: tunnel connection failed", False, "m1", 101),
                GalleryRunResult(0, "done", False, "m2", 102),
            ]
        )
        proxy = FakeProxy(with_nodes=True)
        scheduler = TaskScheduler(self.db, gallery, proxy, self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["attempt_count"], 2)
        self.assertEqual(proxy.releases[0], ("task-1", True))
        self.assertEqual(proxy.releases[1], ("task-1", False))

    async def test_cancel_between_claim_and_begin_attempt_stays_cancelled(self):
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=1))
        self.assertTrue(self.db.claim_task("task-1"))
        self.db.request_cancel("task-1")
        scheduler = TaskScheduler(self.db, FakeGallery([]), FakeProxy(), self.settings.scheduler)
        await scheduler._execute("task-1")
        self.assertEqual(self.db.get_task("task-1")["status"], "cancelled")

    async def test_release_exception_does_not_leave_running_task_or_db_lease(self):
        self.db.create_task(values(self.root, proxy_mode="required", attempts=1))
        gallery = FakeGallery([GalleryRunResult(0, "done", False, "m", 101)])
        proxy = ReleaseFailingProxy(with_nodes=True)
        scheduler = TaskScheduler(self.db, gallery, proxy, self.settings.scheduler)
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")
        self.assertIsNone(self.db.get_task("task-1")["lease"])

    async def test_proxy_credentials_are_redacted_before_database_and_logs(self):
        self.db.create_task(values(self.root, proxy_mode="required", attempts=1))
        gallery = FakeGallery([GalleryRunResult(0, "done", False, "m", 101)])
        scheduler = TaskScheduler(
            self.db,
            gallery,
            CredentialProxy(with_nodes=True),
            self.settings.scheduler,
        )
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        serialized = str(task) + str(self.db.get_logs("task-1"))
        self.assertNotIn("proxy-user", serialized)
        self.assertNotIn("proxy-secret", serialized)

    async def test_invalid_managed_login_pauses_queue_until_reauthorized(self):
        task_values = values(self.root, proxy_mode="direct", attempts=1)
        task_values.update({"site": "twitter", "cookies_file": str(self.root / "twitter.cookies.txt")})
        self.db.create_task(task_values)
        gallery = FakeGallery([GalleryRunResult(0, "done", False, "m", 101)])
        available = False

        def validate(_site, _cookies_file):
            return available

        scheduler = TaskScheduler(
            self.db,
            gallery,
            FakeProxy(),
            self.settings.scheduler,
            credential_validator=validate,
        )
        await scheduler.start()
        await asyncio.sleep(0.15)
        self.assertEqual(self.db.get_task("task-1")["status"], "queued")
        self.assertFalse(gallery.calls)
        available = True
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["status"], "succeeded")

    async def test_extraction_error_with_partial_artifacts_is_requeued(self):
        # bit 4 with a downloaded file recorded = partial success -> bounded retry.
        out_dir = self.root / "out"
        out_dir.mkdir()
        artifact = out_dir / "image_001.jpg"
        artifact.write_bytes(b"partial-download")
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=2))
        self.assertTrue(self.db.claim_task("task-1"))
        gallery = ArtifactGallery(
            [GalleryRunResult(
                4,
                "gallery_dl.exception.ExtractionError: unable to parse gallery page",
                False, "m", 101,
            )],
            stdout_paths=[artifact],
        )
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)
        await scheduler._execute("task-1")
        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["last_error_class"], "extraction_partial")

    async def test_extraction_error_without_artifacts_is_not_requeued(self):
        # bit 4 with zero downloaded files = pure extraction failure -> terminal,
        # even with retry budget remaining (attempts=2).
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=2))
        self.assertTrue(self.db.claim_task("task-1"))
        gallery = FakeGallery(
            [GalleryRunResult(
                4,
                "gallery_dl.exception.ExtractionError: unable to parse gallery page",
                False, "m", 101,
            )]
        )
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)
        await scheduler._execute("task-1")
        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["last_error_class"], "extraction_error")

    async def test_authentication_failure_notifies_managed_auth_callback(self):
        task_values = values(self.root, proxy_mode="direct", attempts=1)
        cookie_file = str(self.root / "twitter.cookies.txt")
        task_values.update({"site": "twitter", "cookies_file": cookie_file})
        self.db.create_task(task_values)
        gallery = FakeGallery(
            [GalleryRunResult(1, "authenticated cookies needed to access this timeline", False, "m", 101)]
        )
        calls = []

        async def invalidate(site, cookies, message):
            calls.append((site, cookies, message))
            return True

        scheduler = TaskScheduler(
            self.db,
            gallery,
            FakeProxy(),
            self.settings.scheduler,
            auth_failure_callback=invalidate,
        )
        await scheduler.start()
        task = await self.wait_terminal("task-1")
        await scheduler.stop()
        self.assertEqual(task["last_error_class"], "authentication")
        self.assertEqual(calls[0][:2], ("twitter", cookie_file))
        self.assertIn("authenticated cookies needed", calls[0][2])
        self.assertTrue(any("等待重新授权" in row["line"] for row in self.db.get_logs("task-1")))

    def _set_task_columns(self, task_id: str, **columns) -> None:
        assignments = ", ".join(f"{name}=?" for name in columns)
        with self.db._transaction() as conn:
            conn.execute(
                f"UPDATE tasks SET {assignments} WHERE id=?",
                (*columns.values(), task_id),
            )

    async def test_retry_backoff_is_capped_for_deep_attempt_sequences(self):
        # A task with a huge accumulated automatic-retry history (attempt_count=20,
        # anchor still 0) must not schedule base*2**19 (~1M s); the cap engages.
        # max_attempts is the DB gate the scheduler checks (not policy.retry_limit,
        # which pydantic caps at 20), so set it directly to leave retry budget.
        task_values = values(self.root, proxy_mode="direct", attempts=1)
        task_values["max_attempts"] = 30
        task_values["policy"] = SitePolicy(
            max_concurrency=1,
            retry_limit=1,
            backoff_base_seconds=2.0,
            proxy_mode="direct",
            gallery_retries=0,
        ).model_dump()
        self.db.create_task(task_values)
        self._set_task_columns("task-1", attempt_count=20)
        self.assertTrue(self.db.claim_task("task-1"))
        gallery = FakeGallery([GalleryRunResult(128, "download failed", False, "m", 101)])
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)

        before = time.time()
        await scheduler._execute("task-1")
        after = time.time()

        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "queued")
        cap = self.settings.scheduler.retry_backoff_cap_seconds
        jitter = self.settings.scheduler.retry_jitter_seconds
        # next_run_at was computed with time.time() inside _execute (>= before),
        # so (next_run_at - after) is a floor on the scheduled delay and must stay
        # within the cap; (next_run_at - before) is a ceiling and proves the cap
        # actually engaged rather than a tiny uncapped value slipping through.
        self.assertLessEqual(task["next_run_at"] - after, cap + jitter)
        self.assertGreaterEqual(task["next_run_at"] - before, cap)

    async def test_backoff_anchor_resets_exponent_for_a_manual_round(self):
        # A manual retry round pinned the anchor to the prior attempt_count (20) and
        # bumped max_attempts, so this round's first automatic retry restarts the
        # exponent at 0 -> delay ~= base, not the accumulated cap/huge value.
        task_values = values(self.root, proxy_mode="direct", attempts=1)
        task_values["policy"] = SitePolicy(
            max_concurrency=1,
            retry_limit=0,
            backoff_base_seconds=2.0,
            proxy_mode="direct",
            gallery_retries=0,
        ).model_dump()
        self.db.create_task(task_values)
        self._set_task_columns(
            "task-1", attempt_count=20, max_attempts=22, backoff_anchor_attempt=20
        )
        self.assertTrue(self.db.claim_task("task-1"))
        gallery = FakeGallery([GalleryRunResult(128, "download failed", False, "m", 101)])
        scheduler = TaskScheduler(self.db, gallery, FakeProxy(), self.settings.scheduler)

        before = time.time()
        await scheduler._execute("task-1")
        after = time.time()

        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "queued")
        base = 2.0
        jitter = self.settings.scheduler.retry_jitter_seconds
        # exponent = attempt_no(21) - 1 - anchor(20) = 0 -> delay == base (fresh).
        self.assertLessEqual(task["next_run_at"] - after, base + jitter)
        self.assertGreaterEqual(task["next_run_at"] - before, base)


if __name__ == "__main__":
    unittest.main()
