from __future__ import annotations

import asyncio
import json
import os
import requests
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from gdl_backend.discovery import (
    DiscoveryService,
    DiscoveryError,
    canonical_gallery_address,
    classify_external_profile,
    danbooru_alias_terms,
    discovery_addresses,
    exhentai_tag_facets,
    merge_alias_search_results,
    parse_discovery_output,
    search_site,
    validate_discovery_args,
)
from gdl_backend.gallery import GalleryCaptureResult, GalleryRunner
from gdl_backend.proxy import ProxyLease
from gdl_backend.schemas import SitePolicy
from tests.helpers import make_settings


class _FakeGallery:
    def __init__(self, stdout: str):
        self.stdout = stdout
        self.calls = []

    async def capture(self, operation_id, **kwargs):
        self.calls.append((operation_id, kwargs))
        return GalleryCaptureResult(0, self.stdout, "", False, "marker", 123)


class _FakeProxy:
    def __init__(self):
        self.acquired = []
        self.released = []

    def acquire(self, task_id, **kwargs):
        self.acquired.append((task_id, kwargs))
        return ProxyLease(
            task_id=task_id,
            node_id="node-1",
            endpoint="http://127.0.0.1:29001",
            name="JP-1",
            protocol="trojan",
            tags=["jp"],
            acquired_at=1.0,
        )

    def release(self, task_id, **kwargs):
        self.released.append((task_id, kwargs))


class _SequenceGallery:
    def __init__(self, stdout_sequence: list[str]):
        self.stdout_sequence = list(stdout_sequence)
        self.calls = []

    async def capture(self, operation_id, **kwargs):
        self.calls.append((operation_id, kwargs))
        stdout = self.stdout_sequence[len(self.calls) - 1]
        return GalleryCaptureResult(0, stdout, "", False, "marker", 123)


class _RotatingFakeProxy:
    def __init__(self, count: int = 2):
        self.nodes = [f"node-{index}" for index in range(1, count + 1)]
        self.acquired = []
        self.released = []

    def acquire(self, task_id, **kwargs):
        excluded = set(kwargs.get("exclude_ids") or set())
        recorded = {**kwargs, "exclude_ids": excluded}
        self.acquired.append((task_id, recorded))
        node_id = next((item for item in self.nodes if item not in excluded), None)
        if node_id is None:
            return None
        index = self.nodes.index(node_id) + 1
        return ProxyLease(
            task_id=task_id,
            node_id=node_id,
            endpoint=f"http://127.0.0.1:{29000 + index}",
            name=f"fixture-node-{index}",
            protocol="http",
            tags=["fixture"],
            acquired_at=1.0,
        )

    def release(self, task_id, **kwargs):
        self.released.append((task_id, kwargs))


class _FakeProcess:
    def __init__(self, stdout: bytes, stderr: bytes = b""):
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.pid = 123
        self.returncode = None

    async def wait(self):
        self.returncode = 0
        return 0


