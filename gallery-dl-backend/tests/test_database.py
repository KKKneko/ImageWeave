from __future__ import annotations

import inspect
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from gdl_backend.database import Database


PURE_READ_METHODS = frozenset(
    {
        "ping",
        "get_task",
        "get_task_by_idempotency",
        "list_tasks",
        "queued_tasks",
        "queued_task_ids",
        "get_logs",
        "get_events",
        "get_crawl_batch_by_idempotency",
        "get_crawl_batch",
        "list_crawl_batches",
        "get_crawl_review",
        "next_crawl_review_automatic",
        "list_crawl_review_groups",
        "get_crawl_review_image",
        "crawl_review_apply_images",
        "crawl_review_automatic_images",
        "active_crawl_batch_ids",
        "next_crawl_address",
        "get_crawl_address_proxy_probe",
        "task_crawl_batch_id",
        "crawl_batch_cancel_requested",
        "succeeded_danbooru_source_keys",
        "succeeded_danbooru_source_key_count",
        "crawl_address_tasks",
        "list_crawl_tasks",
        "crawl_batch_task_count",
        "crawl_address_task_count",
        "get_site_policy",
        "list_site_policies",
        "incomplete_processes",
    }
)

READ_METHOD_WRITE_LOCK_EXCEPTIONS = frozenset()


def task_values(root: Path) -> dict:
    return {
        "id": "task-1",
        "url": "https://example.com/gallery/1",
        "site": "example.com",
        "subcategory": "gallery",
        "extractor": "ExampleExtractor",
        "output_dir": str(root / "out"),
        "proxy_mode": "prefer",
        "max_attempts": 3,
        "policy": {"max_concurrency": 1},
        "extra_args": [],
    }


def site_policy_values(**overrides) -> dict:
    policy = {
        "max_concurrency": 20,
        "retry_limit": 2,
        "backoff_base_seconds": 2.0,
        "proxy_mode": "prefer",
    }
    policy.update(overrides)
    return policy


def crawl_address_values(batch_id: str) -> list[dict]:
    return [
        {
            "id": f"{batch_id}-address",
            "site": "danbooru",
            "source_order": 0,
            "address_order": 0,
            "url": "https://danbooru.donmai.us/posts?tags=review",
            "proxy_mode": "direct",
            "max_attempts": 1,
        }
    ]


def create_media_batch(
    database: Database,
    root: Path,
    *,
    batch_id: str = "batch-media",
    address_id: str = "address-media",
) -> None:
    database.create_crawl_batch(
        {
            "id": batch_id,
            "output_dir": str(root / "batch-media"),
            "concurrency": 3,
            "max_tasks": 100,
        },
        [
            {
                "id": address_id,
                "site": "example.com",
                "source_order": 0,
                "address_order": 0,
                "url": "https://example.com/gallery/media",
                "proxy_mode": "prefer",
                "max_attempts": 4,
            }
        ],
    )


def media_task_item(root: Path, index: int, *, sequence_no: int | None = None) -> dict:
    return {
        "task": {
            **task_values(root),
            "id": f"media-task-{index}",
            "url": f"https://example.com/media/{index}",
            "subcategory": "image",
            "extractor": "ExampleImageExtractor",
            "priority": index,
            "output_dir": str(root / f"out-{index}"),
            "proxy_mode": "required",
            "max_attempts": 4,
            "cookies_file": str(root / "cookies.txt"),
            "config_file": str(root / "gallery.conf"),
            "credentials_ref": "managed-example",
            "extra_args": ["--range", str(index)],
            "policy": {"max_concurrency": 3, "label": "字段对照"},
        },
        "idempotency_key": f"media-key-{index}",
        "sequence_no": index if sequence_no is None else sequence_no,
        "source_key": f"example:{index}",
        "source_url": f"https://source.example/{index}",
    }


def table_rows(database: Database, table: str, order_by: str) -> list[dict]:
    with database._read() as conn:
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY {order_by}").fetchall()
    return [dict(row) for row in rows]


