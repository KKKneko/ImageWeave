from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


WORKSPACE_DIR = Path(__file__).resolve().parent
DEFAULT_CORE_SCRIPT = WORKSPACE_DIR / "dedup_core.py"
DEFAULT_MODEL_DIR = WORKSPACE_DIR / ".models"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".gif"}


class UnionFind:
    def __init__(self, values: list[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, first: str, second: str) -> None:
        first_root = self.find(first)
        second_root = self.find(second)
        if first_root != second_root:
            self.parent[second_root] = first_root


def normalized_path(value: str | os.PathLike[str]) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(value)))


def find_review_images(root: Path) -> list[str]:
    images: list[str] = []
    for current_root, directories, files in os.walk(root):
        # 与核心脚本 find_images 一致：跳过 duplicates/keep 产物目录，避免已淘汰图重新入组
        directories[:] = [
            name for name in directories
            if name.lower() not in {"duplicates", "keep"}
            and not os.path.islink(os.path.join(current_root, name))
        ]
        for name in files:
            path = os.path.join(current_root, name)
            if Path(name).suffix.lower() in IMAGE_EXTENSIONS and not os.path.islink(path):
                images.append(path)
    return sorted(images, key=normalized_path)


def stable_id(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8", "surrogatepass"))
        digest.update(b"\0")
    return digest.hexdigest()[:32]


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        return json_value(item())
    return str(value)


def load_core(script_path: Path):
    if not script_path.is_file():
        raise FileNotFoundError(f"去重核心脚本不存在: {script_path}")
    spec = importlib.util.spec_from_file_location("dedup_review_core", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"加载去重核心脚本失败: {script_path}")
    sys.path.insert(0, str(script_path.parent))
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # 核心在分析阶段才惰性 import dedup_models，趁核心目录还在 sys.path 先预导入缓存；
        # 依赖缺失时不在此报错，留给核心惰性导入处的友好提示
        try:
            import dedup_models  # noqa: F401
        except ImportError:
            pass
        return module
    finally:
        try:
            sys.path.remove(str(script_path.parent))
        except ValueError:
            pass


def relative_image_path(root: Path, path: str) -> str:
    resolved = Path(path).resolve()
    if resolved == root or not resolved.is_relative_to(root):
        raise ValueError(f"图片路径超出批次目录: {resolved}")
    return resolved.relative_to(root).as_posix()


def public_image_info(info: dict[str, Any], root: Path) -> dict[str, Any]:
    relative_path = relative_image_path(root, info["path"])
    fields = (
        "file_hash",
        "pixel_hash",
        "w",
        "h",
        "ext",
        "format",
        "size",
        "frames",
        "has_transparency",
        "icc_profile_hash",
        "bit_depth",
        "lossless",
        "sharpness",
        "blockiness",
        "noise_sigma",
        "jpeg_quality",
        "jpeg_quality_error",
        "jpeg_quant_mean",
    )
    metadata = {field: json_value(info.get(field)) for field in fields}
    return {
        "id": stable_id(relative_path, str(info.get("file_hash") or "")),
        "relative_path": relative_path,
        "readable": True,
        "metadata": metadata,
    }


def unreadable_image_info(path: str, root: Path, core: Any) -> dict[str, Any]:
    relative_path = relative_image_path(root, path)
    try:
        size = Path(path).stat().st_size
    except OSError:
        size = 0
    try:
        file_hash = core.file_sha256(path)
    except OSError:
        file_hash = ""
    return {
        "id": stable_id(relative_path, file_hash),
        "relative_path": relative_path,
        "readable": False,
        "metadata": {
            "file_hash": file_hash,
            "size": size,
            "format": Path(path).suffix.lstrip(".").upper(),
            "read_error": "图片解码或特征提取失败",
        },
    }


def build_manifest(
    root: Path,
    image_paths: list[str],
    image_infos: list[dict[str, Any]],
    auto_groups: list[dict[str, Any]],
    review_groups: list[list[dict[str, Any]]],
    core: Any,
) -> dict[str, Any]:
    root = root.resolve()
    all_info_by_path = {normalized_path(info["path"]): info for info in image_infos}
    automatic_groups: list[dict[str, Any]] = []
    automatic_rejected_paths: set[str] = set()

    for group in auto_groups:
        kind = str(group.get("kind") or "")
        if kind not in {"exact", "compression"}:
            raise ValueError(f"未知的自动去重组类型: {kind}")
        winner_key = normalized_path(group["winner"]["path"])
        winner_info = all_info_by_path.get(winner_key)
        if winner_info is None:
            raise ValueError("自动去重组的保留图不在扫描结果中")
        rejected_items = []
        for member in group.get("members", []):
            key = normalized_path(member["path"])
            if key == winner_key:
                continue
            info = all_info_by_path.get(key)
            if info is None:
                raise ValueError("自动去重组包含扫描结果之外的图片")
            if key in automatic_rejected_paths:
                raise ValueError("图片重复出现在多个自动去重组中")
            automatic_rejected_paths.add(key)
            item = public_image_info(info, root)
            item["recommended"] = False
            item["review_metrics"] = None
            rejected_items.append(item)
        if not rejected_items:
            continue
        winner = public_image_info(winner_info, root)
        winner["recommended"] = True
        winner["review_metrics"] = None
        label = "L0-完全相同" if kind == "exact" else "L1-压缩同源"
        group_id = stable_id(
            "automatic",
            kind,
            winner["id"],
            *(item["id"] for item in sorted(rejected_items, key=lambda item: item["id"])),
        )
        automatic_groups.append(
            {
                "id": group_id,
                "kind": kind,
                "match_levels": [label],
                "reason": str(group.get("reason") or ""),
                "winner": winner,
                "rejected_items": rejected_items,
            }
        )

    info_by_path = {
        key: info
        for key, info in all_info_by_path.items()
        if key not in automatic_rejected_paths
    }
    union_find = UnionFind(list(info_by_path))
    relations: list[tuple[list[str], set[str]]] = []
    metrics_by_path: dict[str, dict[str, Any]] = {}

    def connect(paths: list[str], labels: set[str]) -> None:
        keys = [normalized_path(path) for path in paths if normalized_path(path) in info_by_path]
        if len(keys) < 2:
            return
        first = keys[0]
        for key in keys[1:]:
            union_find.union(first, key)
        relations.append((keys, labels))

    for group in review_groups:
        labels = {
            str(metrics.get("candidate_level"))
            for member in group
            if (metrics := member.get("review_metrics")) and metrics.get("candidate_level")
        }
        connect([member["path"] for member in group], labels or {"L1/L2-人工候选"})
        for member in group:
            metrics = member.get("review_metrics")
            if metrics:
                metrics_by_path[normalized_path(member["path"])] = json_value(metrics)

    components: dict[str, list[str]] = defaultdict(list)
    for key in info_by_path:
        components[union_find.find(key)].append(key)

    relation_labels: dict[str, set[str]] = defaultdict(set)
    for keys, labels in relations:
        relation_labels[union_find.find(keys[0])].update(labels)

    groups: list[dict[str, Any]] = []
    for component_root, keys in components.items():
        infos = [info_by_path[key] for key in keys]
        winner, reason = core.choose_quality_winner(infos)
        winner_key = normalized_path(winner["path"])
        items = []
        for key in keys:
            item = public_image_info(info_by_path[key], root)
            item["recommended"] = key == winner_key
            item["review_metrics"] = metrics_by_path.get(key)
            items.append(item)
        items.sort(key=lambda item: (not item["recommended"], item["relative_path"].casefold()))
        group_id = stable_id(*(item["id"] for item in sorted(items, key=lambda item: item["id"])))
        groups.append(
            {
                "id": group_id,
                "kind": "duplicate" if len(items) > 1 else "single",
                "match_levels": sorted(relation_labels.get(component_root, set())),
                "reason": reason,
                "items": items,
            }
        )

    valid_paths = set(all_info_by_path)
    for path in image_paths:
        if normalized_path(path) in valid_paths:
            continue
        item = unreadable_image_info(path, root, core)
        groups.append(
            {
                "id": stable_id("unreadable", item["id"]),
                "kind": "unreadable",
                "match_levels": [],
                "reason": "图片读取失败",
                "items": [{**item, "recommended": False, "review_metrics": None}],
            }
        )

    kind_order = {"duplicate": 0, "unreadable": 1, "single": 2}
    groups.sort(
        key=lambda group: (
            kind_order.get(group["kind"], 9),
            group["items"][0]["relative_path"].casefold(),
        )
    )
    for ordinal, group in enumerate(groups, 1):
        group["ordinal"] = ordinal
        for item_ordinal, item in enumerate(group["items"], 1):
            item["ordinal"] = item_ordinal

    automatic_groups.sort(
        key=lambda group: (
            group["kind"],
            group["winner"]["relative_path"].casefold(),
        )
    )
    for ordinal, group in enumerate(automatic_groups, 1):
        group["ordinal"] = ordinal
        group["winner"]["ordinal"] = 1
        group["rejected_items"].sort(
            key=lambda item: item["relative_path"].casefold()
        )
        for item_ordinal, item in enumerate(group["rejected_items"], 1):
            item["ordinal"] = item_ordinal

    return {
        "schema_version": 2,
        "root": str(root),
        "generated_at": time.time(),
        "counts": {
            "images": len(image_paths),
            "review_images": sum(len(group["items"]) for group in groups),
            "groups": len(groups),
            "duplicate_groups": sum(group["kind"] == "duplicate" for group in groups),
            "single_groups": sum(group["kind"] == "single" for group in groups),
            "unreadable_images": sum(group["kind"] == "unreadable" for group in groups),
            "automatic_groups": len(automatic_groups),
            "automatic_rejected_images": sum(
                len(group["rejected_items"]) for group in automatic_groups
            ),
        },
        "auto_groups": automatic_groups,
        "groups": groups,
    }


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser(description="为聚合爬图批次生成 L0-L2 全图片审核清单")
    parser.add_argument("root", type=Path, help="批次图片根目录")
    parser.add_argument("--output", type=Path, required=True, help="审核清单 JSON 输出路径")
    parser.add_argument("--core-script", type=Path, default=DEFAULT_CORE_SCRIPT)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument("--no-sscd", action="store_true")
    parser.add_argument("--no-dino", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        parser.error(f"批次图片目录不存在: {root}")
    if args.workers < 1:
        parser.error("--workers 必须大于等于 1")

    core = load_core(args.core_script.resolve())
    core_arguments = [
        str(root),
        "--no-gui",
        "--dry-run",
        "--model-dir",
        str(args.model_dir.resolve()),
        "--device",
        args.device,
        "--workers",
        str(args.workers),
    ]
    if args.no_sscd:
        core_arguments.append("--no-sscd")
    if args.no_dino:
        core_arguments.append("--no-dino")
    core_parser = core.build_argument_parser()
    core_args = core_parser.parse_args(core_arguments)
    core.validate_args(core_parser, core_args)

    image_paths = find_review_images(root)
    image_infos: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(core.get_image_info, path): path for path in image_paths}
        for future in as_completed(futures):
            result = future.result()
            if result is not None:
                image_infos.append(result)

    image_infos.sort(key=lambda info: normalized_path(info["path"]))
    if image_infos:
        auto_groups, review_groups = core.analyze_images(image_infos, core_args)
    else:
        auto_groups, review_groups = [], []
    manifest = build_manifest(root, image_paths, image_infos, auto_groups, review_groups, core)
    actual_device = args.device
    if not args.no_sscd or not args.no_dino:
        from dedup_models import resolve_device

        actual_device = resolve_device(args.device)
    manifest["analysis"] = {
        "device": actual_device,
        "models": {
            "sscd": not args.no_sscd,
            "dinov2": not args.no_dino,
        },
    }
    write_manifest(args.output.resolve(), manifest)
    print(
        "审核清单完成: "
        f"{manifest['counts']['images']} 张图片, "
        f"严格自动淘汰 {manifest['counts']['automatic_rejected_images']} 张, "
        f"{manifest['counts']['duplicate_groups']} 个人工重复组"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
