#!/usr/bin/env python3
from __future__ import annotations

import importlib.metadata as metadata
import json


EXPECTED = {
    "numpy": "2.4.2",
    "opencv-python-headless": "4.13.0.92",
    "pillow": "12.1.1",
    "torch": "2.11.0+cpu",
    "torchvision": "0.26.0+cpu",
    "tqdm": "4.67.3",
}
FORBIDDEN_EXACT = {
    "cuda-bindings",
    "cuda-pathfinder",
    "cuda-toolkit",
    "opencv-contrib-python",
    "opencv-contrib-python-headless",
    "opencv-python",
    "pytorch-triton",
    "triton",
}


def main() -> int:
    names = {
        dist.metadata["Name"].lower(): dist.version
        for dist in metadata.distributions()
        if dist.metadata.get("Name")
    }
    errors: list[str] = []
    for name, expected in EXPECTED.items():
        actual = names.get(name)
        if actual != expected:
            errors.append(f"{name}: 期望 {expected}，实际 {actual or 'missing'}")
    forbidden = sorted(
        name
        for name in names
        if name.startswith("nvidia-") or name in FORBIDDEN_EXACT
    )
    if forbidden:
        errors.append("发现 CPU 禁止包: " + ", ".join(forbidden))

    try:
        import torch
    except Exception as exc:
        errors.append(f"Torch 导入失败: {type(exc).__name__}: {exc}")
        cuda_available = None
        torch_cuda = None
    else:
        cuda_available = bool(torch.cuda.is_available())
        torch_cuda = torch.version.cuda
        if cuda_available:
            errors.append("torch.cuda.is_available() 必须为 false")
        if torch_cuda is not None:
            errors.append(f"torch.version.cuda 必须为 None，实际为 {torch_cuda}")

    result = {
        "ok": not errors,
        "versions": {name: names.get(name) for name in EXPECTED},
        "cuda_available": cuda_available,
        "torch_version_cuda": torch_cuda,
        "forbidden_packages": forbidden,
        "errors": errors,
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
