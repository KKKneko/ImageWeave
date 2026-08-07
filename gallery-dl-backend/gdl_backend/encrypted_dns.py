from __future__ import annotations

import ipaddress
import json
import math
import re
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

import requests


DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"
DEFAULT_DOH_TIMEOUT_SECONDS = 8.0
DEFAULT_DOH_MAX_RESPONSE_BYTES = 64 * 1024
DEFAULT_PROXY_DOH_CACHE_TTL_SECONDS = 300.0
DEFAULT_PROXY_DOH_CACHE_MAX_ENTRIES = 512
_MAX_TARGET_URL_LENGTH = 8192
_MAX_HOSTNAME_LENGTH = 253
_MAX_CNAME_HOPS = 16
_DOH_QUERY_TYPES = (("A", 1), ("AAAA", 28))
_TEREDO_NETWORK = ipaddress.ip_network("2001::/32")
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z", re.I)


class EncryptedDNSError(RuntimeError):
    """不会携带目标查询、代理地址或上游响应正文的受控 DoH 错误。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        proxy_fault: bool,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.proxy_fault = proxy_fault


@dataclass(frozen=True, slots=True)
class NetworkTarget:
    scheme: str
    hostname: str
    port: int
    literal_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None = None


@dataclass(frozen=True, slots=True)
class _ProxyDoHCacheEntry:
    expires_at: float
    addresses: tuple[str, ...]


def _public_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # Python 当前把 2001::/32（Teredo）判为 non-global；这里显式保留该边界，
    # 避免未来 stdlib 分类变化让已知 DNS 注入网段意外通过。
    return address.is_global and address not in _TEREDO_NETWORK


def _normalized_hostname(hostname: str) -> str:
    host = str(hostname or "").strip().rstrip(".")
    if not host:
        raise ValueError("目标 URL 缺少主机名")
    if "%" in host:
        raise ValueError("目标 URL 不允许带 IPv6 zone identifier")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise ValueError("目标 URL 主机名格式无效") from exc
        if len(host) > _MAX_HOSTNAME_LENGTH:
            raise ValueError("目标 URL 主机名过长")
        labels = host.split(".")
        if any(not label or not _HOST_LABEL.fullmatch(label) for label in labels):
            raise ValueError("目标 URL 主机名格式无效")
        return host
    return literal.compressed


def _normalized_dns_record_name(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("DNS 记录名称格式无效")
    name = _normalized_hostname(value)
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return name
    raise ValueError("DNS 记录名称格式无效")


def validate_network_target_syntax(
    url: str,
    allow_private: bool,
) -> NetworkTarget:
    text = str(url or "").strip()
    if not text or len(text) > _MAX_TARGET_URL_LENGTH:
        raise ValueError("目标 URL 为空或过长")
    if any(ord(char) <= 32 or ord(char) == 127 for char in text):
        raise ValueError("目标 URL 包含空白或控制字符")
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise ValueError("目标 URL 无法解析") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ValueError("目标 URL 仅支持 http 或 https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("目标 URL 不允许包含凭据")
    try:
        raw_hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("目标 URL 主机名或端口无效") from exc
    hostname = _normalized_hostname(raw_hostname or "")
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        if not allow_private:
            raise ValueError("目标 URL 指向本机或私有网络")
    if port is None:
        port = 443 if scheme == "https" else 80
    if not 1 <= int(port) <= 65535:
        raise ValueError("目标 URL 端口超出范围")
    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None
    if literal_ip is not None and not allow_private and not _public_ip(literal_ip):
        raise ValueError(
            f"目标 URL 解析到非公网地址（IPv{literal_ip.version}: {literal_ip}），已拒绝"
        )
    return NetworkTarget(scheme, hostname, int(port), literal_ip)


def validate_resolved_addresses(
    addresses: list[str] | tuple[str, ...],
    *,
    allow_private: bool,
    strict: bool,
) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    has_global = False
    for value in addresses:
        address = str(value or "").split("%", 1)[0].strip()
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            if strict:
                raise ValueError("目标主机解析出无法识别的地址") from exc
            continue
        public = _public_ip(ip)
        if not allow_private and strict and not public:
            raise ValueError(
                f"目标 URL 解析到非公网地址（IPv{ip.version}: {ip}），已拒绝"
            )
        has_global = has_global or public
        rendered = ip.compressed
        if rendered not in seen:
            seen.add(rendered)
            normalized.append(rendered)
    if allow_private:
        if not normalized:
            raise ValueError("目标主机 DNS 未返回任何地址")
        return tuple(normalized)
    if strict:
        if not normalized:
            raise ValueError("目标主机 DNS 未返回任何地址")
        return tuple(normalized)
    if not has_global:
        raise ValueError("目标 URL 指向本机或私有网络")
    return tuple(normalized)


def validate_direct_network_target(
    url: str,
    allow_private: bool,
    *,
    strict: bool = True,
) -> tuple[str, ...]:
    target = validate_network_target_syntax(url, allow_private)
    if target.literal_ip is not None:
        return validate_resolved_addresses(
            [target.literal_ip.compressed],
            allow_private=allow_private,
            strict=strict,
        )
    try:
        entries = socket.getaddrinfo(
            target.hostname,
            target.port,
            type=socket.SOCK_STREAM,
        )
    except OSError as exc:
        raise ValueError("目标主机 DNS 解析失败") from exc
    addresses = [entry[4][0] for entry in entries if entry and entry[4]]
    return validate_resolved_addresses(
        addresses,
        allow_private=allow_private,
        strict=strict,
    )


def normalize_doh_endpoint(value: Any) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 2048:
        raise ValueError("encrypted_dns.endpoint 为空或过长")
    if any(ord(char) <= 32 or ord(char) == 127 for char in text):
        raise ValueError("encrypted_dns.endpoint 包含空白或控制字符")
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise ValueError("encrypted_dns.endpoint 无法解析") from exc
    if (parsed.scheme or "").lower() != "https":
        raise ValueError("encrypted_dns.endpoint 必须使用 HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("encrypted_dns.endpoint 不允许包含凭据")
    if parsed.query or parsed.fragment:
        raise ValueError("encrypted_dns.endpoint 不允许包含 query 或 fragment")
    if not parsed.path or parsed.path == "/":
        raise ValueError("encrypted_dns.endpoint 必须包含 DoH 路径")
    try:
        hostname = _normalized_hostname(parsed.hostname or "")
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"encrypted_dns.endpoint 无效: {exc}") from exc
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        raise ValueError("encrypted_dns.endpoint 必须指向公网 HTTPS 服务")
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None and not _public_ip(literal):
        raise ValueError("encrypted_dns.endpoint 必须指向公网 HTTPS 服务")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("encrypted_dns.endpoint 端口超出范围")
    host = f"[{hostname}]" if literal is not None and literal.version == 6 else hostname
    netloc = host if port is None else f"{host}:{port}"
    return urlunsplit(("https", netloc, parsed.path, "", ""))


class EncryptedDNSResolver:
    def __init__(
        self,
        *,
        enabled: bool = True,
        endpoint: str = DEFAULT_DOH_ENDPOINT,
        timeout_seconds: float = DEFAULT_DOH_TIMEOUT_SECONDS,
        max_response_bytes: int = DEFAULT_DOH_MAX_RESPONSE_BYTES,
        session_factory: Callable[[], requests.Session] | None = None,
    ) -> None:
        self.enabled = bool(enabled)
        self.endpoint = normalize_doh_endpoint(endpoint)
        self.timeout_seconds = float(timeout_seconds)
        self.max_response_bytes = int(max_response_bytes)
        self._session_factory = session_factory or requests.Session

    def _read_body(self, response: requests.Response) -> bytes:
        headers = getattr(response, "headers", {}) or {}
        content_length = headers.get("Content-Length") or headers.get("content-length")
        if content_length not in (None, ""):
            try:
                declared = int(content_length)
            except (TypeError, ValueError) as exc:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 返回了无效 Content-Length",
                    retryable=True,
                    proxy_fault=True,
                ) from exc
            if declared < 0 or declared > self.max_response_bytes:
                raise EncryptedDNSError(
                    "encrypted_dns_response_too_large",
                    "加密 DNS 响应超过安全上限",
                    retryable=True,
                    proxy_fault=True,
                )
        body = bytearray()
        for chunk in response.iter_content(chunk_size=8192):
            if not chunk:
                continue
            body.extend(chunk)
            if len(body) > self.max_response_bytes:
                raise EncryptedDNSError(
                    "encrypted_dns_response_too_large",
                    "加密 DNS 响应超过安全上限",
                    retryable=True,
                    proxy_fault=True,
                )
        return bytes(body)

    @staticmethod
    def _parse_payload(
        body: bytes,
        query_type: int,
        hostname: str,
    ) -> list[str]:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 返回了无效 JSON",
                retryable=True,
                proxy_fault=True,
            ) from exc
        if not isinstance(payload, dict):
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 返回结构无效",
                retryable=True,
                proxy_fault=True,
            )
        status = payload.get("Status")
        if isinstance(status, bool) or not isinstance(status, int):
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 缺少有效状态码",
                retryable=True,
                proxy_fault=True,
            )
        if status == 3:
            raise EncryptedDNSError(
                "encrypted_dns_nxdomain",
                "加密 DNS 明确返回目标域名不存在",
                retryable=False,
                proxy_fault=False,
            )
        if status != 0:
            raise EncryptedDNSError(
                "encrypted_dns_status_error",
                "加密 DNS 返回了域名状态错误",
                retryable=True,
                proxy_fault=True,
            )
        if payload.get("TC") is True:
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 返回了截断响应",
                retryable=True,
                proxy_fault=True,
            )
        questions = payload.get("Question")
        question_matches = False
        if isinstance(questions, list):
            for item in questions:
                if not isinstance(item, dict) or item.get("type") != query_type:
                    continue
                try:
                    question_name = _normalized_hostname(item.get("name") or "")
                except ValueError:
                    continue
                if question_name == hostname:
                    question_matches = True
                    break
        if not question_matches:
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 问题结构无效",
                retryable=True,
                proxy_fault=True,
            )
        answers = payload.get("Answer", [])
        if answers is None:
            answers = []
        if not isinstance(answers, list):
            raise EncryptedDNSError(
                "encrypted_dns_protocol",
                "加密 DNS 应答结构无效",
                retryable=True,
                proxy_fault=True,
            )
        cname_targets: dict[str, str] = {}
        address_records: list[tuple[str, Any]] = []
        for answer in answers:
            if not isinstance(answer, dict):
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 应答记录无效",
                    retryable=True,
                    proxy_fault=True,
                )
            record_type = answer.get("type")
            if record_type not in {5, query_type}:
                continue
            try:
                owner = _normalized_dns_record_name(answer.get("name"))
            except ValueError as exc:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 记录名称无效",
                    retryable=True,
                    proxy_fault=True,
                ) from exc
            if record_type == 5:
                try:
                    target = _normalized_dns_record_name(answer.get("data"))
                except ValueError as exc:
                    raise EncryptedDNSError(
                        "encrypted_dns_protocol",
                        "加密 DNS CNAME 记录无效",
                        retryable=True,
                        proxy_fault=True,
                    ) from exc
                previous = cname_targets.setdefault(owner, target)
                if previous != target:
                    raise EncryptedDNSError(
                        "encrypted_dns_protocol",
                        "加密 DNS CNAME 链存在冲突",
                        retryable=True,
                        proxy_fault=True,
                    )
                continue
            address_records.append((owner, answer.get("data")))

        reachable = {hostname}
        final_owner = hostname
        for _hop in range(_MAX_CNAME_HOPS):
            target = cname_targets.get(final_owner)
            if target is None:
                break
            if target in reachable:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS CNAME 链存在环",
                    retryable=True,
                    proxy_fault=True,
                )
            reachable.add(target)
            final_owner = target
        else:
            if final_owner in cname_targets:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS CNAME 链超过安全跳数",
                    retryable=True,
                    proxy_fault=True,
                )

        addresses: list[str] = []
        for owner, data in address_records:
            if owner != final_owner:
                continue
            if not isinstance(data, str) or not data.strip():
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 地址记录无效",
                    retryable=True,
                    proxy_fault=True,
                )
            try:
                address = ipaddress.ip_address(data.strip())
            except ValueError as exc:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 地址记录无效",
                    retryable=True,
                    proxy_fault=True,
                ) from exc
            expected_version = 4 if query_type == 1 else 6
            if address.version != expected_version:
                raise EncryptedDNSError(
                    "encrypted_dns_protocol",
                    "加密 DNS 地址记录类型不匹配",
                    retryable=True,
                    proxy_fault=True,
                )
            addresses.append(address.compressed)
        return addresses

    def resolve(self, hostname: str, *, proxy_url: str) -> tuple[str, ...]:
        if not self.enabled:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理模式需要启用加密 DNS，已拒绝回退本机明文 DNS",
                retryable=False,
                proxy_fault=False,
            )
        try:
            host = _normalized_hostname(hostname)
        except ValueError as exc:
            raise EncryptedDNSError(
                "invalid_network_target",
                "加密 DNS 目标主机名无效",
                retryable=False,
                proxy_fault=False,
            ) from exc
        if not str(proxy_url or "").strip():
            raise EncryptedDNSError(
                "proxy_dns_failed",
                "代理模式缺少可用租约，已拒绝回退本机明文 DNS",
                retryable=False,
                proxy_fault=False,
            )
        session = self._session_factory()
        session.trust_env = False
        proxies = {"http": proxy_url, "https": proxy_url}
        addresses: list[str] = []
        try:
            for query_name, query_type in _DOH_QUERY_TYPES:
                response: requests.Response | None = None
                try:
                    response = session.get(
                        self.endpoint,
                        params={"name": host, "type": query_name},
                        headers={"Accept": "application/dns-json"},
                        proxies=proxies,
                        timeout=self.timeout_seconds,
                        allow_redirects=False,
                        stream=True,
                        verify=True,
                    )
                    status_code = int(getattr(response, "status_code", 0) or 0)
                    if 300 <= status_code < 400:
                        raise EncryptedDNSError(
                            "encrypted_dns_redirect",
                            "加密 DNS 返回了未接受的重定向",
                            retryable=True,
                            proxy_fault=True,
                        )
                    if status_code < 200 or status_code >= 400:
                        raise EncryptedDNSError(
                            "encrypted_dns_http_error",
                            "加密 DNS 服务返回了 HTTP 错误",
                            retryable=True,
                            proxy_fault=True,
                        )
                    body = self._read_body(response)
                    addresses.extend(
                        self._parse_payload(body, query_type, host)
                    )
                finally:
                    if response is not None:
                        response.close()
        except EncryptedDNSError:
            raise
        except requests.exceptions.SSLError as exc:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理节点的加密 DNS TLS 连接失败",
                retryable=True,
                proxy_fault=True,
            ) from exc
        except requests.exceptions.Timeout as exc:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理节点的加密 DNS 请求超时",
                retryable=True,
                proxy_fault=True,
            ) from exc
        except requests.exceptions.ProxyError as exc:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理节点无法连接加密 DNS 服务",
                retryable=True,
                proxy_fault=True,
            ) from exc
        except requests.exceptions.ConnectionError as exc:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理节点的加密 DNS 连接失败",
                retryable=True,
                proxy_fault=True,
            ) from exc
        except requests.exceptions.RequestException as exc:
            raise EncryptedDNSError(
                "encrypted_dns_unavailable",
                "代理节点的加密 DNS 请求失败",
                retryable=True,
                proxy_fault=True,
            ) from exc
        finally:
            session.close()
        if not addresses:
            raise EncryptedDNSError(
                "encrypted_dns_no_answer",
                "加密 DNS 的 A/AAAA 查询均未返回地址",
                retryable=False,
                proxy_fault=False,
            )
        return tuple(addresses)


class NetworkTargetValidator:
    """按连接模式选择本机严格 DNS 或代理租约内 DoH，绝不自动降级。"""

    def __init__(
        self,
        *,
        allow_private_targets: bool,
        strict_target_dns: bool,
        encrypted_dns: EncryptedDNSResolver,
        proxy_doh_cache_ttl_seconds: float = DEFAULT_PROXY_DOH_CACHE_TTL_SECONDS,
        proxy_doh_cache_max_entries: int = DEFAULT_PROXY_DOH_CACHE_MAX_ENTRIES,
        monotonic_clock: Callable[[], float] | None = None,
    ) -> None:
        cache_ttl = float(proxy_doh_cache_ttl_seconds)
        cache_max_entries = int(proxy_doh_cache_max_entries)
        if not math.isfinite(cache_ttl) or cache_ttl < 0:
            raise ValueError("代理 DoH 缓存 TTL 必须是非负有限秒数")
        if cache_max_entries < 0:
            raise ValueError("代理 DoH 缓存容量不能为负数")
        self.allow_private_targets = bool(allow_private_targets)
        self.strict_target_dns = bool(strict_target_dns)
        self.encrypted_dns = encrypted_dns
        # 此缓存只服务于创建批次前的短暂预校验回退；它不参与实际连接。
        self._proxy_doh_cache_ttl_seconds = cache_ttl
        self._proxy_doh_cache_max_entries = cache_max_entries
        self._monotonic_clock = monotonic_clock or time.monotonic
        self._proxy_doh_cache_lock = threading.RLock()
        self._proxy_doh_cache: dict[str, _ProxyDoHCacheEntry] = {}

    def _drop_expired_proxy_doh_cache_entries_locked(self, now: float) -> None:
        for hostname, entry in tuple(self._proxy_doh_cache.items()):
            if entry.expires_at <= now:
                self._proxy_doh_cache.pop(hostname, None)

    def _store_proxy_doh_cache_entry(
        self,
        hostname: str,
        addresses: tuple[str, ...],
    ) -> None:
        with self._proxy_doh_cache_lock:
            now = float(self._monotonic_clock())
            self._drop_expired_proxy_doh_cache_entries_locked(now)
            if (
                self._proxy_doh_cache_ttl_seconds <= 0
                or self._proxy_doh_cache_max_entries <= 0
            ):
                self._proxy_doh_cache.clear()
                return
            self._proxy_doh_cache[hostname] = _ProxyDoHCacheEntry(
                expires_at=now + self._proxy_doh_cache_ttl_seconds,
                addresses=addresses,
            )
            while len(self._proxy_doh_cache) > self._proxy_doh_cache_max_entries:
                # TTL 相同的条目按 hostname 打破平局，保证测试和行为可预测。
                evicted_hostname = min(
                    self._proxy_doh_cache.items(),
                    key=lambda item: (item[1].expires_at, item[0]),
                )[0]
                self._proxy_doh_cache.pop(evicted_hostname, None)

    def validate_proxy_cache_fallback(self, url: str) -> bool:
        """只为创建批次预校验确认旧的代理 DoH 公网结果仍可用。

        这个方法不发起 DoH、不会申请代理租约，且永远不返回缓存 IP，避免
        调用方把 URL 改写成地址。静态校验使用最严格的公网策略，不能借服务
        的 allow_private/strict 配置放行本机、私网或 IP literal。
        """
        try:
            target = validate_network_target_syntax(url, False)
        except ValueError:
            return False
        if target.literal_ip is not None:
            return False
        with self._proxy_doh_cache_lock:
            now = float(self._monotonic_clock())
            self._drop_expired_proxy_doh_cache_entries_locked(now)
            entry = self._proxy_doh_cache.get(target.hostname)
            if entry is None:
                return False
            try:
                # 即使写入路径已验证，也在读取时复验，避免未来内部变更把
                # 非公网地址作为可放行缓存留下。
                validate_resolved_addresses(
                    entry.addresses,
                    allow_private=False,
                    strict=True,
                )
            except ValueError:
                self._proxy_doh_cache.pop(target.hostname, None)
                return False
            return True

    def validate_static(self, url: str) -> NetworkTarget:
        return validate_network_target_syntax(url, self.allow_private_targets)

    def validate_direct(self, url: str) -> tuple[str, ...]:
        target = self.validate_static(url)
        if self.allow_private_targets:
            return (
                (target.literal_ip.compressed,)
                if target.literal_ip is not None
                else ()
            )
        return validate_direct_network_target(
            url,
            False,
            strict=self.strict_target_dns,
        )

    def validate_proxy(self, url: str, lease: Any) -> tuple[str, ...]:
        try:
            target = self.validate_static(url)
        except ValueError as exc:
            raise EncryptedDNSError(
                "invalid_network_target",
                str(exc),
                retryable=False,
                proxy_fault=False,
            ) from exc
        proxy_url = str(getattr(lease, "endpoint", "") or "").strip()
        if not proxy_url:
            raise EncryptedDNSError(
                "proxy_dns_failed",
                "代理模式缺少可用租约，已拒绝回退本机明文 DNS",
                retryable=False,
                proxy_fault=False,
            )
        if target.literal_ip is not None:
            addresses = (target.literal_ip.compressed,)
        else:
            addresses = self.encrypted_dns.resolve(
                target.hostname,
                proxy_url=proxy_url,
            )
        try:
            validated = validate_resolved_addresses(
                addresses,
                allow_private=self.allow_private_targets,
                strict=self.strict_target_dns,
            )
        except ValueError as exc:
            raise EncryptedDNSError(
                "invalid_network_target",
                "加密 DNS 返回了不允许的目标地址，已拒绝连接",
                retryable=False,
                proxy_fault=False,
            ) from exc
        if target.literal_ip is None:
            try:
                # 即使运行时配置允许私网，缓存 key 本身也必须是可由最严格
                # 静态策略接受的公网 hostname；localhost/.local 不保留条目。
                cache_target = validate_network_target_syntax(url, False)
            except ValueError:
                return validated
            try:
                cache_addresses = validate_resolved_addresses(
                    addresses,
                    allow_private=False,
                    strict=True,
                )
            except ValueError:
                # 服务策略可显式允许私网或宽松 DNS；该结果仍绝不能进入
                # 创建批次的公网 DoH 回退缓存。
                pass
            else:
                self._store_proxy_doh_cache_entry(
                    cache_target.hostname,
                    cache_addresses,
                )
        return validated
