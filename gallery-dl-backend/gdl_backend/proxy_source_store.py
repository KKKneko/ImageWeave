from __future__ import annotations

import errno
import hashlib
import json
import logging
import math
import os
import re
import stat
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

from .config import ProxySettings
from .file_security import (
    ensure_private_directory,
    ensure_private_file,
    reject_symlink_path,
    write_private_text,
)
from .proxy_sources import ParsedProxyNode, parse_proxy_line, parse_subscription_text


MANAGED_PROXY_SOURCES_VERSION = 1
MAX_SUBSCRIPTION_URL_LENGTH = 4096
MAX_SUBSCRIPTIONS = 128
MAX_INLINE_NODES = 512
MAX_INLINE_NODE_LENGTH = 16 * 1024
MAX_INLINE_NODE_TOTAL_CHARS = 2 * 1024 * 1024
MAX_PROXY_SOURCE_PATH_LENGTH = 4096
MAX_PROXY_SOURCE_REQUEST_BYTES = MAX_INLINE_NODE_TOTAL_CHARS + 64 * 1024
MAX_MANAGED_SOURCES_FILE_BYTES = 4 * (
    MAX_INLINE_NODE_TOTAL_CHARS
    + MAX_SUBSCRIPTIONS * MAX_SUBSCRIPTION_URL_LENGTH
    + MAX_PROXY_SOURCE_PATH_LENGTH
) + 256 * 1024
REVISION_LENGTH = 64
SOURCE_ID_DIGEST_LENGTH = 64

_SOURCE_ID_RE = re.compile(r"^(?P<prefix>sub|node)_(?P<digest>[0-9a-f]{64})$")
_UUID_RE = re.compile(
    r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
)
_LONG_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_~+/=-]{32,}(?![A-Za-z0-9])")
_LOGGER = logging.getLogger("gdl_backend.proxy_sources_store")


