from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .file_security import ensure_private_directory
from .site_policy import (
    DEFAULT_EDITABLE_SITE_POLICY,
    EDITABLE_SITE_POLICY_FIELDS,
    EditableSitePolicy,
)


PROJECT_DIR = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = PROJECT_DIR.parent

AUTH_PROXY_SCHEMES = ("http", "https", "socks4", "socks5", "socks5h")


def normalize_authorization_proxy(value: Any) -> str:
    """校验并规范化授权专用代理地址；空值表示直连，非法值抛 ValueError。

    同一个地址会同时交给 Chrome（--proxy-server）和 gallery-dl（-o proxy=），
    所以这里只接受两边都能消费的形态：scheme://[user:pass@]host:port。
    """
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) > 300:
        raise ValueError("代理地址过长")
    if any(ord(char) <= 32 or ord(char) == 127 for char in text):
        raise ValueError("代理地址包含空白或控制字符")
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise ValueError("代理地址无法解析") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in AUTH_PROXY_SCHEMES:
        raise ValueError("仅支持 http/https/socks4/socks5/socks5h 代理，例如 http://127.0.0.1:7890")
    try:
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("代理主机或端口无效") from exc
    if not hostname:
        raise ValueError("代理地址缺少主机名")
    if port is None:
        raise ValueError("代理地址需要显式端口，例如 http://127.0.0.1:7890")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("代理地址不能包含路径或查询参数")
    if scheme.startswith("socks") and (parsed.username or parsed.password):
        raise ValueError("Chrome 不支持带账号密码的 SOCKS 代理，请改用 HTTP 代理或去掉凭证")
    userinfo = ""
    if parsed.username is not None:
        userinfo = parsed.username
        if parsed.password is not None:
            userinfo += f":{parsed.password}"
        userinfo += "@"
    host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{scheme}://{userinfo}{host}:{port}"


def _path(value: str | os.PathLike[str] | None, base: Path, default: Path) -> Path:
    if value in (None, ""):
        path = default
    else:
        path = Path(os.path.expandvars(os.path.expanduser(str(value))))
        if not path.is_absolute():
            path = base / path
    return path.resolve()


def _managed_path(
    value: str | os.PathLike[str] | None,
    base: Path,
    default: Path,
) -> Path:
    """规范化应用管理路径但不解引用叶节点，供创建前检查符号链接。"""
    path = default if value in (None, "") else Path(
        os.path.expandvars(os.path.expanduser(str(value)))
    )
    if not path.is_absolute():
        path = base / path
    return Path(os.path.abspath(os.fspath(path)))


def _executable_path(
    value: str | os.PathLike[str] | None,
    base: Path,
    default: Path,
) -> Path:
    """规范化解释器路径，但不解引用 venv 的 python 符号链接。"""
    path = default if value in (None, "") else Path(
        os.path.expandvars(os.path.expanduser(str(value)))
    )
    if not path.is_absolute():
        path = base / path
    return Path(os.path.abspath(os.fspath(path)))


def _paths(values: list[str] | None, base: Path, defaults: list[Path]) -> list[Path]:
    if not values:
        return [p.resolve() for p in defaults]
    # 丢弃空项，避免 _path("") 意外把配置目录扩成许可根目录。
    cleaned = [value for value in values if str(value).strip()]
    if not cleaned:
        return [p.resolve() for p in defaults]
    return [_path(value, base, base) for value in cleaned]


def _allowed_node_roots(values: Any, base: Path) -> list[Path]:
    """规范化 WebUI 节点文件许可根目录，同时拒绝空项和过宽根目录。"""

    if values is None:
        values = ["../subscriptions"]
    if not isinstance(values, (list, tuple)):
        raise ValueError("proxy.allowed_node_roots 必须是路径列表")
    normalized: list[Path] = []
    broad_roots = {
        Path(os.path.abspath(os.fspath(base))),
        Path(os.path.abspath(os.fspath(PROJECT_DIR))),
        Path(os.path.abspath(os.fspath(WORKSPACE_DIR))),
    }
    for value in values:
        if not isinstance(value, (str, os.PathLike)) or not str(value).strip():
            raise ValueError("proxy.allowed_node_roots 不能包含空路径")
        root = _managed_path(value, base, base)
        if root == Path(root.anchor) or root in broad_roots:
            raise ValueError("proxy.allowed_node_roots 不能指向过宽的项目或文件系统根目录")
        if root not in normalized:
            normalized.append(root)
    return normalized


