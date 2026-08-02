import os
import sys
import shutil
import subprocess
import argparse
import hashlib
import io
import math
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed


def project_venv_python():
    """返回当前平台的根目录去重 venv Python，同时保持 Windows 旧路径。"""
    root = os.path.dirname(os.path.abspath(__file__))
    relative = ("Scripts", "python.exe") if os.name == "nt" else ("bin", "python")
    return os.path.join(root, ".venv", *relative)


def reexec_in_project_venv():
    if __name__ != "__main__" or os.environ.get("DEDUP_VENV_ACTIVE") == "1":
        return
    venv_python = project_venv_python()
    if not os.path.isfile(venv_python):
        return
    current_python = os.path.normcase(os.path.abspath(sys.executable))
    target_python = os.path.normcase(os.path.abspath(venv_python))
    if current_python == target_python:
        return
    child_environment = os.environ.copy()
    child_environment["DEDUP_VENV_ACTIVE"] = "1"
    return_code = subprocess.call(
        [venv_python, os.path.abspath(__file__), *sys.argv[1:]],
        env=child_environment,
    )
    raise SystemExit(return_code)


reexec_in_project_venv()

from PIL import Image, ImageOps
import cv2
import numpy as np
from tqdm import tqdm

try:
    from PIL import ImageTk
    import tkinter as tk
    from tkinter import ttk, messagebox
except ImportError:
    ImageTk = None
    tk = None
    ttk = None
    messagebox = None

# ================= 核心处理逻辑 =================

ANALYSIS_SIZE = 512
COLOR_ANALYSIS_SIZE = 128
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_DIR = os.path.join(SCRIPT_DIR, ".models")
LOSSLESS_FORMATS = {"PNG", "BMP", "TIFF", "GIF"}
FORMAT_PREFERENCE = {"PNG": 6, "TIFF": 5, "WEBP": 4, "GIF": 3, "BMP": 2, "JPEG": 1, "JPG": 1}

# 判定函数与廉价门控（cheap_pair_gate）共用的硬阈值，两侧必须引用同一常量。
REVIEW_ASPECT_DELTA_MAX = 0.03          # is_review_candidate 允许的对数宽高比差上限
COMPRESSION_ASPECT_DELTA_MAX = 0.005    # is_compression_equivalent 允许的对数宽高比差上限
SAME_RESOLUTION_RATIO_MAX = 1.05        # 视为同分辨率的像素数比例上限（噪声签名/精细结构检查的前提）

# JPEG 标准量化表，用来反推 Pillow/常规编码器的近似 quality 值。
JPEG_STD_LUMA = np.array([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
], dtype=np.float32)
JPEG_STD_CHROMA = np.array([
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
], dtype=np.float32)

def find_images(directory):
    """递归查找目录及其所有子目录下的图片文件"""
    image_extensions = {'.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff', '.gif'}
    image_files = []

    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d.lower() not in {"duplicates", "keep"}]

        for file in files:
            path = os.path.join(root, file)
            if os.path.splitext(file)[1].lower() in image_extensions and not os.path.islink(path):
                image_files.append(path)
    return sorted(image_files, key=lambda path: os.path.normcase(os.path.abspath(path)))


