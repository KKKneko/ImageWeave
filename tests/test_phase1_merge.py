"""phase-1 合并改造的逐位一致性测试。

覆盖：get_image_info 单次读文件后 file_hash/size 语义不变、
canonical_pixel_hash 新旧路径同值、estimate_jpeg_quality 矢量化与旧循环严格相等、
detect_lossless 传 header 与读盘一致，以及 get_image_info 标量字段/特征形状烟测。
"""

import hashlib
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SCRIPT_PATH = ROOT / "dedup_core.py"
SPEC = importlib.util.spec_from_file_location("dedup_script_phase1", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)


def reference_estimate_jpeg_quality(quantization):
    """矢量化改造前的逐档循环实现，自旧版源码原样复制，作为逐位一致的对照。"""
    if not quantization:
        return None, None, None

    tables = []
    for table_id in sorted(quantization):
        values = np.asarray(quantization[table_id], dtype=np.float32).reshape(-1)
        if values.size >= 64:
            tables.append(values[:64])
    if not tables:
        return None, None, None

    best_quality = None
    best_error = float("inf")
    for quality in range(1, 101):
        scale = 5000 / quality if quality < 50 else 200 - 2 * quality
        expected_tables = []
        for index in range(len(tables)):
            base = DEDUP.JPEG_STD_LUMA if index == 0 else DEDUP.JPEG_STD_CHROMA
            expected = np.floor((base * scale + 50) / 100)
            expected_tables.append(np.clip(expected, 1, 255))
        error = float(np.mean([
            np.mean(np.abs(actual - expected))
            for actual, expected in zip(tables, expected_tables)
        ]))
        if error < best_error:
            best_quality = quality
            best_error = error

    quant_mean = float(np.mean(np.concatenate(tables)))
    return best_quality, best_error, quant_mean


def expected_quant_table(base, quality):
    """按 libjpeg 缩放公式生成某档 quality 的期望量化表（float32 数组）。"""
    scale = 5000 / quality if quality < 50 else 200 - 2 * quality
    return np.clip(np.floor((base * scale + 50) / 100), 1, 255)


def scaled_standard_table(base, quality):
    """模拟常规编码器写进文件、再被 PIL 读出的 int 量化表。"""
    return [int(value) for value in expected_quant_table(base, quality)]


