from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

from gdl_backend.config import AppSettings, normalize_authorization_proxy
from gdl_backend.schemas import build_runtime_site_policy


class ConfigDefaultsTests(unittest.TestCase):
    def test_native_pool_is_the_managed_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = AppSettings.load(Path(temporary) / "missing-config.json")

        self.assertTrue(settings.proxy.enabled)
        self.assertTrue(settings.proxy.auto_start)
        self.assertEqual(settings.proxy.engine, "native")
        self.assertTrue(settings.proxy.allow_socks)
        self.assertIsNone(settings.proxy.node_file)
        self.assertEqual(settings.proxy.probe_timeout_seconds, 10.0)
        self.assertFalse(hasattr(settings.proxy, "max_nodes"))
        self.assertNotIn("max_nodes", settings.public_dict()["proxy"])

        self.assertIsNone(settings.proxy.transport_core_binary)
        self.assertEqual(settings.proxy.transport_core_sha256, "")

    def test_transport_core_defaults_are_external_on_all_platforms(self):
        settings = AppSettings()
        self.assertIsNone(settings.proxy.transport_core_binary)
        self.assertEqual(settings.proxy.transport_core_sha256, "")

    def test_strict_target_dns_defaults_true_and_is_public(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = AppSettings.load(Path(temporary) / "missing-config.json")

        self.assertIs(settings.server.strict_target_dns, True)
        self.assertIs(
            settings.public_dict()["server"]["strict_target_dns"],
            True,
        )

    def test_strict_target_dns_is_loaded_and_warns_when_disabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text(
                json.dumps({"server": {"strict_target_dns": False}}),
                encoding="utf-8",
            )
            stderr = StringIO()
            with redirect_stderr(stderr):
                settings = AppSettings.load(config_path)

        self.assertIs(settings.server.strict_target_dns, False)
        self.assertIs(
            settings.public_dict()["server"]["strict_target_dns"],
            False,
        )
        self.assertIn("server.strict_target_dns=false", stderr.getvalue())
        self.assertIn("已降级", stderr.getvalue())

    def test_strict_target_dns_rejects_non_boolean_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text(
                json.dumps({"server": {"strict_target_dns": "false"}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "必须是布尔值"):
                AppSettings.load(config_path)

    def test_explicit_transport_core_path_and_digest_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "proxy": {
                            "transport_core_binary": "bin/mihomo",
                            "transport_core_sha256": "1" * 64,
                        }
                    }
                ),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)

        self.assertEqual(settings.proxy.transport_core_binary, (root / "bin" / "mihomo").resolve())
        self.assertEqual(settings.proxy.transport_core_sha256, "1" * 64)

    def test_retry_backoff_cap_default_is_five_minutes(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = AppSettings.load(Path(temporary) / "missing-config.json")

        self.assertEqual(settings.scheduler.retry_backoff_cap_seconds, 300.0)
        # public_dict serializes the whole SchedulerSettings via asdict, so the new
        # field is reported without a bespoke serializer entry.
        self.assertEqual(
            settings.public_dict()["scheduler"]["retry_backoff_cap_seconds"], 300.0
        )

    def test_retry_backoff_cap_is_parsed_and_floored(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"scheduler": {"retry_backoff_cap_seconds": 45.0}}),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)
        self.assertEqual(settings.scheduler.retry_backoff_cap_seconds, 45.0)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"scheduler": {"retry_backoff_cap_seconds": 0.0}}),
                encoding="utf-8",
            )
            floored = AppSettings.load(config_path)
        self.assertEqual(floored.scheduler.retry_backoff_cap_seconds, 1.0)
    def test_default_site_policy_ignores_retired_advanced_config_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "dedup": {"enabled": False},
                        "default_site_policy": {
                            "max_concurrency": 7,
                            "retry_limit": 4,
                            "backoff_base_seconds": 1.5,
                            "proxy_mode": "direct",
                            "probe_url": "https://config.invalid/",
                            "probe_before_use": False,
                            "node_tags": ["legacy"],
                            "http_timeout": 1,
                            "gallery_retries": 50,
                            "task_timeout_seconds": 0,
                            "download_stall_timeout_seconds": 0,
                            "eh_download": {
                                "image_mode": "resample",
                                "gp_policy": "resized",
                            },
                            "extra_args": ["--legacy"],
                            "unknown_legacy_field": "ignored",
                        },
                    }
                ),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)

        self.assertEqual(
            settings.default_site_policy,
            {
                "max_concurrency": 7,
                "retry_limit": 4,
                "backoff_base_seconds": 1.5,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(
            settings.public_dict()["default_site_policy"],
            settings.default_site_policy,
        )
        self.assertEqual(
            build_runtime_site_policy(settings.default_site_policy).model_dump(),
            {
                "max_concurrency": 7,
                "retry_limit": 4,
                "backoff_base_seconds": 1.5,
                "proxy_mode": "direct",
                "probe_url": None,
                "probe_before_use": True,
                "node_tags": [],
                "http_timeout": 60.0,
                "gallery_retries": 2,
                "task_timeout_seconds": 7200.0,
                "download_stall_timeout_seconds": 300.0,
                "eh_download": None,
                "extra_args": [],
            },
        )


class DedupResourceConfigTests(unittest.TestCase):
    def test_resource_profile_uses_zero_as_auto_and_preserves_overrides(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_dir": "runtime",
                        "database_path": "runtime/backend.sqlite3",
                        "default_output_root": "runtime/downloads",
                        "gallery": {"cache_file": "credentials/managed/cache.sqlite3"},
                        "dedup": {
                            "enabled": False,
                            "device": "cpu",
                            "workers": 3,
                            "torch_threads": 2,
                            "torch_interop_threads": 1,
                            "deep_batch_size": 2,
                            "neighbor_block_size": 96,
                        },
                    }
                ),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)

        self.assertEqual(settings.dedup.workers, 3)
        self.assertEqual(settings.dedup.torch_threads, 2)
        self.assertEqual(settings.dedup.torch_interop_threads, 1)
        self.assertEqual(settings.dedup.deep_batch_size, 2)
        self.assertEqual(settings.dedup.neighbor_block_size, 96)
        public = settings.public_dict()["dedup"]
        self.assertEqual(public["torch_threads"], 2)
        self.assertEqual(public["neighbor_block_size"], 96)

    @unittest.skipIf(os.name == "nt", "POSIX 符号链接权限验证")
    def test_managed_runtime_symlink_is_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "external-target"
            target.mkdir(mode=0o755)
            (root / "runtime-link").symlink_to(target, target_is_directory=True)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_dir": "runtime-link",
                        "database_path": "runtime-link/backend.sqlite3",
                        "default_output_root": "runtime-link/downloads",
                        "dedup": {"enabled": False},
                    }
                ),
                encoding="utf-8",
            )
            before_mode = target.stat().st_mode & 0o777
            with self.assertRaisesRegex(ValueError, "符号链接"):
                AppSettings.load(config_path)
            self.assertEqual(target.stat().st_mode & 0o777, before_mode)
            self.assertEqual(list(target.iterdir()), [])