def file_sha256(path, chunk_size=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resize_to_long_side(image, long_side):
    """按比例缩放，让长边固定，避免原脚本强制拉伸到正方形。"""
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("图片尺寸无效")
    scale = long_side / max(height, width)
    new_width = max(8, int(round(width * scale)))
    new_height = max(8, int(round(height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    return cv2.resize(image, (new_width, new_height), interpolation=interpolation)


def compute_hash(image):
    """计算标准 64 位 pHash，返回整数。"""
    resized = cv2.resize(image, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(resized))
    dct_low = dct[:8, :8]
    median = np.median(dct_low.flatten()[1:])
    bits = (dct_low > median).flatten().astype(np.uint8)
    return int.from_bytes(np.packbits(bits).tobytes(), "big")


def compute_edge_map(gray):
    """提取对改色、灰度化和轻微重绘更稳定的轮廓图。"""
    normalized = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(normalized, (5, 5), 0)
    return cv2.Canny(blurred, 40, 120)


def hamming_distance(hash1, hash2):
    return (hash1 ^ hash2).bit_count()


def estimate_jpeg_quality(quantization):
    """从 JPEG 量化表估算 quality；自定义量化表也会返回最接近的值。"""
    if not quantization:
        return None, None, None

    tables = []
    for table_id in sorted(quantization):
        values = np.asarray(quantization[table_id], dtype=np.float32).reshape(-1)
        if values.size >= 64:
            tables.append(values[:64])
    if not tables:
        return None, None, None

    # 100 档 quality 一次算完。原逐档循环里 python 标量 scale 在 ufunc 中被降为
    # float32 参与运算，这里显式 astype(float32) 复刻同一舍入；每表按行做 float32
    # 归约，与逐档 np.mean 的求和次序一致，结果逐位相同。
    qualities = np.arange(1, 101, dtype=np.float64)
    scales = np.where(qualities < 50, 5000.0 / qualities, 200.0 - 2.0 * qualities).astype(np.float32)
    per_table_errors = []
    for index, actual in enumerate(tables):
        base = JPEG_STD_LUMA if index == 0 else JPEG_STD_CHROMA
        expected = np.clip(np.floor((base[np.newaxis, :] * scales[:, np.newaxis] + 50) / 100), 1, 255)
        per_table_errors.append(np.mean(np.abs(actual[np.newaxis, :] - expected), axis=1))
    # 跨表平均：按行对各表误差标量归约，复刻原 np.mean([float32 标量, ...]) 的 dtype 与次序；
    # argmin 取首次出现的最小值，等价于原“严格更小才更新”的选择。
    errors = np.mean(np.stack(per_table_errors, axis=1), axis=1)
    best_index = int(np.argmin(errors))
    best_quality = best_index + 1
    best_error = float(errors[best_index])

    quant_mean = float(np.mean(np.concatenate(tables)))
    return best_quality, best_error, quant_mean


def detect_lossless(path, image_format, header=None):
    if image_format in LOSSLESS_FORMATS:
        return True
    if image_format != "WEBP":
        return False
    if header is None:
        # 调用方没给文件头字节时才回退读盘，保持旧行为。
        try:
            with open(path, "rb") as file_obj:
                header = file_obj.read(64)
        except OSError:
            return False
    return b"VP8L" in header


def estimate_blockiness(gray):
    """估算 8x8 编码块边界突变；只作为同源图质量排序的辅助项。"""
    if gray.shape[0] < 16 or gray.shape[1] < 16:
        return 0.0
    gray_f = gray.astype(np.float32)
    vertical = np.abs(np.diff(gray_f, axis=1))
    horizontal = np.abs(np.diff(gray_f, axis=0))
    v_boundary = vertical[:, 7::8]
    h_boundary = horizontal[7::8, :]
    boundary_mean = float(np.mean([
        v_boundary.mean() if v_boundary.size else 0.0,
        h_boundary.mean() if h_boundary.size else 0.0,
    ]))
    interior_mean = float(np.mean([vertical.mean(), horizontal.mean()]))
    return max(0.0, boundary_mean - interior_mean)


def estimate_noise_sigma(gray):
    """用高通残差估算噪声强度；用于同源候选的相对质量排序。"""
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return 0.0
    kernel = np.array([
        [1, -2, 1],
        [-2, 4, -2],
        [1, -2, 1],
    ], dtype=np.float32)
    response = cv2.filter2D(gray.astype(np.float32), -1, kernel)[1:-1, 1:-1]
    return float(np.mean(np.abs(response)) * math.sqrt(math.pi / 2) / 6)


def infer_bit_depth(mode):
    if "16" in mode or mode in {"I", "F"}:
        return 16
    return 8


def canonical_pixel_hash(image, bit_depth, icc_profile, rgba_array=None):
    """计算解码后像素哈希；8 位图统一为 RGBA，从而跨容器识别完全同图。"""
    profile_digest = hashlib.sha256(icc_profile).digest() if icc_profile else b""
    if bit_depth > 8:
        array = np.ascontiguousarray(np.asarray(image))
        mode = image.mode.encode("ascii", "replace")
    else:
        # 调用方可传入已转换好的 RGBA uint8 数组，避免同一张图二次 convert。
        if rgba_array is None:
            rgba_array = np.asarray(image.convert("RGBA"))
        array = np.ascontiguousarray(rgba_array)
        mode = b"RGBA"

    digest = hashlib.sha256()
    digest.update(f"{image.width}x{image.height}|".encode("ascii"))
    digest.update(mode)
    digest.update(b"|")
    digest.update(profile_digest)
    digest.update(array.tobytes())
    return digest.hexdigest()

def get_image_info(image_path):
    """读取一次图片，生成精确哈希、视觉特征和质量特征。"""
    try:
        # 整文件只读一次：同一份字节同时喂 sha256、PIL 解码与 WEBP 头部检测。
        with open(image_path, "rb") as file_obj:
            data = file_obj.read()
        file_size = len(data)
        file_hash = hashlib.sha256(data).hexdigest()

        with Image.open(io.BytesIO(data)) as img:
            image_format = (img.format or os.path.splitext(image_path)[1][1:]).upper()
            frame_count = int(getattr(img, "n_frames", 1))
            icc_profile = img.info.get("icc_profile", b"")
            icc_profile_hash = hashlib.sha256(icc_profile).hexdigest() if icc_profile else None
            quantization = getattr(img, "quantization", None)
            img = ImageOps.exif_transpose(img)
            width, height = img.size
            ext = os.path.splitext(image_path)[1].lower()
            bit_depth = infer_bit_depth(img.mode)
            # RGBA 只转一次：既作视觉特征输入，也直接喂像素哈希（8 位分支）。
            rgba = np.asarray(img.convert("RGBA"), dtype=np.uint8).copy()
            pixel_hash = (
                canonical_pixel_hash(img, bit_depth, icc_profile, rgba_array=rgba)
                if frame_count == 1 else None
            )
            rgb = rgba[:, :, :3]
            alpha = rgba[:, :, 3]
            has_transparency = bool(np.any(alpha != 255))

        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        gray_medium = resize_to_long_side(gray, ANALYSIS_SIZE)
        color_small = resize_to_long_side(rgb, COLOR_ANALYSIS_SIZE)
        alpha_medium = resize_to_long_side(alpha, ANALYSIS_SIZE) if has_transparency else None
        edge_medium = compute_edge_map(gray_medium)
        hash_val = compute_hash(gray)
        sharpness = float(cv2.Laplacian(gray_medium, cv2.CV_32F).var())
        blockiness = estimate_blockiness(gray)
        noise_sigma = estimate_noise_sigma(gray_medium)
        jpeg_quality, jpeg_quality_error, jpeg_quant_mean = estimate_jpeg_quality(quantization)

        return {
            'path': image_path,
            'hash': hash_val,
            'file_hash': file_hash,
            'pixel_hash': pixel_hash,
            'gray_medium': gray_medium,
            'color_small': color_small,
            'alpha_medium': alpha_medium,
            'edge_medium': edge_medium,
            'w': width,
            'h': height,
            'ext': ext,
            'format': image_format,
            'size': file_size,
            'frames': frame_count,
            'has_transparency': has_transparency,
            'icc_profile_hash': icc_profile_hash,
            'bit_depth': bit_depth,
            'lossless': detect_lossless(image_path, image_format, header=data[:64]),
            'sharpness': sharpness,
            'blockiness': blockiness,
            'noise_sigma': noise_sigma,
            'jpeg_quality': jpeg_quality,
            'jpeg_quality_error': jpeg_quality_error,
            'jpeg_quant_mean': jpeg_quant_mean,
        }
    except Exception as e:
        print(f"\n[警告] 无法读取 {image_path}: {e}")
        return None

def match_shape(image1, image2):
    target_height = min(image1.shape[0], image2.shape[0])
    target_width = min(image1.shape[1], image2.shape[1])
    target = (target_width, target_height)
    first = cv2.resize(image1, target, interpolation=cv2.INTER_AREA)
    second = cv2.resize(image2, target, interpolation=cv2.INTER_AREA)
    return first, second


def local_ssim_map(image1, image2):
    first = image1.astype(np.float32)
    second = image2.astype(np.float32)
    mu1 = cv2.GaussianBlur(first, (11, 11), 1.5)
    mu2 = cv2.GaussianBlur(second, (11, 11), 1.5)
    sigma1_sq = cv2.GaussianBlur(first * first, (11, 11), 1.5) - mu1 * mu1
    sigma2_sq = cv2.GaussianBlur(second * second, (11, 11), 1.5) - mu2 * mu2
    sigma12 = cv2.GaussianBlur(first * second, (11, 11), 1.5) - mu1 * mu2
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    numerator = (2 * mu1 * mu2 + c1) * (2 * sigma12 + c2)
    denominator = (mu1 * mu1 + mu2 * mu2 + c1) * (sigma1_sq + sigma2_sq + c2)
    return np.clip(numerator / np.maximum(denominator, 1e-12), -1.0, 1.0)


def grid_means(array, grid_size):
    values = []
    for rows in np.array_split(array, grid_size, axis=0):
        for block in np.array_split(rows, grid_size, axis=1):
            values.append(float(block.mean()))
    return values


def calculate_edge_similarity(info1, info2):
    edge1, edge2 = match_shape(info1['edge_medium'], info2['edge_medium'])
    edge1 = edge1 > 0
    edge2 = edge2 > 0
    count1 = int(edge1.sum())
    count2 = int(edge2.sum())
    if count1 == 0 or count2 == 0:
        return 0.0, 0.0, 0.0

    height, width = edge1.shape
    tolerance = max(3, int(round(min(height, width) / 96)))
    if tolerance % 2 == 0:
        tolerance += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (tolerance, tolerance))
    dilated1 = cv2.dilate(edge1.astype(np.uint8), kernel) > 0
    dilated2 = cv2.dilate(edge2.astype(np.uint8), kernel) > 0
    recall1 = float(np.mean(dilated2[edge1]))
    recall2 = float(np.mean(dilated1[edge2]))
    tolerant_f1 = 2 * recall1 * recall2 / max(recall1 + recall2, 1e-12)

    distance1 = cv2.distanceTransform((~edge1).astype(np.uint8), cv2.DIST_L2, 3)
    distance2 = cv2.distanceTransform((~edge2).astype(np.uint8), cv2.DIST_L2, 3)
    mean_distance = 0.5 * (float(distance2[edge1].mean()) + float(distance1[edge2].mean()))
    chamfer_score = math.exp(-mean_distance / max(2.0, min(height, width) * 0.012))
    score = 0.65 * tolerant_f1 + 0.35 * chamfer_score
    return float(np.clip(score, 0.0, 1.0)), tolerant_f1, mean_distance


def embedding_similarity(info1, info2, key):
    first = info1.get(key)
    second = info2.get(key)
    if first is None or second is None:
        return None
    return float(np.clip(np.dot(first, second), -1.0, 1.0))


# pair 阶段多线程并发访问同一张图时，按路径加锁避免重复计算 SIFT。
_sift_registry_lock = threading.Lock()
_sift_lock_registry = {}


def get_sift_features(info):
    if '_sift_keypoints' not in info:
        with _sift_registry_lock:
            path_lock = _sift_lock_registry.setdefault(info['path'], threading.Lock())
        with path_lock:
            if '_sift_keypoints' not in info:
                standardized = cv2.resize(info['gray_medium'], (384, 384), interpolation=cv2.INTER_AREA)
                sift = cv2.SIFT_create(nfeatures=1600, contrastThreshold=0.02, edgeThreshold=12)
                keypoints, descriptors = sift.detectAndCompute(standardized, None)
                # 先写 descriptors 再写 keypoints：无锁快路径以 keypoints 存在为完成标志。
                info['_sift_descriptors'] = descriptors
                info['_sift_keypoints'] = keypoints
    return info['_sift_keypoints'], info['_sift_descriptors']


def calculate_geometric_similarity(info1, info2):
    keypoints1, descriptors1 = get_sift_features(info1)
    keypoints2, descriptors2 = get_sift_features(info2)
    if descriptors1 is None or descriptors2 is None:
        return 0.0, 0.0, 0, 0

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    matches = matcher.knnMatch(descriptors1, descriptors2, k=2)
    good = [
        pair[0] for pair in matches
        if len(pair) == 2 and pair[0].distance < 0.76 * pair[1].distance
    ]
    if len(good) < 4:
        return 0.0, 0.0, len(good), 0

    source_points = np.float32([keypoints1[match.queryIdx].pt for match in good])
    target_points = np.float32([keypoints2[match.trainIdx].pt for match in good])
    _homography, mask = cv2.findHomography(source_points, target_points, cv2.RANSAC, 5.0)
    inliers = int(mask.sum()) if mask is not None else 0
    inlier_ratio = inliers / max(len(good), 1)
    normalized_inliers = inliers / max(min(len(keypoints1), len(keypoints2)), 1)
    return float(normalized_inliers), float(inlier_ratio), len(good), inliers


def calculate_similarity_metrics(info1, info2):
    gray1, gray2 = match_shape(info1['gray_medium'], info2['gray_medium'])
    color1, color2 = match_shape(info1['color_small'], info2['color_small'])
    diff = np.abs(gray1.astype(np.float32) - gray2.astype(np.float32))
    color_diff = np.abs(color1.astype(np.float32) - color2.astype(np.float32))
    signed_diff = gray1.astype(np.float32) - gray2.astype(np.float32)
    residual_std = float(signed_diff.std())
    edge1 = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray1.astype(np.float32), cv2.CV_32F)), (3, 3), 0)
    edge2 = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray2.astype(np.float32), cv2.CV_32F)), (3, 3), 0)
    edge_strength = np.maximum(edge1, edge2)
    diff_centered = np.abs(signed_diff) - np.abs(signed_diff).mean()
    edge_centered = edge_strength - edge_strength.mean()
    correlation_denominator = float(diff_centered.std() * edge_centered.std())
    residual_edge_correlation = (
        float(np.mean(diff_centered * edge_centered) / correlation_denominator)
        if correlation_denominator > 1e-12 else 0.0
    )
    gray_local_peak = float(cv2.GaussianBlur(diff, (9, 9), 0).max() / 255)
    color_peak_map = np.max(color_diff, axis=2)
    color_local_peak = float(cv2.GaussianBlur(color_peak_map, (9, 9), 0).max() / 255)
    alpha_mismatch = info1['has_transparency'] != info2['has_transparency']
    if info1['alpha_medium'] is None and info2['alpha_medium'] is None:
        alpha_mae = 0.0
        alpha_local_peak = 0.0
    elif alpha_mismatch:
        alpha_mae = 1.0
        alpha_local_peak = 1.0
    else:
        alpha1, alpha2 = match_shape(info1['alpha_medium'], info2['alpha_medium'])
        alpha_diff = np.abs(alpha1.astype(np.float32) - alpha2.astype(np.float32))
        alpha_mae = float(alpha_diff.mean() / 255)
        alpha_local_peak = float(cv2.GaussianBlur(alpha_diff, (9, 9), 0).max() / 255)
    ssim_map = local_ssim_map(gray1, gray2)
    block_ssims_8 = grid_means(ssim_map, 8)
    block_maes_8 = [value / 255 for value in grid_means(diff, 8)]
    block_ssims_4 = sorted(grid_means(ssim_map, 4), reverse=True)
    similar_pixel_ratio = float(np.mean(diff < 15))
    mse = float(np.mean(diff * diff))
    psnr = float("inf") if mse == 0 else 20 * math.log10(255 / math.sqrt(mse))
    diff_block_count = sum(value < 0.8 for value in block_ssims_4)
    top_block_score = float(np.mean(block_ssims_4[:12]))

    coarse1 = resize_to_long_side(gray1, 256)
    coarse2 = resize_to_long_side(gray2, 256)
    coarse1, coarse2 = match_shape(coarse1, coarse2)
    coarse_ssim_map = local_ssim_map(coarse1, coarse2)
    coarse_diff = np.abs(coarse1.astype(np.float32) - coarse2.astype(np.float32))
    coarse_mse = float(np.mean(coarse_diff * coarse_diff))
    coarse_psnr = float("inf") if coarse_mse == 0 else 20 * math.log10(255 / math.sqrt(coarse_mse))

    if diff_block_count <= 6:
        review_score = 0.4 * similar_pixel_ratio + 0.6 * top_block_score
    else:
        review_score = 0.6 * similar_pixel_ratio + 0.4 * float(np.mean(block_ssims_4))

    aspect1 = info1['w'] / info1['h']
    aspect2 = info2['w'] / info2['h']
    resolution_ratio = max(info1['w'] * info1['h'], info2['w'] * info2['h']) / min(
        info1['w'] * info1['h'], info2['w'] * info2['h']
    )
    noise_sigma_delta = abs(info1['noise_sigma'] - info2['noise_sigma'])
    edge_similarity, edge_tolerant_f1, edge_mean_distance = calculate_edge_similarity(info1, info2)
    return {
        'hash_distance': hamming_distance(info1['hash'], info2['hash']),
        'aspect_delta': abs(math.log(aspect1 / aspect2)),
        'resolution_ratio': resolution_ratio,
        'same_size_lossless': (
            info1['lossless'] and info2['lossless']
            and info1['w'] == info2['w'] and info1['h'] == info2['h']
        ),
        'residual_std': residual_std,
        'residual_edge_correlation': residual_edge_correlation,
        'noise_sigma_delta': noise_sigma_delta,
        'ssim': float(np.mean(ssim_map)),
        'psnr': psnr,
        'coarse_ssim': float(np.mean(coarse_ssim_map)),
        'coarse_psnr': coarse_psnr,
        'coarse_block_ssim_p10': float(np.percentile(grid_means(coarse_ssim_map, 8), 10)),
        'gray_mae': float(diff.mean() / 255),
        'color_mae': float(color_diff.mean() / 255),
        'gray_local_peak': gray_local_peak,
        'color_local_peak': color_local_peak,
        'alpha_mismatch': alpha_mismatch,
        'alpha_mae': alpha_mae,
        'alpha_local_peak': alpha_local_peak,
        'icc_mismatch': info1['icc_profile_hash'] != info2['icc_profile_hash'],
        'similar_pixel_ratio': similar_pixel_ratio,
        'block_ssim_p10': float(np.percentile(block_ssims_8, 10)),
        'max_block_mae': max(block_maes_8),
        'review_score': float(np.clip(review_score, 0.0, 1.0)),
        'edge_similarity': edge_similarity,
        'edge_tolerant_f1': edge_tolerant_f1,
        'edge_mean_distance': edge_mean_distance,
        'sscd_similarity': embedding_similarity(info1, info2, 'sscd_embedding'),
        'dino_similarity': embedding_similarity(info1, info2, 'dino_embedding'),
    }


