from __future__ import annotations

import hashlib
import itertools
import os
import sqlite3
import urllib.request
import warnings
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from tqdm import tqdm


SSCD_URL = (
    "https://dl.fbaipublicfiles.com/sscd-copy-detection/"
    "sscd_disc_mixup.torchscript.pt"
)
SSCD_FILENAME = "sscd_disc_mixup.torchscript.pt"
SSCD_SHA256 = "9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56"
DINO_SHA256 = "b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9"
DINO_REPOSITORY = "facebookresearch/dinov2:7764ea0f912e53c92e82eb78a2a1631e92725fc8"
DINO_REPOSITORY_CACHE = (
    "facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"
)
DINO_MODEL_NAME = "dinov2_vits14"
SSCD_CACHE_KEY = "sscd_disc_mixup_320_v1"
DINO_CACHE_KEY = "dinov2_vits14_full224_v1"


def resolve_device(requested: str) -> str:
    import torch

    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("指定了 CUDA，但当前 PyTorch 未检测到可用 GPU")
    return requested


def model_root(path: str | os.PathLike[str]) -> Path:
    root = Path(path).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    torch_home = root / "torch"
    torch_home.mkdir(parents=True, exist_ok=True)
    os.environ["TORCH_HOME"] = str(torch_home)
    return root


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, expected_sha256: str) -> None:
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(
            f"模型文件校验失败: {path}\n期望 SHA256: {expected_sha256}\n实际 SHA256: {actual}"
        )


def verify_or_remove(path: Path, expected_sha256: str) -> None:
    try:
        verify_file(path, expected_sha256)
    except RuntimeError:
        # 删掉坏文件让下次运行重新下载，否则每次都在同处校验失败（与 SSCD 自愈路径对齐）
        path.unlink(missing_ok=True)
        raise


def download_file(url: str, destination: Path, expected_sha256: str | None = None) -> Path:
    if destination.is_file() and destination.stat().st_size > 0:
        try:
            if expected_sha256:
                verify_file(destination, expected_sha256)
            return destination
        except RuntimeError:
            destination.unlink(missing_ok=True)

    destination.parent.mkdir(parents=True, exist_ok=True)
    part_path = destination.with_suffix(destination.suffix + ".part")
    part_path.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "image-dedup/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            total = int(response.headers.get("Content-Length", 0))
            with part_path.open("wb") as file_obj, tqdm(
                total=total or None,
                unit="B",
                unit_scale=True,
                desc=f"下载 {destination.name}",
            ) as progress:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    file_obj.write(chunk)
                    progress.update(len(chunk))
        os.replace(part_path, destination)
        if expected_sha256:
            verify_file(destination, expected_sha256)
    except Exception:
        part_path.unlink(missing_ok=True)
        if expected_sha256:
            destination.unlink(missing_ok=True)
        raise
    return destination