class FileAndPixelHashTests(unittest.TestCase):
    def test_file_hash_size_and_pixel_hash_consistency(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            rng = np.random.default_rng(20260727)
            rgb_pixels = rng.integers(0, 256, size=(96, 64, 3), dtype=np.uint8)
            rgba_pixels = rng.integers(0, 256, size=(48, 40, 4), dtype=np.uint8)
            rgba_pixels[..., 3] = 255
            rgba_pixels[5:20, 5:20, 3] = 90  # 局部半透明，触发 has_transparency

            png_rgb = temp_path / "rgb.png"
            bmp_rgb = temp_path / "rgb.bmp"
            jpeg_rgb = temp_path / "rgb.jpg"
            png_rgba = temp_path / "rgba.png"
            Image.fromarray(rgb_pixels, "RGB").save(png_rgb)
            Image.fromarray(rgb_pixels, "RGB").save(bmp_rgb)
            Image.fromarray(rgb_pixels, "RGB").save(jpeg_rgb, quality=90)
            Image.fromarray(rgba_pixels, "RGBA").save(png_rgba)

            infos = {}
            for path in (png_rgb, bmp_rgb, jpeg_rgb, png_rgba):
                info = DEDUP.get_image_info(str(path))
                self.assertIsNotNone(info, msg=str(path))
                self.assertEqual(
                    info["file_hash"], hashlib.sha256(path.read_bytes()).hexdigest()
                )
                self.assertEqual(info["size"], os.path.getsize(path))
                infos[path.name] = info

            # 模块级 file_sha256 必须保留且与合并后的单次读取结果一致
            self.assertEqual(infos["rgb.png"]["file_hash"], DEDUP.file_sha256(str(png_rgb)))

            # 同像素不同容器 → pixel_hash 相同、file_hash 不同（L0 语义）
            self.assertEqual(infos["rgb.png"]["pixel_hash"], infos["rgb.bmp"]["pixel_hash"])
            self.assertNotEqual(infos["rgb.png"]["file_hash"], infos["rgb.bmp"]["file_hash"])
            # JPEG 有损，解码像素与 PNG 必然不同
            self.assertNotEqual(infos["rgb.jpg"]["pixel_hash"], infos["rgb.png"]["pixel_hash"])

            self.assertTrue(infos["rgba.png"]["has_transparency"])
            self.assertIsNotNone(infos["rgba.png"]["alpha_medium"])
            self.assertFalse(infos["rgb.png"]["has_transparency"])
            self.assertIsNone(infos["rgb.png"]["alpha_medium"])


class CanonicalPixelHashTests(unittest.TestCase):
    def test_rgba_array_path_matches_internal_convert(self):
        rng = np.random.default_rng(11)
        cases = (
            ("RGB", (33, 47, 3)),
            ("RGBA", (25, 31, 4)),
            ("L", (20, 22)),
        )
        for mode, shape in cases:
            pixels = rng.integers(0, 256, size=shape, dtype=np.uint8)
            image = Image.fromarray(pixels, mode)
            for icc in (b"", b"fake-icc-profile"):
                with self.subTest(mode=mode, icc=icc):
                    internal = DEDUP.canonical_pixel_hash(image, 8, icc)
                    rgba_array = np.asarray(image.convert("RGBA"), dtype=np.uint8)
                    provided = DEDUP.canonical_pixel_hash(image, 8, icc, rgba_array=rgba_array)
                    self.assertEqual(internal, provided)

    def test_high_bit_depth_branch_ignores_rgba_array(self):
        pixels = (np.arange(80, dtype=np.uint16).reshape(8, 10) * 500).astype(np.uint16)
        image = Image.fromarray(pixels)
        junk = np.zeros((8, 10, 4), dtype=np.uint8)
        self.assertEqual(
            DEDUP.canonical_pixel_hash(image, 16, b""),
            DEDUP.canonical_pixel_hash(image, 16, b"", rgba_array=junk),
        )


class JpegQualityEquivalenceTests(unittest.TestCase):
    def assert_matches_reference(self, quantization):
        expected = reference_estimate_jpeg_quality(quantization)
        actual = DEDUP.estimate_jpeg_quality(quantization)
        self.assertEqual(actual, expected)
        for new_value, old_value in zip(actual, expected):
            self.assertIs(type(new_value), type(old_value))

    def test_standard_scaled_tables_recover_quality_exactly(self):
        for quality in (5, 50, 75, 92, 98):
            with self.subTest(quality=quality):
                quantization = {
                    0: scaled_standard_table(DEDUP.JPEG_STD_LUMA, quality),
                    1: scaled_standard_table(DEDUP.JPEG_STD_CHROMA, quality),
                }
                self.assert_matches_reference(quantization)
                best_quality, best_error, _quant_mean = DEDUP.estimate_jpeg_quality(quantization)
                self.assertEqual(best_quality, quality)
                self.assertEqual(best_error, 0.0)

    def test_random_and_edge_tables(self):
        rng = np.random.default_rng(20260727)
        cases = []
        # 标准表加随机扰动的双表
        for _ in range(8):
            luma = np.clip(
                np.asarray(scaled_standard_table(DEDUP.JPEG_STD_LUMA, int(rng.integers(2, 99))))
                + rng.integers(-6, 7, size=64),
                1, 255,
            )
            chroma = np.clip(
                np.asarray(scaled_standard_table(DEDUP.JPEG_STD_CHROMA, int(rng.integers(2, 99))))
                + rng.integers(-6, 7, size=64),
                1, 255,
            )
            cases.append({
                0: [int(value) for value in luma],
                1: [int(value) for value in chroma],
            })
        # 纯随机单表
        for _ in range(4):
            cases.append({0: [int(value) for value in rng.integers(1, 256, size=64)]})
        # 单标准表 / 表长 > 64 截断 / 长短混合（短表被丢弃只剩 luma）
        cases.append({0: scaled_standard_table(DEDUP.JPEG_STD_LUMA, 75)})
        cases.append({0: [int(value) for value in rng.integers(1, 256, size=70)]})
        cases.append({0: scaled_standard_table(DEDUP.JPEG_STD_LUMA, 60), 1: [3] * 10})
        for index, quantization in enumerate(cases):
            with self.subTest(index=index):
                self.assert_matches_reference(quantization)

    def test_tie_prefers_first_quality(self):
        # 取 60/61 两档期望表的逐项中点：两档误差向量逐位相同，必须取靠前的 60
        midpoint = (
            expected_quant_table(DEDUP.JPEG_STD_LUMA, 60)
            + expected_quant_table(DEDUP.JPEG_STD_LUMA, 61)
        ) / 2
        quantization = {0: [float(value) for value in midpoint]}
        self.assert_matches_reference(quantization)
        best_quality, _error, _mean = DEDUP.estimate_jpeg_quality(quantization)
        self.assertEqual(best_quality, 60)

    def test_degenerate_inputs(self):
        for quantization in (None, {}, {0: [1] * 10}, {0: [5] * 63, 1: [9] * 32}):
            with self.subTest(quantization=quantization):
                self.assert_matches_reference(quantization)
                self.assertEqual(DEDUP.estimate_jpeg_quality(quantization), (None, None, None))


class DetectLosslessTests(unittest.TestCase):
    def test_formats_and_webp_header_consistency(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            png_path = temp_path / "a.png"
            jpeg_path = temp_path / "a.jpg"
            Image.fromarray(pixels).save(png_path)
            Image.fromarray(pixels).save(jpeg_path, quality=80)

            self.assertTrue(DEDUP.detect_lossless(str(png_path), "PNG"))
            self.assertFalse(DEDUP.detect_lossless(str(jpeg_path), "JPEG"))

            lossless_webp = temp_path / "lossless.webp"
            lossy_webp = temp_path / "lossy.webp"
            lossless_bytes = b"RIFF\x54\x00\x00\x00WEBPVP8L" + b"\x00" * 80
            lossy_bytes = b"RIFF\x54\x00\x00\x00WEBPVP8 " + b"\x00" * 80
            lossless_webp.write_bytes(lossless_bytes)
            lossy_webp.write_bytes(lossy_bytes)

            for path, raw, expected in (
                (lossless_webp, lossless_bytes, True),
                (lossy_webp, lossy_bytes, False),
            ):
                with self.subTest(path=path.name):
                    from_disk = DEDUP.detect_lossless(str(path), "WEBP")
                    from_header = DEDUP.detect_lossless(str(path), "WEBP", header=raw[:64])
                    self.assertEqual(from_disk, expected)
                    self.assertEqual(from_header, from_disk)


class GetImageInfoSmokeTests(unittest.TestCase):
    @staticmethod
    def expected_shape(width, height, long_side):
        # 复刻 resize_to_long_side 的长边缩放规则
        scale = long_side / max(width, height)
        return (
            max(8, int(round(height * scale))),
            max(8, int(round(width * scale))),
        )

    def test_png_scalar_fields_and_feature_shapes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "smoke.png"
            pixels = np.zeros((80, 100, 3), dtype=np.uint8)
            pixels[10:40, 20:70] = (200, 40, 90)
            Image.fromarray(pixels).save(path)

            info = DEDUP.get_image_info(str(path))
            self.assertIsNotNone(info)
            self.assertEqual(info["w"], 100)
            self.assertEqual(info["h"], 80)
            self.assertEqual(info["ext"], ".png")
            self.assertEqual(info["format"], "PNG")
            self.assertEqual(info["frames"], 1)
            self.assertEqual(info["bit_depth"], 8)
            self.assertTrue(info["lossless"])
            self.assertFalse(info["has_transparency"])
            self.assertIsNone(info["icc_profile_hash"])
            self.assertIsNone(info["jpeg_quality"])
            self.assertIsNone(info["jpeg_quality_error"])
            self.assertIsNone(info["jpeg_quant_mean"])
            self.assertIsNone(info["alpha_medium"])
            self.assertIsNotNone(info["pixel_hash"])
            self.assertIsInstance(info["hash"], int)

            expected_medium = self.expected_shape(100, 80, DEDUP.ANALYSIS_SIZE)
            expected_small = self.expected_shape(100, 80, DEDUP.COLOR_ANALYSIS_SIZE)
            self.assertEqual(info["gray_medium"].shape, expected_medium)
            self.assertEqual(info["edge_medium"].shape, expected_medium)
            self.assertEqual(info["color_small"].shape, expected_small + (3,))

    def test_jpeg_scalar_fields(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "smoke.jpg"
            rng = np.random.default_rng(3)
            pixels = rng.integers(0, 256, size=(64, 96, 3), dtype=np.uint8)
            Image.fromarray(pixels).save(path, quality=85)

            info = DEDUP.get_image_info(str(path))
            self.assertIsNotNone(info)
            self.assertEqual((info["w"], info["h"]), (96, 64))
            self.assertEqual(info["ext"], ".jpg")
            self.assertEqual(info["format"], "JPEG")
            self.assertEqual(info["frames"], 1)
            self.assertEqual(info["bit_depth"], 8)
            self.assertFalse(info["lossless"])
            self.assertFalse(info["has_transparency"])
            # Pillow 按标准表缩放编码，应精确回推出 quality 且误差为 0
            self.assertEqual(info["jpeg_quality"], 85)
            self.assertEqual(info["jpeg_quality_error"], 0.0)
            self.assertIsNotNone(info["jpeg_quant_mean"])


if __name__ == "__main__":
    unittest.main()
