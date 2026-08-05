from __future__ import annotations

import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from gdl_backend.crawl import CrawlUnit
from gdl_backend.database import Database
from gdl_backend.gallery import GalleryRunResult
from gdl_backend.log_writer import TaskLogWriter
from gdl_backend.ordered_crawl import OrderedCrawlManager
from gdl_backend.scheduler import TaskScheduler
from gdl_backend.schemas import SitePolicy, TaskPolicy

from tests.helpers import make_settings


class _SchedulerStub:
    def __init__(self) -> None:
        self.cancelled: list[str] = []
        self.notify_count = 0

    async def cancel(self, task_id: str):
        self.cancelled.append(task_id)
        return None

    def notify(self) -> None:
        self.notify_count += 1


class _ActiveBatchDatabase:
    """只为监督循环提供线程安全的活跃批次快照。"""

    def __init__(self, batch_ids: list[str]) -> None:
        self._batch_ids = list(batch_ids)
        self._lock = threading.Lock()

    def recover_ordered_crawls(self) -> int:
        return 0

    def active_crawl_batch_ids(self) -> list[str]:
        with self._lock:
            return list(self._batch_ids)

    def deactivate(self, batch_id: str) -> None:
        with self._lock:
            if batch_id in self._batch_ids:
                self._batch_ids.remove(batch_id)


async def _empty_enqueue(_bodies, _keys, _concurrency):
    return []


def _policy_for(_site: str) -> SitePolicy:
    return SitePolicy(
        max_concurrency=2,
        retry_limit=0,
        backoff_base_seconds=0.0,
        proxy_mode="direct",
    )


def _supervisor_manager(
    database: _ActiveBatchDatabase,
    *,
    max_concurrent_batches: int = 4,
) -> OrderedCrawlManager:
    manager = OrderedCrawlManager(
        database,  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        _SchedulerStub(),  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        _policy_for,
        poll_interval=0.05,
        max_concurrent_batches=max_concurrent_batches,
    )
    manager.set_enqueue(_empty_enqueue)
    return manager


class OrderedCrawlSupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_loop_count_capped(self):
        batch_ids = [f"batch-{index}" for index in range(8)]
        database = _ActiveBatchDatabase(batch_ids)
        manager = _supervisor_manager(database, max_concurrent_batches=4)
        gates = {batch_id: asyncio.Event() for batch_id in batch_ids}
        first_wave_started = asyncio.Event()
        all_started = asyncio.Event()
        started: set[str] = set()
        ticking: set[str] = set()
        peak = 0

        async def fake_tick(batch_id: str) -> bool:
            nonlocal peak
            started.add(batch_id)
            ticking.add(batch_id)
            peak = max(peak, len(ticking))
            if len(started) >= 4:
                first_wave_started.set()
            if len(started) == len(batch_ids):
                all_started.set()
            try:
                await gates[batch_id].wait()
            finally:
                ticking.discard(batch_id)
            database.deactivate(batch_id)
            return False

        manager._tick_batch = fake_tick  # type: ignore[method-assign]
        await manager.start()
        self.addAsyncCleanup(manager.stop)
        await asyncio.wait_for(first_wave_started.wait(), timeout=2.0)

        self.assertEqual(len(manager._batch_tasks), 4)
        self.assertLessEqual(peak, 4)
        first_wave = set(started)
        self.assertEqual(len(first_wave), 4)
        status = manager.status()
        self.assertEqual(status["running_batch_loops"], 4)
        self.assertEqual(status["max_concurrent_batches"], 4)
        self.assertEqual(status["site_planning_locked"], [])
        self.assertEqual(status["execution_order"], "source_then_address")
        self.assertEqual(status["address_parallelism"], "media_tasks")

        for batch_id in first_wave:
            gates[batch_id].set()
        await asyncio.wait_for(all_started.wait(), timeout=2.0)
        self.assertLessEqual(len(manager._batch_tasks), 4)
        self.assertLessEqual(peak, 4)

    async def test_one_batch_exception_does_not_stop_others(self):
        database = _ActiveBatchDatabase(["broken", "healthy"])
        manager = _supervisor_manager(database, max_concurrent_batches=2)
        calls = {"broken": 0, "healthy": 0}
        healthy_advanced = asyncio.Event()

        async def fake_tick(batch_id: str) -> bool:
            calls[batch_id] += 1
            if batch_id == "broken":
                raise RuntimeError("单批次测试异常")
            if calls[batch_id] >= 2:
                healthy_advanced.set()
            return True

        manager._tick_batch = fake_tick  # type: ignore[method-assign]
        await manager.start()
        self.addAsyncCleanup(manager.stop)
        await asyncio.wait_for(healthy_advanced.wait(), timeout=2.0)

        self.assertGreaterEqual(calls["broken"], 1)
        self.assertGreaterEqual(calls["healthy"], 2)
        self.assertIsNotNone(manager._loop_task)
        self.assertFalse(manager._loop_task.done())

    async def test_stop_cancels_all_batch_loops(self):
        batch_ids = ["batch-a", "batch-b", "batch-c"]
        database = _ActiveBatchDatabase(batch_ids)
        manager = _supervisor_manager(database, max_concurrent_batches=3)
        entered = asyncio.Event()
        never = asyncio.Event()
        active: set[str] = set()
        cancelled: set[str] = set()

        async def fake_tick(batch_id: str) -> bool:
            active.add(batch_id)
            if len(active) == len(batch_ids):
                entered.set()
            try:
                await never.wait()
            finally:
                cancelled.add(batch_id)
            return True

        manager._tick_batch = fake_tick  # type: ignore[method-assign]
        await manager.start()
        await asyncio.wait_for(entered.wait(), timeout=2.0)
        tasks = list(manager._batch_tasks.values())

        await manager.stop()

        self.assertEqual(manager._batch_tasks, {})
        self.assertEqual(manager._batch_wakes, {})
        self.assertEqual(cancelled, set(batch_ids))
        self.assertTrue(all(task.done() for task in tasks))

    async def test_notify_wakes_all_batch_loops(self):
        batch_ids = ["batch-a", "batch-b", "batch-c"]
        database = _ActiveBatchDatabase(batch_ids)
        manager = _supervisor_manager(database, max_concurrent_batches=3)
        manager.poll_interval = 60.0
        calls = {batch_id: 0 for batch_id in batch_ids}
        first_ticks_started = asyncio.Event()
        release_first_ticks = asyncio.Event()
        all_batch_loops_waiting = asyncio.Event()
        waiting: set[str] = set()
        second_ticks = asyncio.Event()

        async def fake_tick(batch_id: str) -> bool:
            calls[batch_id] += 1
            if calls[batch_id] == 1:
                if all(count == 1 for count in calls.values()):
                    first_ticks_started.set()
                await release_first_ticks.wait()
            if all(count >= 2 for count in calls.values()):
                second_ticks.set()
            return True

        manager._tick_batch = fake_tick  # type: ignore[method-assign]
        await manager.start()
        self.addAsyncCleanup(manager.stop)
        await asyncio.wait_for(first_ticks_started.wait(), timeout=2.0)

        self.assertEqual(set(manager._batch_wakes), set(batch_ids))
        for batch_id, wake in manager._batch_wakes.items():
            original_wait = wake.wait

            async def tracked_wait(
                batch_id: str = batch_id,
                original_wait=original_wait,
            ) -> bool:
                waiting.add(batch_id)
                if waiting == set(batch_ids):
                    all_batch_loops_waiting.set()
                return await original_wait()

            wake.wait = tracked_wait  # type: ignore[method-assign]

        release_first_ticks.set()
        await asyncio.wait_for(all_batch_loops_waiting.wait(), timeout=2.0)
        self.assertTrue(all(count == 1 for count in calls.values()))

        manager.notify()
        await asyncio.wait_for(second_ticks.wait(), timeout=2.0)

        self.assertTrue(all(count >= 2 for count in calls.values()))


class OrderedCrawlPlanningConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3")
        self.scheduler = _SchedulerStub()
        self.manager = OrderedCrawlManager(
            self.db,
            object(),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            self.scheduler,  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            _policy_for,
            poll_interval=0.05,
            max_concurrent_batches=4,
        )
        self.manager.set_enqueue(self._enqueue)
        self.pending_tasks: list[asyncio.Task] = []

    async def asyncTearDown(self):
        for task in self.pending_tasks:
            if not task.done():
                task.cancel()
        if self.pending_tasks:
            await asyncio.gather(*self.pending_tasks, return_exceptions=True)
        await self.manager.stop()
        self.db.close()
        self.temp.cleanup()

    def _create_batch(self, batch_id: str, site: str) -> tuple[dict, dict]:
        if site == "danbooru":
            url = f"https://danbooru.donmai.us/posts?tags={batch_id}"
        else:
            url = f"https://e-hentai.org/g/{batch_id}/TOKEN/"
        address_id = f"address-{batch_id}"
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.root / batch_id),
                "concurrency": 4,
                "max_tasks": 20,
            },
            [
                {
                    "id": address_id,
                    "site": site,
                    "source_order": 0,
                    "address_order": 0,
                    "url": url,
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                }
            ],
        )
        batch = self.db.crawl_batch_tick_view(batch_id)
        address = self.db.next_crawl_address(batch_id)
        assert batch is not None
        assert address is not None
        return batch, address

    @staticmethod
    def _unit(address: dict) -> CrawlUnit:
        address_id = str(address["id"])
        return CrawlUnit(
            url=f"https://media.example/{address_id}.jpg",
            site=str(address["site"]),
            kind="media",
            source_id=address_id,
            source_key=f"source:{address_id}",
            source_url=str(address["url"]),
        )

    async def _enqueue(self, bodies, keys, _concurrency):
        items = []
        address_id = ""
        for body, key in zip(bodies, keys):
            link = body._crawl_link
            if link is None:
                raise AssertionError("测试任务缺少 crawl link")
            address_id = link.address_id
            policy = body._policy_override or _policy_for(str(body.site))
            items.append(
                {
                    "task": {
                        "id": f"task-{link.address_id}-{link.sequence_no}",
                        "url": body.url,
                        "site": body.site,
                        "subcategory": "",
                        "extractor": "",
                        "priority": body.priority,
                        "output_dir": body.output_dir,
                        "proxy_mode": body.proxy_mode,
                        "max_attempts": body.max_attempts,
                        "cookies_file": body.cookies_file,
                        "config_file": body.config_file,
                        "credentials_ref": body.credentials_ref,
                        "extra_args": list(body.extra_args),
                        "policy": policy.model_dump(),
                    },
                    "idempotency_key": key,
                    "sequence_no": link.sequence_no,
                    "source_key": link.source_key,
                    "source_url": link.source_url,
                }
            )
        return await asyncio.to_thread(
            self.db.create_crawl_media_tasks,
            address_id,
            items,
        )

    def _track(self, task: asyncio.Task) -> asyncio.Task:
        self.pending_tasks.append(task)
        return task

    async def test_two_batches_different_sites_overlap(self):
        batch_a, address_a = self._create_batch("different-a", "danbooru")
        batch_b, address_b = self._create_batch("different-b", "exhentai")
        active: set[str] = set()
        peak = 0
        both_discovering = asyncio.Event()
        both_enqueued = asyncio.Event()
        release = asyncio.Event()
        enqueue_count = 0
        base_enqueue = self._enqueue

        async def fake_probe(address, policy):
            nonlocal peak
            active.add(address["id"])
            peak = max(peak, len(active))
            if len(active) == 2:
                both_discovering.set()
            return TaskPolicy.model_validate(policy.model_dump())

        async def fake_plan(address, **_kwargs):
            try:
                await release.wait()
                return [self._unit(address)], 0
            finally:
                active.discard(address["id"])

        async def tracked_enqueue(bodies, keys, concurrency):
            nonlocal enqueue_count
            results = await base_enqueue(bodies, keys, concurrency)
            enqueue_count += 1
            if enqueue_count == 2:
                both_enqueued.set()
            return results

        self.manager.set_enqueue(tracked_enqueue)
        with patch.object(
            self.manager,
            "_probe_address_policy",
            new=fake_probe,
        ), patch.object(self.manager, "_plan_address", new=fake_plan):
            await self.manager.start()
            await asyncio.wait_for(both_discovering.wait(), timeout=2.0)
            self.assertEqual(peak, 2)
            self.assertEqual(
                self.manager.status()["site_planning_locked"],
                ["danbooru", "exhentai"],
            )
            release.set()
            await asyncio.wait_for(both_enqueued.wait(), timeout=2.0)

        self.assertEqual(self.manager.status()["site_planning_locked"], [])

    async def test_two_batches_same_site_serialize(self):
        batch_a, address_a = self._create_batch("same-a", "danbooru")
        batch_b, address_b = self._create_batch("same-b", "danbooru")
        active: set[str] = set()
        order: list[tuple[str, str]] = []
        peak = 0
        first_entered = asyncio.Event()
        second_began = asyncio.Event()
        release_first = asyncio.Event()
        both_enqueued = asyncio.Event()
        enqueue_count = 0
        base_enqueue = self._enqueue
        original_begin = self.db.begin_crawl_address_planning

        def begin(address_id: str) -> bool:
            result = original_begin(address_id)
            if address_id == address_b["id"] and result:
                second_began.set()
            return result

        async def fake_probe(address, policy):
            nonlocal peak
            active.add(address["id"])
            order.append(("enter", address["id"]))
            peak = max(peak, len(active))
            if address["id"] == address_a["id"]:
                first_entered.set()
            return TaskPolicy.model_validate(policy.model_dump())

        async def fake_plan(address, **_kwargs):
            if address["id"] == address_a["id"]:
                await release_first.wait()
            order.append(("exit", address["id"]))
            active.discard(address["id"])
            return [self._unit(address)], 0

        async def tracked_enqueue(bodies, keys, concurrency):
            nonlocal enqueue_count
            results = await base_enqueue(bodies, keys, concurrency)
            enqueue_count += 1
            if enqueue_count == 2:
                both_enqueued.set()
            return results

        self.manager.set_enqueue(tracked_enqueue)
        with patch.object(
            self.db,
            "begin_crawl_address_planning",
            side_effect=begin,
        ), patch.object(
            self.manager,
            "_probe_address_policy",
            new=fake_probe,
        ), patch.object(self.manager, "_plan_address", new=fake_plan):
            await self.manager.start()
            await asyncio.wait_for(first_entered.wait(), timeout=2.0)
            await asyncio.wait_for(second_began.wait(), timeout=2.0)
            await asyncio.sleep(0)
            self.assertEqual(peak, 1)
            self.assertEqual(
                self.manager.status()["site_planning_locked"],
                ["danbooru"],
            )
            release_first.set()
            await asyncio.wait_for(both_enqueued.wait(), timeout=2.0)

        self.assertEqual(peak, 1)
        self.assertEqual(
            order,
            [
                ("enter", address_a["id"]),
                ("exit", address_a["id"]),
                ("enter", address_b["id"]),
                ("exit", address_b["id"]),
            ],
        )

    async def test_site_lock_released_before_chunk_enqueue(self):
        batch_a, address_a = self._create_batch("enqueue-a", "danbooru")
        batch_b, address_b = self._create_batch("enqueue-b", "danbooru")
        first_enqueue_entered = asyncio.Event()
        second_probe_entered = asyncio.Event()
        release_first_enqueue = asyncio.Event()
        base_enqueue = self._enqueue

        async def fake_probe(address, policy):
            if address["id"] == address_b["id"]:
                second_probe_entered.set()
            return TaskPolicy.model_validate(policy.model_dump())

        async def fake_plan(address, **_kwargs):
            return [self._unit(address)], 0

        async def blocking_enqueue(bodies, keys, concurrency):
            link = bodies[0]._crawl_link
            if link is not None and link.address_id == address_a["id"]:
                first_enqueue_entered.set()
                await release_first_enqueue.wait()
            return await base_enqueue(bodies, keys, concurrency)

        self.manager.set_enqueue(blocking_enqueue)
        with patch.object(
            self.manager,
            "_probe_address_policy",
            new=fake_probe,
        ), patch.object(self.manager, "_plan_address", new=fake_plan):
            first = self._track(
                asyncio.create_task(self.manager._activate_address(batch_a, address_a))
            )
            await asyncio.wait_for(first_enqueue_entered.wait(), timeout=2.0)
            second = self._track(
                asyncio.create_task(self.manager._activate_address(batch_b, address_b))
            )
            await asyncio.wait_for(second_probe_entered.wait(), timeout=2.0)
            release_first_enqueue.set()
            await asyncio.gather(first, second)

    async def test_tick_view_used_in_poll_path(self):
        batch, _address = self._create_batch("tick-path", "danbooru")

        async def fake_plan(address, **_kwargs):
            return [self._unit(address)], 0

        tick_view = self.db.crawl_batch_tick_view
        with patch.object(
            self.db,
            "get_crawl_batch",
            side_effect=AssertionError("轮询路径不得加载完整批次"),
        ), patch.object(
            self.db,
            "crawl_batch_tick_view",
            wraps=tick_view,
        ) as tick_mock, patch.object(
            self.manager,
            "_plan_address",
            new=fake_plan,
        ):
            await self.manager.run_once()

        current = self.db.next_crawl_address(batch["id"])
        self.assertIsNotNone(current)
        self.assertEqual(current["status"], "running")
        self.assertGreaterEqual(tick_mock.call_count, 4)