def has_noise_signature(metrics, args):
    noise_like_residual = (
        metrics['resolution_ratio'] <= SAME_RESOLUTION_RATIO_MAX
        and metrics['residual_std'] >= args.compression_noise_residual_std
        and metrics['residual_edge_correlation'] <= args.compression_noise_edge_correlation
    )
    noise_level_changed = (
        metrics['resolution_ratio'] <= SAME_RESOLUTION_RATIO_MAX
        and metrics['noise_sigma_delta'] >= args.compression_noise_sigma_delta
    )
    return noise_like_residual or noise_level_changed


def is_compression_equivalent(metrics, args):
    """严格门槛：整幅图都只能有编码/缩放级残差，局部突变会转人工。"""
    if args.no_auto_compression or metrics['aspect_delta'] > COMPRESSION_ASPECT_DELTA_MAX:
        return False
    if metrics['same_size_lossless'] or has_noise_signature(metrics, args):
        return False
    if metrics['resolution_ratio'] <= SAME_RESOLUTION_RATIO_MAX:
        structure_ok = (
            metrics['ssim'] >= args.compression_ssim
            and metrics['psnr'] >= args.compression_psnr
            and metrics['block_ssim_p10'] >= args.compression_block_ssim
        )
    else:
        structure_ok = (
            metrics['coarse_ssim'] >= args.compression_resized_ssim
            and metrics['coarse_psnr'] >= args.compression_resized_psnr
            and metrics['coarse_block_ssim_p10'] >= args.compression_resized_block_ssim
        )
    return (
        metrics['resolution_ratio'] <= args.compression_max_resolution_ratio
        and structure_ok
        and not metrics['icc_mismatch']
        and not metrics['alpha_mismatch']
        and metrics['alpha_mae'] <= (1 / 255)
        and metrics['alpha_local_peak'] <= 0.01
        and metrics['max_block_mae'] <= args.compression_block_mae
        and metrics['color_mae'] <= args.compression_color_mae
        and metrics['gray_local_peak'] <= args.compression_gray_peak
        and metrics['color_local_peak'] <= args.compression_color_peak
    )


def is_review_candidate(metrics, args):
    standard_candidate = metrics['hash_distance'] <= args.hash_threshold
    protected_candidate = (
        metrics['hash_distance'] <= args.compression_hash_threshold
        and metrics['review_score'] >= max(args.similarity_threshold, 0.95)
        and (metrics['same_size_lossless'] or has_noise_signature(metrics, args))
    )
    return (
        metrics['aspect_delta'] <= REVIEW_ASPECT_DELTA_MAX
        and metrics['review_score'] >= args.similarity_threshold
        and (standard_candidate or protected_candidate)
    )


def is_l1_auto_candidate(metrics, args):
    if not is_compression_equivalent(metrics, args):
        return False
    if args.no_sscd:
        return True
    similarity = metrics.get('sscd_similarity')
    return (
        similarity is not None
        and similarity >= args.sscd_auto_threshold
        and metrics['hash_distance'] <= args.compression_hash_threshold
    )


def classify_review_candidate(metrics, args):
    legacy = is_review_candidate(metrics, args)
    sscd_similarity = metrics.get('sscd_similarity')
    dino_similarity = metrics.get('dino_similarity')
    aspect_ok = metrics['aspect_delta'] <= args.deep_max_aspect_delta

    sscd_review = (
        not args.no_sscd
        and sscd_similarity is not None
        and sscd_similarity >= args.sscd_review_threshold
        and aspect_ok
    )
    dino_structure_review = (
        not args.no_dino
        and dino_similarity is not None
        and dino_similarity >= args.dino_review_threshold
        and metrics['edge_similarity'] >= args.edge_review_threshold
        and (
            metrics['hash_distance'] <= args.dino_phash_threshold
            or metrics.get('geometric_similarity', 0.0) >= args.geometry_review_threshold
        )
        and aspect_ok
    )

    if sscd_review:
        return 'L1-SSCD', sscd_similarity
    if dino_structure_review:
        combined = math.sqrt(max(0.0, dino_similarity * metrics['edge_similarity']))
        return 'L2-结构', combined
    if legacy:
        return 'L1-pHash', metrics['review_score']
    return None, 0.0


