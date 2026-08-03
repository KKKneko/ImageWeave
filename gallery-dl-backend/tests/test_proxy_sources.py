from __future__ import annotations

import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.proxy import ProxyPoolAdapter, ProxyPoolConflict
from gdl_backend.proxy_source_store import (
    MAX_INLINE_NODES,
    MAX_INLINE_NODE_LENGTH,
    MAX_INLINE_NODE_TOTAL_CHARS,
    MAX_PROXY_SOURCE_REQUEST_BYTES,
    MAX_SUBSCRIPTION_URL_LENGTH,
    ManagedProxySourceStore,
    ProxySourcePathForbidden,
    ProxySourceStoreConflict,
    ProxySourceStoreCorrupt,
    ProxySourceValidationError,
)

from tests.helpers import make_settings


TEST_SUBSCRIPTION = "https://fixture.invalid/private/subscription?ticket=fixture-value"
TEST_SUBSCRIPTION_2 = "https://second.fixture.invalid/another/private/path"
TEST_DIRECT_NODE = "http://fixture-user:fixture-pass@127.0.0.1:18080#LOCAL"
TEST_DIRECT_NODE_2 = "socks5://127.0.0.1:18081#SECOND"
TEST_UUID = "11111111-1111-1111-1111-111111111111"
TEST_TUNNEL_NODE = (
    f"vless://{TEST_UUID}@proxy.fixture.invalid:443"
    "?security=tls&type=ws&path=%2Fprivate#JP-01"
)


def _assert_private_equal(
    test: unittest.TestCase,
    actual: object,
    expected: object,
    message: str = "私有代理源值与预期不一致",
) -> None:
    if actual != expected:
        test.fail(message)


def _assert_no_fixture_secrets(test: unittest.TestCase, value: object, root: Path) -> None:
    serialized = json.dumps(value, ensure_ascii=False)
    forbidden = (
        "/private/subscription",
        "ticket=fixture-value",
        "/another/private/path",
        "fixture-user",
        "fixture-pass",
        TEST_UUID,
        TEST_TUNNEL_NODE,
        str(root),
    )
    if any(item and item in serialized for item in forbidden):
        test.fail("响应泄露了代理源夹具中的秘密内容")


class ManagedProxySourceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.project_dir = self.root
        self.settings.workspace_dir = self.root.parent
        self.allowed_root = self.root / "subscriptions"
        self.allowed_root.mkdir()
        self.settings.proxy.allowed_node_roots = [self.allowed_root]

    def tearDown(self):
        self.temporary.cleanup()

    def make_store(self) -> ManagedProxySourceStore:
        return ManagedProxySourceStore(
            self.settings.proxy,
            self.settings.runtime_dir,
            project_dir=self.settings.project_dir,
        )

    def write_nodes(self, name: str = "nodes.txt", text: str = TEST_DIRECT_NODE) -> Path:
        path = self.allowed_root / name
        path.write_text(text + "\n", encoding="utf-8")
        return path

    def test_none_config_and_first_change_builds_complete_runtime_snapshot(self):
        node_file = self.write_nodes()
        self.settings.proxy.subscription_urls = [TEST_SUBSCRIPTION]
        self.settings.proxy.node_file = node_file
        self.settings.proxy.inline_nodes = [TEST_DIRECT_NODE]
        store = self.make_store()

        initial = store.snapshot()
        self.assertEqual(initial.source, "config")
        self.assertFalse(initial.has_runtime_override)
        with self.assertRaises((AttributeError, TypeError)):
            initial.subscription_urls += (TEST_SUBSCRIPTION_2,)

        changed = store.add_subscription(f"  {TEST_SUBSCRIPTION_2}  ")
        self.assertEqual(changed.source, "runtime")
        document = json.loads(store.path.read_text(encoding="utf-8"))
        self.assertEqual(document["version"], 1)
        _assert_private_equal(
            self,
            document["subscription_urls"],
            [TEST_SUBSCRIPTION, TEST_SUBSCRIPTION_2],
        )
        _assert_private_equal(self, document["node_file"], str(node_file))
        _assert_private_equal(self, document["inline_nodes"], [TEST_DIRECT_NODE])

        # Store 使用启动时基线和完整覆盖，不借用 settings 的可变列表。
        self.settings.proxy.inline_nodes.append(TEST_DIRECT_NODE_2)
        _assert_private_equal(self, store.snapshot().inline_nodes, (TEST_DIRECT_NODE,))
        restored = store.reset_override()
        self.assertEqual(restored.source, "config")
        _assert_private_equal(self, restored.inline_nodes, (TEST_DIRECT_NODE,))
        self.assertFalse(store.path.exists())

    def test_empty_runtime_override_has_runtime_source(self):
        store = self.make_store()
        self.assertEqual(store.snapshot().source, "none")
        runtime = store.clear_node_file()
        self.assertEqual(runtime.source, "runtime")
        self.assertTrue(runtime.has_runtime_override)
        self.assertEqual(runtime.subscription_urls, ())
        self.assertEqual(runtime.inline_nodes, ())

    def test_subscription_and_inline_crud_normalize_duplicates(self):
        store = self.make_store()
        added = store.add_subscription(TEST_SUBSCRIPTION)
        duplicated = store.add_subscription(f"  {TEST_SUBSCRIPTION}  ")
        self.assertEqual(len(duplicated.subscription_urls), 1)
        first_id = store.public_snapshot(added, active_revision=None)["subscriptions"][0]["id"]

        replaced = store.replace_subscription(first_id, TEST_SUBSCRIPTION_2)
        replacement_id = store.public_snapshot(replaced, active_revision=None)["subscriptions"][0]["id"]
        self.assertNotEqual(first_id, replacement_id)
        deleted = store.delete_subscription(replacement_id)
        self.assertEqual(deleted.subscription_urls, ())

        nodes = store.add_inline_nodes(
            [TEST_DIRECT_NODE, f" {TEST_DIRECT_NODE} ", TEST_TUNNEL_NODE]
        )
        self.assertEqual(len(nodes.inline_nodes), 2)
        public = store.public_snapshot(nodes, active_revision=None)
        direct_id = public["inline_nodes"][0]["id"]
        replaced_nodes = store.replace_inline_node(direct_id, TEST_DIRECT_NODE_2)
        replacement_node_id = store.public_snapshot(
            replaced_nodes, active_revision=None
        )["inline_nodes"][0]["id"]
        final = store.delete_inline_node(replacement_node_id)
        _assert_private_equal(self, final.inline_nodes, (TEST_TUNNEL_NODE,))

    def test_node_file_set_clear_and_runtime_restart(self):
        node_file = self.write_nodes()
        store = self.make_store()
        configured = store.set_node_file(str(node_file))
        _assert_private_equal(self, configured.node_file, node_file)
        first_public = store.public_snapshot(configured, active_revision=None)
        self.assertEqual(first_public["node_file"]["display_path"], "subscriptions/nodes.txt")

        restarted = self.make_store()
        persisted = restarted.snapshot()
        self.assertEqual(persisted.source, "runtime")
        _assert_private_equal(self, persisted.node_file, node_file)
        self.assertEqual(
            first_public["configured_revision"],
            restarted.public_snapshot(persisted, active_revision=None)["configured_revision"],
        )
        cleared = restarted.clear_node_file()
        self.assertIsNone(cleared.node_file)

    def test_corrupt_and_unknown_version_fall_back_and_require_reset(self):
        self.settings.proxy.subscription_urls = [TEST_SUBSCRIPTION]
        store = self.make_store()
        store.path.write_text("{broken", encoding="utf-8")
        fallback = store.snapshot()
        self.assertEqual(fallback.source, "config")
        self.assertTrue(fallback.has_runtime_override)
        self.assertFalse(fallback.runtime_override_valid)
        with self.assertRaises(ProxySourceStoreCorrupt):
            store.add_subscription(TEST_SUBSCRIPTION_2)
        restored = store.reset_override()
        self.assertEqual(restored.source, "config")
        self.assertFalse(restored.has_runtime_override)

        document = {
            "version": 999,
            "updated_at": 0,
            "subscription_urls": [],
            "node_file": None,
            "inline_nodes": [],
        }
        store.path.write_text(json.dumps(document), encoding="utf-8")
        self.assertFalse(store.snapshot().runtime_override_valid)
        with self.assertRaises(ProxySourceStoreCorrupt):
            store.add_inline_nodes([TEST_DIRECT_NODE])
        store.reset_override()
        self.assertFalse(store.path.exists())

    @unittest.skipIf(os.name == "nt", "POSIX 权限断言")
    def test_private_permissions_and_atomic_replace(self):
        store = self.make_store()
        original_replace = os.replace
        with patch(
            "gdl_backend.file_security.os.replace",
            side_effect=original_replace,
        ) as replace:
            store.add_subscription(TEST_SUBSCRIPTION)
        self.assertGreaterEqual(replace.call_count, 1)
        self.assertEqual(stat.S_IMODE(store.path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(store.path.stat().st_mode), 0o600)
        self.assertEqual(list(store.path.parent.glob("*.tmp")), [])
        self.assertEqual(json.loads(store.path.read_text())["version"], 1)

    @unittest.skipIf(os.name == "nt", "POSIX 符号链接断言")
    def test_managed_target_and_component_symlinks_are_rejected(self):
        store = self.make_store()
        target = self.root / "external.json"
        target.write_text("do-not-touch", encoding="utf-8")
        store.path.symlink_to(target)
        fallback = store.snapshot()
        self.assertFalse(fallback.runtime_override_valid)
        with self.assertRaises(ProxySourcePathForbidden):
            store.add_subscription(TEST_SUBSCRIPTION)
        with self.assertRaises(ProxySourcePathForbidden):
            store.reset_override()
        self.assertEqual(target.read_text(encoding="utf-8"), "do-not-touch")

        other_root = self.root / "component-case"
        other_root.mkdir()
        runtime_target = other_root / "runtime-target"
        runtime_target.mkdir()
        (other_root / "runtime").symlink_to(runtime_target, target_is_directory=True)
        with self.assertRaises(ProxySourcePathForbidden):
            ManagedProxySourceStore(
                self.settings.proxy,
                other_root / "runtime",
                project_dir=other_root,
            )

    @unittest.skipIf(os.name == "nt", "POSIX 符号链接断言")
    def test_allowed_root_and_file_component_symlinks_are_rejected(self):
        store = self.make_store()
        outside = self.root / "outside"
        outside.mkdir()
        outside_file = outside / "nodes.txt"
        outside_file.write_text(TEST_DIRECT_NODE, encoding="utf-8")
        linked_root = self.root / "linked-subscriptions"
        linked_root.symlink_to(outside, target_is_directory=True)
        self.settings.proxy.allowed_node_roots = [linked_root]
        linked_store = self.make_store()
        with self.assertRaises(ProxySourcePathForbidden):
            linked_store.set_node_file(str(linked_root / "nodes.txt"))

        link = self.allowed_root / "linked.txt"
        link.symlink_to(outside_file)
        with self.assertRaises(ProxySourcePathForbidden):
            store.set_node_file(str(link))

    def test_node_file_rejects_boundary_type_size_encoding_and_empty_parse(self):
        store = self.make_store()
        outside = self.root / "outside.txt"
        outside.write_text(TEST_DIRECT_NODE, encoding="utf-8")
        with self.assertRaises(ProxySourcePathForbidden):
            store.set_node_file(str(outside))
        with self.assertRaises(ProxySourceValidationError) as directory_error:
            store.set_node_file(str(self.allowed_root))
        self.assertEqual(directory_error.exception.reason, "not_regular")

        invalid_encoding = self.allowed_root / "invalid.txt"
        invalid_encoding.write_bytes(b"\xff\xfe\xff")
        with self.assertRaises(ProxySourceValidationError) as encoding_error:
            store.set_node_file(str(invalid_encoding))
        self.assertEqual(encoding_error.exception.reason, "invalid_encoding")

        empty = self.allowed_root / "empty.txt"
        empty.write_text("unsupported://fixture\n", encoding="utf-8")
        with self.assertRaises(ProxySourceValidationError) as empty_error:
            store.set_node_file(str(empty))
        self.assertEqual(empty_error.exception.reason, "empty_parse")

        large = self.allowed_root / "large.txt"
        large.write_text(TEST_DIRECT_NODE * 4, encoding="utf-8")
        with patch("gdl_backend.proxy_sources.MAX_SUBSCRIPTION_BYTES", 16):
            with self.assertRaises(ProxySourceValidationError) as size_error:
                store.set_node_file(str(large))
        self.assertEqual(size_error.exception.reason, "too_large")

    def test_public_snapshot_redacts_url_node_name_and_external_path(self):
        external = self.root.parent / f"external-{self.root.name}.txt"
        external.write_text(TEST_DIRECT_NODE, encoding="utf-8")
        self.addCleanup(external.unlink, missing_ok=True)
        self.settings.proxy.subscription_urls = [
            "https://user:password@[2001:db8::1]:8443/private?q=fixture#fragment"
        ]
        self.settings.proxy.node_file = external
        self.settings.proxy.inline_nodes = [
            f"vless://{TEST_UUID}@proxy.fixture.invalid:443?security=tls"
            f"#{TEST_UUID}%0Acontrol"
        ]
        store = self.make_store()
        public = store.public_snapshot(active_revision=None)
        subscription = public["subscriptions"][0]
        self.assertEqual(subscription["display_url"], "https://[2001:db8::1]:8443/…")
        self.assertTrue(subscription["credentials_redacted"])
        self.assertEqual(public["node_file"]["display_path"], external.name)
        self.assertNotIn("\n", public["inline_nodes"][0]["name"])
        _assert_no_fixture_secrets(self, public, self.root)
        serialized = json.dumps(public, ensure_ascii=False)
        if "password" in serialized or "?q=" in serialized:
            self.fail("脱敏快照包含 URL 凭据或查询参数")

    def test_ids_and_revisions_are_full_length_stable_and_collision_safe(self):
        self.settings.proxy.subscription_urls = [TEST_SUBSCRIPTION]
        self.settings.proxy.inline_nodes = [TEST_DIRECT_NODE]
        first = self.make_store()
        first_public = first.public_snapshot(active_revision=None)
        second = self.make_store()
        second_public = second.public_snapshot(active_revision=None)
        self.assertEqual(first_public["configured_revision"], second_public["configured_revision"])
        self.assertEqual(len(first_public["configured_revision"]), 64)
        self.assertEqual(
            first_public["subscriptions"][0]["id"],
            second_public["subscriptions"][0]["id"],
        )
        self.assertEqual(len(first_public["subscriptions"][0]["id"]), 68)
        self.assertEqual(len(first_public["inline_nodes"][0]["id"]), 69)

        with patch(
            "gdl_backend.proxy_source_store._source_id",
            return_value="sub_" + "0" * 64,
        ):
            snapshot = first.add_subscription(TEST_SUBSCRIPTION_2)
            with self.assertRaises(ProxySourceStoreConflict):
                first.public_snapshot(snapshot, active_revision=None)

    def test_concurrent_changes_are_linearized_without_lost_updates(self):
        self.settings.proxy.inline_nodes = [TEST_DIRECT_NODE]
        store = self.make_store()
        count = 12
        barrier = threading.Barrier(count)
        errors: list[str] = []

        def add(index: int) -> None:
            try:
                barrier.wait(timeout=3)
                store.add_subscription(
                    f"https://provider-{index}.fixture.invalid/subscription/{index}"
                )
            except Exception as exc:  # pragma: no cover - 失败时只报告类型，避免秘密值
                errors.append(type(exc).__name__)

        threads = [threading.Thread(target=add, args=(index,)) for index in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(errors, [])
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        final = store.snapshot()
        self.assertEqual(len(final.subscription_urls), count)
        _assert_private_equal(self, final.inline_nodes, (TEST_DIRECT_NODE,))
        document = json.loads(store.path.read_text(encoding="utf-8"))
        self.assertEqual(len(document["subscription_urls"]), count)
        _assert_private_equal(self, document["inline_nodes"], [TEST_DIRECT_NODE])


class ProxySourceApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.project_dir = self.root
        self.settings.workspace_dir = self.root.parent
        self.allowed_root = self.root / "subscriptions"
        self.allowed_root.mkdir()
        self.settings.proxy.allowed_node_roots = [self.allowed_root]
        self.container = ServiceContainer(self.settings)
        self.client_context = TestClient(
            create_app(self.settings, container=self.container, start_background=False)
        )
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def assert_safe(self, response) -> dict:
        payload = response.json()
        _assert_no_fixture_secrets(self, payload, self.root)
        return payload

    def test_get_none_and_full_subscription_crud(self):
        initial = self.client.get("/api/v1/proxy/sources")
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.json()["source"], "none")
        self.assertIsNone(initial.json()["active_revision"])
        self.assertTrue(initial.json()["reload_required"])

        added = self.client.post(
            "/api/v1/proxy/sources/subscriptions",
            json={"url": TEST_SUBSCRIPTION},
        )
        self.assertEqual(added.status_code, 200)
        added_payload = self.assert_safe(added)
        self.assertEqual(added_payload["source"], "runtime")
        source_id = added_payload["subscriptions"][0]["id"]

        replaced = self.client.put(
            f"/api/v1/proxy/sources/subscriptions/{source_id}",
            json={"url": TEST_SUBSCRIPTION_2},
        )
        self.assertEqual(replaced.status_code, 200)
        replaced_payload = self.assert_safe(replaced)
        replacement_id = replaced_payload["subscriptions"][0]["id"]
        self.assertNotEqual(source_id, replacement_id)

        deleted = self.client.delete(
            f"/api/v1/proxy/sources/subscriptions/{replacement_id}"
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["counts"]["subscriptions"], 0)
        reset = self.client.delete("/api/v1/proxy/sources/override")
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(reset.json()["source"], "none")
        self.assertFalse(reset.json()["has_runtime_override"])

    def test_inline_batch_crud_and_atomic_invalid_index(self):
        added = self.client.post(
            "/api/v1/proxy/sources/inline-nodes",
            json={"nodes": [TEST_DIRECT_NODE, TEST_TUNNEL_NODE]},
        )
        self.assertEqual(added.status_code, 200)
        payload = self.assert_safe(added)
        self.assertEqual(payload["counts"]["inline_nodes"], 2)
        first_id = payload["inline_nodes"][0]["id"]

        replaced = self.client.put(
            f"/api/v1/proxy/sources/inline-nodes/{first_id}",
            json={"node": TEST_DIRECT_NODE_2},
        )
        self.assertEqual(replaced.status_code, 200)
        replacement_id = replaced.json()["inline_nodes"][0]["id"]
        deleted = self.client.delete(
            f"/api/v1/proxy/sources/inline-nodes/{replacement_id}"
        )
        self.assertEqual(deleted.status_code, 200)
        before = deleted.json()["configured_revision"]

        invalid_raw = "unsupported://do-not-echo.invalid/private"
        invalid = self.client.post(
            "/api/v1/proxy/sources/inline-nodes",
            json={"nodes": [TEST_DIRECT_NODE, invalid_raw]},
        )
        self.assertEqual(invalid.status_code, 422)
        error = invalid.json()["error"]
        self.assertEqual(error["code"], "invalid_proxy_inline_node")
        self.assertEqual(error["details"]["index"], 1)
        if invalid_raw in invalid.text:
            self.fail("内联节点错误响应回显了原始节点")
        after = self.client.get("/api/v1/proxy/sources").json()
        self.assertEqual(after["configured_revision"], before)

    def test_node_file_set_clear_and_safe_errors(self):
        node_file = self.allowed_root / "provider.txt"
        node_file.write_text(TEST_DIRECT_NODE, encoding="utf-8")
        configured = self.client.put(
            "/api/v1/proxy/sources/node-file",
            json={"path": str(node_file)},
        )
        self.assertEqual(configured.status_code, 200)
        payload = self.assert_safe(configured)
        self.assertEqual(payload["node_file"]["display_path"], "subscriptions/provider.txt")
        cleared = self.client.delete("/api/v1/proxy/sources/node-file")
        self.assertEqual(cleared.status_code, 200)
        self.assertFalse(cleared.json()["node_file"]["configured"])

        outside = self.root / "outside.txt"
        outside.write_text(TEST_DIRECT_NODE, encoding="utf-8")
        forbidden = self.client.put(
            "/api/v1/proxy/sources/node-file",
            json={"path": str(outside)},
        )
        self.assertEqual(forbidden.status_code, 422)
        self.assertEqual(forbidden.json()["error"]["code"], "proxy_source_path_forbidden")
        if str(outside) in forbidden.text:
            self.fail("节点文件错误响应泄露了绝对路径")

    def test_extra_fields_limits_ids_and_not_found_are_structured(self):
        secret_extra = "never-return-this-fixture-value"
        extra = self.client.post(
            "/api/v1/proxy/sources/subscriptions",
            json={"url": TEST_SUBSCRIPTION, "extra": secret_extra},
        )
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(extra.json()["error"]["code"], "invalid_proxy_subscription")
        if secret_extra in extra.text or TEST_SUBSCRIPTION in extra.text:
            self.fail("请求模型错误响应回显了代理源秘密")

        malformed = self.client.put(
            "/api/v1/proxy/sources/subscriptions/not-an-id",
            json={"url": TEST_SUBSCRIPTION_2},
        )
        self.assertEqual(malformed.status_code, 422)
        self.assertEqual(malformed.json()["error"]["code"], "invalid_proxy_source_id")

        missing = self.client.delete(
            "/api/v1/proxy/sources/subscriptions/sub_" + "0" * 64
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "proxy_source_not_found")

        too_large = self.client.post(
            "/api/v1/proxy/sources/subscriptions",
            content=b'{"url":"https://fixture.invalid/"}',
            headers={
                "content-type": "application/json",
                "content-length": str(MAX_PROXY_SOURCE_REQUEST_BYTES + 1),
            },
        )
        self.assertEqual(too_large.status_code, 413)
        self.assertEqual(
            too_large.json()["error"]["code"],
            "proxy_sources_request_too_large",
        )

    def test_url_node_count_single_length_and_total_limits(self):
        oversized_url = "https://fixture.invalid/" + "u" * MAX_SUBSCRIPTION_URL_LENGTH
        url_response = self.client.post(
            "/api/v1/proxy/sources/subscriptions",
            json={"url": oversized_url},
        )
        self.assertEqual(url_response.status_code, 422)
        self.assertEqual(
            url_response.json()["error"]["code"],
            "invalid_proxy_subscription",
        )
        if oversized_url in url_response.text:
            self.fail("URL 长度错误响应回显了订阅原文")

        too_many_nodes = [TEST_DIRECT_NODE] * (MAX_INLINE_NODES + 1)
        count_response = self.client.post(
            "/api/v1/proxy/sources/inline-nodes",
            json={"nodes": too_many_nodes},
        )
        self.assertEqual(count_response.status_code, 422)
        self.assertEqual(
            count_response.json()["error"]["code"],
            "invalid_proxy_inline_node",
        )

        oversized_node = "http://127.0.0.1:18080#" + "n" * MAX_INLINE_NODE_LENGTH
        node_response = self.client.post(
            "/api/v1/proxy/sources/inline-nodes",
            json={"nodes": [oversized_node]},
        )
        self.assertEqual(node_response.status_code, 422)
        if oversized_node in node_response.text:
            self.fail("节点长度错误响应回显了节点原文")

        per_node = MAX_INLINE_NODE_LENGTH - 64
        count = MAX_INLINE_NODE_TOTAL_CHARS // per_node + 1
        total_nodes = [
            f"http://127.0.0.1:18080#{index}-" + "t" * (per_node - 40)
            for index in range(count)
        ]
        self.assertGreater(sum(map(len, total_nodes)), MAX_INLINE_NODE_TOTAL_CHARS)
        total_response = self.client.post(
            "/api/v1/proxy/sources/inline-nodes",
            json={"nodes": total_nodes},
        )
        self.assertEqual(total_response.status_code, 422)
        self.assertEqual(
            total_response.json()["error"]["code"],
            "invalid_proxy_inline_node",
        )

    def test_corrupt_override_get_fallback_change_conflict_and_reset(self):
        self.settings.proxy.subscription_urls = [TEST_SUBSCRIPTION]
        # ServiceContainer 已冻结启动基线，所以先重建容器以模拟服务重启。
        self.client_context.__exit__(None, None, None)
        self.container = ServiceContainer(self.settings)
        self.client_context = TestClient(
            create_app(self.settings, container=self.container, start_background=False)
        )
        self.client = self.client_context.__enter__()
        self.container.proxy_sources.path.write_text("not-json", encoding="utf-8")

        fallback = self.client.get("/api/v1/proxy/sources")
        self.assertEqual(fallback.status_code, 200)
        fallback_payload = self.assert_safe(fallback)
        self.assertEqual(fallback_payload["source"], "config")
        self.assertFalse(fallback_payload["runtime_override_valid"])
        blocked = self.client.post(
            "/api/v1/proxy/sources/subscriptions",
            json={"url": TEST_SUBSCRIPTION_2},
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["error"]["code"], "proxy_sources_store_error")
        if TEST_SUBSCRIPTION_2 in blocked.text:
            self.fail("损坏存储错误响应回显了订阅秘密")
        reset = self.client.delete("/api/v1/proxy/sources/override")
        self.assertEqual(reset.status_code, 200)
        self.assertTrue(reset.json()["runtime_override_valid"])

    def test_every_success_response_is_redacted(self):
        responses = [
            self.client.post(
                "/api/v1/proxy/sources/subscriptions",
                json={"url": TEST_SUBSCRIPTION},
            ),
            self.client.post(
                "/api/v1/proxy/sources/inline-nodes",
                json={"nodes": [TEST_DIRECT_NODE, TEST_TUNNEL_NODE]},
            ),
            self.client.get("/api/v1/proxy/sources"),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 200)
            self.assert_safe(response)


class ProxySourceRevisionAndLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.project_dir = self.root
        self.settings.workspace_dir = self.root.parent
        self.settings.proxy.enabled = True
        self.settings.proxy.auto_start = False
        self.settings.proxy.inline_nodes = [TEST_DIRECT_NODE]
        self.allowed_root = self.root / "subscriptions"
        self.allowed_root.mkdir()
        self.settings.proxy.allowed_node_roots = [self.allowed_root]
        self.store = ManagedProxySourceStore(
            self.settings.proxy,
            self.settings.runtime_dir,
            project_dir=self.root,
        )
        self.adapter = ProxyPoolAdapter(
            self.settings.proxy,
            self.settings.runtime_dir,
            source_provider=self.store,
        )
        self.adapter.probe = lambda **_: {
            "total": len(self.adapter._records),
            "healthy": len(self.adapter._records),
            "results": [],
        }

    def tearDown(self):
        try:
            self.adapter.stop(force=True)
        except Exception:
            pass
        self.temporary.cleanup()

    def test_start_save_lease_conflict_and_reload_revision_lifecycle(self):
        initial = self.adapter.status()
        self.assertIsNone(initial["active_revision"])
        self.assertTrue(initial["reload_required"])
        started = self.adapter.start()
        active_revision = started["status"]["active_revision"]
        self.assertEqual(active_revision, self.store.snapshot().configured_revision)
        self.assertFalse(started["status"]["reload_required"])
        node_ids = [node["id"] for node in self.adapter.status()["nodes"]]

        lease = self.adapter.acquire("active-task")
        self.assertIsNotNone(lease)
        saved = self.store.add_inline_nodes([TEST_DIRECT_NODE_2])
        after_save = self.adapter.status()
        self.assertTrue(after_save["running"])
        self.assertEqual(after_save["leases"], 1)
        self.assertEqual([node["id"] for node in after_save["nodes"]], node_ids)
        self.assertEqual(after_save["active_revision"], active_revision)
        self.assertEqual(after_save["configured_revision"], saved.configured_revision)
        self.assertTrue(after_save["reload_required"])
        with self.assertRaises(ProxyPoolConflict):
            self.adapter.reload()
        self.assertEqual(self.adapter.active_revision, active_revision)

        self.adapter.release("active-task", proxy_fault=False)
        reloaded = self.adapter.reload()
        self.assertEqual(reloaded["status"]["total"], 2)
        self.assertEqual(reloaded["status"]["active_revision"], saved.configured_revision)
        self.assertFalse(reloaded["status"]["reload_required"])
        stopped = self.adapter.stop()
        self.assertFalse(stopped["running"])
        self.assertEqual(stopped["active_revision"], saved.configured_revision)
        self.assertFalse(stopped["reload_required"])

    def test_failed_reload_keeps_last_successful_active_revision(self):
        self.adapter.start()
        old_revision = self.adapter.active_revision
        configured = self.store.add_inline_nodes([TEST_DIRECT_NODE_2])
        with patch.object(
            self.adapter,
            "_collect_nodes",
            side_effect=RuntimeError("fixture collection failure"),
        ):
            with self.assertRaises(RuntimeError):
                self.adapter.reload()
        status = self.adapter.status()
        self.assertFalse(status["running"])
        self.assertEqual(status["active_revision"], old_revision)
        self.assertEqual(status["configured_revision"], configured.configured_revision)
        self.assertTrue(status["reload_required"])

    def test_start_and_reload_each_fetch_provider_once(self):
        class CountingProvider:
            def __init__(self, store: ManagedProxySourceStore):
                self.store = store
                self.calls = 0

            def snapshot(self):
                self.calls += 1
                return self.store.snapshot()

        provider = CountingProvider(self.store)
        adapter = ProxyPoolAdapter(
            self.settings.proxy,
            self.settings.runtime_dir,
            source_provider=provider,
        )
        adapter.probe = lambda **_: {
            "total": len(adapter._records),
            "healthy": len(adapter._records),
            "results": [],
        }
        try:
            adapter.start()
            self.assertEqual(provider.calls, 1)
            self.store.add_inline_nodes([TEST_DIRECT_NODE_2])
            adapter.reload()
            self.assertEqual(provider.calls, 2)
            self.assertEqual(adapter.status()["total"], 2)
            self.assertEqual(provider.calls, 3)
        finally:
            adapter.stop(force=True)

    def test_api_save_does_not_touch_lease_and_api_reload_still_conflicts(self):
        container = ServiceContainer(self.settings)
        container.proxy.probe = lambda **_: {
            "total": len(container.proxy._records),
            "healthy": len(container.proxy._records),
            "results": [],
        }
        context = TestClient(
            create_app(self.settings, container=container, start_background=False)
        )
        with context as client:
            container.proxy.start()
            lease = container.proxy.acquire("api-active-task")
            self.assertIsNotNone(lease)
            before_nodes = [node["id"] for node in container.proxy.status()["nodes"]]
            saved = client.post(
                "/api/v1/proxy/sources/inline-nodes",
                json={"nodes": [TEST_DIRECT_NODE_2]},
            )
            self.assertEqual(saved.status_code, 200)
            self.assertTrue(saved.json()["reload_required"])
            after = container.proxy.status()
            self.assertTrue(after["running"])
            self.assertEqual(after["leases"], 1)
            self.assertEqual([node["id"] for node in after["nodes"]], before_nodes)

            conflict = client.post(
                "/api/v1/proxy/reload",
                json={"force_refresh": True},
            )
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(conflict.json()["error"]["code"], "proxy_conflict")
            container.proxy.release("api-active-task", proxy_fault=False)
            reloaded = client.post(
                "/api/v1/proxy/reload",
                json={"force_refresh": True},
            )
            self.assertEqual(reloaded.status_code, 200)
            self.assertFalse(reloaded.json()["status"]["reload_required"])
            self.assertEqual(reloaded.json()["status"]["total"], 2)


if __name__ == "__main__":
    unittest.main()
