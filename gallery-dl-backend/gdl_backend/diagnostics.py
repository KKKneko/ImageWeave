from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .config import AppSettings
from .proxy_core import resolve_core_binary
from .redaction import redact_text


SSCD_FILENAME = "sscd_disc_mixup.torchscript.pt"
DINO_CHECKPOINT = Path("torch/hub/checkpoints/dinov2_vits14_pretrain.pth")
DINO_REPOSITORY = Path(
    "torch/hub/facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"
)
_OK_STATUSES = {"ok", "disabled"}
_DEDUP_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, dict[str, Any]]]] = {}
_DEDUP_CACHE_LOCK = threading.Lock()
_DEDUP_CACHE_FRESH_SECONDS = 120.0
_DEDUP_REFRESH_INFLIGHT: set[str] = set()


def _component(
    status: str,
    summary: str,
    *,
    required: bool = True,
    **details: Any,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": status,
        "required": required,
        "summary": summary,
    }
    result.update(details)
    return result


def _safe_error(value: Any) -> str:
    text = redact_text(value, limit=240)
    return " ".join(text.split()) or "未知错误"


def _path_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


def _dedup_cache_key(settings: AppSettings) -> tuple[Any, ...]:
    model_dir = settings.dedup.model_dir
    return (
        str(settings.dedup.python_executable),
        _path_signature(settings.dedup.python_executable),
        str(model_dir),
        settings.dedup.device,
        settings.dedup.no_sscd,
        settings.dedup.no_dino,
        settings.dedup.workers,
        settings.dedup.torch_threads,
        settings.dedup.torch_interop_threads,
        settings.dedup.deep_batch_size,
        settings.dedup.neighbor_block_size,
        _path_signature(model_dir / SSCD_FILENAME),
        _path_signature(model_dir / DINO_CHECKPOINT),
        _path_signature(model_dir / DINO_REPOSITORY / "hubconf.py"),
    )


_DEDUP_PROBE = r"""
import importlib.metadata as metadata
import json
import sys
from pathlib import Path

model_dir = Path(sys.argv[1])
requested = sys.argv[2]
use_sscd = sys.argv[3] == "1"
use_dino = sys.argv[4] == "1"
result = {}
try:
    import torch
    import torchvision
except Exception as exc:
    result["torch_error"] = f"{type(exc).__name__}: {exc}"
else:
    cuda_available = bool(torch.cuda.is_available())
    actual_device = "cuda" if requested == "auto" and cuda_available else requested
    if requested == "cuda" and not cuda_available:
        result["device_error"] = "配置要求 CUDA，但 PyTorch 未检测到可用 GPU"
    elif actual_device not in {"cpu", "cuda"}:
        result["device_error"] = "设备配置无效"
    names = sorted({
        dist.metadata["Name"].lower()
        for dist in metadata.distributions()
        if dist.metadata.get("Name")
    })
    forbidden = [
        name for name in names
        if name.startswith("nvidia-")
        or name in {
            "cuda-bindings", "cuda-pathfinder", "cuda-toolkit",
            "pytorch-triton", "triton",
        }
    ]
    opencv_variants = [
        name for name in names
        if name in {
            "opencv-python", "opencv-contrib-python",
            "opencv-contrib-python-headless", "opencv-python-headless",
        }
    ]
    result.update({
        "torch_version": str(torch.__version__),
        "torchvision_version": str(torchvision.__version__),
        "cuda_available": cuda_available,
        "actual_device": actual_device,
        "forbidden_cpu_packages": forbidden,
        "opencv_variants": opencv_variants,
    })
    if requested == "cpu" and (
        not str(torch.__version__).endswith("+cpu")
        or forbidden
        or cuda_available
        or opencv_variants != ["opencv-python-headless"]
    ):
        result["cpu_purity_error"] = "CPU 配置不是纯 CPU PyTorch/headless OpenCV 环境"
result["sscd_present"] = (
    not use_sscd
    or ((model_dir / "sscd_disc_mixup.torchscript.pt").is_file()
        and (model_dir / "sscd_disc_mixup.torchscript.pt").stat().st_size > 0)
)
dino_checkpoint = model_dir / "torch/hub/checkpoints/dinov2_vits14_pretrain.pth"
dino_hubconf = model_dir / (
    "torch/hub/facebookresearch_dinov2_"
    "7764ea0f912e53c92e82eb78a2a1631e92725fc8/hubconf.py"
)
result["dino_present"] = (
    not use_dino
    or (dino_checkpoint.is_file() and dino_checkpoint.stat().st_size > 0
        and dino_hubconf.is_file())
)
print(json.dumps(result, separators=(",", ":")))
"""