def cheap_pair_gate(args, *, aspect_delta, resolution_ratio, hash_distance,
                    sscd_similarity, dino_similarity, same_size_lossless,
                    icc_mismatch, alpha_mismatch):
    """廉价门控：仅用 phase-1 标量判断四条判定路径是否至少一条可能通过。

    此处是各判定路径必要条件的影子（宁可放行不可错杀），逐条对应：
      gate_a ← is_l1_auto_candidate / is_compression_equivalent（压缩同源自动淘汰）
      gate_b ← classify_review_candidate 的 sscd_review 分支
      gate_c ← classify_review_candidate 的 dino_structure_review 分支
      gate_d ← is_review_candidate（含 has_noise_signature 的同分辨率前提）
    修改上述判定函数必须同步修改这里，守卫测试是 tests/test_dedup_gate_guard.py。
    """
    gate_a = (
        not args.no_auto_compression
        and aspect_delta <= COMPRESSION_ASPECT_DELTA_MAX
        and resolution_ratio <= args.compression_max_resolution_ratio
        and not same_size_lossless
        and not icc_mismatch
        and not alpha_mismatch
        and (
            args.no_sscd
            or (
                sscd_similarity is not None
                and sscd_similarity >= args.sscd_auto_threshold
                and hash_distance <= args.compression_hash_threshold
            )
        )
    )
    gate_b = (
        not args.no_sscd
        and sscd_similarity is not None
        and sscd_similarity >= args.sscd_review_threshold
        and aspect_delta <= args.deep_max_aspect_delta
    )
    gate_c = (
        not args.no_dino
        and dino_similarity is not None
        and dino_similarity >= args.dino_review_threshold
        and aspect_delta <= args.deep_max_aspect_delta
    )
    gate_d = (
        aspect_delta <= REVIEW_ASPECT_DELTA_MAX
        and (
            hash_distance <= args.hash_threshold
            or (
                hash_distance <= args.compression_hash_threshold
                and (same_size_lossless or resolution_ratio <= SAME_RESOLUTION_RATIO_MAX)
            )
        )
    )
    return gate_a or gate_b or gate_c or gate_d


def pair_passes_cheap_gate(info1, info2, args):
    """在计算全套 metrics 之前，用 phase-1 信息复算门控所需的廉价标量。"""
    aspect1 = info1['w'] / info1['h']
    aspect2 = info2['w'] / info2['h']
    pixels1 = info1['w'] * info1['h']
    pixels2 = info2['w'] * info2['h']
    return cheap_pair_gate(
        args,
        aspect_delta=abs(math.log(aspect1 / aspect2)),
        resolution_ratio=max(pixels1, pixels2) / min(pixels1, pixels2),
        hash_distance=hamming_distance(info1['hash'], info2['hash']),
        sscd_similarity=embedding_similarity(info1, info2, 'sscd_embedding'),
        dino_similarity=embedding_similarity(info1, info2, 'dino_embedding'),
        same_size_lossless=(
            info1['lossless'] and info2['lossless']
            and info1['w'] == info2['w'] and info1['h'] == info2['h']
        ),
        icc_mismatch=info1['icc_profile_hash'] != info2['icc_profile_hash'],
        alpha_mismatch=info1['has_transparency'] != info2['has_transparency'],
    )


def extract_deep_candidates(base_infos, args):
    if args.no_sscd and args.no_dino:
        return {}, {}

    try:
        from dedup_models import DeepEmbeddingExtractor, cosine_topk_pairs
    except ImportError as exc:
        setup_command = (
            "setup-dedup.ps1"
            if os.name == "nt"
            else "./scripts/setup-linux.sh --device cpu"
        )
        raise RuntimeError(
            f"深度特征依赖缺失，请使用 {project_venv_python()} 运行脚本，"
            f"或先执行 {setup_command}。原始错误: {exc}"
        ) from exc

    eligible_indices = [index for index, info in enumerate(base_infos) if info['frames'] == 1]
    eligible_infos = [base_infos[index] for index in eligible_indices]
    if len(eligible_infos) < 2:
        return {}, {}

    extractor = DeepEmbeddingExtractor(
        args.model_dir,
        device=args.device,
        batch_size=args.deep_batch_size,
        use_sscd=not args.no_sscd,
        use_dino=not args.no_dino,
    )
    sscd_pairs = {}
    dino_pairs = {}
    try:
        # 单趟解码：一次喂满全部已加载模型，SSCD/DINO 不再各自重复解码同一批图。
        all_embeddings = extractor.encode_all(eligible_infos)
        if not args.no_sscd:
            embeddings = all_embeddings['sscd']
            for info, embedding in zip(eligible_infos, embeddings):
                info['sscd_embedding'] = embedding
            local_pairs = cosine_topk_pairs(
                embeddings,
                top_k=args.sscd_top_k,
                min_similarity=args.sscd_candidate_threshold,
                device=args.device,
                block_size=args.neighbor_block_size,
                mutual=False,
            )
            sscd_pairs = {
                tuple(sorted((eligible_indices[first], eligible_indices[second]))): similarity
                for (first, second), similarity in local_pairs.items()
            }
            print(f"  → L1 SSCD 召回 {len(sscd_pairs)} 对 Top-K 候选")

        if not args.no_dino:
            embeddings = all_embeddings['dino']
            for info, embedding in zip(eligible_infos, embeddings):
                info['dino_embedding'] = embedding
            local_pairs = cosine_topk_pairs(
                embeddings,
                top_k=args.dino_top_k,
                min_similarity=args.dino_candidate_threshold,
                device=args.device,
                block_size=args.neighbor_block_size,
                mutual=False,
            )
            dino_pairs = {
                tuple(sorted((eligible_indices[first], eligible_indices[second]))): similarity
                for (first, second), similarity in local_pairs.items()
            }
            print(f"  → L2 DINOv2 召回 {len(dino_pairs)} 对 Top-K 候选")
    finally:
        extractor.close()
    return sscd_pairs, dino_pairs


def quality_sort_key(info):
    jpeg_quality_rank = -info['jpeg_quant_mean'] if info['jpeg_quant_mean'] is not None else -1000.0
    detail_score = (
        math.log1p(max(0.0, info['sharpness']))
        - 0.12 * info['noise_sigma']
        - 0.08 * info['blockiness']
    )
    return (
        info['w'] * info['h'],
        info['bit_depth'],
        1 if info['lossless'] else 0,
        jpeg_quality_rank,
        FORMAT_PREFERENCE.get(info['format'], 0),
        detail_score,
        info['size'],
    )


def choose_quality_winner(members):
    # 先按路径排好，稳定排序保证质量完全相同时保留字典序靠前的文件。
    ordered = sorted(members, key=lambda info: os.path.normcase(info['path']))
    ordered.sort(key=quality_sort_key, reverse=True)
    winner = ordered[0]
    if len(ordered) == 1:
        return winner, "唯一候选"

    winner_key = quality_sort_key(winner)
    runner_up = next(
        (candidate for candidate in ordered[1:] if quality_sort_key(candidate) != winner_key),
        ordered[1],
    )
    winner_pixels = winner['w'] * winner['h']
    runner_pixels = runner_up['w'] * runner_up['h']
    if winner_pixels != runner_pixels:
        reason = f"分辨率更高 ({winner['w']}x{winner['h']})"
    elif winner['bit_depth'] != runner_up['bit_depth']:
        reason = f"位深更高 ({winner['bit_depth']} bit)"
    elif winner['lossless'] != runner_up['lossless']:
        reason = f"优先无损容器 ({winner['format']})"
    elif (
        winner['jpeg_quality'] is not None
        and runner_up['jpeg_quality'] is not None
        and winner['jpeg_quality'] != runner_up['jpeg_quality']
    ):
        reason = f"JPEG 量化质量更高 (约 Q{winner['jpeg_quality']})"
    elif winner['format'] != runner_up['format']:
        reason = f"质量相当时优先 {winner['format']} 容器"
    elif winner['noise_sigma'] + 0.05 < runner_up['noise_sigma']:
        reason = f"高频噪声估计更低 ({winner['noise_sigma']:.2f})"
    elif abs(winner['sharpness'] - runner_up['sharpness']) > 1:
        reason = f"归一化细节得分更高 ({winner['sharpness']:.1f})"
    elif winner['size'] != runner_up['size']:
        reason = "内容等价时保留信息量更大的文件"
    else:
        reason = "质量指标相同，按路径稳定保留"
    return winner, reason


def is_better_image(curr_info, kept_info):
    return quality_sort_key(curr_info) > quality_sort_key(kept_info)


class HammingBKTree:
    """64 位哈希的 BK-tree，避免对全部图片做 O(n²) 精确比较。"""
    def __init__(self):
        self.root = None

    def add(self, value, index):
        if self.root is None:
            self.root = [value, [index], {}]
            return
        node = self.root
        while True:
            distance = hamming_distance(value, node[0])
            if distance == 0:
                node[1].append(index)
                return
            if distance not in node[2]:
                node[2][distance] = [value, [index], {}]
                return
            node = node[2][distance]

    def query(self, value, max_distance):
        if self.root is None:
            return []
        results = []
        stack = [self.root]
        while stack:
            node = stack.pop()
            distance = hamming_distance(value, node[0])
            if distance <= max_distance:
                results.extend(node[1])
            low = distance - max_distance
            high = distance + max_distance
            stack.extend(child for edge, child in node[2].items() if low <= edge <= high)
        return results


