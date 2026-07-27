from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gdl_backend.config import AppSettings, normalize_authorization_proxy


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
