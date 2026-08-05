from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gdl_backend.database import Database
from gdl_backend.log_writer import TaskLogWriter


def task_values(root: Path) -> dict:
    return {
        "id": "task-1",
        "url": "https://example.com/gallery/1",
        "site": "example.com",
        "subcategory": "gallery",
        "extractor": "ExampleExtractor",
        "output_dir": str(root / "out"),
        "proxy_mode": "direct",
        "max_attempts": 1,
        "policy": {"max_concurrency": 1},
        "extra_args": [],
    }


class TaskLogWriterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3")
        self.db.create_task(task_values(self.root))
        self.writers: list[TaskLogWriter] = []

    async def asyncTearDown(self) -> None:
        for writer in reversed(self.writers):
            await writer.stop()
        self.db.close()
        self.temp.cleanup()

    def make_writer(self, **kwargs) -> TaskLogWriter:
        writer = TaskLogWriter(self.db, **kwargs)
        self.writers.append(writer)
        return writer

    async def get_logs(self) -> list[dict]:
        return await asyncio.to_thread(self.db.get_logs, "task-1", limit=5000)

    async def wait_for_logs(self, count: int, *, timeout: float = 2.0) -> list[dict]:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            logs = await self.get_logs()
            if len(logs) >= count:
                return logs
            await asyncio.sleep(0.01)
        self.fail(f"日志未在期限内达到 {count} 行")

    async def test_flush_by_row_count(self) -> None:
        writer = self.make_writer(flush_interval=60.0)
        await writer.start()

        for index in range(64):
            writer.push("task-1", None, "stdout", f"line-{index:03d}")

        logs = await self.wait_for_logs(64)
        self.assertEqual(len(logs), 64)

    async def test_flush_by_interval(self) -> None:
        writer = self.make_writer()
        await writer.start()

        with mock.patch("gdl_backend.log_writer.time.time", return_value=1234.5):
            writer.push("task-1", None, "stdout", "interval-line")
        await asyncio.sleep(0)
        self.assertEqual(await self.get_logs(), [])

        logs = await self.wait_for_logs(1)
        self.assertEqual(logs[0]["line"], "interval-line")
        self.assertEqual(logs[0]["ts"], 1234.5)

    async def test_order_preserved(self) -> None:
        writer = self.make_writer(flush_interval=60.0)
        for index in range(500):
            writer.push("task-1", None, "stdout", f"line-{index:03d}")

        await writer.flush()

        logs = await self.get_logs()
        self.assertEqual(
            [row["line"] for row in logs],
            [f"line-{index:03d}" for index in range(500)],
        )

    async def test_overflow_emits_marker(self) -> None:
        writer = self.make_writer(
            flush_interval=60.0,
            flush_rows=64,
            max_pending=10,
        )
        for index in range(50):
            writer.push("task-1", None, "stdout", f"line-{index:03d}")

        await writer.flush()

        logs = await self.get_logs()
        markers = [
            row for row in logs
            if row["stream"] == "backend" and "已丢弃" in row["line"]
        ]
        self.assertEqual(len(markers), 1)
        self.assertIn("40 行", markers[0]["line"])
        self.assertEqual(len(logs), 11)
        self.assertEqual(
            [row["line"] for row in logs if row["stream"] == "stdout"],
            [f"line-{index:03d}" for index in range(40, 50)],
        )

    async def test_bulk_insert_prunes_deterministically(self) -> None:
        self.db.max_logs_per_task = 100
        writer = self.make_writer(flush_interval=60.0)
        for index in range(500):
            writer.push("task-1", None, "stdout", f"line-{index:03d}")

        await writer.flush()

        logs = await self.get_logs()
        self.assertLessEqual(len(logs), 100)
        self.assertEqual(logs[0]["line"], "line-400")
        self.assertEqual(logs[-1]["line"], "line-499")

    async def test_flush_failure_does_not_break_loop(self) -> None:
        writer = self.make_writer(flush_interval=60.0, flush_rows=1)
        original_append = self.db.append_logs_bulk
        first_attempt = asyncio.Event()
        loop = asyncio.get_running_loop()
        call_count = 0

        def append_with_one_failure(rows):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                loop.call_soon_threadsafe(first_attempt.set)
                raise sqlite3.OperationalError("token=writer-secret")
            return original_append(rows)

        with (
            mock.patch.object(
                self.db,
                "append_logs_bulk",
                side_effect=append_with_one_failure,
            ),
            self.assertLogs("gdl_backend.log_writer", level="WARNING") as warnings,
        ):
            await writer.start()
            writer.push("task-1", None, "stdout", "discarded-line")
            await asyncio.wait_for(first_attempt.wait(), timeout=1.0)
            writer.push("task-1", None, "stdout", "persisted-line")
            logs = await self.wait_for_logs(1)

        self.assertEqual([row["line"] for row in logs], ["persisted-line"])
        self.assertGreaterEqual(call_count, 2)
        self.assertNotIn("writer-secret", "\n".join(warnings.output))

    async def test_stop_flushes_pending(self) -> None:
        writer = self.make_writer(flush_interval=60.0)
        await writer.start()
        writer.push("task-1", None, "stderr", "token=stop-secret")

        await writer.stop()

        logs = await self.get_logs()
        self.assertEqual(len(logs), 1)
        self.assertNotIn("stop-secret", logs[0]["line"])


if __name__ == "__main__":
    unittest.main()