class ProxyNodeRootConfigTests(unittest.TestCase):
    @staticmethod
    def _write_config(root: Path, proxy: dict) -> Path:
        path = root / "config.json"
        path.write_text(
            json.dumps(
                {
                    "runtime_dir": "runtime",
                    "database_path": "runtime/backend.sqlite3",
                    "default_output_root": "runtime/downloads",
                    "gallery": {"cache_file": "credentials/managed/cache.sqlite3"},
                    "dedup": {"enabled": False},
                    "proxy": proxy,
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_allowed_node_roots_are_absolute_but_public_values_are_relative(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self._write_config(
                root,
                {"allowed_node_roots": ["subscriptions", "external/nodes"]},
            )
            settings = AppSettings.load(path)
            self.assertEqual(
                settings.proxy.allowed_node_roots,
                [
                    Path(os.path.abspath(root / "subscriptions")),
                    Path(os.path.abspath(root / "external" / "nodes")),
                ],
            )
            public = settings.public_dict()["proxy"]["allowed_node_roots"]
            self.assertEqual(public, ["subscriptions", "nodes"])
            self.assertNotIn(str(root), json.dumps(public))

    def test_default_node_root_is_dedicated_subscriptions_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = AppSettings.load(self._write_config(root, {}))
            self.assertEqual(
                settings.proxy.allowed_node_roots,
                [Path(os.path.abspath(root / ".." / "subscriptions"))],
            )

    def test_empty_or_overbroad_node_root_is_rejected(self):
        for value in ("", "   ", "."):
            with self.subTest(value=repr(value)), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = self._write_config(root, {"allowed_node_roots": [value]})
                with self.assertRaisesRegex(ValueError, "allowed_node_roots"):
                    AppSettings.load(path)

    def test_config_node_file_remains_valid_outside_new_allow_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = root / "legacy" / "nodes.txt"
            legacy.parent.mkdir()
            legacy.write_text("http://127.0.0.1:18080#LEGACY\n", encoding="utf-8")
            path = self._write_config(
                root,
                {
                    "node_file": "legacy/nodes.txt",
                    "allowed_node_roots": ["subscriptions"],
                },
            )
            settings = AppSettings.load(path)
            self.assertEqual(settings.proxy.node_file, legacy.resolve())
            self.assertNotIn(legacy.resolve(), settings.proxy.allowed_node_roots)


class AuthorizationProxyConfigTests(unittest.TestCase):
    def test_default_is_direct_and_reported_as_none(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = AppSettings.load(Path(temporary) / "missing-config.json")
        self.assertEqual(settings.auth.authorization_proxy, "")
        self.assertIsNone(settings.public_dict()["auth"]["authorization_proxy"])

    def test_configured_proxy_is_normalized_and_public(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"auth": {"authorization_proxy": " HTTP://127.0.0.1:7890/ "}}),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)
        self.assertEqual(settings.auth.authorization_proxy, "http://127.0.0.1:7890")
        self.assertEqual(
            settings.public_dict()["auth"]["authorization_proxy"],
            "http://127.0.0.1:7890",
        )

    def test_proxy_credentials_are_redacted_from_public_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "auth": {"authorization_proxy": "http://user:secret@127.0.0.1:7890"},
                        "dedup": {"enabled": False},
                    }
                ),
                encoding="utf-8",
            )
            settings = AppSettings.load(config_path)
        public_value = settings.public_dict()["auth"]["authorization_proxy"]
        self.assertEqual(public_value, "http://***@127.0.0.1:7890")
        self.assertNotIn("secret", public_value)

    def test_invalid_proxy_rejected_at_load(self):
        bad_values = [
            "ftp://127.0.0.1:7890",
            "127.0.0.1:7890",
            "http://:7890",
            "http://127.0.0.1",
            "http://127.0.0.1:7890/path",
            "socks5://user:pass@127.0.0.1:1080",
        ]
        for bad in bad_values:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config_path = root / "config.json"
                config_path.write_text(
                    json.dumps({"auth": {"authorization_proxy": bad}}),
                    encoding="utf-8",
                )
                with self.assertRaises(ValueError, msg=bad):
                    AppSettings.load(config_path)

    def test_validate_rejects_directly_assigned_invalid_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = AppSettings.load(Path(temporary) / "missing-config.json")
            settings.auth.authorization_proxy = "not-a-proxy"
            with self.assertRaises(ValueError):
                settings.validate()


