from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class WebUiModuleTests(unittest.TestCase):
    def test_business_modules_static_security_boundaries(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"

        app_endpoints = {
            "proxy.js": {
                "/api/v1/proxy/status",
                "/api/v1/proxy/start",
                "/api/v1/proxy/reload",
                "/api/v1/proxy/probe",
                "/api/v1/proxy/stop",
                "/api/v1/proxy/sources",
                "/api/v1/proxy/sources/subscriptions",
                "/api/v1/proxy/sources/node-file",
                "/api/v1/proxy/sources/inline-nodes",
                "/api/v1/proxy/sources/override",
            },
            "vault.js": {
                "/api/v1/auth",
                "/api/v1/auth/proxy",
                "/api/v1/auth/browser-profile",
                "/api/v1/auth/pixiv/oauth/start",
                "/api/v1/auth/pixiv/oauth/session",
            },
            "policy.js": {"/api/v1/sites/policies"},
            "crawl.js": {
                "/api/v1/search",
                "/api/v1/search/autocomplete",
                "/api/v1/crawls",
            },
            "tasks.js": {"/api/v1/crawls"},
            "review.js": {"/api/v1/crawls"},
            "diagnostics.js": {
                "/healthz",
                "/readyz",
                "/api/v1/config?view=diagnostics",
                "/api/v1/scheduler/status?view=diagnostics",
            },
        }
        app_sources = {
            path.name: path.read_text(encoding="utf-8")
            for path in (webui / "js" / "apps").glob("*.js")
        }
        for name, endpoints in app_endpoints.items():
            source = app_sources[name]
            for endpoint in endpoints:
                self.assertEqual(source.count(f'"{endpoint}"'), 1, (name, endpoint))
            self.assertNotIn("createDeferredApplication", source, name)
            for hook in ("mount", "activate", "deactivate", "unmount"):
                self.assertIn(f"{hook}(", source, name)

        placeholder = app_sources["placeholder.js"]
        self.assertNotIn("/api/", placeholder)
        self.assertIn("createPlaceholderShell", placeholder)

        business_paths = [
            *(webui / "js" / "apps").glob("*.js"),
            *(webui / "js" / "components").glob("*.js"),
            *(webui / "js" / "core").glob("*-model.js"),
        ]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in business_paths)
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "console.",
        ):
            self.assertNotIn(forbidden, combined)

        proxy = app_sources["proxy.js"]
        vault = app_sources["vault.js"]
        policy = app_sources["policy.js"]
        crawl = app_sources["crawl.js"]
        tasks = app_sources["tasks.js"]
        review = app_sources["review.js"]
        diagnostics = app_sources["diagnostics.js"]
        self.assertIn('STATUS_POLL_KEY = "proxy.status"', proxy)
        self.assertIn('AUTHORIZATION_POLL_KEY = "vault.authorization"', vault)
        self.assertNotIn("polling.start", policy)
        self.assertIn('BATCH_POLL_KEY = "batches.active"', tasks)
        self.assertIn("queueMicrotask", tasks)
        self.assertIn('REVIEW_POLL_KEY = "review.active"', review)
        self.assertIn("queueMicrotask", review)
        self.assertIn('DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"', diagnostics)
        self.assertIn("idempotencyKey: true", crawl)
        self.assertIn("beforeLeave()", review)
        self.assertNotIn("force: true", proxy)

        for name in ("crawl.js", "tasks.js", "review.js", "diagnostics.js"):
            source = app_sources[name]
            self.assertNotIn("/api/v1/auth", source, name)
            self.assertNotIn("/api/v1/proxy", source, name)
            self.assertNotIn("/api/v1/sites", source, name)

        store = (webui / "js" / "core" / "store.js").read_text(encoding="utf-8")
        for action in (
            'DIAGNOSTICS_RECEIVED: "diagnostics/received"',
            'CRAWL_SEARCH_RECEIVED: "crawl/searchReceived"',
            'BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived"',
            'REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived"',
        ):
            self.assertIn(action, store)
        for sanitizer in (
            "validateDiagnosticsSnapshot",
            "validateCrawlSnapshot",
            "sanitizeBatchDetail",
            "validateReviewState",
        ):
            self.assertIn(sanitizer, store)

        review_model = (webui / "js" / "core" / "review-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("buildReviewDecisionPayload", review_model)
        self.assertIn("reviewImageUrl", review_model)
        self.assertNotIn("relative_path:", review_model)
        crawl_model = (webui / "js" / "core" / "crawl-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("projectCrawlSearchResponse", crawl_model)
        self.assertIn("buildCrawlPayload", crawl_model)
        self.assertIn("operations.set", crawl_model)

    def test_pure_javascript_modules(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("未安装 Node.js；生产运行不依赖 Node.js")

        backend_root = Path(__file__).resolve().parents[1]
        source_webui = backend_root / "gdl_backend" / "webui"
        source_test = backend_root / "tests" / "webui_modules.test.mjs"
        with tempfile.TemporaryDirectory() as temporary:
            test_root = Path(temporary)
            shutil.copytree(
                source_webui / "js",
                test_root / "gdl_backend" / "webui" / "js",
            )
            (test_root / "tests").mkdir()
            shutil.copy2(source_test, test_root / "tests" / source_test.name)
            # ESM 标记仅存在于临时测试目录，不进入 wheel 或最终运行环境。
            (test_root / "package.json").write_text(
                '{"type":"module","private":true}\n',
                encoding="utf-8",
            )
            completed = subprocess.run(
                [node, "--test", str(test_root / "tests" / source_test.name)],
                cwd=test_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
                check=False,
            )

        if completed.returncode != 0:
            self.fail(
                "WebUI 纯 JavaScript 模块测试失败：\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            )


if __name__ == "__main__":
    unittest.main()
