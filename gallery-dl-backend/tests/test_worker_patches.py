from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from gdl_backend.gallery import GalleryRunner

from tests.helpers import WORKSPACE, make_settings


GALLERY_ROOT = WORKSPACE / "gallery-dl-codeberg"
BACKEND_ROOT = WORKSPACE / "gallery-dl-backend"
# Valid JPEG signature so adjust-extension keeps the name; > one 32 KiB chunk
# so an aborted transfer leaves a resumable prefix.
JPEG_PAYLOAD = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 400 + b"\xff\xd9"


def _import_gallery_path_module():
    repo = str(GALLERY_ROOT)
    if repo not in sys.path:
        sys.path.insert(0, repo)
    import gallery_dl.path

    return gallery_dl.path


class _RangeFileState:
    """Shared state for the local origin: payload, abort switch, hang switch."""

    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.abort_after: int | None = None
        self.hang_after: int | None = None
        self.range_headers: list[str | None] = []
        self.lock = threading.Lock()


class _RangeFileHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: _RangeFileState

    def do_GET(self):  # noqa: N802 - http.server naming
        state = self.state
        header = self.headers.get("Range")
        with state.lock:
            state.range_headers.append(header)
            abort_after = state.abort_after
            hang_after = state.hang_after
        payload = state.payload
        if header:
            start = int(header.split("=", 1)[1].split("-", 1)[0])
            body = payload[start:]
            self.send_response(206)
            self.send_header(
                "Content-Range", f"bytes {start}-{len(payload) - 1}/{len(payload)}"
            )
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if abort_after is not None:
            self.wfile.write(payload[:abort_after])
            self.wfile.flush()
            self.connection.close()
            return
        if hang_after is not None:
            self.wfile.write(payload[:hang_after])
            self.wfile.flush()
            time.sleep(30.0)
            return
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class _LocalOrigin:
    def __init__(self, payload: bytes) -> None:
        self.state = _RangeFileState(payload)
        handler = type("Handler", (_RangeFileHandler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/img.jpg"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _run_worker(
    url: str,
    destination: Path,
    *,
    extra_env: dict[str, str] | None = None,
    timeout: float = 90.0,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    pythonpath = [str(BACKEND_ROOT), str(GALLERY_ROOT)]
    if env.get("PYTHONPATH"):
        pythonpath.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(pythonpath)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    if extra_env:
        env.update(extra_env)
    command = [
        sys.executable,
        "-m",
        "gdl_backend.worker_entry",
        "--marker",
        "worker-patch-test",
        "--gallery-root",
        str(GALLERY_ROOT),
        "--",
        "--config-ignore",
        "--no-colors",
        "--no-input",
        "--retries",
        "0",
        "--http-timeout",
        "15",
        "--destination",
        str(destination),
        url,
    ]
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=str(BACKEND_ROOT),
    )


def _find_only(destination: Path, pattern: str) -> Path:
    matches = [path for path in destination.rglob(pattern) if path.is_file()]
    if len(matches) != 1:
        raise AssertionError(f"expected one {pattern} under {destination}: {matches}")
    return matches[0]


class PartNamingPatchTests(unittest.TestCase):
    def _make_pathfmt(self, gdl_path):
        pathfmt = object.__new__(gdl_path.PathFormat)
        pathfmt.extension = "jpg"
        pathfmt.realpath = "/downloads/file.jpg"
        pathfmt.temppath = "/downloads/stale-from-earlier-build.bin"
        pathfmt.kwdict = {}
        pathfmt.prefix = ""
        return pathfmt

    def test_patch_resets_stale_temppath_and_keeps_part_directory(self):
        from gdl_backend import worker_patches

        gdl_path = _import_gallery_path_module()
        self.assertTrue(worker_patches.apply_part_naming_patch())
        # Applying twice stays a single wrap.
        self.assertTrue(worker_patches.apply_part_naming_patch())

        pathfmt = self._make_pathfmt(gdl_path)
        pathfmt.part_enable()
        self.assertEqual(pathfmt.temppath, pathfmt.realpath + ".part")

        scoped = self._make_pathfmt(gdl_path)
        scoped.part_enable("/parts")
        self.assertEqual(scoped.temppath, os.path.join("/parts", "file.jpg.part"))

    def test_heartbeat_patch_is_inert_without_environment(self):
        from gdl_backend import worker_patches

        for key in (worker_patches.ACTIVITY_ENV, worker_patches.ACTIVITY_STARTED_ENV):
            self.assertNotIn(key, os.environ)
        self.assertFalse(worker_patches.apply_activity_heartbeat_patch())


class WorkerSubprocessPatchTests(unittest.TestCase):
    def test_aborted_download_resumes_from_part_file(self):
        origin = _LocalOrigin(JPEG_PAYLOAD)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                destination = Path(tmp) / "downloads"
                origin.state.abort_after = 32768 + 16
                first = _run_worker(origin.url, destination)
                self.assertNotEqual(first.returncode, 0, first.stderr)
                self.assertNotIn("[gdl-backend-patch]", first.stderr, first.stderr)
                part = _find_only(destination, "*.part")
                part_size = part.stat().st_size
                self.assertGreater(part_size, 0)
                self.assertLess(part_size, len(JPEG_PAYLOAD))

                origin.state.abort_after = None
                second = _run_worker(origin.url, destination)
                self.assertEqual(second.returncode, 0, second.stderr)
                self.assertNotIn("[gdl-backend-patch]", second.stderr, second.stderr)
                self.assertIn(
                    f"bytes={part_size}-",
                    [header for header in origin.state.range_headers if header],
                )
                final = _find_only(destination, "*.jpg")
                self.assertEqual(final.read_bytes(), JPEG_PAYLOAD)
                self.assertEqual(list(destination.rglob("*.part")), [])
        finally:
            origin.close()

    def test_heartbeat_files_are_touched_during_download(self):
        origin = _LocalOrigin(JPEG_PAYLOAD)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                destination = Path(tmp) / "downloads"
                activity = Path(tmp) / "activity"
                started = Path(tmp) / "activity.started"
                result = _run_worker(
                    origin.url,
                    destination,
                    extra_env={
                        "GDL_ACTIVITY_FILE": str(activity),
                        "GDL_ACTIVITY_STARTED_FILE": str(started),
                    },
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("[gdl-backend-patch]", result.stderr, result.stderr)
                self.assertTrue(started.is_file())
                self.assertTrue(activity.is_file())
                final = _find_only(destination, "*.jpg")
                self.assertEqual(final.read_bytes(), JPEG_PAYLOAD)
        finally:
            origin.close()

    def test_stalled_download_is_killed_by_watchdog_then_resumes(self):
        origin = _LocalOrigin(JPEG_PAYLOAD)
        old_no_proxy = os.environ.get("NO_PROXY")
        old_no_proxy_lower = os.environ.get("no_proxy")
        os.environ["NO_PROXY"] = "*"
        os.environ["no_proxy"] = "*"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                settings = make_settings(root)
                settings.gallery.terminate_grace_seconds = 0.5
                runner = GalleryRunner(settings.gallery, settings.project_dir)
                destination = settings.default_output_root / "stall"
                destination.mkdir(parents=True, exist_ok=True)
                # One full 32 KiB chunk (plus signature header) lands on disk,
                # then the transfer stalls inside the second chunk read.
                origin.state.hang_after = 45000

                async def run_stalled():
                    async def noop(*_args):
                        return None

                    return await runner.run(
                        "stall-watchdog-test",
                        url=origin.url,
                        output_dir=str(destination),
                        proxy_url=None,
                        http_timeout=10,
                        gallery_retries=0,
                        task_timeout=30.0,
                        stall_timeout=1.5,
                        cookies_file=None,
                        config_file=None,
                        credentials_ref=None,
                        extra_args=[],
                        on_line=noop,
                        on_started=noop,
                    )

                begin = time.monotonic()
                result = asyncio.run(run_stalled())
                elapsed = time.monotonic() - begin
                self.assertTrue(result.timed_out, result.output_tail)
                # The stall watchdog must fire, not the 30s task timeout.
                self.assertLess(elapsed, 15.0)
                part = _find_only(destination, "*.part")
                part_size = part.stat().st_size
                self.assertGreater(part_size, 0)
                # Heartbeat markers are removed once the attempt ends.
                self.assertEqual(list(destination.glob(".gdl-activity-*")), [])

                origin.state.hang_after = None
                resumed = _run_worker(origin.url, destination)
                self.assertEqual(resumed.returncode, 0, resumed.stderr)
                self.assertIn(
                    f"bytes={part_size}-",
                    [header for header in origin.state.range_headers if header],
                )
                final = _find_only(destination, "*.jpg")
                self.assertEqual(final.read_bytes(), JPEG_PAYLOAD)
                self.assertEqual(list(destination.rglob("*.part")), [])
        finally:
            if old_no_proxy is None:
                os.environ.pop("NO_PROXY", None)
            else:
                os.environ["NO_PROXY"] = old_no_proxy
            if old_no_proxy_lower is None:
                os.environ.pop("no_proxy", None)
            else:
                os.environ["no_proxy"] = old_no_proxy_lower
            origin.close()


if __name__ == "__main__":
    unittest.main()