class DatabaseSourceAuditTests(unittest.TestCase):
    def test_read_methods_do_not_take_write_lock(self):
        self.assertLessEqual(
            READ_METHOD_WRITE_LOCK_EXCEPTIONS,
            PURE_READ_METHODS,
            "写锁例外只能来自纯读方法清单",
        )
        for method_name in sorted(PURE_READ_METHODS):
            with self.subTest(method=method_name):
                source = inspect.getsource(getattr(Database, method_name))
                if method_name in READ_METHOD_WRITE_LOCK_EXCEPTIONS:
                    continue
                self.assertNotIn(
                    "self._lock",
                    source,
                    f"纯读方法 {method_name} 不得获取写锁",
                )


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3", max_logs_per_task=100)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_reader_connection_rejects_writes(self):
        with self.db._read() as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute(
                    "INSERT INTO meta(key, value) VALUES ('reader-write', '1')"
                )

    def test_reader_is_per_thread(self):
        readers: list[sqlite3.Connection | None] = [None, None]
        errors: list[BaseException | None] = [None, None]

        def open_reader(index: int) -> None:
            try:
                with self.db._read() as conn:
                    conn.execute("SELECT 1").fetchone()
                    readers[index] = conn
            except BaseException as exc:
                errors[index] = exc

        threads = [
            threading.Thread(target=open_reader, args=(index,)) for index in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [None, None])
        self.assertIsNotNone(readers[0])
        self.assertIsNotNone(readers[1])
        self.assertIsNot(readers[0], readers[1])

    def test_reader_sees_committed_writes(self):
        self.db.create_task(task_values(self.root))
        seen: list[dict | None] = [None]
        errors: list[BaseException | None] = [None]

        def read_task() -> None:
            try:
                seen[0] = self.db.get_task("task-1")
            except BaseException as exc:
                errors[0] = exc

        thread = threading.Thread(target=read_task)
        thread.start()
        thread.join()

        self.assertIsNone(errors[0])
        self.assertIsNotNone(seen[0])
        self.assertEqual(seen[0]["id"], "task-1")

    def test_concurrent_reads_are_not_serialized(self):
        self.db.create_task(task_values(self.root))
        reader_count = 3
        all_readers_ready = threading.Event()
        release_readers = threading.Event()
        counter_lock = threading.Lock()
        entered = 0
        results: list[str | None] = [None] * reader_count
        errors: list[BaseException | None] = [None] * reader_count

        def wait_for_release() -> int:
            nonlocal entered
            with counter_lock:
                entered += 1
                if entered == reader_count:
                    all_readers_ready.set()
            release_readers.wait()
            return 1

        def run_read(index: int) -> None:
            try:
                with self.db._read() as conn:
                    conn.create_function("wait_for_release", 0, wait_for_release)
                    row = conn.execute(
                        "SELECT wait_for_release() AS ready, id "
                        "FROM tasks WHERE id=?",
                        ("task-1",),
                    ).fetchone()
                    results[index] = str(row["id"])
            except BaseException as exc:
                errors[index] = exc

        threads = [
            threading.Thread(target=run_read, args=(index,))
            for index in range(reader_count)
        ]
        for thread in threads:
            thread.start()

        readers_overlapped = all_readers_ready.wait(timeout=5.0)
        write_result: tuple[dict, bool] | None = None
        try:
            if readers_overlapped:
                write_result = self.db.create_task(
                    {**task_values(self.root), "id": "task-2"}
                )
        finally:
            release_readers.set()
        for thread in threads:
            thread.join()

        self.assertTrue(readers_overlapped)
        self.assertEqual(errors, [None] * reader_count)
        self.assertEqual(results, ["task-1"] * reader_count)
        self.assertIsNotNone(write_result)
        self.assertTrue(write_result[1])
        self.assertEqual(self.db.get_task("task-2")["id"], "task-2")

    def test_close_closes_all_reader_connections(self):
        readers: list[sqlite3.Connection | None] = [None, None]
        errors: list[BaseException | None] = [None, None]

        def open_reader(index: int) -> None:
            try:
                with self.db._read() as conn:
                    conn.execute("SELECT 1").fetchone()
                    readers[index] = conn
            except BaseException as exc:
                errors[index] = exc

        threads = [
            threading.Thread(target=open_reader, args=(index,)) for index in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [None, None])

        self.db.close()

        for conn in readers:
            self.assertIsNotNone(conn)
            with self.assertRaises(sqlite3.ProgrammingError):
                conn.execute("SELECT 1")

    def test_create_task_idempotent_hit_returns_full_shape(self):
        created, is_new = self.db.create_task(
            task_values(self.root), idempotency_key="full-shape"
        )
        self.assertTrue(is_new)
        self.assertTrue(self.db.claim_task(created["id"]))
        attempt = self.db.begin_attempt(created["id"])
        self.db.set_lease(
            created["id"],
            attempt["id"],
            "node-1",
            "http://127.0.0.1:28000",
            "example.com",
        )

        duplicate, is_new = self.db.create_task(
            {**task_values(self.root), "id": "task-duplicate"},
            idempotency_key="full-shape",
        )

        self.assertFalse(is_new)
        self.assertEqual(duplicate["id"], created["id"])
        self.assertIn("latest_attempt", duplicate)
        self.assertIn("lease", duplicate)
        self.assertIsNotNone(duplicate["latest_attempt"])
        self.assertIsNotNone(duplicate["lease"])

    def test_chunked_enqueue_creates_same_tasks_as_before(self):
        other = Database(self.root / "batch.sqlite3", max_logs_per_task=100)
        try:
            items = [
                media_task_item(self.root, 1),
                media_task_item(self.root, 2, sequence_no=1),
                media_task_item(self.root, 3),
            ]
            with patch("gdl_backend.database.time.time", return_value=1234.5):
                create_media_batch(self.db, self.root)
                create_media_batch(other, self.root)
                for item in items:
                    task, created = self.db.create_task(
                        item["task"],
                        idempotency_key=item["idempotency_key"],
                    )
                    self.assertTrue(created)
                    self.db.link_crawl_task(
                        "address-media",
                        task["id"],
                        item["sequence_no"],
                        source_key=item["source_key"],
                        source_url=item["source_url"],
                    )
                results = other.create_crawl_media_tasks("address-media", items)

            self.assertEqual(
                results,
                [
                    {"task_id": f"media-task-{index}", "created": True}
                    for index in range(1, 4)
                ],
            )
            for table, order_by in (
                ("tasks", "id"),
                ("crawl_address_tasks", "sequence_no, task_id"),
                ("crawl_task_source_keys", "task_id, source_key"),
                ("task_events", "id"),
            ):
                with self.subTest(table=table):
                    self.assertEqual(
                        table_rows(other, table, order_by),
                        table_rows(self.db, table, order_by),
                    )
            task_row = table_rows(other, "tasks", "id")[0]
            self.assertEqual(task_row["status"], "queued")
            self.assertEqual(task_row["attempt_count"], 0)
            self.assertEqual(task_row["backoff_anchor_attempt"], 0)
            self.assertEqual(task_row["cancel_requested"], 0)
            self.assertEqual(task_row["last_error_class"], "")
            self.assertEqual(task_row["last_error"], "")
            self.assertEqual(task_row["tried_proxy_ids_json"], "[]")
            self.assertEqual(task_row["artifact_count"], 0)
            self.assertEqual(task_row["artifact_bytes"], 0)
            self.assertEqual(task_row["version"], 0)
            self.assertEqual(
                [row["sequence_no"] for row in table_rows(
                    other, "crawl_address_tasks", "sequence_no"
                )],
                [1, 2, 3],
            )
            self.assertEqual(other.get_crawl_batch("batch-media")["task_count"], 3)
            self.assertTrue(
                all(
                    event["event_type"] == "queued"
                    for event in table_rows(other, "task_events", "id")
                )
            )
        finally:
            other.close()

    def test_chunk_rollback_on_failure(self):
        create_media_batch(self.db, self.root)
        first_chunk = [
            media_task_item(self.root, 1),
            media_task_item(self.root, 2),
        ]
        self.db.create_crawl_media_tasks("address-media", first_chunk)
        second_chunk = [
            media_task_item(self.root, 3),
            media_task_item(self.root, 4),
            media_task_item(self.root, 5),
        ]
        del second_chunk[1]["task"]["output_dir"]

        with self.assertRaises(KeyError):
            self.db.create_crawl_media_tasks("address-media", second_chunk)

        self.assertEqual(
            [row["id"] for row in table_rows(self.db, "tasks", "id")],
            ["media-task-1", "media-task-2"],
        )
        self.assertEqual(len(table_rows(self.db, "crawl_address_tasks", "task_id")), 2)
        self.assertEqual(len(table_rows(self.db, "crawl_task_source_keys", "task_id")), 2)
        self.assertEqual(len(table_rows(self.db, "task_events", "id")), 2)
        self.assertEqual(self.db.get_crawl_batch("batch-media")["task_count"], 2)

    def test_idempotent_replan_creates_no_duplicates(self):
        create_media_batch(self.db, self.root)
        items = [
            media_task_item(self.root, 1),
            media_task_item(self.root, 2, sequence_no=1),
        ]
        first = self.db.create_crawl_media_tasks("address-media", items)
        replanned = [
            {
                **item,
                "task": {**item["task"], "id": f"replacement-{index}"},
                "sequence_no": 90 + index,
                "source_url": f"https://updated.example/{index}",
            }
            for index, item in enumerate(items, start=1)
        ]
        second = self.db.create_crawl_media_tasks("address-media", replanned)

        self.assertTrue(all(item["created"] for item in first))
        self.assertEqual(
            second,
            [
                {"task_id": "media-task-1", "created": False},
                {"task_id": "media-task-2", "created": False},
            ],
        )
        self.assertEqual(len(table_rows(self.db, "tasks", "id")), 2)
        self.assertEqual(len(table_rows(self.db, "task_events", "id")), 2)
        links = table_rows(self.db, "crawl_address_tasks", "sequence_no")
        self.assertEqual([row["sequence_no"] for row in links], [1, 2])
        sources = table_rows(self.db, "crawl_task_source_keys", "task_id")
        self.assertEqual(
            [row["source_url"] for row in sources],
            ["https://updated.example/1", "https://updated.example/2"],
        )
        self.assertEqual(self.db.get_crawl_batch("batch-media")["task_count"], 2)

    def test_task_attempt_retry_and_completion(self):
        created, is_new = self.db.create_task(task_values(self.root), idempotency_key="same")
        self.assertTrue(is_new)
        duplicate, is_new = self.db.create_task({**task_values(self.root), "id": "other"}, idempotency_key="same")
        self.assertFalse(is_new)
        self.assertEqual(created["id"], duplicate["id"])

        self.assertTrue(self.db.claim_task("task-1"))
        attempt = self.db.begin_attempt("task-1")
        self.db.set_process("task-1", attempt["id"], 123, "marker")
        self.db.set_lease("task-1", attempt["id"], "node", "http://127.0.0.1:28000", "example.com")
        self.db.finish_attempt(
            attempt["id"],
            exit_code=4,
            status="failed",
            error_class="proxy_failure",
            error_message="ProxyError",
            retryable=True,
            proxy_node_id="node",
        )
        self.db.clear_lease("task-1")
        self.db.requeue_task(
            "task-1",
            next_run_at=0,
            exit_code=4,
            error_class="proxy_failure",
            error_message="ProxyError",
            tried_proxy_ids=["node"],
        )
        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["tried_proxy_ids"], ["node"])

        self.db.complete_task("task-1", "failed", error_class="exhausted")
        self.assertEqual(self.db.get_task("task-1")["status"], "failed")
        retried = self.db.retry_task("task-1", 2)
        self.assertEqual(retried["status"], "queued")

    def test_retry_task_anchors_backoff_to_prior_attempt_count(self):
        self.db.create_task(task_values(self.root))
        self.assertTrue(self.db.claim_task("task-1"))
        attempt = self.db.begin_attempt("task-1")
        self.db.complete_task(
            "task-1",
            "failed",
            error_class="download_error",
            error_message="boom",
            expected_attempt_id=attempt["id"],
        )
        # Emulate a longer automatic-retry history before the manual round.
        with self.db._transaction() as conn:
            conn.execute("UPDATE tasks SET attempt_count=? WHERE id=?", (5, "task-1"))

        retried = self.db.retry_task("task-1", 2)
        self.assertEqual(retried["status"], "queued")
        # The manual round pins the anchor to the accumulated attempt_count so the
        # scheduler's backoff exponent restarts at 0, and grows the budget by 2.
        self.assertEqual(retried["backoff_anchor_attempt"], 5)
        self.assertEqual(retried["max_attempts"], 7)

    def test_logs_events_and_policy(self):
        self.db.create_task(task_values(self.root))
        self.db.append_log("task-1", None, "stderr", "token=secret")
        logs = self.db.get_logs("task-1")
        self.assertEqual(len(logs), 1)
        self.assertNotIn("secret", logs[0]["line"])
        self.assertTrue(self.db.get_events("task-1"))
        policy = site_policy_values(max_concurrency=3)
        self.db.put_site_policy("example.com", policy)
        self.assertEqual(self.db.get_site_policy("example.com")["policy"], policy)
        with self.assertRaises(ValueError):
            self.db.put_site_policy(
                "example.com",
                {**policy, "http_timeout": 1},
            )
        self.assertTrue(self.db.delete_site_policy("example.com"))

    def test_exclude_sites_caps_parameter_count(self):
        self.db.create_task(task_values(self.root))
        excluded_sites = {f"site-{index:03d}" for index in range(100)}
        previous_limit = self.db._conn.setlimit(
            sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,
            66,
        )
        try:
            queued = self.db.queued_tasks(
                limit=200,
                exclude_sites=excluded_sites,
            )
        finally:
            self.db._conn.setlimit(
                sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,
                previous_limit,
            )
        self.assertEqual([task["id"] for task in queued], ["task-1"])

    def test_lease_cleanup_is_scoped_to_attempt(self):
        self.db.create_task(task_values(self.root))
        self.assertTrue(self.db.claim_task("task-1"))
        attempt = self.db.begin_attempt("task-1")
        self.db.set_lease(
            "task-1",
            attempt["id"],
            "node",
            "http://127.0.0.1:28000",
            "example.com",
        )

        self.db.clear_lease("task-1", "stale-attempt")
        remaining = self.db._conn.execute(
            "SELECT attempt_id FROM leases WHERE task_id=?", ("task-1",)
        ).fetchone()
        self.assertIsNotNone(remaining)
        self.assertEqual(remaining["attempt_id"], attempt["id"])

        self.db.clear_lease("task-1", attempt["id"])
        remaining = self.db._conn.execute(
            "SELECT attempt_id FROM leases WHERE task_id=?", ("task-1",)
        ).fetchone()
        self.assertIsNone(remaining)

    def test_ordered_crawl_batch_persists_order_links_and_idempotency(self):
        addresses = [
            {
                "id": "address-1",
                "site": "twitter",
                "source_order": 0,
                "address_order": 0,
                "url": "https://x.com/a/media",
                "proxy_mode": "required",
                "max_attempts": 3,
                "download_options": {
                    "eh": {"image_mode": "original", "gp_policy": "stop"}
                },
            },
            {
                "id": "address-2",
                "site": "pixiv",
                "source_order": 1,
                "address_order": 0,
                "url": "https://www.pixiv.net/users/1/artworks",
                "proxy_mode": "required",
                "max_attempts": 3,
            },
        ]
        batch_id, created = self.db.create_crawl_batch(
            {
                "id": "batch-1",
                "output_dir": str(self.root / "batch"),
                "concurrency": 20,
                "max_tasks": 100,
            },
            addresses,
            idempotency_key="same-batch",
        )
        self.assertTrue(created)
        duplicate, created = self.db.create_crawl_batch(
            {
                "id": "batch-2",
                "output_dir": str(self.root / "other"),
                "concurrency": 1,
                "max_tasks": 1,
            },
            addresses,
            idempotency_key="same-batch",
        )
        self.assertFalse(created)
        self.assertEqual(duplicate, batch_id)

        probe = self.db.save_crawl_address_proxy_probe(
            "address-1",
            target_url="https://x.com/",
            total_count=3,
            healthy_node_ids=["node-b", "node-a", "node-b"],
        )
        self.assertEqual(probe["healthy_count"], 2)
        self.assertEqual(probe["node_ids"], ["node-a", "node-b"])
        batch = self.db.get_crawl_batch(batch_id)
        first_address = batch["sources"][0]["addresses"][0]
        self.assertEqual(
            first_address["download_options"],
            {"eh": {"image_mode": "original", "gp_policy": "stop"}},
        )
        self.assertEqual(first_address["proxy_probe_target"], "https://x.com/")
        self.assertEqual(first_address["probed_proxy_count"], 3)
        self.assertEqual(first_address["healthy_proxy_count"], 2)

        self.assertEqual(self.db.next_crawl_address(batch_id)["id"], "address-1")
        self.assertTrue(self.db.begin_crawl_address_planning("address-1"))

        values = task_values(self.root)
        self.db.create_task(values)
        self.db.link_crawl_task("address-1", "task-1", 1)
        self.assertTrue(self.db.mark_crawl_address_running("address-1"))
        self.db.complete_task("task-1", "succeeded")
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-1"))
        self.assertEqual(self.db.next_crawl_address(batch_id)["id"], "address-2")
        batch = self.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["task_count"], 1)
        self.assertEqual(batch["succeeded_task_count"], 1)
        self.assertEqual(batch["sources"][0]["status"], "succeeded")
        self.assertEqual(batch["sources"][1]["status"], "pending")

    def test_retry_failed_crawl_tasks_requeues_only_failed_media(self):
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-retry",
                "output_dir": str(self.root / "batch-retry"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-retry",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/1/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        values = {**task_values(self.root), "id": "task-retry"}
        self.assertTrue(self.db.begin_crawl_address_planning("address-retry"))
        self.db.create_task(values)
        self.db.link_crawl_task("address-retry", "task-retry", 1)
        self.assertTrue(self.db.mark_crawl_address_running("address-retry"))
        self.assertTrue(self.db.claim_task("task-retry"))
        attempt = self.db.begin_attempt("task-retry")
        self.db.finish_attempt(
            attempt["id"],
            exit_code=1,
            status="failed",
            error_class="download_error",
            error_message="continuation",
            retryable=True,
        )
        self.db.complete_task(
            "task-retry",
            "failed",
            exit_code=1,
            error_class="download_error",
            error_message="continuation",
            expected_attempt_id=attempt["id"],
        )
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-retry"))
        result = self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=2)
        self.assertEqual(result["retried_count"], 1)
        self.assertEqual(result["address_ids"], ["address-retry"])
        task = self.db.get_task("task-retry")
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["max_attempts"], 3)
        # The manual round anchors the backoff exponent to the prior attempt_count
        # (one attempt was recorded), so the next automatic retry starts fresh.
        self.assertEqual(task["backoff_anchor_attempt"], 1)
        batch = self.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["status"], "running")
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "running")

    def test_retry_failed_crawl_tasks_requeues_cancelled_media(self):
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-cancel",
                "output_dir": str(self.root / "batch-cancel"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-cancel",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/2/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        values = {**task_values(self.root), "id": "task-cancel"}
        self.assertTrue(self.db.begin_crawl_address_planning("address-cancel"))
        self.db.create_task(values)
        self.db.link_crawl_task("address-cancel", "task-cancel", 1)
        self.assertTrue(self.db.mark_crawl_address_running("address-cancel"))
        self.assertTrue(self.db.claim_task("task-cancel"))
        attempt = self.db.begin_attempt("task-cancel")
        self.db.request_cancel("task-cancel")
        self.db.complete_task(
            "task-cancel",
            "cancelled",
            exit_code=1,
            error_class="cancelled",
            error_message="任务已取消",
            expected_attempt_id=attempt["id"],
        )
        cancelled = self.db.get_task("task-cancel")
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertTrue(cancelled["cancel_requested"])
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-cancel"))

        result = self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=2)
        self.assertEqual(result["retried_count"], 1)
        self.assertEqual(result["task_ids"], ["task-cancel"])
        self.assertEqual(result["address_ids"], ["address-cancel"])
        task = self.db.get_task("task-cancel")
        self.assertEqual(task["status"], "queued")
        self.assertFalse(task["cancel_requested"])
        self.assertEqual(task["max_attempts"], 3)
        batch = self.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["status"], "running")
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "running")

    def test_manual_retry_preserves_last_error_until_success(self):
        # retry_failed_crawl_tasks must not blank the prior failure evidence.
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-err",
                "output_dir": str(self.root / "batch-err"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-err",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/3/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-err"))
        self.db.create_task({**task_values(self.root), "id": "task-err"})
        self.db.link_crawl_task("address-err", "task-err", 1)
        self.assertTrue(self.db.mark_crawl_address_running("address-err"))
        self.assertTrue(self.db.claim_task("task-err"))
        attempt = self.db.begin_attempt("task-err")
        self.db.complete_task(
            "task-err",
            "failed",
            exit_code=1,
            error_class="download_error",
            error_message="遗漏图片-42",
            expected_attempt_id=attempt["id"],
        )
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-err"))

        self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=1)
        requeued = self.db.get_task("task-err")
        self.assertEqual(requeued["status"], "queued")
        self.assertEqual(requeued["last_error_class"], "download_error")
        self.assertEqual(requeued["last_error"], "遗漏图片-42")

        # A later success clears the stale error via complete_task.
        self.db.complete_task("task-err", "succeeded")
        succeeded = self.db.get_task("task-err")
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertEqual(succeeded["last_error_class"], "")
        self.assertEqual(succeeded["last_error"], "")

        # retry_task (standalone manual retry) must preserve it too.
        self.db.create_task({**task_values(self.root), "id": "task-solo"})
        self.assertTrue(self.db.claim_task("task-solo"))
        solo_attempt = self.db.begin_attempt("task-solo")
        self.db.complete_task(
            "task-solo",
            "failed",
            exit_code=1,
            error_class="http_error",
            error_message="断点丢图-7",
            expected_attempt_id=solo_attempt["id"],
        )
        self.db.retry_task("task-solo", 1)
        solo = self.db.get_task("task-solo")
        self.assertEqual(solo["status"], "queued")
        self.assertEqual(solo["last_error_class"], "http_error")
        self.assertEqual(solo["last_error"], "断点丢图-7")

        self.db.complete_task("task-solo", "succeeded")
        solo_done = self.db.get_task("task-solo")
        self.assertEqual(solo_done["last_error_class"], "")
        self.assertEqual(solo_done["last_error"], "")

    def test_retry_replans_address_that_failed_planning_with_zero_tasks(self):
        # B2: planning failed before any media task existed, so there is nothing to
        # requeue at the task level; retry must re-plan the address instead.
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-replan-zero",
                "output_dir": str(self.root / "batch-replan-zero"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-replan-zero",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/9/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-replan-zero"))
        self.db.fail_crawl_address("address-replan-zero", "discovery exploded")
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))

        finished = self.db.get_crawl_batch(batch_id)
        self.assertEqual(finished["status"], "completed_with_errors")
        self.assertEqual(finished["failed_task_count"], 0)
        address = finished["sources"][0]["addresses"][0]
        self.assertEqual(address["status"], "failed")
        self.assertEqual(address["planning_error"], "discovery exploded")
        # Resumable purely because of the planning gap (no failed/cancelled tasks).
        self.assertTrue(finished["resumable"])

        result = self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=1)
        self.assertEqual(result["retried_count"], 0)
        self.assertEqual(result["replanned_address_count"], 1)
        self.assertEqual(result["replanned_address_ids"], ["address-replan-zero"])

        reactivated = self.db.get_crawl_batch(batch_id)
        self.assertEqual(reactivated["status"], "running")
        replanned = reactivated["sources"][0]["addresses"][0]
        self.assertEqual(replanned["status"], "pending")
        self.assertEqual(replanned["planning_error"], "")
        self.assertEqual(replanned["last_error"], "")
        self.assertIsNone(replanned["started_at"])
        self.assertIsNone(replanned["finished_at"])

    def test_retry_replans_partially_planned_address(self):
        # B3: planning threw after linking one task; that task even SUCCEEDS, so the
        # address looks complete at the task level but silently dropped un-planned units.
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-replan-partial",
                "output_dir": str(self.root / "batch-replan-partial"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-replan-partial",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/10/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-replan-partial"))
        self.db.create_task({**task_values(self.root), "id": "task-partial"})
        self.db.link_crawl_task("address-replan-partial", "task-partial", 1)
        self.assertTrue(
            self.db.mark_crawl_address_running(
                "address-replan-partial",
                last_error="planning interrupted",
                planning_error="planning interrupted",
            )
        )
        self.db.complete_task("task-partial", "succeeded")
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-replan-partial"))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))

        finished = self.db.get_crawl_batch(batch_id)
        address = finished["sources"][0]["addresses"][0]
        # Terminal 'failed' via planning_error even though its media task succeeded.
        self.assertEqual(address["status"], "failed")
        self.assertEqual(address["planning_error"], "planning interrupted")
        self.assertEqual(finished["failed_task_count"], 0)
        self.assertEqual(finished["succeeded_task_count"], 1)
        self.assertTrue(finished["resumable"])

        result = self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=1)
        self.assertEqual(result["retried_count"], 0)
        self.assertEqual(result["replanned_address_count"], 1)

        reactivated = self.db.get_crawl_batch(batch_id)
        self.assertEqual(reactivated["status"], "running")
        replanned = reactivated["sources"][0]["addresses"][0]
        self.assertEqual(replanned["status"], "pending")
        self.assertEqual(replanned["planning_error"], "")
        # The already-succeeded task stays attached for idempotent re-planning.
        linked = self.db.crawl_address_tasks("address-replan-partial")
        self.assertEqual([task["id"] for task in linked], ["task-partial"])
        self.assertEqual(linked[0]["status"], "succeeded")

    def test_retry_requeues_tasks_without_replanning_fully_planned_address(self):
        # Fully planned (planning_error==''), only a media task failed: requeue the task
        # but do NOT reset the address to 'pending' (no needless re-discovery).
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-noreplan",
                "output_dir": str(self.root / "batch-noreplan"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-noreplan",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/11/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-noreplan"))
        self.db.create_task({**task_values(self.root), "id": "task-noreplan"})
        self.db.link_crawl_task("address-noreplan", "task-noreplan", 1)
        self.assertTrue(self.db.mark_crawl_address_running("address-noreplan"))
        self.assertTrue(self.db.claim_task("task-noreplan"))
        attempt = self.db.begin_attempt("task-noreplan")
        self.db.complete_task(
            "task-noreplan",
            "failed",
            exit_code=1,
            error_class="download_error",
            error_message="boom",
            expected_attempt_id=attempt["id"],
        )
        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-noreplan"))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))

        finished = self.db.get_crawl_batch(batch_id)
        address = finished["sources"][0]["addresses"][0]
        self.assertEqual(address["status"], "failed")
        self.assertEqual(address["planning_error"], "")
        self.assertTrue(finished["resumable"])

        result = self.db.retry_failed_crawl_tasks(batch_id, additional_attempts=1)
        self.assertEqual(result["retried_count"], 1)
        self.assertEqual(result["replanned_address_count"], 0)
        self.assertEqual(result["replanned_address_ids"], [])

        reactivated = self.db.get_crawl_batch(batch_id)
        self.assertEqual(reactivated["status"], "running")
        address = reactivated["sources"][0]["addresses"][0]
        # Requeued via the task path (status 'running'), NOT re-planned ('pending').
        self.assertEqual(address["status"], "running")
        self.assertEqual(self.db.get_task("task-noreplan")["status"], "queued")

    def test_crawl_address_task_count(self):
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-count",
                "output_dir": str(self.root / "batch-count"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "addr-count",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=x",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertEqual(self.db.crawl_address_task_count("addr-count"), 0)
        for i in range(3):
            self.db.create_task({**task_values(self.root), "id": f"ct-{i}"})
            self.db.link_crawl_task("addr-count", f"ct-{i}", i + 1)
        self.assertEqual(self.db.crawl_address_task_count("addr-count"), 3)
        self.assertEqual(self.db.crawl_batch_task_count(batch_id), 3)

    def test_ordered_crawl_recovery_resets_only_planning_address(self):
        self.db.create_crawl_batch(
            {
                "id": "batch-recovery",
                "output_dir": str(self.root / "batch"),
                "concurrency": 20,
                "max_tasks": 100,
            },
            [
                {
                    "id": "address-recovery",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "prefer",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-recovery"))
        self.assertEqual(self.db.recover_ordered_crawls(), 1)
        self.assertEqual(self.db.next_crawl_address("batch-recovery")["status"], "pending")

    def test_pre_dedup_uses_only_successful_danbooru_tasks_in_the_same_batch(self):
        self.db.create_crawl_batch(
            {
                "id": "batch-dedup",
                "output_dir": str(self.root / "batch"),
                "concurrency": 20,
                "max_tasks": 100,
            },
            [
                {
                    "id": "address-danbooru",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
                {
                    "id": "address-pixiv",
                    "site": "pixiv",
                    "source_order": 1,
                    "address_order": 0,
                    "url": "https://www.pixiv.net/users/1/artworks",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-danbooru"))
        for task_id, source_key, status in (
            ("dan-success", "pixiv:100", "succeeded"),
            ("dan-failed", "twitter:200", "failed"),
        ):
            self.db.create_task(
                {
                    **task_values(self.root),
                    "id": task_id,
                    "site": "danbooru",
                    "url": f"https://danbooru.donmai.us/posts/{task_id}",
                }
            )
            self.db.link_crawl_task(
                "address-danbooru",
                task_id,
                1 if status == "succeeded" else 2,
                source_key=source_key,
                source_url="https://SOURCE",
            )
            self.db.complete_task(task_id, status)
        self.assertTrue(self.db.mark_crawl_address_running("address-danbooru"))
        self.assertEqual(
            self.db.succeeded_danbooru_source_keys(
                "batch-dedup",
                {"pixiv:100", "twitter:200", "pixiv:300"},
            ),
            {"pixiv:100"},
        )
        self.assertEqual(
            self.db.succeeded_danbooru_source_keys("other-batch", {"pixiv:100"}),
            set(),
        )
        self.assertEqual(
            self.db.succeeded_danbooru_source_key_count("batch-dedup", "pixiv"),
            1,
        )
        self.assertEqual(
            self.db.succeeded_danbooru_source_key_count("batch-dedup", "twitter"),
            0,
        )

        self.assertTrue(self.db.finish_crawl_address_if_terminal("address-danbooru"))
        self.assertTrue(self.db.begin_crawl_address_planning("address-pixiv"))
        self.assertTrue(
            self.db.finish_crawl_address_as_pre_deduplicated("address-pixiv", 3)
        )
        self.assertTrue(self.db.finish_crawl_batch_if_ready("batch-dedup"))
        batch = self.db.get_crawl_batch("batch-dedup")
        pixiv = batch["sources"][1]["addresses"][0]
        self.assertEqual(pixiv["status"], "succeeded")
        self.assertEqual(pixiv["planned_task_count"], 0)
        self.assertEqual(pixiv["pre_dedup_skipped_count"], 3)
        self.assertEqual(batch["pre_dedup_skipped_count"], 3)

    def test_ordered_crawl_recovery_drains_partially_linked_address(self):
        self.db.create_crawl_batch(
            {
                "id": "batch-linked-recovery",
                "output_dir": str(self.root / "batch"),
                "concurrency": 20,
                "max_tasks": 100,
            },
            [
                {
                    "id": "address-linked-recovery",
                    "site": "twitter",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://x.com/artist/media",
                    "proxy_mode": "prefer",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-linked-recovery"))
        self.db.create_task(task_values(self.root))
        self.db.link_crawl_task("address-linked-recovery", "task-1", 1)

        self.assertEqual(self.db.recover_ordered_crawls(), 1)
        address = self.db.next_crawl_address("batch-linked-recovery")
        self.assertEqual(address["status"], "running")
        self.assertEqual(address["planned_task_count"], 1)
        self.assertIn("部分规划", address["last_error"])

        self.db.complete_task("task-1", "succeeded")
        self.assertTrue(self.db.finish_crawl_address_if_terminal(address["id"]))
        batch = self.db.get_crawl_batch("batch-linked-recovery")
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "failed")

    def test_new_crawl_requires_explicit_review_start_after_terminal(self):
        batch_id = "batch-review-queue"
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.root / batch_id),
                "concurrency": 1,
                "max_tasks": 10,
            },
            crawl_address_values(batch_id),
        )

        self.assertIsNone(self.db.get_crawl_review(batch_id))
        self.assertIsNone(self.db.claim_next_crawl_review())
        with self.assertRaisesRegex(RuntimeError, "结束后"):
            self.db.start_crawl_review(batch_id)

        address_id = f"{batch_id}-address"
        self.assertTrue(self.db.begin_crawl_address_planning(address_id))
        self.assertTrue(self.db.finish_crawl_address_as_pre_deduplicated(address_id, 0))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))
        self.assertIsNone(self.db.get_crawl_review(batch_id))
        self.assertIsNone(self.db.claim_next_crawl_review())

        review = self.db.start_crawl_review(batch_id)
        self.assertEqual(review["status"], "pending")
        self.assertEqual(
            self.db.start_crawl_review(batch_id)["created_at"],
            review["created_at"],
        )
        claimed = self.db.claim_next_crawl_review()
        self.assertEqual(claimed["batch_id"], batch_id)

    def test_legacy_waiting_review_is_not_claimed_until_explicit_start(self):
        batch_id = "batch-review-legacy-waiting"
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.root / batch_id),
                "concurrency": 1,
                "max_tasks": 10,
            },
            crawl_address_values(batch_id),
        )
        address_id = f"{batch_id}-address"
        self.assertTrue(self.db.begin_crawl_address_planning(address_id))
        self.assertTrue(self.db.finish_crawl_address_as_pre_deduplicated(address_id, 0))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))

        with self.db._transaction() as conn:
            conn.execute(
                """
                INSERT INTO crawl_reviews(batch_id, status, created_at, updated_at)
                VALUES (?, 'waiting_for_crawl', 1, 1)
                """,
                (batch_id,),
            )
        self.assertIsNone(self.db.claim_next_crawl_review())
        self.assertEqual(self.db.get_crawl_review(batch_id)["status"], "waiting_for_crawl")
        self.assertEqual(self.db.start_crawl_review(batch_id)["status"], "pending")
        self.assertEqual(self.db.claim_next_crawl_review()["batch_id"], batch_id)

    def test_historical_terminal_review_is_registered_only_by_explicit_start(self):
        batch_ids = ("batch-review-history-a", "batch-review-history-b")
        for batch_id in batch_ids:
            self.db.create_crawl_batch(
                {
                    "id": batch_id,
                    "output_dir": str(self.root / batch_id),
                    "concurrency": 1,
                    "max_tasks": 10,
                },
                crawl_address_values(batch_id),
            )
            address_id = f"{batch_id}-address"
            self.assertTrue(self.db.begin_crawl_address_planning(address_id))
            self.assertTrue(self.db.finish_crawl_address_as_pre_deduplicated(address_id, 0))
            self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))

        self.assertIsNone(self.db.claim_next_crawl_review())
        review = self.db.start_crawl_review(batch_ids[0])
        self.assertEqual(review["status"], "pending")
        self.assertIsNone(self.db.get_crawl_review(batch_ids[1]))
        self.assertEqual(
            self.db.start_crawl_review(batch_ids[0])["created_at"],
            review["created_at"],
        )

    def test_link_crawl_task_keeps_existing_link_on_relink(self):
        # Re-planning re-links the SAME (address, task) under a shifted sequence_no; the
        # original row must stay untouched (no churn, no duplicate).
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-relink",
                "output_dir": str(self.root / "batch-relink"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "addr-relink",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.db.create_task({**task_values(self.root), "id": "task-relink"})
        self.db.link_crawl_task("addr-relink", "task-relink", 1)
        self.db.link_crawl_task("addr-relink", "task-relink", 5)
        linked = self.db.crawl_address_tasks("addr-relink")
        self.assertEqual([task["id"] for task in linked], ["task-relink"])
        self.assertEqual(linked[0]["sequence_no"], 1)
        self.assertEqual(self.db.crawl_address_task_count("addr-relink"), 1)

    def test_link_crawl_task_appends_new_task_on_sequence_collision(self):
        # A NEW work prepended on re-plan requests a sequence_no already owned by an old
        # task. INSERT OR IGNORE (the old bug) would silently drop the link; the fix must
        # append the new task at MAX+1 so it stays visible to counts / completion.
        batch_id, _ = self.db.create_crawl_batch(
            {
                "id": "batch-collision",
                "output_dir": str(self.root / "batch-collision"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "addr-collision",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.db.create_task({**task_values(self.root), "id": "task-old"})
        self.db.link_crawl_task("addr-collision", "task-old", 1)
        self.db.create_task({**task_values(self.root), "id": "task-new"})
        self.db.link_crawl_task("addr-collision", "task-new", 1)
        linked = self.db.crawl_address_tasks("addr-collision")
        self.assertEqual({task["id"] for task in linked}, {"task-old", "task-new"})
        self.assertEqual(self.db.crawl_address_task_count("addr-collision"), 2)
        sequences = {task["id"]: task["sequence_no"] for task in linked}
        self.assertEqual(sequences["task-old"], 1)
        self.assertEqual(sequences["task-new"], 2)
        self.assertEqual(self.db.crawl_batch_task_count(batch_id), 2)

    def _settle_task(self, task_id, status):
        if status == "succeeded":
            self.db.complete_task(task_id, "succeeded")
            return
        self.assertTrue(self.db.claim_task(task_id))
        attempt = self.db.begin_attempt(task_id)
        if status == "cancelled":
            self.db.request_cancel(task_id)
            self.db.complete_task(
                task_id,
                "cancelled",
                exit_code=1,
                error_class="cancelled",
                error_message="cancelled",
                expected_attempt_id=attempt["id"],
            )
        else:
            self.db.complete_task(
                task_id,
                "failed",
                exit_code=1,
                error_class="download_error",
                error_message=f"boom-{task_id}",
                expected_attempt_id=attempt["id"],
            )

    def _build_terminal_batch(self, batch_id, task_specs):
        # task_specs: list of (task_id, status). Builds one address holding those tasks
        # and drives the batch to a terminal status.
        address_id = f"{batch_id}-addr"
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.root / batch_id),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": address_id,
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/1/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.db.begin_crawl_address_planning(address_id))
        for sequence_no, (task_id, _status) in enumerate(task_specs, start=1):
            self.db.create_task({**task_values(self.root), "id": task_id})
            self.db.link_crawl_task(address_id, task_id, sequence_no)
        self.assertTrue(self.db.mark_crawl_address_running(address_id))
        for task_id, status in task_specs:
            self._settle_task(task_id, status)
        self.assertTrue(self.db.finish_crawl_address_if_terminal(address_id))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))
        return address_id

    def test_rerun_resets_addresses_and_keeps_succeeded_tasks(self):
        address_id = self._build_terminal_batch(
            "batch-rerun-ok", [("rk-1", "succeeded"), ("rk-2", "succeeded")]
        )
        self.assertEqual(self.db.get_crawl_batch("batch-rerun-ok")["status"], "succeeded")

        result = self.db.rerun_crawl_batch("batch-rerun-ok")
        self.assertEqual(result["requeued_task_count"], 0)
        self.assertEqual(result["task_ids"], [])
        self.assertEqual(result["replanned_address_count"], 1)
        self.assertEqual(result["replanned_address_ids"], [address_id])
        self.assertFalse(result["requeue_succeeded"])

        reactivated = self.db.get_crawl_batch("batch-rerun-ok")
        self.assertEqual(reactivated["status"], "running")
        address = reactivated["sources"][0]["addresses"][0]
        self.assertEqual(address["status"], "pending")
        self.assertEqual(address["planning_error"], "")
        self.assertEqual(address["last_error"], "")
        self.assertIsNone(address["started_at"])
        self.assertIsNone(address["finished_at"])
        # Succeeded tasks are untouched so idempotent re-planning skips them (no re-download).
        self.assertEqual(self.db.get_task("rk-1")["status"], "succeeded")
        self.assertEqual(self.db.get_task("rk-2")["status"], "succeeded")

    def test_rerun_requeues_failed_and_cancelled_preserving_last_error(self):
        self._build_terminal_batch(
            "batch-rerun-mixed",
            [("mk-ok", "succeeded"), ("mk-fail", "failed"), ("mk-cancel", "cancelled")],
        )
        self.assertEqual(
            self.db.get_crawl_batch("batch-rerun-mixed")["status"],
            "completed_with_errors",
        )

        result = self.db.rerun_crawl_batch("batch-rerun-mixed", additional_attempts=2)
        self.assertEqual(result["requeued_task_count"], 2)
        self.assertEqual(set(result["task_ids"]), {"mk-fail", "mk-cancel"})
        self.assertEqual(result["replanned_address_count"], 1)

        reactivated = self.db.get_crawl_batch("batch-rerun-mixed")
        self.assertEqual(reactivated["status"], "running")
        self.assertEqual(reactivated["sources"][0]["addresses"][0]["status"], "pending")

        failed = self.db.get_task("mk-fail")
        self.assertEqual(failed["status"], "queued")
        # backoff anchored to the prior attempt_count (1), budget grown by 2.
        self.assertEqual(failed["backoff_anchor_attempt"], 1)
        self.assertEqual(failed["max_attempts"], 3)
        self.assertEqual(failed["last_error_class"], "download_error")
        self.assertEqual(failed["last_error"], "boom-mk-fail")

        cancelled = self.db.get_task("mk-cancel")
        self.assertEqual(cancelled["status"], "queued")
        self.assertFalse(cancelled["cancel_requested"])
        self.assertEqual(cancelled["backoff_anchor_attempt"], 1)

        self.assertEqual(self.db.get_task("mk-ok")["status"], "succeeded")

    def test_rerun_with_requeue_succeeded_requeues_succeeded_tasks(self):
        self._build_terminal_batch(
            "batch-rerun-all", [("ak-1", "succeeded"), ("ak-2", "succeeded")]
        )
        result = self.db.rerun_crawl_batch("batch-rerun-all", requeue_succeeded=True)
        self.assertEqual(result["requeued_task_count"], 2)
        self.assertTrue(result["requeue_succeeded"])
        self.assertEqual(set(result["task_ids"]), {"ak-1", "ak-2"})
        self.assertEqual(self.db.get_task("ak-1")["status"], "queued")
        self.assertEqual(self.db.get_task("ak-2")["status"], "queued")

    def test_rerun_rejects_running_batch_and_unknown_batch(self):
        self.assertIsNone(self.db.rerun_crawl_batch("does-not-exist"))
        self.db.create_crawl_batch(
            {
                "id": "batch-rerun-live",
                "output_dir": str(self.root / "batch-rerun-live"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            crawl_address_values("batch-rerun-live"),
        )
        # Activate the address so the batch is genuinely 'running', not terminal.
        self.assertTrue(self.db.begin_crawl_address_planning("batch-rerun-live-address"))
        self.assertEqual(self.db.get_crawl_batch("batch-rerun-live")["status"], "running")
        self.assertEqual(
            self.db.rerun_crawl_batch("batch-rerun-live"),
            {"batch_id": "batch-rerun-live", "not_terminal": True},
        )

    def test_schema_v1_reopen_creates_ordered_crawl_tables(self):
        path = self.root / "legacy.sqlite3"
        legacy = Database(path)
        with legacy._transaction() as conn:
            conn.execute("DROP TABLE crawl_address_proxy_nodes")
            conn.execute("DROP TABLE crawl_address_proxy_probes")
            conn.execute("DROP TABLE crawl_task_source_keys")
            conn.execute("DROP TABLE crawl_address_tasks")
            conn.execute("DROP TABLE crawl_addresses")
            conn.execute("DROP TABLE crawl_batches")
            conn.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
        legacy.close()

        upgraded = Database(path)
        try:
            version = upgraded._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in upgraded._conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            address_columns = {
                row[1]
                for row in upgraded._conn.execute(
                    "PRAGMA table_info(crawl_addresses)"
                ).fetchall()
            }
            review_columns = {
                row[1]
                for row in upgraded._conn.execute(
                    "PRAGMA table_info(crawl_reviews)"
                ).fetchall()
            }
            self.assertEqual(version, "8")
            self.assertIn("download_options_json", address_columns)
            self.assertIn("pre_dedup_skipped_count", address_columns)
            self.assertIn("automatic_group_count", review_columns)
            self.assertIn("automatic_rejected_image_count", review_columns)
            self.assertTrue(
                {
                    "crawl_batches",
                    "crawl_addresses",
                    "crawl_address_tasks",
                    "crawl_task_source_keys",
                    "crawl_address_proxy_probes",
                    "crawl_address_proxy_nodes",
                    "crawl_reviews",
                    "crawl_review_groups",
                    "crawl_review_images",
                }.issubset(tables)
            )
        finally:
            upgraded.close()

    def test_site_policy_v8_migration_clears_old_rows_once_then_preserves_new_rows(self):
        path = self.root / "site-policy-v7.sqlite3"
        legacy = Database(path)
        with legacy._transaction() as conn:
            conn.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at)
                VALUES (?, ?, ?)
                """,
                (
                    "pixiv",
                    '{"max_concurrency":3,"retry_limit":1,'
                    '"backoff_base_seconds":0.5,"proxy_mode":"required",'
                    '"http_timeout":1,"extra_args":["--legacy"]}',
                    1.0,
                ),
            )
            conn.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at)
                VALUES (?, ?, ?)
                """,
                ("unknown-old-site", '{"secret":"legacy"}', 1.0),
            )
            conn.execute("UPDATE meta SET value='7' WHERE key='schema_version'")
        legacy.close()

        upgraded = Database(path)
        self.assertEqual(upgraded.list_site_policies(), [])
        self.assertEqual(
            upgraded._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0],
            "8",
        )
        current = site_policy_values(max_concurrency=7, proxy_mode="direct")
        upgraded.put_site_policy("pixiv", current)
        upgraded.close()

        restarted = Database(path)
        try:
            self.assertEqual(
                restarted.get_site_policy("pixiv")["policy"],
                current,
            )
            self.assertEqual(
                restarted._conn.execute(
                    "SELECT value FROM meta WHERE key='schema_version'"
                ).fetchone()[0],
                "8",
            )
        finally:
            restarted.close()


if __name__ == "__main__":
    unittest.main()
