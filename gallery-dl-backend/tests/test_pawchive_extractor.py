from __future__ import annotations

import sys
import unittest

from tests.helpers import WORKSPACE

GALLERY_ROOT = WORKSPACE / "gallery-dl-codeberg"


def _gallery_extractor():
    repo = str(GALLERY_ROOT)
    if repo not in sys.path:
        sys.path.insert(0, repo)
    import gallery_dl.extractor

    return gallery_dl.extractor


class PawchiveResolutionTests(unittest.TestCase):
    """The vendored gallery-dl ships pawchive support; nothing is patched in."""

    def test_url_patterns_resolve_to_upstream_pawchive_classes(self):
        module = _gallery_extractor()
        cases = {
            "https://pawchive.pw/fanbox/user/123": "PawchiveUserExtractor",
            "https://pawchive.st/patreon/user/1/post/2": "PawchivePostExtractor",
            "https://pawchive.pw/posts?q=x": "PawchivePostsExtractor",
            "https://pawchive.pw/artists?q=x": "PawchiveArtistsExtractor",
            "https://pawchive.pw/account/favorites?type=artist": (
                "PawchiveFavoriteExtractor"
            ),
        }
        for url, expected in cases.items():
            extractor = module.find(url)
            self.assertIsNotNone(extractor, url)
            self.assertEqual(type(extractor).__name__, expected)
            self.assertEqual(extractor.category, "pawchive")
            self.assertEqual(
                type(extractor).__module__, "gallery_dl.extractor.pawchive"
            )
        kemono = module.find("https://kemono.cr/fanbox/user/123")
        self.assertEqual(type(kemono).__name__, "KemonoUserExtractor")
        self.assertEqual(kemono.category, "kemono")

    def test_site_resolver_reports_pawchive(self):
        from gdl_backend.site import SiteResolver

        resolver = SiteResolver(GALLERY_ROOT)
        info = resolver.resolve("https://pawchive.pw/fanbox/user/75317652")
        self.assertTrue(info.supported)
        self.assertEqual(info.site, "pawchive")
        self.assertEqual(info.subcategory, "fanbox")


class PawchiveItemsTests(unittest.TestCase):
    """Offline behavior of the upstream extractor on canned post data."""

    def _post_extractor(self, post):
        module = _gallery_extractor()
        from gallery_dl import config

        config.set(("extractor", "pawchive"), "metadata", False)
        self.addCleanup(config.clear)
        extractor = module.find(
            f"https://pawchive.pw/{post['service']}/user/{post['user']}"
            f"/post/{post['id']}"
        )
        extractor.initialize()
        extractor.posts = lambda: (post,)
        return extractor

    def test_items_uses_file_server_and_skips_deferred_attachments(self):
        post = {
            "id": "12311822",
            "user": "75317652",
            "service": "fanbox",
            "title": "sample",
            "content": "",
            "published": "2026-01-01T00:00:00",
            "file": {"name": "cover.jpeg", "path": "/2b/81/" + "a" * 64 + ".jpeg"},
            "attachments": [
                {"name": "one.png", "path": "/22/fa/" + "b" * 64 + ".png"},
                {"name": "deferred.png", "deferred": True},
            ],
        }
        extractor = self._post_extractor(post)
        from gallery_dl.extractor.message import Message

        urls = []
        count = None
        for message in extractor:
            if message[0] is Message.Directory:
                count = message[2].get("count")
            elif message[0] is Message.Url:
                urls.append((message[1], message[2].get("url")))
        self.assertEqual(count, 2)
        self.assertEqual(len(urls), 2)
        for download_url, metadata_url in urls:
            self.assertTrue(
                download_url.startswith("https://file.pawchive.pw/data/"),
                download_url,
            )
            self.assertEqual(download_url, metadata_url)


if __name__ == "__main__":
    unittest.main()
