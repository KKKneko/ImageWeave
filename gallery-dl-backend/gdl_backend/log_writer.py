from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import TypeAlias

from .database import Database
from .redaction import redact_text


logger = logging.getLogger(__name__)

LogRow: TypeAlias = tuple[str, str | None, float, str, str]


class TaskLogWriter:
    def __init__(
        self,
        db: Database,
        *,
        flush_interval: float = 0.2,
        flush_rows: int = 64,
        max_pending: int = 20000,
    ) -> None:
        if flush_interval <= 0:
            raise ValueError("flush_interval 必须大于 0")
        if flush_rows <= 0:
            raise ValueError("flush_rows 必须大于 0")
        if max_pending <= 0:
            raise ValueError("max_pending 必须大于 0")
        self.db = db
        self.flush_interval = float(flush_interval)
        self.flush_rows = int(flush_rows)
        self.max_pending = int(max_pending)
        self._pending: deque[LogRow] = deque(maxlen=self.max_pending)
        self._event = asyncio.Event()
        self._flush_lock = asyncio.Lock()
        self._loop_task: asyncio.Task[None] | None = None
        self._stopping = False
        self.dropped_count = 0
        self._dropped_target: tuple[str, str | None] | None = None
        self._dropped_ts: float | None = None

    async def start(self) -> None:
        if self._loop_task is not None and not self._loop_task.done():
            return
        if self._loop_task is not None:
            await asyncio.gather(self._loop_task, return_exceptions=True)
        self._stopping = False
        self._loop_task = asyncio.create_task(
            self._flush_loop(),
            name="task-log-writer",
        )

    async def stop(self) -> None:
        task = self._loop_task
        if task is None:
            await self.flush()
            self._event.clear()
            return
        self._stopping = True
        self._event.set()
        await asyncio.gather(task, return_exceptions=True)
        self._loop_task = None
        # 后台循环退出后再取一次快照，覆盖退出交界处到达的日志。
        await self.flush()
        self._event.clear()

    def push(
        self,
        task_id: str,
        attempt_id: str | None,
        stream: str,
        line: str,
    ) -> None:
        ts = time.time()
        if len(self._pending) >= self.max_pending:
            dropped = self._pending.popleft()
            if self.dropped_count == 0:
                self._dropped_target = (dropped[0], dropped[1])
                self._dropped_ts = dropped[2]
            self.dropped_count += 1
        self._pending.append((task_id, attempt_id, ts, stream, line))
        if len(self._pending) >= self.flush_rows:
            self._event.set()

    async def flush(self) -> None:
        async with self._flush_lock:
            rows = self._take_pending()
            if not rows:
                return
            try:
                await asyncio.to_thread(self.db.append_logs_bulk, rows)
            except Exception as exc:
                logger.warning(
                    "任务日志批量落库失败，已丢弃 %d 行：%s",
                    len(rows),
                    redact_text(exc, limit=500),
                )

    def _take_pending(self) -> list[LogRow]:
        rows: list[LogRow] = []
        if self.dropped_count:
            target = self._dropped_target
            if target is None and self._pending:
                target = (self._pending[0][0], self._pending[0][1])
            if target is not None:
                rows.append(
                    (
                        target[0],
                        target[1],
                        self._dropped_ts if self._dropped_ts is not None else time.time(),
                        "backend",
                        f"因日志缓冲溢出已丢弃 {self.dropped_count} 行输出",
                    )
                )
            self.dropped_count = 0
            self._dropped_target = None
            self._dropped_ts = None
        rows.extend(self._pending)
        self._pending.clear()
        return rows

    async def _flush_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(
                    self._event.wait(),
                    timeout=self.flush_interval,
                )
            except asyncio.TimeoutError:
                pass
            self._event.clear()
            await self.flush()
            if self._stopping:
                return
