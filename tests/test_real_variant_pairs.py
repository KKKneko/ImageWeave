import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SCRIPT_PATH = ROOT / "dedup_core.py"
SPEC = importlib.util.spec_from_file_location("dedup_script_real", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)


class RealVariantPairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.image_root = (
            ROOT / "gallery-dl-backend" / "runtime" / "downloads" / "こうこうや"
            / "01-twitter" / "0000" / "twitter"
        )
        cls.names = [
            "GZSlP9waQAArDYB.jpg",
            "GZXXtr_asAMWN1H.jpg",
            "GUwJgzsbEAAVmfO.jpg",
            "GUWWKgyasAAP7G8.jpg",
        ]
        if not all((cls.image_root / name).is_file() for name in cls.names):
            raise unittest.SkipTest("真实变体回归样本不完整")

        from dedup_models import DeepEmbeddingExtractor

        cls.infos = [DEDUP.get_image_info(str(cls.image_root / name)) for name in cls.names]
        extractor = DeepEmbeddingExtractor(ROOT / ".models", device="cuda", batch_size=4)
        for model_name, key in (("sscd", "sscd_embedding"), ("dino", "dino_embedding")):
            vectors = extractor.encode_infos(cls.infos, model_name)
            for info, vector in zip(cls.infos, vectors):
                info[key] = vector
        extractor.close()
        cls.args = SimpleNamespace(
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
        )

    def test_recolored_sketch_pair_enters_l1(self):
        metrics = DEDUP.calculate_similarity_metrics(self.infos[0], self.infos[1])
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L1-SSCD")

    def test_color_and_grayscale_pair_enters_l2(self):
        metrics = DEDUP.calculate_similarity_metrics(self.infos[2], self.infos[3])
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L2-结构")


if __name__ == "__main__":
    unittest.main()
