from __future__ import annotations

import os
import threading
from dataclasses import asdict, dataclass
from typing import Any, Sequence


_INTEROP_LOCK = threading.Lock()
_INTEROP_CONFIGURED = False


@dataclass(frozen=True, slots=True)
class DedupResourceProfile:
    """去重进程实际采用的资源边界。0 只存在于配置输入，解析后均为正整数。"""

    requested_device: str
    cpu_count: int
    workers: int
    model_decode_workers: int
    deep_batch_size: int
    neighbor_block_size: int
    torch_threads: int | None
    torch_interop_threads: int | None
    opencv_threads: int | None

    def manifest_dict(self) -> dict[str, Any]:
        return asdict(self)


def _positive(value: int | str | None) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def build_resource_profile(
    requested_device: str,
    *,
    workers: int = 0,
    deep_batch_size: int = 0,
    neighbor_block_size: int = 0,
    torch_threads: int = 0,
    torch_interop_threads: int = 0,
    cpu_count: int | None = None,
) -> DedupResourceProfile:
    """把 0（自动）解析为 CPU 保守档或原有 CUDA/auto 性能档。"""

    device = str(requested_device or "auto").strip().lower()
    logical_cpus = max(1, int(cpu_count or os.cpu_count() or 1))
    available_cpus = max(1, logical_cpus - 1)
    cpu_mode = device == "cpu"

    if cpu_mode:
        default_workers = min(4, max(1, (available_cpus + 3) // 4))
        default_torch_threads = min(4, max(1, available_cpus // 2))
        default_batch = min(4, max(1, logical_cpus // 8))
        default_block = min(256, max(64, logical_cpus * 8))
        resolved_torch_threads: int | None = _positive(torch_threads) or default_torch_threads
        resolved_interop: int | None = _positive(torch_interop_threads) or 1
        opencv_threads: int | None = 1
        resolved_workers = _positive(workers) or default_workers
        model_decode_workers = resolved_workers
    else:
        # CUDA 与 auto 沿用原来的 8 worker / batch 8 / block 512；未显式配置时
        # 不改 Torch、OpenMP 或 OpenCV 线程语义。
        default_workers = min(8, logical_cpus)
        default_batch = 8
        default_block = 512
        resolved_torch_threads = _positive(torch_threads) or None
        resolved_interop = _positive(torch_interop_threads) or None
        opencv_threads = None
        resolved_workers = _positive(workers) or default_workers
        # 模型解码池原本固定最多 4；CUDA/auto 不因资源配置接入而被放大。
        model_decode_workers = min(4, logical_cpus)

    return DedupResourceProfile(
        requested_device=device,
        cpu_count=logical_cpus,
        workers=resolved_workers,
        model_decode_workers=model_decode_workers,
        deep_batch_size=_positive(deep_batch_size) or default_batch,
        neighbor_block_size=_positive(neighbor_block_size) or default_block,
        torch_threads=resolved_torch_threads,
        torch_interop_threads=resolved_interop,
        opencv_threads=opencv_threads,
    )


def apply_thread_environment(profile: DedupResourceProfile) -> None:
    """在导入 Torch/OpenCV 前设置原生线程库上限。"""

    if profile.torch_threads is None:
        return
    value = str(profile.torch_threads)
    for name in (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
    ):
        os.environ[name] = value


def configure_process_resources(profile: DedupResourceProfile) -> dict[str, Any]:
    """在任何并行分析前配置库线程；inter-op 每进程最多设置一次。"""

    global _INTEROP_CONFIGURED
    apply_thread_environment(profile)
    actual = profile.manifest_dict()

    if profile.torch_threads is not None:
        import torch

        torch.set_num_threads(profile.torch_threads)
        if profile.torch_interop_threads is not None:
            with _INTEROP_LOCK:
                if not _INTEROP_CONFIGURED:
                    try:
                        torch.set_num_interop_threads(profile.torch_interop_threads)
                    except RuntimeError:
                        # Torch 在更早的第三方代码中初始化过 inter-op 时不允许再次设置；
                        # 保留真实值并继续，避免重复调用导致 worker 直接失败。
                        pass
                    _INTEROP_CONFIGURED = True
        actual["torch_threads"] = int(torch.get_num_threads())
        actual["torch_interop_threads"] = int(torch.get_num_interop_threads())

    if profile.opencv_threads is not None:
        import cv2

        cv2.setNumThreads(profile.opencv_threads)
        actual["opencv_threads"] = int(cv2.getNumThreads())

    actual["omp_num_threads"] = os.environ.get("OMP_NUM_THREADS")
    actual["mkl_num_threads"] = os.environ.get("MKL_NUM_THREADS")
    return actual


def profile_from_argv(arguments: Sequence[str]) -> DedupResourceProfile | None:
    """轻量扫描 CLI 资源参数，供重型数值库导入前预设环境。"""

    values: dict[str, str] = {}
    names = {
        "--device": "device",
        "--workers": "workers",
        "--deep-batch-size": "deep_batch_size",
        "--neighbor-block-size": "neighbor_block_size",
        "--torch-threads": "torch_threads",
        "--torch-interop-threads": "torch_interop_threads",
    }
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        matched = False
        for option, key in names.items():
            if argument == option and index + 1 < len(arguments):
                values[key] = arguments[index + 1]
                index += 2
                matched = True
                break
            if argument.startswith(option + "="):
                values[key] = argument.split("=", 1)[1]
                index += 1
                matched = True
                break
        if not matched:
            index += 1

    if values.get("device", "auto").strip().lower() != "cpu":
        return None
    return build_resource_profile(
        "cpu",
        workers=_positive(values.get("workers")),
        deep_batch_size=_positive(values.get("deep_batch_size")),
        neighbor_block_size=_positive(values.get("neighbor_block_size")),
        torch_threads=_positive(values.get("torch_threads")),
        torch_interop_threads=_positive(values.get("torch_interop_threads")),
    )
