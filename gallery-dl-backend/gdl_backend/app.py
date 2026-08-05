from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import socket
import sqlite3
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .auth import (
    MAX_AUTH_PROXY_REQUEST_BYTES,
    AuthError,
    AuthManager,
    vault_safe_browser_profile,
    vault_safe_proxy_status,
    vault_safe_session,
    vault_safe_status,
    vault_safe_statuses,
)
from .config import AppSettings
from .crawl import CrawlPlanError, CrawlPlanner
from .database import Database, TERMINAL_STATUSES
from .diagnostics import (
    diagnostics_config_snapshot,
    diagnostics_scheduler_snapshot,
    readiness_snapshot,
)
from .discovery import (
    DiscoveryError,
    DiscoveryService,
    canonical_gallery_address,
    danbooru_alias_terms,
    discovery_addresses,
    exhentai_tag_facets,
    merge_alias_search_results,
    search_site,
    search_site_catalog,
    validate_discovery_args,
)
from .gallery import GalleryRunner
from .log_writer import TaskLogWriter
from .ordered_crawl import EnqueueBatchCancelled, OrderedCrawlManager
from .policy_view import (
    MAX_POLICY_REQUEST_BYTES,
    POLICY_RESPONSE_PROFILE,
    PolicyViewValidationError,
    is_policy_site,
    policy_view_item,
    policy_view_snapshot,
    safe_policy_dict,
)
from .proxy import ProxyPoolAdapter, ProxyPoolConflict, ProxyPoolError
from .proxy_source_store import (
    MAX_PROXY_SOURCE_REQUEST_BYTES,
    ManagedProxySourceStore,
    ProxySourceNotFound,
    ProxySourcePathForbidden,
    ProxySourceSnapshot,
    ProxySourceStoreConflict,
    ProxySourceStoreCorrupt,
    ProxySourceStoreError,
    ProxySourceValidationError,
)
from .redaction import redact_text
from .review import DedupReviewManager, resolve_review_file
from .scheduler import TaskScheduler
from .schemas import (
    AuthProxyUpdate,
    CrawlRerunRequest,
    CrawlRequest,
    ProxyInlineNodesCreate,
    ProxyInlineNodeUpdate,
    ProxyNodeFileUpdate,
    ProxyProbeRequest,
    ProxyStartRequest,
    ProxyStopRequest,
    ProxySubscriptionUpdate,
    RetryRequest,
    ReviewDecisions,
    SearchRequest,
    SitePolicy,
    TaskCreate,
    TaskPolicy,
    build_runtime_site_policy,
)
from .site_policy import EDITABLE_SITE_POLICY_FIELDS, EditableSitePolicy
from .site import SiteInfo, SiteResolver

# How long an EH/Pawchive search waits for the shared Danbooru artist-directory
# lookup before proceeding without alias expansion.  The lookup keeps running
# for the danbooru source itself, which awaits it in full.
_ALIAS_LOOKUP_WAIT_SECONDS = 30.0

_search_logger = logging.getLogger("gdl_backend.search")
AuthResponseView = Literal["legacy", "vault"]
PolicyResponseView = Literal["legacy", "policy"]
DiagnosticsResponseView = Literal["legacy", "diagnostics"]

# VAULT profile 可以保留后端定义的受控错误码，但绝不透传任意错误码、消息或 details。
_VAULT_SAFE_AUTH_ERROR_CODES = frozenset(
    {
        "unsupported_auth_site",
        "managed_browser_unsupported",
        "browser_login_session_not_found",
        "browser_login_start_failed",
        "shared_browser_busy",
        "pixiv_oauth_start_failed",
        "pixiv_oauth_start_timeout",
        "pixiv_oauth_session_not_found",
        "pixiv_oauth_session_expired",
        "pixiv_oauth_exchange_active",
        "pixiv_oauth_process_ended",
        "pixiv_oauth_exchange_timeout",
        "pixiv_oauth_exchange_failed",
        "invalid_pixiv_oauth_code",
        "pixiv_oauth_cache_failed",
        "invalid_authorization_proxy",
        "browser_profile_reset_active",
        "browser_profile_busy",
        "invalid_browser_profile_path",
        "chrome_not_found",
        "auth_cache_clear_failed",
    }
)


class ApiError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class ServiceContainer:
    def __init__(self, settings: AppSettings) -> None:
        if os.name != "nt":
            os.umask(0o077)
        self.settings = settings
        self.db = Database(
            settings.database_path,
            max_logs_per_task=settings.scheduler.max_logs_per_task,
        )
        self.proxy_sources = ManagedProxySourceStore(
            settings.proxy,
            settings.runtime_dir,
            project_dir=settings.project_dir,
        )
        self.proxy = ProxyPoolAdapter(
            settings.proxy,
            settings.runtime_dir,
            source_provider=self.proxy_sources,
        )
        self.auth = AuthManager(settings)
        self.gallery = GalleryRunner(settings.gallery, settings.project_dir)
        self.log_writer = TaskLogWriter(self.db)
        self.scheduler = TaskScheduler(
            self.db,
            self.gallery,
            self.proxy,
            settings.scheduler,
            self.log_writer,
            credential_validator=self.auth.managed_credentials_available,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.resolver = SiteResolver(settings.gallery.repo_path)
        self.discovery = DiscoveryService(
            self.gallery,
            self.proxy,
            settings.runtime_dir,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.crawl_planner = CrawlPlanner(
            self.proxy,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.ordered_crawls = OrderedCrawlManager(
            self.db,
            self.discovery,
            self.crawl_planner,
            self.scheduler,
            self.proxy,
            self.policy_for,
            poll_interval=settings.scheduler.poll_interval_seconds,
        )
        self.reviews = DedupReviewManager(
            self.db,
            settings.dedup,
            settings.runtime_dir,
        )
        self._health_task: asyncio.Task | None = None
        self._started = False

    def policy_for(self, site: str) -> SitePolicy:
        stored = self.db.get_site_policy(site)
        raw = stored["policy"] if stored else self.settings.default_site_policy
        return build_runtime_site_policy(raw)

    async def start(self, *, background: bool = True) -> None:
        if self._started:
            return
        self._started = True
        if self.settings.proxy.enabled and self.settings.proxy.auto_start:
            try:
                await asyncio.to_thread(self.proxy.start, force_refresh=True)
            except Exception as exc:
                # Keep the service up so the pool can be fixed and restarted from
                # the WebUI, but never silently. Only a mihomo core startup
                # failure blocks tasks (terminate, no direct fallback); other
                # start failures keep the original prefer/required semantics.
                core_error = ""
                try:
                    core_error = str(
                        (self.proxy.status().get("transport_core") or {}).get("last_error") or ""
                    )
                except Exception:
                    pass
                reminder = (
                    "；mihomo 传输核心启动失败，修复前非 direct 任务将被终止（不会回退直连）"
                    if core_error
                    else ""
                )
                print(
                    f"[gdl-backend] 代理池启动失败：{redact_text(exc, limit=500)}{reminder}；"
                    "详情见 /api/v1/proxy/status",
                    file=sys.stderr,
                    flush=True,
                )
        if background:
            await self.scheduler.start()
            await self.ordered_crawls.start()
            await self.reviews.start()
            self._health_task = asyncio.create_task(self._proxy_health_loop(), name="proxy-health-monitor")

    async def stop(self) -> None:
        if self._health_task is not None:
            self._health_task.cancel()
            await asyncio.gather(self._health_task, return_exceptions=True)
            self._health_task = None
        await self.reviews.stop()
        await self.ordered_crawls.stop()
        await self.scheduler.stop()
        await self.auth.stop()
        try:
            await asyncio.to_thread(self.proxy.stop, force=True)
        except Exception:
            pass
        self.db.close()
        self._started = False

    async def _proxy_health_loop(self) -> None:
        interval = max(5.0, self.settings.proxy.health_interval_seconds)
        while True:
            try:
                await asyncio.sleep(interval)
                status = await asyncio.to_thread(self.proxy.status)
                if status.get("running"):
                    await asyncio.to_thread(self.proxy.probe)
            except asyncio.CancelledError:
                break
            except Exception:
                continue


def _validate_site_name(site: str) -> str:
    value = site.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,127}", value):
        raise ApiError(422, "invalid_site", "site 格式无效")
    return value


def _canonical_site_name(site: str) -> str:
    value = _validate_site_name(site)
    try:
        return search_site(value).site
    except ValueError:
        return value


def _validate_site_match(explicit_site: str, resolved_site: str) -> None:
    try:
        explicit = search_site(explicit_site).site
        resolved = search_site(resolved_site).site
    except ValueError:
        return
    if explicit != resolved:
        raise ValueError(f"site={explicit} 与 URL 提取器站点 {resolved} 不一致")


def _task_files(task: dict[str, Any], limit: int = 2000) -> list[dict[str, Any]]:
    root = Path(task["output_dir"]).resolve()
    if not root.is_dir():
        return []
    files: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        if len(files) >= limit:
            break
        try:
            if path.is_symlink():
                continue
            if path.is_file():
                stat = path.stat()
                files.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "size": stat.st_size,
                        "modified_at": stat.st_mtime,
                    }
                )
        except OSError:
            continue
    return files


