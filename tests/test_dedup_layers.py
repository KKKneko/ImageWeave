import importlib.util
import hashlib
import io
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
SCRIPT_PATH = ROOT / "差分去除_优化版.py"
SPEC = importlib.util.spec_from_file_location("dedup_script", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)


def quality_info(path, rank):
    return {
        "path": path,
        "w": 100 + rank,
        "h": 100 + rank,
        "bit_depth": 8,
        "lossless": False,
        "jpeg_quant_mean": 10.0,
        "format": "JPEG",
        "sharpness": 10.0,
        "noise_sigma": 1.0,
        "blockiness": 0.0,
        "size": 1000 + rank,
    }


class ExactAndStructureTests(unittest.TestCase):
    def test_same_pixels_in_different_containers_form_one_l0_unit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            pixels = np.zeros((96, 64, 3), dtype=np.uint8)
            cv2.rectangle(pixels, (10, 10), (50, 80), (30, 180, 220), -1)
            png_path = temp_path / "same.png"
            bmp_path = temp_path / "same.bmp"
            Image.fromarray(pixels).save(png_path)
            Image.fromarray(pixels).save(bmp_path)

            infos = [DEDUP.get_image_info(str(png_path)), DEDUP.get_image_info(str(bmp_path))]
            self.assertNotEqual(infos[0]["file_hash"], infos[1]["file_hash"])
            units = DEDUP.build_exact_units(infos)
            self.assertEqual(len(units), 1)
            self.assertEqual(units[0]["kind"], "exact")
            self.assertEqual(len(units[0]["members"]), 2)

    def test_edge_similarity_survives_recoloring(self):
        image = np.full((320, 220, 3), 245, dtype=np.uint8)
        cv2.circle(image, (110, 95), 55, (20, 30, 180), 7)
        cv2.line(image, (60, 160), (170, 285), (25, 120, 40), 9)
        recolored = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), cv2.COLOR_GRAY2RGB)
        info1 = {"edge_medium": DEDUP.compute_edge_map(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY))}
        info2 = {"edge_medium": DEDUP.compute_edge_map(cv2.cvtColor(recolored, cv2.COLOR_RGB2GRAY))}
        score, _f1, _distance = DEDUP.calculate_edge_similarity(info1, info2)
        self.assertGreater(score, 0.85)


class LayerClassificationTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(
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

    def base_metrics(self):
        return {
            "hash_distance": 30,
            "aspect_delta": 0.01,
            "review_score": 0.20,
            "resolution_ratio": 1.0,
            "residual_std": 1.0,
            "residual_edge_correlation": 0.5,
            "noise_sigma_delta": 0.0,
            "same_size_lossless": False,
            "sscd_similarity": 0.0,
            "dino_similarity": 0.0,
            "edge_similarity": 0.0,
            "geometric_similarity": 0.0,
        }

    def test_sscd_candidate_is_l1(self):
        metrics = self.base_metrics()
        metrics["sscd_similarity"] = 0.84
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L1-SSCD")

    def test_dino_requires_structure_and_is_l2(self):
        metrics = self.base_metrics()
        metrics.update(dino_similarity=0.86, edge_similarity=0.61, geometric_similarity=0.06)
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L2-结构")

        metrics["edge_similarity"] = 0.20
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertIsNone(level)

    def test_l1_auto_requires_strict_pixels_and_high_sscd(self):
        metrics = self.base_metrics()
        metrics.update({
            "hash_distance": 2,
            "aspect_delta": 0.0,
            "resolution_ratio": 1.0,
            "same_size_lossless": False,
            "residual_std": 0.1,
            "residual_edge_correlation": 0.5,
            "noise_sigma_delta": 0.0,
            "ssim": 0.995,
            "psnr": 45.0,
            "block_ssim_p10": 0.99,
            "coarse_ssim": 0.995,
            "coarse_psnr": 45.0,
            "coarse_block_ssim_p10": 0.99,
            "icc_mismatch": False,
            "alpha_mismatch": False,
            "alpha_mae": 0.0,
            "alpha_local_peak": 0.0,
            "max_block_mae": 0.01,
            "color_mae": 0.005,
            "gray_local_peak": 0.01,
            "color_local_peak": 0.01,
            "sscd_similarity": 0.98,
        })
        self.assertTrue(DEDUP.is_l1_auto_candidate(metrics, self.args))
        metrics["sscd_similarity"] = 0.90
        self.assertFalse(DEDUP.is_l1_auto_candidate(metrics, self.args))


class ClusteringAndSearchTests(unittest.TestCase):
    def test_review_complete_link_blocks_similarity_chains(self):
        infos = [quality_info(f"{index}.jpg", 3 - index) for index in range(3)]
        edges = [(0, 1), (1, 2)]
        metrics = {
            (0, 1): {"candidate_score": 0.9},
            (1, 2): {"candidate_score": 0.9},
        }
        groups = DEDUP.split_review_cliques(infos, edges, metrics)
        self.assertEqual(sum(len(group) for group in groups), 2)
        self.assertTrue(all(len(group) == 2 for group in groups))

    def test_mutual_topk_returns_only_qualified_pairs(self):
        from dedup_models import cosine_topk_pairs

        vectors = np.array([
            [1.0, 0.0, 0.0],
            [0.99, 0.10, 0.0],
            [0.0, 1.0, 0.0],
        ], dtype=np.float32)
        pairs = cosine_topk_pairs(vectors, top_k=1, min_similarity=0.9, device="cpu")
        self.assertEqual(set(pairs), {(0, 1)})

    def test_non_mutual_topk_keeps_one_direction_candidates(self):
        from dedup_models import cosine_topk_pairs

        vectors = np.array([
            [1.0, 0.0],
            [0.995, 0.100],
            [0.994, 0.110],
        ], dtype=np.float32)
        mutual_pairs = cosine_topk_pairs(
            vectors, top_k=1, min_similarity=0.9, device="cpu", mutual=True,
        )
        union_pairs = cosine_topk_pairs(
            vectors, top_k=1, min_similarity=0.9, device="cpu", mutual=False,
        )
        self.assertEqual(set(mutual_pairs), {(1, 2)})
        self.assertEqual(set(union_pairs), {(0, 1), (1, 2)})

    def test_safe_move_respects_existing_companion_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_dir = root / "source"
            destination_dir = root / "duplicates"
            source_dir.mkdir()
            destination_dir.mkdir()
            source = source_dir / "photo.jpg"
            source.write_bytes(b"image")
            (destination_dir / "photo.txt").write_text("caption", encoding="utf-8")

            result = DEDUP.safe_move(str(source), str(destination_dir), companion_exts=(".txt",))
            self.assertEqual(Path(result).name, "photo_1.jpg")
            self.assertTrue((destination_dir / "photo_1.jpg").is_file())

    def test_corrupt_model_cache_is_replaced(self):
        from dedup_models import download_file

        payload = b"verified-model"
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "model.pt"
            destination.write_bytes(b"corrupt")
            response = io.BytesIO(payload)
            response.headers = {"Content-Length": str(len(payload))}
            with mock.patch("urllib.request.urlopen", return_value=response):
                download_file("https://example.test/model.pt", destination, expected)
            self.assertEqual(destination.read_bytes(), payload)


if __name__ == "__main__":
    unittest.main()
