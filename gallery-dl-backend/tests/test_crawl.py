from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

from gdl_backend.crawl import CrawlPlanError, CrawlPlanner, _parse_eh_index
from gdl_backend.schemas import SitePolicy


class _FakeEHResponse:
    """Minimal stand-in for requests.Response used by the EH gallery fetch loop."""

    def __init__(self, *, status_code=200, headers=None, text="", content=None):
        self.status_code = status_code
        self.headers = dict(headers or {})
        self.text = text
        self.content = content if content is not None else text.encode("utf-8")

    def raise_for_status(self):
        if 400 <= self.status_code:
            raise requests.HTTPError(f"{self.status_code} error")


class CrawlPlannerTests(unittest.TestCase):
    def test_media_planning_is_the_only_address_execution_mode(self):
        planner = CrawlPlanner(object())  # Proxy is only used by EH gallery planning.
        policy = SitePolicy(proxy_mode="direct")
        items = [
            {
                "id": "pixiv-1",
                "site": "pixiv",
                "kind": "work",
                "url": "https://www.pixiv.net/artworks/1",
                "media_count": 3,
            },
            {
                "id": "danbooru-2",
                "site": "danbooru",
                "kind": "post",
                "url": "https://danbooru.donmai.us/posts/2",
                "source_url": "https://twitter.com/artist/status/22",
                "media_count": 1,
            },
        ]
        units, proxies = asyncio.run(
            planner.plan_media(
                items,
                policy=policy,
                proxy_mode="direct",
                cookies_file=None,
                max_tasks=10,
            )
        )
        self.assertEqual(len(units), 4)
        self.assertEqual(units[0].extra_args, ["--range", "1"])
        self.assertEqual(units[2].extra_args, ["--range", "3"])
        self.assertEqual(units[3].extra_args, [])
        self.assertEqual([unit.source_key for unit in units[:3]], ["pixiv:1"] * 3)
        self.assertEqual(units[3].source_key, "twitter:22")
        self.assertEqual(units[3].source_url, "https://twitter.com/artist/status/22")
        self.assertEqual(proxies, [])

        with self.assertRaises(CrawlPlanError):
            asyncio.run(
                planner.plan_media(
                    items,
                    policy=policy,
                    proxy_mode="direct",
                    cookies_file=None,
                    max_tasks=2,
                )
            )

    def test_twitter_media_urls_bypass_status_page_ranges(self):
        planner = CrawlPlanner(object())
        media_urls = [
            "https://pbs.twimg.com/media/sample?format=jpg&name=orig",
            "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/sample.mp4?tag=12",
            "https://pbs.twimg.com/media/unexpected?format=jpg&name=orig",
        ]
        units, _proxies = asyncio.run(
            planner.plan_media(
                [
                    {
                        "id": "123",
                        "site": "twitter",
                        "kind": "work",
                        "download_url": "https://x.com/example/status/123",
                        "media_count": 2,
                        "media_urls": media_urls,
                        "extra_args": ["--sleep", "0"],
                    }
                ],
                policy=SitePolicy(proxy_mode="direct"),
                proxy_mode="direct",
                cookies_file=None,
                max_tasks=10,
            )
        )
        self.assertEqual([unit.url for unit in units], media_urls[:2])
        self.assertEqual([unit.source_id for unit in units], ["123:1", "123:2"])
        self.assertEqual([unit.extra_args for unit in units], [["--sleep", "0"]] * 2)
        self.assertTrue(all("--range" not in unit.extra_args for unit in units))

        fallback, _proxies = asyncio.run(
            planner.plan_media(
                [
                    {
                        "id": "partial",
                        "site": "twitter",
                        "url": "https://x.com/example/status/456",
                        "media_count": 2,
                        "media_urls": media_urls[:1],
                    }
                ],
                policy=SitePolicy(proxy_mode="direct"),
                proxy_mode="direct",
                cookies_file=None,
                max_tasks=10,
            )
        )
        self.assertEqual(
            [unit.extra_args for unit in fallback],
            [["--range", "1"], ["--range", "2"]],
        )

    def test_eh_index_parser(self):
        page = """
        <h1 id="gn">A &amp; B</h1>
        <table><tr><td>Length:</td><td class="gdt2">2 pages</td></tr></table>
        <a href="https://e-hentai.org/s/aaaaaaaaaa/123-1">1</a>
        <a href="https://e-hentai.org/s/bbbbbbbbbb/123-2">2</a>
        """
        title, total, links = _parse_eh_index(
            page,
            "https://e-hentai.org/g/123/cccccccccc/",
            123,
        )
        self.assertEqual(title, "A & B")
        self.assertEqual(total, 2)
        self.assertEqual(sorted(links), [1, 2])

    def test_eh_blank_page_is_authentication_and_invalidates_credentials(self):
        # ExHentai signals an expired/invalid login with a BLANK PAGE:
        # HTTP 200, empty body, and no Cache-Control response header (mirrors
        # gallery_dl/extractor/exhentai.py ExhentaiExtractor.request). This must
        # surface as an authentication failure AND fire the auth_failure_callback,
        # not fall through to the generic "缺少标题或图片总数" ValueError.
        callback_calls: list[tuple] = []

        async def auth_failure_callback(site, cookies_file, error):
            callback_calls.append((site, cookies_file, error))
            return True

        planner = CrawlPlanner(object(), auth_failure_callback=auth_failure_callback)
        policy = SitePolicy(proxy_mode="direct", retry_limit=2, backoff_base_seconds=0.0)

        blank = _FakeEHResponse(status_code=200, headers={}, content=b"", text="")

        with tempfile.TemporaryDirectory() as tmp:
            cookies_path = Path(tmp) / "eh-cookies.txt"
            cookies_path.write_text(
                "# Netscape HTTP Cookie File\n"
                ".exhentai.org\tTRUE\t/\tTRUE\t0\tipb_member_id\t123\n"
                ".exhentai.org\tTRUE\t/\tTRUE\t0\tipb_pass_hash\tdeadbeefff\n",
                encoding="utf-8",
            )

            with mock.patch.object(requests.Session, "get", return_value=blank):
                with self.assertRaises(CrawlPlanError) as ctx:
                    asyncio.run(
                        planner.plan_media(
                            [
                                {
                                    "id": "eh-1",
                                    "site": "exhentai",
                                    "url": "https://exhentai.org/g/123/abcdef0123/",
                                }
                            ],
                            policy=policy,
                            proxy_mode="direct",
                            cookies_file=str(cookies_path),
                            max_tasks=100,
                        )
                    )

            self.assertEqual(ctx.exception.code, "authentication")
            self.assertNotIn("insufficient privileges to access this resource", ctx.exception.message)
            self.assertEqual(len(callback_calls), 1)
            self.assertEqual(callback_calls[0][0], "exhentai")
            self.assertEqual(callback_calls[0][1], str(cookies_path))

    def test_eh_gallery_with_content_plans_media_units(self):
        # A normal logged-in gallery page (HTTP 200, real HTML, with Cache-Control)
        # must still plan one media unit per image.
        page = """
        <h1 id="gn">Sample Gallery</h1>
        <table><tr><td>Length:</td><td class="gdt2">2 pages</td></tr></table>
        <a href="https://exhentai.org/s/aaaaaaaaaa/123-1">1</a>
        <a href="https://exhentai.org/s/bbbbbbbbbb/123-2">2</a>
        """
        ok = _FakeEHResponse(
            status_code=200,
            headers={"Cache-Control": "private, no-cache"},
            text=page,
        )

        planner = CrawlPlanner(object())
        policy = SitePolicy(proxy_mode="direct")

        with mock.patch.object(requests.Session, "get", return_value=ok):
            units, proxies = asyncio.run(
                planner.plan_media(
                    [
                        {
                            "id": "eh-ok",
                            "site": "exhentai",
                            "url": "https://exhentai.org/g/123/cccccccccc/",
                        }
                    ],
                    policy=policy,
                    proxy_mode="direct",
                    cookies_file=None,
                    max_tasks=100,
                )
            )

        self.assertEqual(len(units), 2)
        self.assertEqual([unit.source_id for unit in units], ["123:1", "123:2"])
        self.assertEqual([unit.site for unit in units], ["exhentai", "exhentai"])
        self.assertEqual([unit.extra_args for unit in units], [["--range", "1"], ["--range", "1"]])
        self.assertEqual(len(proxies), 1)
        self.assertEqual(proxies[0]["title"], "Sample Gallery")


if __name__ == "__main__":
    unittest.main()
