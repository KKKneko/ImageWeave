from __future__ import annotations

import asyncio
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import httpx

from gdl_backend import diagnostics
from gdl_backend.app import ServiceContainer, create_app

from tests.helpers import make_settings


def _components(summary: str) -> dict[str, dict[str, object]]:
    return {
        name: {
            "status": "ok",
            "required": True,
            "summary": summary,
        }
        for name in ("dedup", "dedup_python", "torch", "sscd_model", "dino_model")
    }


class DiagnosticsCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.settings.dedup.enabled = True
        with diagnostics._DEDUP_CACHE_LOCK:
            diagnostics._DEDUP_CACHE.clear()
            diagnostics._DEDUP_REFRESH_INFLIGHT.clear()

    def tearDown(self) -> None:
        with diagnostics._DEDUP_CACHE_LOCK:
            diagnostics._DEDUP_CACHE.clear()
            diagnostics._DEDUP_REFRESH_INFLIGHT.clear()
        self.temp.cleanup()

    def _put_cache(
        self,
        components: dict[str, dict[str, object]],
        *,
        age_seconds: float,
    ) -> None:
        key = diagnostics._dedup_cache_key(self.settings)
        with diagnostics._DEDUP_CACHE_LOCK:
            diagnostics._DEDUP_CACHE[key] = (
                time.monotonic() - age_seconds,
                components,
            )

    def test_readyz_does_not_block_event_loop(self) -> None:
        asyncio.run(self._assert_readyz_does_not_block_event_loop())

    async def _assert_readyz_does_not_block_event_loop(self) -> None:
        probe_started = threading.Event()
        release_probe = threading.Event()
        completion_order: list[str] = []

        def blocking_dedup_components(*_args, **_kwargs):
            probe_started.set()
            if not release_probe.wait(timeout=10.0):
                raise RuntimeError("测试未放行诊断探测")
            return _components("探测完成")

        container = ServiceContainer(self.settings)
        app = create_app(self.settings, container=container, start_background=False)
        transport = httpx.ASGITransport(app=app)
        ready_task: asyncio.Task[httpx.Response] | None = None
        ready_response: httpx.Response | None = None
        try:
            async with httpx.AsyncClient(
                transport=transport,
                base_url=f"http://127.0.0.1:{self.settings.server.port}",
            ) as client:
                with patch.object(
                    diagnostics,
                    "dedup_components",
                    side_effect=blocking_dedup_components,
                ):
                    ready_task = asyncio.create_task(client.get("/readyz"))
                    started = await asyncio.to_thread(probe_started.wait, 5.0)
                    self.assertTrue(started, "readyz 未进入阻塞诊断探测")
                    self.assertFalse(ready_task.done())

                    try:
                        health_response = await asyncio.wait_for(
                            client.get("/healthz"),
                            timeout=5.0,
                        )
                        completion_order.append("healthz")
                        self.assertEqual(health_response.status_code, 200)
                        self.assertFalse(ready_task.done())
                        self.assertEqual(completion_order, ["healthz"])
                    finally:
                        release_probe.set()
                        ready_response = await asyncio.wait_for(
                            asyncio.shield(ready_task),
                            timeout=5.0,
                        )
                        completion_order.append("readyz")
        finally:
            release_probe.set()
            if ready_task is not None and not ready_task.done():
                ready_task.cancel()
                await asyncio.gather(ready_task, return_exceptions=True)
            container.db.close()

        self.assertIsNotNone(ready_response)
        self.assertEqual(ready_response.status_code, 200)
        self.assertEqual(completion_order, ["healthz", "readyz"])

    def test_dedup_components_returns_stale_immediately(self) -> None:
        cached = _components("旧缓存")
        refreshed = _components("刷新结果")
        self._put_cache(
            cached,
            age_seconds=diagnostics._DEDUP_CACHE_FRESH_SECONDS + 1.0,
        )
        probe_started = threading.Event()
        release_probe = threading.Event()
        probe_threads: list[threading.Thread] = []

        def blocking_probe(_settings):
            probe_threads.append(threading.current_thread())
            probe_started.set()
            if not release_probe.wait(timeout=10.0):
                raise RuntimeError("测试未放行缓存刷新")
            return refreshed

        with patch.object(
            diagnostics,
            "_probe_dedup_components",
            side_effect=blocking_probe,
        ):
            try:
                result = diagnostics.dedup_components(self.settings)
                self.assertTrue(probe_started.wait(timeout=5.0))
                self.assertEqual(result["dedup"]["summary"], "旧缓存")
                for component in result.values():
                    self.assertIs(component["stale"], True)
                    self.assertGreaterEqual(
                        component["age_seconds"],
                        diagnostics._DEDUP_CACHE_FRESH_SECONDS,
                    )
                self.assertEqual(len(probe_threads), 1)
                self.assertTrue(probe_threads[0].daemon)
            finally:
                release_probe.set()
                for thread in probe_threads:
                    if thread is not threading.current_thread():
                        thread.join(timeout=5.0)
                        self.assertFalse(thread.is_alive())

            fresh = diagnostics.dedup_components(self.settings)
            self.assertEqual(fresh["dedup"]["summary"], "刷新结果")
            self.assertNotIn("stale", fresh["dedup"])
            self.assertNotIn("age_seconds", fresh["dedup"])

    def test_dedup_components_single_flight(self) -> None:
        self._put_cache(
            _components("旧缓存"),
            age_seconds=diagnostics._DEDUP_CACHE_FRESH_SECONDS + 1.0,
        )
        probe_started = threading.Event()
        release_probe = threading.Event()
        call_lock = threading.Lock()
        probe_calls = 0
        probe_threads: list[threading.Thread] = []

        def blocking_probe(_settings):
            nonlocal probe_calls
            with call_lock:
                probe_calls += 1
                probe_threads.append(threading.current_thread())
            probe_started.set()
            if not release_probe.wait(timeout=10.0):
                raise RuntimeError("测试未放行缓存刷新")
            return _components("刷新结果")

        with patch.object(
            diagnostics,
            "_probe_dedup_components",
            side_effect=blocking_probe,
        ):
            try:
                with ThreadPoolExecutor(max_workers=8) as executor:
                    futures = [
                        executor.submit(diagnostics.dedup_components, self.settings)
                        for _ in range(8)
                    ]
                    results = [future.result(timeout=5.0) for future in futures]
                self.assertTrue(probe_started.wait(timeout=5.0))
                self.assertEqual(probe_calls, 1)
                self.assertTrue(
                    all(result["dedup"].get("stale") is True for result in results)
                )
            finally:
                release_probe.set()
                for thread in probe_threads:
                    thread.join(timeout=5.0)
                    self.assertFalse(thread.is_alive())

    def test_dedup_components_fresh_has_no_stale_flag(self) -> None:
        self._put_cache(_components("新鲜缓存"), age_seconds=1.0)

        with patch.object(diagnostics, "_probe_dedup_components") as probe:
            result = diagnostics.dedup_components(self.settings)
            probe.assert_not_called()
            for component in result.values():
                self.assertNotIn("stale", component)
                self.assertNotIn("age_seconds", component)

            result["dedup"]["summary"] = "调用方修改"
            second = diagnostics.dedup_components(self.settings)
            self.assertEqual(second["dedup"]["summary"], "新鲜缓存")

    def test_doctor_path_ignores_cache(self) -> None:
        self._put_cache(_components("缓存结果"), age_seconds=1.0)
        marker = "doctor-path-must-not-touch-single-flight"
        with diagnostics._DEDUP_CACHE_LOCK:
            diagnostics._DEDUP_REFRESH_INFLIGHT.add(marker)

        try:
            with patch.object(
                diagnostics,
                "_probe_dedup_components",
                return_value=_components("真实探测"),
            ) as probe:
                result = diagnostics.dedup_components(
                    self.settings,
                    use_cache=False,
                )
            probe.assert_called_once_with(self.settings)
            self.assertEqual(result["dedup"]["summary"], "真实探测")
            with diagnostics._DEDUP_CACHE_LOCK:
                self.assertIn(marker, diagnostics._DEDUP_REFRESH_INFLIGHT)
        finally:
            with diagnostics._DEDUP_CACHE_LOCK:
                diagnostics._DEDUP_REFRESH_INFLIGHT.discard(marker)


if __name__ == "__main__":
    unittest.main()