class _DirectProxy:
    def acquire(self, _task_id: str, **_kwargs):
        return None

    def release(self, _task_id: str, **_kwargs) -> None:
        return None


class _PeakGallery:
    def __init__(self, expected: int) -> None:
        self.expected = expected
        self.active = 0
        self.peak = 0
        self.started = 0
        self.two_started = asyncio.Event()
        self.all_started = asyncio.Event()
        self.release = asyncio.Event()

    async def run(self, task_id: str, **kwargs):
        await kwargs["on_started"](100 + self.started, f"marker-{task_id}")
        self.active += 1
        self.started += 1
        self.peak = max(self.peak, self.active)
        if self.active >= 2:
            self.two_started.set()
        if self.started == self.expected:
            self.all_started.set()
        try:
            await self.release.wait()
        finally:
            self.active -= 1
        return GalleryRunResult(0, "done", False, f"marker-{task_id}", 100)

    async def cancel(self, _task_id: str) -> bool:
        return True

    async def stop_all(self) -> None:
        self.release.set()


class SchedulerSiteConcurrencyRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_site_download_concurrency_still_capped(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        settings = make_settings(root)
        settings.scheduler.max_concurrent_tasks = 20
        database = Database(settings.database_path)
        log_writer = TaskLogWriter(database)
        gallery = _PeakGallery(expected=4)
        policy = TaskPolicy(
            max_concurrency=2,
            retry_limit=0,
            backoff_base_seconds=0.0,
            proxy_mode="direct",
            gallery_retries=0,
        )
        scheduler = TaskScheduler(
            database,
            gallery,  # type: ignore[arg-type]
            _DirectProxy(),  # type: ignore[arg-type]
            settings.scheduler,
            log_writer,
        )
        stopped = False
        try:
            for index in range(4):
                batch_id = f"scheduler-batch-{index}"
                address_id = f"scheduler-address-{index}"
                database.create_crawl_batch(
                    {
                        "id": batch_id,
                        "output_dir": str(root / batch_id),
                        "concurrency": 4,
                        "max_tasks": 10,
                    },
                    [
                        {
                            "id": address_id,
                            "site": "danbooru",
                            "source_order": 0,
                            "address_order": 0,
                            "url": f"https://danbooru.donmai.us/posts/{index}",
                            "proxy_mode": "direct",
                            "max_attempts": 1,
                        }
                    ],
                )
                database.create_crawl_media_tasks(
                    address_id,
                    [
                        {
                            "task": {
                                "id": f"scheduler-task-{index}",
                                "url": f"https://danbooru.donmai.us/posts/{index}",
                                "site": "danbooru",
                                "output_dir": str(root / batch_id),
                                "proxy_mode": "direct",
                                "max_attempts": 1,
                                "policy": policy.model_dump(),
                                "extra_args": [],
                            },
                            "idempotency_key": f"scheduler-task-key-{index}",
                            "sequence_no": 1,
                            "source_key": f"danbooru:{index}",
                            "source_url": f"https://danbooru.donmai.us/posts/{index}",
                        }
                    ],
                )

            await scheduler.start()
            await asyncio.wait_for(gallery.two_started.wait(), timeout=2.0)
            self.assertEqual(gallery.active, 2)
            self.assertLessEqual(gallery.peak, 2)

            gallery.release.set()
            await asyncio.wait_for(gallery.all_started.wait(), timeout=2.0)
            await scheduler.stop()
            stopped = True

            self.assertLessEqual(gallery.peak, 2)
            self.assertEqual(gallery.started, 4)
            self.assertTrue(
                all(
                    database.get_task(f"scheduler-task-{index}")["status"]
                    == "succeeded"
                    for index in range(4)
                )
            )
        finally:
            gallery.release.set()
            if not stopped:
                await scheduler.stop()
            await log_writer.stop()
            database.close()
            temp.cleanup()


if __name__ == "__main__":
    unittest.main()
