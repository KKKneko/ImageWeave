from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .file_security import ensure_private_directory, secure_sqlite_files
from .redaction import redact_data, redact_text
from .site_policy import EditableSitePolicy


CURRENT_SCHEMA_VERSION = 8
SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION = 8
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
ACTIVE_STATUSES = {"starting", "running", "cancelling"}
TERMINAL_BATCH_STATUSES = {"succeeded", "completed_with_errors", "cancelled"}


class Database:
    def __init__(self, path: Path, *, max_logs_per_task: int = 5000) -> None:
        # 不先 resolve 叶节点，否则 SQLite 文件符号链接会被静默解引用。
        self.path = Path(os.path.abspath(os.fspath(path)))
        # 已存在的自定义外部父目录保持用户权限；新目录仍以 0700 创建。
        ensure_private_directory(self.path.parent, repair_existing=False)
        secure_sqlite_files(self.path)
        self.max_logs_per_task = max(100, int(max_logs_per_task))
        self._since_prune: dict[str, int] = {}
        self._lock = threading.RLock()
        self._reader_local = threading.local()
        self._reader_registry: list[sqlite3.Connection] = []
        self._reader_registry_lock = threading.Lock()
        # `_conn` 始终是唯一写连接；所有写事务继续由 `_transaction()` 串行化。
        self._conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._initialize()
        secure_sqlite_files(self.path)

    def _initialize(self) -> None:
        # 先读取持久版本，再创建缺失结构；不能在数据迁移前提前抬高版本号。
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
            """
        )
        raw_version = self._conn.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        try:
            schema_version = int(raw_version[0])
        except (TypeError, ValueError, IndexError) as exc:
            raise RuntimeError("SQLite schema_version 无效") from exc
        if not 1 <= schema_version <= CURRENT_SCHEMA_VERSION:
            raise RuntimeError(
                f"SQLite schema_version={schema_version} 不受当前后端支持"
            )

        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT UNIQUE,
                url TEXT NOT NULL,
                site TEXT NOT NULL,
                subcategory TEXT NOT NULL DEFAULT '',
                extractor TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                output_dir TEXT NOT NULL,
                proxy_mode TEXT NOT NULL,
                max_attempts INTEGER NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                backoff_anchor_attempt INTEGER NOT NULL DEFAULT 0,
                next_run_at REAL NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                pid INTEGER,
                process_marker TEXT,
                exit_code INTEGER,
                last_error_class TEXT NOT NULL DEFAULT '',
                last_error TEXT NOT NULL DEFAULT '',
                cookies_file TEXT,
                config_file TEXT,
                credentials_ref TEXT,
                extra_args_json TEXT NOT NULL DEFAULT '[]',
                policy_json TEXT NOT NULL DEFAULT '{}',
                tried_proxy_ids_json TEXT NOT NULL DEFAULT '[]',
                artifact_count INTEGER NOT NULL DEFAULT 0,
                artifact_bytes INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_queue
                ON tasks(status, next_run_at, priority, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_site_status
                ON tasks(site, status);

            CREATE TABLE IF NOT EXISTS attempts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                attempt_no INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL,
                exit_code INTEGER,
                proxy_node_id TEXT,
                proxy_endpoint TEXT,
                error_class TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                retryable INTEGER NOT NULL DEFAULT 0,
                pid INTEGER,
                process_marker TEXT,
                UNIQUE(task_id, attempt_no)
            );
            CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);

            CREATE TABLE IF NOT EXISTS leases (
                task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                site TEXT NOT NULL,
                acquired_at REAL NOT NULL,
                heartbeat_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                attempt_id TEXT,
                ts REAL NOT NULL,
                stream TEXT NOT NULL,
                line TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_logs_task_id ON task_logs(task_id, id);

            CREATE TABLE IF NOT EXISTS task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                ts REAL NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id, id);

            CREATE TABLE IF NOT EXISTS site_policies (
                site TEXT PRIMARY KEY,
                policy_json TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS crawl_batches (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT UNIQUE,
                status TEXT NOT NULL,
                output_dir TEXT NOT NULL,
                concurrency INTEGER NOT NULL,
                max_tasks INTEGER NOT NULL,
                task_count INTEGER NOT NULL DEFAULT 0,
                succeeded_task_count INTEGER NOT NULL DEFAULT 0,
                failed_task_count INTEGER NOT NULL DEFAULT 0,
                cancelled_task_count INTEGER NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL,
                last_error TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_batches_status
                ON crawl_batches(status, created_at);

            CREATE TABLE IF NOT EXISTS crawl_addresses (
                id TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
                site TEXT NOT NULL,
                source_order INTEGER NOT NULL,
                address_order INTEGER NOT NULL,
                url TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                address_type TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                proxy_mode TEXT NOT NULL,
                max_attempts INTEGER NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                credentials_ref TEXT,
                cookies_file TEXT,
                config_file TEXT,
                download_options_json TEXT NOT NULL DEFAULT '{}',
                extra_args_json TEXT NOT NULL DEFAULT '[]',
                discovery_args_json TEXT NOT NULL DEFAULT '[]',
                timeout_seconds REAL NOT NULL DEFAULT 180,
                planned_task_count INTEGER NOT NULL DEFAULT 0,
                pre_dedup_skipped_count INTEGER NOT NULL DEFAULT 0,
                succeeded_task_count INTEGER NOT NULL DEFAULT 0,
                failed_task_count INTEGER NOT NULL DEFAULT 0,
                cancelled_task_count INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL,
                last_error TEXT NOT NULL DEFAULT '',
                planning_error TEXT NOT NULL DEFAULT '',
                UNIQUE(batch_id, source_order, address_order)
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_addresses_batch_order
                ON crawl_addresses(batch_id, source_order, address_order);
            CREATE INDEX IF NOT EXISTS idx_crawl_addresses_status
                ON crawl_addresses(status, updated_at);

            CREATE TABLE IF NOT EXISTS crawl_address_tasks (
                address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
                sequence_no INTEGER NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY(address_id, task_id),
                UNIQUE(address_id, sequence_no)
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_address_tasks_address
                ON crawl_address_tasks(address_id, sequence_no);

            CREATE TABLE IF NOT EXISTS crawl_task_source_keys (
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                source_key TEXT NOT NULL,
                source_url TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                PRIMARY KEY(task_id, source_key)
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_task_source_keys_key
                ON crawl_task_source_keys(source_key);

            CREATE TABLE IF NOT EXISTS crawl_address_proxy_probes (
                address_id TEXT PRIMARY KEY REFERENCES crawl_addresses(id) ON DELETE CASCADE,
                target_url TEXT NOT NULL,
                total_count INTEGER NOT NULL,
                healthy_count INTEGER NOT NULL,
                checked_at REAL NOT NULL,
                last_error TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS crawl_address_proxy_nodes (
                address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                PRIMARY KEY(address_id, node_id)
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_address_proxy_nodes_address
                ON crawl_address_proxy_nodes(address_id);

            CREATE TABLE IF NOT EXISTS crawl_reviews (
                batch_id TEXT PRIMARY KEY REFERENCES crawl_batches(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                total_image_count INTEGER NOT NULL DEFAULT 0,
                total_group_count INTEGER NOT NULL DEFAULT 0,
                duplicate_group_count INTEGER NOT NULL DEFAULT 0,
                unreadable_image_count INTEGER NOT NULL DEFAULT 0,
                automatic_group_count INTEGER NOT NULL DEFAULT 0,
                automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0,
                kept_image_count INTEGER NOT NULL DEFAULT 0,
                rejected_image_count INTEGER NOT NULL DEFAULT 0,
                failed_image_count INTEGER NOT NULL DEFAULT 0,
                error TEXT NOT NULL DEFAULT '',
                analysis_log_path TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                started_at REAL,
                ready_at REAL,
                applied_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_reviews_status
                ON crawl_reviews(status, created_at);

            CREATE TABLE IF NOT EXISTS crawl_review_groups (
                batch_id TEXT NOT NULL,
                id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                kind TEXT NOT NULL,
                match_levels_json TEXT NOT NULL DEFAULT '[]',
                reason TEXT NOT NULL DEFAULT '',
                decided INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(batch_id, id),
                UNIQUE(batch_id, ordinal),
                FOREIGN KEY(batch_id) REFERENCES crawl_reviews(batch_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_review_groups_order
                ON crawl_review_groups(batch_id, kind, ordinal);

            CREATE TABLE IF NOT EXISTS crawl_review_images (
                batch_id TEXT NOT NULL,
                id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                relative_path TEXT NOT NULL,
                file_hash TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                readable INTEGER NOT NULL DEFAULT 1,
                recommended INTEGER NOT NULL DEFAULT 0,
                selected INTEGER NOT NULL DEFAULT 1,
                disposition TEXT NOT NULL DEFAULT 'pending',
                final_relative_path TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(batch_id, id),
                UNIQUE(batch_id, relative_path),
                FOREIGN KEY(batch_id, group_id)
                    REFERENCES crawl_review_groups(batch_id, id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crawl_review_images_group
                ON crawl_review_images(batch_id, group_id, ordinal);
            CREATE INDEX IF NOT EXISTS idx_crawl_review_images_selection
                ON crawl_review_images(batch_id, selected, disposition);
            """
        )
        address_columns = {
            str(row["name"])
            for row in self._conn.execute("PRAGMA table_info(crawl_addresses)").fetchall()
        }
        if "download_options_json" not in address_columns:
            self._conn.execute(
                "ALTER TABLE crawl_addresses ADD COLUMN "
                "download_options_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "pre_dedup_skipped_count" not in address_columns:
            self._conn.execute(
                "ALTER TABLE crawl_addresses ADD COLUMN "
                "pre_dedup_skipped_count INTEGER NOT NULL DEFAULT 0"
            )
        if "planning_error" not in address_columns:
            self._conn.execute(
                "ALTER TABLE crawl_addresses ADD COLUMN "
                "planning_error TEXT NOT NULL DEFAULT ''"
            )
        review_columns = {
            str(row["name"])
            for row in self._conn.execute("PRAGMA table_info(crawl_reviews)").fetchall()
        }
        if "automatic_group_count" not in review_columns:
            self._conn.execute(
                "ALTER TABLE crawl_reviews ADD COLUMN "
                "automatic_group_count INTEGER NOT NULL DEFAULT 0"
            )
        if "automatic_rejected_image_count" not in review_columns:
            self._conn.execute(
                "ALTER TABLE crawl_reviews ADD COLUMN "
                "automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0"
            )
        task_columns = {
            str(row["name"])
            for row in self._conn.execute("PRAGMA table_info(tasks)").fetchall()
        }
        if "backoff_anchor_attempt" not in task_columns:
            self._conn.execute(
                "ALTER TABLE tasks ADD COLUMN "
                "backoff_anchor_attempt INTEGER NOT NULL DEFAULT 0"
            )

        if schema_version < SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION:
            # v8 产品迁移：旧行可能带高级字段，必须与版本标记在同一事务中
            # 一次性清除。提交 v8 后新建的四字段覆盖在后续启动中会保留。
            with self._transaction() as conn:
                conn.execute("DELETE FROM site_policies")
                conn.execute(
                    "UPDATE meta SET value=? WHERE key='schema_version'",
                    (str(CURRENT_SCHEMA_VERSION),),
                )

    def _reader(self) -> sqlite3.Connection:
        conn = getattr(self._reader_local, "connection", None)
        if conn is not None:
            return conn
        conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=10000")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA query_only=ON")
        except Exception:
            conn.close()
            raise
        with self._reader_registry_lock:
            self._reader_registry.append(conn)
        self._reader_local.connection = conn
        return conn

    # 可见性铁律：任何需要观察“当前未提交事务写入”的读，必须使用
    # `_transaction()` 产出的 `conn`，绝不能调用基于 `_read()` 的公开方法。
    # WAL 下读连接只能看到已提交快照。
    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        yield self._reader()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except Exception:
                # Never let a rollback error (e.g. SQLite already auto-rolled-back,
                # "no transaction is active") replace the original exception the
                # caller is trying to classify.
                if self._conn.in_transaction:
                    try:
                        self._conn.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                raise
            else:
                try:
                    self._conn.execute("COMMIT")
                except sqlite3.Error:
                    # A failed COMMIT (disk full, I/O error) otherwise leaves the
                    # shared connection stuck inside the transaction, so every later
                    # BEGIN IMMEDIATE fails with "cannot start a transaction within a
                    # transaction" until the process restarts. Roll back and re-raise.
                    if self._conn.in_transaction:
                        try:
                            self._conn.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                    raise

    @staticmethod
    def _task(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        for key, default in (
            ("extra_args_json", []),
            ("policy_json", {}),
            ("tried_proxy_ids_json", []),
        ):
            target = key.removesuffix("_json")
            try:
                data[target] = json.loads(data.pop(key) or "null")
            except Exception:
                data[target] = default
                data.pop(key, None)
        data["cancel_requested"] = bool(data.get("cancel_requested"))
        return data

    @staticmethod
    def _attempt(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        data["retryable"] = bool(data.get("retryable"))
        return data

    @staticmethod
    def _crawl_batch(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        data["cancel_requested"] = bool(data.get("cancel_requested"))
        return data

    @staticmethod
    def _crawl_address(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        for key, default in (
            ("download_options_json", {}),
            ("extra_args_json", []),
            ("discovery_args_json", []),
        ):
            target = key.removesuffix("_json")
            try:
                data[target] = json.loads(data.pop(key) or "null")
            except Exception:
                data[target] = default
                data.pop(key, None)
        return data

    @staticmethod
    def _crawl_review(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return dict(row)

    @staticmethod
    def _crawl_review_group(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        try:
            data["match_levels"] = json.loads(data.pop("match_levels_json") or "[]")
        except Exception:
            data["match_levels"] = []
            data.pop("match_levels_json", None)
        data["decided"] = bool(data.get("decided"))
        return data

    @staticmethod
    def _crawl_review_image(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        try:
            data["metadata"] = json.loads(data.pop("metadata_json") or "{}")
        except Exception:
            data["metadata"] = {}
            data.pop("metadata_json", None)
        for key in ("readable", "recommended", "selected"):
            data[key] = bool(data.get(key))
        return data

    def close(self) -> None:
        with self._lock:
            self._conn.close()
        with self._reader_registry_lock:
            for conn in self._reader_registry:
                conn.close()
            self._reader_registry.clear()
        secure_sqlite_files(self.path)

    def ping(self) -> bool:
        with self._read() as conn:
            return conn.execute("SELECT 1").fetchone()[0] == 1

    def _event(self, conn: sqlite3.Connection, task_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        conn.execute(
            "INSERT INTO task_events(task_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)",
            (task_id, time.time(), event_type, json.dumps(redact_data(payload or {}), ensure_ascii=False)),
        )

    def create_task(self, values: dict[str, Any], *, idempotency_key: str | None = None) -> tuple[dict[str, Any], bool]:
        now = time.time()
        with self._transaction() as conn:
            if idempotency_key:
                existing = conn.execute(
                    "SELECT * FROM tasks WHERE idempotency_key=?", (idempotency_key,)
                ).fetchone()
                if existing is not None:
                    # 幂等命中只可能读取本事务开始前已提交的行，因此在这里调用基于
                    # `_read()` 的 `get_task()` 是安全的；它还能补齐
                    # `latest_attempt` 与 `lease`，保持和普通查询一致的返回形状。
                    return self.get_task(str(existing["id"])), False  # type: ignore[return-value]
            task_id = str(values.get("id") or uuid.uuid4())
            conn.execute(
                """
                INSERT INTO tasks(
                    id, idempotency_key, url, site, subcategory, extractor, status,
                    priority, output_dir, proxy_mode, max_attempts, attempt_count,
                    next_run_at, created_at, updated_at, cookies_file, config_file,
                    credentials_ref, extra_args_json, policy_json, tried_proxy_ids_json
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
                """,
                (
                    task_id,
                    idempotency_key,
                    values["url"],
                    values["site"],
                    values.get("subcategory", ""),
                    values.get("extractor", ""),
                    int(values.get("priority", 0)),
                    values["output_dir"],
                    values["proxy_mode"],
                    int(values["max_attempts"]),
                    now,
                    now,
                    now,
                    values.get("cookies_file"),
                    values.get("config_file"),
                    values.get("credentials_ref"),
                    json.dumps(values.get("extra_args", []), ensure_ascii=False),
                    json.dumps(values.get("policy", {}), ensure_ascii=False),
                ),
            )
            self._event(conn, task_id, "queued", {"site": values["site"]})
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            return self._task(row), True  # type: ignore[return-value]

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            task = self._task(row)
            if task is None:
                return None
            attempt = conn.execute(
                "SELECT * FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1", (task_id,)
            ).fetchone()
            task["latest_attempt"] = self._attempt(attempt)
            lease = conn.execute("SELECT * FROM leases WHERE task_id=?", (task_id,)).fetchone()
            task["lease"] = dict(lease) if lease else None
            return task

    def get_task_by_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT id FROM tasks WHERE idempotency_key=?", (key,)).fetchone()
        return self.get_task(row["id"]) if row else None

    def list_tasks(
        self,
        *,
        status: str | None = None,
        site: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status=?")
            params.append(status)
        if site:
            clauses.append("site=?")
            params.append(site)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        params.extend([max(1, min(int(limit), 500)), max(0, int(offset))])
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM tasks{where} ORDER BY created_at DESC LIMIT ? OFFSET ?", params
            ).fetchall()
            return [self._task(row) for row in rows]  # type: ignore[misc]

    def queued_tasks(
        self,
        limit: int = 100,
        exclude_sites: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        excluded = sorted(exclude_sites or ())[:64]
        site_filter = ""
        params: list[Any] = [time.time()]
        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            site_filter = f" AND site NOT IN ({placeholders})"
            params.extend(excluded)
        params.append(max(1, min(int(limit), 1000)))
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM tasks
                WHERE status='queued' AND cancel_requested=0 AND next_run_at<=?
                {site_filter}
                ORDER BY priority DESC, created_at ASC LIMIT ?
                """,
                params,
            ).fetchall()
            return [self._task(row) for row in rows]  # type: ignore[misc]

    def queued_task_ids(self, task_ids: set[str]) -> set[str]:
        ids = sorted(task_ids)
        if not ids:
            return set()
        queued: set[str] = set()
        now = time.time()
        with self._lock:
            for offset in range(0, len(ids), 63):
                chunk = ids[offset : offset + 63]
                placeholders = ",".join("?" for _ in chunk)
                rows = self._conn.execute(
                    f"""
                    SELECT id FROM tasks
                    WHERE status='queued' AND cancel_requested=0
                      AND next_run_at<=? AND id IN ({placeholders})
                    """,
                    (now, *chunk),
                ).fetchall()
                queued.update(str(row["id"]) for row in rows)
        return queued

    def mark_task_credentials_unavailable(self, task_id: str, site: str) -> bool:
        message = "站点托管授权已失效，等待在 VAULT.CPL 重新授权"
        now = time.time()
        with self._transaction() as conn:
            updated = conn.execute(
                """
                UPDATE tasks SET last_error_class='credentials_unavailable',
                    last_error=?, updated_at=?, version=version+1
                WHERE id=? AND status='queued' AND cancel_requested=0
                """,
                (redact_text(message, limit=2000), now, task_id),
            )
            if not updated.rowcount:
                return False
            self._event(
                conn,
                task_id,
                "credentials_unavailable",
                {"site": site},
            )
            return True

    def claim_task(self, task_id: str) -> bool:
        now = time.time()
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE tasks SET status='starting', updated_at=?,
                    started_at=COALESCE(started_at, ?), version=version+1
                WHERE id=? AND status='queued' AND cancel_requested=0
                """,
                (now, now, task_id),
            )
            if cur.rowcount:
                self._event(conn, task_id, "starting")
                return True
            return False

    def begin_attempt(self, task_id: str) -> dict[str, Any]:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise KeyError(task_id)
            if row["status"] != "starting":
                raise RuntimeError(f"任务状态不是 starting: {row['status']}")
            attempt_no = int(row["attempt_count"]) + 1
            attempt_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO attempts(id, task_id, attempt_no, status, started_at)
                VALUES (?, ?, ?, 'running', ?)
                """,
                (attempt_id, task_id, attempt_no, now),
            )
            conn.execute(
                """
                UPDATE tasks SET status='running', attempt_count=?, updated_at=?,
                    pid=NULL, process_marker=NULL, version=version+1 WHERE id=?
                """,
                (attempt_no, now, task_id),
            )
            self._event(conn, task_id, "attempt_started", {"attempt": attempt_no, "attempt_id": attempt_id})
            task = self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            return {"id": attempt_id, "attempt_no": attempt_no, "task": task}

    def set_process(self, task_id: str, attempt_id: str, pid: int, marker: str) -> None:
        now = time.time()
        with self._transaction() as conn:
            cur = conn.execute(
                "UPDATE attempts SET pid=?, process_marker=? WHERE id=? AND task_id=? AND status='running'",
                (int(pid), marker, attempt_id, task_id),
            )
            if cur.rowcount:
                conn.execute(
                    """
                    UPDATE tasks SET pid=?, process_marker=?, updated_at=?
                    WHERE id=? AND status='running' AND EXISTS (
                        SELECT 1 FROM attempts
                        WHERE attempts.id=? AND attempts.task_id=tasks.id AND attempts.status='running'
                    )
                    """,
                    (int(pid), marker, now, task_id, attempt_id),
                )
                self._event(conn, task_id, "process_started", {"pid": int(pid), "attempt_id": attempt_id})

    def finish_attempt(
        self,
        attempt_id: str,
        *,
        exit_code: int | None,
        status: str,
        error_class: str = "",
        error_message: str = "",
        retryable: bool = False,
        proxy_node_id: str | None = None,
        proxy_endpoint: str | None = None,
    ) -> None:
        with self._transaction() as conn:
            row = conn.execute("SELECT task_id, attempt_no FROM attempts WHERE id=?", (attempt_id,)).fetchone()
            if row is None:
                return
            cur = conn.execute(
                """
                UPDATE attempts SET status=?, finished_at=?, exit_code=?, proxy_node_id=?,
                    proxy_endpoint=?, error_class=?, error_message=?, retryable=?
                WHERE id=? AND status='running'
                """,
                (
                    status,
                    time.time(),
                    exit_code,
                    proxy_node_id,
                    proxy_endpoint,
                    error_class,
                    redact_text(error_message, limit=2000),
                    int(bool(retryable)),
                    attempt_id,
                ),
            )
            if cur.rowcount:
                self._event(
                    conn,
                    row["task_id"],
                    "attempt_finished",
                    {"attempt": row["attempt_no"], "status": status, "exit_code": exit_code, "error_class": error_class},
                )

    def complete_task(
        self,
        task_id: str,
        status: str,
        *,
        exit_code: int | None = None,
        error_class: str = "",
        error_message: str = "",
        expected_attempt_id: str | None = None,
    ) -> dict[str, Any] | None:
        if status not in TERMINAL_STATUSES:
            raise ValueError(status)
        now = time.time()
        with self._transaction() as conn:
            attempt_guard = ""
            params: list[Any] = [
                status,
                now,
                now,
                exit_code,
                error_class,
                redact_text(error_message, limit=2000),
                status,
                task_id,
            ]
            if expected_attempt_id:
                attempt_guard = """
                    AND status IN ('running','cancelling')
                    AND (SELECT id FROM attempts WHERE task_id=tasks.id ORDER BY attempt_no DESC LIMIT 1)=?
                """
                params.append(expected_attempt_id)
            cur = conn.execute(
                f"""
                UPDATE tasks SET status=?, finished_at=?, updated_at=?, pid=NULL,
                    process_marker=NULL, exit_code=?, last_error_class=?, last_error=?,
                    cancel_requested=CASE WHEN ?='cancelled' THEN 1 ELSE cancel_requested END,
                    version=version+1 WHERE id=? {attempt_guard}
                """,
                params,
            )
            if cur.rowcount:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                self._event(conn, task_id, status, {"exit_code": exit_code, "error_class": error_class})
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def requeue_task(
        self,
        task_id: str,
        *,
        next_run_at: float,
        exit_code: int | None,
        error_class: str,
        error_message: str,
        tried_proxy_ids: list[str],
        expected_attempt_id: str | None = None,
    ) -> bool:
        now = time.time()
        with self._transaction() as conn:
            attempt_guard = ""
            params: list[Any] = [
                float(next_run_at),
                now,
                exit_code,
                error_class,
                redact_text(error_message, limit=2000),
                json.dumps(list(dict.fromkeys(tried_proxy_ids))),
                task_id,
            ]
            if expected_attempt_id:
                attempt_guard = """
                    AND status IN ('running','cancelling')
                    AND (SELECT id FROM attempts WHERE task_id=tasks.id ORDER BY attempt_no DESC LIMIT 1)=?
                """
                params.append(expected_attempt_id)
            cur = conn.execute(
                f"""
                UPDATE tasks SET status='queued', next_run_at=?, updated_at=?, pid=NULL,
                    process_marker=NULL, exit_code=?, last_error_class=?, last_error=?,
                    tried_proxy_ids_json=?, version=version+1
                WHERE id=? AND cancel_requested=0 {attempt_guard}
                """,
                params,
            )
            if cur.rowcount:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                self._event(conn, task_id, "retry_scheduled", {"next_run_at": next_run_at, "error_class": error_class})
            return bool(cur.rowcount)

    def request_cancel(self, task_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            status = row["status"]
            if status in TERMINAL_STATUSES:
                return self._task(row)
            if status == "queued":
                conn.execute(
                    """
                    UPDATE tasks SET status='cancelled', cancel_requested=1,
                        finished_at=?, updated_at=?, version=version+1 WHERE id=?
                    """,
                    (now, now, task_id),
                )
                self._event(conn, task_id, "cancelled")
            else:
                conn.execute(
                    """
                    UPDATE tasks SET status='cancelling', cancel_requested=1,
                        updated_at=?, version=version+1 WHERE id=?
                    """,
                    (now, task_id),
                )
                self._event(conn, task_id, "cancelling")
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def retry_task(self, task_id: str, additional_attempts: int) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            if row["status"] not in TERMINAL_STATUSES:
                raise RuntimeError("仅终态任务支持重新排队")
            prior_attempts = int(row["attempt_count"])
            max_attempts = prior_attempts + max(1, int(additional_attempts))
            conn.execute(
                """
                UPDATE tasks SET status='queued', cancel_requested=0, next_run_at=?,
                    started_at=NULL, finished_at=NULL, updated_at=?, max_attempts=?,
                    pid=NULL, process_marker=NULL, exit_code=NULL, backoff_anchor_attempt=?,
                    tried_proxy_ids_json='[]', version=version+1 WHERE id=?
                """,
                (now, now, max_attempts, prior_attempts, task_id),
            )
            self._event(conn, task_id, "manually_retried", {"max_attempts": max_attempts})
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def _requeue_crawl_batch_tasks(
        self,
        conn: sqlite3.Connection,
        batch_id: str,
        *,
        statuses: tuple[str, ...],
        extra: int,
        now: float,
        event_payload: dict[str, Any],
    ) -> list[str]:
        """Requeue every media task of a batch whose status is in ``statuses``.

        Shared by retry (failed/cancelled only) and rerun (also succeeded when asked).
        Anchors the backoff exponent to the prior attempt_count and grows the budget by
        ``extra``, without blanking last_error. Returns the requeued task ids in order.
        """
        placeholders = ",".join("?" for _ in statuses)
        rows = conn.execute(
            f"""
            SELECT t.id, t.attempt_count
            FROM crawl_address_tasks cat
            JOIN crawl_addresses ca ON ca.id=cat.address_id
            JOIN tasks t ON t.id=cat.task_id
            WHERE ca.batch_id=? AND t.status IN ({placeholders})
            ORDER BY ca.source_order, ca.address_order, cat.sequence_no
            """,
            (batch_id, *statuses),
        ).fetchall()
        task_ids = [str(row["id"]) for row in rows]
        for row in rows:
            task_id = str(row["id"])
            prior_attempts = int(row["attempt_count"])
            max_attempts = prior_attempts + extra
            conn.execute(
                f"""
                UPDATE tasks SET status='queued', cancel_requested=0, next_run_at=?,
                    started_at=NULL, finished_at=NULL, updated_at=?, max_attempts=?,
                    pid=NULL, process_marker=NULL, exit_code=NULL,
                    backoff_anchor_attempt=?, tried_proxy_ids_json='[]',
                    version=version+1 WHERE id=? AND status IN ({placeholders})
                """,
                (now, now, max_attempts, prior_attempts, task_id, *statuses),
            )
            conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
            self._event(
                conn,
                task_id,
                "manually_retried",
                {**event_payload, "max_attempts": max_attempts},
            )
        return task_ids

    def retry_failed_crawl_tasks(
        self,
        batch_id: str,
        additional_attempts: int = 1,
    ) -> dict[str, Any] | None:
        """Requeue only failed media tasks in a finished crawl batch."""
        now = time.time()
        extra = max(1, int(additional_attempts))
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT id FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            task_ids = self._requeue_crawl_batch_tasks(
                conn,
                batch_id,
                statuses=("failed", "cancelled"),
                extra=extra,
                now=now,
                event_payload={"batch_id": batch_id},
            )
            address_rows = conn.execute(
                """
                SELECT DISTINCT ca.id
                FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE ca.batch_id=? AND t.status='queued'
                """,
                (batch_id,),
            ).fetchall()
            address_ids = [str(row["id"]) for row in address_rows]
            for address_id in address_ids:
                conn.execute(
                    """
                    UPDATE crawl_addresses SET status='running', finished_at=NULL,
                        updated_at=?, last_error='' WHERE id=? AND status IN ('failed','cancelled')
                    """,
                    (now, address_id),
                )
            replanned_rows = conn.execute(
                """
                SELECT id FROM crawl_addresses
                WHERE batch_id=? AND planning_error != ''
                ORDER BY source_order, address_order
                """,
                (batch_id,),
            ).fetchall()
            replanned_address_ids = [str(row["id"]) for row in replanned_rows]
            for address_id in replanned_address_ids:
                # Reset to a clean pending state so the OrderedCrawlManager re-plans the
                # whole address. Existing crawl_address_tasks stay linked: re-planning is
                # idempotent (same enqueue key) and gallery-dl skips downloaded files, so
                # succeeded units are not re-fetched, only missing units are added.
                conn.execute(
                    """
                    UPDATE crawl_addresses SET status='pending', planning_error='',
                        last_error='', started_at=NULL, finished_at=NULL, updated_at=?
                    WHERE id=?
                    """,
                    (now, address_id),
                )
            if task_ids or replanned_address_ids:
                conn.execute(
                    """
                    UPDATE crawl_batches SET status='running', cancel_requested=0,
                        finished_at=NULL, updated_at=?, last_error='' WHERE id=?
                    """,
                    (now, batch_id),
                )
            self._refresh_crawl_batch_counts(conn, batch_id)
        return {
            "batch_id": batch_id,
            "retried_count": len(task_ids),
            "task_ids": task_ids,
            "address_ids": address_ids,
            "replanned_address_count": len(replanned_address_ids),
            "replanned_address_ids": replanned_address_ids,
        }

    def rerun_crawl_batch(
        self,
        batch_id: str,
        additional_attempts: int = 1,
        requeue_succeeded: bool = False,
    ) -> dict[str, Any] | None:
        """Re-open a finished crawl batch in place.

        Resets every address back to 'pending' so the OrderedCrawlManager re-plans them
        against the SAME position-based output dirs, requeues failed and cancelled media
        tasks (also succeeded when ``requeue_succeeded``), and reactivates the batch.
        Succeeded tasks are kept as-is by default, so idempotent re-enqueue returns them
        with zero re-execution and only new / failed units are downloaded. Existing task
        links and proxy-probe rows are preserved. Returns None for an unknown batch and
        ``{"batch_id":..., "not_terminal": True}`` when the batch is not yet finished.
        """
        now = time.time()
        extra = max(1, int(additional_attempts))
        terminal_batch = {"succeeded", "completed_with_errors", "cancelled"}
        # finish_crawl_address_as_pre_deduplicated marks addresses 'succeeded', so the
        # resettable set is exactly the terminal address statuses (nothing distinct).
        terminal_address = ("succeeded", "failed", "cancelled")
        statuses = (
            ("failed", "cancelled", "succeeded")
            if requeue_succeeded
            else ("failed", "cancelled")
        )
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT status FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            if str(batch["status"]) not in terminal_batch:
                return {"batch_id": batch_id, "not_terminal": True}
            task_ids = self._requeue_crawl_batch_tasks(
                conn,
                batch_id,
                statuses=statuses,
                extra=extra,
                now=now,
                event_payload={"batch_id": batch_id, "rerun": True},
            )
            address_placeholders = ",".join("?" for _ in terminal_address)
            address_rows = conn.execute(
                f"""
                SELECT id FROM crawl_addresses
                WHERE batch_id=? AND status IN ({address_placeholders})
                ORDER BY source_order, address_order
                """,
                (batch_id, *terminal_address),
            ).fetchall()
            replanned_address_ids = [str(row["id"]) for row in address_rows]
            conn.execute(
                f"""
                UPDATE crawl_addresses SET status='pending', planning_error='',
                    last_error='', started_at=NULL, finished_at=NULL, updated_at=?
                WHERE batch_id=? AND status IN ({address_placeholders})
                """,
                (now, batch_id, *terminal_address),
            )
            conn.execute(
                """
                UPDATE crawl_batches SET status='running', cancel_requested=0,
                    finished_at=NULL, last_error='', updated_at=? WHERE id=?
                """,
                (now, batch_id),
            )
            # A rerun changes the batch's file set, so any existing review manifest is
            # stale — and there is otherwise no path to re-analyze it (retry only accepts
            # 'failed', start only a not_started batch). Drop the review entirely so the
            # re-finished batch can be analyzed fresh. In-flight reviews are blocked from
            # rerun at the API layer (_REVIEW_IN_FLIGHT).
            conn.execute("DELETE FROM crawl_review_images WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM crawl_reviews WHERE batch_id=?", (batch_id,))
            self._refresh_crawl_batch_counts(conn, batch_id)
        return {
            "batch_id": batch_id,
            "requeued_task_count": len(task_ids),
            "task_ids": task_ids,
            "replanned_address_count": len(replanned_address_ids),
            "replanned_address_ids": replanned_address_ids,
            "requeue_succeeded": bool(requeue_succeeded),
        }

    def set_lease(self, task_id: str, attempt_id: str, node_id: str, endpoint: str, site: str) -> None:
        now = time.time()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO leases(task_id, attempt_id, node_id, endpoint, site, acquired_at, heartbeat_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET attempt_id=excluded.attempt_id,
                    node_id=excluded.node_id, endpoint=excluded.endpoint, site=excluded.site,
                    acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at
                """,
                (task_id, attempt_id, node_id, endpoint, site, now, now),
            )
            self._event(conn, task_id, "proxy_acquired", {"node_id": node_id, "endpoint": endpoint})

    def clear_lease(self, task_id: str, attempt_id: str | None = None) -> None:
        with self._transaction() as conn:
            if attempt_id is None:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
            else:
                conn.execute(
                    "DELETE FROM leases WHERE task_id=? AND attempt_id=?",
                    (task_id, attempt_id),
                )

    def append_logs_bulk(
        self,
        rows: Iterable[tuple[str, str | None, float, str, str]],
    ) -> int | None:
        prepared = [
            (task_id, attempt_id, ts, stream, redact_text(line, limit=8000))
            for task_id, attempt_id, ts, stream, line in rows
        ]
        if not prepared:
            return None

        increments: dict[str, int] = {}
        for task_id, _attempt_id, _ts, _stream, _line in prepared:
            increments[task_id] = increments.get(task_id, 0) + 1
        prune_threshold = self.max_logs_per_task // 4

        # 计数与事务共用数据库锁；只有提交成功后才发布新计数。
        with self._lock:
            next_counts = {
                task_id: self._since_prune.get(task_id, 0) + count
                for task_id, count in increments.items()
            }
            prune_task_ids = [
                task_id
                for task_id, count in next_counts.items()
                if count > prune_threshold
            ]
            with self._transaction() as conn:
                conn.executemany(
                    "INSERT INTO task_logs(task_id, attempt_id, ts, stream, line) "
                    "VALUES (?, ?, ?, ?, ?)",
                    prepared,
                )
                last_row = conn.execute("SELECT last_insert_rowid()").fetchone()
                for task_id in prune_task_ids:
                    conn.execute(
                        """
                        DELETE FROM task_logs WHERE task_id=? AND id NOT IN (
                            SELECT id FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?
                        )
                        """,
                        (task_id, task_id, self.max_logs_per_task),
                    )
            for task_id, count in next_counts.items():
                self._since_prune[task_id] = 0 if task_id in prune_task_ids else count
        return int(last_row[0]) if last_row is not None else None

    def append_log(self, task_id: str, attempt_id: str | None, stream: str, line: str) -> int:
        log_id = self.append_logs_bulk(
            [(task_id, attempt_id, time.time(), stream, line)]
        )
        return int(log_id or 0)

    def get_logs(self, task_id: str, *, since: int = 0, tail: int | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        with self._read() as conn:
            if tail is not None:
                rows = conn.execute(
                    "SELECT * FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?",
                    (task_id, max(1, min(int(tail), 5000))),
                ).fetchall()
                return [dict(row) for row in reversed(rows)]
            rows = conn.execute(
                "SELECT * FROM task_logs WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?",
                (task_id, max(0, int(since)), max(1, min(int(limit), 5000))),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_events(self, task_id: str, *, since: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?",
                (task_id, max(0, int(since)), max(1, min(int(limit), 5000))),
            ).fetchall()
            result: list[dict[str, Any]] = []
            for row in rows:
                data = dict(row)
                try:
                    data["payload"] = json.loads(data.pop("payload_json") or "{}")
                except Exception:
                    data["payload"] = {}
                result.append(data)
            return result

    def update_artifacts(self, task_id: str, count: int, total_bytes: int) -> None:
        with self._transaction() as conn:
            conn.execute(
                "UPDATE tasks SET artifact_count=?, artifact_bytes=?, updated_at=? WHERE id=?",
                (max(0, int(count)), max(0, int(total_bytes)), time.time(), task_id),
            )

    def create_crawl_batch(
        self,
        values: dict[str, Any],
        addresses: list[dict[str, Any]],
        *,
        idempotency_key: str | None = None,
    ) -> tuple[str, bool]:
        now = time.time()
        with self._transaction() as conn:
            if idempotency_key:
                existing = conn.execute(
                    "SELECT id FROM crawl_batches WHERE idempotency_key=?",
                    (idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return str(existing["id"]), False
            batch_id = str(values.get("id") or uuid.uuid4())
            conn.execute(
                """
                INSERT INTO crawl_batches(
                    id, idempotency_key, status, output_dir, concurrency, max_tasks,
                    created_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    batch_id,
                    idempotency_key,
                    values["output_dir"],
                    int(values["concurrency"]),
                    int(values["max_tasks"]),
                    now,
                    now,
                ),
            )
            for address in addresses:
                conn.execute(
                    """
                    INSERT INTO crawl_addresses(
                        id, batch_id, site, source_order, address_order, url, label,
                        address_type, status, proxy_mode, max_attempts, priority,
                        credentials_ref, cookies_file, config_file, download_options_json,
                        extra_args_json, discovery_args_json, timeout_seconds, created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        address["id"],
                        batch_id,
                        address["site"],
                        int(address["source_order"]),
                        int(address["address_order"]),
                        address["url"],
                        address.get("label", ""),
                        address.get("address_type", ""),
                        address["proxy_mode"],
                        int(address["max_attempts"]),
                        int(address.get("priority", 0)),
                        address.get("credentials_ref"),
                        address.get("cookies_file"),
                        address.get("config_file"),
                        json.dumps(address.get("download_options", {}), ensure_ascii=False),
                        json.dumps(address.get("extra_args", []), ensure_ascii=False),
                        json.dumps(address.get("discovery_args", []), ensure_ascii=False),
                        float(address.get("timeout_seconds", 180.0)),
                        now,
                        now,
                    ),
                )
            return batch_id, True

    def get_crawl_batch_by_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM crawl_batches WHERE idempotency_key=?",
                (key,),
            ).fetchone()
        return self.get_crawl_batch(str(row["id"])) if row else None

    def get_crawl_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            batch = self._crawl_batch(row)
            if batch is None:
                return None
            rows = conn.execute(
                """
                SELECT ca.*, cap.target_url AS proxy_probe_target,
                    cap.total_count AS probed_proxy_count,
                    cap.healthy_count AS healthy_proxy_count,
                    cap.checked_at AS proxy_probed_at,
                    cap.last_error AS proxy_probe_error
                FROM crawl_addresses ca
                LEFT JOIN crawl_address_proxy_probes cap ON cap.address_id=ca.id
                WHERE ca.batch_id=? ORDER BY ca.source_order, ca.address_order
                """,
                (batch_id,),
            ).fetchall()
            addresses = [self._crawl_address(item) for item in rows]

        sources: list[dict[str, Any]] = []
        source_index: dict[int, dict[str, Any]] = {}
        current: dict[str, Any] | None = None
        terminal = {"succeeded", "failed", "cancelled"}
        for address in addresses:
            if address is None:
                continue
            order = int(address["source_order"])
            group = source_index.get(order)
            if group is None:
                group = {
                    "order": order,
                    "site": address["site"],
                    "status": "pending",
                    "addresses": [],
                }
                source_index[order] = group
                sources.append(group)
            group["addresses"].append(address)
            group["pre_dedup_skipped_count"] = int(
                group.get("pre_dedup_skipped_count") or 0
            ) + int(address.get("pre_dedup_skipped_count") or 0)
            if current is None and address["status"] not in terminal:
                current = {
                    "source_order": order,
                    "address_order": address["address_order"],
                    "address_id": address["id"],
                    "site": address["site"],
                    "url": address["url"],
                    "status": address["status"],
                }
        for group in sources:
            statuses = [item["status"] for item in group["addresses"]]
            if all(status == "succeeded" for status in statuses):
                group["status"] = "succeeded"
            elif any(status in {"planning", "running"} for status in statuses):
                group["status"] = "running"
            elif any(status == "failed" for status in statuses) and all(status in terminal for status in statuses):
                group["status"] = "completed_with_errors"
            elif all(status == "cancelled" for status in statuses):
                group["status"] = "cancelled"
        batch["sources"] = sources
        batch["source_count"] = len(sources)
        batch["address_count"] = sum(len(item["addresses"]) for item in sources)
        batch["pre_dedup_skipped_count"] = sum(
            int(item.get("pre_dedup_skipped_count") or 0) for item in sources
        )
        batch["current"] = current
        batch["execution_order"] = "source_then_address"
        batch["lease_model"] = "one-media-task-one-node"
        # A terminal batch can be resumed when there is failed/cancelled media work to
        # requeue, or an address whose planning never completed (planning_error set) and
        # so needs re-planning. Computed from already-loaded rows — no extra query.
        terminal_batch = {"succeeded", "completed_with_errors", "cancelled"}
        has_planning_gap = any(
            str((address or {}).get("planning_error") or "") for address in addresses
        )
        batch["resumable"] = bool(
            batch["status"] in terminal_batch
            and (
                int(batch.get("failed_task_count") or 0) > 0
                or int(batch.get("cancelled_task_count") or 0) > 0
                or has_planning_gap
            )
        )
        batch["review"] = self.get_crawl_review(batch_id)
        return batch

    def list_crawl_batches(self, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM crawl_batches
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                (max(1, min(int(limit), 500)), max(0, int(offset))),
            ).fetchall()
            return [self._crawl_batch(row) for row in rows]  # type: ignore[misc]

    def get_crawl_review(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            review = self._crawl_review(row)
            if review is None:
                return None
            image_counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN selected=1 THEN 1 ELSE 0 END) AS selected_count,
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept_count,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected_count,
                    SUM(CASE WHEN disposition='failed' THEN 1 ELSE 0 END) AS failed_count
                FROM crawl_review_images WHERE batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            decided = conn.execute(
                """
                SELECT COUNT(*) FROM crawl_review_groups
                WHERE batch_id=? AND decided=1 AND kind NOT LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()[0]
        review["selected_image_count"] = int(image_counts["selected_count"] or 0)
        review["kept_image_count"] = int(image_counts["kept_count"] or review["kept_image_count"] or 0)
        review["rejected_image_count"] = int(
            image_counts["rejected_count"] or review["rejected_image_count"] or 0
        )
        review["failed_image_count"] = int(
            image_counts["failed_count"] or review["failed_image_count"] or 0
        )
        review["decided_group_count"] = int(decided or 0)
        return review

    def start_crawl_review(self, batch_id: str) -> dict[str, Any]:
        now = time.time()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT status FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                raise KeyError(batch_id)
            if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
                raise RuntimeError("爬取批次结束后才能启动去重分析")
            conn.execute(
                """
                INSERT INTO crawl_reviews(batch_id, status, created_at, updated_at)
                VALUES (?, 'pending', ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET status='pending', updated_at=?, error=''
                WHERE crawl_reviews.status='waiting_for_crawl'
                """,
                (batch_id, now, now, now),
            )
        review = self.get_crawl_review(batch_id)
        if review is None:
            raise RuntimeError("去重分析任务建立后读取失败")
        return review

    def recover_crawl_reviews(self) -> int:
        now = time.time()
        with self._transaction() as conn:
            analyzing = conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', updated_at=?,
                    error='服务重启，重新执行去重分析'
                WHERE status='analyzing'
                """,
                (now,),
            ).rowcount
            applying = conn.execute(
                """
                UPDATE crawl_reviews SET status='apply_failed', updated_at=?,
                    error='服务重启，需重试应用审核结果'
                WHERE status='applying'
                """,
                (now,),
            ).rowcount
            return int(analyzing + applying)

    def claim_next_crawl_review(self) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                """
                SELECT cr.batch_id, cb.output_dir FROM crawl_reviews cr
                JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.status='pending'
                  AND cb.status IN ('succeeded','completed_with_errors','cancelled')
                ORDER BY cb.finished_at, cb.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='analyzing', started_at=?, updated_at=?,
                    ready_at=NULL, applied_at=NULL, error=''
                WHERE batch_id=? AND status='pending'
                """,
                (now, now, row["batch_id"]),
            )
            if not updated.rowcount:
                return None
            return {"batch_id": str(row["batch_id"]), "output_dir": str(row["output_dir"])}

    def next_crawl_review_automatic(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT cr.batch_id, cb.output_dir FROM crawl_reviews cr
                JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.status='auto_applying'
                ORDER BY cr.updated_at, cr.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            return {
                "batch_id": str(row["batch_id"]),
                "output_dir": str(row["output_dir"]),
            }

    def requeue_crawl_review(self, batch_id: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', updated_at=?, error=''
                WHERE batch_id=? AND status='analyzing'
                """,
                (time.time(), batch_id),
            )

    def fail_crawl_review(self, batch_id: str, error: str, *, log_path: str = "") -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_reviews SET status='failed', error=?, analysis_log_path=?,
                    updated_at=? WHERE batch_id=? AND status='analyzing'
                """,
                (redact_text(error, limit=4000), log_path, time.time(), batch_id),
            )

    def retry_crawl_review(self, batch_id: str) -> bool:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if row is None:
                return False
            if row["status"] != "failed":
                raise RuntimeError("当前审核分析状态不允许重试")
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', total_image_count=0,
                    total_group_count=0, duplicate_group_count=0, unreadable_image_count=0,
                    automatic_group_count=0, automatic_rejected_image_count=0,
                    kept_image_count=0, rejected_image_count=0, failed_image_count=0,
                    error='', updated_at=?, started_at=NULL, ready_at=NULL, applied_at=NULL
                WHERE batch_id=?
                """,
                (now, batch_id),
            )
            return True

    def replace_crawl_review_manifest(
        self,
        batch_id: str,
        manifest: dict[str, Any],
        *,
        log_path: str = "",
    ) -> None:
        groups = list(manifest.get("groups") or [])
        automatic_groups = list(manifest.get("auto_groups") or [])
        now = time.time()
        with self._transaction() as conn:
            review = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if review is None or review["status"] != "analyzing":
                raise RuntimeError("审核任务未处于分析状态")
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            image_count = 0
            duplicate_count = 0
            unreadable_count = 0
            automatic_rejected_count = 0
            seen_group_ids: set[str] = set()
            seen_image_ids: set[str] = set()
            seen_paths: set[str] = set()

            def insert_group(
                group_id: str,
                ordinal: int,
                kind: str,
                match_levels: list[Any],
                reason: str,
                *,
                decided: bool,
            ) -> None:
                if not group_id or group_id in seen_group_ids:
                    raise ValueError("审核清单包含空或重复的组 ID")
                seen_group_ids.add(group_id)
                conn.execute(
                    """
                    INSERT INTO crawl_review_groups(
                        batch_id, id, ordinal, kind, match_levels_json, reason,
                        decided, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        batch_id,
                        group_id,
                        ordinal,
                        kind,
                        json.dumps(match_levels, ensure_ascii=False),
                        redact_text(reason, limit=1000),
                        int(decided),
                        now,
                        now,
                    ),
                )

            def insert_image(
                group_id: str,
                image: dict[str, Any],
                fallback_ordinal: int,
                *,
                selected: bool,
                metadata_extra: dict[str, Any] | None = None,
            ) -> None:
                nonlocal image_count, unreadable_count
                image_id = str(image.get("id") or "").strip()
                relative_path = str(image.get("relative_path") or "").strip()
                if not image_id or image_id in seen_image_ids:
                    raise ValueError("审核清单包含空或重复的图片 ID")
                if not relative_path or relative_path in seen_paths:
                    raise ValueError("审核清单包含空或重复的图片路径")
                seen_image_ids.add(image_id)
                seen_paths.add(relative_path)
                metadata = dict(image.get("metadata") or {})
                if metadata_extra:
                    metadata.update(metadata_extra)
                # The worker emits per-image SSCD/DINO similarity as a top-level
                # review_metrics key; fold it into metadata_json so it survives to the
                # API (the UI reads image.metadata.review_metrics). Without this the
                # review cards never showed the similarity scores.
                if image.get("review_metrics") is not None:
                    metadata["review_metrics"] = image["review_metrics"]
                readable = bool(image.get("readable", True))
                if not readable:
                    unreadable_count += 1
                conn.execute(
                    """
                    INSERT INTO crawl_review_images(
                        batch_id, id, group_id, ordinal, relative_path, file_hash,
                        metadata_json, readable, recommended, selected, disposition,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (
                        batch_id,
                        image_id,
                        group_id,
                        int(image.get("ordinal") or fallback_ordinal),
                        relative_path,
                        str(metadata.get("file_hash") or ""),
                        json.dumps(metadata, ensure_ascii=False, allow_nan=False),
                        int(readable),
                        int(bool(image.get("recommended"))),
                        int(selected),
                        now,
                        now,
                    ),
                )
                image_count += 1

            for fallback_ordinal, group in enumerate(groups, 1):
                group_id = str(group.get("id") or "").strip()
                kind = str(group.get("kind") or "single")
                if kind == "duplicate":
                    duplicate_count += 1
                items = list(group.get("items") or [])
                insert_group(
                    group_id,
                    int(group.get("ordinal") or fallback_ordinal),
                    kind,
                    list(group.get("match_levels") or []),
                    str(group.get("reason") or ""),
                    decided=False,
                )
                for fallback_image_ordinal, image in enumerate(items, 1):
                    insert_image(
                        group_id,
                        image,
                        fallback_image_ordinal,
                        selected=True,
                    )

            manual_ordinals = [
                int(group.get("ordinal") or fallback)
                for fallback, group in enumerate(groups, 1)
            ]
            automatic_ordinal = max(manual_ordinals, default=0)
            for fallback_ordinal, group in enumerate(automatic_groups, 1):
                group_id = str(group.get("id") or "").strip()
                automatic_kind = str(group.get("kind") or "")
                if automatic_kind not in {"exact", "compression"}:
                    raise ValueError("自动去重组类型无效")
                winner = dict(group.get("winner") or {})
                winner_path = str(winner.get("relative_path") or "").strip()
                rejected_items = list(group.get("rejected_items") or [])
                if not winner_path or not rejected_items:
                    raise ValueError("自动去重组缺少保留图或淘汰图")
                insert_group(
                    group_id,
                    automatic_ordinal + fallback_ordinal,
                    f"auto_{automatic_kind}",
                    list(group.get("match_levels") or []),
                    str(group.get("reason") or ""),
                    decided=True,
                )
                for fallback_image_ordinal, image in enumerate(rejected_items, 1):
                    insert_image(
                        group_id,
                        image,
                        fallback_image_ordinal,
                        selected=False,
                        metadata_extra={
                            "automatic_dedup": {
                                "kind": automatic_kind,
                                "winner_relative_path": winner_path,
                                "reason": str(group.get("reason") or ""),
                            }
                        },
                    )
                    automatic_rejected_count += 1

            expected_images = int((manifest.get("counts") or {}).get("images") or 0)
            if expected_images != image_count:
                raise ValueError("审核清单的总图片计数不一致")
            next_status = "auto_applying" if automatic_rejected_count else "ready"
            conn.execute(
                """
                UPDATE crawl_reviews SET status=?, total_image_count=?,
                    total_group_count=?, duplicate_group_count=?, unreadable_image_count=?,
                    automatic_group_count=?, automatic_rejected_image_count=?,
                    kept_image_count=0, rejected_image_count=0, failed_image_count=0,
                    error='', analysis_log_path=?, ready_at=?, updated_at=?
                WHERE batch_id=?
                """,
                (
                    next_status,
                    image_count,
                    len(groups),
                    duplicate_count,
                    unreadable_count,
                    len(automatic_groups),
                    automatic_rejected_count,
                    log_path,
                    now if next_status == "ready" else None,
                    now,
                    batch_id,
                ),
            )

    def list_crawl_review_groups(
        self,
        batch_id: str,
        *,
        kind: str | None = None,
        limit: int = 12,
        offset: int = 0,
    ) -> dict[str, Any]:
        where = "batch_id=? AND kind NOT LIKE 'auto_%'"
        params: list[Any] = [batch_id]
        if kind:
            where += " AND kind=?"
            params.append(kind)
        page_limit = max(1, min(int(limit), 50))
        page_offset = max(0, int(offset))
        with self._read() as conn:
            total = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM crawl_review_groups WHERE {where}",
                    params,
                ).fetchone()[0]
            )
            rows = conn.execute(
                f"""
                SELECT * FROM crawl_review_groups WHERE {where}
                ORDER BY ordinal LIMIT ? OFFSET ?
                """,
                [*params, page_limit, page_offset],
            ).fetchall()
            groups: list[dict[str, Any]] = []
            for row in rows:
                group = self._crawl_review_group(row)
                if group is None:
                    continue
                image_rows = conn.execute(
                    """
                    SELECT * FROM crawl_review_images
                    WHERE batch_id=? AND group_id=? ORDER BY ordinal
                    """,
                    (batch_id, group["id"]),
                ).fetchall()
                group["images"] = [
                    self._crawl_review_image(image_row) for image_row in image_rows
                ]
                group["image_count"] = len(group["images"])
                group["selected_image_count"] = sum(
                    bool(image and image.get("selected")) for image in group["images"]
                )
                groups.append(group)
        return {"items": groups, "total": total, "limit": page_limit, "offset": page_offset}

    def update_crawl_review_decisions(
        self,
        batch_id: str,
        decisions: list[dict[str, Any]],
    ) -> None:
        now = time.time()
        with self._transaction() as conn:
            review = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if review is None:
                raise KeyError(batch_id)
            if review["status"] != "ready":
                raise RuntimeError("当前审核状态不允许修改选择")
            seen_groups: set[str] = set()
            for decision in decisions:
                group_id = str(decision.get("group_id") or "")
                if not group_id or group_id in seen_groups:
                    raise ValueError("审核决策包含空或重复的组 ID")
                seen_groups.add(group_id)
                group_row = conn.execute(
                    "SELECT kind FROM crawl_review_groups WHERE batch_id=? AND id=?",
                    (batch_id, group_id),
                ).fetchone()
                if group_row is None:
                    raise KeyError(group_id)
                if str(group_row["kind"] or "").startswith("auto_"):
                    # Auto-dedup groups are applied by the worker, not the user. Flipping a
                    # rejected auto-image back to selected would make apply look for a file
                    # the worker already moved away -> apply_failed + skewed auto counts.
                    raise ValueError("不能修改自动去重组的选择")
                rows = conn.execute(
                    """
                    SELECT id FROM crawl_review_images WHERE batch_id=? AND group_id=?
                    """,
                    (batch_id, group_id),
                ).fetchall()
                if not rows:
                    raise KeyError(group_id)
                available = {str(row["id"]) for row in rows}
                selected = {str(value) for value in decision.get("selected_image_ids") or []}
                if not selected.issubset(available):
                    raise ValueError("审核决策包含不属于当前组的图片 ID")
                conn.execute(
                    """
                    UPDATE crawl_review_images SET selected=0, updated_at=?
                    WHERE batch_id=? AND group_id=?
                    """,
                    (now, batch_id, group_id),
                )
                if selected:
                    conn.executemany(
                        """
                        UPDATE crawl_review_images SET selected=1, updated_at=?
                        WHERE batch_id=? AND group_id=? AND id=?
                        """,
                        [(now, batch_id, group_id, image_id) for image_id in selected],
                    )
                conn.execute(
                    """
                    UPDATE crawl_review_groups SET decided=1, updated_at=?
                    WHERE batch_id=? AND id=?
                    """,
                    (now, batch_id, group_id),
                )
            conn.execute(
                "UPDATE crawl_reviews SET updated_at=? WHERE batch_id=?",
                (now, batch_id),
            )

    def get_crawl_review_image(self, batch_id: str, image_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT cri.*, cb.output_dir FROM crawl_review_images cri
                JOIN crawl_batches cb ON cb.id=cri.batch_id
                WHERE cri.batch_id=? AND cri.id=?
                """,
                (batch_id, image_id),
            ).fetchone()
            return self._crawl_review_image(row)

    def begin_crawl_review_apply(self, batch_id: str) -> bool:
        with self._transaction() as conn:
            review = conn.execute(
                """
                SELECT cr.status AS status, cb.status AS batch_status
                FROM crawl_reviews cr JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            if review is None or review["status"] not in {"ready", "apply_failed"}:
                return False
            # A rerun/retry can pull the batch back to running after the review turned
            # ready; applying an old manifest then would move files while gallery-dl is
            # writing the same tree (and re-download whatever we "rejected"). Refuse
            # unless the batch is terminal again.
            if review["batch_status"] not in TERMINAL_BATCH_STATUSES:
                return False
            undecided = int(
                conn.execute(
                    """
                    SELECT COUNT(*) FROM crawl_review_groups
                    WHERE batch_id=? AND decided=0
                    """,
                    (batch_id,),
                ).fetchone()[0]
            )
            if undecided:
                raise RuntimeError(f"还有 {undecided} 个图片组尚未确认")
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='applying', error='', updated_at=?
                WHERE batch_id=? AND status IN ('ready','apply_failed')
                """,
                (time.time(), batch_id),
            )
            return bool(updated.rowcount)

    def crawl_review_apply_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM crawl_review_images WHERE batch_id=?
                ORDER BY group_id, ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]  # type: ignore[misc]

    def crawl_review_automatic_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT cri.* FROM crawl_review_images cri
                JOIN crawl_review_groups crg
                    ON crg.batch_id=cri.batch_id AND crg.id=cri.group_id
                WHERE cri.batch_id=? AND crg.kind LIKE 'auto_%' AND cri.selected=0
                ORDER BY crg.ordinal, cri.ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]  # type: ignore[misc]

    def finish_crawl_review_automatic(self, batch_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN cri.disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN cri.disposition='failed' THEN 1 ELSE 0 END) AS failed
                FROM crawl_review_images cri
                JOIN crawl_review_groups crg
                    ON crg.batch_id=cri.batch_id AND crg.id=cri.group_id
                WHERE cri.batch_id=? AND crg.kind LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            error = f"{failed} 张严格自动淘汰图片处理失败" if failed else ""
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='ready', rejected_image_count=?,
                    failed_image_count=?, error=?, ready_at=?, updated_at=?
                WHERE batch_id=? AND status='auto_applying'
                """,
                (rejected, failed, error, now, now, batch_id),
            )
            if not updated.rowcount:
                return None
        return self.get_crawl_review(batch_id)

    def stage_crawl_review_image_move(
        self,
        batch_id: str,
        image_id: str,
        final_relative_path: str,
    ) -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_review_images SET disposition='moving', final_relative_path=?,
                    error='', updated_at=? WHERE batch_id=? AND id=?
                """,
                (final_relative_path, time.time(), batch_id, image_id),
            )

    def finish_crawl_review_image(
        self,
        batch_id: str,
        image_id: str,
        disposition: str,
        *,
        final_relative_path: str,
        error: str = "",
    ) -> None:
        if disposition not in {"kept", "rejected", "failed"}:
            raise ValueError("审核图片结果状态无效")
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_review_images SET disposition=?, final_relative_path=?,
                    error=?, updated_at=? WHERE batch_id=? AND id=?
                """,
                (
                    disposition,
                    final_relative_path,
                    redact_text(error, limit=2000),
                    time.time(),
                    batch_id,
                    image_id,
                ),
            )

    def finish_crawl_review_apply(self, batch_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN disposition NOT IN ('kept','rejected') THEN 1 ELSE 0 END) AS failed
                FROM crawl_review_images WHERE batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            kept = int(counts["kept"] or 0)
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            status = "apply_failed" if failed else "applied"
            error = f"{failed} 张图片处理失败" if failed else ""
            conn.execute(
                """
                UPDATE crawl_reviews SET status=?, kept_image_count=?, rejected_image_count=?,
                    failed_image_count=?, error=?, updated_at=?, applied_at=? WHERE batch_id=?
                """,
                (status, kept, rejected, failed, error, now, now if not failed else None, batch_id),
            )
        return self.get_crawl_review(batch_id)

    def active_crawl_batch_ids(self) -> list[str]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT id FROM crawl_batches
                WHERE status IN ('queued','running','cancelling')
                ORDER BY created_at
                """
            ).fetchall()
            return [str(row["id"]) for row in rows]

    def next_crawl_address(self, batch_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM crawl_addresses
                WHERE batch_id=? AND status NOT IN ('succeeded','failed','cancelled')
                ORDER BY source_order, address_order LIMIT 1
                """,
                (batch_id,),
            ).fetchone()
            return self._crawl_address(row)

    def save_crawl_address_proxy_probe(
        self,
        address_id: str,
        *,
        target_url: str,
        total_count: int,
        healthy_node_ids: list[str],
        error: str = "",
    ) -> dict[str, Any]:
        checked_at = time.time()
        node_ids = list(dict.fromkeys(str(value) for value in healthy_node_ids if str(value)))
        with self._transaction() as conn:
            address = conn.execute(
                "SELECT id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if address is None:
                raise KeyError(address_id)
            conn.execute(
                """
                INSERT INTO crawl_address_proxy_probes(
                    address_id, target_url, total_count, healthy_count, checked_at, last_error
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(address_id) DO UPDATE SET
                    target_url=excluded.target_url,
                    total_count=excluded.total_count,
                    healthy_count=excluded.healthy_count,
                    checked_at=excluded.checked_at,
                    last_error=excluded.last_error
                """,
                (
                    address_id,
                    target_url,
                    max(0, int(total_count)),
                    len(node_ids),
                    checked_at,
                    redact_text(error, limit=2000),
                ),
            )
            conn.execute(
                "DELETE FROM crawl_address_proxy_nodes WHERE address_id=?",
                (address_id,),
            )
            conn.executemany(
                "INSERT INTO crawl_address_proxy_nodes(address_id, node_id) VALUES (?, ?)",
                ((address_id, node_id) for node_id in node_ids),
            )
        return self.get_crawl_address_proxy_probe(address_id)  # type: ignore[return-value]

    def get_crawl_address_proxy_probe(self, address_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_address_proxy_probes WHERE address_id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return None
            node_rows = conn.execute(
                """
                SELECT node_id FROM crawl_address_proxy_nodes
                WHERE address_id=? ORDER BY node_id
                """,
                (address_id,),
            ).fetchall()
        result = dict(row)
        result["node_ids"] = [str(item["node_id"]) for item in node_rows]
        return result

    def begin_crawl_address_planning(self, address_id: str) -> bool:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT batch_id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='planning', started_at=COALESCE(started_at, ?),
                    updated_at=?, last_error=''
                WHERE id=? AND status='pending'
                """,
                (now, now, address_id),
            )
            if cur.rowcount:
                conn.execute(
                    """
                    UPDATE crawl_batches SET status='running', started_at=COALESCE(started_at, ?),
                        updated_at=? WHERE id=? AND cancel_requested=0
                    """,
                    (now, now, row["batch_id"]),
                )
            return bool(cur.rowcount)

    def task_crawl_batch_id(self, task_id: str) -> str | None:
        """Return the crawl batch a task belongs to, or None for a standalone task.
        Used to route task-level retries of crawl media tasks back through the batch
        endpoint so address/batch counters stay consistent."""
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT ca.batch_id FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                WHERE cat.task_id=? LIMIT 1
                """,
                (task_id,),
            ).fetchone()
        return str(row["batch_id"]) if row else None

    def crawl_batch_cancel_requested(self, batch_id: str) -> bool | None:
        """Cheap cancel-flag read for hot planning loops, avoiding get_crawl_batch's
        full address + review load. None means the batch no longer exists."""
        with self._read() as conn:
            row = conn.execute(
                "SELECT cancel_requested FROM crawl_batches WHERE id=?", (batch_id,)
            ).fetchone()
        if row is None:
            return None
        return bool(row["cancel_requested"])

    def link_crawl_task(
        self,
        address_id: str,
        task_id: str,
        sequence_no: int,
        *,
        source_key: str | None = None,
        source_url: str | None = None,
    ) -> None:
        now = time.time()
        with self._transaction() as conn:
            # Re-planning re-links this address's tasks. Discovery for artist feeds often
            # returns new works first, shifting positional sequence numbers, so a fresh
            # task can request a sequence_no already owned by an older task. INSERT OR
            # IGNORE would silently drop that link (UNIQUE(address_id, sequence_no)),
            # leaving the new task invisible to counts / 补齐 / completion tracking.
            # Instead: keep an existing (address, task) link untouched, take the requested
            # slot when free, else append at MAX+1.
            already_linked = conn.execute(
                "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND task_id=?",
                (address_id, task_id),
            ).fetchone()
            if already_linked is None:
                slot_taken = conn.execute(
                    "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND sequence_no=?",
                    (address_id, int(sequence_no)),
                ).fetchone()
                if slot_taken is None:
                    effective_sequence = int(sequence_no)
                else:
                    effective_sequence = int(
                        conn.execute(
                            "SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM crawl_address_tasks WHERE address_id=?",
                            (address_id,),
                        ).fetchone()[0]
                    )
                conn.execute(
                    """
                    INSERT INTO crawl_address_tasks(address_id, task_id, sequence_no, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (address_id, task_id, effective_sequence, now),
                )
            normalized_key = str(source_key or "").strip()
            if normalized_key:
                conn.execute(
                    """
                    INSERT INTO crawl_task_source_keys(
                        task_id, source_key, source_url, created_at
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(task_id, source_key) DO UPDATE SET
                        source_url=excluded.source_url
                    """,
                    (
                        task_id,
                        normalized_key[:500],
                        str(source_url or "").strip()[:8192],
                        now,
                    ),
                )
            if already_linked is None:
                # Only a genuinely new link changes the batch total. Increment by one
                # instead of re-running a full-batch COUNT subquery on every unit — that
                # made planning an N-unit address O(N²). mark_crawl_address_running
                # reconciles the exact value once the address is fully planned.
                row = conn.execute(
                    "SELECT batch_id FROM crawl_addresses WHERE id=?",
                    (address_id,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE crawl_batches SET task_count=task_count+1, updated_at=? WHERE id=?",
                        (now, row["batch_id"]),
                    )

    def succeeded_danbooru_source_keys(
        self,
        batch_id: str,
        source_keys: list[str] | set[str] | tuple[str, ...],
    ) -> set[str]:
        keys = list(
            dict.fromkeys(
                str(value).strip() for value in source_keys if str(value).strip()
            )
        )
        if not keys:
            return set()
        matched: set[str] = set()
        with self._lock:
            for offset in range(0, len(keys), 500):
                chunk = keys[offset : offset + 500]
                placeholders = ",".join("?" for _ in chunk)
                rows = self._conn.execute(
                    f"""
                    SELECT DISTINCT ctsk.source_key
                    FROM crawl_task_source_keys ctsk
                    JOIN tasks t ON t.id=ctsk.task_id
                    JOIN crawl_address_tasks cat ON cat.task_id=t.id
                    JOIN crawl_addresses ca ON ca.id=cat.address_id
                    WHERE ca.batch_id=? AND ca.site='danbooru'
                        AND t.status='succeeded'
                        AND ctsk.source_key IN ({placeholders})
                    """,
                    [batch_id, *chunk],
                ).fetchall()
                matched.update(str(row["source_key"]) for row in rows)
        return matched

    def succeeded_danbooru_source_key_count(
        self,
        batch_id: str,
        target_site: str,
    ) -> int:
        prefix = str(target_site).strip().lower()
        if prefix == "x":
            prefix = "twitter"
        if prefix not in {"pixiv", "twitter"}:
            return 0
        with self._lock:
            row = self._conn.execute(
                """
                SELECT COUNT(DISTINCT ctsk.source_key)
                FROM crawl_task_source_keys ctsk
                JOIN tasks t ON t.id=ctsk.task_id
                JOIN crawl_address_tasks cat ON cat.task_id=t.id
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                WHERE ca.batch_id=? AND ca.site='danbooru'
                    AND t.status='succeeded' AND ctsk.source_key LIKE ?
                """,
                (batch_id, f"{prefix}:%"),
            ).fetchone()
        return int(row[0] or 0)

    def set_crawl_address_pre_dedup_skipped_count(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET pre_dedup_skipped_count=?, updated_at=?
                WHERE id=? AND status='planning'
                """,
                (max(0, int(skipped_count)), time.time(), address_id),
            )
            return bool(cur.rowcount)

    def finish_crawl_address_as_pre_deduplicated(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                """
                SELECT ca.batch_id FROM crawl_addresses ca
                JOIN crawl_batches cb ON cb.id=ca.batch_id
                WHERE ca.id=? AND ca.status='planning' AND cb.cancel_requested=0
                """,
                (address_id,),
            ).fetchone()
            if row is None:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='succeeded', planned_task_count=0,
                    pre_dedup_skipped_count=?, finished_at=?, updated_at=?, last_error=''
                WHERE id=? AND status='planning'
                """,
                (max(0, int(skipped_count)), now, now, address_id),
            )
            if not cur.rowcount:
                return False
            self._refresh_crawl_batch_counts(conn, str(row["batch_id"]))
            return True

    def mark_crawl_address_running(
        self, address_id: str, *, last_error: str = "", planning_error: str = ""
    ) -> bool:
        now = time.time()
        with self._transaction() as conn:
            count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?",
                    (address_id,),
                ).fetchone()[0]
            )
            if count <= 0:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='running', planned_task_count=?, updated_at=?,
                    last_error=?, planning_error=?
                WHERE id=? AND status='planning'
                """,
                (
                    count,
                    now,
                    redact_text(last_error, limit=2000),
                    redact_text(planning_error, limit=2000),
                    address_id,
                ),
            )
            if cur.rowcount:
                # Reconcile the batch counters once per address, now that link_crawl_task
                # only increments task_count incrementally during planning.
                batch_row = conn.execute(
                    "SELECT batch_id FROM crawl_addresses WHERE id=?", (address_id,)
                ).fetchone()
                if batch_row:
                    self._refresh_crawl_batch_counts(conn, str(batch_row["batch_id"]))
            return bool(cur.rowcount)

    def reset_crawl_address_planning(self, address_id: str, error: str = "") -> bool:
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='pending', updated_at=?, last_error=?
                WHERE id=? AND status='planning'
                """,
                (time.time(), redact_text(error, limit=2000), address_id),
            )
            return bool(cur.rowcount)

    def crawl_address_tasks(self, address_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT t.*, cat.sequence_no FROM crawl_address_tasks cat
                JOIN tasks t ON t.id=cat.task_id
                WHERE cat.address_id=? ORDER BY cat.sequence_no
                """,
                (address_id,),
            ).fetchall()
            return [self._task(row) | {"sequence_no": row["sequence_no"]} for row in rows]  # type: ignore[operator]

    def list_crawl_tasks(
        self,
        batch_id: str,
        *,
        address_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = "ca.batch_id=?"
        params: list[Any] = [batch_id]
        if address_id:
            where += " AND ca.id=?"
            params.append(address_id)
        params.extend([max(1, min(int(limit), 1000)), max(0, int(offset))])
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT t.*, ca.id AS crawl_address_id, ca.source_order, ca.address_order,
                    cat.sequence_no
                FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE {where}
                ORDER BY ca.source_order, ca.address_order, cat.sequence_no
                LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
            result: list[dict[str, Any]] = []
            for row in rows:
                task = self._task(row)
                if task is not None:
                    task["crawl_address_id"] = row["crawl_address_id"]
                    task["source_order"] = row["source_order"]
                    task["address_order"] = row["address_order"]
                    task["sequence_no"] = row["sequence_no"]
                    result.append(task)
            return result

    def crawl_batch_task_count(self, batch_id: str) -> int:
        with self._read() as conn:
            return int(
                conn.execute(
                    """
                    SELECT COUNT(*) FROM crawl_address_tasks cat
                    JOIN crawl_addresses ca ON ca.id=cat.address_id
                    WHERE ca.batch_id=?
                    """,
                    (batch_id,),
                ).fetchone()[0]
            )

    def crawl_address_task_count(self, address_id: str) -> int:
        with self._read() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?",
                    (address_id,),
                ).fetchone()[0]
            )

    @staticmethod
    def _refresh_crawl_batch_counts(conn: sqlite3.Connection, batch_id: str) -> None:
        counts = conn.execute(
            """
            SELECT COUNT(*) AS total,
                SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) AS cancelled
            FROM crawl_address_tasks cat
            JOIN crawl_addresses ca ON ca.id=cat.address_id
            JOIN tasks t ON t.id=cat.task_id
            WHERE ca.batch_id=?
            """,
            (batch_id,),
        ).fetchone()
        conn.execute(
            """
            UPDATE crawl_batches SET task_count=?, succeeded_task_count=?,
                failed_task_count=?, cancelled_task_count=?, updated_at=? WHERE id=?
            """,
            (
                int(counts["total"] or 0),
                int(counts["succeeded"] or 0),
                int(counts["failed"] or 0),
                int(counts["cancelled"] or 0),
                time.time(),
                batch_id,
            ),
        )

    def finish_crawl_address_if_terminal(self, address_id: str) -> bool:
        terminal = {"succeeded", "failed", "cancelled"}
        now = time.time()
        with self._transaction() as conn:
            address = conn.execute(
                "SELECT * FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if address is None or address["status"] != "running":
                return False
            rows = conn.execute(
                """
                SELECT t.status FROM crawl_address_tasks cat
                JOIN tasks t ON t.id=cat.task_id WHERE cat.address_id=?
                """,
                (address_id,),
            ).fetchall()
            statuses = [str(row["status"]) for row in rows]
            if not statuses or any(status not in terminal for status in statuses):
                return False
            batch = conn.execute(
                "SELECT cancel_requested FROM crawl_batches WHERE id=?",
                (address["batch_id"],),
            ).fetchone()
            succeeded = statuses.count("succeeded")
            failed = statuses.count("failed")
            cancelled = statuses.count("cancelled")
            planning_error = str(address["planning_error"] or "")
            status = "cancelled" if batch and batch["cancel_requested"] else "succeeded"
            if status != "cancelled" and (failed or cancelled or planning_error):
                status = "failed"
            error = (
                ""
                if status == "succeeded"
                else planning_error or f"媒体任务失败={failed}, 取消={cancelled}"
            )
            conn.execute(
                """
                UPDATE crawl_addresses SET status=?, succeeded_task_count=?,
                    failed_task_count=?, cancelled_task_count=?, finished_at=?,
                    updated_at=?, last_error=? WHERE id=?
                """,
                (status, succeeded, failed, cancelled, now, now, error, address_id),
            )
            self._refresh_crawl_batch_counts(conn, str(address["batch_id"]))
            return True

    def fail_crawl_address(self, address_id: str, error: str) -> None:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT batch_id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return
            conn.execute(
                """
                UPDATE crawl_addresses SET status='failed', finished_at=?, updated_at=?,
                    last_error=?, planning_error=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')
                """,
                (
                    now,
                    now,
                    redact_text(error, limit=2000),
                    redact_text(error, limit=2000),
                    address_id,
                ),
            )
            conn.execute(
                "UPDATE crawl_batches SET last_error=?, updated_at=? WHERE id=?",
                (redact_text(error, limit=2000), now, row["batch_id"]),
            )
            self._refresh_crawl_batch_counts(conn, str(row["batch_id"]))

    def finish_crawl_batch_if_ready(self, batch_id: str) -> bool:
        now = time.time()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return False
            if batch["status"] in TERMINAL_BATCH_STATUSES:
                # Already finalized. Re-running the finish UPDATE would rewrite
                # finished_at (which also reshuffles the pending-review claim order)
                # every time a repeat cancel/retry call lands on a done batch.
                return True
            rows = conn.execute(
                "SELECT status FROM crawl_addresses WHERE batch_id=?",
                (batch_id,),
            ).fetchall()
            statuses = [str(row["status"]) for row in rows]
            terminal = {"succeeded", "failed", "cancelled"}
            self._refresh_crawl_batch_counts(conn, batch_id)
            if not statuses or any(status not in terminal for status in statuses):
                next_status = "cancelling" if batch["cancel_requested"] else "running"
                conn.execute(
                    "UPDATE crawl_batches SET status=?, updated_at=? WHERE id=?",
                    (next_status, now, batch_id),
                )
                return False
            if batch["cancel_requested"]:
                status = "cancelled"
            elif any(status in {"failed", "cancelled"} for status in statuses):
                status = "completed_with_errors"
            else:
                status = "succeeded"
            conn.execute(
                """
                UPDATE crawl_batches SET status=?, finished_at=?, updated_at=? WHERE id=?
                """,
                (status, now, now, batch_id),
            )
            return True

    def request_cancel_crawl_batch(self, batch_id: str) -> tuple[dict[str, Any] | None, list[str]]:
        now = time.time()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None, []
            if batch["status"] in {"succeeded", "completed_with_errors", "cancelled"}:
                return self._crawl_batch(batch), []  # type: ignore[return-value]
            conn.execute(
                """
                UPDATE crawl_batches SET status='cancelling', cancel_requested=1,
                    updated_at=? WHERE id=?
                """,
                (now, batch_id),
            )
            conn.execute(
                """
                UPDATE crawl_addresses SET status='cancelled', finished_at=?, updated_at=?,
                    last_error='批次已取消'
                WHERE batch_id=? AND status IN ('pending','planning')
                """,
                (now, now, batch_id),
            )
            task_rows = conn.execute(
                """
                SELECT t.id FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled')
                """,
                (batch_id,),
            ).fetchall()
            return self._crawl_batch(
                conn.execute("SELECT * FROM crawl_batches WHERE id=?", (batch_id,)).fetchone()
            ), [str(row["id"]) for row in task_rows]  # type: ignore[return-value]

    def recover_ordered_crawls(self) -> int:
        now = time.time()
        with self._transaction() as conn:
            linked = conn.execute(
                """
                UPDATE crawl_addresses SET status='running', updated_at=?,
                    planned_task_count=(
                        SELECT COUNT(*) FROM crawl_address_tasks cat
                        WHERE cat.address_id=crawl_addresses.id
                    ),
                    last_error='后端重启时地址只完成了部分规划，等待已创建任务结束',
                    planning_error='后端重启时地址只完成了部分规划，等待已创建任务结束'
                WHERE status='planning' AND EXISTS (
                    SELECT 1 FROM crawl_address_tasks cat
                    WHERE cat.address_id=crawl_addresses.id
                )
                """,
                (now,),
            )
            pending = conn.execute(
                """
                UPDATE crawl_addresses SET status='pending', updated_at=?, last_error='后端重启后重新规划'
                WHERE status='planning' AND NOT EXISTS (
                    SELECT 1 FROM crawl_address_tasks cat
                    WHERE cat.address_id=crawl_addresses.id
                )
                """,
                (now,),
            )
            conn.execute(
                """
                UPDATE crawl_batches SET status=CASE WHEN cancel_requested=1 THEN 'cancelling' ELSE 'running' END,
                    updated_at=? WHERE status IN ('queued','running','cancelling')
                """,
                (now,),
            )
            return int(linked.rowcount) + int(pending.rowcount)

    def put_site_policy(self, site: str, policy: dict[str, Any]) -> dict[str, Any]:
        normalized = EditableSitePolicy.model_validate(policy).model_dump()
        now = time.time()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(site) DO UPDATE SET policy_json=excluded.policy_json, updated_at=excluded.updated_at
                """,
                (site, json.dumps(normalized, ensure_ascii=False), now),
            )
        return {"site": site, "policy": normalized, "updated_at": now}

    def get_site_policy(self, site: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM site_policies WHERE site=?", (site,)).fetchone()
            if row is None:
                return None
            return {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}

    def list_site_policies(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute("SELECT * FROM site_policies ORDER BY site").fetchall()
            return [
                {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}
                for row in rows
            ]

    def delete_site_policy(self, site: str) -> bool:
        with self._transaction() as conn:
            return bool(conn.execute("DELETE FROM site_policies WHERE site=?", (site,)).rowcount)

    def incomplete_processes(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT id, pid, process_marker, status, attempt_count, max_attempts FROM tasks WHERE status IN ('starting','running','cancelling')"
            ).fetchall()
            return [dict(row) for row in rows]

    def recover_incomplete(self) -> int:
        now = time.time()
        recovered = 0
        with self._transaction() as conn:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE status IN ('starting','running','cancelling')"
            ).fetchall()
            for row in rows:
                task_id = row["id"]
                if row["cancel_requested"]:
                    conn.execute(
                        """
                        UPDATE tasks SET status='cancelled', finished_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启时任务处于取消流程' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self._event(conn, task_id, "cancelled_after_restart")
                elif int(row["attempt_count"]) < int(row["max_attempts"]):
                    conn.execute(
                        """
                        UPDATE tasks SET status='queued', next_run_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启，任务重新排队' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self._event(conn, task_id, "requeued_after_restart")
                else:
                    conn.execute(
                        """
                        UPDATE tasks SET status='failed', finished_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启且重试次数已用尽' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self._event(conn, task_id, "failed_after_restart")
                conn.execute(
                    """
                    UPDATE attempts SET status='orphaned', finished_at=?,
                        error_class='backend_restart', error_message='后端重启'
                    WHERE task_id=? AND status='running'
                    """,
                    (now, task_id),
                )
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                recovered += 1
        return recovered
