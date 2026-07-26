import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import dedup_models
from dedup_models import DINO_CACHE_KEY, SSCD_CACHE_KEY, DeepEmbeddingExtractor


class FakeModel(torch.nn.Module):
    """按每样本像素和生成确定性向量，逐样本独立、与批大小无关，便于跨分批方式比对。"""

    def __init__(self, seed: int, dim: int = 4, as_dict: bool = False):
        super().__init__()
        self.seed = seed
        self.dim = dim
        self.as_dict = as_dict
        self.batch_sizes: list[int] = []

    def forward(self, batch: torch.Tensor):
        self.batch_sizes.append(int(batch.shape[0]))
        sums = batch.reshape(batch.shape[0], -1).sum(dim=1, keepdim=True)
        exponents = torch.arange(1, self.dim + 1, dtype=torch.float32).unsqueeze(0)
        vectors = torch.cos(sums * exponents * float(self.seed)) + 0.1 * self.seed
        if self.as_dict:
            return {"x_norm_clstoken": vectors}
        return vectors


class FakeTransform:
    def __init__(self, size: int):
        self.size = size
        self.calls = 0
        self._lock = threading.Lock()

    def __call__(self, image: Image.Image) -> torch.Tensor:
        # 解码预取在线程池里跑，计数器必须加锁才可靠
        with self._lock:
            self.calls += 1
        resized = image.resize((self.size, self.size))
        array = np.asarray(resized, dtype=np.float32) / 255.0
        return torch.from_numpy(array).permute(2, 0, 1).contiguous()


def make_infos(root: Path, count: int = 6) -> list[dict]:
    root.mkdir(parents=True, exist_ok=True)
    infos = []
    for index in range(count):
        pixels = np.zeros((24, 16, 3), dtype=np.uint8)
        pixels[..., 0] = 10 + 20 * index
        pixels[..., 1] = (
            np.arange(16, dtype=np.uint16)[None, :] * (index + 3) % 256
        ).astype(np.uint8)
        pixels[..., 2] = 250 - 17 * index
        path = root / f"img_{index}.png"
        Image.fromarray(pixels).save(path)
        infos.append({"path": str(path), "file_hash": f"h{index}"})
    return infos


def build_extractor(root: Path, batch_size: int = 2) -> DeepEmbeddingExtractor:
    extractor = DeepEmbeddingExtractor(
        root, device="cpu", batch_size=batch_size, use_sscd=False, use_dino=False
    )
    # dino 用 dict 输出覆盖 x_norm_clstoken 分支；两个 transform 尺寸不同以捕捉串线
    extractor.models["sscd"] = FakeModel(seed=1)
    extractor.models["dino"] = FakeModel(seed=2, as_dict=True)
    extractor.transforms["sscd"] = FakeTransform(8)
    extractor.transforms["dino"] = FakeTransform(6)
    return extractor


def expected_rows(seed: int, as_dict: bool, size: int, infos: list[dict]) -> np.ndarray:
    """用独立的假模型/假变换逐图单批算期望值（假模型逐样本独立，故与分批无关）。"""
    model = FakeModel(seed=seed, as_dict=as_dict)
    transform = FakeTransform(size)
    rows = []
    for info in infos:
        tensor = transform(dedup_models._open_rgb(info["path"])).unsqueeze(0)
        with torch.inference_mode():
            output = model(tensor)
            if isinstance(output, dict):
                output = output["x_norm_clstoken"]
            output = torch.nn.functional.normalize(output.float(), dim=1)
        rows.append(output.numpy().astype(np.float32)[0].copy())
    return np.stack(rows)


class EncodeAllTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)

    def test_encode_all_matches_per_model_encode_infos(self):
        infos = make_infos(self.root / "images")
        extractor = build_extractor(self.root / "models")
        try:
            results = extractor.encode_all(infos)
        finally:
            extractor.close()

        self.assertEqual(list(results), ["sscd", "dino"])
        expected = {
            "sscd": expected_rows(1, False, 8, infos),
            "dino": expected_rows(2, True, 6, infos),
        }
        for name in ("sscd", "dino"):
            self.assertEqual(results[name].shape, (len(infos), 4))
            self.assertEqual(results[name].dtype, np.float32)
            np.testing.assert_allclose(results[name], expected[name], atol=1e-6)

        # 同一缓存路径另建 extractor，逐模型 encode_infos 应与 encode_all 结果一致，
        # 且全部命中缓存（不再解码）
        second = build_extractor(self.root / "models")
        try:
            for name in ("sscd", "dino"):
                vectors = second.encode_infos(infos, name)
                np.testing.assert_allclose(vectors, results[name], atol=1e-6)
            self.assertEqual(second.transforms["sscd"].calls, 0)
            self.assertEqual(second.transforms["dino"].calls, 0)
        finally:
            second.close()

    def test_mixed_cache_hits_decode_union_missing_once(self):
        infos = make_infos(self.root / "images")
        extractor = build_extractor(self.root / "models")
        sscd_model = extractor.models["sscd"]
        dino_model = extractor.models["dino"]
        sscd_transform = extractor.transforms["sscd"]
        dino_transform = extractor.transforms["dino"]

        seeded_sscd = {f"h{i}": np.full(4, 10.0 + i, dtype=np.float32) for i in (0, 1, 2)}
        seeded_dino = {f"h{i}": np.full(4, 100.0 + i, dtype=np.float32) for i in (1, 3)}
        extractor.cache.put_many(SSCD_CACHE_KEY, list(seeded_sscd.items()))
        extractor.cache.put_many(DINO_CACHE_KEY, list(seeded_dino.items()))

        original_open = dedup_models._open_rgb
        lock = threading.Lock()
        counter = {"count": 0}

        def counting_open(path):
            with lock:
                counter["count"] += 1
            return original_open(path)

        try:
            with mock.patch.object(dedup_models, "_open_rgb", new=counting_open):
                results = extractor.encode_all(infos)
        finally:
            extractor.close()

        # sscd 缺 {3,4,5}、dino 缺 {0,2,4,5}，union={0,2,3,4,5}：每张图只解码一次
        self.assertEqual(counter["count"], 5)
        self.assertEqual(sscd_transform.calls, 3)
        self.assertEqual(dino_transform.calls, 4)
        # 各模型仍按自己的 missing 序列独立切批（batch_size=2）
        self.assertEqual(sscd_model.batch_sizes, [2, 1])
        self.assertEqual(dino_model.batch_sizes, [2, 2])

        # 命中行必须原样返回预置向量
        for file_hash, vector in seeded_sscd.items():
            np.testing.assert_allclose(results["sscd"][int(file_hash[1:])], vector)
        for file_hash, vector in seeded_dino.items():
            np.testing.assert_allclose(results["dino"][int(file_hash[1:])], vector)

        fresh_sscd = expected_rows(1, False, 8, infos)
        fresh_dino = expected_rows(2, True, 6, infos)
        for row in (3, 4, 5):
            np.testing.assert_allclose(results["sscd"][row], fresh_sscd[row], atol=1e-6)
        for row in (0, 2, 4, 5):
            np.testing.assert_allclose(results["dino"][row], fresh_dino[row], atol=1e-6)

    def test_batch_split_matches_batch_size(self):
        infos = make_infos(self.root / "images", count=5)
        extractor = build_extractor(self.root / "models", batch_size=2)
        try:
            extractor.encode_all(infos)
            self.assertEqual(extractor.models["sscd"].batch_sizes, [2, 2, 1])
            self.assertEqual(extractor.models["dino"].batch_sizes, [2, 2, 1])
        finally:
            extractor.close()

    def test_decode_error_propagates_without_hang(self):
        images_dir = self.root / "images"
        infos = make_infos(images_dir, count=5)
        infos[2] = {"path": str(images_dir / "not_exists.png"), "file_hash": "hx"}
        outcome = {}

        # sqlite 连接不允许跨线程使用，整个 extractor 生命周期都放进工作线程；
        # 用 join(timeout) 断言 fail-fast，避免实现死锁时测试无限挂起
        def run():
            extractor = build_extractor(self.root / "models")
            try:
                extractor.encode_all(infos)
                outcome["error"] = None
            except Exception as error:
                outcome["error"] = error
            finally:
                extractor.close()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout=60)
        self.assertFalse(worker.is_alive(), "encode_all 在解码异常后疑似死锁")
        self.assertIsInstance(outcome.get("error"), FileNotFoundError)


if __name__ == "__main__":
    unittest.main()