class UnionFind:
    def __init__(self, size):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value):
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, first, second):
        root1 = self.find(first)
        root2 = self.find(second)
        if root1 == root2:
            return
        if self.rank[root1] < self.rank[root2]:
            root1, root2 = root2, root1
        self.parent[root2] = root1
        if self.rank[root1] == self.rank[root2]:
            self.rank[root1] += 1


def connected_components(size, edges):
    union_find = UnionFind(size)
    for first, second in edges:
        union_find.union(first, second)
    groups = defaultdict(list)
    for index in range(size):
        groups[union_find.find(index)].append(index)
    return list(groups.values())


def build_exact_units(image_infos):
    """先折叠完全相同的文件/解码像素，并为后续视觉比较保留一个代表。"""
    buckets = defaultdict(list)
    for info in image_infos:
        if info['pixel_hash'] is not None:
            key = ('pixel', info['pixel_hash'])
        else:
            key = ('file', info['file_hash'])
        buckets[key].append(info)

    units = []
    for members in buckets.values():
        winner, reason = choose_quality_winner(members)
        units.append({
            'bases': [winner],
            'members': members,
            'winner': winner,
            'kind': 'exact' if len(members) > 1 else 'single',
            'reason': reason,
        })
    units.sort(key=lambda unit: os.path.normcase(unit['winner']['path']))
    return units


def split_compression_cliques(base_infos, compression_edges, compression_metrics):
    """压缩同源组采用 complete-link，阻断 A≈B≈C 的链式自动误删。"""
    edge_set = {tuple(sorted(edge)) for edge in compression_edges}
    components = connected_components(len(base_infos), compression_edges)
    cliques = []

    for component in components:
        ordered = sorted(component, key=lambda idx: quality_sort_key(base_infos[idx]), reverse=True)
        local_groups = []
        for index in ordered:
            compatible = []
            for group in local_groups:
                if all(tuple(sorted((index, other))) in edge_set for other in group):
                    weakest = min(
                        compression_metrics[tuple(sorted((index, other)))]['ssim']
                        for other in group
                    )
                    compatible.append((weakest, group))
            if compatible:
                max(compatible, key=lambda item: item[0])[1].append(index)
            else:
                local_groups.append([index])
        cliques.extend(local_groups)
    return cliques


def split_review_cliques(unit_infos, review_edges, review_metrics):
    """人工候选同样采用 complete-link，避免相似关系沿链条无限扩张。"""
    edge_set = {tuple(sorted(edge)) for edge in review_edges}
    components = connected_components(len(unit_infos), review_edges)
    cliques = []

    for component in components:
        ordered = sorted(component, key=lambda idx: quality_sort_key(unit_infos[idx]), reverse=True)
        local_groups = []
        for index in ordered:
            compatible = []
            for group in local_groups:
                keys = [tuple(sorted((index, other))) for other in group]
                if all(key in edge_set for key in keys):
                    weakest = min(review_metrics[key]['candidate_score'] for key in keys)
                    compatible.append((weakest, group))
            if compatible:
                max(compatible, key=lambda item: item[0])[1].append(index)
            else:
                local_groups.append([index])
        cliques.extend(group for group in local_groups if len(group) > 1)
    return cliques


def analyze_images(image_infos, args):
    exact_units = build_exact_units(image_infos)
    base_infos = [unit['winner'] for unit in exact_units]
    sscd_pairs, dino_pairs = extract_deep_candidates(base_infos, args)
    tree = HammingBKTree()
    candidate_sources = defaultdict(set)
    visual_edges = []
    compression_edges = []
    comparison_cache = {}

    print(f"  → 共 {len(image_infos)} 张有效图片，{len(base_infos)} 个精确内容单元")
    for index, info in enumerate(base_infos):
        if info['frames'] != 1:
            continue
        candidate_hash_threshold = max(args.hash_threshold, args.compression_hash_threshold)
        for candidate_index in tree.query(info['hash'], candidate_hash_threshold):
            candidate_sources[(candidate_index, index)].add('pHash')
        tree.add(info['hash'], index)

    for key in sscd_pairs:
        candidate_sources[key].add('SSCD')
    for key in dino_pairs:
        candidate_sources[key].add('DINOv2')

    sorted_candidates = sorted(candidate_sources)
    surviving_pairs = [
        key for key in sorted_candidates
        if pair_passes_cheap_gate(base_infos[key[0]], base_infos[key[1]], args)
    ]
    print(f"  → 廉价门控跳过 {len(sorted_candidates) - len(surviving_pairs)}/{len(sorted_candidates)} 对候选")

    def compute_pair_metrics(key):
        first, second = key
        metrics = calculate_similarity_metrics(base_infos[first], base_infos[second])
        metrics.update({
            'geometric_similarity': 0.0,
            'geometric_inlier_ratio': 0.0,
            'geometric_matches': 0,
            'geometric_inliers': 0,
        })
        if (
            metrics.get('dino_similarity') is not None
            and metrics['dino_similarity'] >= args.dino_review_threshold
            and metrics['edge_similarity'] >= args.edge_review_threshold
        ):
            (
                metrics['geometric_similarity'],
                metrics['geometric_inlier_ratio'],
                metrics['geometric_matches'],
                metrics['geometric_inliers'],
            ) = calculate_geometric_similarity(base_infos[first], base_infos[second])
        metrics['candidate_sources'] = ', '.join(sorted(candidate_sources[key]))
        return metrics

    pair_metrics = {}
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_key = {executor.submit(compute_pair_metrics, key): key for key in surviving_pairs}
        for future in tqdm(
            as_completed(future_to_key),
            total=len(surviving_pairs),
            desc="分层关系分析",
            unit="pair",
        ):
            pair_metrics[future_to_key[future]] = future.result()

    # 分类与建边按 sorted 顺序串行执行，保证与单线程版的输出顺序完全一致。
    for key in surviving_pairs:
        first, second = key
        metrics = pair_metrics[key]
        comparison_cache[key] = metrics
        if is_l1_auto_candidate(metrics, args):
            metrics['candidate_level'] = 'L1-自动'
            metrics['candidate_score'] = metrics.get('sscd_similarity') or metrics['review_score']
            relation = 'compression'
            compression_edges.append(key)
        else:
            level, candidate_score = classify_review_candidate(metrics, args)
            if level is None:
                continue
            metrics['candidate_level'] = level
            metrics['candidate_score'] = candidate_score
            relation = 'review'
        visual_edges.append((first, second, relation, metrics))

    compression_cliques = split_compression_cliques(
        base_infos,
        compression_edges,
        comparison_cache,
    )
    base_to_unit = {}
    final_units = []
    for clique in compression_cliques:
        source_units = [exact_units[index] for index in clique]
        members = [member for unit in source_units for member in unit['members']]
        winner, reason = choose_quality_winner(members)
        kind = 'compression' if len(clique) > 1 else source_units[0]['kind']
        final_index = len(final_units)
        final_units.append({
            'bases': [base_infos[index] for index in clique],
            'members': members,
            'winner': winner,
            'kind': kind,
            'reason': reason,
        })
        for index in clique:
            base_to_unit[index] = final_index

    unit_edge_metrics = {}
    for first, second, relation, metrics in visual_edges:
        if relation != 'review':
            continue
        unit1 = base_to_unit[first]
        unit2 = base_to_unit[second]
        if unit1 != unit2:
            unit_key = tuple(sorted((unit1, unit2)))
            current = unit_edge_metrics.get(unit_key)
            if current is None or metrics['candidate_score'] > current['candidate_score']:
                unit_edge_metrics[unit_key] = metrics

    auto_groups = [unit for unit in final_units if len(unit['members']) > 1]
    review_groups = []
    review_cliques = split_review_cliques(
        [unit['winner'] for unit in final_units],
        list(unit_edge_metrics),
        unit_edge_metrics,
    )
    # 合并单元的 winner 一定是某个 base winner（quality_sort_key 是全序），可按对象身份回查缓存。
    base_index_by_id = {id(info): index for index, info in enumerate(base_infos)}
    for component in review_cliques:
        members = [(index, final_units[index]['winner']) for index in component]
        member_infos = [member for _index, member in members]
        anchor, _ = choose_quality_winner(member_infos)
        anchor_unit = next(index for index, member in members if member['path'] == anchor['path'])
        display_members = []
        for unit_index, member in members:
            display = {
                key: value for key, value in member.items()
                if key not in {
                    'gray_medium', 'color_small', 'alpha_medium', 'edge_medium',
                    'sscd_embedding', 'dino_embedding', '_sift_keypoints', '_sift_descriptors',
                }
            }
            if member['path'] == anchor['path']:
                display['review_metrics'] = None
            else:
                anchor_base = base_index_by_id.get(id(anchor))
                member_base = base_index_by_id.get(id(member))
                cached_metrics = (
                    comparison_cache.get(tuple(sorted((anchor_base, member_base))))
                    if anchor_base is not None and member_base is not None
                    else None
                )
                if cached_metrics is not None:
                    # 浅拷贝：缓存条目同时被 unit_edge_metrics 等引用，禁止原地覆盖。
                    display_metrics = dict(cached_metrics)
                else:
                    display_metrics = calculate_similarity_metrics(anchor, member)
                edge_metrics = unit_edge_metrics[tuple(sorted((anchor_unit, unit_index)))]
                display_metrics['candidate_level'] = edge_metrics['candidate_level']
                display_metrics['candidate_score'] = edge_metrics['candidate_score']
                display_metrics['candidate_sources'] = edge_metrics['candidate_sources']
                for key in (
                    'geometric_similarity', 'geometric_inlier_ratio',
                    'geometric_matches', 'geometric_inliers',
                ):
                    display_metrics[key] = edge_metrics.get(key, 0)
                display['review_metrics'] = display_metrics
            display_members.append(display)
        display_members.sort(
            key=lambda item: (item['path'] != anchor['path'], os.path.normcase(item['path']))
        )
        review_groups.append(display_members)

    # 后续文件操作和 GUI 不再需要大数组，及时释放以降低审核阶段内存。
    large_keys = {
        'gray_medium', 'color_small', 'alpha_medium', 'edge_medium',
        'sscd_embedding', 'dino_embedding', '_sift_keypoints', '_sift_descriptors',
    }
    for info in image_infos:
        for key in large_keys:
            info.pop(key, None)

    return auto_groups, review_groups