@dataclass(slots=True)
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 8787
    cors_origins: list[str] = field(default_factory=list)
    allow_private_targets: bool = False
    strict_target_dns: bool = True


@dataclass(slots=True)
class GallerySettings:
    repo_path: Path = field(default_factory=lambda: (WORKSPACE_DIR / "gallery-dl-codeberg").resolve())
    cache_file: Path = field(
        default_factory=lambda: (PROJECT_DIR / "credentials" / "managed" / "gallery-dl-cache.sqlite3").resolve()
    )
    python_executable: str = sys.executable
    migrate_default_auth: bool = True
    default_http_timeout: float = 30.0
    default_retries: int = 2
    terminate_grace_seconds: float = 5.0
    max_log_line_chars: int = 4000
    forbidden_args: list[str] = field(
        default_factory=lambda: [
            "--proxy",
            "--destination",
            "--directory",
            "--config-ignore",
            "--ignore-config",
            "--server",
            "--write-log",
            "--input-file",
            "--exec",
            "--exec-after",
            "--option",
            "--config",
            "--config-json",
            "--config-yaml",
            "--config-toml",
            "--cookies",
            "--cookies-export",
            "--cookies-from-browser",
            "--cache-file",
            "--username",
            "--password",
            "-d",
            "-D",
            "-S",
            "-o",
            "-c",
            "-C",
            "-u",
            "-p",
        ]
    )


@dataclass(slots=True)
class AuthSettings:
    chrome_executable: str = ""
    browser_login_timeout_seconds: float = 900.0
    browser_poll_interval_seconds: float = 1.0
    # 授权专用代理：X/Pixiv/EH 登录授权全程（共享 Chrome 页面流量 + Pixiv token 交换）
    # 走这个地址；与抓取用的代理池互不影响。空字符串 = 直连。
    authorization_proxy: str = ""


@dataclass(slots=True)
class ProxySettings:
    enabled: bool = True
    auto_start: bool = True
    engine: str = "native"
    subscription_urls: list[str] = field(default_factory=list)
    node_file: Path | None = None
    inline_nodes: list[str] = field(default_factory=list)
    allowed_node_roots: list[Path] = field(
        default_factory=lambda: [(WORKSPACE_DIR / "subscriptions").resolve()]
    )
    allow_socks: bool = True
    probe_url: str = "https://example.com/"
    probe_timeout_seconds: float = 10.0
    probe_workers: int = 32
    probe_cache_ttl_seconds: float = 600.0
    health_interval_seconds: float = 60.0
    fail_cooldown_seconds: float = 30.0
    subscription_timeout_seconds: float = 20.0
    transport_core_enabled: bool = True
    transport_core_binary: Path | None = None
    transport_core_sha256: str = ""
    transport_core_base_port: int = 29000
    transport_core_start_timeout_seconds: float = 15.0


@dataclass(slots=True)
class SchedulerSettings:
    max_concurrent_tasks: int = 20
    poll_interval_seconds: float = 0.5
    shutdown_grace_seconds: float = 15.0
    max_logs_per_task: int = 5000
    retry_jitter_seconds: float = 0.5
    retry_backoff_cap_seconds: float = 300.0


def _default_dedup_python() -> Path:
    relative = Path("Scripts/python.exe") if os.name == "nt" else Path("bin/python")
    return Path(os.path.abspath(WORKSPACE_DIR / ".venv" / relative))


@dataclass(slots=True)
class DedupSettings:
    enabled: bool = True
    python_executable: Path = field(default_factory=_default_dedup_python)
    worker_script: Path = field(default_factory=lambda: (WORKSPACE_DIR / "dedup_review_worker.py").resolve())
    core_script: Path = field(default_factory=lambda: (WORKSPACE_DIR / "dedup_core.py").resolve())
    model_dir: Path = field(default_factory=lambda: (WORKSPACE_DIR / ".models").resolve())
    device: str = "auto"
    # 0 表示由 worker 根据设备和 CPU 数量选择；显式正整数始终覆盖 profile。
    workers: int = 0
    torch_threads: int = 0
    torch_interop_threads: int = 0
    deep_batch_size: int = 0
    neighbor_block_size: int = 0
    poll_interval_seconds: float = 1.0
    shutdown_grace_seconds: float = 10.0
    no_sscd: bool = False
    no_dino: bool = False


