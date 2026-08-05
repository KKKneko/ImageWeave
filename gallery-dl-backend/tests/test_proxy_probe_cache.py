from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from gdl_backend.proxy import ProxyPoolAdapter

from tests.helpers import make_settings


def _mark_all_records_healthy(adapter: ProxyPoolAdapter) -> dict[str, object]:
    for record in adapter._records:
        record.healthy = True
    return {
        "total": len(adapter._records),
        "healthy": len(adapter._records),
        "results": [],
    }


class _FailingLifecycleLock:
    def __enter__(self):
        raise AssertionError("缓存命中路径不应获取 lifecycle lock")

    def __exit__(self, *_args):
        return False


class _ObservedRLock:
    def __init__(self, observed_thread_name: str) -> None:
        self._lock = threading.RLock()
        self._observed_thread_name = observed_thread_name
        self.observed_attempt = threading.Event()

    def __enter__(self):
        if threading.current_thread().name == self._observed_thread_name:
            self.observed_attempt.set()
        self._lock.acquire()
        return self

    def __exit__(self, *_args):
        self._lock.release()
        return False


class ProxyProbeCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.settings.proxy.enabled = True
        self.settings.proxy.probe_cache_ttl_seconds = 600.0
        self.settings.proxy.inline_nodes = [
            f"http://127.0.0.1:{18080 + index}#CACHE-{index}"
            for index in range(3)
        ]
        self.adapter = ProxyPoolAdapter(
            self.settings.proxy,
            self.settings.runtime_dir,
        )
        self.adapter.probe = lambda **_: _mark_all_records_healthy(self.adapter)
        self.adapter.start(force_refresh=True)
        del self.adapter.probe

    def tearDown(self):
        self.adapter.stop(force=True)
        self.temp.cleanup()

    def _install_healthy_endpoint_probe(self) -> Mock:
        def probe_endpoint(
            node_id: str,
            endpoint: str,
            target_url: str,
            *,
            update_pool: bool = True,
        ) -> dict[str, object]:
            del update_pool
            return {
                "id": node_id,
                "healthy": True,
                "latency_ms": 1.0,
                "error": "",
                "endpoint": endpoint,
                "target": target_url,
            }

        mocked = Mock(side_effect=probe_endpoint)
        self.adapter._probe_endpoint = mocked
        return mocked

    @staticmethod
    def _result_by_id(result: dict[str, object], node_id: str) -> dict[str, object]:
        rows = result["results"]
        assert isinstance(rows, list)
        return next(row for row in rows if row["id"] == node_id)

    def test_second_address_same_host_hits_cache(self):
        endpoint_probe = self._install_healthy_endpoint_probe()
        first = self.adapter.probe_for_target("https://cache.example/gallery/1")
        original_lock = self.adapter._lifecycle_lock
        self.adapter._lifecycle_lock = _FailingLifecycleLock()
        try:
            second = self.adapter.probe_for_target("https://cache.example/gallery/2")
        finally:
            self.adapter._lifecycle_lock = original_lock

        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertGreaterEqual(second["age_seconds"], 0.0)
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records))

    def test_cache_key_ignores_path(self):
        self.assertEqual(
            self.adapter._probe_cache_key("https://CACHE.example/"),
            self.adapter._probe_cache_key("https://cache.example/posts/123?tag=x"),
        )

    def test_cache_key_separates_port_and_scheme(self):
        https_key = self.adapter._probe_cache_key("https://cache.example/")
        self.assertNotEqual(
            https_key,
            self.adapter._probe_cache_key("https://cache.example:444/"),
        )
        self.assertNotEqual(
            https_key,
            self.adapter._probe_cache_key("http://cache.example/"),
        )
        self.assertEqual(https_key, ("https", "cache.example", 443))

    def test_ttl_expiry_triggers_real_probe(self):
        self.settings.proxy.probe_cache_ttl_seconds = 0.01
        endpoint_probe = self._install_healthy_endpoint_probe()
        now = [100.0]
        with patch("gdl_backend.proxy.time.monotonic", side_effect=lambda: now[0]):
            first = self.adapter.probe_for_target("https://expiry.example/one")
            now[0] += 0.02
            second = self.adapter.probe_for_target("https://expiry.example/two")

        self.assertFalse(first["cached"])
        self.assertFalse(second["cached"])
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)

    def test_ttl_zero_disables_cache(self):
        self.settings.proxy.probe_cache_ttl_seconds = 0.0
        endpoint_probe = self._install_healthy_endpoint_probe()

        first = self.adapter.probe_for_target("https://disabled.example/one")
        second = self.adapter.probe_for_target("https://disabled.example/two")

        self.assertFalse(first["cached"])
        self.assertFalse(second["cached"])
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)
        self.assertEqual(self.adapter.status()["probe_cache"]["entries"], 0)

    def test_cached_results_are_deep_copies(self):
        self._install_healthy_endpoint_probe()
        first = self.adapter.probe_for_target("https://copies.example/one")
        first["results"][0]["healthy"] = False
        first["results"].append({"id": "injected", "healthy": True})

        second = self.adapter.probe_for_target("https://copies.example/two")
        second["results"][0]["healthy"] = False
        third = self.adapter.probe_for_target("https://copies.example/three")

        self.assertEqual(second["healthy"], 3)
        self.assertEqual(len(second["results"]), 3)
        self.assertEqual(third["healthy"], 3)
        self.assertTrue(third["results"][0]["healthy"])
        self.assertEqual(len(third["results"]), 3)

    def test_proxy_fault_release_marks_node_unhealthy_in_cache(self):
        endpoint_probe = self._install_healthy_endpoint_probe()
        target = "https://release.example/posts"
        cached = self.adapter.probe_for_target(target)
        self.adapter.probe_for_target("https://release-second.example/posts")
        node_id = cached["results"][0]["id"]
        lease = self.adapter.acquire("faulted-task", allowed_ids={node_id})
        self.assertIsNotNone(lease)

        self.adapter.release(
            "faulted-task",
            proxy_fault=True,
            reason="fixture proxy failure",
        )
        after_fault = self.adapter.probe_for_target("https://release.example/other")
        second_target = self.adapter.probe_for_target(
            "https://release-second.example/other"
        )

        for result in (after_fault, second_target):
            self.assertTrue(result["cached"])
            self.assertFalse(self._result_by_id(result, node_id)["healthy"])
            self.assertEqual(result["healthy"], 2)
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)

    def test_cache_entry_removed_when_no_healthy_node_left(self):
        endpoint_probe = self._install_healthy_endpoint_probe()
        target = "https://all-faulted.example/"
        self.adapter.probe_for_target(target)

        for index, record in enumerate(list(self.adapter._records)):
            task_id = f"fault-{index}"
            lease = self.adapter.acquire(task_id, allowed_ids={record.id})
            self.assertIsNotNone(lease)
            self.adapter.release(task_id, proxy_fault=True, reason="fixture failure")

        self.assertEqual(self.adapter.status()["probe_cache"]["entries"], 0)
        refreshed = self.adapter.probe_for_target(target)
        self.assertFalse(refreshed["cached"])
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)

    def test_start_and_reload_clear_cache(self):
        endpoint_probe = self._install_healthy_endpoint_probe()
        target = "https://lifecycle.example/"
        self.adapter.probe_for_target(target)
        self.assertEqual(self.adapter.status()["probe_cache"]["entries"], 1)

        self.adapter.probe = lambda **_: _mark_all_records_healthy(self.adapter)
        try:
            self.adapter.start(force_refresh=True)
            entries_after_start = self.adapter.status()["probe_cache"]["entries"]
        finally:
            del self.adapter.probe
        self.assertEqual(entries_after_start, 0)

        self.adapter.probe_for_target(target)
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)
        self.adapter.probe = lambda **_: _mark_all_records_healthy(self.adapter)
        try:
            self.adapter.reload(force_refresh=True)
            entries_after_reload = self.adapter.status()["probe_cache"]["entries"]
        finally:
            del self.adapter.probe
        self.assertEqual(entries_after_reload, 0)

    def test_stop_and_set_records_clear_cache(self):
        self._install_healthy_endpoint_probe()
        target = "https://remaining-lifecycle.example/"
        self.adapter.probe_for_target(target)

        self.adapter._set_records(list(self.adapter._records))
        self.assertEqual(self.adapter.status()["probe_cache"]["entries"], 0)
        self.adapter.probe_for_target(target)

        stopped = self.adapter.stop(force=True)
        self.assertEqual(stopped["probe_cache"]["entries"], 0)

    def test_manual_full_probe_bypasses_and_refreshes_cache(self):
        unhealthy_id = {"value": ""}

        def probe_endpoint(node_id, endpoint, target_url, *, update_pool=True):
            del update_pool
            healthy = node_id != unhealthy_id["value"]
            return {
                "id": node_id,
                "healthy": healthy,
                "endpoint": endpoint,
                "target": target_url,
            }

        endpoint_probe = Mock(side_effect=probe_endpoint)
        self.adapter._probe_endpoint = endpoint_probe
        target = "https://manual.example/one"
        first = self.adapter.probe_for_target(target)
        self.assertEqual(first["healthy"], 3)

        unhealthy_id["value"] = self.adapter._records[0].id
        manual = self.adapter.probe(target_url="https://manual.example/two")
        cached = self.adapter.probe_for_target("https://manual.example/three")

        self.assertFalse(manual["cached"])
        self.assertEqual(manual["healthy"], 2)
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["healthy"], 2)
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records) * 2)

    def test_single_node_manual_probe_never_replaces_full_allowlist(self):
        endpoint_probe = self._install_healthy_endpoint_probe()
        target = "https://single.example/one"
        self.adapter.probe_for_target(target)
        node_id = self.adapter._records[0].id

        single = self.adapter.probe(target_url=target, node_id=node_id)
        cached = self.adapter.probe_for_target("https://single.example/two")

        self.assertEqual(single["total"], 1)
        self.assertEqual(cached["total"], 3)
        self.assertEqual(len(cached["results"]), 3)

        uncached_target = "https://new-single.example/"
        self.adapter.probe(target_url=uncached_target, node_id=node_id)
        before_full = endpoint_probe.call_count
        full = self.adapter.probe_for_target(uncached_target)
        self.assertFalse(full["cached"])
        self.assertEqual(full["total"], 3)
        self.assertEqual(
            endpoint_probe.call_count - before_full,
            len(self.adapter._records),
        )

    def test_single_node_endpoint_failure_downgrades_cache(self):
        self._install_healthy_endpoint_probe()
        target = "https://endpoint-failure.example/"
        cached = self.adapter.probe_for_target(target)
        second_target = "https://endpoint-failure-second.example/"
        self.adapter.probe_for_target(second_target)
        node_id = cached["results"][0]["id"]
        record = next(record for record in self.adapter._records if record.id == node_id)
        del self.adapter._probe_endpoint

        with patch(
            "gdl_backend.proxy.requests.get",
            side_effect=RuntimeError("fixture connection failure"),
        ):
            failed = self.adapter._probe_endpoint(record.id, record.endpoint, target)
        after_failure = self.adapter.probe_for_target(target)
        second_after_failure = self.adapter.probe_for_target(second_target)

        self.assertFalse(failed["healthy"])
        for result in (after_failure, second_after_failure):
            self.assertTrue(result["cached"])
            self.assertFalse(self._result_by_id(result, node_id)["healthy"])
            self.assertEqual(result["healthy"], 2)

    def test_status_reports_cache_entries_without_hostnames(self):
        self._install_healthy_endpoint_probe()
        hostname = "private-crawl-target.example"
        self.adapter.probe_for_target(f"https://{hostname}/secret/path")

        cache_status = self.adapter.status()["probe_cache"]
        serialized = json.dumps(cache_status)
        self.assertEqual(
            cache_status,
            {"entries": 1, "ttl_seconds": 600.0},
        )
        self.assertNotIn(hostname, serialized)

    def test_double_check_avoids_duplicate_probe_after_lifecycle_wait(self):
        entered_probe = threading.Event()
        release_probe = threading.Event()

        def blocking_probe(node_id, endpoint, target_url, *, update_pool=True):
            del update_pool
            entered_probe.set()
            if not release_probe.wait(timeout=2.0):
                raise AssertionError("探活测试未收到释放信号")
            return {
                "id": node_id,
                "healthy": True,
                "endpoint": endpoint,
                "target": target_url,
            }

        endpoint_probe = Mock(side_effect=blocking_probe)
        self.adapter._probe_endpoint = endpoint_probe
        original_lock = self.adapter._lifecycle_lock
        observed_lock = _ObservedRLock("cache-waiter")
        self.adapter._lifecycle_lock = observed_lock
        results: dict[str, dict[str, object]] = {}
        errors: list[BaseException] = []

        def run(name: str) -> None:
            try:
                results[name] = self.adapter.probe_for_target(
                    f"https://double-check.example/{name}"
                )
            except BaseException as exc:  # 测试线程必须把异常带回主线程。
                errors.append(exc)

        owner = threading.Thread(target=run, args=("owner",), name="cache-owner")
        waiter = threading.Thread(target=run, args=("waiter",), name="cache-waiter")
        try:
            owner.start()
            self.assertTrue(entered_probe.wait(timeout=2.0))
            waiter.start()
            self.assertTrue(observed_lock.observed_attempt.wait(timeout=2.0))
        finally:
            release_probe.set()
            owner.join(timeout=3.0)
            waiter.join(timeout=3.0)
            self.adapter._lifecycle_lock = original_lock

        self.assertFalse(owner.is_alive())
        self.assertFalse(waiter.is_alive())
        self.assertEqual(errors, [])
        self.assertFalse(results["owner"]["cached"])
        self.assertTrue(results["waiter"]["cached"])
        self.assertEqual(endpoint_probe.call_count, len(self.adapter._records))


if __name__ == "__main__":
    unittest.main()