def safe_move(src_path, dest_dir, companion_exts=()):
    """安全移动文件（处理重名），并返回最终的目标路径"""
    filename = os.path.basename(src_path)
    dest_path = os.path.join(dest_dir, filename)
    name, ext = os.path.splitext(filename)
    suffix = 1
    def destination_taken(candidate):
        stem = os.path.splitext(candidate)[0]
        return os.path.exists(candidate) or any(os.path.exists(stem + item) for item in companion_exts)

    while destination_taken(dest_path):
        dest_path = os.path.join(dest_dir, f"{name}_{suffix}{ext}")
        suffix += 1
    try:
        shutil.move(src_path, dest_path)
        return dest_path
    except OSError as e:
        print(f"\n[错误] 移动失败 {src_path}: {e}")
        return None


def discard_image(img_info, args):
    path = img_info['path']
    txt_path = os.path.splitext(path)[0] + ".txt"
    has_txt = os.path.exists(txt_path) and args.move_txt
    if args.dry_run:
        return True

    if args.delete:
        staged_txt = None
        try:
            if has_txt:
                staged_txt = txt_path + f".dedup_delete_{os.getpid()}"
                suffix = 1
                while os.path.exists(staged_txt):
                    staged_txt = txt_path + f".dedup_delete_{os.getpid()}_{suffix}"
                    suffix += 1
                os.replace(txt_path, staged_txt)
            os.remove(path)
            if staged_txt:
                os.remove(staged_txt)
            return True
        except OSError as exc:
            if staged_txt and os.path.exists(staged_txt) and not os.path.exists(txt_path):
                try:
                    os.replace(staged_txt, txt_path)
                except OSError as rollback_exc:
                    print(f"\n[错误] TXT回滚失败 {staged_txt}: {rollback_exc}")
            print(f"\n[错误] 删除失败 {path}: {exc}")
            return False

    duplicate_dir = os.path.join(os.path.dirname(path), "duplicates")
    os.makedirs(duplicate_dir, exist_ok=True)
    new_img_path = safe_move(path, duplicate_dir, companion_exts=(".txt",) if has_txt else ())
    if not new_img_path:
        return False
    if has_txt:
        new_txt_name = os.path.splitext(os.path.basename(new_img_path))[0] + ".txt"
        try:
            shutil.move(txt_path, os.path.join(duplicate_dir, new_txt_name))
        except OSError as exc:
            try:
                shutil.move(new_img_path, path)
            except OSError as rollback_exc:
                print(f"[错误] 图片回滚失败 {new_img_path}: {rollback_exc}")
            print(f"[错误] TXT移动失败: {exc}")
            return False
    return True


def process_auto_groups(auto_groups, args):
    discarded = 0
    failed = 0
    for group_index, group in enumerate(auto_groups, 1):
        label = "完全相同" if group['kind'] == 'exact' else "压缩/重编码同源"
        winner = group['winner']
        print(f"\n[自动 {group_index}/{len(auto_groups)}] {label}")
        print(f"  [保留] {winner['path']}")
        print(f"         原因: {group['reason']}")
        for member in group['members']:
            if member['path'] == winner['path']:
                continue
            action = "删除" if args.delete else "移入 duplicates"
            prefix = "模拟" if args.dry_run else action
            print(f"  [{prefix}] {member['path']}")
            if discard_image(member, args):
                discarded += 1
            else:
                failed += 1
    return discarded, failed


def format_optional_score(value):
    return "-" if value is None else f"{value:.3f}"


# ================= GUI 交互组件 =================