class ProxySourceStoreError(RuntimeError):
    """托管代理源错误；消息和详情必须始终可以安全返回给 API。"""

    def __init__(self, message: str, *, reason: str = "store_error", details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.details = details


class ProxySourceStoreCorrupt(ProxySourceStoreError):
    pass


class ProxySourceStoreConflict(ProxySourceStoreError):
    pass


class ProxySourceNotFound(ProxySourceStoreError):
    pass


class ProxySourcePathForbidden(ProxySourceStoreError):
    pass


class ProxySourceValidationError(ProxySourceStoreError):
    def __init__(
        self,
        category: Literal["subscription", "inline_node", "node_file", "source_id"],
        message: str,
        *,
        reason: str,
        index: int | None = None,
    ) -> None:
        details: dict[str, Any] = {"reason": reason}
        if index is not None:
            details["index"] = index
        super().__init__(message, reason=reason, details=details)
        self.category = category
        self.index = index


@dataclass(frozen=True, slots=True)
class ProxySourceSnapshot:
    """一份完整、不可变且不在 repr 中暴露秘密的有效代理源快照。"""

    subscription_urls: tuple[str, ...]
    node_file: Path | None
    inline_nodes: tuple[str, ...]
    source: Literal["config", "runtime", "none"]
    has_runtime_override: bool
    runtime_override_valid: bool
    configured_revision: str

    def __repr__(self) -> str:
        return (
            "ProxySourceSnapshot("
            f"source={self.source!r}, subscriptions={len(self.subscription_urls)}, "
            f"node_file={self.node_file is not None}, inline_nodes={len(self.inline_nodes)}, "
            f"has_runtime_override={self.has_runtime_override}, "
            f"runtime_override_valid={self.runtime_override_valid}, "
            f"configured_revision={self.configured_revision!r})"
        )


class ProxySourceProvider(Protocol):
    def snapshot(self) -> ProxySourceSnapshot: ...


ProxySourceProviderLike = ProxySourceProvider | Callable[[], ProxySourceSnapshot]


@dataclass(frozen=True, slots=True)
class _LoadedSnapshot:
    snapshot: ProxySourceSnapshot
    token: str


def _unique_trimmed(values: Any) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or ():
        text = str(value).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return tuple(result)


def _snapshot_payload(
    subscription_urls: tuple[str, ...],
    node_file: Path | None,
    inline_nodes: tuple[str, ...],
) -> bytes:
    data = {
        "subscription_urls": list(subscription_urls),
        "node_file": os.fspath(node_file) if node_file is not None else None,
        "inline_nodes": list(inline_nodes),
    }
    return json.dumps(
        data,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def configured_revision_for(
    subscription_urls: tuple[str, ...],
    node_file: Path | None,
    inline_nodes: tuple[str, ...],
) -> str:
    """使用完整 SHA-256，避免截断 revision 导致错误等同。"""

    return hashlib.sha256(
        b"imageweave-managed-proxy-sources-revision-v1\0"
        + _snapshot_payload(subscription_urls, node_file, inline_nodes)
    ).hexdigest()


def make_proxy_source_snapshot(
    subscription_urls: Any,
    node_file: Path | str | None,
    inline_nodes: Any,
    *,
    source: Literal["config", "runtime", "none"] | None = None,
    has_runtime_override: bool = False,
    runtime_override_valid: bool = True,
) -> ProxySourceSnapshot:
    subscriptions = _unique_trimmed(subscription_urls)
    nodes = _unique_trimmed(inline_nodes)
    # 有效来源使用与写入相同的规范化规则；旧配置中的非法值仍保留给原启动错误路径处理。
    try:
        subscriptions = _normalize_subscriptions(subscriptions)
    except ProxySourceValidationError:
        pass
    try:
        nodes = _normalize_inline_nodes(nodes)
    except ProxySourceValidationError:
        pass
    normalized_file = (
        Path(os.path.abspath(os.fspath(node_file))) if node_file not in (None, "") else None
    )
    effective_source = source
    if effective_source is None:
        effective_source = "config" if subscriptions or normalized_file or nodes else "none"
    return ProxySourceSnapshot(
        subscription_urls=subscriptions,
        node_file=normalized_file,
        inline_nodes=nodes,
        source=effective_source,
        has_runtime_override=has_runtime_override,
        runtime_override_valid=runtime_override_valid,
        configured_revision=configured_revision_for(subscriptions, normalized_file, nodes),
    )


def snapshot_from_settings(settings: ProxySettings) -> ProxySourceSnapshot:
    """兼容旧调用：每次调用都读取 settings 当前值，而不是缓存列表引用。"""

    return make_proxy_source_snapshot(
        settings.subscription_urls,
        settings.node_file,
        settings.inline_nodes,
    )


def _canonical_host(hostname: str) -> str:
    host = str(hostname or "").strip().rstrip(".")
    if not host or any(char.isspace() or char in "/\\?#@" for char in host):
        raise ValueError("invalid host")
    if ":" in host:
        return host.lower()
    return host.encode("idna").decode("ascii").lower()


def normalize_subscription_url(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        raise ProxySourceValidationError(
            "subscription", "订阅地址无效", reason="empty"
        )
    if len(text) > MAX_SUBSCRIPTION_URL_LENGTH:
        raise ProxySourceValidationError(
            "subscription", "订阅地址无效", reason="too_long"
        )
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ProxySourceValidationError(
            "subscription", "订阅地址无效", reason="control_character"
        )
    try:
        parsed = urlsplit(text)
        scheme = parsed.scheme.lower()
        hostname = _canonical_host(parsed.hostname or "")
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("invalid port")
    except (UnicodeError, ValueError) as exc:
        raise ProxySourceValidationError(
            "subscription", "订阅地址无效", reason="malformed"
        ) from exc
    if scheme not in {"http", "https"}:
        raise ProxySourceValidationError(
            "subscription", "订阅地址无效", reason="unsupported_scheme"
        )
    raw_userinfo, separator, _ = parsed.netloc.rpartition("@")
    userinfo = f"{raw_userinfo}@" if separator else ""
    host_text = f"[{hostname}]" if ":" in hostname else hostname
    authority = f"{userinfo}{host_text}{f':{port}' if port is not None else ''}"
    return urlunsplit((scheme, authority, parsed.path, parsed.query, parsed.fragment))


def _parse_one_inline_node(value: object, *, index: int | None = None) -> tuple[str, ParsedProxyNode]:
    text = str(value or "").strip()
    if not text:
        raise ProxySourceValidationError(
            "inline_node", "内联节点无效", reason="empty", index=index
        )
    if len(text) > MAX_INLINE_NODE_LENGTH:
        raise ProxySourceValidationError(
            "inline_node", "内联节点无效", reason="too_long", index=index
        )
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ProxySourceValidationError(
            "inline_node", "内联节点无效", reason="control_character", index=index
        )
    node = parse_proxy_line(text)
    if node is None:
        try:
            parsed = parse_subscription_text(text)
        except (TypeError, ValueError):
            parsed = []
        if len(parsed) == 1:
            node = parsed[0]
    if node is None or not (node.usable or node.core_config):
        raise ProxySourceValidationError(
            "inline_node", "内联节点无效", reason="unsupported_or_empty", index=index
        )
    return text, node


def _normalize_subscriptions(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)):
        raise ProxySourceValidationError(
            "subscription", "订阅列表无效", reason="invalid_list"
        )
    if len(values) > MAX_SUBSCRIPTIONS:
        raise ProxySourceValidationError(
            "subscription", "订阅列表无效", reason="too_many"
        )
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_subscription_url(value)
        if normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return tuple(result)


def _normalize_inline_nodes(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)):
        raise ProxySourceValidationError(
            "inline_node", "内联节点列表无效", reason="invalid_list"
        )
    if len(values) > MAX_INLINE_NODES:
        raise ProxySourceValidationError(
            "inline_node", "内联节点列表无效", reason="too_many"
        )
    total = sum(len(str(value or "")) for value in values)
    if total > MAX_INLINE_NODE_TOTAL_CHARS:
        raise ProxySourceValidationError(
            "inline_node", "内联节点列表无效", reason="total_too_large"
        )
    result: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(values):
        normalized, _ = _parse_one_inline_node(value, index=index)
        if normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return tuple(result)


def _absolute_lexical_path(path: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _inside_lexically(path: Path, root: Path) -> bool:
    candidate = _absolute_lexical_path(path)
    parent = _absolute_lexical_path(root)
    return candidate == parent or candidate.is_relative_to(parent)


def _open_absolute_no_follow(path: Path) -> int:
    """逐组件打开绝对路径；POSIX 上不会在检查后重新跟随中间符号链接。"""

    candidate = _absolute_lexical_path(path)
    try:
        reject_symlink_path(candidate)
    except (OSError, ValueError) as exc:
        raise ProxySourcePathForbidden(
            "节点文件路径不在许可范围内", reason="symlink"
        ) from exc

    nofollow = int(getattr(os, "O_NOFOLLOW", 0))
    cloexec = int(getattr(os, "O_CLOEXEC", 0))
    directory = int(getattr(os, "O_DIRECTORY", 0))
    if os.name == "nt" or not directory or not candidate.is_absolute():
        try:
            return os.open(candidate, os.O_RDONLY | nofollow | cloexec)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise ProxySourcePathForbidden(
                    "节点文件路径不在许可范围内", reason="symlink"
                ) from exc
            raise ProxySourceValidationError(
                "node_file", "节点文件不可用", reason="unavailable"
            ) from exc

    parts = candidate.parts
    descriptor = -1
    try:
        descriptor = os.open(parts[0], os.O_RDONLY | directory | cloexec)
        for index, part in enumerate(parts[1:], start=1):
            final = index == len(parts) - 1
            flags = os.O_RDONLY | nofollow | cloexec
            if not final:
                flags |= directory
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except OSError as exc:
        if descriptor >= 0:
            os.close(descriptor)
        if exc.errno == errno.ELOOP:
            raise ProxySourcePathForbidden(
                "节点文件路径不在许可范围内", reason="symlink"
            ) from exc
        raise ProxySourceValidationError(
            "node_file", "节点文件不可用", reason="unavailable"
        ) from exc


def read_proxy_node_file(
    path: Path,
    *,
    allowed_roots: tuple[Path, ...] | list[Path] | None = None,
) -> tuple[str, list[ParsedProxyNode]]:
    """限量、严格 UTF-8、逐组件 no-follow 地读取并解析节点文件。"""

    candidate = _absolute_lexical_path(path)
    if allowed_roots is not None:
        roots = tuple(_absolute_lexical_path(root) for root in allowed_roots)
        if not roots or not any(_inside_lexically(candidate, root) for root in roots):
            raise ProxySourcePathForbidden(
                "节点文件路径不在许可范围内", reason="outside_allowed_roots"
            )
    descriptor = _open_absolute_no_follow(candidate)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ProxySourceValidationError(
                "node_file", "节点文件不可用", reason="not_regular"
            )
        from .proxy_sources import MAX_SUBSCRIPTION_BYTES

        if info.st_size > MAX_SUBSCRIPTION_BYTES:
            raise ProxySourceValidationError(
                "node_file", "节点文件不可用", reason="too_large"
            )
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(65536, MAX_SUBSCRIPTION_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_SUBSCRIPTION_BYTES:
                raise ProxySourceValidationError(
                    "node_file", "节点文件不可用", reason="too_large"
                )
    finally:
        os.close(descriptor)
    try:
        text = b"".join(chunks).decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ProxySourceValidationError(
            "node_file", "节点文件不可用", reason="invalid_encoding"
        ) from exc
    try:
        nodes = parse_subscription_text(text)
    except (TypeError, ValueError) as exc:
        raise ProxySourceValidationError(
            "node_file", "节点文件不可用", reason="invalid_content"
        ) from exc
    if not any(node.usable or node.core_config for node in nodes):
        raise ProxySourceValidationError(
            "node_file", "节点文件不可用", reason="empty_parse"
        )
    return text, nodes


def _source_id(prefix: Literal["sub", "node"], value: str) -> str:
    digest = hashlib.sha256(
        f"imageweave-proxy-source-id-v1:{prefix}\0{value}".encode("utf-8")
    ).hexdigest()
    return f"{prefix}_{digest}"


def _id_index(
    prefix: Literal["sub", "node"], values: tuple[str, ...]
) -> dict[str, tuple[int, str]]:
    result: dict[str, tuple[int, str]] = {}
    for index, value in enumerate(values):
        source_id = _source_id(prefix, value)
        existing = result.get(source_id)
        if existing is not None and existing[1] != value:
            raise ProxySourceStoreConflict(
                "代理源标识发生冲突，未执行操作", reason="opaque_id_collision"
            )
        result[source_id] = (index, value)
    return result


def _validate_source_id(source_id: str, prefix: Literal["sub", "node"]) -> None:
    value = str(source_id or "")
    expected_length = SOURCE_ID_DIGEST_LENGTH + len(prefix) + 1
    match = _SOURCE_ID_RE.fullmatch(value) if len(value) == expected_length else None
    if match is None or match.group("prefix") != prefix:
        raise ProxySourceValidationError(
            "source_id", "代理源标识格式无效", reason="invalid_source_id"
        )


def _safe_text(value: object, *, limit: int) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(" " if unicodedata.category(char).startswith("C") else char for char in text)
    text = " ".join(text.split())
    text = _UUID_RE.sub("***", text)
    text = _LONG_TOKEN_RE.sub("***", text)
    if "://" in text or any(marker in text.lower() for marker in ("password=", "token=", "secret=")):
        return "已命名节点"
    return text[:limit]


def safe_proxy_node_name(value: object) -> str:
    """供代理源 API 与运行状态共用的节点名称安全显示规则。"""

    return _safe_text(value, limit=80)


def _display_host(host: str) -> str:
    try:
        return _canonical_host(host)
    except (UnicodeError, ValueError):
        return ""


def _public_subscription(value: str, *, source: str) -> dict[str, Any]:
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower() if parsed.scheme.lower() in {"http", "https"} else "https"
        host = _display_host(parsed.hostname or "")
        port = parsed.port
        has_credentials = parsed.username is not None or parsed.password is not None
        sensitive = bool(
            has_credentials
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        )
    except ValueError:
        scheme, host, port, has_credentials, sensitive = "https", "", None, False, True
    authority = f"[{host}]" if ":" in host else host
    if port is not None:
        authority += f":{port}"
    return {
        "id": _source_id("sub", value),
        "source": source,
        "scheme": scheme,
        "host": host,
        "port": port,
        "display_url": f"{scheme}://{authority}/…" if authority else f"{scheme}://…",
        "credentials_redacted": has_credentials,
        "sensitive_parts_redacted": sensitive,
    }


def _public_inline_node(value: str, *, source: str) -> dict[str, Any]:
    try:
        _, node = _parse_one_inline_node(value)
        scheme = str(node.scheme or "unknown").lower()[:24]
        host = _display_host(node.host)
        port = int(node.port or 0)
        name = safe_proxy_node_name(node.name)
        requires_core = bool(not node.usable and node.core_config)
    except ProxySourceValidationError:
        scheme, host, port, name, requires_core = "unknown", "", 0, "", False
    authority = f"[{host}]" if ":" in host else host
    if port:
        authority += f":{port}"
    endpoint = f"{scheme}://***@{authority}" if authority else f"{scheme}://***"
    if name:
        endpoint += f"#{name}"
    return {
        "id": _source_id("node", value),
        "source": source,
        "scheme": scheme,
        "name": name,
        "host": host,
        "port": port,
        "requires_transport_core": requires_core,
        "display_endpoint": endpoint,
    }


class ManagedProxySourceStore:
    """线程安全地管理 config 基线与单文件运行时完整覆盖。"""

    def __init__(
        self,
        settings: ProxySettings,
        runtime_dir: Path,
        *,
        project_dir: Path | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._project_dir = _absolute_lexical_path(
            project_dir if project_dir is not None else Path(runtime_dir).parent
        )
        self._workspace_dir = self._project_dir.parent
        self._allowed_node_roots = tuple(
            _absolute_lexical_path(root) for root in settings.allowed_node_roots
        )
        self.override_path = _absolute_lexical_path(
            Path(runtime_dir) / "proxy" / "managed-sources.json"
        )
        try:
            ensure_private_directory(self.override_path.parent)
        except (OSError, PermissionError, ValueError) as exc:
            raise ProxySourcePathForbidden(
                "托管代理源路径不可用", reason="managed_path_forbidden"
            ) from exc
        self._baseline = make_proxy_source_snapshot(
            settings.subscription_urls,
            settings.node_file,
            settings.inline_nodes,
        )
        self._last_reported_failure = ""
        # 启动时即检查覆盖；损坏只触发脱敏告警并安全回退基线。
        self.snapshot()

    @property
    def path(self) -> Path:
        return self.override_path

    def _report_failure(self, reason: str) -> None:
        if reason == self._last_reported_failure:
            return
        self._last_reported_failure = reason
        _LOGGER.warning("托管代理源覆盖无效，已安全回退配置基线（原因：%s）", reason)

    def _fallback_snapshot(self, *, override_present: bool) -> ProxySourceSnapshot:
        return make_proxy_source_snapshot(
            self._baseline.subscription_urls,
            self._baseline.node_file,
            self._baseline.inline_nodes,
            source=self._baseline.source,
            has_runtime_override=override_present,
            runtime_override_valid=not override_present,
        )

    def _lexists(self) -> bool:
        return os.path.lexists(self.override_path)

    def _read_raw_override(self) -> bytes:
        try:
            reject_symlink_path(self.override_path)
            ensure_private_file(self.override_path)
        except (OSError, PermissionError, ValueError) as exc:
            if self.override_path.is_symlink():
                raise ProxySourcePathForbidden(
                    "托管代理源路径不可用", reason="managed_path_symlink"
                ) from exc
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_target"
            ) from exc
        nofollow = int(getattr(os, "O_NOFOLLOW", 0))
        try:
            descriptor = os.open(self.override_path, os.O_RDONLY | nofollow)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise ProxySourcePathForbidden(
                    "托管代理源路径不可用", reason="managed_path_symlink"
                ) from exc
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="read_failed"
            ) from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ProxySourceStoreCorrupt(
                    "运行时代理源覆盖无效", reason="not_regular"
                )
            if info.st_size > MAX_MANAGED_SOURCES_FILE_BYTES:
                raise ProxySourceStoreCorrupt(
                    "运行时代理源覆盖无效", reason="too_large"
                )
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = os.read(
                    descriptor,
                    min(65536, MAX_MANAGED_SOURCES_FILE_BYTES + 1 - size),
                )
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_MANAGED_SOURCES_FILE_BYTES:
                    raise ProxySourceStoreCorrupt(
                        "运行时代理源覆盖无效", reason="too_large"
                    )
            return b"".join(chunks)
        finally:
            os.close(descriptor)

    def _decode_override(self, raw: bytes) -> ProxySourceSnapshot:
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_json"
            ) from exc
        required = {
            "version",
            "updated_at",
            "subscription_urls",
            "node_file",
            "inline_nodes",
        }
        if not isinstance(data, dict) or set(data) != required:
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_structure"
            )
        if type(data["version"]) is not int or data["version"] != MANAGED_PROXY_SOURCES_VERSION:
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="unsupported_version"
            )
        updated_at = data["updated_at"]
        if (
            isinstance(updated_at, bool)
            or not isinstance(updated_at, (int, float))
            or not math.isfinite(float(updated_at))
            or float(updated_at) < 0
        ):
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_updated_at"
            )
        if not isinstance(data["subscription_urls"], list) or not all(
            isinstance(item, str) for item in data["subscription_urls"]
        ):
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_structure"
            )
        if data["node_file"] is not None and not isinstance(data["node_file"], str):
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_structure"
            )
        if not isinstance(data["inline_nodes"], list) or not all(
            isinstance(item, str) for item in data["inline_nodes"]
        ):
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_structure"
            )
        try:
            subscriptions = _normalize_subscriptions(data["subscription_urls"])
            nodes = _normalize_inline_nodes(data["inline_nodes"])
        except ProxySourceValidationError as exc:
            raise ProxySourceStoreCorrupt(
                "运行时代理源覆盖无效", reason="invalid_source_value"
            ) from exc
        node_file: Path | None = None
        if data["node_file"]:
            raw_path = str(data["node_file"])
            if len(raw_path) > MAX_PROXY_SOURCE_PATH_LENGTH or not Path(raw_path).is_absolute():
                raise ProxySourceStoreCorrupt(
                    "运行时代理源覆盖无效", reason="invalid_node_file_value"
                )
            node_file = _absolute_lexical_path(raw_path)
        return make_proxy_source_snapshot(
            subscriptions,
            node_file,
            nodes,
            source="runtime",
            has_runtime_override=True,
            runtime_override_valid=True,
        )

    def _load_locked(self, *, for_mutation: bool) -> _LoadedSnapshot:
        if not self._lexists():
            self._last_reported_failure = ""
            return _LoadedSnapshot(self._fallback_snapshot(override_present=False), "absent")
        try:
            raw = self._read_raw_override()
            snapshot = self._decode_override(raw)
        except (ProxySourcePathForbidden, ProxySourceStoreCorrupt) as exc:
            self._report_failure(exc.reason)
            if for_mutation:
                raise
            return _LoadedSnapshot(self._fallback_snapshot(override_present=True), "invalid")
        self._last_reported_failure = ""
        return _LoadedSnapshot(snapshot, hashlib.sha256(raw).hexdigest())

    def snapshot(self) -> ProxySourceSnapshot:
        with self._lock:
            return self._load_locked(for_mutation=False).snapshot

    def _current_token_locked(self) -> str:
        if not self._lexists():
            return "absent"
        return hashlib.sha256(self._read_raw_override()).hexdigest()

    def _validate_complete(
        self,
        subscription_urls: Any,
        node_file: Path | None,
        inline_nodes: Any,
    ) -> tuple[tuple[str, ...], Path | None, tuple[str, ...]]:
        subscriptions = _normalize_subscriptions(subscription_urls)
        nodes = _normalize_inline_nodes(inline_nodes)
        normalized_file = _absolute_lexical_path(node_file) if node_file is not None else None
        if normalized_file is not None:
            read_proxy_node_file(normalized_file)
        return subscriptions, normalized_file, nodes

    def _write_locked(
        self,
        *,
        expected_token: str,
        subscription_urls: Any,
        node_file: Path | None,
        inline_nodes: Any,
    ) -> ProxySourceSnapshot:
        subscriptions, normalized_file, nodes = self._validate_complete(
            subscription_urls,
            node_file,
            inline_nodes,
        )
        try:
            current_token = self._current_token_locked()
        except (ProxySourcePathForbidden, ProxySourceStoreCorrupt) as exc:
            raise ProxySourceStoreConflict(
                "运行时代理源覆盖已被并发修改，未保存本次变更",
                reason="external_change",
            ) from exc
        if current_token != expected_token:
            raise ProxySourceStoreConflict(
                "运行时代理源覆盖已被并发修改，未保存本次变更",
                reason="external_change",
            )
        document = {
            "version": MANAGED_PROXY_SOURCES_VERSION,
            "updated_at": int(time.time()),
            "subscription_urls": list(subscriptions),
            "node_file": os.fspath(normalized_file) if normalized_file is not None else None,
            "inline_nodes": list(nodes),
        }
        text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        try:
            write_private_text(self.override_path, text)
        except (OSError, PermissionError, ValueError) as exc:
            if self.override_path.is_symlink():
                raise ProxySourcePathForbidden(
                    "托管代理源路径不可用", reason="managed_path_symlink"
                ) from exc
            raise ProxySourceStoreError(
                "无法保存运行时代理源覆盖", reason="write_failed"
            ) from exc
        return make_proxy_source_snapshot(
            subscriptions,
            normalized_file,
            nodes,
            source="runtime",
            has_runtime_override=True,
            runtime_override_valid=True,
        )

    def add_subscription(self, url: str) -> ProxySourceSnapshot:
        with self._lock:
            loaded = self._load_locked(for_mutation=True)
            normalized = normalize_subscription_url(url)
            values = (*loaded.snapshot.subscription_urls, normalized)
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=values,
                node_file=loaded.snapshot.node_file,
                inline_nodes=loaded.snapshot.inline_nodes,
            )

    def replace_subscription(self, source_id: str, url: str) -> ProxySourceSnapshot:
        with self._lock:
            _validate_source_id(source_id, "sub")
            loaded = self._load_locked(for_mutation=True)
            identifiers = _id_index("sub", loaded.snapshot.subscription_urls)
            found = identifiers.get(source_id)
            if found is None:
                raise ProxySourceNotFound("代理源不存在", reason="not_found")
            normalized = normalize_subscription_url(url)
            values = list(loaded.snapshot.subscription_urls)
            values[found[0]] = normalized
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=values,
                node_file=loaded.snapshot.node_file,
                inline_nodes=loaded.snapshot.inline_nodes,
            )

    def delete_subscription(self, source_id: str) -> ProxySourceSnapshot:
        with self._lock:
            _validate_source_id(source_id, "sub")
            loaded = self._load_locked(for_mutation=True)
            identifiers = _id_index("sub", loaded.snapshot.subscription_urls)
            found = identifiers.get(source_id)
            if found is None:
                raise ProxySourceNotFound("代理源不存在", reason="not_found")
            values = list(loaded.snapshot.subscription_urls)
            values.pop(found[0])
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=values,
                node_file=loaded.snapshot.node_file,
                inline_nodes=loaded.snapshot.inline_nodes,
            )

    def _resolve_api_node_file(self, value: str) -> Path:
        text = str(value or "").strip()
        if (
            not text
            or len(text) > MAX_PROXY_SOURCE_PATH_LENGTH
            or any(ord(char) < 32 or ord(char) == 127 for char in text)
        ):
            raise ProxySourceValidationError(
                "node_file", "节点文件不可用", reason="invalid_path"
            )
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            candidate = self._project_dir / candidate
        candidate = _absolute_lexical_path(candidate)
        read_proxy_node_file(candidate, allowed_roots=self._allowed_node_roots)
        return candidate

    def set_node_file(self, path: str) -> ProxySourceSnapshot:
        with self._lock:
            loaded = self._load_locked(for_mutation=True)
            candidate = self._resolve_api_node_file(path)
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=loaded.snapshot.subscription_urls,
                node_file=candidate,
                inline_nodes=loaded.snapshot.inline_nodes,
            )

    def clear_node_file(self) -> ProxySourceSnapshot:
        with self._lock:
            loaded = self._load_locked(for_mutation=True)
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=loaded.snapshot.subscription_urls,
                node_file=None,
                inline_nodes=loaded.snapshot.inline_nodes,
            )

    def add_inline_nodes(self, nodes: list[str]) -> ProxySourceSnapshot:
        with self._lock:
            loaded = self._load_locked(for_mutation=True)
            normalized = _normalize_inline_nodes(nodes)
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=loaded.snapshot.subscription_urls,
                node_file=loaded.snapshot.node_file,
                inline_nodes=(*loaded.snapshot.inline_nodes, *normalized),
            )

    def replace_inline_node(self, source_id: str, node: str) -> ProxySourceSnapshot:
        with self._lock:
            _validate_source_id(source_id, "node")
            loaded = self._load_locked(for_mutation=True)
            identifiers = _id_index("node", loaded.snapshot.inline_nodes)
            found = identifiers.get(source_id)
            if found is None:
                raise ProxySourceNotFound("代理源不存在", reason="not_found")
            normalized, _ = _parse_one_inline_node(node)
            values = list(loaded.snapshot.inline_nodes)
            values[found[0]] = normalized
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=loaded.snapshot.subscription_urls,
                node_file=loaded.snapshot.node_file,
                inline_nodes=values,
            )

    def delete_inline_node(self, source_id: str) -> ProxySourceSnapshot:
        with self._lock:
            _validate_source_id(source_id, "node")
            loaded = self._load_locked(for_mutation=True)
            identifiers = _id_index("node", loaded.snapshot.inline_nodes)
            found = identifiers.get(source_id)
            if found is None:
                raise ProxySourceNotFound("代理源不存在", reason="not_found")
            values = list(loaded.snapshot.inline_nodes)
            values.pop(found[0])
            return self._write_locked(
                expected_token=loaded.token,
                subscription_urls=loaded.snapshot.subscription_urls,
                node_file=loaded.snapshot.node_file,
                inline_nodes=values,
            )

    def reset_override(self) -> ProxySourceSnapshot:
        with self._lock:
            try:
                ensure_private_directory(self.override_path.parent)
                reject_symlink_path(self.override_path)
            except (OSError, PermissionError, ValueError) as exc:
                raise ProxySourcePathForbidden(
                    "托管代理源路径不可用", reason="managed_path_symlink"
                ) from exc
            if self._lexists():
                try:
                    info = os.lstat(self.override_path)
                    if stat.S_ISLNK(info.st_mode):
                        raise ProxySourcePathForbidden(
                            "托管代理源路径不可用", reason="managed_path_symlink"
                        )
                    if not stat.S_ISREG(info.st_mode):
                        raise ProxySourcePathForbidden(
                            "托管代理源路径不可用", reason="managed_target_not_file"
                        )
                    self.override_path.unlink()
                except ProxySourcePathForbidden:
                    raise
                except OSError as exc:
                    raise ProxySourceStoreError(
                        "无法恢复配置文件默认代理源", reason="delete_failed"
                    ) from exc
            self._last_reported_failure = ""
            return self._fallback_snapshot(override_present=False)

    def _display_node_file(self, path: Path | None) -> str | None:
        if path is None:
            return None
        candidate = _absolute_lexical_path(path)
        for root in (self._project_dir, self._workspace_dir):
            if _inside_lexically(candidate, root):
                try:
                    return _safe_text(candidate.relative_to(root).as_posix(), limit=240)
                except ValueError:
                    pass
        return _safe_text(candidate.name, limit=160) or "外部节点文件"

    def public_snapshot(
        self,
        snapshot: ProxySourceSnapshot | None = None,
        *,
        active_revision: str | None,
    ) -> dict[str, Any]:
        current = snapshot or self.snapshot()
        # 构建映射时检测完整哈希碰撞，绝不让 source_id 指向错误秘密值。
        _id_index("sub", current.subscription_urls)
        _id_index("node", current.inline_nodes)
        subscriptions = [
            _public_subscription(value, source=current.source)
            for value in current.subscription_urls
        ]
        inline_nodes = [
            _public_inline_node(value, source=current.source)
            for value in current.inline_nodes
        ]
        counts = {
            "subscriptions": len(subscriptions),
            "node_file": int(current.node_file is not None),
            "inline_nodes": len(inline_nodes),
        }
        counts["total"] = sum(counts.values())
        return {
            "source": current.source,
            "has_runtime_override": current.has_runtime_override,
            "runtime_override_valid": current.runtime_override_valid,
            "configured_revision": current.configured_revision,
            "active_revision": active_revision,
            "reload_required": current.configured_revision != active_revision,
            "subscriptions": subscriptions,
            "node_file": {
                "configured": current.node_file is not None,
                "source": current.source,
                "display_path": self._display_node_file(current.node_file),
            },
            "inline_nodes": inline_nodes,
            "counts": counts,
        }