DEFAULT_SITE_POLICY: dict[str, Any] = dict(DEFAULT_EDITABLE_SITE_POLICY)


def _editable_default_site_policy(value: Any) -> dict[str, Any]:
    """只采用 default_site_policy 中仍属于产品设置的四个字段。"""

    if value is None:
        raw: dict[str, Any] = {}
    elif isinstance(value, dict):
        raw = value
    else:
        raise ValueError("default_site_policy 必须是对象")
    projected = {
        field: raw[field]
        for field in EDITABLE_SITE_POLICY_FIELDS
        if field in raw
    }
    return EditableSitePolicy.model_validate(
        {**DEFAULT_EDITABLE_SITE_POLICY, **projected}
    ).model_dump()


@dataclass(slots=True)
class AppSettings:
    project_dir: Path = PROJECT_DIR
    workspace_dir: Path = WORKSPACE_DIR
    runtime_dir: Path = field(default_factory=lambda: (PROJECT_DIR / "runtime").resolve())
    database_path: Path = field(default_factory=lambda: (PROJECT_DIR / "runtime" / "backend.sqlite3").resolve())
    default_output_root: Path = field(default_factory=lambda: (PROJECT_DIR / "runtime" / "downloads").resolve())
    allowed_output_roots: list[Path] = field(default_factory=lambda: [(PROJECT_DIR / "runtime" / "downloads").resolve()])
    allowed_config_roots: list[Path] = field(default_factory=lambda: [(PROJECT_DIR / "credentials").resolve()])
    allowed_cookie_roots: list[Path] = field(default_factory=lambda: [(PROJECT_DIR / "credentials").resolve()])
    server: ServerSettings = field(default_factory=ServerSettings)
    gallery: GallerySettings = field(default_factory=GallerySettings)
    auth: AuthSettings = field(default_factory=AuthSettings)
    proxy: ProxySettings = field(default_factory=ProxySettings)
    scheduler: SchedulerSettings = field(default_factory=SchedulerSettings)
    dedup: DedupSettings = field(default_factory=DedupSettings)
    default_site_policy: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_SITE_POLICY))
    config_path: Path | None = None

    @classmethod
    def load(cls, path: str | os.PathLike[str] | None = None) -> "AppSettings":
        requested = path or os.environ.get("GDL_BACKEND_CONFIG")
        config_path = Path(requested).expanduser().resolve() if requested else (PROJECT_DIR / "config.json")
        data: dict[str, Any] = {}
        if config_path.is_file():
            data = json.loads(config_path.read_text(encoding="utf-8"))
        base = config_path.parent if config_path else PROJECT_DIR

        runtime = _managed_path(data.get("runtime_dir"), base, PROJECT_DIR / "runtime")
        database = _managed_path(data.get("database_path"), base, runtime / "backend.sqlite3")
        output_root = _managed_path(data.get("default_output_root"), base, runtime / "downloads")

        server_data = dict(data.get("server") or {})
        gallery_data = dict(data.get("gallery") or {})
        auth_data = dict(data.get("auth") or {})
        proxy_data = dict(data.get("proxy") or {})
        scheduler_data = dict(data.get("scheduler") or {})
        dedup_data = dict(data.get("dedup") or {})

        server = ServerSettings(
            host=str(os.environ.get("GDL_BACKEND_HOST", server_data.get("host", "127.0.0.1"))),
            port=int(os.environ.get("GDL_BACKEND_PORT", server_data.get("port", 8787))),
            cors_origins=[str(x) for x in server_data.get("cors_origins", [])],
            allow_private_targets=bool(server_data.get("allow_private_targets", False)),
            strict_target_dns=server_data.get("strict_target_dns", True),
        )
        gallery = GallerySettings(
            repo_path=_path(gallery_data.get("repo_path"), base, WORKSPACE_DIR / "gallery-dl-codeberg"),
            cache_file=_managed_path(
                gallery_data.get("cache_file"),
                base,
                PROJECT_DIR / "credentials" / "managed" / "gallery-dl-cache.sqlite3",
            ),
            python_executable=str(gallery_data.get("python_executable") or sys.executable),
            migrate_default_auth=bool(gallery_data.get("migrate_default_auth", True)),
            default_http_timeout=float(gallery_data.get("default_http_timeout", 30.0)),
            default_retries=int(gallery_data.get("default_retries", 2)),
            terminate_grace_seconds=float(gallery_data.get("terminate_grace_seconds", 5.0)),
            max_log_line_chars=int(gallery_data.get("max_log_line_chars", 4000)),
            forbidden_args=[str(x) for x in gallery_data.get("forbidden_args", GallerySettings().forbidden_args)],
        )
        auth = AuthSettings(
            chrome_executable=str(auth_data.get("chrome_executable") or ""),
            browser_login_timeout_seconds=float(
                auth_data.get("browser_login_timeout_seconds", 900.0)
            ),
            browser_poll_interval_seconds=float(
                auth_data.get("browser_poll_interval_seconds", 1.0)
            ),
            authorization_proxy=str(auth_data.get("authorization_proxy") or "").strip(),
        )
        node_file_value = proxy_data.get("node_file")
        transport_core_binary_value = proxy_data.get("transport_core_binary")
        if transport_core_binary_value in (None, ""):
            transport_core_binary = None
        else:
            transport_core_binary = _path(transport_core_binary_value, base, base)
        transport_core_sha256 = str(proxy_data.get("transport_core_sha256") or "").strip().lower()
        proxy = ProxySettings(
            enabled=bool(proxy_data.get("enabled", True)),
            auto_start=bool(proxy_data.get("auto_start", True)),
            engine=str(proxy_data.get("engine", "native")).strip().lower(),
            subscription_urls=[str(x).strip() for x in proxy_data.get("subscription_urls", []) if str(x).strip()],
            node_file=_path(node_file_value, base, base) if node_file_value else None,
            inline_nodes=[str(x).strip() for x in proxy_data.get("inline_nodes", []) if str(x).strip()],
            allowed_node_roots=_allowed_node_roots(
                proxy_data.get("allowed_node_roots"), base
            ),
            allow_socks=bool(proxy_data.get("allow_socks", True)),
            probe_url=str(proxy_data.get("probe_url", "https://example.com/")),
            probe_timeout_seconds=float(proxy_data.get("probe_timeout_seconds", 10.0)),
            probe_workers=int(proxy_data.get("probe_workers", 32)),
            probe_cache_ttl_seconds=float(
                proxy_data.get("probe_cache_ttl_seconds", 600.0)
            ),
            health_interval_seconds=float(proxy_data.get("health_interval_seconds", 60.0)),
            fail_cooldown_seconds=float(proxy_data.get("fail_cooldown_seconds", 30.0)),
            subscription_timeout_seconds=float(proxy_data.get("subscription_timeout_seconds", 20.0)),
            transport_core_enabled=bool(proxy_data.get("transport_core_enabled", True)),
            transport_core_binary=transport_core_binary,
            transport_core_sha256=transport_core_sha256,
            transport_core_base_port=int(proxy_data.get("transport_core_base_port", 29000)),
            transport_core_start_timeout_seconds=float(
                proxy_data.get("transport_core_start_timeout_seconds", 15.0)
            ),
        )
        scheduler = SchedulerSettings(
            max_concurrent_tasks=max(1, int(scheduler_data.get("max_concurrent_tasks", 20))),
            poll_interval_seconds=max(0.1, float(scheduler_data.get("poll_interval_seconds", 0.5))),
            shutdown_grace_seconds=max(1.0, float(scheduler_data.get("shutdown_grace_seconds", 15.0))),
            max_logs_per_task=max(100, int(scheduler_data.get("max_logs_per_task", 5000))),
            retry_jitter_seconds=max(0.0, float(scheduler_data.get("retry_jitter_seconds", 0.5))),
            retry_backoff_cap_seconds=max(
                1.0, float(scheduler_data.get("retry_backoff_cap_seconds", 300.0))
            ),
        )
        dedup = DedupSettings(
            enabled=bool(dedup_data.get("enabled", True)),
            python_executable=_executable_path(
                dedup_data.get("python_executable"),
                base,
                _default_dedup_python(),
            ),
            worker_script=_path(
                dedup_data.get("worker_script"),
                base,
                WORKSPACE_DIR / "dedup_review_worker.py",
            ),
            core_script=_path(
                dedup_data.get("core_script"),
                base,
                WORKSPACE_DIR / "dedup_core.py",
            ),
            model_dir=_managed_path(
                dedup_data.get("model_dir"),
                base,
                WORKSPACE_DIR / ".models",
            ),
            device=str(dedup_data.get("device", "auto")).strip().lower(),
            workers=max(0, int(dedup_data.get("workers", 0) or 0)),
            torch_threads=max(0, int(dedup_data.get("torch_threads", 0) or 0)),
            torch_interop_threads=max(
                0, int(dedup_data.get("torch_interop_threads", 0) or 0)
            ),
            deep_batch_size=max(0, int(dedup_data.get("deep_batch_size", 0) or 0)),
            neighbor_block_size=max(
                0, int(dedup_data.get("neighbor_block_size", 0) or 0)
            ),
            poll_interval_seconds=max(0.1, float(dedup_data.get("poll_interval_seconds", 1.0))),
            shutdown_grace_seconds=max(1.0, float(dedup_data.get("shutdown_grace_seconds", 10.0))),
            no_sscd=bool(dedup_data.get("no_sscd", False)),
            no_dino=bool(dedup_data.get("no_dino", False)),
        )

        policy = _editable_default_site_policy(data.get("default_site_policy"))
        settings = cls(
            runtime_dir=runtime,
            database_path=database,
            default_output_root=output_root,
            allowed_output_roots=_paths(data.get("allowed_output_roots"), base, [output_root]),
            allowed_config_roots=_paths(data.get("allowed_config_roots"), base, [PROJECT_DIR / "credentials"]),
            allowed_cookie_roots=_paths(data.get("allowed_cookie_roots"), base, [PROJECT_DIR / "credentials"]),
            server=server,
            gallery=gallery,
            auth=auth,
            proxy=proxy,
            scheduler=scheduler,
            dedup=dedup,
            default_site_policy=policy,
            config_path=config_path if config_path.is_file() else None,
        )
        settings.ensure_directories()
        settings.validate()
        return settings

    def validate(self) -> None:
        # 程序化构造的 Settings 也走同一四字段投影；旧高级键不能改变运行时。
        self.default_site_policy = _editable_default_site_policy(
            self.default_site_policy
        )
        if not 1 <= int(self.server.port) <= 65535:
            raise ValueError("server.port 超出范围")
        if not isinstance(self.server.strict_target_dns, bool):
            raise ValueError("server.strict_target_dns 必须是布尔值")
        if not self.server.strict_target_dns:
            print(
                "警告：server.strict_target_dns=false，目标 DNS 校验已降级；"
                "仅应在确认合法站点被误拒时使用。",
                file=sys.stderr,
            )
        host = self.server.host.strip().lower()
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("本地服务仅允许监听回环地址")
        if self.proxy.engine != "native":
            raise ValueError("proxy.engine 当前支持 native")
        node_root_base = self.config_path.parent if self.config_path is not None else self.project_dir
        self.proxy.allowed_node_roots = _allowed_node_roots(
            self.proxy.allowed_node_roots,
            node_root_base,
        )
        if self.auth.browser_login_timeout_seconds <= 0:
            raise ValueError("auth.browser_login_timeout_seconds 必须大于 0")
        if self.auth.browser_poll_interval_seconds <= 0:
            raise ValueError("auth.browser_poll_interval_seconds 必须大于 0")
        try:
            self.auth.authorization_proxy = normalize_authorization_proxy(
                self.auth.authorization_proxy
            )
        except ValueError as exc:
            raise ValueError(f"auth.authorization_proxy 无效: {exc}") from exc
        if not 1 <= int(self.proxy.probe_workers) <= 64:
            raise ValueError("proxy.probe_workers 必须位于 1..64")
        if not self.proxy.probe_cache_ttl_seconds >= 0:
            raise ValueError("proxy.probe_cache_ttl_seconds 必须大于等于 0")
        if self.proxy.probe_timeout_seconds <= 0 or self.proxy.subscription_timeout_seconds <= 0:
            raise ValueError("代理超时必须大于 0")
        if self.proxy.health_interval_seconds <= 0:
            raise ValueError("proxy.health_interval_seconds 必须大于 0")
        if self.proxy.fail_cooldown_seconds <= 0:
            raise ValueError("proxy.fail_cooldown_seconds 必须大于 0")
        if not 1024 <= int(self.proxy.transport_core_base_port) <= 65000:
            raise ValueError("proxy.transport_core_base_port 必须位于 1024..65000")
        if self.proxy.transport_core_start_timeout_seconds <= 0:
            raise ValueError("proxy.transport_core_start_timeout_seconds 必须大于 0")
        if self.dedup.device not in {"auto", "cpu", "cuda"}:
            raise ValueError("dedup.device 必须是 auto、cpu 或 cuda")
        resource_limits = {
            "dedup.workers": (self.dedup.workers, 64),
            "dedup.torch_threads": (self.dedup.torch_threads, 128),
            "dedup.torch_interop_threads": (self.dedup.torch_interop_threads, 16),
            "dedup.deep_batch_size": (self.dedup.deep_batch_size, 128),
            "dedup.neighbor_block_size": (self.dedup.neighbor_block_size, 8192),
        }
        for name, (value, maximum) in resource_limits.items():
            if not 0 <= value <= maximum:
                raise ValueError(f"{name} 必须是 0（自动）或 1..{maximum}")
        if self.dedup.poll_interval_seconds <= 0 or self.dedup.shutdown_grace_seconds <= 0:
            raise ValueError("去重轮询与退出等待时间必须大于 0")
        digest = self.proxy.transport_core_sha256
        if digest and (len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest)):
            raise ValueError("proxy.transport_core_sha256 必须是 64 位十六进制 SHA-256")

    @staticmethod
    def _lexically_inside(path: Path, root: Path) -> bool:
        candidate = Path(os.path.abspath(os.fspath(path)))
        parent = Path(os.path.abspath(os.fspath(root)))
        return candidate == parent or candidate.is_relative_to(parent)

    def is_dedicated_credentials_directory(self, path: Path) -> bool:
        roots = [*self.allowed_config_roots, *self.allowed_cookie_roots]
        return any(
            self._lexically_inside(path, root)
            and Path(os.path.abspath(os.fspath(path))) != Path(os.path.abspath(os.fspath(root)))
            for root in roots
        )

    def ensure_directories(self) -> None:
        for path in (
            self.runtime_dir,
            self.runtime_dir / "logs",
            self.runtime_dir / "proxy",
        ):
            ensure_private_directory(path)
        if self._lexically_inside(self.database_path.parent, self.runtime_dir):
            ensure_private_directory(self.database_path.parent)
        else:
            ensure_private_directory(self.database_path.parent, repair_existing=False)
        if self.is_dedicated_credentials_directory(self.gallery.cache_file.parent):
            ensure_private_directory(self.gallery.cache_file.parent)
        else:
            ensure_private_directory(
                self.gallery.cache_file.parent,
                repair_existing=False,
            )
        # 默认 runtime/downloads 属于应用管理路径；显式外部输出目录不做 chmod。
        if self._lexically_inside(self.default_output_root, self.runtime_dir):
            ensure_private_directory(self.default_output_root)
        else:
            self.default_output_root.mkdir(parents=True, exist_ok=True)
        if self.dedup.enabled:
            ensure_private_directory(self.dedup.model_dir)

    @staticmethod
    def _inside(path: Path, roots: list[Path]) -> bool:
        resolved = path.resolve()
        return any(resolved == root.resolve() or resolved.is_relative_to(root.resolve()) for root in roots)

    def task_output_dir(self, value: str | None, task_id: str) -> Path:
        if value:
            candidate = Path(os.path.expandvars(os.path.expanduser(value)))
            if not candidate.is_absolute():
                candidate = self.default_output_root / candidate
        else:
            candidate = self.default_output_root / task_id
        try:
            candidate = candidate.resolve()
        except OSError as exc:
            # Windows raises OSError (WinError 123) on illegal path chars like < > |;
            # the caller only maps ValueError to a 422, so translate to keep it out of 500s.
            raise ValueError("输出目录路径无效") from exc
        if not self._inside(candidate, self.allowed_output_roots):
            raise ValueError("输出目录超出 allowed_output_roots")
        try:
            if self._lexically_inside(candidate, self.runtime_dir):
                ensure_private_directory(candidate)
            else:
                # 用户显式外部输出目录保留其权限策略，不由应用盲目 chmod。
                candidate.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError, ValueError) as exc:
            raise ValueError("无法创建输出目录") from exc
        return candidate

    def allowed_file(self, value: str | None, roots: list[Path], label: str) -> Path | None:
        if not value:
            return None
        candidate = Path(os.path.expandvars(os.path.expanduser(value)))
        if not candidate.is_absolute():
            candidate = self.project_dir / candidate
        try:
            candidate = candidate.resolve()
        except OSError as exc:
            raise ValueError(f"{label}路径无效") from exc
        if not self._inside(candidate, roots):
            raise ValueError(f"{label}超出配置的许可目录")
        if not candidate.is_file():
            raise ValueError(f"{label}不存在或不是文件")
        return candidate

    def _public_authorization_proxy(self) -> str | None:
        value = self.auth.authorization_proxy
        if not value:
            return None
        parsed = urlsplit(value)
        if parsed.username is None:
            return value
        host = f"[{parsed.hostname}]" if parsed.hostname and ":" in parsed.hostname else parsed.hostname
        return f"{parsed.scheme}://***@{host}:{parsed.port}"

    def _public_proxy_path(self, path: Path | None) -> str | None:
        """代理配置只公开项目相对路径或文件名，不回显额外主机绝对路径。"""

        if path is None:
            return None
        candidate = Path(os.path.abspath(os.fspath(path)))
        for root in (self.project_dir, self.workspace_dir):
            parent = Path(os.path.abspath(os.fspath(root)))
            if candidate == parent or candidate.is_relative_to(parent):
                return candidate.relative_to(parent).as_posix() or candidate.name
        return candidate.name or "configured-path"

    def public_dict(self) -> dict[str, Any]:
        return {
            "runtime_dir": str(self.runtime_dir),
            "database_path": str(self.database_path),
            "default_output_root": str(self.default_output_root),
            "allowed_output_roots": [str(x) for x in self.allowed_output_roots],
            "server": {
                "host": self.server.host,
                "port": self.server.port,
                "cors_origins": list(self.server.cors_origins),
                "allow_private_targets": self.server.allow_private_targets,
                "strict_target_dns": self.server.strict_target_dns,
            },
            "gallery": {
                "repo_path": str(self.gallery.repo_path),
                "python_executable": self.gallery.python_executable,
                "default_http_timeout": self.gallery.default_http_timeout,
                "default_retries": self.gallery.default_retries,
                "managed_auth_cache": True,
            },
            "auth": {
                "managed_browser": True,
                "chrome_configured": bool(self.auth.chrome_executable.strip()),
                "browser_login_timeout_seconds": self.auth.browser_login_timeout_seconds,
                "browser_poll_interval_seconds": self.auth.browser_poll_interval_seconds,
                "authorization_proxy": self._public_authorization_proxy(),
            },
            "proxy": {
                "enabled": self.proxy.enabled,
                "auto_start": self.proxy.auto_start,
                "engine": self.proxy.engine,
                "subscription_count": len(self.proxy.subscription_urls),
                "node_file": self._public_proxy_path(self.proxy.node_file),
                "inline_node_count": len(self.proxy.inline_nodes),
                "allowed_node_roots": [
                    self._public_proxy_path(root) for root in self.proxy.allowed_node_roots
                ],
                "allow_socks": self.proxy.allow_socks,
                "probe_url": self.proxy.probe_url,
                "probe_timeout_seconds": self.proxy.probe_timeout_seconds,
                "probe_cache_ttl_seconds": self.proxy.probe_cache_ttl_seconds,
                "transport_core_enabled": self.proxy.transport_core_enabled,
                "transport_core_binary": (
                    str(self.proxy.transport_core_binary) if self.proxy.transport_core_binary else None
                ),
                "transport_core_sha256": self.proxy.transport_core_sha256,
                "transport_core_base_port": self.proxy.transport_core_base_port,
            },
            "scheduler": asdict(self.scheduler),
            "dedup": {
                "enabled": self.dedup.enabled,
                "python_executable": str(self.dedup.python_executable),
                "worker_script": str(self.dedup.worker_script),
                "core_script": str(self.dedup.core_script),
                "model_dir": str(self.dedup.model_dir),
                "device": self.dedup.device,
                "workers": self.dedup.workers,
                "torch_threads": self.dedup.torch_threads,
                "torch_interop_threads": self.dedup.torch_interop_threads,
                "deep_batch_size": self.dedup.deep_batch_size,
                "neighbor_block_size": self.dedup.neighbor_block_size,
                "no_sscd": self.dedup.no_sscd,
                "no_dino": self.dedup.no_dino,
            },
            "default_site_policy": dict(self.default_site_policy),
        }