class EmbeddingCache:
    def __init__(self, database_path: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path)
        # 多个去重进程可能同时读写同一缓存库：WAL + busy_timeout 避免 database is locked
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA busy_timeout=30000")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS embeddings (
                model_key TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                vector BLOB NOT NULL,
                PRIMARY KEY (model_key, file_hash)
            )
            """
        )

    def get(self, model_key: str, file_hash: str) -> np.ndarray | None:
        row = self.connection.execute(
            "SELECT dimension, vector FROM embeddings WHERE model_key = ? AND file_hash = ?",
            (model_key, file_hash),
        ).fetchone()
        if row is None:
            return None
        dimension, vector = row
        result = np.frombuffer(vector, dtype=np.float32).copy()
        if result.size != dimension:
            return None
        return result

    def put_many(self, model_key: str, items: list[tuple[str, np.ndarray]]) -> None:
        rows = []
        for file_hash, vector in items:
            normalized = np.asarray(vector, dtype=np.float32).reshape(-1)
            rows.append((model_key, file_hash, normalized.size, normalized.tobytes()))
        self.connection.executemany(
            "INSERT OR REPLACE INTO embeddings(model_key, file_hash, dimension, vector) "
            "VALUES (?, ?, ?, ?)",
            rows,
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()


def _normalized_transform(size: int):
    from torchvision import transforms

    return transforms.Compose([
        transforms.Resize((size, size), antialias=True),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225],
        ),
    ])


def _open_rgb(path: str) -> Image.Image:
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGB").copy()


class DeepEmbeddingExtractor:
    def __init__(
        self,
        root: str | os.PathLike[str],
        device: str = "auto",
        batch_size: int = 16,
        use_sscd: bool = True,
        use_dino: bool = True,
    ):
        import torch

        self.torch = torch
        self.root = model_root(root)
        self.device = resolve_device(device)
        self.batch_size = max(1, batch_size)
        self.cache = EmbeddingCache(self.root / "embeddings.sqlite3")
        self.models = {}
        self.transforms = {}

        if use_sscd:
            weight_path = download_file(SSCD_URL, self.root / SSCD_FILENAME, SSCD_SHA256)
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="`torch.jit.load` is deprecated.*")
                model = torch.jit.load(str(weight_path), map_location=self.device)
            self.models["sscd"] = model.eval().to(self.device)
            self.transforms["sscd"] = _normalized_transform(320)

        if use_dino:
            dino_checkpoint = self.root / "torch" / "hub" / "checkpoints" / "dinov2_vits14_pretrain.pth"
            if dino_checkpoint.is_file():
                verify_or_remove(dino_checkpoint, DINO_SHA256)
            local_repository = self.root / "torch" / "hub" / DINO_REPOSITORY_CACHE
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="xFormers is not available.*")
                if (local_repository / "hubconf.py").is_file():
                    model = torch.hub.load(
                        str(local_repository),
                        DINO_MODEL_NAME,
                        source="local",
                        pretrained=True,
                        verbose=False,
                    )
                else:
                    model = torch.hub.load(
                        DINO_REPOSITORY,
                        DINO_MODEL_NAME,
                        pretrained=True,
                        trust_repo=True,
                        skip_validation=True,
                        verbose=False,
                    )
            if dino_checkpoint.is_file():
                verify_or_remove(dino_checkpoint, DINO_SHA256)
            self.models["dino"] = model.eval().to(self.device)
            self.transforms["dino"] = _normalized_transform(224)

    @property
    def model_names(self) -> tuple[str, ...]:
        return tuple(self.models)

    def _cache_key(self, model_name: str) -> str:
        return SSCD_CACHE_KEY if model_name == "sscd" else DINO_CACHE_KEY

    def encode_infos(self, infos: list[dict], model_name: str) -> np.ndarray:
        return self.encode_all(infos, [model_name])[model_name]

    def encode_all(
        self,
        infos: list[dict],
        model_names: list[str] | None = None,
    ) -> dict[str, np.ndarray]:
        if model_names is None:
            model_names = list(self.models)
        else:
            model_names = list(dict.fromkeys(model_names))
        for model_name in model_names:
            if model_name not in self.models:
                raise KeyError(f"模型未加载: {model_name}")

        results: dict[str, list[np.ndarray | None]] = {
            name: [None] * len(infos) for name in model_names
        }
        # 同一张图可能只缺其中一个模型的缓存：按 infos 原顺序记录每张图还缺哪些模型
        union_missing: list[tuple[int, dict, list[str]]] = []
        for index, info in enumerate(infos):
            needed = []
            for name in model_names:
                cached = self.cache.get(self._cache_key(name), info["file_hash"])
                if cached is None:
                    needed.append(name)
                else:
                    results[name][index] = cached
            if needed:
                union_missing.append((index, info, needed))

        batch_items: dict[str, list] = {name: [] for name in model_names}
        pending_cache: dict[str, list] = {name: [] for name in model_names}

        def flush_batch(name: str) -> None:
            items = batch_items[name]
            if not items:
                return
            batch_items[name] = []
            tensors = [tensor for _index, _file_hash, tensor in items]
            batch = self.torch.stack(tensors).to(self.device, non_blocking=True)
            with self.torch.inference_mode():
                output = self.models[name](batch)
                if isinstance(output, dict):
                    output = output["x_norm_clstoken"]
                output = self.torch.nn.functional.normalize(output.float(), dim=1)
            vectors = output.cpu().numpy().astype(np.float32, copy=False)
            for (index, file_hash, _tensor), vector in zip(items, vectors):
                results[name][index] = vector.copy()
                pending_cache[name].append((file_hash, vector))
            del batch, output
            # 增量落盘：整个 pass 攒到最后一次性提交，中途崩溃会全丢且大事务易锁库
            if len(pending_cache[name]) >= 256:
                self.cache.put_many(self._cache_key(name), pending_cache[name])
                pending_cache[name] = []

        def decode_entry(entry: tuple[int, dict, list[str]]) -> dict:
            _index, info, needed = entry
            image = _open_rgb(info["path"])
            return {name: self.transforms[name](image) for name in needed}

        # 单线程 PIL 解码是瓶颈：线程池预取解码，一次解码喂所有缺该图的模型；
        # 主线程严格按提交顺序消费，各模型攒批顺序 = 其 missing 序列原顺序，
        # 分批切法与逐模型独立跑完全一致；在途任务不超过 batch_size*3，防止解码结果无界堆积
        window = self.batch_size * 3
        pool = ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 4))
        try:
            entry_iter = iter(union_missing)
            inflight = deque(
                (entry, pool.submit(decode_entry, entry))
                for entry in itertools.islice(entry_iter, window)
            )
            with tqdm(
                total=len(union_missing),
                desc="深度特征",
                unit="img",
                disable=not union_missing,
            ) as progress:
                while inflight:
                    (index, info, needed), future = inflight.popleft()
                    tensors_by_model = future.result()
                    for name in needed:
                        batch_items[name].append(
                            (index, info["file_hash"], tensors_by_model[name])
                        )
                        if len(batch_items[name]) >= self.batch_size:
                            flush_batch(name)
                    progress.update(1)
                    next_entry = next(entry_iter, None)
                    if next_entry is not None:
                        inflight.append((next_entry, pool.submit(decode_entry, next_entry)))
        finally:
            # 解码线程异常经 future.result() 在主线程抛出；这里兜底取消未启动任务并回收线程
            pool.shutdown(wait=True, cancel_futures=True)

        for name in model_names:
            flush_batch(name)
            if pending_cache[name]:
                self.cache.put_many(self._cache_key(name), pending_cache[name])

        return {
            name: np.stack(results[name]).astype(np.float32, copy=False)
            for name in model_names
        }

    def close(self) -> None:
        self.models.clear()
        self.cache.close()
        if self.device == "cuda":
            self.torch.cuda.empty_cache()


def cosine_topk_pairs(
    embeddings: np.ndarray,
    top_k: int,
    min_similarity: float,
    device: str = "cpu",
    block_size: int = 512,
    mutual: bool = True,
) -> dict[tuple[int, int], float]:
    import torch

    vectors = np.asarray(embeddings, dtype=np.float32)
    count = vectors.shape[0]
    if count < 2 or top_k < 1:
        return {}

    target_device = resolve_device(device)
    tensor = None
    try:
        tensor = torch.from_numpy(vectors).to(target_device)
        tensor = torch.nn.functional.normalize(tensor, dim=1)
        if target_device == "cuda":
            free_memory, _total_memory = torch.cuda.mem_get_info()
            safe_rows = max(1, int((free_memory * 0.25) / max(count * 4, 1)))
            block_size = min(block_size, safe_rows)
        neighbor_maps: list[dict[int, float]] = [dict() for _ in range(count)]
        effective_k = min(top_k + 1, count)

        for start in tqdm(range(0, count, block_size), desc="向量近邻", unit="block"):
            stop = min(count, start + block_size)
            similarities = tensor[start:stop] @ tensor.T
            values, indices = torch.topk(similarities, k=effective_k, dim=1)
            values = values.cpu().numpy()
            indices = indices.cpu().numpy()
            for offset, (row_values, row_indices) in enumerate(zip(values, indices)):
                source = start + offset
                for similarity, target in zip(row_values, row_indices):
                    target = int(target)
                    similarity = float(similarity)
                    if target != source and similarity >= min_similarity:
                        neighbor_maps[source][target] = similarity
            del similarities, values, indices
    except torch.OutOfMemoryError:
        if target_device != "cuda":
            raise
        if tensor is not None:
            del tensor
        torch.cuda.empty_cache()
        print("[警告] GPU 向量检索显存不足，自动切换到 CPU 分块检索。")
        return cosine_topk_pairs(
            embeddings,
            top_k,
            min_similarity,
            device="cpu",
            block_size=min(block_size, 256),
            mutual=mutual,
        )

    pairs = {}
    for source, neighbors in enumerate(neighbor_maps):
        for target, similarity in neighbors.items():
            if mutual and source not in neighbor_maps[target]:
                continue
            key = tuple(sorted((source, target)))
            pairs[key] = max(pairs.get(key, -1.0), similarity)
    return pairs


def prepare_models(root: str | os.PathLike[str], device: str = "cpu") -> dict[str, str]:
    extractor = DeepEmbeddingExtractor(root, device=device, batch_size=1)
    paths = {
        "sscd": str(extractor.root / SSCD_FILENAME),
        "dino_torch_home": os.environ["TORCH_HOME"],
    }
    extractor.close()
    return paths