def _validate_network_target(
    url: str,
    allow_private: bool,
    *,
    strict: bool = True,
) -> None:
    if allow_private:
        return
    text = url.strip()
    lower = text.lower()
    starts = [pos for pos in (lower.find("http://"), lower.find("https://")) if pos >= 0]
    if starts:
        text = text[min(starts) :]
    parsed = urlsplit(text)
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ValueError("目标 URL 缺少主机名")
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise ValueError("目标 URL 指向本机或私有网络")
    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("目标主机 DNS 解析失败") from exc
    resolved_count = 0
    has_global = False
    for entry in addresses:
        address = entry[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            if strict:
                raise ValueError("目标主机解析出无法识别的地址") from exc
            continue
        if strict and not ip.is_global:
            raise ValueError(
                f"目标 URL 解析到非公网地址（IPv{ip.version}: {ip}），已拒绝"
            )
        if ip.is_global:
            has_global = True
        resolved_count += 1
    if strict:
        if not resolved_count:
            raise ValueError("目标主机 DNS 未返回任何地址")
        return
    if not has_global:
        raise ValueError("目标 URL 指向本机或私有网络")


def create_app(
    settings: AppSettings | None = None,
    *,
    container: ServiceContainer | None = None,
    start_background: bool = True,
) -> FastAPI:
    settings = settings or AppSettings.load()
    settings.validate()
    port = settings.server.port
    allowed_hosts = frozenset(
        {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
            "127.0.0.1",
            "localhost",
            "[::1]",
        }
    )
    service = container or ServiceContainer(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.container = service
        await service.start(background=start_background)
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(
        title="gallery-dl Backend",
        version=__version__,
        description="gallery-dl 子进程调度与内置订阅代理池后端",
        lifespan=lifespan,
    )
    app.state.container = service
    app.mount(
        "/ui",
        StaticFiles(directory=str(Path(__file__).resolve().parent / "webui"), html=True),
        name="webui",
    )
    if settings.server.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.server.cors_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.middleware("http")
    async def local_origin_guard(request: Request, call_next):
        host = request.headers.get("host", "").strip().lower()
        hostname, separator, port_suffix = host.rpartition(":")
        if separator and hostname.endswith("."):
            host = f"{hostname[:-1]}:{port_suffix}"
        elif host.endswith("."):
            host = host[:-1]

        fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
        if host not in allowed_hosts:
            error_code = "forbidden_host"
            error_message = "仅允许从本机回环地址访问"
        elif fetch_site in {"cross-site", "same-site"}:
            error_code = "forbidden_cross_site"
            error_message = "仅允许同源访问"
        else:
            return await call_next(request)

        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        response = JSONResponse(
            status_code=403,
            content={
                "error": {
                    "code": error_code,
                    "message": error_message,
                    "details": None,
                    "request_id": request_id,
                }
            },
        )
        response.headers["X-Request-ID"] = request_id
        return response

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details,
                    "request_id": getattr(request.state, "request_id", ""),
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        source_path = request.url.path
        policy_request = source_path.startswith("/api/v1/sites/policies/")
        sensitive_request = (
            source_path.startswith("/api/v1/proxy/sources")
            or source_path == "/api/v1/auth/proxy"
            or policy_request
        )
        if sensitive_request:
            # Pydantic 默认错误包含 input；敏感写接口不得回显刚提交的原文。
            if policy_request:
                allowed_fields = frozenset(EDITABLE_SITE_POLICY_FIELDS)
                details = []
                for item in exc.errors():
                    location = list(item.get("loc") or ())
                    field = next(
                        (
                            part for part in location
                            if isinstance(part, str) and part in allowed_fields
                        ),
                        "policy",
                    )
                    index = next(
                        (part for part in location if isinstance(part, int) and part >= 0),
                        None,
                    )
                    reason = str(item.get("type") or "validation_error")
                    if not re.fullmatch(r"[a-z0-9_.:-]{1,64}", reason, re.I):
                        reason = "validation_error"
                    detail = {"field": field, "reason": reason}
                    if index is not None:
                        detail["index"] = index
                    details.append(detail)
            else:
                details = [
                    {
                        "type": item.get("type", "validation_error"),
                        "loc": list(item.get("loc") or ()),
                        "msg": item.get("msg", "请求字段无效"),
                    }
                    for item in exc.errors()
                ]
            if policy_request:
                error_code = "invalid_policy"
            elif source_path == "/api/v1/auth/proxy":
                error_code = "invalid_authorization_proxy"
            elif "/subscriptions" in source_path:
                error_code = "invalid_proxy_subscription"
            elif "/node-file" in source_path:
                error_code = "invalid_proxy_node_file"
            elif "/inline-nodes" in source_path:
                error_code = "invalid_proxy_inline_node"
            else:
                error_code = "validation_error"
        else:
            details = jsonable_encoder(exc.errors())
            error_code = "validation_error"
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": error_code,
                    "message": "请求参数校验失败",
                    "details": details,
                    "request_id": getattr(request.state, "request_id", ""),
                }
            },
        )

    def get_service(request: Request) -> ServiceContainer:
        return request.app.state.container

    def _content_length(request: Request) -> int | None:
        raw_length = request.headers.get("content-length")
        if raw_length is None:
            return None
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ApiError(400, "invalid_content_length", "Content-Length 无效") from exc
        if length < 0:
            raise ApiError(400, "invalid_content_length", "Content-Length 无效")
        return length

    async def enforce_proxy_source_body_limit(request: Request) -> None:
        length = _content_length(request)
        if length is not None and length > MAX_PROXY_SOURCE_REQUEST_BYTES:
            raise ApiError(
                413,
                "proxy_sources_request_too_large",
                "代理源请求体超过大小上限",
            )

    async def enforce_auth_proxy_body_limit(request: Request) -> None:
        length = _content_length(request)
        if length is not None and length > MAX_AUTH_PROXY_REQUEST_BYTES:
            raise ApiError(
                413,
                "auth_request_too_large",
                "授权代理请求体超过大小上限",
            )

    async def enforce_policy_body_limit(request: Request) -> None:
        # 四字段写接口无论使用哪种响应形状，都采用同一请求体上限。
        length = _content_length(request)
        if length is not None and length > MAX_POLICY_REQUEST_BYTES:
            raise ApiError(
                413,
                "policy_request_too_large",
                "站点策略请求体超过大小上限",
            )
        # 不能信任客户端声明；FastAPI 已缓存请求体，这里再核对实际字节数。
        if len(await request.body()) > MAX_POLICY_REQUEST_BYTES:
            raise ApiError(
                413,
                "policy_request_too_large",
                "站点策略请求体超过大小上限",
            )

    api = APIRouter(prefix="/api/v1")

    @app.get("/")
    async def root():
        return {
            "service": "gallery-dl-backend",
            "version": __version__,
            "ui": "/ui/",
            "docs": "/docs",
        }

    @app.get("/healthz")
    async def healthz():
        database_ok = service.db.ping()
        payload = {
            "ok": database_ok,
            "components": {
                "process": {"status": "ok"},
                "database": {"status": "ok" if database_ok else "error"},
            },
            "time": time.time(),
        }
        return JSONResponse(status_code=200 if database_ok else 503, content=payload)

    @app.get("/readyz")
    async def readyz():
        # 事件循环拥有的可变状态必须在循环上取快照，不能带进工作线程。
        scheduler_summary = service.scheduler.active_summary()
        ordered_summary = service.ordered_crawls.status()

        def snapshot() -> dict[str, Any]:
            return readiness_snapshot(
                settings,
                database_ok=service.db.ping(),
                live_proxy_status=service.proxy.status(),
                scheduler=scheduler_summary,
                ordered_crawls=ordered_summary,
            )

        payload = await asyncio.to_thread(snapshot)
        return JSONResponse(status_code=200 if payload["ready"] else 503, content=payload)

    @api.get("/config")
    async def public_config(
        view: DiagnosticsResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        if view == "diagnostics":
            return diagnostics_config_snapshot(container.settings)
        return container.settings.public_dict()

    def _raise_auth_error(
        exc: AuthError,
        view: AuthResponseView = "legacy",
    ) -> None:
        if exc.code in {
            "unsupported_auth_site",
            "pixiv_oauth_session_not_found",
            "browser_login_session_not_found",
        }:
            status_code = 404
        elif exc.code.startswith("invalid_"):
            status_code = 422
        else:
            status_code = 409
        if view == "vault":
            code = (
                exc.code
                if exc.code in _VAULT_SAFE_AUTH_ERROR_CODES
                else "authorization_operation_failed"
            )
            if status_code == 404:
                message = "授权目标或会话不存在"
            elif status_code == 422:
                message = "授权请求不符合安全约束"
            else:
                message = "授权状态冲突或操作暂时不可用"
            raise ApiError(status_code, code, message) from exc
        raise ApiError(status_code, exc.code, exc.message, exc.details) from exc

    def _auth_browser_result(result: dict[str, Any], view: AuthResponseView) -> dict[str, Any]:
        if view == "legacy":
            return result
        status = vault_safe_status(result.get("status"))
        return {
            "session": vault_safe_session(result.get("session"), site=status["site"]),
            "status": status,
        }

    @api.get("/auth")
    async def auth_statuses(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        result = container.auth.statuses()
        return vault_safe_statuses(result) if view == "vault" else result

    # 注意：/auth/proxy 必须先于 /auth/{site} 注册，否则会被当成站点名匹配。
    @api.get("/auth/proxy")
    async def auth_proxy_status(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        result = container.auth.proxy_status()
        return vault_safe_proxy_status(result) if view == "vault" else result

    @api.put("/auth/proxy")
    async def auth_set_proxy(
        payload: AuthProxyUpdate,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_auth_proxy_body_limit),
    ):
        try:
            result = await container.auth.set_authorization_proxy(payload.proxy_url)
            return vault_safe_proxy_status(result) if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.delete("/auth/proxy")
    async def auth_reset_proxy(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.clear_authorization_proxy()
            return vault_safe_proxy_status(result) if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.get("/auth/{site}")
    async def auth_status(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = container.auth.status(site)
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.post("/auth/{site}/login/start", status_code=202)
    async def auth_start_browser_login(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.start_browser_login(site)
            return _auth_browser_result(result, view)
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.get("/auth/{site}/login/{session_id}")
    async def auth_browser_login_session(
        site: str,
        session_id: str,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = container.auth.browser_login_session(site, session_id)
            return _auth_browser_result(result, view)
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.delete("/auth/{site}/login/{session_id}")
    async def auth_cancel_browser_login(
        site: str,
        session_id: str,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.cancel_browser_login(site, session_id)
            return _auth_browser_result(result, view)
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.post("/auth/pixiv/oauth/start")
    async def auth_start_pixiv(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.start_pixiv_oauth()
            return vault_safe_session(result, site="pixiv") if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.delete("/auth/pixiv/oauth/session")
    async def auth_cancel_pixiv(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.cancel_pixiv_oauth()
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.delete("/auth/browser-profile")
    async def auth_clear_browser_profile(
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.clear_browser_profile()
            if view == "legacy":
                return result
            return {
                "browser_profile": vault_safe_browser_profile(result.get("browser_profile")),
                "auth": vault_safe_statuses(result.get("auth")),
            }
        except AuthError as exc:
            _raise_auth_error(exc, view)

    @api.delete("/auth/{site}")
    async def auth_clear(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            result = await container.auth.clear(site)
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            _raise_auth_error(exc, view)

    def _validate_idempotency_key(value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) > 200:
            raise ApiError(422, "invalid_idempotency_key", "Idempotency-Key 过长")
        result = value.strip()
        if not result:
            raise ApiError(422, "invalid_idempotency_key", "Idempotency-Key 为空")
        return result

    def _allowed_request_files(
        container: ServiceContainer,
        *,
        cookies_file: str | None,
        config_file: str | None,
    ) -> tuple[Path | None, Path | None]:
        cookies = container.settings.allowed_file(
            cookies_file,
            container.settings.allowed_cookie_roots,
            "cookies_file",
        )
        config = container.settings.allowed_file(
            config_file,
            container.settings.allowed_config_roots,
            "config_file",
        )
        return cookies, config

    def _managed_request_credentials(
        container: ServiceContainer,
        site: str,
        *,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
    ) -> tuple[str | None, str | None, str | None]:
        managed = container.auth.credentials_for(site)
        return (
            credentials_ref or managed.get("credentials_ref"),
            cookies_file or managed.get("cookies_file"),
            config_file or managed.get("config_file"),
        )

    def _build_task_row(
        body: TaskCreate,
        site_info: SiteInfo,
        container: ServiceContainer,
        *,
        concurrency_override: int | None = None,
    ) -> dict[str, Any]:
        if body.site:
            site = _canonical_site_name(body.site)
            if site_info.supported:
                _validate_site_match(site, site_info.site)
        else:
            site = site_info.site
        policy = body._policy_override or container.policy_for(site)
        if body.eh_download is not None:
            if site != "exhentai":
                raise ValueError("eh_download 仅适用于 EH/EHX 任务")
            policy = TaskPolicy.model_validate(
                {
                    **policy.model_dump(),
                    "eh_download": body.eh_download.model_dump(),
                }
            )
        if concurrency_override is not None:
            effective = min(
                int(concurrency_override),
                container.settings.scheduler.max_concurrent_tasks,
            )
            policy = policy.model_copy(update={"max_concurrency": max(1, effective)})
        task_id = str(uuid.uuid4())
        output_dir = container.settings.task_output_dir(body.output_dir, task_id)
        if body._skip_managed_credentials:
            credentials_ref = body.credentials_ref
            cookies_value = body.cookies_file
            config_value = body.config_file
        else:
            credentials_ref, cookies_value, config_value = _managed_request_credentials(
                container,
                site,
                credentials_ref=body.credentials_ref,
                cookies_file=body.cookies_file,
                config_file=body.config_file,
            )
        cookies, config_file = _allowed_request_files(
            container,
            cookies_file=cookies_value,
            config_file=config_value,
        )
        container.gallery.validate_args([*policy.extra_args, *body.extra_args])
        return {
            "id": task_id,
            "url": body.url,
            "site": site,
            "subcategory": site_info.subcategory,
            "extractor": site_info.extractor,
            "priority": body.priority,
            "output_dir": str(output_dir),
            "proxy_mode": body.proxy_mode or policy.proxy_mode,
            "max_attempts": body.max_attempts or (policy.retry_limit + 1),
            "cookies_file": str(cookies) if cookies else None,
            "config_file": str(config_file) if config_file else None,
            "credentials_ref": credentials_ref,
            "extra_args": body.extra_args,
            "policy": policy.model_dump(),
        }

    async def _enqueue_task(
        body: TaskCreate,
        *,
        idempotency_key: str | None,
        container: ServiceContainer,
        concurrency_override: int | None = None,
        network_validated: bool = False,
        notify: bool = True,
    ) -> tuple[dict[str, Any], bool]:
        key = _validate_idempotency_key(idempotency_key)
        if key is not None:
            existing = container.db.get_task_by_idempotency(key)
            if existing is not None:
                return existing, False
        try:
            if not network_validated:
                await asyncio.to_thread(
                    _validate_network_target,
                    body.url,
                    container.settings.server.allow_private_targets,
                    strict=container.settings.server.strict_target_dns,
                )
            site_info = await asyncio.to_thread(container.resolver.resolve, body.url)
            task_row = _build_task_row(
                body,
                site_info,
                container,
                concurrency_override=concurrency_override,
            )
        except ValueError as exc:
            raise ApiError(422, "invalid_task", str(exc)) from exc
        task, created = container.db.create_task(
            task_row,
            idempotency_key=key,
        )
        if notify:
            container.scheduler.notify()
        return task, created

    async def _enqueue_ordered_tasks(
        bodies: list[TaskCreate],
        idempotency_keys: list[str],
        concurrency: int,
    ) -> list[dict]:
        if len(bodies) != len(idempotency_keys):
            raise RuntimeError("批量任务与幂等键数量不一致")
        if not bodies:
            return []

        keys: list[str] = []
        metadata = []
        for body, raw_key in zip(bodies, idempotency_keys):
            key = _validate_idempotency_key(raw_key)
            if key is None:
                raise RuntimeError("顺序爬取任务缺少幂等键")
            link = body._crawl_link
            if link is None:
                raise RuntimeError("顺序爬取任务缺少地址链接元数据")
            keys.append(key)
            metadata.append(link)
        address_id = metadata[0].address_id
        if any(link.address_id != address_id for link in metadata):
            raise RuntimeError("同一入队块包含多个地址")

        def _build_task_rows() -> list[dict[str, Any]]:
            return [
                _build_task_row(
                    body,
                    service.resolver.resolve(body.url),
                    service,
                    concurrency_override=concurrency,
                )
                for body in bodies
            ]

        try:
            task_rows = await asyncio.to_thread(_build_task_rows)
        except ValueError as exc:
            raise ApiError(422, "invalid_task", str(exc)) from exc

        items = [
            {
                "task": task_row,
                "idempotency_key": key,
                "sequence_no": link.sequence_no,
                "source_key": link.source_key,
                "source_url": link.source_url,
            }
            for task_row, key, link in zip(task_rows, keys, metadata)
        ]
        # shield 只覆盖已提交的 SQLite worker；取消若在提交竞态中到达，必须先
        # 收回结果，再由顺序管理器把这些已链接任务纳入原有取消排空分支。
        write_task = asyncio.create_task(
            asyncio.to_thread(
                service.db.create_crawl_media_tasks,
                address_id,
                items,
            ),
            name="ordered-crawl-media-write",
        )
        try:
            return await asyncio.shield(write_task)
        except asyncio.CancelledError as cancelled:
            while not write_task.done():
                try:
                    await asyncio.shield(write_task)
                except asyncio.CancelledError:
                    continue
            if write_task.cancelled():
                raise
            try:
                results = write_task.result()
            except Exception as exc:
                raise EnqueueBatchCancelled([]) from exc
            raise EnqueueBatchCancelled(results) from cancelled

    service.ordered_crawls.set_enqueue(_enqueue_ordered_tasks)

    @api.post("/tasks")
    async def create_task(
        body: TaskCreate,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        container: ServiceContainer = Depends(get_service),
    ):
        task, created = await _enqueue_task(
            body,
            idempotency_key=idempotency_key,
            container=container,
        )
        return JSONResponse(status_code=202 if created else 200, content=task)

    def _effective_search_options(body: SearchRequest, site: str) -> dict[str, Any]:
        canonical_options: dict[str, Any] = {}
        for key, value in body.source_options.items():
            canonical = search_site(key).site
            if canonical in canonical_options:
                raise ValueError(f"source_options 重复配置来源: {canonical}")
            canonical_options[canonical] = value
        specific = canonical_options.get(site)

        def choose(name: str):
            if specific is not None and name in specific.model_fields_set:
                return getattr(specific, name)
            return getattr(body, name)

        return {
            "proxy_mode": choose("proxy_mode"),
            "credentials_ref": choose("credentials_ref"),
            "cookies_file": choose("cookies_file"),
            "config_file": choose("config_file"),
            "search_extra_args": [
                *body.search_extra_args,
                *(specific.search_extra_args if specific is not None else []),
            ],
            "timeout_seconds": choose("timeout_seconds"),
        }

    async def _perform_search(body: SearchRequest, container: ServiceContainer) -> dict[str, Any]:
        try:
            sites: list[str] = []
            for value in body.sites:
                canonical = search_site(value).site
                if canonical not in sites:
                    sites.append(canonical)
            execution_sites = list(sites)
            implicit_danbooru = (
                "danbooru" not in execution_sites
                and any(site in {"twitter", "pixiv"} for site in execution_sites)
            )
            if implicit_danbooru:
                execution_sites.insert(0, "danbooru")
            alias_search_sites = {"exhentai", "pawchive"}
            needs_artist_directory = "danbooru" in execution_sites or any(
                site in alias_search_sites for site in execution_sites
            )
            option_sites = list(execution_sites)
            if needs_artist_directory and "danbooru" not in option_sites:
                option_sites.append("danbooru")
            options = {
                site: _effective_search_options(body, site) for site in option_sites
            }
        except ValueError as exc:
            raise ApiError(422, "invalid_search", str(exc)) from exc

        # One artist-directory lookup shared by the danbooru source (author
        # merging) and the EH/Pawchive alias expansion below.
        artist_directory_task: asyncio.Task | None = None
        if needs_artist_directory:

            async def _artist_directory_lookup() -> dict[str, Any]:
                option = options["danbooru"]
                credentials_ref, cookies_value, config_value = _managed_request_credentials(
                    container,
                    "danbooru",
                    credentials_ref=option["credentials_ref"],
                    cookies_file=option["cookies_file"],
                    config_file=option["config_file"],
                )
                cookies, config_file = _allowed_request_files(
                    container,
                    cookies_file=cookies_value,
                    config_file=config_value,
                )
                return await container.discovery.search_danbooru_artists(
                    keyword=body.keyword,
                    limit=body.limit,
                    policy=container.policy_for("danbooru"),
                    proxy_mode=option["proxy_mode"],
                    credentials_ref=credentials_ref,
                    cookies_file=str(cookies) if cookies else None,
                    config_file=str(config_file) if config_file else None,
                    timeout_seconds=option["timeout_seconds"],
                )

            artist_directory_task = asyncio.create_task(_artist_directory_lookup())

        async def run_source(order: int, site: str) -> dict[str, Any]:
            spec = search_site(site)
            option = options[site]
            if site in {"twitter", "pixiv"}:
                # Account discovery for X and Pixiv is intentionally sourced
                # from Danbooru's curated artist URLs.  Their native site
                # searches are work-oriented / unstable and create false
                # negatives for account lookup.  Crawl/download support for
                # the resulting account URLs remains unchanged.
                return {
                    "order": order,
                    "site": site,
                    "status": "succeeded",
                    "search_url": None,
                    "search_strategy": "danbooru_artist_urls",
                    "evidence_count": 0,
                    "preview_count": 0,
                    "preview_missing_count": 0,
                    "address_count": 0,
                    "addresses": [],
                    "weak_evidence_count": 0,
                    "weak_evidence": [],
                    "tag_facets": [],
                    "proxy": None,
                    "attempts": 0,
                    "error": None,
                    "enrichment_errors": [],
                    "auth": container.auth.status(site),
                }
            try:
                search_url = spec.search_url(body.keyword)
                await asyncio.to_thread(
                    _validate_network_target,
                    search_url,
                    container.settings.server.allow_private_targets,
                    strict=container.settings.server.strict_target_dns,
                )
                credentials_ref, cookies_value, config_value = _managed_request_credentials(
                    container,
                    site,
                    credentials_ref=option["credentials_ref"],
                    cookies_file=option["cookies_file"],
                    config_file=option["config_file"],
                )
                cookies, config_file = _allowed_request_files(
                    container,
                    cookies_file=cookies_value,
                    config_file=config_value,
                )
                validate_discovery_args(option["search_extra_args"])
                container.gallery.validate_args(option["search_extra_args"])
                source_enrichment_errors: list[dict[str, str]] = []

                async def _search_term(term: str) -> dict[str, Any]:
                    return await container.discovery.search(
                        site=site,
                        keyword=term,
                        limit=body.limit,
                        policy=container.policy_for(site),
                        proxy_mode=option["proxy_mode"],
                        credentials_ref=credentials_ref,
                        cookies_file=str(cookies) if cookies else None,
                        config_file=str(config_file) if config_file else None,
                        extra_args=option["search_extra_args"],
                        timeout_seconds=option["timeout_seconds"],
                    )

                # The primary keyword search starts immediately; the alias
                # wait below runs while it is in flight so alias expansion
                # never delays the native search.
                primary_task = asyncio.create_task(_search_term(body.keyword))

                alias_terms: list[str] = []
                if site in alias_search_sites and artist_directory_task is not None:
                    # Danbooru's curated artist entries carry other_names
                    # (Japanese/romaji/CJK aliases); EH and Pawchive have no
                    # such link maintenance, so a keyword in "the wrong"
                    # variant silently misses artists that do exist there.
                    try:
                        artist_result = await asyncio.wait_for(
                            asyncio.shield(artist_directory_task),
                            timeout=_ALIAS_LOOKUP_WAIT_SECONDS,
                        )
                        alias_terms = danbooru_alias_terms(artist_result, body.keyword)
                    except asyncio.TimeoutError:
                        source_enrichment_errors.append(
                            {
                                "stage": "danbooru_alias_lookup",
                                "message": (
                                    "Danbooru 画师目录查询超过 "
                                    f"{_ALIAS_LOOKUP_WAIT_SECONDS:g}s，已跳过别名扩搜"
                                ),
                            }
                        )
                    except Exception as exc:
                        source_enrichment_errors.append(
                            {
                                "stage": "danbooru_alias_lookup",
                                "message": redact_text(
                                    exc.message
                                    if isinstance(exc, DiscoveryError)
                                    else exc,
                                    limit=1000,
                                ),
                            }
                        )

                alias_outcomes = await asyncio.gather(
                    *(_search_term(term) for term in alias_terms),
                    return_exceptions=True,
                )
                result = await primary_task
                if alias_terms:
                    alias_results: list[tuple[str, dict[str, Any]]] = []
                    for term, outcome in zip(alias_terms, alias_outcomes):
                        if isinstance(outcome, BaseException):
                            source_enrichment_errors.append(
                                {
                                    "stage": "danbooru_alias_search",
                                    "message": redact_text(
                                        f"{term}: "
                                        + str(
                                            outcome.message
                                            if isinstance(outcome, DiscoveryError)
                                            else outcome
                                        ),
                                        limit=1000,
                                    ),
                                }
                            )
                        else:
                            alias_results.append((term, outcome))
                    result = merge_alias_search_results(
                        body.keyword, result, alias_results, limit=body.limit
                    )
                if site == "exhentai":
                    try:
                        result = await container.discovery.enrich_exhentai_previews(
                            result,
                            policy=container.policy_for(site),
                            proxy_mode=option["proxy_mode"],
                            timeout_seconds=option["timeout_seconds"],
                        )
                    except Exception as exc:
                        result["preview_count"] = int(result.get("preview_count") or 0)
                        result["preview_missing_count"] = max(
                            0,
                            int(
                                result.get("candidate_count")
                                or len(result.get("candidates") or [])
                            )
                            - result["preview_count"],
                        )
                        source_enrichment_errors.append(
                            {
                                "stage": "exhentai_gallery_previews",
                                "message": redact_text(
                                    exc.message if isinstance(exc, DiscoveryError) else exc,
                                    limit=1000,
                                ),
                            }
                        )
                if site == "danbooru" and artist_directory_task is not None:
                    try:
                        artist_result = await artist_directory_task
                        merged_authors = list(result.get("authors") or [])
                        author_by_key = {
                            str(author.get("works_url") or author.get("url") or author.get("name")): author
                            for author in merged_authors
                        }
                        for author in artist_result.get("authors") or []:
                            key = str(author.get("works_url") or author.get("url") or author.get("name"))
                            existing = author_by_key.get(key)
                            if existing is None:
                                merged_authors.append(author)
                                author_by_key[key] = author
                                continue
                            # Prefer the structured artist-directory identity over a
                            # post-derived author with the same works URL.
                            for field in (
                                "id",
                                "name",
                                "display_name",
                                "url",
                                "works_url",
                                "other_names",
                                "group_name",
                                "origin",
                            ):
                                value = author.get(field)
                                if value not in (None, "", []):
                                    existing[field] = value
                        result["authors"] = merged_authors
                    except Exception as exc:
                        source_enrichment_errors.append(
                            {
                                "stage": "danbooru_artist_directory",
                                "message": redact_text(
                                    exc.message if isinstance(exc, DiscoveryError) else exc,
                                    limit=1000,
                                ),
                            }
                        )
                discovered_addresses = discovery_addresses(
                    site,
                    result,
                    keyword=body.keyword,
                    limit=body.limit,
                )
                addresses = [
                    address
                    for address in discovered_addresses
                    if address.get("confidence") != "weak_evidence"
                ]
                weak_evidence = [
                    address
                    for address in discovered_addresses
                    if address.get("confidence") == "weak_evidence"
                ]
                tag_facets = (
                    exhentai_tag_facets(discovered_addresses)
                    if site == "exhentai"
                    else []
                )
                return {
                    "order": order,
                    "site": site,
                    "status": "partial" if source_enrichment_errors else "succeeded",
                    "search_url": result.get("search_url"),
                    "alias_keywords": list(result.get("alias_keywords") or []),
                    "evidence_count": result.get("candidate_count", 0),
                    "preview_count": result.get("preview_count", 0),
                    "preview_missing_count": result.get("preview_missing_count", 0),
                    "address_count": len(addresses),
                    "addresses": addresses,
                    "weak_evidence_count": len(weak_evidence),
                    "weak_evidence": weak_evidence,
                    "tag_facets": tag_facets,
                    "proxy": result.get("proxy"),
                    "attempts": result.get("attempts", 0),
                    "error": None,
                    "enrichment_errors": source_enrichment_errors,
                    "auth": container.auth.status(site),
                }
            except Exception as exc:
                code = exc.code if isinstance(exc, DiscoveryError) else "invalid_search_source"
                message = exc.message if isinstance(exc, DiscoveryError) else str(exc)
                details = (
                    exc.details
                    if isinstance(exc, DiscoveryError) and isinstance(exc.details, dict)
                    else {}
                )
                return {
                    "order": order,
                    "site": site,
                    "status": "failed",
                    "search_url": spec.search_url(body.keyword),
                    "evidence_count": 0,
                    "preview_count": 0,
                    "preview_missing_count": 0,
                    "address_count": 0,
                    "addresses": [],
                    "weak_evidence_count": 0,
                    "weak_evidence": [],
                    "tag_facets": [],
                    "proxy": details.get("proxy"),
                    "attempts": int(details.get("attempts") or 0),
                    "error": {"code": code, "message": redact_text(message, limit=1000)},
                    "auth": container.auth.status(site),
                }

        sources = list(
            await asyncio.gather(
                *(run_source(order, site) for order, site in enumerate(execution_sites))
            )
        )
        if artist_directory_task is not None:
            # Every consumer guards its own await; retrieve the outcome here so
            # an all-consumers-timed-out run never leaves an unretrieved task
            # exception behind.
            if not artist_directory_task.done():
                artist_directory_task.cancel()
            try:
                await artist_directory_task
            except (Exception, asyncio.CancelledError):
                pass
        source_by_site = {source["site"]: source for source in sources}
        related_profiles: list[dict[str, Any]] = []
        enrichment_errors: list[dict[str, str]] = [
            {"source": source["site"], **error}
            for source in sources
            for error in source.get("enrichment_errors") or []
        ]
        danbooru = source_by_site.get("danbooru")
        if danbooru is not None and (danbooru["addresses"] or danbooru["weak_evidence"]):
            artist_names = [
                str(address.get("tag") or "")
                for address in [*danbooru["addresses"], *danbooru["weak_evidence"]]
                if address.get("address_type") == "artist_tag"
            ]
            if artist_names:
                try:
                    profiles, profile_errors = await container.discovery.danbooru_artist_profiles(
                        artist_names,
                        policy=container.policy_for("danbooru"),
                        proxy_mode=options["danbooru"]["proxy_mode"],
                        limit=body.limit,
                    )
                    enrichment_errors.extend(
                        {"source": "danbooru", **error} for error in profile_errors
                    )
                except Exception as exc:
                    profiles = []
                    enrichment_errors.append(
                        {
                            "source": "danbooru",
                            "artist": "*",
                            "message": redact_text(
                                exc.message if isinstance(exc, DiscoveryError) else exc,
                                limit=1000,
                            ),
                        }
                    )
                danbooru_errors = [
                    error for error in enrichment_errors if error.get("source") == "danbooru"
                ]
                if danbooru_errors:
                    danbooru["status"] = "partial"
                    danbooru["enrichment_errors"] = danbooru_errors
                profile_by_name = {str(profile["name"]): profile for profile in profiles}
                for address in [*danbooru["addresses"], *danbooru["weak_evidence"]]:
                    profile = profile_by_name.get(str(address.get("tag") or ""))
                    if profile is None:
                        continue
                    address["danbooru_artist"] = {
                        key: profile.get(key)
                        for key in ("id", "name", "other_names", "group_name", "profile_url")
                    }
                    address["related_profiles"] = profile["related_profiles"]
                    for related in profile["related_profiles"]:
                        item = {
                            **related,
                            "artist_id": profile["id"],
                            "artist_name": profile["name"],
                            "origin": "danbooru_artist_url",
                        }
                        related_profiles.append(item)
                        crawl_site = related.get("crawl_site")
                        crawl_url = related.get("crawl_url")
                        if not related.get("active", True) or crawl_site not in source_by_site or not crawl_url:
                            continue
                        crawl_url = canonical_gallery_address(crawl_site, crawl_url)
                        target = source_by_site[crawl_site]
                        existing = next(
                            (
                                candidate
                                for candidate in target["addresses"]
                                if canonical_gallery_address(crawl_site, candidate.get("url") or "") == crawl_url
                            ),
                            None,
                        )
                        weak_existing = next(
                            (
                                candidate
                                for candidate in target["weak_evidence"]
                                if canonical_gallery_address(crawl_site, candidate.get("url") or "")
                                == crawl_url
                            ),
                            None,
                        )
                        if existing is not None:
                            origins = list(existing.get("origins") or [existing.get("origin", "site_search")])
                            if "danbooru_artist_url" not in origins:
                                origins.append("danbooru_artist_url")
                            existing["origins"] = origins
                            existing["confidence"] = "verified"
                            reasons = list(existing.get("evidence_reasons") or [])
                            if "danbooru_artist_url" not in reasons:
                                reasons.append("danbooru_artist_url")
                            existing["evidence_reasons"] = reasons
                            related_artists = existing.setdefault("related_artists", [])
                            if profile["name"] not in related_artists:
                                related_artists.append(profile["name"])
                            continue
                        if weak_existing is not None:
                            target["weak_evidence"].remove(weak_existing)
                            prior_origin = weak_existing.get("origin", "site_search")
                            weak_existing["origin"] = "danbooru_artist_url"
                            weak_existing["origins"] = list(
                                dict.fromkeys([prior_origin, "danbooru_artist_url"])
                            )
                            weak_existing["confidence"] = "verified"
                            reasons = list(weak_existing.get("evidence_reasons") or [])
                            if "danbooru_artist_url" not in reasons:
                                reasons.append("danbooru_artist_url")
                            weak_existing["evidence_reasons"] = reasons
                            weak_existing["related_artists"] = list(
                                dict.fromkeys(
                                    [*weak_existing.get("related_artists", []), profile["name"]]
                                )
                            )
                            target["addresses"].append(weak_existing)
                            if target["status"] == "failed":
                                target["status"] = "partial"
                            continue
                        if len(target["addresses"]) >= body.limit:
                            continue
                        target["addresses"].append(
                            {
                                "id": f"{crawl_site}:danbooru:{profile['id']}:{len(target['addresses']) + 1}",
                                "source": crawl_site,
                                "address_type": "account",
                                "label": profile["name"],
                                "url": crawl_url,
                                "profile_url": related["url"],
                                "origin": "danbooru_artist_url",
                                "confidence": "verified",
                                "evidence_reasons": ["danbooru_artist_url"],
                                "related_artists": [profile["name"]],
                            }
                        )
                        if target["status"] == "failed":
                            target["status"] = "partial"
                for source in sources:
                    source["address_count"] = len(source["addresses"])
                    source["weak_evidence_count"] = len(source["weak_evidence"])

        # X/Pixiv account discovery rides entirely on the Danbooru artist
        # entry; when that upstream failed, an empty account list is an
        # incident, not "no results" — surface it on the affected sources
        # instead of letting them report a clean success with zero addresses.
        danbooru_upstream_errors = [
            error for error in enrichment_errors if error.get("source") == "danbooru"
        ]
        if danbooru is not None and danbooru.get("status") == "failed":
            danbooru_upstream_errors.append(
                {
                    "source": "danbooru",
                    "stage": "danbooru_search",
                    "message": ((danbooru.get("error") or {}).get("message"))
                    or "Danbooru 搜索失败",
                }
            )
        if danbooru_upstream_errors:
            detail = "; ".join(
                str(error.get("message") or error.get("stage") or "")[:200]
                for error in danbooru_upstream_errors[:3]
            )
            for affected in ("twitter", "pixiv"):
                target = source_by_site.get(affected)
                if target is None or target["addresses"]:
                    continue
                if target["status"] == "succeeded":
                    target["status"] = "partial"
                target["enrichment_errors"] = [
                    *(target.get("enrichment_errors") or []),
                    {
                        "stage": "danbooru_account_discovery",
                        "message": (
                            "Danbooru 画师条目查询失败，本次未完成账号发现"
                            "（通常重试搜索即可恢复）：" + detail
                        ),
                    },
                ]

        if implicit_danbooru:
            sources = [source for source in sources if source["site"] != "danbooru"]
        for order, source in enumerate(sources):
            source["order"] = order
        for source in sources:
            if source.get("status") == "succeeded":
                continue
            _search_logger.warning(
                "search source issue site=%s status=%s error_code=%s enrichment_stages=[%s]",
                source.get("site"),
                source.get("status"),
                (source.get("error") or {}).get("code"),
                ",".join(
                    str(item.get("stage") or "unknown")[:64]
                    for item in source.get("enrichment_errors") or []
                ),
            )

        return {
            "keyword": body.keyword,
            "source_count": len(sources),
            "address_count": sum(len(source["addresses"]) for source in sources),
            "weak_evidence_count": sum(len(source["weak_evidence"]) for source in sources),
            "sources": sources,
            "related_profiles": related_profiles,
            "enrichment_errors": enrichment_errors,
            "selection_contract": {
                "field": "sources[].addresses[]",
                "weak_evidence_field": "sources[].weak_evidence[]",
                "default_visibility": "addresses_only",
                "execution_order": "source_then_address",
                "address_execution": "media_parallel",
            },
            "tag_filter_contract": {
                "source": "exhentai",
                "facets_field": "sources[].tag_facets[]",
                "tags_field": "sources[].addresses[].metadata.tags[]",
                "same_namespace": "or",
                "across_namespaces": "and",
                "exclusions": "take_precedence",
            },
        }

    @api.get("/search/sites")
    async def supported_search_sites():
        return {"items": search_site_catalog()}

    @api.get("/search/autocomplete")
    async def search_autocomplete(
        q: str,
        limit: int = 10,
        container: ServiceContainer = Depends(get_service),
    ):
        # Prefix suggestions from Danbooru's search-box autocomplete so the
        # user can resolve a partial/alias spelling to the real artist tag
        # themselves — nothing here feeds the search silently.
        query = str(q or "").strip()
        if not query:
            raise ApiError(422, "invalid_autocomplete", "补全关键词不能为空")
        if len(query) > 200:
            raise ApiError(422, "invalid_autocomplete", "补全关键词过长")
        try:
            result = await container.discovery.danbooru_autocomplete(
                query,
                limit=min(max(1, int(limit)), 20),
                policy=container.policy_for("danbooru"),
                proxy_mode=None,
            )
        except DiscoveryError as exc:
            raise ApiError(502, exc.code, exc.message) from exc
        return {
            "query": result["query"],
            "source": "danbooru",
            "items": result["items"],
        }

    @api.post("/search")
    async def search_candidates(
        body: SearchRequest,
        container: ServiceContainer = Depends(get_service),
    ):
        return await _perform_search(body, container)

    def _range_argument_present(args: list[str]) -> bool:
        managed = {
            "--range",
            "--file-range",
            "--image-range",
            "--post-range",
            "--child-range",
            "--chapter-range",
        }
        return any(str(value).split("=", 1)[0] in managed for value in args)

    async def _perform_crawl(
        body: CrawlRequest,
        *,
        container: ServiceContainer,
        idempotency_key: str | None,
    ) -> tuple[dict[str, Any], bool]:
        base_key = _validate_idempotency_key(idempotency_key)
        if base_key is not None:
            existing = container.db.get_crawl_batch_by_idempotency(base_key)
            if existing is not None:
                return existing, False
        try:
            container.gallery.validate_args(body.extra_args)
            validate_discovery_args(body.discovery_extra_args)
            if _range_argument_present(body.extra_args):
                raise ValueError("图片范围参数由单地址并发规划器管理")

            canonical_sources: list[tuple[str, Any]] = []
            seen_sites: set[str] = set()
            for source in body.sources:
                site = search_site(source.site).site
                if site in seen_sites:
                    raise ValueError(f"sources 重复配置来源: {site}")
                seen_sites.add(site)
                canonical_sources.append((site, source))

            batch_id = str(uuid.uuid4())
            output_dir = container.settings.task_output_dir(body.output_dir, f"batch-{batch_id}")
            flattened: list[dict[str, Any]] = []
            for source_order, (site, source) in enumerate(canonical_sources):
                policy = container.policy_for(site)
                if source.eh_download is not None and site != "exhentai":
                    raise ValueError("eh_download 仅适用于 EH/EHX 来源")
                download_options = (
                    {"eh": source.eh_download.model_dump()}
                    if source.eh_download is not None
                    else {}
                )

                def source_value(name: str):
                    if name in source.model_fields_set:
                        return getattr(source, name)
                    return getattr(body, name)

                task_args = [*body.extra_args, *source.extra_args]
                discovery_args = [*body.discovery_extra_args, *source.discovery_extra_args]
                container.gallery.validate_args(task_args)
                validate_discovery_args(discovery_args)
                if _range_argument_present(task_args):
                    raise ValueError("图片范围参数由单地址并发规划器管理")
                credentials_ref, cookies_value, config_value = _managed_request_credentials(
                    container,
                    site,
                    credentials_ref=source_value("credentials_ref"),
                    cookies_file=source_value("cookies_file"),
                    config_file=source_value("config_file"),
                )
                cookies, config_file = _allowed_request_files(
                    container,
                    cookies_file=cookies_value,
                    config_file=config_value,
                )
                mode = source_value("proxy_mode") or policy.proxy_mode
                max_attempts = source_value("max_attempts") or (policy.retry_limit + 1)
                priority = source.priority if "priority" in source.model_fields_set else body.priority
                timeout_seconds = (
                    source.timeout_seconds
                    if "timeout_seconds" in source.model_fields_set
                    else body.timeout_seconds
                )
                for address_order, address in enumerate(source.addresses):
                    url = canonical_gallery_address(site, address.url)
                    await asyncio.to_thread(
                        _validate_network_target,
                        url,
                        container.settings.server.allow_private_targets,
                        strict=container.settings.server.strict_target_dns,
                    )
                    site_info = await asyncio.to_thread(container.resolver.resolve, url)
                    if site_info.supported:
                        _validate_site_match(site, site_info.site)
                    if site == "exhentai" and not re.search(
                        r"https?://(?:e-|ex)hentai\.org/g/\d+/[0-9a-f]{10}/?",
                        url,
                        re.I,
                    ):
                        raise ValueError("EH 来源地址必须是具体画廊 /g/GID/TOKEN/")
                    address_args = [*task_args, *address.extra_args]
                    container.gallery.validate_args(address_args)
                    if _range_argument_present(address_args):
                        raise ValueError("图片范围参数由单地址并发规划器管理")
                    flattened.append(
                        {
                            "id": str(uuid.uuid5(uuid.UUID(batch_id), f"{source_order}:{address_order}:{url}")),
                            "site": site,
                            "source_order": source_order,
                            "address_order": address_order,
                            "url": url,
                            "label": address.label or "",
                            "address_type": address.address_type or "",
                            "proxy_mode": mode,
                            "max_attempts": max_attempts,
                            "priority": priority,
                            "credentials_ref": credentials_ref,
                            "cookies_file": str(cookies) if cookies else None,
                            "config_file": str(config_file) if config_file else None,
                            "download_options": download_options,
                            "extra_args": address_args,
                            "discovery_args": discovery_args,
                            "timeout_seconds": timeout_seconds,
                        }
                    )
            batch_id, created = container.db.create_crawl_batch(
                {
                    "id": batch_id,
                    "output_dir": str(output_dir),
                    "concurrency": min(
                        body.concurrency,
                        container.settings.scheduler.max_concurrent_tasks,
                    ),
                    "max_tasks": body.max_tasks,
                },
                flattened,
                idempotency_key=base_key,
            )
            container.ordered_crawls.notify()
            result = container.db.get_crawl_batch(batch_id)
            if result is None:
                raise RuntimeError("顺序爬取批次创建后读取失败")
            result["created"] = created
            result["requested_concurrency"] = body.concurrency
            result["effective_concurrency"] = min(
                body.concurrency,
                container.settings.scheduler.max_concurrent_tasks,
            )
            return result, created
        except ValueError as exc:
            raise ApiError(422, "invalid_crawl", str(exc)) from exc

    @api.post("/crawls")
    async def create_crawl(
        body: CrawlRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        container: ServiceContainer = Depends(get_service),
    ):
        result, created = await _perform_crawl(
            body,
            container=container,
            idempotency_key=idempotency_key,
        )
        return JSONResponse(status_code=202 if created else 200, content=result)

    @api.get("/crawls")
    async def list_crawls(
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        container: ServiceContainer = Depends(get_service),
    ):
        return {
            "items": container.db.list_crawl_batches(limit=limit, offset=offset),
            "limit": limit,
            "offset": offset,
        }

    @api.get("/crawls/{batch_id}")
    async def get_crawl(batch_id: str, container: ServiceContainer = Depends(get_service)):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if (
            batch["status"] in {"succeeded", "completed_with_errors", "cancelled"}
            and batch.get("review") is None
        ):
            status = "not_started" if container.settings.dedup.enabled else "disabled"
            batch["review"] = {"batch_id": batch_id, "status": status}
        return batch

    @api.get("/crawls/{batch_id}/tasks")
    async def list_crawl_tasks(
        batch_id: str,
        address_id: str | None = None,
        limit: int = Query(default=100, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
        container: ServiceContainer = Depends(get_service),
    ):
        if container.db.get_crawl_batch(batch_id) is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        return {
            "items": container.db.list_crawl_tasks(
                batch_id,
                address_id=address_id,
                limit=limit,
                offset=offset,
            ),
            "limit": limit,
            "offset": offset,
        }

    @api.get("/crawls/{batch_id}/review")
    async def get_crawl_review(
        batch_id: str,
        kind: str | None = Query(default=None, pattern="^(duplicate|single|unreadable)$"),
        limit: int = Query(default=12, ge=1, le=50),
        offset: int = Query(default=0, ge=0),
        container: ServiceContainer = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
            raise ApiError(409, "crawl_not_finished", "爬取批次结束后才会进入图片审核")
        review = container.db.get_crawl_review(batch_id)
        if review is None:
            status = "not_started" if container.settings.dedup.enabled else "disabled"
            return {
                "batch_id": batch_id,
                "status": status,
                "groups": {"items": [], "total": 0, "limit": limit, "offset": offset},
            }
        page = {"items": [], "total": 0, "limit": limit, "offset": offset}
        if review["status"] in {"ready", "applying", "applied", "apply_failed"}:
            page = container.db.list_crawl_review_groups(
                batch_id,
                kind=kind,
                limit=limit,
                offset=offset,
            )
            for group in page["items"]:
                for image in group["images"]:
                    image["url"] = (
                        f"/api/v1/crawls/{batch_id}/review/images/{image['id']}"
                    )
        return {**review, "groups": page}

    @api.post("/crawls/{batch_id}/review/start", status_code=202)
    async def start_crawl_review(
        batch_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        if not container.settings.dedup.enabled:
            raise ApiError(409, "dedup_disabled", "去重功能未启用")
        try:
            return container.reviews.start_analysis(batch_id)
        except KeyError as exc:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @api.put("/crawls/{batch_id}/review/decisions")
    async def update_crawl_review_decisions(
        batch_id: str,
        body: ReviewDecisions,
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            container.db.update_crawl_review_decisions(
                batch_id,
                [group.model_dump() for group in body.groups],
            )
        except KeyError as exc:
            raise ApiError(404, "review_not_found", "审核批次或分组不存在") from exc
        except (RuntimeError, ValueError) as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc
        review = container.db.get_crawl_review(batch_id)
        if review is None:
            raise ApiError(404, "review_not_found", "审核批次不存在")
        return review

    @api.post("/crawls/{batch_id}/review/apply")
    async def apply_crawl_review(
        batch_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        if container.db.get_crawl_batch(batch_id) is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        try:
            return await asyncio.to_thread(container.reviews.apply, batch_id)
        except KeyError as exc:
            raise ApiError(404, "review_not_found", "审核批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @api.post("/crawls/{batch_id}/review/retry", status_code=202)
    async def retry_crawl_review(
        batch_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            retried = container.reviews.retry_analysis(batch_id)
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc
        if not retried:
            raise ApiError(404, "review_not_found", "审核批次不存在")
        return container.db.get_crawl_review(batch_id)

    @api.get("/crawls/{batch_id}/review/images/{image_id}")
    async def get_crawl_review_image(
        batch_id: str,
        image_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        image = container.db.get_crawl_review_image(batch_id, image_id)
        if image is None:
            raise ApiError(404, "review_image_not_found", "审核图片不存在")
        root = Path(image["output_dir"]).resolve()
        candidates = []
        if image.get("final_relative_path"):
            candidates.append(str(image["final_relative_path"]))
        candidates.append(str(image["relative_path"]))
        for relative_path in candidates:
            try:
                target = resolve_review_file(root, relative_path)
            except ValueError:
                continue
            if target.is_file():
                return FileResponse(target)
        raise ApiError(404, "review_image_not_found", "审核图片文件不存在")

    @api.post("/crawls/{batch_id}/cancel")
    async def cancel_crawl(batch_id: str, container: ServiceContainer = Depends(get_service)):
        batch, task_ids = container.db.request_cancel_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        for task_id in task_ids:
            await container.scheduler.cancel(task_id)
        container.ordered_crawls.notify()
        container.db.finish_crawl_batch_if_ready(batch_id)
        return container.db.get_crawl_batch(batch_id)

    @api.post("/crawls/{batch_id}/retry", status_code=202)
    async def retry_crawl_failed(
        batch_id: str,
        body: RetryRequest,
        container: ServiceContainer = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        # Same guard as /rerun: requeuing failed tasks pulls the batch back to running
        # and re-downloads into the batch's output_dir. If dedup review is mid-flight it
        # is scanning/moving that same tree, so the two would corrupt each other.
        if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
            raise ApiError(409, "crawl_not_finished", "批次仍在运行，结束后才能重试失败任务")
        review = batch.get("review")
        if review is not None and review.get("status") in _REVIEW_IN_FLIGHT:
            raise ApiError(409, "review_in_progress", "图片审核进行中，结束后才能重试失败任务")
        result = container.db.retry_failed_crawl_tasks(
            batch_id,
            body.additional_attempts,
        )
        if result is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if not result["retried_count"] and not result.get("replanned_address_count"):
            raise ApiError(
                409,
                "crawl_no_failed_tasks",
                "批次没有可重新排队的失败任务或待重规划的地址",
            )
        container.scheduler.notify()
        container.ordered_crawls.notify()
        for address_id in result.get("address_ids", []):
            container.db.finish_crawl_address_if_terminal(address_id)
        container.db.finish_crawl_batch_if_ready(batch_id)
        return {
            **result,
            "batch": container.db.get_crawl_batch(batch_id),
        }

    # Review states in which a background worker is actively scanning or moving the
    # batch's files. Re-crawling under any of these would race the analysis/apply, so
    # the rerun endpoint blocks them. A stale finished review (ready/applied/failed/
    # apply_failed/waiting_for_crawl) does not touch files and must not block.
    _REVIEW_IN_FLIGHT = {"pending", "analyzing", "applying", "auto_applying"}

    @api.post("/crawls/{batch_id}/rerun", status_code=202)
    async def rerun_crawl(
        batch_id: str,
        body: CrawlRerunRequest,
        container: ServiceContainer = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
            raise ApiError(409, "crawl_not_finished", "批次仍在运行，结束后才能重新爬取")
        review = batch.get("review")
        if review is not None and review.get("status") in _REVIEW_IN_FLIGHT:
            raise ApiError(409, "review_in_progress", "图片审核进行中，结束后才能重新爬取")
        result = container.db.rerun_crawl_batch(
            batch_id,
            body.additional_attempts,
            requeue_succeeded=body.requeue_succeeded,
        )
        if result is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if result.get("not_terminal"):
            raise ApiError(409, "crawl_not_finished", "批次仍在运行，结束后才能重新爬取")
        container.scheduler.notify()
        container.ordered_crawls.notify()
        return {
            **result,
            "batch": container.db.get_crawl_batch(batch_id),
        }

    @api.get("/tasks")
    async def list_tasks(
        status: str | None = None,
        site: str | None = None,
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        container: ServiceContainer = Depends(get_service),
    ):
        items = container.db.list_tasks(status=status, site=site, limit=limit, offset=offset)
        return {"items": items, "limit": limit, "offset": offset}

    @api.get("/tasks/{task_id}")
    async def get_task(task_id: str, container: ServiceContainer = Depends(get_service)):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @api.post("/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str, container: ServiceContainer = Depends(get_service)):
        task = await container.scheduler.cancel(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @api.post("/tasks/{task_id}/retry", status_code=202)
    async def retry_task(task_id: str, body: RetryRequest, container: ServiceContainer = Depends(get_service)):
        # A crawl media task retried in isolation would rerun into the batch's output_dir
        # without ever refreshing the owning address/batch counters (they only settle via
        # the crawl-level retry/finish paths), leaving the batch stuck showing a failed
        # task forever. Route these back through /crawls/{id}/retry.
        crawl_batch_id = container.db.task_crawl_batch_id(task_id)
        if crawl_batch_id is not None:
            raise ApiError(
                409,
                "task_belongs_to_crawl",
                f"该任务属于爬取批次，请通过 /crawls/{crawl_batch_id}/retry 重试以保持批次统计一致",
            )
        try:
            task = container.scheduler.retry(task_id, body.additional_attempts)
        except RuntimeError as exc:
            raise ApiError(409, "task_state_conflict", str(exc)) from exc
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @api.get("/tasks/{task_id}/logs")
    async def task_logs(
        task_id: str,
        since: int = Query(default=0, ge=0),
        tail: int | None = Query(default=None, ge=1, le=5000),
        limit: int = Query(default=1000, ge=1, le=5000),
        container: ServiceContainer = Depends(get_service),
    ):
        if container.db.get_task(task_id) is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {"items": container.db.get_logs(task_id, since=since, tail=tail, limit=limit)}

    @api.get("/tasks/{task_id}/events")
    async def task_events(
        task_id: str,
        since: int = Query(default=0, ge=0),
        limit: int = Query(default=1000, ge=1, le=5000),
        container: ServiceContainer = Depends(get_service),
    ):
        if container.db.get_task(task_id) is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {"items": container.db.get_events(task_id, since=since, limit=limit)}

    @api.get("/tasks/{task_id}/files")
    async def list_task_files(task_id: str, container: ServiceContainer = Depends(get_service)):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {"items": await asyncio.to_thread(_task_files, task)}

    @api.get("/tasks/{task_id}/files/{relative_path:path}")
    async def download_task_file(task_id: str, relative_path: str, container: ServiceContainer = Depends(get_service)):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        root_dir = Path(task["output_dir"]).resolve()
        unresolved = root_dir / relative_path
        cursor = root_dir
        for part in Path(relative_path).parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ApiError(404, "file_not_found", "任务文件不存在")
        target = unresolved.resolve()
        if not (target == root_dir or target.is_relative_to(root_dir)) or not target.is_file():
            raise ApiError(404, "file_not_found", "任务文件不存在")
        return FileResponse(target)

    def _require_policy_site(name: str) -> None:
        if not is_policy_site(name):
            raise ApiError(
                422,
                "unsupported_policy_site",
                "该站点不能在此处设置",
            )

    def _raise_policy_store_error(exc: Exception) -> None:
        raise ApiError(
            503,
            "policy_store_error",
            "站点设置暂时无法保存或读取",
        ) from exc

    def _legacy_policy_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        projected: list[dict[str, Any]] = []
        for item in items:
            site = item.get("site")
            if not isinstance(site, str) or not is_policy_site(site):
                continue
            projected.append(
                {
                    "site": site,
                    "policy": safe_policy_dict(item.get("policy")),
                    "updated_at": item.get("updated_at"),
                }
            )
        return projected

    @api.get("/sites/policies")
    async def site_policies(
        view: PolicyResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        try:
            stored = container.db.list_site_policies()
            if view == "legacy":
                return {
                    "default": safe_policy_dict(container.settings.default_site_policy),
                    "items": _legacy_policy_items(stored),
                }
            return policy_view_snapshot(
                container.settings.default_site_policy,
                stored,
            )
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)

    @api.get("/sites/policies/{site}")
    async def get_site_policy(
        site: str,
        view: PolicyResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        name = _validate_site_name(site)
        _require_policy_site(name)
        try:
            stored = container.db.get_site_policy(name)
            if view == "legacy":
                if stored is not None:
                    return {
                        "site": name,
                        "policy": safe_policy_dict(stored.get("policy")),
                        "updated_at": stored.get("updated_at"),
                    }
                return {
                    "site": name,
                    "policy": safe_policy_dict(container.settings.default_site_policy),
                    "inherited": True,
                }
            if stored is None:
                return policy_view_item(
                    name,
                    container.settings.default_site_policy,
                    inherited=True,
                )
            return policy_view_item(
                name,
                stored.get("policy"),
                inherited=False,
                updated_at=stored.get("updated_at"),
            )
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)

    @api.put("/sites/policies/{site}")
    async def put_site_policy(
        site: str,
        body: EditableSitePolicy,
        view: PolicyResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_policy_body_limit),
    ):
        name = _validate_site_name(site)
        _require_policy_site(name)
        try:
            policy = safe_policy_dict(body, require_complete=True)
        except PolicyViewValidationError as exc:
            raise ApiError(
                422,
                "invalid_policy",
                "站点设置中有不支持或不正确的字段",
                exc.safe_details(),
            ) from exc
        try:
            stored = container.db.put_site_policy(name, policy)
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)
        if view == "legacy":
            return stored
        return policy_view_item(
            name,
            stored["policy"],
            inherited=False,
            updated_at=stored.get("updated_at"),
        )

    @api.delete("/sites/policies/{site}")
    async def delete_site_policy(
        site: str,
        view: PolicyResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        name = _validate_site_name(site)
        _require_policy_site(name)
        try:
            deleted = container.db.delete_site_policy(name)
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)
        if not deleted:
            raise ApiError(404, "site_policy_not_found", "该站点没有单独保存的设置")
        if view == "policy":
            return {
                "response_profile": POLICY_RESPONSE_PROFILE,
                "deleted": True,
                "site": name,
            }
        return {"deleted": True, "site": name}

    def _raise_proxy_source_error(exc: ProxySourceStoreError) -> None:
        if isinstance(exc, ProxySourceNotFound):
            raise ApiError(404, "proxy_source_not_found", exc.message) from exc
        if isinstance(exc, ProxySourcePathForbidden):
            raise ApiError(
                422,
                "proxy_source_path_forbidden",
                exc.message,
                exc.details,
            ) from exc
        if isinstance(exc, ProxySourceValidationError):
            code = {
                "subscription": "invalid_proxy_subscription",
                "inline_node": "invalid_proxy_inline_node",
                "node_file": "invalid_proxy_node_file",
                "source_id": "invalid_proxy_source_id",
            }[exc.category]
            raise ApiError(422, code, exc.message, exc.details) from exc
        if isinstance(exc, (ProxySourceStoreCorrupt, ProxySourceStoreConflict)):
            raise ApiError(
                409,
                "proxy_sources_store_error",
                exc.message,
                {"reason": exc.reason},
            ) from exc
        raise ApiError(
            503,
            "proxy_sources_store_error",
            exc.message,
            {"reason": exc.reason},
        ) from exc

    async def _proxy_sources_response(
        container: ServiceContainer,
        snapshot: ProxySourceSnapshot | None = None,
    ) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(
                container.proxy_sources.public_snapshot,
                snapshot,
                active_revision=container.proxy.active_revision,
            )
        except ProxySourceStoreError as exc:
            _raise_proxy_source_error(exc)
            raise AssertionError("unreachable")

    async def _proxy_source_change(
        container: ServiceContainer,
        call,
    ) -> dict[str, Any]:
        try:
            snapshot = await asyncio.to_thread(call)
        except ProxySourceStoreError as exc:
            _raise_proxy_source_error(exc)
            raise AssertionError("unreachable")
        return await _proxy_sources_response(container, snapshot)

    @api.get("/proxy/sources")
    async def proxy_sources(container: ServiceContainer = Depends(get_service)):
        return await _proxy_sources_response(container)

    @api.post("/proxy/sources/subscriptions")
    async def add_proxy_subscription(
        body: ProxySubscriptionUpdate,
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.add_subscription(body.url),
        )

    @api.put("/proxy/sources/subscriptions/{source_id}")
    async def replace_proxy_subscription(
        source_id: str,
        body: ProxySubscriptionUpdate,
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_subscription(source_id, body.url),
        )

    @api.delete("/proxy/sources/subscriptions/{source_id}")
    async def delete_proxy_subscription(
        source_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_subscription(source_id),
        )

    @api.put("/proxy/sources/node-file")
    async def set_proxy_node_file(
        body: ProxyNodeFileUpdate,
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.set_node_file(body.path),
        )

    @api.delete("/proxy/sources/node-file")
    async def clear_proxy_node_file(
        container: ServiceContainer = Depends(get_service),
    ):
        return await _proxy_source_change(
            container,
            container.proxy_sources.clear_node_file,
        )

    @api.post("/proxy/sources/inline-nodes")
    async def add_proxy_inline_nodes(
        body: ProxyInlineNodesCreate,
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.add_inline_nodes(body.nodes),
        )

    @api.put("/proxy/sources/inline-nodes/{source_id}")
    async def replace_proxy_inline_node(
        source_id: str,
        body: ProxyInlineNodeUpdate,
        container: ServiceContainer = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_inline_node(source_id, body.node),
        )

    @api.delete("/proxy/sources/inline-nodes/{source_id}")
    async def delete_proxy_inline_node(
        source_id: str,
        container: ServiceContainer = Depends(get_service),
    ):
        return await _proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_inline_node(source_id),
        )

    @api.delete("/proxy/sources/override")
    async def reset_proxy_sources_override(
        container: ServiceContainer = Depends(get_service),
    ):
        return await _proxy_source_change(
            container,
            container.proxy_sources.reset_override,
        )

    @api.get("/proxy/status")
    async def proxy_status(container: ServiceContainer = Depends(get_service)):
        return await asyncio.to_thread(container.proxy.status)

    async def _proxy_action(call):
        try:
            return await asyncio.to_thread(call)
        except ProxyPoolConflict as exc:
            raise ApiError(409, "proxy_conflict", str(exc)) from exc
        except (ProxyPoolError, FileNotFoundError, ValueError, RuntimeError) as exc:
            raise ApiError(503, "proxy_error", redact_text(exc, limit=500)) from exc

    @api.post("/proxy/start")
    async def proxy_start(body: ProxyStartRequest, container: ServiceContainer = Depends(get_service)):
        return await _proxy_action(
            lambda: container.proxy.start(force_refresh=body.force_refresh, probe_url=body.probe_url)
        )

    @api.post("/proxy/reload")
    async def proxy_reload(body: ProxyStartRequest, container: ServiceContainer = Depends(get_service)):
        return await _proxy_action(
            lambda: container.proxy.reload(force_refresh=body.force_refresh, probe_url=body.probe_url)
        )

    @api.post("/proxy/stop")
    async def proxy_stop(body: ProxyStopRequest, container: ServiceContainer = Depends(get_service)):
        return await _proxy_action(lambda: container.proxy.stop(force=body.force))

    @api.post("/proxy/probe")
    async def proxy_probe(body: ProxyProbeRequest, container: ServiceContainer = Depends(get_service)):
        target = body.target_url
        if body.site and not target:
            target = container.policy_for(_validate_site_name(body.site)).probe_url
        if target:
            try:
                await asyncio.to_thread(
                    _validate_network_target,
                    target,
                    container.settings.server.allow_private_targets,
                    strict=container.settings.server.strict_target_dns,
                )
            except ValueError as exc:
                raise ApiError(422, "invalid_probe_target", str(exc)) from exc
        return await _proxy_action(lambda: container.proxy.probe(target_url=target, node_id=body.node_id))

    @api.get("/scheduler/status")
    async def scheduler_status(
        view: DiagnosticsResponseView = Query("legacy"),
        container: ServiceContainer = Depends(get_service),
    ):
        tasks = container.scheduler.active_summary()
        ordered_crawls = container.ordered_crawls.status()
        if view == "diagnostics":
            return diagnostics_scheduler_snapshot(tasks, ordered_crawls)
        return {
            "tasks": tasks,
            "ordered_crawls": ordered_crawls,
        }

    app.include_router(api)
    return app
