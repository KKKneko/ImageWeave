from __future__ import annotations

"""Backend-side runtime patches for the vendored gallery-dl subprocess.

The backend needs two behaviors from gallery-dl that upstream does not
provide, and the submodule must stay pristine (no local edits):

1. Stable ``.part`` naming.  ``PathFormat.part_enable`` appends ``.part`` to
   whatever ``temppath`` is left over from earlier ``build_path()`` /
   ``fix_extension()`` calls.  When a download attempt is killed (stall
   watchdog, backend restart) and retried in a new process, a stale
   ``temppath`` can point the retry at a different ``.part`` name, so the
   HTTP Range resume never finds the previous partial file.  The patch
   resets ``temppath`` to ``realpath`` right before upstream appends
   ``.part``, making the name a pure function of the target path.

2. Download activity heartbeats.  The parent process watches two files
   (``GDL_ACTIVITY_STARTED_FILE`` / ``GDL_ACTIVITY_FILE``) to detect EH
   downloads that stall mid-transfer; media tasks of one address share an
   output directory, so directory mtimes cannot attribute progress to a
   single task.  The patch wraps ``HttpDownloader.receive`` (and its rate
   limited sibling): the started marker is touched when the body transfer
   begins, and the activity file at most once per second while chunks are
   written.

Every seam is validated first; on mismatch the patch is skipped with a
loud stderr line, so an upstream update degrades to stock behavior instead
of failing silently mid-download.
"""

import inspect
import os
import sys
import time


_PATCH_FLAG = "_gdl_backend_patch"
ACTIVITY_ENV = "GDL_ACTIVITY_FILE"
ACTIVITY_STARTED_ENV = "GDL_ACTIVITY_STARTED_FILE"


def _warn(message: str) -> None:
    print(f"[gdl-backend-patch] {message}", file=sys.stderr, flush=True)


def _parameters(func) -> list[str]:
    try:
        return list(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return []


def apply_part_naming_patch() -> bool:
    """Make ``temppath`` always resolve to ``<realpath>.part``."""
    try:
        from gallery_dl.path import PathFormat
    except Exception as exc:
        _warn(f"part 命名补丁未生效：无法导入 gallery_dl.path ({exc})")
        return False
    original = getattr(PathFormat, "part_enable", None)
    if original is None:
        _warn("part 命名补丁未生效：PathFormat.part_enable 不存在")
        return False
    if getattr(original, _PATCH_FLAG, False):
        return True
    if _parameters(original) != ["self", "part_directory"]:
        _warn(
            "part 命名补丁未生效：part_enable 签名与预期不符 "
            f"({_parameters(original)})"
        )
        return False

    def part_enable(self, part_directory=None):
        # Drop temppath state left over from earlier build_path() calls so
        # upstream derives "<realpath>.part"; its part_directory handling
        # then operates on that name unchanged.
        if self.extension:
            self.temppath = self.realpath
        return original(self, part_directory)

    setattr(part_enable, _PATCH_FLAG, True)
    PathFormat.part_enable = part_enable
    return True


def apply_activity_heartbeat_patch() -> bool:
    """Touch parent-visible heartbeat files while HTTP chunks are written."""
    activity_path = os.environ.get(ACTIVITY_ENV, "")
    started_path = os.environ.get(ACTIVITY_STARTED_ENV, "")
    if not activity_path and not started_path:
        return False
    try:
        from gallery_dl.downloader.http import HttpDownloader
    except Exception as exc:
        _warn(f"下载心跳补丁未生效：无法导入 HTTP 下载器 ({exc})")
        return False

    state = {
        "activity": activity_path,
        "started": started_path,
        "last_touch": 0.0,
    }

    def touch(key: str) -> None:
        path = state[key]
        if not path:
            return
        try:
            with open(path, "ab"):
                pass
            os.utime(path, None)
        except OSError:
            state[key] = ""

    class _HeartbeatFile:
        __slots__ = ("_fp",)

        def __init__(self, fp) -> None:
            self._fp = fp

        def write(self, data):
            result = self._fp.write(data)
            # 每个完整网络块写入后刷新 Python 用户态缓冲；watchdog 随后终止进程时，
            # 已收到的块仍会留在非空 .part 中。这里只 flush，不做昂贵的逐块 fsync。
            self._fp.flush()
            now = time.monotonic()
            if state["activity"] and now - state["last_touch"] >= 1.0:
                state["last_touch"] = now
                touch("activity")
            return result

        def __getattr__(self, name):
            return getattr(self._fp, name)

    expected = ["self", "fp", "content", "bytes_total", "bytes_start"]

    def wrap(name: str) -> bool:
        original = getattr(HttpDownloader, name, None)
        if original is None:
            _warn(f"下载心跳补丁未生效：HttpDownloader.{name} 不存在")
            return False
        if getattr(original, _PATCH_FLAG, False):
            return True
        if _parameters(original) != expected:
            _warn(
                f"下载心跳补丁未生效：{name} 签名与预期不符 "
                f"({_parameters(original)})"
            )
            return False

        def wrapped(self, fp, content, bytes_total, bytes_start):
            if state["started"]:
                touch("started")
                state["started"] = ""
            return original(
                self, _HeartbeatFile(fp), content, bytes_total, bytes_start
            )

        setattr(wrapped, _PATCH_FLAG, True)
        setattr(HttpDownloader, name, wrapped)
        return True

    # Both entry points must be wrapped: __init__ rebinds
    # ``self.receive = self._receive_rate`` when a rate limit or progress
    # indicator is configured, and that lookup resolves through the class.
    receive_ok = wrap("receive")
    rate_ok = wrap("_receive_rate")
    return receive_ok and rate_ok


def apply_all() -> None:
    apply_part_naming_patch()
    apply_activity_heartbeat_patch()
