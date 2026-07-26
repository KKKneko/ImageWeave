from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.config import DedupSettings
from gdl_backend.database import Database
from gdl_backend.review import DedupReviewManager
from tests.helpers import make_settings


def create_terminal_batch(
    db: Database,
    root: Path,
    batch_id: str = "batch-review",
) -> Path:
    output = root / "downloads" / batch_id
    output.mkdir(parents=True, exist_ok=True)
    db.create_crawl_batch(
        {
            "id": batch_id,
            "output_dir": str(output),
            "concurrency": 1,
            "max_tasks": 10,
        },
        [
            {
                "id": f"{batch_id}-address",
                "site": "danbooru",
                "source_order": 0,
                "address_order": 0,
                "url": "https://danbooru.donmai.us/posts?tags=review",
                "proxy_mode": "direct",
                "max_attempts": 1,
            }
        ],
    )
    address_id = f"{batch_id}-address"
    assert db.begin_crawl_address_planning(address_id)
    assert db.finish_crawl_address_as_pre_deduplicated(address_id, 0)
    assert db.finish_crawl_batch_if_ready(batch_id)
    return output


def manifest_image(image_id: str, relative_path: str, *, recommended: bool) -> dict:
    return {
        "id": image_id,
        "relative_path": relative_path,
        "readable": True,
        "recommended": recommended,
        "metadata": {
            "file_hash": image_id,
            "w": 32,
            "h": 32,
            "format": "PNG",
            "size": 1,
        },
    }


def review_manifest(output: Path, *, include_automatic: bool = False) -> dict:
    duplicate_images = (
        [
            manifest_image("image-b", "source/b.png", recommended=True),
            manifest_image("image-c", "source/c.png", recommended=False),
        ]
        if include_automatic
        else [
            manifest_image("image-a", "source/a.png", recommended=True),
            manifest_image("image-b", "source/b.png", recommended=False),
        ]
    )
    single_image = (
        manifest_image("image-d", "source/d.png", recommended=True)
        if include_automatic
        else manifest_image("image-c", "source/c.png", recommended=True)
    )
    automatic_groups = []
    if include_automatic:
        automatic_groups = [
            {
                "id": "automatic-exact-group",
                "ordinal": 1,
                "kind": "exact",
                "match_levels": ["L0-完全相同"],
                "reason": "质量指标相同，按路径稳定保留",
                "winner": manifest_image(
                    "image-b", "source/b.png", recommended=True
                ),
                "rejected_items": [
                    manifest_image("image-a", "source/a.png", recommended=False)
                ],
            }
        ]
    total_images = 4 if include_automatic else 3
    return {
        "schema_version": 2,
        "root": str(output.resolve()),
        "counts": {
            "images": total_images,
            "review_images": total_images - len(automatic_groups),
            "groups": 2,
            "duplicate_groups": 1,
            "single_groups": 1,
            "unreadable_images": 0,
            "automatic_groups": len(automatic_groups),
            "automatic_rejected_images": len(automatic_groups),
        },
        "auto_groups": automatic_groups,
        "groups": [
            {
                "id": "duplicate-group",
                "ordinal": 1,
                "kind": "duplicate",
                "match_levels": ["L0-完全相同"],
                "reason": "分辨率更高",
                "items": duplicate_images,
            },
            {
                "id": "single-group",
                "ordinal": 2,
                "kind": "single",
                "match_levels": [],
                "reason": "唯一候选",
                "items": [single_image],
            },
        ],
    }


def write_review_files(
    output: Path,
    names: tuple[str, ...] = ("a.png", "b.png", "c.png"),
) -> None:
    source = output / "source"
    source.mkdir(parents=True, exist_ok=True)
    for name in names:
        (source / name).write_bytes(f"image-{name}".encode("ascii"))
    (source / "a.txt").write_text("caption", encoding="utf-8")