class ZoomableCanvas(tk.Canvas if tk is not None else object):
    """支持滚轮缩放和左键拖拽的高清图片画布"""
    def __init__(self, parent, image_path, **kwargs):
        super().__init__(parent, bg="#2b2b2b", highlightthickness=0, **kwargs)
        self.image_path = image_path

        # 立即 load/copy，释放文件句柄；否则 Windows 下审核后移动文件会失败。
        with Image.open(image_path) as image:
            self.orig_pil_img = ImageOps.exif_transpose(image).convert("RGB").copy()
        self.img_tk = None

        w, h = self.orig_pil_img.size
        self.scale = min(350/w, 350/h)
        if self.scale > 1.0: self.scale = 1.0

        self.bind("<MouseWheel>", self.zoom)
        self.bind("<Button-4>", self.zoom)
        self.bind("<Button-5>", self.zoom)
        self.bind("<ButtonPress-1>", self.start_pan)
        self.bind("<B1-Motion>", self.pan)

        self.bind('<Configure>', lambda e: self.update_image())
        self.bind('<Enter>', lambda e: self.focus_set())

    def zoom(self, event):
        if hasattr(event, 'state') and (event.state & 0x0001):
            return

        scale_factor = 1.15
        if hasattr(event, 'delta') and event.delta != 0:
            if event.delta > 0: self.scale *= scale_factor
            else: self.scale /= scale_factor
        elif hasattr(event, 'num'):
            if event.num == 4: self.scale *= scale_factor
            elif event.num == 5: self.scale /= scale_factor

        self.update_image()

    def start_pan(self, event):
        self.scan_mark(event.x, event.y)

    def pan(self, event):
        self.scan_dragto(event.x, event.y, gain=1)

    def update_image(self):
        w, h = self.orig_pil_img.size
        new_w, new_h = int(w * self.scale), int(h * self.scale)

        if new_w < 50 or new_h < 50 or new_w > 8000 or new_h > 8000:
            return

        resized = self.orig_pil_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        self.img_tk = ImageTk.PhotoImage(resized)

        self.delete("all")
        canvas_w = self.winfo_width()
        canvas_h = self.winfo_height()
        x_pos = max((canvas_w - new_w) // 2, 0)
        y_pos = max((canvas_h - new_h) // 2, 0)

        self.create_image(x_pos, y_pos, anchor="nw", image=self.img_tk)
        self.config(scrollregion=self.bbox("all"))


class DuplicateReviewApp:
    def __init__(self, root, duplicate_groups, args):
        self.root = root
        self.groups = duplicate_groups
        self.args = args
        self.current_idx = 0
        self.checkbox_vars = []
        self.best_path = None
        self.failed_operations = []

        self.root.title("L1 / L2 图片变体人工筛选")
        self.root.geometry("1200x760")

        self.info_label = tk.Label(root, text="", font=("Arial", 14, "bold"))
        self.info_label.pack(pady=10)

        tk.Label(
            root,
            text="默认全部保留；可取消当前组的全部勾选。鼠标滚轮缩放，左键拖拽，Shift+滚轮横向滚动。",
            fg="gray",
        ).pack()

        self.container = tk.Frame(root)
        self.container.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        self.h_scrollbar = ttk.Scrollbar(self.container, orient="horizontal")
        self.h_scrollbar.pack(side=tk.BOTTOM, fill=tk.X)

        self.canvas = tk.Canvas(self.container, xscrollcommand=self.h_scrollbar.set, highlightthickness=0)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.h_scrollbar.config(command=self.canvas.xview)

        self.images_frame = tk.Frame(self.canvas)
        self.canvas_window = self.canvas.create_window((0, 0), window=self.images_frame, anchor="nw")

        self.images_frame.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfig(self.canvas_window, height=e.height))

        self.root.bind("<Shift-MouseWheel>", self._on_shift_mousewheel)
        self.root.bind("<Shift-Button-4>", self._on_shift_mousewheel)
        self.root.bind("<Shift-Button-5>", self._on_shift_mousewheel)

        self.btn_frame = tk.Frame(root)
        self.btn_frame.pack(fill=tk.X, pady=10)

        tk.Button(self.btn_frame, text="全部保留", command=lambda: self.set_all(True)).pack(side=tk.LEFT, padx=8)
        tk.Button(self.btn_frame, text="仅保留质量推荐", command=self.select_recommended).pack(side=tk.LEFT, padx=8)
        self.confirm_btn = tk.Button(self.btn_frame, text="确认选中并下一组 (Enter)",
                                     command=self.on_confirm, bg="#4CAF50", fg="white", font=("Arial", 12, "bold"))
        self.confirm_btn.pack(side=tk.RIGHT, padx=12, pady=5)
        self.root.bind('<Return>', lambda event: self.on_confirm())

        self.load_current_group()

    def _on_shift_mousewheel(self, event):
        if hasattr(event, 'delta') and event.delta != 0:
            self.canvas.xview_scroll(int(-1 * (event.delta / 120)), "units")
        elif hasattr(event, 'num'):
            if event.num == 4:
                self.canvas.xview_scroll(-1, "units")
            elif event.num == 5:
                self.canvas.xview_scroll(1, "units")

    def set_all(self, selected):
        for var, _img_info in self.checkbox_vars:
            var.set(selected)

    def select_recommended(self):
        for var, img_info in self.checkbox_vars:
            var.set(img_info['path'] == self.best_path)

    def load_current_group(self):
        for widget in self.images_frame.winfo_children():
            widget.destroy()
        self.checkbox_vars.clear()
        self.canvas.xview_moveto(0)

        if self.current_idx >= len(self.groups):
            if self.failed_operations:
                messagebox.showwarning(
                    "部分操作失败",
                    f"审核完成，但有 {len(self.failed_operations)} 个文件操作失败。\n"
                    "请检查原目录、duplicates 目录和控制台日志。",
                )
            else:
                messagebox.showinfo("完成", "所有 L1 / L2 图片变体候选已处理完毕！")
            self.root.quit()
            return

        group = self.groups[self.current_idx]
        self.info_label.config(
            text=f"L1 / L2 图片变体候选：第 {self.current_idx + 1} 组 / 共 {len(self.groups)} 组"
        )

        best_img, best_reason = choose_quality_winner(group)
        self.best_path = best_img['path']

        for i, img_info in enumerate(group):
            frame = tk.Frame(self.images_frame, bd=2, relief=tk.GROOVE)
            frame.pack(side=tk.LEFT, padx=5, pady=5, expand=True, fill=tk.BOTH)

            dir_name = os.path.basename(os.path.dirname(img_info['path']))
            tk.Label(frame, text=f"📂 {dir_name}", font=("Arial", 9, "bold"), fg="#1e88e5").pack(pady=2)

            try:
                canvas = ZoomableCanvas(frame, img_info['path'], width=450)
                canvas.pack(expand=True, fill=tk.BOTH, pady=5)
            except Exception as e:
                tk.Label(frame, text=f"图片加载失败:\n{e}", width=40).pack(expand=True)

            size_mb = img_info['size'] / (1024 * 1024)
            jpeg_text = f" | JPEG约Q{img_info['jpeg_quality']}" if img_info['jpeg_quality'] is not None else ""
            info_text = (
                f"{img_info['w']}x{img_info['h']} | {size_mb:.2f} MB | {img_info['format']}"
                f"{jpeg_text} | 细节 {img_info['sharpness']:.1f} | 噪声 {img_info['noise_sigma']:.2f}"
            )
            tk.Label(frame, text=info_text, font=("Arial", 10)).pack()

            metrics = img_info.get('review_metrics')
            if metrics is None:
                metrics_text = "组内质量基准图"
            else:
                psnr_text = "∞" if math.isinf(metrics['psnr']) else f"{metrics['psnr']:.1f}"
                metrics_text = (
                    f"{metrics.get('candidate_level', '候选')} | "
                    f"SSCD {format_optional_score(metrics.get('sscd_similarity'))} | "
                    f"DINO {format_optional_score(metrics.get('dino_similarity'))} | "
                    f"边缘 {metrics['edge_similarity']:.3f} | "
                    f"几何 {metrics.get('geometric_similarity', 0.0):.3f}\n"
                    f"像素差分 {metrics['review_score']:.3f} | SSIM {metrics['ssim']:.3f} | "
                    f"PSNR {psnr_text} dB | pHash差 {metrics['hash_distance']}"
                )
            tk.Label(frame, text=metrics_text, font=("Arial", 9), fg="#555555", justify=tk.LEFT).pack()

            var = tk.BooleanVar(value=True)
            if img_info['path'] == best_img['path']:
                tk.Label(frame, text=f"质量推荐：{best_reason}", fg="#c62828").pack()

            cb = tk.Checkbutton(frame, text="保留此图", variable=var, font=("Arial", 11, "bold"))
            cb.pack(pady=5)
            self.checkbox_vars.append((var, img_info))

    def on_confirm(self):
        if self.args.dry_run:
            print(f"\n[模拟] 第 {self.current_idx + 1} 组:")
            for var, img_info in self.checkbox_vars:
                status = "保留" if var.get() else "淘汰"
                print(f"  [{status}] {img_info['path']}")
            self.current_idx += 1
            self.load_current_group()
            return

        for var, img_info in self.checkbox_vars:
            if not var.get():
                if not discard_image(img_info, self.args):
                    self.failed_operations.append(img_info['path'])

        self.current_idx += 1
        self.load_current_group()

# ================= 启动程序 =================


def validate_args(parser, args):
    if not 0 <= args.hash_threshold <= 64:
        parser.error("--hash-threshold 必须在 0 到 64 之间")
    if not 0 <= args.compression_hash_threshold <= 64:
        parser.error("--compression-hash-threshold 必须在 0 到 64 之间")
    if not 0 <= args.dino_phash_threshold <= 64:
        parser.error("--dino-phash-threshold 必须在 0 到 64 之间")
    probability_args = {
        '--similarity-threshold': args.similarity_threshold,
        '--compression-ssim': args.compression_ssim,
        '--compression-block-ssim': args.compression_block_ssim,
        '--compression-block-mae': args.compression_block_mae,
        '--compression-color-mae': args.compression_color_mae,
        '--compression-gray-peak': args.compression_gray_peak,
        '--compression-color-peak': args.compression_color_peak,
        '--compression-resized-ssim': args.compression_resized_ssim,
        '--compression-resized-block-ssim': args.compression_resized_block_ssim,
        '--compression-noise-edge-correlation': args.compression_noise_edge_correlation,
        '--sscd-candidate-threshold': args.sscd_candidate_threshold,
        '--sscd-review-threshold': args.sscd_review_threshold,
        '--sscd-auto-threshold': args.sscd_auto_threshold,
        '--dino-candidate-threshold': args.dino_candidate_threshold,
        '--dino-review-threshold': args.dino_review_threshold,
        '--edge-review-threshold': args.edge_review_threshold,
        '--geometry-review-threshold': args.geometry_review_threshold,
        '--deep-max-aspect-delta': args.deep_max_aspect_delta,
    }
    for name, value in probability_args.items():
        if not 0 <= value <= 1:
            parser.error(f"{name} 必须在 0 到 1 之间")
    if args.compression_psnr < 0:
        parser.error("--compression-psnr 必须大于等于 0")
    if args.compression_resized_psnr < 0:
        parser.error("--compression-resized-psnr 必须大于等于 0")
    if args.compression_max_resolution_ratio < 1:
        parser.error("--compression-max-resolution-ratio 必须大于等于 1")
    if args.compression_noise_residual_std < 0:
        parser.error("--compression-noise-residual-std 必须大于等于 0")
    if args.compression_noise_sigma_delta < 0:
        parser.error("--compression-noise-sigma-delta 必须大于等于 0")
    if args.workers < 1:
        parser.error("--workers 必须大于等于 1")
    if args.deep_batch_size < 1:
        parser.error("--deep-batch-size 必须大于等于 1")
    if args.sscd_top_k < 1 or args.dino_top_k < 1:
        parser.error("--sscd-top-k 和 --dino-top-k 必须大于等于 1")
    if args.neighbor_block_size < 1:
        parser.error("--neighbor-block-size 必须大于等于 1")


def print_review_groups(review_groups):
    print(f"\n有 {len(review_groups)} 组 L1 / L2 图片变体候选等待人工筛选：")
    for index, group in enumerate(review_groups, 1):
        print(f"\n[人工组 {index}] 共 {len(group)} 张")
        for info in group:
            metrics = info.get('review_metrics')
            suffix = "基准图" if metrics is None else (
                f"{metrics.get('candidate_level', '候选')}, "
                f"SSCD={format_optional_score(metrics.get('sscd_similarity'))}, "
                f"DINO={format_optional_score(metrics.get('dino_similarity'))}, "
                f"edge={metrics['edge_similarity']:.3f}, "
                f"geo={metrics.get('geometric_similarity', 0.0):.3f}, "
                f"pHash={metrics['hash_distance']}"
            )
            print(f"  {info['path']} ({suffix})")

def build_argument_parser():
    parser = argparse.ArgumentParser(
        description="L0-L2 分层图片去重：精确折叠、SSCD近重复择优、DINOv2结构变体人工筛选"
    )
    parser.add_argument("dir", nargs="?", help="包含图片的文件夹路径 (自动递归子目录)")
    parser.add_argument("--hash-threshold", type=int, default=12,
                        help="动作/场景候选的 pHash 阈值 (0-64，默认12)")
    parser.add_argument("--compression-hash-threshold", type=int, default=20,
                        help="压缩/噪声保护候选的 pHash 搜索阈值 (0-64，默认20)")
    parser.add_argument("--similarity-threshold", type=float, default=0.88,
                        help="动作/场景候选差分分数阈值 (0-1，默认0.88)")
    parser.add_argument("--compression-ssim", type=float, default=0.985,
                        help="自动认定压缩同源的全局 SSIM 下限 (默认0.985)")
    parser.add_argument("--compression-psnr", type=float, default=32.0,
                        help="自动认定压缩同源的 PSNR 下限，单位 dB (默认32)")
    parser.add_argument("--compression-block-ssim", type=float, default=0.965,
                        help="自动认定压缩同源的局部 SSIM P10 下限 (默认0.965)")
    parser.add_argument("--compression-block-mae", type=float, default=0.045,
                        help="自动认定压缩同源的最差局部归一化 MAE 上限 (默认0.045)")
    parser.add_argument("--compression-color-mae", type=float, default=0.025,
                        help="自动认定压缩同源的 RGB 归一化 MAE 上限 (默认0.025)")
    parser.add_argument("--compression-gray-peak", type=float, default=0.06,
                        help="自动认定压缩同源的局部灰度残差峰值上限 (默认0.06)")
    parser.add_argument("--compression-color-peak", type=float, default=0.06,
                        help="自动认定压缩同源的局部颜色残差峰值上限 (默认0.06)")
    parser.add_argument("--compression-resized-ssim", type=float, default=0.985,
                        help="有限降采样版本的粗尺度 SSIM 下限 (默认0.985)")
    parser.add_argument("--compression-resized-psnr", type=float, default=35.0,
                        help="有限降采样版本的粗尺度 PSNR 下限 (默认35)")
    parser.add_argument("--compression-resized-block-ssim", type=float, default=0.98,
                        help="有限降采样版本的粗尺度局部 SSIM P10 下限 (默认0.98)")
    parser.add_argument("--compression-max-resolution-ratio", type=float, default=4.1,
                        help="自动合并时允许的最大像素数比例 (默认4.1，约等于边长减半)")
    parser.add_argument("--compression-noise-residual-std", type=float, default=0.45,
                        help="疑似全局高频噪声的残差标准差下限 (默认0.45)")
    parser.add_argument("--compression-noise-edge-correlation", type=float, default=0.05,
                        help="疑似全局高频噪声的残差/边缘相关性上限 (默认0.05)")
    parser.add_argument("--compression-noise-sigma-delta", type=float, default=0.25,
                        help="同尺寸候选的高通噪声估计差值上限 (默认0.25，超过则人工审核)")
    parser.add_argument("--no-auto-compression", action="store_true",
                        help="压缩/重编码同源图也交给人工，不自动淘汰")
    parser.add_argument("--sscd-candidate-threshold", type=float, default=0.60,
                        help="L1 SSCD 近邻召回下限 (默认0.60)")
    parser.add_argument("--sscd-review-threshold", type=float, default=0.72,
                        help="L1 SSCD 人工候选下限 (默认0.72)")
    parser.add_argument("--sscd-auto-threshold", type=float, default=0.94,
                        help="L1 自动压缩同源所需 SSCD 下限 (默认0.94)")
    parser.add_argument("--sscd-top-k", type=int, default=20,
                        help="每张图保留的 SSCD Top-K 近邻数量 (默认20)")
    parser.add_argument("--dino-candidate-threshold", type=float, default=0.68,
                        help="L2 DINOv2 近邻召回下限 (默认0.68)")
    parser.add_argument("--dino-review-threshold", type=float, default=0.82,
                        help="L2 DINOv2 人工候选下限 (默认0.82)")
    parser.add_argument("--edge-review-threshold", type=float, default=0.32,
                        help="L2 边缘结构人工候选下限 (默认0.32)")
    parser.add_argument("--geometry-review-threshold", type=float, default=0.035,
                        help="L2 SIFT几何归一化内点下限 (默认0.035)")
    parser.add_argument("--dino-phash-threshold", type=int, default=18,
                        help="L2 可直接通过几何门槛的 pHash 距离上限 (默认18)")
    parser.add_argument("--dino-top-k", type=int, default=20,
                        help="每张图保留的 DINOv2 Top-K 近邻数量 (默认20)")
    parser.add_argument("--deep-max-aspect-delta", type=float, default=0.20,
                        help="L1/L2 人工候选允许的对数宽高比差 (默认0.20)")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto",
                        help="深度模型运行设备 (默认auto)")
    parser.add_argument("--deep-batch-size", type=int, default=8,
                        help="深度模型推理批量；6GB显存默认8 (默认8)")
    parser.add_argument("--neighbor-block-size", type=int, default=512,
                        help="向量 Top-K 检索分块大小 (默认512)")
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR,
                        help=f"模型与特征缓存目录 (默认 {DEFAULT_MODEL_DIR})")
    parser.add_argument("--no-sscd", action="store_true", help="关闭 L1 SSCD，保留旧 pHash 流程")
    parser.add_argument("--no-dino", action="store_true", help="关闭 L2 DINOv2/结构候选层")
    parser.add_argument("--prepare-models", action="store_true",
                        help="下载并验证 SSCD、DINOv2 模型后退出")
    parser.add_argument("--group-compare-limit", type=int, default=6, help=argparse.SUPPRESS)
    parser.add_argument("--delete", action="store_true", help="不选中的图直接删除，而不是移入 duplicates")
    parser.add_argument("--dry-run", action="store_true", help="仅模拟运行，打印结果，不改变文件")
    parser.add_argument("--no-gui", action="store_true", help="仅打印人工候选组，不打开审核界面")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1), help="多线程数量")
    parser.add_argument("--move-txt", action="store_true", help="移动或删除图片时，同时处理同目录下的同名txt文件")

    return parser