class DiscoveryParserTests(unittest.TestCase):
    def test_site_aliases_and_search_urls(self):
        self.assertEqual(search_site("x").site, "twitter")
        self.assertEqual(search_site("eh").site, "exhentai")
        self.assertIn("q=clover+days", search_site("twitter").search_url("clover days"))
        self.assertIn("tags=clover_days", search_site("danbooru").search_url("clover_days"))
        self.assertIn("f_search=clover+days", search_site("exhentai").search_url("clover days"))
        with self.assertRaises(ValueError):
            search_site("pixiv").search_url("clover days")

    def test_pawchive_search_url_and_canonical_addresses(self):
        self.assertEqual(search_site("pawchive").site, "pawchive")
        self.assertIn("q=maplestar", search_site("pawchive").search_url("maplestar"))
        from gdl_backend.discovery import canonical_gallery_address

        self.assertEqual(
            canonical_gallery_address(
                "pawchive", "https://www.pawchive.st/patreon/user/3295915/?o=50"
            ),
            "https://pawchive.pw/patreon/user/3295915",
        )
        self.assertEqual(
            canonical_gallery_address(
                "pawchive", "https://pawchive.pw/fanbox/user/1/post/2"
            ),
            "https://pawchive.pw/fanbox/user/1/post/2",
        )

    def test_danbooru_autocomplete_normalizes_rows(self):
        rows = [
            {
                "type": "tag-other-name",
                "label": "ningmeng jing jing jing jing",
                "value": "ningmeng_jing_jing_jing_jing",
                "category": 1,
                "post_count": 255,
                "antecedent": "柠檬静静静静",
            },
            {
                "type": "tag",
                "label": "lemon",
                "value": "lemon",
                "category": 0,
                "post_count": 40000,
            },
            {"type": "tag", "value": "", "category": 1},
            "not-a-dict",
        ]
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch.object(
                service,
                "_danbooru_api_json",
                new=AsyncMock(return_value=(rows, {"used": False}, 1)),
            ) as api_mock:
                result = asyncio.run(
                    service.danbooru_autocomplete(
                        "柠檬静",
                        limit=50,
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                    )
                )
        self.assertEqual(result["query"], "柠檬静")
        self.assertEqual(len(result["items"]), 2)
        first = result["items"][0]
        self.assertEqual(first["value"], "ningmeng_jing_jing_jing_jing")
        self.assertEqual(first["category"], "artist")
        self.assertEqual(first["antecedent"], "柠檬静静静静")
        self.assertEqual(first["match_type"], "tag-other-name")
        self.assertEqual(result["items"][1]["category"], "general")
        params = api_mock.await_args.kwargs["params"]
        self.assertEqual(params["search[query]"], "柠檬静")
        self.assertEqual(params["search[type]"], "tag_query")
        self.assertEqual(params["limit"], 20)

    def test_danbooru_alias_terms_only_exact_identity_matches(self):
        artist_result = {
            "authors": [
                {
                    # Primary name matches the keyword: other_names become
                    # aliases; the keyword-equivalent variant is dropped.
                    "name": "rocket_punch",
                    "other_names": ["ろけっとぱんち", "Rocket-Punch"],
                },
                {
                    # Wildcard substring hit only — must not leak aliases.
                    "name": "rocketeer",
                    "other_names": ["rocket puncher"],
                },
                {
                    # Keyword appears in other_names: primary name and the
                    # remaining aliases become search terms.
                    "name": "someone",
                    "other_names": ["Rocket Punch", "別名"],
                },
            ]
        }
        # Non-ASCII aliases sort first: they match EH/Fanbox naming habits.
        self.assertEqual(
            danbooru_alias_terms(artist_result, "rocket punch"),
            ["ろけっとぱんち", "別名", "someone"],
        )
        self.assertEqual(
            danbooru_alias_terms(artist_result, "rocket punch", cap=2),
            ["ろけっとぱんち", "別名"],
        )
        self.assertEqual(danbooru_alias_terms(artist_result, ""), [])
        self.assertEqual(danbooru_alias_terms(None, "rocket punch"), [])
        self.assertEqual(danbooru_alias_terms({"authors": []}, "rocket punch"), [])

    def test_danbooru_alias_terms_accepts_group_name_hits(self):
        # Danbooru's exact any_name_matches also matches circle/group names
        # (e.g. 毛玉牛乳 is kedama_milk's group_name, absent from other_names).
        artist_result = {
            "authors": [
                {
                    "name": "kedama_milk",
                    # 毛 must be dropped: single-character aliases only add
                    # site-search noise.
                    "other_names": ["けだま", "毛"],
                    "group_name": "毛玉牛乳",
                }
            ]
        }
        self.assertEqual(
            danbooru_alias_terms(artist_result, "毛玉牛乳"),
            ["けだま", "kedama milk"],
        )

    def test_merge_alias_search_results_dedupes_and_tracks_terms(self):
        primary = {
            "site": "exhentai",
            "keyword": "wlop",
            "search_url": "https://e-hentai.org/?f_search=wlop",
            "candidates": [
                {"id": "100", "title": "A"},
                {"id": "200", "title": "B"},
            ],
            "authors": [{"name": "wlop", "works_url": "https://x/1"}],
            "attempts": 1,
        }
        alias_result = {
            "candidates": [
                {"id": "200", "title": "B"},
                {"id": "300", "title": "C"},
            ],
            "authors": [
                {"name": "wlop", "works_url": "https://x/1"},
                {"name": "王凌", "works_url": "https://x/2"},
            ],
            "attempts": 2,
        }
        merged = merge_alias_search_results(
            "wlop", primary, [("王凌", alias_result)], limit=10
        )
        self.assertEqual(
            [item["id"] for item in merged["candidates"]], ["100", "200", "300"]
        )
        self.assertEqual(merged["candidates"][0]["matched_keywords"], ["wlop"])
        self.assertEqual(merged["candidates"][1]["matched_keywords"], ["wlop", "王凌"])
        self.assertEqual(merged["candidates"][2]["matched_keywords"], ["王凌"])
        self.assertEqual(merged["candidate_count"], 3)
        self.assertEqual(len(merged["authors"]), 2)
        self.assertEqual(merged["attempts"], 3)
        self.assertEqual(merged["alias_keywords"], ["王凌"])
        self.assertEqual(merged["search_url"], primary["search_url"])
        # Primary hits stay first when the limit truncates alias-only hits.
        truncated = merge_alias_search_results(
            "wlop", primary, [("王凌", alias_result)], limit=2
        )
        self.assertEqual(
            [item["id"] for item in truncated["candidates"]], ["100", "200"]
        )
        self.assertEqual(truncated["candidate_count"], 2)

    def test_exhentai_alias_addresses_tag_alias_evidence(self):
        result = {
            "alias_keywords": ["王凌"],
            "candidates": [
                {
                    "id": "100",
                    "title": "Direct + alias hit",
                    "url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "download_url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "matched_keywords": ["wlop", "王凌"],
                },
                {
                    "id": "200",
                    "title": "Alias-only hit",
                    "url": "https://e-hentai.org/g/200/bbbbbbbbbb/",
                    "download_url": "https://e-hentai.org/g/200/bbbbbbbbbb/",
                    "matched_keywords": ["王凌"],
                },
                {
                    "id": "300",
                    "title": "Plain search without alias metadata",
                    "url": "https://e-hentai.org/g/300/cccccccccc/",
                    "download_url": "https://e-hentai.org/g/300/cccccccccc/",
                },
            ],
        }
        addresses = discovery_addresses(
            "exhentai", result, keyword="wlop", limit=10
        )
        by_id = {address["id"]: address for address in addresses}
        self.assertEqual(
            by_id["exhentai:gallery:100"]["evidence_reasons"],
            ["keyword_gallery_search", "danbooru_alias_search"],
        )
        self.assertEqual(
            by_id["exhentai:gallery:200"]["evidence_reasons"],
            ["danbooru_alias_search"],
        )
        self.assertEqual(
            by_id["exhentai:gallery:200"]["matched_keywords"], ["王凌"]
        )
        self.assertEqual(
            by_id["exhentai:gallery:300"]["evidence_reasons"],
            ["keyword_gallery_search"],
        )
        self.assertNotIn("matched_keywords", by_id["exhentai:gallery:300"])

    def test_pawchive_alias_name_match_is_verified(self):
        result = {
            "alias_keywords": ["ろけっとぱんち"],
            "candidates": [
                {
                    "id": "patreon:1",
                    "site": "pawchive",
                    "kind": "account",
                    "title": "ろけっとぱんち",
                    "url": "https://pawchive.pw/patreon/user/1",
                    "download_url": "https://pawchive.pw/patreon/user/1",
                    "matched_keywords": ["ろけっとぱんち"],
                    "metadata": {"service": "patreon"},
                },
                {
                    "id": "patreon:2",
                    "site": "pawchive",
                    "kind": "account",
                    "title": "unrelated creator",
                    "url": "https://pawchive.pw/patreon/user/2",
                    "download_url": "https://pawchive.pw/patreon/user/2",
                    "metadata": {"service": "patreon"},
                },
            ],
        }
        addresses = discovery_addresses(
            "pawchive", result, keyword="rocket punch", limit=10
        )
        self.assertEqual(len(addresses), 2)
        alias_hit = addresses[0]
        self.assertEqual(alias_hit["confidence"], "verified")
        self.assertEqual(
            alias_hit["evidence_reasons"], ["danbooru_alias_name_match"]
        )
        self.assertEqual(alias_hit["matched_keywords"], ["ろけっとぱんち"])
        self.assertEqual(addresses[1]["confidence"], "site_search")
        self.assertEqual(
            addresses[1]["evidence_reasons"], ["keyword_creator_search"]
        )

    def test_pawchive_creator_search_yields_verified_account_addresses(self):
        payload = [
            [
                6,
                "https://pawchive.pw/patreon/user/3295915",
                {
                    "id": "3295915",
                    "name": "Maplestar",
                    "service": "patreon",
                    "favorited": 23385,
                    "updated": 1784946978,
                    "ever_imported": True,
                },
            ],
            [
                6,
                "https://pawchive.pw/fanbox/user/999",
                {
                    "id": "999",
                    "name": "maplestar fanclub",
                    "service": "fanbox",
                    "favorited": 3,
                    "updated": 1,
                    "ever_imported": True,
                },
            ],
        ]
        candidates, authors = parse_discovery_output(
            "pawchive",
            json.dumps(payload),
            source_url="https://pawchive.pw/artists?q=maplestar",
            limit=20,
        )
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]["kind"], "account")
        self.assertEqual(
            candidates[0]["thumbnail_url"],
            "https://pawchive.pw/icons/patreon/3295915",
        )
        self.assertEqual(candidates[0]["metadata"]["service"], "patreon")
        addresses = discovery_addresses(
            "pawchive",
            {"candidates": candidates, "authors": authors},
            keyword="maplestar",
            limit=20,
        )
        self.assertEqual(len(addresses), 2)
        exact = addresses[0]
        self.assertEqual(exact["id"], "pawchive:account:patreon:3295915")
        self.assertEqual(exact["url"], "https://pawchive.pw/patreon/user/3295915")
        self.assertEqual(exact["confidence"], "verified")
        self.assertEqual(exact["evidence_reasons"], ["account_name_exact_match"])
        partial = addresses[1]
        self.assertEqual(partial["confidence"], "site_search")
        self.assertEqual(partial["evidence_reasons"], ["keyword_creator_search"])

    def test_pawchive_post_candidates_carry_media_counts_and_thumbnails(self):
        payload = [
            [
                2,
                {
                    "id": "162543314",
                    "user": "3295915",
                    "service": "patreon",
                    "title": "June Update",
                    "username": "Maplestar",
                    "published": "2026-06-30T00:00:00",
                    "count": 6,
                },
            ],
            [
                3,
                "https://file.pawchive.pw/data/70/b6/70b6ffff.png",
                {"id": "162543314", "num": 1},
            ],
            [
                2,
                {
                    "id": "159892657",
                    "user": "3295915",
                    "service": "patreon",
                    "title": "All deferred",
                    "count": 0,
                },
            ],
        ]
        candidates, authors = parse_discovery_output(
            "pawchive",
            json.dumps(payload),
            source_url="https://pawchive.pw/patreon/user/3295915",
            limit=20,
        )
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["kind"], "post")
        self.assertEqual(candidate["media_count"], 6)
        self.assertEqual(
            candidate["url"],
            "https://pawchive.pw/patreon/user/3295915/post/162543314",
        )
        self.assertEqual(
            candidate["thumbnail_url"],
            "https://img.pawchive.pw/thumbnail/data/70/b6/70b6ffff.png",
        )
        self.assertEqual(authors[0]["works_url"], "https://pawchive.pw/patreon/user/3295915")

    def test_exhentai_tag_facets_follow_official_namespaces(self):
        facets = exhentai_tag_facets(
            [
                {
                    "metadata": {
                        "tags": [
                            "artist:Ogipote",
                            "a:ogipote",
                            "language:english",
                            "m:glasses",
                            "temporary tag",
                            "custom:value",
                        ]
                    }
                },
                {
                    "metadata": {
                        "tags": ["artist:ogipote", "language:japanese"]
                    }
                },
            ]
        )
        self.assertEqual(
            [facet["namespace"] for facet in facets],
            ["artist", "language", "male", "temp", "unknown"],
        )
        artist = facets[0]
        self.assertEqual(artist["gallery_count"], 2)
        self.assertEqual(artist["tags"][0]["count"], 2)
        self.assertEqual(artist["tags"][0]["tag"].lower(), "artist:ogipote")
        language = facets[1]
        self.assertEqual(language["tag_count"], 2)
        self.assertEqual(facets[2]["tags"][0]["tag"], "male:glasses")
        self.assertEqual(facets[3]["tags"][0]["tag"], "temp:temporary tag")
        self.assertEqual(facets[4]["label"], "未识别命名空间")

    def test_twitter_candidates_and_authors(self):
        payload = [
            [
                2,
                {
                    "tweet_id": 123456789,
                    "content": "sample post",
                    "count": 2,
                    "author": {"id": 42, "name": "artist", "nick": "Artist"},
                    "favorite_count": 10,
                    "hashtags": ["art"],
                },
            ],
            [
                3,
                "https://pbs.twimg.com/media/sample?format=jpg&name=orig",
                {"tweet_id": 123456789, "num": 1},
            ],
            [
                3,
                "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/sample.mp4?tag=12",
                {"tweet_id": 123456789, "num": 2},
            ],
        ]
        candidates, authors = parse_discovery_output(
            "twitter",
            json.dumps(payload),
            source_url="https://x.com/search?q=sample",
            limit=20,
        )
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["url"], "https://x.com/artist/status/123456789")
        self.assertEqual(candidates[0]["media_count"], 2)
        self.assertEqual(
            candidates[0]["thumbnail_url"],
            "https://pbs.twimg.com/media/sample?format=jpg&name=orig",
        )
        self.assertEqual(
            candidates[0]["media_urls"],
            [
                "https://pbs.twimg.com/media/sample?format=jpg&name=orig",
                "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/sample.mp4?tag=12",
            ],
        )
        self.assertEqual(authors[0]["works_url"], "https://x.com/artist/media")

    def test_twitter_author_deduplication_is_case_insensitive(self):
        payload = [
            [
                2,
                {
                    "tweet_id": 1,
                    "count": 1,
                    "author": {"name": "Artist_Name", "nick": "Artist"},
                },
            ],
            [
                2,
                {
                    "tweet_id": 2,
                    "count": 1,
                    "author": {"name": "artist_name", "nick": "Artist"},
                },
            ],
        ]
        candidates, authors = parse_discovery_output(
            "twitter",
            json.dumps(payload),
            source_url="https://x.com/search?q=artist",
            limit=20,
        )
        self.assertEqual(len(authors), 1)
        addresses = discovery_addresses(
            "twitter",
            {"candidates": candidates, "authors": authors},
            keyword="artist",
            limit=20,
        )
        self.assertEqual(len(addresses), 1)
        self.assertEqual(addresses[0]["url"], "https://x.com/artist_name/media")
        self.assertEqual(addresses[0]["matched_items"], 2)
        self.assertNotEqual(addresses[0]["id"], "twitter:account:")

    def test_pixiv_candidates_and_authors(self):
        payload = [
            [
                2,
                {
                    "id": 9988,
                    "title": "sample artwork",
                    "count": 3,
                    "user": {"id": 77, "account": "artist77", "name": "Artist 77"},
                    "tags": [{"name": "clover_days"}],
                    "rating": "General",
                },
            ],
            [3, "https://i.pximg.net/img-original/sample.jpg", {"id": 9988}],
        ]
        candidates, authors = parse_discovery_output(
            "pixiv",
            json.dumps(payload),
            source_url="https://www.pixiv.net/en/tags/sample/artworks",
            limit=20,
        )
        self.assertEqual(candidates[0]["url"], "https://www.pixiv.net/artworks/9988")
        self.assertEqual(candidates[0]["media_count"], 3)
        self.assertEqual(candidates[0]["metadata"]["tags"], ["clover_days"])
        self.assertEqual(authors[0]["works_url"], "https://www.pixiv.net/users/77/artworks")

    def test_danbooru_and_eh_candidates(self):
        danbooru = [
            [
                2,
                {
                    "id": 123,
                    "tags_artist": ["artist_name"],
                    "tags_copyright": ["clover_days"],
                    "preview_file_url": "https://cdn.donmai.us/preview.jpg",
                    "source": "https://www.pixiv.net/artworks/9988",
                    "rating": "g",
                },
            ]
        ]
        candidates, authors = parse_discovery_output(
            "danbooru",
            json.dumps(danbooru),
            source_url="https://danbooru.donmai.us/posts?tags=clover_days",
            limit=20,
        )
        self.assertEqual(candidates[0]["url"], "https://danbooru.donmai.us/posts/123")
        self.assertEqual(candidates[0]["source_url"], "https://www.pixiv.net/artworks/9988")
        self.assertIn("tags=artist_name", authors[0]["works_url"])

        artist_queue = [
            [
                6,
                "https://danbooru.donmai.us/posts?tags=artist_name",
                {
                    "id": 55,
                    "name": "artist_name",
                    "other_names": ["Artist Name"],
                    "group_name": "Circle",
                },
            ]
        ]
        candidates, authors = parse_discovery_output(
            "danbooru",
            json.dumps(artist_queue),
            source_url="https://danbooru.donmai.us/artists?search=x",
            limit=20,
        )
        self.assertEqual(candidates, [])
        self.assertEqual(authors[0]["id"], "55")
        self.assertEqual(authors[0]["other_names"], ["Artist Name"])

        eh = [
            [
                6,
                "https://e-hentai.org/g/1531036/91cbde3481/",
                {"gallery_id": 1531036, "gallery_token": "91cbde3481"},
            ]
        ]
        candidates, authors = parse_discovery_output(
            "exhentai",
            json.dumps(eh),
            source_url="https://e-hentai.org/?f_search=clover",
            limit=20,
        )
        self.assertEqual(candidates[0]["kind"], "gallery")
        self.assertEqual(candidates[0]["id"], "1531036")
        self.assertEqual(authors, [])
        galleries = discovery_addresses(
            "exhentai",
            {"candidates": candidates, "authors": authors},
            keyword="clover",
            limit=20,
        )
        self.assertEqual(galleries[0]["confidence"], "site_search")
        self.assertEqual(galleries[0]["evidence_reasons"], ["keyword_gallery_search"])

    def test_selectable_addresses_are_accounts_tags_and_galleries(self):
        twitter = discovery_addresses(
            "twitter",
            {
                "candidates": [
                    {
                        "author": {"id": "42"},
                        "thumbnail_url": "https://pbs.twimg.com/a.jpg",
                    }
                ],
                "authors": [
                    {
                        "id": "42",
                        "name": "artist",
                        "url": "https://x.com/artist",
                        "works_url": "https://x.com/artist/media",
                    }
                ],
            },
            keyword="artist",
            limit=20,
        )
        self.assertEqual([item["address_type"] for item in twitter], ["account"])
        self.assertEqual(twitter[0]["url"], "https://x.com/artist/media")
        self.assertEqual(twitter[0]["confidence"], "verified")
        self.assertEqual(
            twitter[0]["evidence_reasons"],
            ["site_search_work_evidence", "account_name_exact_match"],
        )

        danbooru = discovery_addresses(
            "danbooru",
            {
                "candidates": [
                    {
                        "metadata": {
                            "artists": ["artist_name"],
                            "characters": ["character_name"],
                        }
                    },
                ],
                "authors": [
                    {
                        "name": "artist_name",
                        "url": "https://danbooru.donmai.us/artists?search[name]=artist_name",
                        "works_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                    }
                ],
            },
            keyword="artist_name",
            limit=20,
        )
        self.assertEqual([item["address_type"] for item in danbooru], ["artist_tag"])
        self.assertEqual(danbooru[0]["tag"], "artist_name")
        self.assertEqual(danbooru[0]["confidence"], "verified")

        character = discovery_addresses(
            "danbooru",
            {
                "candidates": [
                    {
                        "metadata": {
                            "artists": ["unrelated_artist"],
                            "characters": ["Character_Name", "unrelated_character"],
                        }
                    }
                ],
                "authors": [],
            },
            keyword="character name",
            limit=20,
        )
        self.assertEqual([item["address_type"] for item in character], ["character_tag"])
        self.assertEqual(character[0]["tag"], "Character_Name")
        self.assertEqual(character[0]["evidence_reasons"], ["character_tag_exact_match"])

    def test_danbooru_directory_drops_unrelated_artist_results(self):
        addresses = discovery_addresses(
            "danbooru",
            {
                "candidates": [],
                "authors": [
                    {
                        "name": "other_artist",
                        "other_names": ["Someone Else"],
                        "origin": "danbooru_artist_directory",
                        "works_url": "https://danbooru.donmai.us/posts?tags=other_artist",
                    }
                ],
            },
            keyword="target_artist",
            limit=20,
        )
        self.assertEqual(addresses, [])

    def test_danbooru_directory_prefers_primary_name_over_conflicting_alias(self):
        addresses = discovery_addresses(
            "danbooru",
            {
                "candidates": [],
                "authors": [
                    {
                        "name": "rurudo",
                        "other_names": ["kajuu_aisu"],
                        "origin": "danbooru_artist_directory",
                        "works_url": "https://danbooru.donmai.us/posts?tags=rurudo",
                    },
                    {
                        "name": "kajuu_aisu",
                        "other_names": ["rurudo"],
                        "origin": "danbooru_artist_directory",
                        "works_url": "https://danbooru.donmai.us/posts?tags=kajuu_aisu",
                    },
                ],
            },
            keyword="rurudo",
            limit=20,
        )
        self.assertEqual([item["tag"] for item in addresses], ["rurudo"])
        self.assertEqual(addresses[0]["confidence"], "verified")
        self.assertEqual(
            addresses[0]["evidence_reasons"],
            ["danbooru_artist_directory_match"],
        )

    def test_danbooru_directory_alias_only_match_is_weak_evidence(self):
        addresses = discovery_addresses(
            "danbooru",
            {
                "candidates": [],
                "authors": [
                    {
                        "name": "canonical_artist",
                        "other_names": ["old_artist_name"],
                        "origin": "danbooru_artist_directory",
                        "works_url": "https://danbooru.donmai.us/posts?tags=canonical_artist",
                    }
                ],
            },
            keyword="old_artist_name",
            limit=20,
        )
        self.assertEqual([item["tag"] for item in addresses], ["canonical_artist"])
        self.assertEqual(addresses[0]["confidence"], "weak_evidence")
        self.assertEqual(
            addresses[0]["evidence_reasons"],
            ["danbooru_artist_directory_alias_match"],
        )

    def test_account_samples_require_a_real_author_identity(self):
        addresses = discovery_addresses(
            "twitter",
            {
                "candidates": [
                    {
                        "author": {"name": "first_artist"},
                        "thumbnail_url": "https://pbs.twimg.com/first.jpg",
                    },
                    {
                        "author": {"name": "second_artist"},
                        "thumbnail_url": "https://pbs.twimg.com/second.jpg",
                    },
                    {"author": {}, "thumbnail_url": "https://pbs.twimg.com/unknown.jpg"},
                ],
                "authors": [
                    {"name": "first_artist", "works_url": "https://x.com/First_Artist/media"},
                    {"name": "second_artist", "works_url": "https://x.com/Second_Artist/media"},
                ],
            },
            keyword="artist",
            limit=20,
        )
        self.assertEqual([item["matched_items"] for item in addresses], [1, 1])
        self.assertEqual([item["confidence"] for item in addresses], ["weak_evidence"] * 2)
        self.assertTrue(
            all("account_identity_unverified" in item["evidence_reasons"] for item in addresses)
        )
        self.assertEqual(len({item["id"] for item in addresses}), 2)
        self.assertTrue(all(item["id"].removeprefix("twitter:account:") for item in addresses))
        self.assertEqual(
            [item["sample_thumbnails"] for item in addresses],
            [["https://pbs.twimg.com/first.jpg"], ["https://pbs.twimg.com/second.jpg"]],
        )

    def test_danbooru_external_profile_normalization(self):
        twitter = classify_external_profile("https://x.com/artist_name")
        self.assertEqual(twitter["crawl_site"], "twitter")
        self.assertEqual(twitter["crawl_url"], "https://x.com/artist_name/media")
        numeric_twitter = classify_external_profile("https://x.com/i/user/123")
        self.assertIsNone(numeric_twitter["crawl_url"])
        pixiv = classify_external_profile("https://www.pixiv.net/users/77")
        self.assertEqual(pixiv["crawl_site"], "pixiv")
        self.assertEqual(pixiv["crawl_url"], "https://www.pixiv.net/users/77/artworks")
        self.assertEqual(
            canonical_gallery_address("x", "https://twitter.com/artist/"),
            "https://x.com/artist/media",
        )
        self.assertEqual(
            canonical_gallery_address("x", "https://X.com/Artist_Name/MEDIA"),
            "https://x.com/artist_name/media",
        )
        self.assertEqual(
            classify_external_profile("https://x.com/Artist_Name")["crawl_url"],
            "https://x.com/artist_name/media",
        )
        self.assertEqual(
            canonical_gallery_address("pixiv", "https://pixiv.net/users/77/?ref=x"),
            "https://www.pixiv.net/users/77/artworks",
        )

    def test_danbooru_artist_profile_reads_artist_urls_endpoint(self):
        class Response:
            def __init__(self, payload):
                self.payload = payload

            def raise_for_status(self):
                return None

            def json(self):
                return self.payload

        class Session:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                if url.endswith("artists.json"):
                    return Response(
                        [
                            {
                                "id": 55,
                                "name": "artist_name",
                                "other_names": ["Artist Name"],
                                "group_name": "Circle",
                            }
                        ]
                    )
                return Response(
                    [
                        {
                            "id": 99,
                            "artist_id": 55,
                            "url": "https://x.com/artist_name",
                            "is_active": True,
                        }
                    ]
                )

        session = Session()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch("gdl_backend.discovery.requests.Session", return_value=session):
                profiles, errors = asyncio.run(
                    service.danbooru_artist_profiles(
                        ["artist_name"],
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                    )
                )
        self.assertEqual(errors, [])
        self.assertEqual(profiles[0]["id"], "55")
        self.assertEqual(
            profiles[0]["related_profiles"][0]["crawl_url"],
            "https://x.com/artist_name/media",
        )
        self.assertTrue(session.calls[1][0].endswith("artist_urls.json"))

    def test_danbooru_artist_profile_rejects_non_exact_api_fallback(self):
        class Response:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return [
                    {
                        "id": 74349,
                        "name": "kajuu_aisu",
                        "other_names": ["rurudo"],
                    }
                ]

        class Session:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                if url.endswith("artist_urls.json"):
                    raise AssertionError("non-exact artist must not load artist_urls")
                return Response()

        session = Session()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch("gdl_backend.discovery.requests.Session", return_value=session):
                profiles, errors = asyncio.run(
                    service.danbooru_artist_profiles(
                        ["rurudo"],
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                    )
                )

        self.assertEqual(profiles, [])
        self.assertEqual(errors, [])
        self.assertEqual(len(session.calls), 1)

    def test_exhentai_gdata_enriches_search_titles_and_covers(self):
        class Response:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "gmetadata": [
                        {
                            "gid": 1531036,
                            "token": "91cbde3481",
                            "title": "Artist &amp; Character Collection",
                            "title_jpn": "画集",
                            "thumb": "https://ehgt.org/w/cover.webp",
                            "filecount": "42",
                            "category": "Non-H",
                            "uploader": "sample_uploader",
                            "rating": "4.50",
                            "tags": ["artist:ogipote", "character:sample"],
                        }
                    ]
                }

        class Session:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return Response()

        result = {
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "1531036",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 1531036",
                    "url": "https://e-hentai.org/g/1531036/91cbde3481/",
                    "download_url": "https://e-hentai.org/g/1531036/91cbde3481/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "author": None,
                    "metadata": {"gallery_token": "91cbde3481"},
                    "matched_keywords": ["ogipote", "おぎぽて"],
                }
            ],
            "authors": [],
        }
        session = Session()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch("gdl_backend.discovery.requests.Session", return_value=session):
                enriched = asyncio.run(
                    service.enrich_exhentai_previews(
                        result,
                        policy=SitePolicy(
                            proxy_mode="direct",
                            retry_limit=0,
                            http_timeout=10,
                        ),
                        proxy_mode="direct",
                        timeout_seconds=30,
                    )
                )

        candidate = enriched["candidates"][0]
        self.assertEqual(candidate["title"], "Artist & Character Collection")
        self.assertEqual(candidate["thumbnail_url"], "https://ehgt.org/w/cover.webp")
        self.assertEqual(candidate["media_count"], 42)
        self.assertEqual(candidate["metadata"]["tags"], ["artist:ogipote", "character:sample"])
        # Alias-expansion provenance survives the gdata rebuild.
        self.assertEqual(candidate["matched_keywords"], ["ogipote", "おぎぽて"])
        self.assertEqual(enriched["preview_count"], 1)
        self.assertEqual(enriched["preview_missing_count"], 0)
        self.assertEqual(
            session.calls[0][1]["json"]["gidlist"],
            [[1531036, "91cbde3481"]],
        )

    def test_exhentai_gdata_retries_transient_server_error(self):
        class Response:
            def __init__(self, status_code):
                self.status_code = status_code

            def raise_for_status(self):
                if self.status_code >= 400:
                    response = requests.Response()
                    response.status_code = self.status_code
                    raise requests.HTTPError(
                        f"{self.status_code} Server Error",
                        response=response,
                    )

            def json(self):
                return {
                    "gmetadata": [
                        {
                            "gid": 1531036,
                            "token": "91cbde3481",
                            "title": "Retried gallery",
                            "thumb": "https://ehgt.org/w/retried.webp",
                            "filecount": "1",
                            "tags": [],
                        }
                    ]
                }

        class Session:
            def __init__(self):
                self.headers = {}
                self.calls = 0

            def post(self, _url, **_kwargs):
                self.calls += 1
                return Response(500 if self.calls == 1 else 200)

        result = {
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "1531036",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 1531036",
                    "url": "https://e-hentai.org/g/1531036/91cbde3481/",
                    "download_url": "https://e-hentai.org/g/1531036/91cbde3481/",
                    "metadata": {"gallery_token": "91cbde3481"},
                }
            ],
            "authors": [],
        }
        session = Session()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch("gdl_backend.discovery.requests.Session", return_value=session):
                enriched = asyncio.run(
                    service.enrich_exhentai_previews(
                        result,
                        policy=SitePolicy(
                            proxy_mode="direct",
                            retry_limit=1,
                            backoff_base_seconds=0,
                        ),
                        proxy_mode="direct",
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(session.calls, 2)
        self.assertEqual(enriched["preview_count"], 1)
        self.assertEqual(enriched["candidates"][0]["title"], "Retried gallery")

    def test_exhentai_gdata_rotates_proxy_lease_per_batch(self):
        class Response:
            status_code = 200

            def __init__(self, payload):
                self.payload = payload

            def raise_for_status(self):
                return None

            def json(self):
                return self.payload

        class Session:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                gidlist = kwargs["json"]["gidlist"]
                return Response(
                    {
                        "gmetadata": [
                            {
                                "gid": gid,
                                "token": token,
                                "title": f"Gallery {gid}",
                                "thumb": f"https://ehgt.org/w/{gid}.webp",
                                "filecount": "7",
                                "tags": [],
                            }
                            for gid, token in gidlist
                        ]
                    }
                )

        class RotatingProxy:
            def __init__(self):
                self.acquired = []
                self.released = []
                self._counter = 0

            def acquire(self, task_id, **kwargs):
                self._counter += 1
                self.acquired.append((task_id, kwargs))
                index = self._counter
                return ProxyLease(
                    task_id=task_id,
                    node_id=f"node-{index}",
                    endpoint=f"http://127.0.0.1:{29000 + index}",
                    name=f"JP-{index}",
                    protocol="trojan",
                    tags=["jp"],
                    acquired_at=1.0,
                )

            def release(self, task_id, **kwargs):
                self.released.append((task_id, kwargs))

        candidates = [
            {
                "id": str(gid),
                "site": "exhentai",
                "kind": "gallery",
                "title": f"Gallery {gid}",
                "url": f"https://e-hentai.org/g/{gid}/token{gid}/",
                "download_url": f"https://e-hentai.org/g/{gid}/token{gid}/",
                "metadata": {"gallery_token": f"token{gid}"},
            }
            for gid in range(1, 31)
        ]
        result = {
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": len(candidates),
            "author_count": 0,
            "candidates": candidates,
            "authors": [],
        }
        session = Session()
        proxy = RotatingProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), proxy, Path(temporary))
            with patch("gdl_backend.discovery.requests.Session", return_value=session):
                enriched = asyncio.run(
                    service.enrich_exhentai_previews(
                        result,
                        policy=SitePolicy(
                            proxy_mode="required",
                            retry_limit=0,
                            http_timeout=10,
                            node_tags=["jp"],
                        ),
                        proxy_mode="required",
                        timeout_seconds=30,
                    )
                )

        # 30 gids => two batches (25 + 5): one POST per batch, ≤25 gids each.
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(
            [len(call[1]["json"]["gidlist"]) for call in session.calls],
            [25, 5],
        )
        # Each batch took its own lease, so consecutive batches rotate nodes.
        self.assertEqual(len(proxy.acquired), 2)
        self.assertEqual(len(proxy.released), 2)
        self.assertNotEqual(proxy.acquired[0][0], proxy.acquired[1][0])
        self.assertEqual(
            session.calls[0][1]["proxies"],
            {"http": "http://127.0.0.1:29001", "https": "http://127.0.0.1:29001"},
        )
        self.assertEqual(
            session.calls[1][1]["proxies"],
            {"http": "http://127.0.0.1:29002", "https": "http://127.0.0.1:29002"},
        )
        # Every batch's gmetadata is merged back exactly as before.
        self.assertEqual(enriched["preview_count"], 30)
        self.assertEqual(enriched["preview_missing_count"], 0)

    def test_protocol_error_after_candidate_remains_a_soft_partial_result(self):
        payload = [
            [
                6,
                "https://e-hentai.org/g/1531036/91cbde3481/",
                {"gallery_id": 1531036, "gallery_token": "91cbde3481"},
            ],
            [-1, {
                "error": "HttpError",
                "message": "SSLError: UNEXPECTED_EOF_WHILE_READING",
            }],
        ]
        candidates, authors = parse_discovery_output(
            "exhentai",
            json.dumps(payload),
            source_url="https://e-hentai.org/?f_search=ogipote",
            limit=20,
        )
        self.assertEqual([item["id"] for item in candidates], ["1531036"])
        self.assertEqual(authors, [])

    def test_protocol_errors_and_managed_args(self):
        with self.assertRaises(DiscoveryError):
            parse_discovery_output(
                "pixiv",
                json.dumps([[-1, {"error": "Auth", "message": "token expired"}]]),
                source_url="https://www.pixiv.net/en/tags/a/artworks",
                limit=20,
            )
        with self.assertRaises(ValueError):
            validate_discovery_args(["--dump-json"])
        self.assertEqual(validate_discovery_args(["--filter", "rating == 'g'"]), ["--filter", "rating == 'g'"])

    def test_search_uses_proxy_pool_lease(self):
        stdout = json.dumps(
            [
                [
                    2,
                    {
                        "id": 123,
                        "tags_artist": ["artist"],
                        "tags_copyright": ["tag"],
                    },
                ]
            ]
        )
        gallery = _FakeGallery(stdout)
        proxy = _FakeProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, proxy, Path(temporary))
            result = asyncio.run(
                service.search(
                    site="danbooru",
                    keyword="tag",
                    limit=1,
                    policy=SitePolicy(
                        proxy_mode="required",
                        retry_limit=0,
                        node_tags=["jp"],
                    ),
                    proxy_mode="required",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )
        self.assertTrue(result["proxy"]["used"])
        self.assertEqual(result["proxy"]["node_id"], "node-1")
        self.assertEqual(gallery.calls[0][1]["proxy_url"], "http://127.0.0.1:29001")
        self.assertEqual(proxy.acquired[0][1]["node_tags"], ["jp"])
        self.assertFalse(proxy.released[0][1]["proxy_fault"])

    def test_pixiv_discovery_emits_only_the_first_media_per_work(self):
        stdout = json.dumps(
            [
                [
                    2,
                    {
                        "id": 123,
                        "title": "multi-page",
                        "count": 53,
                        "user": {"id": 77, "account": "artist", "name": "Artist"},
                    },
                ],
                [3, "https://i.pximg.net/example_p0.png", {"id": 123, "num": 0}],
            ]
        )
        gallery = _FakeGallery(stdout)
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, _FakeProxy(), Path(temporary))
            result = asyncio.run(
                service.discover_url(
                    site="pixiv",
                    url="https://www.pixiv.net/users/77/artworks",
                    keyword=None,
                    limit=5,
                    range_kind=None,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=["--filter", "rating == 'g'"],
                    timeout_seconds=30,
                )
            )
        self.assertEqual(result["candidates"][0]["media_count"], 53)
        self.assertEqual(
            gallery.calls[0][1]["extra_args"],
            [
                "--dump-json",
                "--post-range",
                "1-5",
                "--filter",
                "(rating == 'g') and (num == 0)",
            ],
        )

    def test_tls_eof_protocol_error_rotates_proxy_then_succeeds(self):
        tls_error = json.dumps(
            [[-1, {
                "error": "HttpError",
                "message": "SSLError: UNEXPECTED_EOF_WHILE_READING; "
                "EOF occurred in violation of protocol (_ssl.c:1082)",
            }]]
        )
        success = json.dumps(
            [[
                6,
                "https://e-hentai.org/g/1531036/91cbde3481/",
                {"gallery_id": 1531036, "gallery_token": "91cbde3481"},
            ]]
        )
        gallery = _SequenceGallery([tls_error, success])
        proxy = _RotatingFakeProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, proxy, Path(temporary))
            result = asyncio.run(
                service.search(
                    site="exhentai",
                    keyword="ogipote",
                    limit=20,
                    policy=SitePolicy(
                        proxy_mode="required",
                        retry_limit=1,
                        backoff_base_seconds=0,
                    ),
                    proxy_mode="required",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        self.assertEqual(len(gallery.calls), 2)
        self.assertEqual(proxy.acquired[1][1]["exclude_ids"], {"node-1"})
        self.assertEqual(proxy.released[0][1]["proxy_fault"], True)
        self.assertEqual(proxy.released[1][1]["proxy_fault"], False)
        self.assertNotEqual(
            gallery.calls[0][1]["proxy_url"],
            gallery.calls[1][1]["proxy_url"],
        )
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["proxy"]["node_id"], "node-2")

    def test_tls_eof_protocol_error_exhaustion_reports_actual_attempts(self):
        tls_error = json.dumps(
            [[-1, {
                "error": "HttpError",
                "message": "requests.exceptions.SSLEOFError: "
                "EOF occurred in violation of protocol (_ssl.c:1082)",
            }]]
        )
        gallery = _SequenceGallery([tls_error, tls_error])
        proxy = _RotatingFakeProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, proxy, Path(temporary))
            with self.assertRaises(DiscoveryError) as caught:
                asyncio.run(
                    service.search(
                        site="exhentai",
                        keyword="ogipote",
                        limit=20,
                        policy=SitePolicy(
                            proxy_mode="required",
                            retry_limit=1,
                            backoff_base_seconds=0,
                        ),
                        proxy_mode="required",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        extra_args=[],
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(caught.exception.code, "discovery_failed")
        self.assertEqual(caught.exception.details["attempts"], 2)
        self.assertEqual(caught.exception.details["proxy"]["node_id"], "node-2")
        self.assertNotIn("endpoint", caught.exception.details["proxy"])
        self.assertEqual(len(gallery.calls), 2)
        self.assertTrue(all(item[1]["proxy_fault"] for item in proxy.released))

    def test_non_retryable_extractor_error_keeps_safe_attempt_details(self):
        raw_message = (
            "ExtractionError: unable to parse gallery page "
            "Cookie=session-fixture "
            "proxy=http://user:pass@proxy.invalid:8080 "
            "token=fixture-token"
        )
        gallery = _SequenceGallery(
            [json.dumps([[-1, {"error": "ExtractionError", "message": raw_message}]])]
        )
        proxy = _RotatingFakeProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, proxy, Path(temporary))
            with self.assertRaises(DiscoveryError) as caught:
                asyncio.run(
                    service.search(
                        site="exhentai",
                        keyword="ogipote",
                        limit=20,
                        policy=SitePolicy(
                            proxy_mode="required",
                            retry_limit=2,
                            backoff_base_seconds=0,
                        ),
                        proxy_mode="required",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        extra_args=[],
                        timeout_seconds=30,
                    )
                )

        error = caught.exception
        self.assertEqual(error.code, "extractor_error")
        self.assertEqual(error.details["attempts"], 1)
        self.assertEqual(error.details["message"], error.message)
        self.assertIn("unable to parse gallery page", error.message)
        for secret in ("session-fixture", "user:pass", "fixture-token"):
            self.assertNotIn(secret, error.message)
            self.assertNotIn(secret, str(error.details))
        self.assertEqual(error.details["proxy"]["node_id"], "node-1")
        self.assertNotIn("endpoint", error.details["proxy"])
        self.assertEqual(len(gallery.calls), 1)
        self.assertFalse(proxy.released[0][1]["proxy_fault"])

    def test_cloudflare_parse_error_retries_and_reports_attempts(self):
        gallery = _FakeGallery(
            json.dumps(
                [
                    [
                        -1,
                        {
                            "error": "HttpError",
                            "message": "Cloudflare challenge (403 Forbidden) for https://x.com/account/access",
                        },
                    ]
                ]
            )
        )
        proxy = _FakeProxy()
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, proxy, Path(temporary))
            with self.assertRaises(DiscoveryError) as caught:
                asyncio.run(
                    service.search(
                        site="twitter",
                        keyword="rurudo",
                        limit=20,
                        policy=SitePolicy(
                            proxy_mode="required",
                            retry_limit=1,
                            backoff_base_seconds=0,
                        ),
                        proxy_mode="required",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        extra_args=[],
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(caught.exception.code, "discovery_failed")
        self.assertEqual(caught.exception.details["attempts"], 2)
        self.assertEqual(len(gallery.calls), 2)
        self.assertTrue(all(item[1]["proxy_fault"] for item in proxy.released))

    def test_empty_danbooru_gallery_result_falls_back_to_api_transport(self):
        gallery = _FakeGallery("[]")
        api_posts = [
            {
                "id": 123,
                "created_at": "2026-07-01T00:00:00Z",
                "rating": "s",
                "score": 5,
                "image_width": 1000,
                "image_height": 1200,
                "source": "https://example.test/preview.png",
                "tag_string_artist": "rurudo",
                "tag_string_character": "sample_character",
                "tag_string_copyright": "original",
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, _FakeProxy(), Path(temporary))
            with patch(
                "gdl_backend.discovery._danbooru_json_request",
                return_value=api_posts,
            ) as request:
                result = asyncio.run(
                    service.search(
                        site="danbooru",
                        keyword="rurudo",
                        limit=20,
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        extra_args=[],
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(result["transport"], "danbooru_api_honest_ua")
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["authors"][0]["name"], "rurudo")
        self.assertEqual(
            result["candidates"][0]["metadata"]["characters"],
            ["sample_character"],
        )
        self.assertEqual(request.call_args.kwargs["params"]["tags"], "rurudo")

    def test_danbooru_api_transport_paginates_with_before_cursor(self):
        first_page = [
            {
                "id": post_id,
                "tag_string_artist": "rurudo",
                "tag_string_copyright": "original",
            }
            for post_id in range(1000, 800, -1)
        ]
        second_page = [
            {
                "id": 800,
                "tag_string_artist": "rurudo",
                "tag_string_copyright": "original",
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(_FakeGallery("[]"), _FakeProxy(), Path(temporary))
            with patch(
                "gdl_backend.discovery._danbooru_json_request",
                side_effect=[first_page, second_page],
            ) as request:
                result = asyncio.run(
                    service._search_danbooru_posts_api(
                        keyword="rurudo",
                        limit=201,
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                    )
                )

        self.assertEqual(result["candidate_count"], 201)
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].kwargs["params"]["limit"], 200)
        self.assertEqual(request.call_args_list[1].kwargs["params"]["limit"], 1)
        self.assertEqual(request.call_args_list[1].kwargs["params"]["page"], "b801")

    def test_danbooru_tag_discovery_uses_api_instead_of_empty_gallery_transport(self):
        gallery = _FakeGallery("[]")
        api_posts = [
            {"id": 2, "tag_string_artist": "rurudo"},
            {"id": 1, "tag_string_artist": "rurudo"},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, _FakeProxy(), Path(temporary))
            with patch(
                "gdl_backend.discovery._danbooru_json_request",
                return_value=api_posts,
            ) as request:
                result = asyncio.run(
                    service.discover_url(
                        site="danbooru",
                        url="https://danbooru.donmai.us/posts?tags=rurudo",
                        keyword=None,
                        limit=2,
                        range_kind=None,
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        extra_args=[],
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(gallery.calls, [])
        self.assertEqual(request.call_args.kwargs["params"]["tags"], "rurudo")

    def test_empty_danbooru_artist_directory_falls_back_without_outer_wildcards(self):
        gallery = _FakeGallery("[]")
        api_artists = [
            {
                "id": 153992,
                "name": "rurudo",
                "other_names": ["kajuu_aisu"],
                "group_name": "",
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, _FakeProxy(), Path(temporary))
            with patch(
                "gdl_backend.discovery._danbooru_json_request",
                return_value=api_artists,
            ) as request:
                result = asyncio.run(
                    service.search_danbooru_artists(
                        keyword="rurudo",
                        limit=20,
                        policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                        proxy_mode="direct",
                        credentials_ref=None,
                        cookies_file=None,
                        config_file=None,
                        timeout_seconds=30,
                    )
                )

        self.assertEqual(result["authors"][0]["name"], "rurudo")
        self.assertEqual(result["authors"][0]["other_names"], ["kajuu_aisu"])
        self.assertEqual(
            request.call_args.kwargs["params"]["search[any_name_matches]"],
            "rurudo",
        )

    def test_danbooru_artist_directory_search_uses_child_range(self):
        stdout = json.dumps(
            [
                [
                    6,
                    "https://danbooru.donmai.us/posts?tags=eijunesound",
                    {"id": 559075, "name": "eijunesound", "other_names": ["EijuneSound"]},
                ]
            ]
        )
        gallery = _FakeGallery(stdout)
        with tempfile.TemporaryDirectory() as temporary:
            service = DiscoveryService(gallery, _FakeProxy(), Path(temporary))
            result = asyncio.run(
                service.search_danbooru_artists(
                    keyword="eijune sound",
                    limit=3,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    timeout_seconds=30,
                )
            )
        self.assertEqual(result["authors"][0]["name"], "eijunesound")
        call = gallery.calls[0][1]
        # No wildcards: they now trigger HTTP 500 database timeouts on
        # Danbooru's artist table; a plain query exact-matches
        # name/other_names/group_name with server-side normalization.
        self.assertIn("search%5Bany_name_matches%5D=eijune+sound", call["url"])
        self.assertEqual(call["extra_args"][:3], ["--dump-json", "--child-range", "1-3"])

    def test_missing_credentials_reference_is_explicit(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                GalleryRunner._credentials("missing-profile")

    def test_capture_stops_at_streaming_output_limit(self):
        class HangingPipeProcess(_FakeProcess):
            def __init__(self):
                super().__init__(b"x" * 1024)
                self.stderr = asyncio.StreamReader()

        async def create_process(*args, **kwargs):
            return HangingPipeProcess()

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = make_settings(root)
            runner = GalleryRunner(settings.gallery, settings.project_dir)

            async def execute():
                with patch(
                    "gdl_backend.gallery.asyncio.create_subprocess_exec",
                    new=create_process,
                ):
                    await asyncio.wait_for(
                        runner.capture(
                            "limited",
                            url="https://danbooru.donmai.us/posts/1",
                            output_dir=str(root / "capture"),
                            proxy_url=None,
                            http_timeout=10,
                            gallery_retries=0,
                            task_timeout=30,
                            cookies_file=None,
                            config_file=None,
                            credentials_ref=None,
                            extra_args=["--dump-json"],
                            max_output_bytes=100,
                        ),
                        timeout=1,
                    )

            with self.assertRaises(ValueError):
                asyncio.run(execute())


if __name__ == "__main__":
    unittest.main()