class ReviewManagerTests(unittest.TestCase):
    def test_strict_auto_rejections_run_before_remaining_images_enter_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = Database(root / "backend.sqlite3")
            try:
                output = create_terminal_batch(db, root)
                write_review_files(output, ("a.png", "b.png", "c.png", "d.png"))
                db.start_crawl_review("batch-review")

                async def runner(_claimed):
                    return review_manifest(output, include_automatic=True), str(root / "analysis.log")

                manager = DedupReviewManager(
                    db,
                    DedupSettings(enabled=True),
                    root / "runtime",
                    runner=runner,
                )
                self.assertTrue(asyncio.run(manager.run_once()))
                review = db.get_crawl_review("batch-review")
                self.assertEqual(review["status"], "ready")
                self.assertEqual(review["total_image_count"], 4)
                self.assertEqual(review["duplicate_group_count"], 1)
                self.assertEqual(review["automatic_group_count"], 1)
                self.assertEqual(review["automatic_rejected_image_count"], 1)
                self.assertEqual(review["selected_image_count"], 3)
                self.assertEqual(review["rejected_image_count"], 1)
                self.assertFalse((output / "source" / "a.png").exists())
                self.assertTrue((output / "duplicates" / "source" / "a.png").is_file())
                self.assertTrue((output / "duplicates" / "source" / "a.txt").is_file())

                duplicate_page = db.list_crawl_review_groups(
                    "batch-review", kind="duplicate"
                )
                self.assertEqual(duplicate_page["total"], 1)
                self.assertEqual(len(duplicate_page["items"][0]["images"]), 2)

                with self.assertRaisesRegex(RuntimeError, "2 个图片组尚未确认"):
                    manager.apply("batch-review")

                db.update_crawl_review_decisions(
                    "batch-review",
                    [
                        {"group_id": "duplicate-group", "selected_image_ids": []},
                        {"group_id": "single-group", "selected_image_ids": ["image-d"]},
                    ],
                )
                self.assertEqual(db.get_crawl_review("batch-review")["selected_image_count"], 1)

                applied = manager.apply("batch-review")
                self.assertEqual(applied["status"], "applied")
                self.assertEqual(applied["kept_image_count"], 1)
                self.assertEqual(applied["rejected_image_count"], 3)
                self.assertTrue((output / "source" / "d.png").is_file())
                self.assertTrue((output / "duplicates" / "source" / "b.png").is_file())
                self.assertTrue((output / "duplicates" / "source" / "c.png").is_file())
            finally:
                db.close()

    def test_automatic_move_resume_finishes_txt_after_image_only_crash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = Database(root / "backend.sqlite3")
            try:
                output = create_terminal_batch(db, root, "batch-auto-resume")
                write_review_files(output, ("a.png", "b.png", "c.png", "d.png"))
                db.start_crawl_review("batch-auto-resume")
                claimed = db.claim_next_crawl_review()
                db.replace_crawl_review_manifest(
                    "batch-auto-resume",
                    review_manifest(output, include_automatic=True),
                )
                image = db.crawl_review_automatic_images("batch-auto-resume")[0]
                destination = output / "duplicates" / "source" / "a.png"
                destination.parent.mkdir(parents=True, exist_ok=True)
                db.stage_crawl_review_image_move(
                    "batch-auto-resume",
                    image["id"],
                    destination.relative_to(output).as_posix(),
                )
                (output / "source" / "a.png").replace(destination)

                manager = DedupReviewManager(
                    db,
                    DedupSettings(enabled=True),
                    root / "runtime",
                )
                self.assertTrue(asyncio.run(manager.run_once()))
                review = db.get_crawl_review("batch-auto-resume")
                self.assertEqual(review["status"], "ready")
                self.assertEqual(review["rejected_image_count"], 1)
                self.assertFalse((output / "source" / "a.txt").exists())
                self.assertTrue(
                    (output / "duplicates" / "source" / "a.txt").is_file()
                )
            finally:
                db.close()


class ReviewApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        output = create_terminal_batch(self.container.db, self.root, "batch-api-review")
        write_review_files(output)
        self.container.db.start_crawl_review("batch-api-review")
        claimed = self.container.db.claim_next_crawl_review()
        self.assertEqual(claimed["batch_id"], "batch-api-review")
        self.container.db.replace_crawl_review_manifest(
            "batch-api-review", review_manifest(output)
        )
        self.client_context = TestClient(
            create_app(self.settings, container=self.container, start_background=False)
        )
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def test_review_api_accepts_zero_selection_and_serves_images(self):
        listing = self.client.get(
            "/api/v1/crawls/batch-api-review/review?kind=duplicate"
        )
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["groups"]["total"], 1)
        image_url = listing.json()["groups"]["items"][0]["images"][0]["url"]
        self.assertEqual(self.client.get(image_url).status_code, 200)

        decision = self.client.put(
            "/api/v1/crawls/batch-api-review/review/decisions",
            json={
                "groups": [
                    {"group_id": "duplicate-group", "selected_image_ids": []}
                ]
            },
        )
        self.assertEqual(decision.status_code, 200, decision.text)
        self.assertEqual(decision.json()["selected_image_count"], 1)

        incomplete = self.client.post(
            "/api/v1/crawls/batch-api-review/review/apply", json={}
        )
        self.assertEqual(incomplete.status_code, 409, incomplete.text)

        single = self.client.put(
            "/api/v1/crawls/batch-api-review/review/decisions",
            json={
                "groups": [
                    {"group_id": "single-group", "selected_image_ids": ["image-c"]}
                ]
            },
        )
        self.assertEqual(single.status_code, 200, single.text)

        applied = self.client.post(
            "/api/v1/crawls/batch-api-review/review/apply", json={}
        )
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["status"], "applied")


class ReviewRegistrationApiTests(unittest.TestCase):
    def test_loading_historical_batch_is_read_only_until_explicit_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = make_settings(root)
            settings.dedup.enabled = True
            container = ServiceContainer(settings)
            create_terminal_batch(container.db, root, "batch-history-enabled")
            self.assertIsNone(container.db.get_crawl_review("batch-history-enabled"))

            with TestClient(
                create_app(settings, container=container, start_background=False)
            ) as client:
                response = client.get("/api/v1/crawls/batch-history-enabled")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["review"]["status"], "not_started")
                listing = client.get(
                    "/api/v1/crawls/batch-history-enabled/review"
                )
                self.assertEqual(listing.status_code, 200, listing.text)
                self.assertEqual(listing.json()["status"], "not_started")
                self.assertIsNone(container.db.get_crawl_review("batch-history-enabled"))

                started = client.post(
                    "/api/v1/crawls/batch-history-enabled/review/start", json={}
                )
                self.assertEqual(started.status_code, 202, started.text)
                self.assertEqual(started.json()["status"], "pending")
                repeated = client.post(
                    "/api/v1/crawls/batch-history-enabled/review/start", json={}
                )
                self.assertEqual(repeated.status_code, 202, repeated.text)
                self.assertEqual(repeated.json()["status"], "pending")

    def test_disabled_review_does_not_register_historical_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = make_settings(root)
            container = ServiceContainer(settings)
            create_terminal_batch(container.db, root, "batch-history-disabled")

            with TestClient(
                create_app(settings, container=container, start_background=False)
            ) as client:
                detail = client.get("/api/v1/crawls/batch-history-disabled")
                self.assertEqual(detail.status_code, 200, detail.text)
                self.assertEqual(detail.json()["review"]["status"], "disabled")
                listing = client.get(
                    "/api/v1/crawls/batch-history-disabled/review"
                )
                self.assertEqual(listing.status_code, 200, listing.text)
                self.assertEqual(listing.json()["status"], "disabled")
                start = client.post(
                    "/api/v1/crawls/batch-history-disabled/review/start", json={}
                )
                self.assertEqual(start.status_code, 409, start.text)
                self.assertIsNone(
                    container.db.get_crawl_review("batch-history-disabled")
                )


if __name__ == "__main__":
    unittest.main()