def _disabled_dedup_components() -> dict[str, dict[str, Any]]:
    disabled = _component("disabled", "去重功能未启用", required=False)
    return {
        "dedup": disabled,
        "dedup_python": dict(disabled),
        "torch": dict(disabled),
        "sscd_model": dict(disabled),
        "dino_model": dict(disabled),
    }


def _probe_dedup_components(settings: AppSettings) -> dict[str, dict[str, Any]]:
    python = settings.dedup.python_executable

    if not python.is_file() or (os.name != "nt" and not os.access(python, os.X_OK)):
        blocked = _component("error", "去重 Python 不可用")
        result = {
            "dedup": _component("error", "去重环境不完整"),
            "dedup_python": blocked,
            "torch": _component("error", "无法检查 Torch：去重 Python 不可用"),
            "sscd_model": (
                _component("disabled", "SSCD 已由配置禁用", required=False)
                if settings.dedup.no_sscd
                else _component("error", "无法检查 SSCD：去重 Python 不可用")
            ),
            "dino_model": (
                _component("disabled", "DINOv2 已由配置禁用", required=False)
                if settings.dedup.no_dino
                else _component("error", "无法检查 DINOv2：去重 Python 不可用")
            ),
        }
    elif not settings.dedup.worker_script.is_file() or not settings.dedup.core_script.is_file():
        result = {
            "dedup": _component("error", "去重脚本不完整"),
            "dedup_python": _component("ok", "去重 Python 可执行"),
            "torch": _component("error", "去重核心脚本缺失"),
            "sscd_model": (
                _component("disabled", "SSCD 已由配置禁用", required=False)
                if settings.dedup.no_sscd
                else _component("error", "去重核心脚本缺失")
            ),
            "dino_model": (
                _component("disabled", "DINOv2 已由配置禁用", required=False)
                if settings.dedup.no_dino
                else _component("error", "去重核心脚本缺失")
            ),
        }
    else:
        env = os.environ.copy()
        env["TORCH_HOME"] = str(settings.dedup.model_dir / "torch")
        try:
            completed = subprocess.run(
                [
                    str(python),
                    "-c",
                    _DEDUP_PROBE,
                    str(settings.dedup.model_dir),
                    settings.dedup.device,
                    "0" if settings.dedup.no_sscd else "1",
                    "0" if settings.dedup.no_dino else "1",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            probe: dict[str, Any] = {"torch_error": _safe_error(exc)}
        else:
            if completed.returncode != 0:
                probe = {
                    "torch_error": _safe_error(completed.stderr or completed.stdout)
                }
            else:
                try:
                    probe = json.loads(completed.stdout.strip().splitlines()[-1])
                except (IndexError, json.JSONDecodeError) as exc:
                    probe = {"torch_error": f"诊断输出无效：{type(exc).__name__}"}

        torch_error = probe.get("torch_error") or probe.get("device_error") or probe.get(
            "cpu_purity_error"
        )
        torch_component = (
            _component("error", _safe_error(torch_error))
            if torch_error
            else _component(
                "ok",
                "Torch 可用",
                version=str(probe.get("torch_version") or "unknown"),
                torchvision_version=str(probe.get("torchvision_version") or "unknown"),
                configured_device=settings.dedup.device,
                actual_device=str(probe.get("actual_device") or "unknown"),
                cuda_available=bool(probe.get("cuda_available")),
                forbidden_cpu_package_count=len(probe.get("forbidden_cpu_packages") or []),
                opencv_variants=list(probe.get("opencv_variants") or []),
            )
        )
        sscd_component = (
            _component("disabled", "SSCD 已由配置禁用", required=False)
            if settings.dedup.no_sscd
            else (
                _component("ok", "SSCD 模型缓存存在")
                if probe.get("sscd_present")
                else _component("error", "SSCD 模型缓存缺失")
            )
        )
        dino_component = (
            _component("disabled", "DINOv2 已由配置禁用", required=False)
            if settings.dedup.no_dino
            else (
                _component("ok", "DINOv2 权重和固定 revision 源码缓存存在")
                if probe.get("dino_present")
                else _component("error", "DINOv2 权重或固定 revision 源码缓存缺失")
            )
        )
        children = [torch_component, sscd_component, dino_component]
        dedup_ok = all(
            not item["required"] or item["status"] in _OK_STATUSES for item in children
        )
        result = {
            "dedup": _component(
                "ok" if dedup_ok else "error",
                "去重环境已就绪" if dedup_ok else "去重环境或模型不完整",
                configured_device=settings.dedup.device,
                configured_resources={
                    "workers": settings.dedup.workers,
                    "torch_threads": settings.dedup.torch_threads,
                    "torch_interop_threads": settings.dedup.torch_interop_threads,
                    "deep_batch_size": settings.dedup.deep_batch_size,
                    "neighbor_block_size": settings.dedup.neighbor_block_size,
                },
            ),
            "dedup_python": _component("ok", "去重 Python 可执行"),
            "torch": torch_component,
            "sscd_model": sscd_component,
            "dino_model": dino_component,
        }

    return result


def _store_dedup_cache(
    key: tuple[Any, ...],
    result: dict[str, dict[str, Any]],
) -> None:
    with _DEDUP_CACHE_LOCK:
        _DEDUP_CACHE.clear()
        _DEDUP_CACHE[key] = (time.monotonic(), result)


def _refresh_dedup_components(
    settings: AppSettings,
    key: tuple[Any, ...],
    refresh_key: str,
) -> None:
    try:
        result = _probe_dedup_components(settings)
        _store_dedup_cache(key, result)
    except Exception:
        # 后台刷新失败时继续保留旧值，且不输出可能含本机路径的异常。
        pass
    finally:
        with _DEDUP_CACHE_LOCK:
            _DEDUP_REFRESH_INFLIGHT.discard(refresh_key)


def dedup_components(
    settings: AppSettings,
    *,
    use_cache: bool = True,
) -> dict[str, dict[str, Any]]:
    if not settings.dedup.enabled:
        return _disabled_dedup_components()

    key = _dedup_cache_key(settings)
    if not use_cache:
        # doctor 路径始终同步执行真实探测，不参与后台单飞状态。
        result = _probe_dedup_components(settings)
        _store_dedup_cache(key, result)
        return {name: dict(value) for name, value in result.items()}

    now = time.monotonic()
    cached_result: dict[str, dict[str, Any]] | None = None
    cached_age = 0.0
    should_refresh = False
    refresh_key = repr(key)
    with _DEDUP_CACHE_LOCK:
        cached = _DEDUP_CACHE.get(key)
        if cached is not None:
            cached_age = max(0.0, now - cached[0])
            cached_result = cached[1]
            if (
                cached_age >= _DEDUP_CACHE_FRESH_SECONDS
                and refresh_key not in _DEDUP_REFRESH_INFLIGHT
            ):
                _DEDUP_REFRESH_INFLIGHT.add(refresh_key)
                should_refresh = True

    if cached_result is not None and cached_age < _DEDUP_CACHE_FRESH_SECONDS:
        return {name: dict(value) for name, value in cached_result.items()}

    if cached_result is not None:
        if should_refresh:
            refresh_thread = threading.Thread(
                target=_refresh_dedup_components,
                args=(settings, key, refresh_key),
                name="dedup-diagnostics-refresh",
                daemon=True,
            )
            try:
                refresh_thread.start()
            except RuntimeError:
                with _DEDUP_CACHE_LOCK:
                    _DEDUP_REFRESH_INFLIGHT.discard(refresh_key)
        age_seconds = round(cached_age, 1)
        return {
            name: {**dict(value), "stale": True, "age_seconds": age_seconds}
            for name, value in cached_result.items()
        }

    result = _probe_dedup_components(settings)
    _store_dedup_cache(key, result)
    return {name: dict(value) for name, value in result.items()}


def project_proxy_component(
    settings: AppSettings,
    live_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not settings.proxy.enabled:
        return _component(
            "disabled",
            "项目抓取代理池未启用（安装下载代理不计作节点源）",
            required=False,
            source_count=0,
        )
    source_count = (
        len(settings.proxy.subscription_urls)
        + len(settings.proxy.inline_nodes)
        + int(settings.proxy.node_file is not None and settings.proxy.node_file.is_file())
    )
    if source_count == 0:
        return _component("error", "项目抓取代理池已启用，但没有配置节点源", source_count=0)
    if live_status is not None and settings.proxy.auto_start and not live_status.get("running"):
        return _component(
            "error",
            "项目抓取代理池自动启动后未运行",
            source_count=source_count,
        )
    return _component(
        "ok",
        "项目抓取代理池已配置",
        source_count=source_count,
        running=bool(live_status and live_status.get("running")),
        healthy=int((live_status or {}).get("healthy") or 0),
    )


def mihomo_component(settings: AppSettings, *, include_version: bool = False) -> dict[str, Any]:
    required = bool(settings.proxy.enabled and settings.proxy.transport_core_enabled)
    try:
        binary = resolve_core_binary(
            settings.proxy.transport_core_binary,
            settings.proxy.transport_core_sha256,
        )
    except (OSError, RuntimeError) as exc:
        return _component(
            "error" if required else "optional_missing",
            "Mihomo 不可用" if required else "Mihomo 未安装（当前项目抓取代理池未要求）",
            required=required,
            reason=_safe_error(exc),
        )
    version = ""
    if include_version:
        try:
            completed = subprocess.run(
                [str(binary), "-v"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
            version = _safe_error(completed.stdout or completed.stderr)
        except (OSError, subprocess.SubprocessError):
            version = ""
    return _component(
        "ok",
        "Mihomo 可执行文件可用",
        required=required,
        version=version or None,
    )


def diagnostics_config_snapshot(settings: AppSettings) -> dict[str, Any]:
    """返回 DIAG.EXE 可读取的最小配置能力投影，不公开任何主机路径或秘密。"""

    return {
        "response_profile": "diagnostics",
        "secrets_exposed": False,
        "server": {
            "loopback_only": settings.server.host.strip().lower()
            in {"127.0.0.1", "localhost", "::1"},
            "cors_enabled": bool(settings.server.cors_origins),
            "private_targets_enabled": bool(settings.server.allow_private_targets),
        },
        "gallery": {
            "managed_auth_cache": True,
        },
        "proxy": {
            "enabled": bool(settings.proxy.enabled),
            "auto_start": bool(settings.proxy.auto_start),
            "transport_core_enabled": bool(settings.proxy.transport_core_enabled),
        },
        "scheduler": {
            "max_concurrent_tasks": max(
                1, min(int(settings.scheduler.max_concurrent_tasks), 100_000)
            ),
        },
        "dedup": {
            "enabled": bool(settings.dedup.enabled),
            "configured_device": (
                settings.dedup.device
                if settings.dedup.device in {"auto", "cpu", "cuda"}
                else "unknown"
            ),
            "sscd_enabled": not settings.dedup.no_sscd,
            "dino_enabled": not settings.dedup.no_dino,
        },
    }


def diagnostics_scheduler_snapshot(
    scheduler: dict[str, Any],
    ordered_crawls: dict[str, Any],
) -> dict[str, Any]:
    """投影调度摘要；只保留计数和受控枚举，不返回任务或批次载荷。"""

    def bounded_count(value: Any) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError, OverflowError):
            return 0
        return max(0, min(number, 1_000_000_000))

    execution_order = str(ordered_crawls.get("execution_order") or "unknown")
    if execution_order not in {"source_then_address", "unknown"}:
        execution_order = "unknown"
    address_parallelism = str(ordered_crawls.get("address_parallelism") or "unknown")
    if address_parallelism not in {"media_tasks", "unknown"}:
        address_parallelism = "unknown"
    return {
        "response_profile": "diagnostics",
        "secrets_exposed": False,
        "tasks": {
            "running": bool(scheduler.get("running")),
            "active": bounded_count(scheduler.get("active")),
            "max_concurrent": bounded_count(scheduler.get("max_concurrent")),
            "active_site_count": len(scheduler.get("sites") or {}),
        },
        "ordered_crawls": {
            "running": bool(ordered_crawls.get("running")),
            "active_batches": bounded_count(ordered_crawls.get("active_batches")),
            "execution_order": execution_order,
            "address_parallelism": address_parallelism,
        },
    }


def readiness_snapshot(
    settings: AppSettings,
    *,
    database_ok: bool,
    live_proxy_status: dict[str, Any],
    scheduler: dict[str, Any],
    ordered_crawls: dict[str, Any],
) -> dict[str, Any]:
    gallery_ok = (settings.gallery.repo_path / "gallery_dl" / "__init__.py").is_file()
    components: dict[str, dict[str, Any]] = {
        "process": _component("ok", "后端进程正在响应"),
        "database": _component(
            "ok" if database_ok else "error",
            "SQLite 可访问" if database_ok else "SQLite 不可访问",
        ),
        "gallery_source": _component(
            "ok" if gallery_ok else "error",
            "gallery-dl submodule 可用" if gallery_ok else "gallery-dl submodule 缺失",
        ),
        "project_proxy": project_proxy_component(settings, live_proxy_status),
        "mihomo": mihomo_component(settings),
        "scheduler": _component("ok", "任务调度器可用", details=scheduler),
        "ordered_crawls": _component("ok", "顺序批次管理器可用", details=ordered_crawls),
    }
    components.update(dedup_components(settings))
    ready = all(
        not item.get("required", True) or item.get("status") in _OK_STATUSES
        for item in components.values()
    )
    return {"ready": ready, "components": components, "time": time.time()}


def _directory_component(path: Path, label: str) -> dict[str, Any]:
    if not path.is_dir():
        return _component("error", f"{label}不存在")
    if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
        return _component("error", f"{label}不可读写")
    if os.name != "nt" and path.stat().st_mode & 0o077:
        return _component("error", f"{label}权限过宽，需要 0700")
    return _component("ok", f"{label}可读写且权限受限")


def _private_files_component(paths: list[Path], label: str) -> dict[str, Any]:
    existing = 0
    for path in paths:
        if path.is_symlink():
            return _component("error", f"{label}包含符号链接")
        if not path.exists():
            continue
        existing += 1
        if not path.is_file() or not os.access(path, os.R_OK | os.W_OK):
            return _component("error", f"{label}包含不可读写文件")
        if os.name != "nt" and path.stat().st_mode & 0o077:
            return _component("error", f"{label}文件权限过宽，需要 0600")
    return _component("ok", f"{label}权限受限", existing_file_count=existing)


def _model_permissions_component(settings: AppSettings) -> dict[str, Any]:
    if not settings.dedup.enabled:
        return _component("disabled", "模型缓存权限检查随去重禁用", required=False)
    directory = _directory_component(settings.dedup.model_dir, "模型缓存目录")
    if directory["status"] != "ok":
        return directory
    model_dir = settings.dedup.model_dir
    return _private_files_component(
        [
            model_dir / SSCD_FILENAME,
            model_dir / "embeddings.sqlite3",
            model_dir / "embeddings.sqlite3-wal",
            model_dir / "embeddings.sqlite3-shm",
            model_dir / DINO_CHECKPOINT,
        ],
        "模型与 embedding 缓存",
    )


def _external_output_component(settings: AppSettings) -> dict[str, Any]:
    if settings._lexically_inside(settings.default_output_root, settings.runtime_dir):
        return _component(
            "ok",
            "默认输出目录位于应用管理 runtime 内，权限由应用维护",
            required=False,
        )
    path = settings.default_output_root
    if not path.is_dir() or not os.access(path, os.R_OK | os.W_OK | os.X_OK):
        return _component("error", "外部输出目录不可读写", required=False)
    if os.name != "nt" and path.stat().st_mode & 0o022:
        return _component(
            "optional_warning",
            "外部输出目录可被组或其他用户写入；doctor 仅报告，不会修改",
            required=False,
        )
    return _component(
        "ok",
        "外部输出目录可用；权限由用户维护，doctor 不会修改",
        required=False,
    )


def _chrome_component(settings: AppSettings) -> dict[str, Any]:
    configured = settings.auth.chrome_executable.strip()
    candidate = configured if configured and Path(configured).is_file() else ""
    if not candidate:
        for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
            found = shutil.which(name)
            if found:
                candidate = found
                break
    if candidate:
        return _component(
            "ok",
            "检测到 Chrome/Chromium；桌面授权仍需要图形会话",
            required=False,
        )
    return _component(
        "optional_missing",
        "未检测到 Chrome/Chromium；仅影响桌面授权",
        required=False,
    )


def doctor_snapshot(settings: AppSettings) -> dict[str, Any]:
    expected_python = settings.project_dir / ".venv" / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    try:
        same_python = expected_python.is_file() and os.path.samefile(expected_python, sys.executable)
    except OSError:
        same_python = False
    dependencies = (
        "fastapi",
        "httpx",
        "pydantic",
        "requests",
        "uvicorn",
        "yaml",
    )
    missing_dependencies = [name for name in dependencies if importlib.util.find_spec(name) is None]
    backend_ok = same_python and not missing_dependencies

    config = settings.config_path
    if config is None or not config.is_file():
        config_component = _component("error", "正式配置文件不存在")
    elif os.name != "nt" and (
        config.stat().st_mode & 0o077 or config.stat().st_mode & 0o600 != 0o600
    ):
        config_component = _component("error", "配置文件权限需要 0600")
    else:
        config_component = _component("ok", "配置文件存在且权限受限")

    sqlite_parent = settings.database_path.parent
    sqlite_component = _directory_component(sqlite_parent, "SQLite 目录")
    if sqlite_component["status"] == "ok" and settings.database_path.is_file():
        try:
            connection = sqlite3.connect(
                f"file:{settings.database_path}?mode=ro", uri=True, timeout=2
            )
            try:
                connection.execute("SELECT 1").fetchone()
            finally:
                connection.close()
        except sqlite3.Error as exc:
            sqlite_component = _component("error", "SQLite 数据库不可读", reason=_safe_error(exc))

    install_proxy_present = bool(
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
    )
    components: dict[str, dict[str, Any]] = {
        "linux": _component(
            "ok" if sys.platform.startswith("linux") else "error",
            "Linux 主机" if sys.platform.startswith("linux") else "当前主机不是 Linux",
        ),
        "backend_python": _component(
            "ok" if backend_ok else "error",
            (
                f"后端 venv Python {sys.version_info.major}.{sys.version_info.minor} 依赖可用"
                if backend_ok
                else "后端 venv 或依赖不完整"
            ),
            missing_dependency_count=len(missing_dependencies),
        ),
        "gallery_source": _component(
            "ok"
            if (settings.gallery.repo_path / "gallery_dl" / "__init__.py").is_file()
            else "error",
            "gallery-dl submodule 可用"
            if (settings.gallery.repo_path / "gallery_dl" / "__init__.py").is_file()
            else "gallery-dl submodule 缺失",
        ),
        "config": config_component,
        "sqlite": sqlite_component,
        "sqlite_file_permissions": _private_files_component(
            [
                settings.database_path,
                Path(f"{settings.database_path}-wal"),
                Path(f"{settings.database_path}-shm"),
            ],
            "SQLite 主文件与 sidecar",
        ),
        "runtime_permissions": _directory_component(settings.runtime_dir, "runtime 目录"),
        "credentials_permissions": _directory_component(
            settings.gallery.cache_file.parent, "credentials/managed 目录"
        ),
        "model_cache_permissions": _model_permissions_component(settings),
        "external_output_permissions": _external_output_component(settings),
        "install_proxy": _component(
            "ok" if install_proxy_present else "disabled",
            (
                "检测到安装/下载代理环境变量；它不代表项目抓取代理池已配置"
                if install_proxy_present
                else "未设置安装/下载代理环境变量；这不代表项目抓取代理池状态"
            ),
            required=False,
        ),
        "project_proxy": project_proxy_component(settings),
        "mihomo": mihomo_component(settings, include_version=True),
        "chrome": _chrome_component(settings),
    }
    components.update(dedup_components(settings, use_cache=False))
    ready = all(
        not item.get("required", True) or item.get("status") in _OK_STATUSES
        for item in components.values()
    )
    return {"ready": ready, "components": components, "time": time.time()}


def _print_doctor(snapshot: dict[str, Any]) -> None:
    labels = {
        "ok": "通过",
        "error": "失败",
        "disabled": "禁用",
        "optional_missing": "可选缺失",
        "optional_warning": "提示",
    }
    print("ImageWeave Linux doctor")
    for name, item in snapshot["components"].items():
        label = labels.get(str(item.get("status")), str(item.get("status")))
        print(f"[{label}] {name}: {item.get('summary', '')}")
        if item.get("reason"):
            print(f"       原因：{item['reason']}")
        if name == "torch" and item.get("status") == "ok":
            print(
                "       "
                f"torch={item.get('version')}，实际设备={item.get('actual_device')}，"
                f"cuda_available={str(bool(item.get('cuda_available'))).lower()}，"
                f"CPU 禁止包={item.get('forbidden_cpu_package_count')}，"
                f"OpenCV={','.join(item.get('opencv_variants') or [])}"
            )
    print("doctor 结论：" + ("ready" if snapshot["ready"] else "not ready"))


def main() -> int:
    parser = argparse.ArgumentParser(description="ImageWeave Linux 快速部署诊断")
    parser.add_argument("--config", type=Path, required=True, help="后端 config.json")
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON")
    args = parser.parse_args()
    if not args.config.is_file():
        parser.error("配置文件不存在；请先运行 ./scripts/setup-linux.sh --device cpu")
    try:
        settings = AppSettings.load(args.config)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(f"配置加载失败：{_safe_error(exc)}")
    snapshot = doctor_snapshot(settings)
    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    else:
        _print_doctor(snapshot)
    return 0 if snapshot["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
