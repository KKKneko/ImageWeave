import contextlib
import importlib.util
import io
import random
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SCRIPT_PATH = ROOT / "dedup_core.py"
SPEC = importlib.util.spec_from_file_location("dedup_script_gate", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)


def build_default_args():
    return SimpleNamespace(
        no_sscd=False,
        no_dino=False,
        sscd_review_threshold=0.72,
        dino_review_threshold=0.82,
        edge_review_threshold=0.32,
        geometry_review_threshold=0.035,
        dino_phash_threshold=18,
        deep_max_aspect_delta=0.20,
        hash_threshold=12,
        compression_hash_threshold=20,
        similarity_threshold=0.88,
        compression_noise_residual_std=0.45,
        compression_noise_edge_correlation=0.05,
        compression_noise_sigma_delta=0.25,
        no_auto_compression=False,
        compression_ssim=0.985,
        compression_psnr=32.0,
        compression_block_ssim=0.965,
        compression_resized_ssim=0.985,
        compression_resized_psnr=35.0,
        compression_resized_block_ssim=0.98,
        compression_max_resolution_ratio=4.1,
        compression_block_mae=0.045,
        compression_color_mae=0.025,
        compression_gray_peak=0.06,
        compression_color_peak=0.06,
        sscd_auto_threshold=0.94,
    )


# A 路（is_l1_auto_candidate）对昂贵字段单调：取各字段最有利的极值后，
# 门控判死的组合仍必须为 False，才能证明门控是必要条件。
A_PATH_BEST_EXPENSIVE = {
    "ssim": 1.0,
    "psnr": float("inf"),
    "block_ssim_p10": 1.0,
    "coarse_ssim": 1.0,
    "coarse_psnr": float("inf"),
    "coarse_block_ssim_p10": 1.0,
    "alpha_mae": 0.0,
    "alpha_local_peak": 0.0,
    "max_block_mae": 0.0,
    "color_mae": 0.0,
    "gray_local_peak": 0.0,
    "color_local_peak": 0.0,
    # 噪声签名对 A 路是一票否决，取不会触发的极值。
    "residual_std": 0.0,
    "residual_edge_correlation": 1.0,
    "noise_sigma_delta": 0.0,
}

# review 三条路（B/C/D）的最有利值；残差字段取能触发噪声签名的极值，
# 以照顾 is_review_candidate 的 protected 分支。
REVIEW_PATH_BEST_EXPENSIVE = {
    "review_score": 1.0,
    "edge_similarity": 1.0,
    "geometric_similarity": 1.0,
    "residual_std": 99.0,
    "residual_edge_correlation": 0.0,
    "noise_sigma_delta": 99.0,
}

ASPECT_BOUNDARIES = (0.005, 0.03, 0.20)
HASH_BOUNDARIES = (12, 18, 20)
RATIO_BOUNDARIES = (1.05, 4.1)
SSCD_BOUNDARIES = (0.72, 0.94)
DINO_BOUNDARIES = (0.82,)


def sample_cheap_scalars(rng):
    def maybe_boundary(value, boundaries):
        return rng.choice(boundaries) if rng.random() < 0.2 else value

    sscd = None if rng.random() < 0.25 else maybe_boundary(rng.uniform(-0.1, 1.0), SSCD_BOUNDARIES)
    dino = None if rng.random() < 0.25 else maybe_boundary(rng.uniform(-0.1, 1.0), DINO_BOUNDARIES)
    return {
        "aspect_delta": maybe_boundary(rng.uniform(0.0, 0.3), ASPECT_BOUNDARIES),
        "resolution_ratio": maybe_boundary(rng.uniform(1.0, 6.0), RATIO_BOUNDARIES),
        "hash_distance": maybe_boundary(rng.randint(0, 40), HASH_BOUNDARIES),
        "sscd_similarity": sscd,
        "dino_similarity": dino,
        "same_size_lossless": rng.random() < 0.5,
        "icc_mismatch": rng.random() < 0.5,
        "alpha_mismatch": rng.random() < 0.5,
    }


