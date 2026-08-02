from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, _validate_network_target, create_app
from gdl_backend.crawl import CrawlUnit
from gdl_backend.discovery import DiscoveryError

from tests.helpers import make_settings


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        self.client_context = TestClient(self.app)
        self.client = self.client_context.__enter__()
        self.headers = {}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def test_health_ready_and_local_api(self):
        health = self.client.get("/healthz")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["components"]["database"]["status"], "ok")
        ready = self.client.get("/readyz")
        self.assertEqual(ready.status_code, 200, ready.text)
        self.assertTrue(ready.json()["ready"])
        self.assertEqual(ready.json()["components"]["dedup"]["status"], "disabled")
        self.assertEqual(
            ready.json()["components"]["project_proxy"]["status"], "disabled"
        )
        self.assertEqual(self.client.get("/api/v1/tasks").status_code, 200)

    def test_ready_fails_when_enabled_dedup_python_is_missing(self):
        self.settings.dedup.enabled = True
        self.settings.dedup.python_executable = Path(self.temp.name) / "missing-python"
        ready = self.client.get("/readyz")
        self.assertEqual(ready.status_code, 503, ready.text)
        self.assertFalse(ready.json()["ready"])
        self.assertEqual(
            ready.json()["components"]["dedup_python"]["status"], "error"
        )

    def test_webui_static_assets_and_root_link(self):
        root = self.client.get("/")
        self.assertEqual(root.status_code, 200)
        self.assertEqual(root.json()["ui"], "/ui/")

        index = self.client.get("/ui/")
        self.assertEqual(index.status_code, 200)
        self.assertIn("聚合爬取测试台", index.text)
        self.assertIn('id="ehTagFilter"', index.text)
        self.assertIn('id="ehTagGroups"', index.text)
        self.assertIn('id="authCenter"', index.text)
        self.assertIn('data-managed-browser-auth="twitter"', index.text)
        self.assertIn('data-managed-browser-auth="exhentai"', index.text)
        self.assertIn('id="startPixivOAuth"', index.text)
        self.assertIn('id="cancelPixivOAuth"', index.text)
        self.assertIn('id="clearAuthBrowserProfile"', index.text)
        self.assertIn('id="authProxyInput"', index.text)
        self.assertIn('id="saveAuthProxy"', index.text)
        self.assertIn('id="resetAuthProxy"', index.text)
        self.assertIn("授权专用代理", index.text)
        self.assertIn('id="ehDownloadOptions"', index.text)
        self.assertIn('name="ehImageMode"', index.text)
        self.assertIn('id="ehGpPolicy"', index.text)
        self.assertIn('id="reviewPanel"', index.text)
        self.assertIn('id="reviewGroups"', index.text)
        self.assertIn('id="reviewStart"', index.text)
        self.assertIn('id="reviewApply"', index.text)
        self.assertIn('id="rerunBatch"', index.text)
        self.assertIn("删除导出凭证", index.text)
        self.assertIn("X、Pixiv 与 EH 共用同一个项目授权 Chrome Profile", index.text)
        self.assertNotIn('id="apiKey"', index.text)
        self.assertNotIn('id="pixivOAuthCallback"', index.text)
        self.assertNotIn('id="completePixivOAuth"', index.text)
        self.assertNotIn('id="authBrowser"', index.text)
        self.assertNotIn('data-browser-auth=', index.text)
        self.assertNotIn("Cookie 文件</span><span>gallery-dl 配置", index.text)
        self.assertIn("text/html", index.headers["content-type"])

        script = self.client.get("/ui/app.js")
        self.assertEqual(script.status_code, 200)
        self.assertIn("/api/v1/search", script.text)
        self.assertIn("/api/v1/crawls", script.text)
        self.assertIn("rerunActiveBatch", script.text)
        self.assertIn("/rerun", script.text)
        self.assertNotIn("X-API-Key", script.text)
        self.assertNotIn("gdl.apiKey", script.text)
        self.assertIn("address-thumbnail", script.text)
        self.assertIn("gallery-tags", script.text)
        self.assertIn("ehEntryMatchesTagFilter", script.text)
        self.assertIn("eh-tag-option", script.text)
        self.assertIn("keyword_gallery_search", script.text)
        self.assertIn("eh_download", script.text)
        self.assertIn("ehDownloadOptions", script.text)
        self.assertIn("/api/v1/auth", script.text)
        self.assertIn("startManagedBrowserLogin", script.text)
        self.assertIn("scheduleBrowserLoginPoll", script.text)
        self.assertNotIn("importBrowserLogin", script.text)
        self.assertIn("schedulePixivOAuthPoll", script.text)
        self.assertIn("/api/v1/auth/browser-profile", script.text)
        self.assertIn("/api/v1/auth/proxy", script.text)
        self.assertIn("renderAuthProxy", script.text)
        self.assertIn("/review/decisions", script.text)
        self.assertIn("/review/start", script.text)
        self.assertIn("automatic_rejected_image_count", script.text)
        self.assertIn("setReviewGroupSelection", script.text)
        self.assertNotIn("completePixivOAuth", script.text)

        styles = self.client.get("/ui/styles.css")
        self.assertEqual(styles.status_code, 200)
        self.assertIn(".source-card", styles.text)
        self.assertIn(".address-thumbnail", styles.text)
        self.assertIn(".gallery-tag", styles.text)
        self.assertIn(".eh-tag-filter", styles.text)
        self.assertIn(".eh-tag-option.exclude", styles.text)
        self.assertIn(".auth-center", styles.text)
        self.assertIn(".auth-proxy-row", styles.text)
        self.assertIn(".oauth-panel", styles.text)
        self.assertIn(".segmented-control", styles.text)
        self.assertIn(".eh-download-options", styles.text)
        self.assertIn(".review-image-grid", styles.text)
        self.assertIn(".review-group.duplicate", styles.text)

    def test_authorization_proxy_api_roundtrip(self):
        # 路由顺序回归：/auth/proxy 不能被 /auth/{site} 当成站点名吃掉（那会 404）
        initial = self.client.get("/api/v1/auth/proxy")
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertIsNone(initial.json()["proxy_url"])
        self.assertEqual(initial.json()["source"], "none")

        updated = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "http://127.0.0.1:7890"}
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["proxy_url"], "http://127.0.0.1:7890")
        self.assertEqual(updated.json()["source"], "runtime")

        listing = self.client.get("/api/v1/auth")
        self.assertEqual(
            listing.json()["authorization_proxy"]["proxy_url"], "http://127.0.0.1:7890"
        )

        invalid = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "ftp://127.0.0.1:21"}
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)
        self.assertEqual(invalid.json()["error"]["code"], "invalid_authorization_proxy")

        unknown_field = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "", "surprise": True}
        )
        self.assertEqual(unknown_field.status_code, 422)

        direct = self.client.put("/api/v1/auth/proxy", json={"proxy_url": ""})
        self.assertEqual(direct.status_code, 200, direct.text)
        self.assertIsNone(direct.json()["proxy_url"])
        self.assertEqual(direct.json()["source"], "runtime")

        reset = self.client.delete("/api/v1/auth/proxy")
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertIsNone(reset.json()["proxy_url"])
        self.assertEqual(reset.json()["source"], "none")

    def test_managed_auth_api_contract(self):
        listing = self.client.get("/api/v1/auth")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(
            [item["site"] for item in listing.json()["items"]],
            ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"],
        )
        self.assertFalse(listing.json()["secrets_exposed"])
        self.assertTrue(listing.json()["browser_profile"]["shared"])
        unknown = self.client.get("/api/v1/auth/unknown", headers=self.headers)
        self.assertEqual(unknown.status_code, 404)

        browser_status = {
            "site": "twitter",
            "label": "X / Twitter",
            "method": "managed_browser",
            "state": "authorizing",
            "authorized": False,
            "summary": "项目专属浏览器已打开。",
            "actions": ["managed_browser_login", "clear"],
        }
        browser_session = {
            "session_id": "b" * 32,
            "site": "twitter",
            "state": "awaiting_login",
            "message": "请完成登录。",
            "created_at": 1,
            "expires_at": 901,
            "cookie_count": 0,
            "recommended_missing": [],
            "error": None,
        }
        browser_result = {"status": browser_status, "session": browser_session}
        self.container.auth.start_browser_login = AsyncMock(return_value=browser_result)
        started_browser = self.client.post(
            "/api/v1/auth/twitter/login/start",
            headers=self.headers,
        )
        self.assertEqual(started_browser.status_code, 202, started_browser.text)
        self.assertEqual(started_browser.json()["session"]["session_id"], "b" * 32)
        self.container.auth.start_browser_login.assert_awaited_once_with("twitter")

        self.container.auth.browser_login_session = Mock(return_value=browser_result)
        polled = self.client.get(
            f"/api/v1/auth/twitter/login/{'b' * 32}",
            headers=self.headers,
        )
        self.assertEqual(polled.status_code, 200, polled.text)
        self.container.auth.browser_login_session.assert_called_once_with("twitter", "b" * 32)

        self.container.auth.cancel_browser_login = AsyncMock(return_value=browser_result)
        closed = self.client.delete(
            f"/api/v1/auth/twitter/login/{'b' * 32}",
            headers=self.headers,
        )
        self.assertEqual(closed.status_code, 200, closed.text)
        self.container.auth.cancel_browser_login.assert_awaited_once_with("twitter", "b" * 32)
        self.assertEqual(
            self.client.post("/api/v1/auth/twitter/browser", headers=self.headers, json={}).status_code,
            404,
        )

        session = {
            "session_id": "a" * 32,
            "state": "awaiting_code",
            "authorization_url": "https://app-api.pixiv.net/web/v1/login?state=test",
            "created_at": 1,
            "expires_at": 601,
            "error": None,
        }
        self.container.auth.start_pixiv_oauth = AsyncMock(return_value=session)
        started = self.client.post("/api/v1/auth/pixiv/oauth/start", headers=self.headers)
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["session_id"], "a" * 32)

        pixiv_status = {
            "site": "pixiv",
            "label": "Pixiv",
            "method": "oauth",
            "state": "authorized",
            "authorized": True,
            "summary": "Pixiv 登录授权有效。",
            "actions": ["oauth", "clear"],
        }
        completed = self.client.post(
            "/api/v1/auth/pixiv/oauth/complete",
            headers=self.headers,
            json={"session_id": "a" * 32, "callback": "https://callback/?code=VALUE"},
        )
        self.assertEqual(completed.status_code, 404, completed.text)
        self.assertNotIn(
            "/api/v1/auth/pixiv/oauth/complete",
            self.client.get("/openapi.json").json()["paths"],
        )

        self.container.auth.cancel_pixiv_oauth = AsyncMock(return_value=pixiv_status)
        cancelled = self.client.delete(
            "/api/v1/auth/pixiv/oauth/session",
            headers=self.headers,
        )
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.container.auth.cancel_pixiv_oauth.assert_awaited_once()

        self.container.auth.clear = AsyncMock(return_value={**pixiv_status, "authorized": False})
        cleared = self.client.delete("/api/v1/auth/pixiv", headers=self.headers)
        self.assertEqual(cleared.status_code, 200, cleared.text)

        profile_result = {
            "browser_profile": {"shared": True, "present": False, "running": False},
            "auth": {"items": []},
        }
        self.container.auth.clear_browser_profile = AsyncMock(return_value=profile_result)
        profile_cleared = self.client.delete(
            "/api/v1/auth/browser-profile",
            headers=self.headers,
        )
        self.assertEqual(profile_cleared.status_code, 200, profile_cleared.text)
        self.container.auth.clear_browser_profile.assert_awaited_once()

    def test_task_idempotency_cancel_logs_and_files(self):
        body = {"url": "https://www.pixiv.net/artworks/123456", "proxy_mode": "direct"}
        headers = {**self.headers, "Idempotency-Key": "same-request"}
        first = self.client.post("/api/v1/tasks", headers=headers, json=body)
        self.assertEqual(first.status_code, 202, first.text)
        second = self.client.post("/api/v1/tasks", headers=headers, json=body)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["id"], second.json()["id"])
        task_id = first.json()["id"]
        cancelled = self.client.post(f"/api/v1/tasks/{task_id}/cancel", headers=self.headers)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual(self.client.get(f"/api/v1/tasks/{task_id}/logs", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get(f"/api/v1/tasks/{task_id}/files", headers=self.headers).status_code, 200)

    def test_task_automatically_uses_managed_site_login(self):
        cookie_path = self.container.auth.managed_dir / "twitter.cookies.txt"
        cookie_path.write_text(
            "# Netscape HTTP Cookie File\n\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\tSECRET\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tct0\tSECRET2\n",
            encoding="utf-8",
        )
        response = self.client.post(
            "/api/v1/tasks",
            headers=self.headers,
            json={"url": "https://x.com/example/status/123456", "proxy_mode": "direct"},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["cookies_file"], str(cookie_path))

    def test_site_policy_crud_and_proxy_status(self):
        policy = {
            "max_concurrency": 1,
            "retry_limit": 1,
            "backoff_base_seconds": 0,
            "proxy_mode": "required",
            "probe_url": "https://www.pixiv.net/",
            "probe_before_use": True,
            "node_tags": ["jp"],
            "http_timeout": 15,
            "gallery_retries": 1,
            "task_timeout_seconds": 60,
            "extra_args": [],
        }
        response = self.client.put("/api/v1/sites/policies/pixiv", headers=self.headers, json=policy)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["policy"]["node_tags"], ["jp"])
        status = self.client.get("/api/v1/proxy/status", headers=self.headers)
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["running"])
        self.assertTrue(status.json()["managed_by_backend"])
        self.assertFalse(status.json()["auto_start"])
        self.assertEqual(status.json()["engine"], "native")
        self.assertFalse(status.json()["executable_required"])

    def test_private_target_guard(self):
        with self.assertRaises(ValueError):
            _validate_network_target("http://127.0.0.1:8080/a", False)
        _validate_network_target("http://127.0.0.1:8080/a", True)
        mixed = [
            (None, None, None, None, ("127.0.0.1", 443)),
            (None, None, None, None, ("1.1.1.1", 443)),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=mixed):
            _validate_network_target("https://example.com/a", False)

    def test_known_site_must_match_extractor(self):
        response = self.client.post(
            "/api/v1/tasks",
            headers=self.headers,
            json={
                "url": "https://www.pixiv.net/artworks/123456",
                "site": "twitter",
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_task")

    def test_non_loopback_bind_is_rejected(self):
        self.settings.server.host = "0.0.0.0"
        with self.assertRaisesRegex(ValueError, "回环"):
            self.settings.validate()

    def test_search_sites_and_grouped_source_addresses(self):
        sites = self.client.get("/api/v1/search/sites", headers=self.headers)
        self.assertEqual(sites.status_code, 200)
        self.assertEqual(
            {item["site"] for item in sites.json()["items"]},
            {"twitter", "pixiv", "danbooru", "exhentai", "pawchive"},
        )
        eh_catalog = next(
            item for item in sites.json()["items"] if item["site"] == "exhentai"
        )
        self.assertEqual(
            {item["namespace"] for item in eh_catalog["tag_namespaces"]},
            {
                "artist",
                "character",
                "cosplayer",
                "female",
                "group",
                "language",
                "location",
                "male",
                "mixed",
                "other",
                "parody",
                "reclass",
                "temp",
            },
        )
        expected = {
            "site": "twitter",
            "keyword": "clover days",
            "search_url": "https://x.com/search?q=clover+days",
            "candidate_count": 1,
            "author_count": 1,
            "candidates": [
                {
                    "id": "123",
                    "site": "twitter",
                    "kind": "work",
                    "url": "https://x.com/artist/status/123",
                    "download_url": "https://x.com/artist/status/123",
                    "media_count": 1,
                    "author": {"id": "42"},
                }
            ],
            "authors": [
                {
                    "id": "42",
                    "site": "twitter",
                    "kind": "author",
                    "name": "artist",
                    "display_name": "clover days",
                    "url": "https://x.com/artist",
                    "works_url": "https://x.com/artist/media",
                }
            ],
            "proxy": {"mode": "direct", "used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=expected)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["x"],
                "keyword": "clover days",
                "limit": 10,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["source_count"], 1)
        self.assertEqual(payload["address_count"], 0)
        self.assertEqual(payload["weak_evidence_count"], 0)
        self.assertEqual(payload["sources"][0]["site"], "twitter")
        self.assertEqual(payload["sources"][0]["addresses"], [])
        self.assertEqual(
            payload["sources"][0]["search_strategy"],
            "danbooru_artist_urls",
        )
        self.assertEqual(payload["sources"][0]["weak_evidence"], [])
        self.assertEqual(payload["selection_contract"]["execution_order"], "source_then_address")
        self.assertEqual(payload["selection_contract"]["default_visibility"], "addresses_only")
        self.assertEqual(self.container.discovery.search.await_args.kwargs["site"], "danbooru")

    def test_exhentai_search_returns_selectable_galleries_with_previews(self):
        raw = {
            "site": "exhentai",
            "keyword": "ogipote",
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "3079340",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 3079340",
                    "url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "download_url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {"gallery_token": "991425f1c4"},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        enriched = {
            **raw,
            "preview_count": 1,
            "preview_missing_count": 0,
            "candidates": [
                {
                    **raw["candidates"][0],
                    "title": "(C104) Catchy & Punk",
                    "thumbnail_url": "https://ehgt.org/w/cover.webp",
                    "media_count": 13,
                    "metadata": {
                        "gallery_token": "991425f1c4",
                        "tags": ["artist:ogipote"],
                    },
                }
            ],
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            return_value=enriched
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "ogipote",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(source["weak_evidence_count"], 0)
        self.assertEqual(source["preview_count"], 1)
        self.assertEqual(source["preview_missing_count"], 0)
        gallery = source["addresses"][0]
        self.assertEqual(gallery["confidence"], "site_search")
        self.assertEqual(gallery["label"], "(C104) Catchy & Punk")
        self.assertEqual(gallery["thumbnail_url"], "https://ehgt.org/w/cover.webp")
        self.assertEqual(gallery["media_count"], 13)
        self.assertEqual(gallery["metadata"]["tags"], ["artist:ogipote"])
        self.assertEqual(source["tag_facets"][0]["namespace"], "artist")
        self.assertEqual(source["tag_facets"][0]["tags"][0]["tag"], "artist:ogipote")
        self.assertEqual(source["weak_evidence"], [])
        self.assertEqual(
            response.json()["tag_filter_contract"]["same_namespace"],
            "or",
        )
        self.container.discovery.enrich_exhentai_previews.assert_awaited_once()

    def test_exhentai_preview_failure_keeps_all_galleries_selectable(self):
        raw = {
            "site": "exhentai",
            "keyword": "ogipote",
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "3079340",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 3079340",
                    "url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "download_url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {"gallery_token": "991425f1c4"},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=DiscoveryError("exhentai_preview_lookup_failed", "temporary")
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "ogipote",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(source["weak_evidence_count"], 0)
        self.assertEqual(source["preview_count"], 0)
        self.assertEqual(source["preview_missing_count"], 1)
        self.assertEqual(source["addresses"][0]["confidence"], "site_search")
        self.assertEqual(
            source["enrichment_errors"][0]["stage"],
            "exhentai_gallery_previews",
        )

    def test_exhentai_search_expands_danbooru_aliases(self):
        def gallery(gid: str, token: str) -> dict:
            url = f"https://e-hentai.org/g/{gid}/{token}/"
            return {
                "id": gid,
                "site": "exhentai",
                "kind": "gallery",
                "title": f"Gallery {gid}",
                "url": url,
                "download_url": url,
                "thumbnail_url": None,
                "media_count": None,
                "metadata": {},
            }

        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "exhentai")
            candidates = {
                "wlop": [gallery("100", "aaaaaaaaaa")],
                "王凌": [gallery("100", "aaaaaaaaaa"), gallery("200", "bbbbbbbbbb")],
                "wlopwangling": [],
            }[keyword]
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://e-hentai.org/?f_search=wlop",
                "candidate_count": len(candidates),
                "author_count": 0,
                "candidates": candidates,
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={
                "authors": [
                    {
                        "name": "wlop",
                        "other_names": ["王凌", "wlopwangling"],
                        "origin": "danbooru_artist_directory",
                    }
                ]
            }
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=lambda result, **kwargs: result
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "wlop",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "succeeded")
        self.assertEqual(source["alias_keywords"], ["王凌", "wlopwangling"])
        self.assertEqual(source["address_count"], 2)
        by_label = {item["label"]: item for item in source["addresses"]}
        self.assertEqual(
            by_label["Gallery 100"]["evidence_reasons"],
            ["keyword_gallery_search", "danbooru_alias_search"],
        )
        self.assertEqual(
            by_label["Gallery 200"]["evidence_reasons"],
            ["danbooru_alias_search"],
        )
        self.assertEqual(by_label["Gallery 200"]["matched_keywords"], ["王凌"])
        searched = sorted(
            call.kwargs["keyword"]
            for call in self.container.discovery.search.await_args_list
        )
        self.assertEqual(searched, sorted(["wlop", "王凌", "wlopwangling"]))
        self.container.discovery.search_danbooru_artists.assert_awaited_once()

    def test_exhentai_alias_lookup_failure_degrades_to_plain_search(self):
        raw = {
            "site": "exhentai",
            "keyword": "wlop",
            "search_url": "https://e-hentai.org/?f_search=wlop",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "100",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 100",
                    "url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "download_url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            side_effect=DiscoveryError("danbooru_api_protocol", "directory down")
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=lambda result, **kwargs: result
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "wlop",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["alias_keywords"], [])
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(
            source["enrichment_errors"][0]["stage"], "danbooru_alias_lookup"
        )
        self.assertEqual(
            source["addresses"][0]["evidence_reasons"], ["keyword_gallery_search"]
        )
        self.container.discovery.search.assert_awaited_once()

    def test_search_autocomplete_endpoint(self):
        self.container.discovery.danbooru_autocomplete = AsyncMock(
            return_value={
                "query": "柠檬静",
                "items": [
                    {
                        "value": "ningmeng_jing_jing_jing_jing",
                        "label": "ningmeng jing jing jing jing",
                        "match_type": "tag-other-name",
                        "antecedent": "柠檬静静静静",
                        "category": "artist",
                        "post_count": 255,
                    }
                ],
                "proxy": {"used": False},
                "attempts": 1,
            }
        )
        response = self.client.get(
            "/api/v1/search/autocomplete",
            headers=self.headers,
            params={"q": "柠檬静"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["source"], "danbooru")
        self.assertEqual(payload["query"], "柠檬静")
        self.assertEqual(
            payload["items"][0]["value"], "ningmeng_jing_jing_jing_jing"
        )
        self.assertEqual(payload["items"][0]["antecedent"], "柠檬静静静静")
        call = self.container.discovery.danbooru_autocomplete.await_args
        self.assertEqual(call.args[0], "柠檬静")
        self.assertEqual(call.kwargs["limit"], 10)

        blank = self.client.get(
            "/api/v1/search/autocomplete", headers=self.headers, params={"q": "  "}
        )
        self.assertEqual(blank.status_code, 422)

        self.container.discovery.danbooru_autocomplete = AsyncMock(
            side_effect=DiscoveryError("danbooru_api_protocol", "bad upstream")
        )
        failed = self.client.get(
            "/api/v1/search/autocomplete", headers=self.headers, params={"q": "abc"}
        )
        self.assertEqual(failed.status_code, 502)

    def test_cross_source_search_uses_danbooru_curated_profiles(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            if site == "danbooru":
                return {
                    "site": site,
                    "keyword": keyword,
                    "search_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                    "candidate_count": 1,
                    "author_count": 1,
                    "candidates": [
                        {
                            "id": "10",
                            "site": "danbooru",
                            "kind": "post",
                            "metadata": {
                                "artists": ["artist_name"],
                                "characters": ["character_name"],
                            },
                        }
                    ],
                    "authors": [
                        {
                            "name": "artist_name",
                            "url": "https://danbooru.donmai.us/artists?search[name]=artist_name",
                            "works_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                        }
                    ],
                    "proxy": {"used": False},
                    "attempts": 1,
                }
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://example.invalid/search",
                "candidate_count": 0,
                "author_count": 0,
                "candidates": [],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.danbooru_artist_profiles = AsyncMock(
            return_value=(
                [
                    {
                        "id": "55",
                        "name": "artist_name",
                        "other_names": ["Artist Name"],
                        "group_name": None,
                        "profile_url": "https://danbooru.donmai.us/artists/55",
                        "related_profiles": [
                            {
                                "url": "https://x.com/artist_name",
                                "platform": "twitter",
                                "crawl_site": "twitter",
                                "crawl_url": "https://x.com/artist_name/media",
                                "active": True,
                            },
                            {
                                "url": "https://www.pixiv.net/users/77",
                                "platform": "pixiv",
                                "crawl_site": "pixiv",
                                "crawl_url": "https://www.pixiv.net/users/77/artworks",
                                "active": True,
                            },
                            {
                                "url": "https://x.com/artist_alt",
                                "platform": "twitter",
                                "crawl_site": "twitter",
                                "crawl_url": "https://x.com/artist_alt/media",
                                "active": True,
                            },
                        ],
                    }
                ],
                [],
            )
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["danbooru", "x", "pixiv"],
                "keyword": "artist name",
                "limit": 2,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [item["site"] for item in response.json()["sources"]],
            ["danbooru", "twitter", "pixiv"],
        )
        sources = {item["site"]: item for item in response.json()["sources"]}
        dan_types = {item["address_type"] for item in sources["danbooru"]["addresses"]}
        self.assertEqual(dan_types, {"artist_tag"})
        self.assertNotIn(
            "character_name",
            {item.get("tag") for item in sources["danbooru"]["addresses"]},
        )
        self.assertEqual(sources["twitter"]["addresses"][0]["url"], "https://x.com/artist_name/media")
        self.assertEqual(sources["pixiv"]["addresses"][0]["url"], "https://www.pixiv.net/users/77/artworks")
        self.assertEqual(sources["twitter"]["addresses"][0]["origin"], "danbooru_artist_url")
        self.assertEqual(sources["pixiv"]["addresses"][0]["confidence"], "verified")
        self.assertEqual(sources["pixiv"]["addresses"][0]["origin"], "danbooru_artist_url")
        self.assertIn(
            "danbooru_artist_url",
            sources["pixiv"]["addresses"][0]["evidence_reasons"],
        )
        self.assertEqual(sources["pixiv"]["weak_evidence_count"], 0)
        self.assertEqual(len(sources["twitter"]["addresses"]), 2)
        self.assertEqual(response.json()["weak_evidence_count"], 0)
        self.assertEqual(len(response.json()["related_profiles"]), 3)
        searched_sites = [call.kwargs["site"] for call in self.container.discovery.search.await_args_list]
        self.assertEqual(searched_sites, ["danbooru"])
        self.assertEqual(sources["twitter"]["search_strategy"], "danbooru_artist_urls")
        self.assertEqual(sources["pixiv"]["search_strategy"], "danbooru_artist_urls")

    def test_account_discovery_failure_marks_x_pixiv_partial(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "danbooru")
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                "candidate_count": 1,
                "author_count": 0,
                "candidates": [
                    {
                        "id": "10",
                        "site": "danbooru",
                        "kind": "post",
                        "metadata": {"artists": ["artist_name"]},
                    }
                ],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.danbooru_artist_profiles = AsyncMock(
            side_effect=DiscoveryError("discovery_failed", "proxy node flaked")
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["danbooru", "x", "pixiv"],
                "keyword": "artist_name",
                "limit": 5,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        sources = {item["site"]: item for item in response.json()["sources"]}
        self.assertEqual(sources["danbooru"]["status"], "partial")
        for affected in ("twitter", "pixiv"):
            self.assertEqual(sources[affected]["status"], "partial")
            self.assertEqual(sources[affected]["addresses"], [])
            stages = [
                item["stage"] for item in sources[affected]["enrichment_errors"]
            ]
            self.assertIn("danbooru_account_discovery", stages)
            self.assertIn(
                "proxy node flaked",
                sources[affected]["enrichment_errors"][-1]["message"],
            )

    def test_cross_source_search_skips_native_account_lookups(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "danbooru")
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://x.com/search?q=artist",
                "candidate_count": 0,
                "author_count": 0,
                "candidates": [],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={"keyword": "artist", "sites": ["pixiv", "x"], "proxy_mode": "direct"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [source["site"] for source in response.json()["sources"]],
            ["pixiv", "twitter"],
        )
        self.assertEqual(response.json()["sources"][0]["status"], "succeeded")
        self.assertEqual(response.json()["sources"][1]["status"], "succeeded")
        self.assertEqual(
            [call.kwargs["site"] for call in self.container.discovery.search.await_args_list],
            ["danbooru"],
        )
        self.container.discovery.search_danbooru_artists.assert_awaited_once()

    def test_ordered_crawl_sequence_and_batch_idempotency(self):
        async def discover_side_effect(*, site, url, **kwargs):
            count = 2 if url.endswith("artist-a/media") else 1
            work_id = "1" if "artist-a" in url else "2"
            work_url = (
                f"https://x.com/example/status/{work_id}"
                if site == "twitter"
                else f"https://www.pixiv.net/artworks/{work_id}"
            )
            candidate = {
                "id": work_id,
                "site": site,
                "kind": "work",
                "url": work_url,
                "media_count": count,
            }
            if site == "twitter":
                candidate["media_urls"] = [
                    f"https://pbs.twimg.com/media/sample-{work_id}-{index}?format=jpg&name=orig"
                    for index in range(1, count + 1)
                ]
            return {"candidates": [candidate]}

        self.container.discovery.discover_url = AsyncMock(side_effect=discover_side_effect)
        cookie_path = self.container.auth.managed_dir / "twitter.cookies.txt"
        cookie_path.write_text(
            "# Netscape HTTP Cookie File\n\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\tSECRET\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tct0\tSECRET2\n",
            encoding="utf-8",
        )
        body = {
            "sources": [
                {
                    "site": "x",
                    "addresses": [
                        {"url": "https://x.com/artist-a/media", "label": "A"},
                        {"url": "https://x.com/artist-b/media", "label": "B"},
                    ],
                    "extra_args": ["--filter", "favorite_count >= 0"],
                },
                {
                    "site": "pixiv",
                    "addresses": [
                        {"url": "https://www.pixiv.net/users/77/artworks", "label": "P"}
                    ],
                },
            ],
            "concurrency": 20,
            "proxy_mode": "direct",
            "extra_args": ["--sleep", "0"],
        }
        headers = {**self.headers, "Idempotency-Key": "ordered-batch"}
        first = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(first.status_code, 202, first.text)
        batch_id = first.json()["id"]
        self.assertEqual(first.json()["task_count"], 0)
        self.assertEqual(first.json()["execution_order"], "source_then_address")

        second = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["id"], batch_id)

        import asyncio

        asyncio.run(self.container.ordered_crawls.run_once())
        active = self.container.db.get_crawl_batch(batch_id)
        first_address = active["sources"][0]["addresses"][0]
        self.assertEqual(first_address["status"], "running")
        self.assertEqual(first_address["planned_task_count"], 2)
        self.assertEqual(active["sources"][0]["addresses"][1]["status"], "pending")
        self.assertEqual(active["sources"][1]["addresses"][0]["status"], "pending")
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 2)
        self.assertTrue(all(task["address_order"] == 0 for task in tasks))
        self.assertEqual(
            [task["url"] for task in tasks],
            [
                "https://pbs.twimg.com/media/sample-1-1?format=jpg&name=orig",
                "https://pbs.twimg.com/media/sample-1-2?format=jpg&name=orig",
            ],
        )
        self.assertTrue(all(task["cookies_file"] is None for task in tasks))
        self.assertTrue(all("--range" not in task["extra_args"] for task in tasks))
        self.assertEqual(tasks[0]["policy"]["max_concurrency"], 20)
        self.assertEqual(
            tasks[0]["extra_args"][:4],
            ["--sleep", "0", "--filter", "favorite_count >= 0"],
        )
        listing = self.client.get("/api/v1/crawls?limit=1", headers=self.headers)
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["items"][0]["id"], batch_id)
        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        task_page = self.client.get(
            f"/api/v1/crawls/{batch_id}/tasks?limit=1",
            headers=self.headers,
        )
        self.assertEqual(task_page.status_code, 200, task_page.text)
        self.assertEqual(len(task_page.json()["items"]), 1)
        missing = self.client.get("/api/v1/crawls/missing", headers=self.headers)
        self.assertEqual(missing.status_code, 404)

        for task in tasks:
            self.container.db.complete_task(task["id"], "succeeded")
        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        progressed = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(progressed["sources"][0]["addresses"][0]["status"], "succeeded")
        self.assertEqual(progressed["sources"][0]["addresses"][1]["status"], "running")
        self.assertEqual(progressed["sources"][1]["addresses"][0]["status"], "pending")
        self.assertEqual(len(self.container.db.list_crawl_tasks(batch_id)), 3)

    def test_ordered_crawl_probes_each_new_address_for_its_site(self):
        import asyncio

        events: list[tuple[str, str]] = []

        def probe(*, target_url, **_kwargs):
            events.append(("probe", target_url))
            return {
                "total": 3,
                "healthy": 2,
                "target": target_url,
                "results": [
                    {"id": "node-a", "healthy": True},
                    {"id": "node-b", "healthy": True},
                    {"id": "node-c", "healthy": False},
                ],
            }

        async def discover(*, site, url, **_kwargs):
            events.append(("discover", site))
            work_url = (
                "https://x.com/example/status/1"
                if site == "twitter"
                else "https://www.pixiv.net/artworks/2"
            )
            return {
                "candidates": [
                    {
                        "id": site,
                        "site": site,
                        "kind": "work",
                        "url": work_url,
                        "media_count": 1,
                    }
                ]
            }

        self.container.proxy.probe = Mock(side_effect=probe)
        self.container.discovery.discover_url = AsyncMock(side_effect=discover)
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "x",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    },
                    {
                        "site": "pixiv",
                        "addresses": [
                            {"url": "https://www.pixiv.net/users/77/artworks"}
                        ],
                    },
                ],
                "proxy_mode": "required",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        first_address = batch["sources"][0]["addresses"][0]
        self.assertEqual(events, [("probe", "https://x.com/"), ("discover", "twitter")])
        self.assertEqual(first_address["healthy_proxy_count"], 2)
        self.assertEqual(first_address["probed_proxy_count"], 3)
        first_task = self.container.db.list_crawl_tasks(batch_id)[0]
        self.assertEqual(first_task["policy"]["proxy_probe_scope"], first_address["id"])
        self.assertEqual(first_task["policy"]["probe_url"], "https://x.com/")
        self.assertNotIn("allowed_proxy_ids", first_task["policy"])
        self.assertEqual(
            self.container.db.get_crawl_address_proxy_probe(first_address["id"])["node_ids"],
            ["node-a", "node-b"],
        )

        self.container.db.complete_task(first_task["id"], "succeeded")
        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        self.assertEqual(
            events,
            [
                ("probe", "https://x.com/"),
                ("discover", "twitter"),
                ("probe", "https://www.pixiv.net/"),
                ("discover", "pixiv"),
            ],
        )

    def test_ordered_crawl_pre_deduplicates_pixiv_and_twitter_from_danbooru(self):
        import asyncio

        discovery_limits = []

        async def discover(*, site, **_kwargs):
            limit = int(_kwargs["limit"])
            discovery_limits.append((site, limit))
            if site == "danbooru":
                candidates = [
                    {
                        "id": "10",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/10",
                        "source_url": (
                            "https://www.pixiv.net/member_illust.php?"
                            "mode=medium&illust_id=100"
                        ),
                        "media_count": 1,
                    },
                    {
                        "id": "11",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/11",
                        "source_url": "https://www.pixiv.net/artworks/101",
                        "media_count": 1,
                    },
                    {
                        "id": "12",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/12",
                        "source_url": (
                            "https://i.pximg.net/img-original/img/2026/01/02/"
                            "03/04/05/102_p0.png"
                        ),
                        "media_count": 1,
                    },
                    {
                        "id": "13",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/13",
                        "source_url": "https://twitter.com/artist/status/200",
                        "media_count": 1,
                    },
                ]
                return {"candidates": candidates[:limit]}
            if site == "pixiv":
                candidates = [
                    {
                        "id": "100",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/100",
                        "media_count": 2,
                    },
                    {
                        "id": "101",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/101",
                        "media_count": 1,
                    },
                    {
                        "id": "102",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/102",
                        "media_count": 1,
                    },
                    {
                        "id": "103",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/103",
                        "media_count": 1,
                    },
                ]
                return {"candidates": candidates[:limit]}
            candidates = [
                {
                    "id": "200",
                    "site": "twitter",
                    "kind": "work",
                    "url": "https://x.com/artist/status/200",
                    "media_count": 1,
                }
            ]
            return {"candidates": candidates[:limit]}

        self.container.discovery.discover_url = AsyncMock(side_effect=discover)
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist"}
                        ],
                    },
                    {
                        "site": "pixiv",
                        "addresses": [
                            {"url": "https://www.pixiv.net/users/1/artworks"}
                        ],
                    },
                    {
                        "site": "twitter",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    },
                ],
                "max_tasks": 6,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        danbooru_tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(danbooru_tasks), 4)
        for task in danbooru_tasks:
            self.container.db.complete_task(task["id"], "succeeded")

        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        pixiv = batch["sources"][1]["addresses"][0]
        self.assertEqual(pixiv["status"], "running")
        self.assertEqual(pixiv["planned_task_count"], 1)
        self.assertEqual(pixiv["pre_dedup_skipped_count"], 4)
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 5)
        self.assertEqual(tasks[-1]["url"], "https://www.pixiv.net/artworks/103")
        self.container.db.complete_task(tasks[-1]["id"], "succeeded")

        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        twitter = batch["sources"][2]["addresses"][0]
        self.assertEqual(batch["status"], "succeeded")
        self.assertEqual(batch["task_count"], 5)
        self.assertEqual(batch["pre_dedup_skipped_count"], 5)
        self.assertEqual(twitter["status"], "succeeded")
        self.assertEqual(twitter["planned_task_count"], 0)
        self.assertEqual(twitter["pre_dedup_skipped_count"], 1)
        self.assertEqual(
            discovery_limits,
            [("danbooru", 7), ("pixiv", 6), ("twitter", 3)],
        )

    def test_required_crawl_stops_before_planning_when_site_probe_has_no_nodes(self):
        import asyncio

        self.container.proxy.probe = Mock(
            return_value={"total": 2, "healthy": 0, "results": []}
        )
        self.container.discovery.discover_url = AsyncMock()
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "x",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    }
                ],
                "proxy_mode": "required",
            },
        )
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        address = batch["sources"][0]["addresses"][0]
        self.assertEqual(address["status"], "failed")
        self.assertEqual(address["healthy_proxy_count"], 0)
        self.assertEqual(address["probed_proxy_count"], 2)
        self.assertIn("图站探活后没有可用代理节点", address["last_error"])
        self.assertEqual(batch["task_count"], 0)
        self.container.discovery.discover_url.assert_not_awaited()

    def test_crawl_contract_rejects_legacy_modes_and_non_gallery_eh_address(self):
        legacy = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "items": [{"url": "https://x.com/artist/media"}],
                "fanout": "media",
            },
        )
        self.assertEqual(legacy.status_code, 422)

        invalid_eh = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [{"url": "https://e-hentai.org/?f_search=tag"}],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(invalid_eh.status_code, 422, invalid_eh.text)
        self.assertEqual(invalid_eh.json()["error"]["code"], "invalid_crawl")

    def test_eh_download_options_are_persisted_and_reach_media_tasks(self):
        import asyncio

        self.container.crawl_planner.plan_media = AsyncMock(
            return_value=(
                [
                    CrawlUnit(
                        "https://e-hentai.org/s/aaaaaaaaaa/123-1",
                        "exhentai",
                        "media",
                        "123:1",
                        ["--range", "1"],
                    )
                ],
                [],
            )
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [
                            {"url": "https://e-hentai.org/g/123/cccccccccc/"}
                        ],
                        "eh_download": {
                            "image_mode": "original",
                            "gp_policy": "stop",
                        },
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        address = response.json()["sources"][0]["addresses"][0]
        self.assertEqual(
            address["download_options"],
            {"eh": {"image_mode": "original", "gp_policy": "stop"}},
        )

        asyncio.run(self.container.ordered_crawls.run_once())
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(
            tasks[0]["policy"]["eh_download"],
            {"image_mode": "original", "gp_policy": "stop"},
        )
        self.assertEqual(tasks[0]["extra_args"], ["--range", "1"])

        wrong_site = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [{"url": "https://x.com/example/media"}],
                        "eh_download": {"image_mode": "original"},
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(wrong_site.status_code, 422, wrong_site.text)
        self.assertEqual(wrong_site.json()["error"]["code"], "invalid_crawl")

        invalid_mode = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [
                            {"url": "https://e-hentai.org/g/123/cccccccccc/"}
                        ],
                        "eh_download": {"image_mode": "archive"},
                    }
                ]
            },
        )
        self.assertEqual(invalid_mode.status_code, 422, invalid_mode.text)

    def test_partial_enqueue_drains_current_address_before_next_address(self):
        import asyncio

        self.container.discovery.discover_url = AsyncMock(
            return_value={
                "candidates": [
                    {
                        "id": "1",
                        "site": "twitter",
                        "kind": "work",
                        "url": "https://x.com/artist/status/1",
                        "media_count": 2,
                    }
                ]
            }
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [
                            {"url": "https://x.com/artist/media"},
                            {"url": "https://x.com/artist2/media"},
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        batch_id = response.json()["id"]
        original_enqueue = self.container.ordered_crawls._enqueue
        calls = 0

        async def flaky_enqueue(body, key, concurrency):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected enqueue failure")
            return await original_enqueue(body, key, concurrency)

        self.container.ordered_crawls.set_enqueue(flaky_enqueue)
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "running")
        self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "failed")
        self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
        self.container.ordered_crawls.set_enqueue(original_enqueue)

    def test_manager_cancellation_drains_linked_tasks_without_replanning(self):
        import asyncio

        self.container.discovery.discover_url = AsyncMock(
            return_value={
                "candidates": [
                    {
                        "id": "1",
                        "site": "twitter",
                        "kind": "work",
                        "url": "https://x.com/artist/status/1",
                        "media_count": 2,
                    }
                ]
            }
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [
                            {"url": "https://x.com/artist/media"},
                            {"url": "https://x.com/artist2/media"},
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        batch_id = response.json()["id"]
        original_enqueue = self.container.ordered_crawls._enqueue

        async def scenario():
            second_enqueue = asyncio.Event()
            calls = 0

            async def blocking_enqueue(body, key, concurrency):
                nonlocal calls
                calls += 1
                if calls == 2:
                    second_enqueue.set()
                    await asyncio.Event().wait()
                return await original_enqueue(body, key, concurrency)

            self.container.ordered_crawls.set_enqueue(blocking_enqueue)
            worker = asyncio.create_task(self.container.ordered_crawls.run_once())
            await asyncio.wait_for(second_enqueue.wait(), timeout=1)
            worker.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await worker

        try:
            asyncio.run(scenario())
            batch = self.container.db.get_crawl_batch(batch_id)
            first = batch["sources"][0]["addresses"][0]
            self.assertEqual(first["status"], "running")
            self.assertEqual(first["planned_task_count"], 1)
            self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
            linked = self.container.db.crawl_address_tasks(first["id"])
            self.assertEqual(len(linked), 1)
            self.assertEqual(linked[0]["status"], "cancelled")

            asyncio.run(self.container.ordered_crawls.run_once())
            batch = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "failed")
            self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
        finally:
            self.container.ordered_crawls.set_enqueue(original_enqueue)

    def test_cancel_queued_ordered_crawl(self):
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist_name"}
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        cancelled = self.client.post(f"/api/v1/crawls/{batch_id}/cancel", headers=self.headers)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual(cancelled.json()["sources"][0]["addresses"][0]["status"], "cancelled")

    def test_retry_replans_batch_with_only_planning_failures(self):
        # A finished batch whose only defect is a planning failure (0 media tasks) must
        # still be resumable and its /retry endpoint must NOT 409.
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-replan",
                "output_dir": str(Path(self.temp.name) / "batch-api-replan"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-replan",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/12/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.container.db.begin_crawl_address_planning("address-api-replan"))
        self.container.db.fail_crawl_address("address-api-replan", "planning blew up")
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["failed_task_count"], 0)
        self.assertTrue(detail.json()["resumable"])

        retry = self.client.post(
            f"/api/v1/crawls/{batch_id}/retry",
            headers=self.headers,
            json={"additional_attempts": 1},
        )
        self.assertEqual(retry.status_code, 202, retry.text)
        payload = retry.json()
        self.assertEqual(payload["retried_count"], 0)
        self.assertEqual(payload["replanned_address_count"], 1)
        self.assertEqual(payload["replanned_address_ids"], ["address-api-replan"])
        self.assertEqual(payload["batch"]["status"], "running")
        replanned = payload["batch"]["sources"][0]["addresses"][0]
        self.assertEqual(replanned["status"], "pending")
        self.assertEqual(replanned["planning_error"], "")

    def test_replan_returns_address_own_linked_tasks_to_budget(self):
        # Re-planning a large partially-planned address must not trip crawl_plan_too_large:
        # its already-linked tasks are counted by crawl_batch_task_count but re-enqueue
        # idempotently (no new budget), so `remaining` must add that count back. Here
        # max_tasks=10, another address holds 2 tasks, this address holds 5 partial tasks;
        # the fixed remaining is 10-2=8 (the old formula gave 10-7=3 and would raise).
        import asyncio

        root = Path(self.temp.name)

        def task_row(task_id):
            return {
                "id": task_id,
                "url": "https://danbooru.donmai.us/posts/1",
                "site": "danbooru",
                "subcategory": "post",
                "extractor": "DanbooruExtractor",
                "output_dir": str(root / "out"),
                "proxy_mode": "direct",
                "max_attempts": 3,
                "policy": {"max_concurrency": 1},
                "extra_args": [],
            }

        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-budget",
                "output_dir": str(self.settings.default_output_root / "batch-budget"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "addr-A",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
                {
                    "id": "addr-B",
                    "site": "danbooru",
                    "source_order": 1,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=b",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
            ],
        )
        # Address B contributes 2 tasks to the batch budget (other addresses' work).
        for i in range(2):
            self.container.db.create_task(task_row(f"b-task-{i}"))
            self.container.db.link_crawl_task("addr-B", f"b-task-{i}", i + 1)
        # Address A already holds 5 partially-planned tasks still linked (re-plan keeps them).
        for i in range(5):
            self.container.db.create_task(task_row(f"a-task-{i}"))
            self.container.db.link_crawl_task("addr-A", f"a-task-{i}", i + 1)

        self.assertEqual(self.container.db.crawl_address_task_count("addr-A"), 5)
        self.assertEqual(self.container.db.crawl_batch_task_count(batch_id), 7)

        captured = {}
        units = [
            CrawlUnit(
                url=f"https://danbooru.donmai.us/posts/{100 + i}",
                site="danbooru",
                kind="post",
                source_id=f"danbooru:{100 + i}",
            )
            for i in range(4)  # old remaining 3 would raise; fixed remaining 8 allows it
        ]

        async def fake_plan(address, *, batch_id, policy, max_tasks):
            captured["max_tasks"] = max_tasks
            return units, 0

        batch = self.container.db.get_crawl_batch(batch_id)
        address = batch["sources"][0]["addresses"][0]
        self.assertEqual(address["id"], "addr-A")
        with patch.object(self.container.ordered_crawls, "_plan_address", new=fake_plan):
            asyncio.run(self.container.ordered_crawls._activate_address(batch, address))

        # remaining passed to the planner adds addr-A's own 5 linked tasks back:
        # 10 - crawl_batch_task_count(7) + crawl_address_task_count(5) = 8.
        self.assertEqual(captured["max_tasks"], 8)
        replanned = self.container.db.get_crawl_batch(batch_id)["sources"][0]["addresses"][0]
        # Guard did NOT raise (the old formula would have driven addr-A to 'failed').
        self.assertEqual(replanned["status"], "running", replanned.get("last_error"))

    def test_rerun_endpoint_reopens_terminal_batch(self):
        root = Path(self.temp.name)
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-rerun",
                "output_dir": str(root / "batch-api-rerun"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-rerun",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.container.db.begin_crawl_address_planning("address-api-rerun"))
        self.container.db.create_task(
            {
                "id": "api-rerun-task",
                "url": "https://danbooru.donmai.us/posts/1",
                "site": "danbooru",
                "output_dir": str(root / "out"),
                "proxy_mode": "direct",
                "max_attempts": 3,
                "policy": {"max_concurrency": 1},
                "extra_args": [],
            }
        )
        self.container.db.link_crawl_task("address-api-rerun", "api-rerun-task", 1)
        self.assertTrue(self.container.db.mark_crawl_address_running("address-api-rerun"))
        self.container.db.complete_task("api-rerun-task", "succeeded")
        self.assertTrue(
            self.container.db.finish_crawl_address_if_terminal("address-api-rerun")
        )
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.json()["status"], "succeeded")

        rerun = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(rerun.status_code, 202, rerun.text)
        payload = rerun.json()
        self.assertEqual(payload["requeued_task_count"], 0)
        self.assertEqual(payload["replanned_address_count"], 1)
        self.assertFalse(payload["requeue_succeeded"])
        self.assertEqual(payload["batch"]["status"], "running")
        self.assertEqual(
            payload["batch"]["sources"][0]["addresses"][0]["status"], "pending"
        )
        # Succeeded task untouched -> idempotent re-planning will skip it (no re-download).
        self.assertEqual(
            self.container.db.get_task("api-rerun-task")["status"], "succeeded"
        )

    def test_rerun_endpoint_rejects_running_and_missing_batch(self):
        missing = self.client.post(
            "/api/v1/crawls/does-not-exist/rerun", headers=self.headers, json={}
        )
        self.assertEqual(missing.status_code, 404, missing.text)
        self.assertEqual(missing.json()["error"]["code"], "crawl_not_found")

        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist_name"}
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        rerun = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(rerun.status_code, 409, rerun.text)
        self.assertEqual(rerun.json()["error"]["code"], "crawl_not_finished")

    def test_rerun_endpoint_blocks_in_flight_review_only(self):
        root = Path(self.temp.name)
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-rerun-review",
                "output_dir": str(root / "batch-api-rerun-review"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-rerun-review",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/13/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(
            self.container.db.begin_crawl_address_planning("address-api-rerun-review")
        )
        self.container.db.fail_crawl_address("address-api-rerun-review", "planning blew up")
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        # A review whose analysis is running actively scans the batch dir; re-crawling
        # would race it, so the endpoint must block with 409 review_in_progress.
        with self.container.db._transaction() as conn:
            conn.execute(
                """
                INSERT INTO crawl_reviews(batch_id, status, created_at, updated_at)
                VALUES (?, 'analyzing', 1, 1)
                """,
                (batch_id,),
            )
        blocked = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(blocked.json()["error"]["code"], "review_in_progress")

        # A stale finished review (ready) does not touch files and must not block.
        with self.container.db._transaction() as conn:
            conn.execute(
                "UPDATE crawl_reviews SET status='ready' WHERE batch_id=?",
                (batch_id,),
            )
        allowed = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(allowed.status_code, 202, allowed.text)
        self.assertEqual(allowed.json()["batch"]["status"], "running")

    def test_rerun_incremental_replan_skips_succeeded_and_links_new_unit(self):
        import asyncio

        plan_state = {"units": []}

        async def fake_plan(address, *, batch_id, policy, max_tasks):
            return list(plan_state["units"]), 0

        unit_a = CrawlUnit(
            url="https://danbooru.donmai.us/posts/1",
            site="danbooru",
            kind="post",
            source_id="danbooru:1",
        )
        unit_new = CrawlUnit(
            url="https://danbooru.donmai.us/posts/2",
            site="danbooru",
            kind="post",
            source_id="danbooru:2",
        )

        create = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [{"url": "https://danbooru.donmai.us/posts?tags=a"}],
                    }
                ],
                "proxy_mode": "direct",
                "max_tasks": 10,
            },
        )
        self.assertEqual(create.status_code, 202, create.text)
        batch_id = create.json()["id"]

        with patch.object(self.container.ordered_crawls, "_plan_address", new=fake_plan):
            # Initial crawl: one unit -> one task, which succeeds.
            plan_state["units"] = [unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            tasks = self.container.db.list_crawl_tasks(batch_id)
            self.assertEqual(len(tasks), 1)
            task_a_id = tasks[0]["id"]
            self.container.db.complete_task(task_a_id, "succeeded")
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            self.assertEqual(
                self.container.db.get_crawl_batch(batch_id)["status"], "succeeded"
            )
            address_id = self.container.db.get_crawl_batch(batch_id)["sources"][0][
                "addresses"
            ][0]["id"]

            # (a) Rerun re-discovering the SAME unit: idempotent skip, zero new tasks and
            # zero requeued; the succeeded task stays succeeded.
            rerun_a = self.client.post(
                f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
            )
            self.assertEqual(rerun_a.status_code, 202, rerun_a.text)
            self.assertEqual(rerun_a.json()["requeued_task_count"], 0)
            plan_state["units"] = [unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            after_a = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(after_a["status"], "succeeded")
            self.assertEqual(
                after_a["sources"][0]["addresses"][0]["status"], "succeeded"
            )
            self.assertEqual(len(self.container.db.list_crawl_tasks(batch_id)), 1)
            self.assertEqual(
                self.container.db.get_task(task_a_id)["status"], "succeeded"
            )

            # (b) Rerun re-discovering a SUPERSET with a NEW unit PREPENDED. The new unit
            # requests sequence_no=1, already owned by the succeeded task, forcing the
            # collision the Part 1 fix handles: exactly one new task is created AND linked
            # (INSERT OR IGNORE would have silently dropped it).
            rerun_b = self.client.post(
                f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
            )
            self.assertEqual(rerun_b.status_code, 202, rerun_b.text)
            plan_state["units"] = [unit_new, unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            linked = self.container.db.crawl_address_tasks(address_id)
            self.assertEqual(len(linked), 2)
            new_ids = [task["id"] for task in linked if task["id"] != task_a_id]
            self.assertEqual(len(new_ids), 1)
            new_task_id = new_ids[0]
            self.assertEqual(
                self.container.db.get_task(new_task_id)["url"],
                "https://danbooru.donmai.us/posts/2",
            )

            # The address completes once the single new task finishes.
            self.container.db.complete_task(new_task_id, "succeeded")
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            final = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(final["status"], "succeeded")
            self.assertEqual(final["sources"][0]["addresses"][0]["status"], "succeeded")
            self.assertEqual(final["task_count"], 2)


if __name__ == "__main__":
    unittest.main()
