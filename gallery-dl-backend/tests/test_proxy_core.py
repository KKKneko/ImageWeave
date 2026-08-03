from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gdl_backend.proxy import ProxyPoolAdapter, ProxyPoolUnavailable
from gdl_backend.proxy_core import (
    CoreEndpoint,
    _core_binary_names,
    build_transport_config,
    resolve_core_binary,
)
from gdl_backend.proxy_sources import parse_subscription_text

from tests.helpers import make_settings


CLASH_TUNNEL_FIXTURE = """
proxies:
  - name: JP-TROJAN
    type: trojan
    server: jp.example
    port: 443
    password: fixture-secret
    sni: edge.example
  - name: US-VLESS
    type: vless
    server: us.example
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    tls: true
  - name: SG-MIERU
    type: mieru
    server: sg.example
    port: 8443
    username: fixture
    password: fixture-secret
"""


def _mark_all_records_healthy(adapter: ProxyPoolAdapter) -> dict[str, object]:
    for record in adapter._records:
        record.healthy = True
    return {
        "total": len(adapter._records),
        "healthy": len(adapter._records),
        "results": [],
    }


class ProxyCoreTests(unittest.TestCase):
    def test_core_binary_search_names_are_platform_specific(self):
        self.assertEqual(_core_binary_names("posix"), ("proxy-core", "mihomo", "verge-mihomo"))
        self.assertEqual(
            _core_binary_names("nt")[:3],
            ("proxy-core.exe", "mihomo.exe", "verge-mihomo.exe"),
        )

    def test_project_bin_is_preferred_over_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_binary = root / ("proxy-core.exe" if os.name == "nt" else "proxy-core")
            path_binary = root / ("mihomo.exe" if os.name == "nt" else "mihomo")
            project_binary.write_bytes(b"project-core")
            path_binary.write_bytes(b"path-core")
            if os.name != "nt":
                project_binary.chmod(0o700)
                path_binary.chmod(0o700)

            with (
                patch("gdl_backend.proxy_core.PROJECT_BIN_DIR", root),
                patch("gdl_backend.proxy_core.shutil.which", return_value=str(path_binary)),
            ):
                self.assertEqual(resolve_core_binary(None), project_binary.resolve())

    def test_core_binary_is_discovered_from_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / ("mihomo.exe" if os.name == "nt" else "mihomo")
            binary.write_bytes(b"fixture-core")
            if os.name != "nt":
                binary.chmod(0o700)
            digest = hashlib.sha256(b"fixture-core").hexdigest()

            def which(name: str):
                return str(binary) if name == binary.name else None

            with (
                patch("gdl_backend.proxy_core.PROJECT_BIN_DIR", Path(tmp) / "empty-project-bin"),
                patch("gdl_backend.proxy_core.shutil.which", side_effect=which),
            ):
                self.assertEqual(resolve_core_binary(None, digest), binary.resolve())

    def test_explicit_core_binary_does_not_fall_back_to_path(self):
        missing = Path("missing-explicit-core")
        with patch("gdl_backend.proxy_core.shutil.which", return_value="system-mihomo") as which:
            with self.assertRaisesRegex(FileNotFoundError, "missing-explicit-core"):
                resolve_core_binary(missing)
        which.assert_not_called()

    @unittest.skipIf(os.name == "nt", "POSIX executable permissions only")
    def test_core_binary_requires_execute_permission_on_posix(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "mihomo"
            binary.write_bytes(b"fixture-core")
            binary.chmod(0o600)
            with self.assertRaisesRegex(PermissionError, "执行权限"):
                resolve_core_binary(binary)

    def test_core_binary_sha256_is_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "proxy-core.exe"
            binary.write_bytes(b"fixture-core")
            if os.name != "nt":
                binary.chmod(0o700)
            digest = hashlib.sha256(b"fixture-core").hexdigest()
            self.assertEqual(resolve_core_binary(binary, digest), binary.resolve())
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                resolve_core_binary(binary, "0" * 64)

    def test_clash_tunnel_nodes_keep_private_core_config(self):
        nodes = parse_subscription_text(CLASH_TUNNEL_FIXTURE)
        self.assertEqual([node.scheme for node in nodes], ["trojan", "vless", "mieru"])
        self.assertTrue(all(not node.usable for node in nodes))
        self.assertTrue(all(node.core_config for node in nodes))
        self.assertNotIn("fixture-secret", repr(nodes[0]))

    def test_builds_one_local_http_listener_per_tunnel_node(self):
        nodes = parse_subscription_text(CLASH_TUNNEL_FIXTURE)
        config, endpoints = build_transport_config(
            nodes,
            listen_host="127.0.0.1",
            base_port=29100,
        )
        self.assertEqual(len(config["proxies"]), 3)
        self.assertEqual(len(config["listeners"]), 3)
        self.assertEqual([item["port"] for item in config["listeners"]], [29100, 29101, 29102])
        self.assertEqual(
            [item["proxy"] for item in config["listeners"]],
            [item["name"] for item in config["proxies"]],
        )
        self.assertEqual(endpoints[0].local_http, "http://127.0.0.1:29100")

    def test_mieru_port_range_does_not_reintroduce_a_single_port(self):
        nodes = parse_subscription_text(
            "mieru://user:secret@range.example:5000"
            "?transport=tcp&multiplexing=low&port-range=5000-5010#RANGE"
        )
        config, endpoints = build_transport_config(
            nodes,
            listen_host="127.0.0.1",
            base_port=29100,
        )
        self.assertEqual(len(endpoints), 1)
        self.assertEqual(config["proxies"][0]["port-range"], "5000-5010")
        self.assertNotIn("port", config["proxies"][0])

    def test_acquire_returns_none_when_pool_never_started(self):
        # 未启动（含 auto_start=False）不属于核心启动失败：保持原契约返回 None，
        # prefer 降级直连、required 走原重试路径。
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.proxy.enabled = True
            adapter = ProxyPoolAdapter(settings.proxy, settings.runtime_dir)
            self.assertIsNone(adapter.acquire("task-not-running"))

    def test_acquire_returns_none_after_manual_stop_without_core_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.proxy.enabled = True
            settings.proxy.inline_nodes = ["http://127.0.0.1:39999"]
            adapter = ProxyPoolAdapter(settings.proxy, settings.runtime_dir)
            adapter.probe = lambda **_: _mark_all_records_healthy(adapter)
            adapter.start(force_refresh=True)
            adapter.stop()
            self.assertIsNone(adapter.acquire("task-stopped"))

    def test_core_start_failure_fails_pool_start_and_blocks_acquire(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.proxy.enabled = True
            settings.proxy.transport_core_enabled = True
            node_file = Path(tmp) / "nodes.yaml"
            node_file.write_text(CLASH_TUNNEL_FIXTURE, encoding="utf-8")
            settings.proxy.node_file = node_file
            adapter = ProxyPoolAdapter(settings.proxy, settings.runtime_dir)
            adapter.probe = lambda **_: _mark_all_records_healthy(adapter)
            fake_endpoints = [
                CoreEndpoint(
                    id=f"node-{index}",
                    name=f"fixture-{index}",
                    source_protocol="trojan",
                    source_host="fixture.example",
                    local_http=f"http://127.0.0.1:{29100 + index}",
                )
                for index in range(3)
            ]
            with patch("gdl_backend.proxy.TunnelTransportCore") as core_class:
                core = core_class.return_value
                core.start.side_effect = RuntimeError(
                    "代理核心启动失败，3 个监听端口尚未就绪"
                )
                with self.assertRaisesRegex(RuntimeError, "监听端口尚未就绪"):
                    adapter.start(force_refresh=True)
                core.stop.assert_called()
                # 启动失败原因在 /proxy/status 可见；acquire 硬错误，禁止直连回退。
                self.assertIn(
                    "隧道核心启动失败",
                    adapter.status()["transport_core"]["last_error"],
                )
                with self.assertRaisesRegex(ProxyPoolUnavailable, "隧道核心启动失败"):
                    adapter.acquire("task-core-down")
                # 修复核心后重启成功即恢复正常出租，标记被清除。
                core.start.side_effect = None
                core.start.return_value = fake_endpoints
                core.status.return_value = {
                    "enabled": True,
                    "running": True,
                    "listeners": 3,
                    "last_error": "",
                }
                adapter.start(force_refresh=True)
                self.assertEqual(adapter.status()["transport_core"]["last_error"], "")
                lease = adapter.acquire("task-recovered")
                self.assertIsNotNone(lease)
                adapter.release("task-recovered", proxy_fault=False)
                adapter.stop()

    def test_core_start_failure_fails_pool_even_with_direct_nodes(self):
        # 混合订阅（隧道 + 直连 HTTP 节点）同样硬失败：选择了 mihomo 就不做
        # “丢弃隧道节点继续跑”的静默降级。
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.proxy.enabled = True
            settings.proxy.transport_core_enabled = True
            node_file = Path(tmp) / "nodes.yaml"
            node_file.write_text(CLASH_TUNNEL_FIXTURE, encoding="utf-8")
            settings.proxy.node_file = node_file
            settings.proxy.inline_nodes = ["http://127.0.0.1:39999"]
            adapter = ProxyPoolAdapter(settings.proxy, settings.runtime_dir)
            with patch("gdl_backend.proxy.TunnelTransportCore") as core_class:
                core_class.return_value.start.side_effect = RuntimeError(
                    "代理核心启动失败，3 个监听端口尚未就绪"
                )
                with self.assertRaisesRegex(RuntimeError, "监听端口尚未就绪"):
                    adapter.start(force_refresh=True)
            self.assertFalse(adapter.status()["running"])
            with self.assertRaisesRegex(ProxyPoolUnavailable, "隧道核心启动失败"):
                adapter.acquire("task-mixed")

    def test_adapter_wires_core_endpoints_into_native_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.proxy.enabled = True
            settings.proxy.transport_core_enabled = True
            node_file = Path(tmp) / "nodes.yaml"
            node_file.write_text(CLASH_TUNNEL_FIXTURE, encoding="utf-8")
            settings.proxy.node_file = node_file
            adapter = ProxyPoolAdapter(settings.proxy, settings.runtime_dir)
            adapter.probe = lambda **_: _mark_all_records_healthy(adapter)
            fake_endpoints = [
                CoreEndpoint(
                    id=f"node-{index}",
                    name=f"fixture-{index}",
                    source_protocol="trojan",
                    source_host="fixture.example",
                    local_http=f"http://127.0.0.1:{29100 + index}",
                )
                for index in range(3)
            ]
            with patch("gdl_backend.proxy.TunnelTransportCore") as core_class:
                core = core_class.return_value
                core.start.return_value = fake_endpoints
                core.status.return_value = {"enabled": True, "running": True, "listeners": 3}
                started = adapter.start(force_refresh=True)
                self.assertEqual(
                    core_class.call_args.kwargs["expected_sha256"],
                    settings.proxy.transport_core_sha256,
                )
                self.assertEqual(started["status"]["sources"]["core_nodes"], 3)
                self.assertEqual(started["status"]["total"], 3)
                lease = adapter.acquire("fixture-task")
                self.assertIsNotNone(lease)
                self.assertTrue(lease.endpoint.startswith("http://127.0.0.1:291"))
                adapter.release("fixture-task", proxy_fault=False)
                adapter.stop()
                core.stop.assert_called()


if __name__ == "__main__":
    unittest.main()
