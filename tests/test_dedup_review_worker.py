import importlib.util
import tempfile
import unittest
from pathlib import Path

import dedup_review_worker as worker


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dedup_review_test_core", ROOT / "差分去除_优化版.py")
CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORE)


def image_info(path: Path, rank: int) -> dict:
    return {
        "path": str(path),
        "file_hash": f"file-{rank}",
        "pixel_hash": f"pixel-{rank}",
        "w": 100 + rank,
        "h": 100 + rank,
        "ext": ".png",
        "format": "PNG",
        "size": 1000 + rank,
        "frames": 1,
        "has_transparency": False,
        "icc_profile_hash": None,
        "bit_depth": 8,
        "lossless": True,
        "sharpness": 10.0 + rank,
        "blockiness": 0.0,
        "noise_sigma": 0.0,
        "jpeg_quality": None,
        "jpeg_quality_error": None,
        "jpeg_quant_mean": None,
    }


class ReviewManifestTests(unittest.TestCase):
    def test_original_auto_winner_is_kept_and_only_losers_are_marked_automatic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            paths = [root / f"{name}.png" for name in ("a", "b", "c")]
            for path in paths:
                path.write_bytes(path.name.encode("ascii"))
            infos = [image_info(path, index) for index, path in enumerate(paths, 1)]
            auto_groups = [
                {
                    "kind": "exact",
                    "members": infos[:2],
                    "winner": infos[1],
                    "reason": "分辨率更高",
                }
            ]
            review_groups = [
                [
                    {**infos[1], "review_metrics": None},
                    {
                        **infos[2],
                        "review_metrics": {
                            "candidate_level": "L2-结构",
                            "candidate_score": 0.9,
                        },
                    },
                ]
            ]

            manifest = worker.build_manifest(
                root,
                [str(path) for path in paths],
                infos,
                auto_groups,
                review_groups,
                CORE,
            )
            self.assertEqual(manifest["counts"]["images"], 3)
            self.assertEqual(manifest["counts"]["review_images"], 2)
            self.assertEqual(manifest["counts"]["automatic_groups"], 1)
            self.assertEqual(manifest["counts"]["automatic_rejected_images"], 1)
            self.assertEqual(manifest["counts"]["duplicate_groups"], 1)
            self.assertEqual(len(manifest["groups"]), 1)
            automatic = manifest["auto_groups"][0]
            self.assertEqual(automatic["kind"], "exact")
            self.assertEqual(automatic["winner"]["relative_path"], "b.png")
            self.assertEqual(
                [item["relative_path"] for item in automatic["rejected_items"]],
                ["a.png"],
            )
            group = manifest["groups"][0]
            self.assertEqual(len(group["items"]), 2)
            self.assertEqual(group["match_levels"], ["L2-结构"])
            self.assertEqual(
                {item["relative_path"] for item in group["items"]},
                {"b.png", "c.png"},
            )

    def test_decode_failure_still_enters_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            broken = root / "broken.png"
            broken.write_bytes(b"not-an-image")
            manifest = worker.build_manifest(
                root,
                [str(broken)],
                [],
                [],
                [],
                CORE,
            )
            self.assertEqual(manifest["schema_version"], 2)
            self.assertEqual(manifest["counts"]["images"], 1)
            self.assertEqual(manifest["counts"]["unreadable_images"], 1)
            self.assertEqual(manifest["groups"][0]["kind"], "unreadable")
            self.assertFalse(manifest["groups"][0]["items"][0]["readable"])

    def test_review_scan_prunes_keep_and_duplicates_directories(self):
        # 与核心脚本 find_images 一致：keep/duplicates 产物目录（任意深度、不分大小写）
        # 必须剪掉，避免已淘汰图在重新分析时回流；仅精确目录名被剪，普通目录不受影响。
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for directory, name in (
                ("keep", "kept.png"),
                ("duplicates", "old.jpg"),
                ("nested/Keep", "upper.png"),
                ("artist/duplicates", "deep.png"),
            ):
                path = root / directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
            expected = []
            for directory, name in (
                ("", "top.png"),
                ("artist", "normal.jpg"),
                ("keepsake", "similar.png"),
                ("duplicates_old", "archive.png"),
            ):
                path = (root / directory / name) if directory else (root / name)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
                expected.append(str(path))
            self.assertEqual(worker.find_review_images(root), sorted(expected, key=worker.normalized_path))


if __name__ == "__main__":
    unittest.main()