def main():
    parser = build_argument_parser()

    args = parser.parse_args()
    validate_args(parser, args)
    args.model_dir = os.path.abspath(args.model_dir)

    if args.prepare_models:
        try:
            from dedup_models import prepare_models
            paths = prepare_models(args.model_dir, device=args.device)
        except (ImportError, RuntimeError, OSError) as exc:
            parser.error(f"模型准备失败: {exc}")
        print("模型准备完成：")
        for name, path in paths.items():
            print(f"  {name}: {path}")
        return

    if args.dir is None:
        parser.error("缺少图片目录；常规运行需传入 dir，模型预下载请使用 --prepare-models")
    target_dir = args.dir

    if not os.path.isdir(target_dir):
        print("错误：指定的目录不存在！")
        return

    print(f"正在扫描目录及子目录: {target_dir} ...")
    image_paths = find_images(target_dir)
    total_images = len(image_paths)

    if total_images == 0:
        print("没有找到支持的图片文件。")
        return

    print(f"\n[1/4] 正在使用 {args.workers} 个线程提取 L0、像素与边缘特征...")
    image_infos = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_path = {executor.submit(get_image_info, path): path for path in image_paths}
        for future in tqdm(as_completed(future_to_path), total=total_images, unit="img", desc="处理"):
            result = future.result()
            if result is not None:
                image_infos.append(result)

    if not image_infos:
        print("所有图片均读取失败，未执行后续处理。")
        return

    enabled_layers = ["L0"]
    if not args.no_sscd:
        enabled_layers.append("L1-SSCD")
    if not args.no_dino:
        enabled_layers.append("L2-DINOv2+边缘")
    print(f"\n[2/4] 正在提取深度特征并建立候选 ({', '.join(enabled_layers)})...")
    auto_groups, review_groups = analyze_images(image_infos, args)

    exact_count = sum(group['kind'] == 'exact' for group in auto_groups)
    compression_count = sum(group['kind'] == 'compression' for group in auto_groups)
    print(
        f"\n[3/4] 自动组 {len(auto_groups)} 个 "
        f"(完全相同 {exact_count}，压缩同源 {compression_count})；人工组 {len(review_groups)} 个。"
    )
    discarded, failed = process_auto_groups(auto_groups, args)
    mode = "模拟淘汰" if args.dry_run else "已自动淘汰"
    print(f"\n{mode} {discarded} 张，保留图维持原路径。")
    if failed:
        print(f"[警告] 有 {failed} 张自动处理失败，请根据上方错误检查原目录和 duplicates。")

    if not review_groups:
        print("\n[4/4] 扫描完成，没有 L1 / L2 图片变体候选需要人工筛选。")
        return

    if args.no_gui:
        print_review_groups(review_groups)
        return

    if tk is None or ImageTk is None:
        parser.error("当前 Python 环境缺少 tkinter；请使用 --no-gui，或安装 tkinter 后重试")

    print(f"\n[4/4] 准备打开 {len(review_groups)} 组 L1 / L2 图片变体候选的人工审核界面...")

    root = tk.Tk()
    DuplicateReviewApp(root, review_groups, args)

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(root.attributes, '-topmost', False)
    root.mainloop()

    print("\n" + "-" * 40)
    print("所有处理流程完毕！")

if __name__ == "__main__":
    main()