class GateNecessityTests(unittest.TestCase):
    """守卫测试：cheap_pair_gate 判死的组合，四条判定路径必须全部不可能通过。"""

    def run_necessity_property(self, args, rng, samples):
        killed = 0
        for _ in range(samples):
            scalars = sample_cheap_scalars(rng)
            if DEDUP.cheap_pair_gate(args, **scalars):
                continue
            killed += 1
            metrics_auto = {**scalars, **A_PATH_BEST_EXPENSIVE}
            metrics_review = {**scalars, **REVIEW_PATH_BEST_EXPENSIVE}
            self.assertFalse(
                DEDUP.is_l1_auto_candidate(metrics_auto, args),
                msg=f"门控判死但 A 路仍可通过: {scalars}",
            )
            self.assertEqual(
                DEDUP.classify_review_candidate(metrics_review, args),
                (None, 0.0),
                msg=f"门控判死但 review 路仍可通过: {scalars}",
            )
        # 确认样本中确实有足够多被判死的组合，防止性质测试空转。
        self.assertGreater(killed, samples // 10)

    def test_gate_is_necessary_condition_with_default_thresholds(self):
        self.run_necessity_property(build_default_args(), random.Random(20260727), 20000)

    def test_gate_stays_necessary_after_threshold_perturbation(self):
        perturbed_names = (
            "sscd_review_threshold",
            "sscd_auto_threshold",
            "dino_review_threshold",
            "edge_review_threshold",
            "hash_threshold",
            "compression_hash_threshold",
            "dino_phash_threshold",
        )
        for seed in (11, 173, 9001):
            rng = random.Random(seed)
            args = build_default_args()
            for name in perturbed_names:
                setattr(args, name, getattr(args, name) * rng.uniform(0.8, 1.2))
            self.run_necessity_property(args, rng, 20000)


def make_smooth_base_image():
    height, width = 160, 192
    grid_x, grid_y = np.meshgrid(
        np.linspace(0.0, 1.0, width, dtype=np.float32),
        np.linspace(0.0, 1.0, height, dtype=np.float32),
    )
    image = np.stack([
        40 + 170 * grid_x,
        60 + 150 * grid_y,
        80 + 60 * (grid_x + grid_y),
    ], axis=2).astype(np.uint8)
    cv2.circle(image, (70, 60), 34, (210, 120, 60), -1)
    cv2.rectangle(image, (110, 90), (170, 140), (40, 160, 200), -1)
    return cv2.GaussianBlur(image, (7, 7), 0)


class ParallelDeterminismTests(unittest.TestCase):
    """workers=1 与 workers=8 的 analyze_images 输出结构必须完全一致。"""

    @staticmethod
    def build_fixture_images(directory):
        base = make_smooth_base_image()
        Image.fromarray(base).save(directory / "base.png")
        Image.fromarray(base).save(directory / "base_same_pixels.bmp")
        Image.fromarray(base).save(directory / "base_q85.jpg", quality=85)
        half = cv2.resize(
            base, (base.shape[1] // 2, base.shape[0] // 2), interpolation=cv2.INTER_AREA
        )
        Image.fromarray(half).save(directory / "base_half.png")
        variant = base.copy()
        variant[40:72, 52:96] = (205, 40, 45)
        Image.fromarray(variant).save(directory / "base_variant.png")
        # 横向拉伸 8%：pHash 依旧接近（仍会成为候选），但 aspect_delta≈0.075
        # 超出四条门的宽高比上限，应被廉价门控跳过且不进任何组。
        stretched = cv2.resize(base, (207, base.shape[0]), interpolation=cv2.INTER_CUBIC)
        Image.fromarray(stretched).save(directory / "base_stretched.png")
        rng = np.random.default_rng(20260727)
        for index in range(4):
            noise = rng.integers(0, 256, size=base.shape, dtype=np.uint8)
            Image.fromarray(noise).save(directory / f"random_{index}.png")

    @staticmethod
    def normalize_results(auto_groups, review_groups):
        auto = [
            (
                group["kind"],
                group["reason"],
                group["winner"]["path"],
                [member["path"] for member in group["members"]],
            )
            for group in auto_groups
        ]
        review = [
            [
                (
                    item["path"],
                    None if item["review_metrics"] is None
                    else item["review_metrics"]["candidate_level"],
                )
                for item in group
            ]
            for group in review_groups
        ]
        return auto, review

    def test_worker_count_does_not_change_grouping(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            self.build_fixture_images(temp_path)
            image_paths = DEDUP.find_images(str(temp_path))
            self.assertGreaterEqual(len(image_paths), 10)

            results = []
            skipped_counts = []
            for worker_count in (1, 8):
                args = DEDUP.build_argument_parser().parse_args(
                    [str(temp_path), "--no-gui", "--dry-run", "--no-sscd", "--no-dino"]
                )
                args.workers = worker_count
                infos = [DEDUP.get_image_info(path) for path in image_paths]
                self.assertTrue(all(info is not None for info in infos))
                captured = io.StringIO()
                with mock.patch.object(DEDUP, "extract_deep_candidates", return_value=({}, {})), \
                        contextlib.redirect_stdout(captured):
                    auto_groups, review_groups = DEDUP.analyze_images(infos, args)
                results.append(self.normalize_results(auto_groups, review_groups))
                gate_line = re.search(r"廉价门控跳过 (\d+)/(\d+) 对候选", captured.getvalue())
                self.assertIsNotNone(gate_line)
                skipped_counts.append((int(gate_line.group(1)), int(gate_line.group(2))))

            self.assertEqual(results[0], results[1])
            self.assertEqual(skipped_counts[0], skipped_counts[1])
            auto_normalized, review_normalized = results[0]
            # PNG/BMP 同像素副本必然折叠成一个自动组；局部差分版必然进入人工组。
            self.assertTrue(any(len(members) > 1 for _k, _r, _w, members in auto_normalized))
            self.assertGreaterEqual(len(review_normalized), 1)
            # 拉伸版会成为 pHash 候选但必须被门控跳过，且不得出现在任何组里。
            self.assertGreaterEqual(skipped_counts[0][0], 1)
            stretched_path = str(temp_path / "base_stretched.png")
            grouped_paths = {
                path
                for _k, _r, _w, members in auto_normalized if len(members) > 1
                for path in members
            }
            grouped_paths.update(
                path for group in review_normalized for path, _level in group
            )
            self.assertNotIn(stretched_path, grouped_paths)


if __name__ == "__main__":
    unittest.main()
