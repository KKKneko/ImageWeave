#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "dedup_review_worker.py"


def open_private_log(path: Path):
    for candidate in (*reversed(path.parents), path):
        if candidate.is_symlink():
            raise RuntimeError("真实模型日志路径不能包含符号链接")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | int(getattr(os, "O_NOFOLLOW", 0))
    descriptor = os.open(path, flags, 0o600)
    if hasattr(os, "fchmod"):
        os.fchmod(descriptor, 0o600)
    return os.fdopen(descriptor, "wb")


def generate_images(root: Path, base_images: int) -> int:
    """生成确定性的抽象图与 JPEG 重编码版本；样本完全由程序生成，可用于公开 CI。"""

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    size = 384
    yy, xx = np.mgrid[0:size, 0:size]
    for index in range(base_images):
        red = (xx * (index + 3) + yy * 2 + index * 31) % 256
        green = (yy * (index + 5) + xx // 2 + index * 47) % 256
        blue = ((xx + yy) * (index + 7) + index * 19) % 256
        array = np.stack((red, green, blue), axis=2).astype(np.uint8)
        image = Image.fromarray(array, mode="RGB")
        draw = ImageDraw.Draw(image)
        margin = 18 + (index % 5) * 7
        draw.rectangle(
            (margin, margin, size - margin, size - margin),
            outline=(255 - index % 120, 40 + index % 160, 120),
            width=5,
        )
        draw.ellipse(
            (80 + index % 30, 70, 280, 270 + index % 25),
            outline=(20, 240 - index % 120, 220),
            width=4,
        )
        image.save(root / f"generated-{index:03d}.png", optimize=True)
        image.save(root / f"generated-{index:03d}-jpeg.jpg", quality=88, optimize=True)
    return base_images * 2


def health_probe(url: str) -> tuple[bool, float]:
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
            ok = response.status == 200 and bool(body.get("ok"))
    except Exception:
        ok = False
    return ok, time.perf_counter() - started


def main() -> int:
    parser = argparse.ArgumentParser(description="真实 SSCD+DINOv2 Linux CPU worker 闭环")
    parser.add_argument("--base-images", type=int, default=4, help="基础图数量；实际图片为两倍")
    parser.add_argument("--model-dir", type=Path, default=ROOT / ".models")
    parser.add_argument("--work-dir", type=Path, help="保留样本、manifest 与日志；默认使用临时目录")
    parser.add_argument("--report", type=Path, help="额外写出不含样本绝对路径的 JSON 报告")
    parser.add_argument("--health-url", default="", help="worker 运行期间轮询已启动服务的 /healthz")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--torch-threads", type=int, default=0)
    parser.add_argument("--torch-interop-threads", type=int, default=0)
    parser.add_argument("--deep-batch-size", type=int, default=0)
    parser.add_argument("--neighbor-block-size", type=int, default=0)
    args = parser.parse_args()
    if args.base_images < 2:
        parser.error("--base-images 必须大于等于 2")
    if os.name != "nt":
        os.umask(0o077)

    temporary: tempfile.TemporaryDirectory[str] | None = None
    if args.work_dir:
        work_dir = args.work_dir.absolute()
        if work_dir.is_symlink():
            parser.error("--work-dir 不能是符号链接")
        work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        work_dir.chmod(0o700)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="imageweave-model-smoke-")
        work_dir = Path(temporary.name)

    try:
        image_dir = work_dir / "images"
        manifest_path = work_dir / "manifest.json"
        log_path = work_dir / "worker.log"
        image_count = generate_images(image_dir, args.base_images)
        command = [
            sys.executable,
            str(WORKER),
            str(image_dir),
            "--output",
            str(manifest_path),
            "--core-script",
            str(ROOT / "dedup_core.py"),
            "--model-dir",
            str(args.model_dir.absolute()),
            "--device",
            "cpu",
            "--workers",
            str(args.workers),
            "--torch-threads",
            str(args.torch_threads),
            "--torch-interop-threads",
            str(args.torch_interop_threads),
            "--deep-batch-size",
            str(args.deep_batch_size),
            "--neighbor-block-size",
            str(args.neighbor_block_size),
        ]
        started = time.perf_counter()
        probes = 0
        probe_failures = 0
        max_health_latency = 0.0
        with open_private_log(log_path) as log_file:
            process = subprocess.Popen(
                command,
                cwd=str(ROOT),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"},
            )
            while process.poll() is None:
                if args.health_url:
                    ok, latency = health_probe(args.health_url)
                    probes += 1
                    probe_failures += int(not ok)
                    max_health_latency = max(max_health_latency, latency)
                time.sleep(1)
            return_code = process.wait()
        elapsed = time.perf_counter() - started
        if return_code != 0:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise RuntimeError(f"真实模型 worker 失败（退出码 {return_code}）：\n{tail}")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        analysis = manifest.get("analysis") or {}
        resources = analysis.get("resources") or {}
        if int((manifest.get("counts") or {}).get("images") or 0) != image_count:
            raise RuntimeError("真实模型 manifest 图片计数不一致")
        if analysis.get("device") != "cpu":
            raise RuntimeError(f"真实模型 worker 未使用 CPU: {analysis.get('device')}")
        if analysis.get("models") != {"sscd": True, "dinov2": True}:
            raise RuntimeError("真实模型 worker 未同时启用 SSCD 与 DINOv2")
        for name in (
            "workers",
            "deep_batch_size",
            "neighbor_block_size",
            "torch_threads",
            "torch_interop_threads",
        ):
            if not isinstance(resources.get(name), int) or resources[name] < 1:
                raise RuntimeError(f"manifest 缺少实际资源参数: {name}")
        if probes and probe_failures:
            raise RuntimeError(f"worker 运行期间 /healthz 失败 {probe_failures}/{probes} 次")

        peak_rss_kib = int(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
        report = {
            "ok": True,
            "generated_images": image_count,
            "elapsed_seconds": round(elapsed, 3),
            "peak_rss_kib": peak_rss_kib,
            "analysis": {
                "device": analysis.get("device"),
                "models": analysis.get("models"),
                "resources": resources,
                "timings_seconds": analysis.get("timings_seconds"),
            },
            "manifest_counts": manifest.get("counts"),
            "health_probes": probes,
            "health_probe_failures": probe_failures,
            "max_health_latency_seconds": round(max_health_latency, 6) if probes else None,
        }
        encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        print(encoded, end="")
        if args.report:
            report_path = args.report.absolute()
            if report_path.is_symlink():
                raise RuntimeError("报告路径不能是符号链接")
            report_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            report_path.write_text(encoded, encoding="utf-8")
            report_path.chmod(0o600)
        return 0
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