class NormalizeAuthorizationProxyTests(unittest.TestCase):
    def test_valid_forms(self):
        self.assertEqual(normalize_authorization_proxy(""), "")
        self.assertEqual(normalize_authorization_proxy(None), "")
        self.assertEqual(normalize_authorization_proxy("   "), "")
        self.assertEqual(
            normalize_authorization_proxy("http://user:pa55@10.0.0.2:8080"),
            "http://user:pa55@10.0.0.2:8080",
        )
        self.assertEqual(
            normalize_authorization_proxy("socks5h://127.0.0.1:7890"),
            "socks5h://127.0.0.1:7890",
        )
        self.assertEqual(
            normalize_authorization_proxy("socks5://[::1]:1080"),
            "socks5://[::1]:1080",
        )

    def test_rejects_garbage(self):
        bad_values = [
            "http://127.0.0.1:7890 extra",
            "http://127.0.0.1:notaport",
            "https://127.0.0.1:7890?x=1",
            "socks5://127.0.0.1:7890#frag",
            "http://127.0\n.0.1:7890",
            "http://127.0.0.1:7890/" + "a" * 300,
        ]
        for bad in bad_values:
            with self.assertRaises(ValueError, msg=repr(bad)):
                normalize_authorization_proxy(bad)


if __name__ == "__main__":
    unittest.main()
