from __future__ import annotations

import ipaddress
import math
import re
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

from .schemas import SitePolicy


POLICY_RESPONSE_PROFILE = "policy"
MAX_POLICY_REQUEST_BYTES = 16 * 1024
MAX_POLICY_PROBE_URL_LENGTH = 2048
MAX_POLICY_NODE_TAG_LENGTH = 64
MAX_POLICY_EXTRA_ARG_LENGTH = 512
MAX_POLICY_EXTRA_ARGS_TOTAL_CHARS = 8192

POLICY_SITE_IDS = (
    "danbooru",
    "twitter",
    "pixiv",
    "exhentai",
    "pawchive",
)

_POLICY_SITE_DEFINITIONS = {
    "danbooru": ("Danbooru", "anonymous"),
    "twitter": ("X / Twitter", "managed_browser"),
    "pixiv": ("Pixiv", "oauth"),
    "exhentai": ("EH", "managed_browser_for_private_content"),
    "pawchive": ("Pawchive", "anonymous"),
}
_POLICY_FIELDS = frozenset(SitePolicy.model_fields)
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ABSOLUTE_PATH = re.compile(
    r"(?:^|[\s=])(?:[A-Za-z]:[\\/]|/[^/\s]|\\\\[^\\\s]+\\)",
)
_URL_LIKE = re.compile(r"[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?:^|[^a-z0-9_])(?:token|cookie|password|secret|authorization|api[_-]?key)\s*[:=]",
    re.IGNORECASE,
)
_SAFE_REASON_CODES = frozenset(
    {
        "control_characters",
        "too_long",
        "too_many_items",
        "total_too_large",
        "absolute_path",
        "url_not_allowed",
        "url_credentials",
        "url_query_or_fragment",
        "url_host_invalid",
        "url_target_forbidden",
        "sensitive_assignment",
        "forbidden_gallery_arg",
        "invalid_policy",
        "missing_field",
    }
)


class PolicyViewValidationError(ValueError):
    """POLICY profile 的受控校验错误，不携带用户原文。"""

    def __init__(
        self,
        field: str,
        reason: str,
        *,
        index: int | None = None,
    ) -> None:
        safe_field = field if field in _POLICY_FIELDS else "policy"
        safe_reason = reason if reason in _SAFE_REASON_CODES else "invalid_policy"
        super().__init__(f"{safe_field}: {safe_reason}")
        self.field = safe_field
        self.reason = safe_reason
        self.index = index if isinstance(index, int) and index >= 0 else None

    def safe_details(self) -> dict[str, Any]:
        details: dict[str, Any] = {
            "field": self.field,
            "reason": self.reason,
        }
        if self.index is not None:
            details["index"] = self.index
        return details


def is_policy_site(site: str) -> bool:
    return site in _POLICY_SITE_DEFINITIONS


def policy_site_definition(site: str) -> dict[str, Any]:
    try:
        label, authorization = _POLICY_SITE_DEFINITIONS[site]
    except KeyError as exc:
        raise ValueError("POLICY 不支持该来源") from exc
    return {
        "site": site,
        "label": label,
        "supported": True,
        "authorization": authorization,
        "selection_mode": "per_request",
        "availability": "not_probed",
    }


def _validate_plain_text(
    value: str,
    *,
    field: str,
    index: int,
    maximum: int,
    reject_urls: bool = True,
) -> None:
    if _CONTROL_CHARACTERS.search(value):
        raise PolicyViewValidationError(field, "control_characters", index=index)
    if len(value) > maximum:
        raise PolicyViewValidationError(field, "too_long", index=index)
    if _ABSOLUTE_PATH.search(value):
        raise PolicyViewValidationError(field, "absolute_path", index=index)
    if reject_urls and _URL_LIKE.search(value):
        raise PolicyViewValidationError(field, "url_not_allowed", index=index)
    if _SENSITIVE_ASSIGNMENT.search(value):
        raise PolicyViewValidationError(field, "sensitive_assignment", index=index)


def _validate_probe_url(value: str | None) -> None:
    if value is None:
        return
    if len(value) > MAX_POLICY_PROBE_URL_LENGTH:
        raise PolicyViewValidationError("probe_url", "too_long")
    if _CONTROL_CHARACTERS.search(value) or any(char.isspace() for char in value):
        raise PolicyViewValidationError("probe_url", "control_characters")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise PolicyViewValidationError("probe_url", "url_host_invalid") from exc
    if parsed.scheme.lower() != "https" or not hostname or not parsed.netloc:
        raise PolicyViewValidationError("probe_url", "url_host_invalid")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise PolicyViewValidationError("probe_url", "url_credentials")
    if parsed.query or parsed.fragment:
        raise PolicyViewValidationError("probe_url", "url_query_or_fragment")
    if port is not None and not 1 <= port <= 65535:
        raise PolicyViewValidationError("probe_url", "url_host_invalid")
    normalized_host = hostname.rstrip(".").lower()
    if normalized_host in {"localhost", "localhost.localdomain"} or normalized_host.endswith(".local"):
        raise PolicyViewValidationError("probe_url", "url_target_forbidden")
    try:
        literal = ipaddress.ip_address(normalized_host.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        raise PolicyViewValidationError("probe_url", "url_target_forbidden")


def _validate_node_tags(values: list[str]) -> None:
    if len(values) > 32:
        raise PolicyViewValidationError("node_tags", "too_many_items")
    for index, value in enumerate(values):
        _validate_plain_text(
            value,
            field="node_tags",
            index=index,
            maximum=MAX_POLICY_NODE_TAG_LENGTH,
        )


def _validate_extra_args(
    values: list[str],
    validate_gallery_args: Callable[[list[str]], Any],
) -> None:
    if len(values) > 128:
        raise PolicyViewValidationError("extra_args", "too_many_items")
    total = 0
    for index, value in enumerate(values):
        total += len(value)
        _validate_plain_text(
            value,
            field="extra_args",
            index=index,
            maximum=MAX_POLICY_EXTRA_ARG_LENGTH,
        )
    if total > MAX_POLICY_EXTRA_ARGS_TOTAL_CHARS:
        raise PolicyViewValidationError("extra_args", "total_too_large")
    try:
        validate_gallery_args(values)
    except ValueError as exc:
        raise PolicyViewValidationError("extra_args", "forbidden_gallery_arg") from exc


def safe_policy_dict(
    value: SitePolicy | dict[str, Any],
    *,
    validate_gallery_args: Callable[[list[str]], Any],
    require_complete: bool = False,
) -> dict[str, Any]:
    """校验并复制桌面 WebUI 可读取/回写的完整 SitePolicy 白名单。"""

    if require_complete and isinstance(value, SitePolicy):
        missing = [field for field in SitePolicy.model_fields if field not in value.model_fields_set]
        if missing:
            raise PolicyViewValidationError(missing[0], "missing_field")
    try:
        policy = value if isinstance(value, SitePolicy) else SitePolicy.model_validate(value)
    except (TypeError, ValueError) as exc:
        raise PolicyViewValidationError("policy", "invalid_policy") from exc
    _validate_probe_url(policy.probe_url)
    _validate_node_tags(policy.node_tags)
    _validate_extra_args(policy.extra_args, validate_gallery_args)
    # model_dump 只包含 SitePolicy 已声明字段；复制列表/子对象，避免返回数据库对象引用。
    return policy.model_dump()


def _safe_timestamp(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and 0 <= number <= 4_102_444_800 else None


def _policy_state(
    value: SitePolicy | dict[str, Any],
    *,
    reason: str,
    validate_gallery_args: Callable[[list[str]], Any],
) -> dict[str, Any]:
    try:
        policy = safe_policy_dict(value, validate_gallery_args=validate_gallery_args)
    except PolicyViewValidationError:
        return {"editable": False, "reason": reason, "policy": None}
    return {"editable": True, "reason": "", "policy": policy}


def policy_view_item(
    site: str,
    value: SitePolicy | dict[str, Any],
    *,
    inherited: bool,
    updated_at: Any = None,
    validate_gallery_args: Callable[[list[str]], Any],
) -> dict[str, Any]:
    definition = policy_site_definition(site)
    state = _policy_state(
        value,
        reason="unsafe_stored_policy" if not inherited else "unsafe_default_policy",
        validate_gallery_args=validate_gallery_args,
    )
    return {
        **definition,
        "inherited": bool(inherited),
        "has_override": not inherited,
        "editable": state["editable"],
        "reason": state["reason"],
        "updated_at": None if inherited else _safe_timestamp(updated_at),
        "policy": state["policy"],
    }


def policy_view_snapshot(
    default_policy: SitePolicy | dict[str, Any],
    stored_items: Iterable[dict[str, Any]],
    *,
    validate_gallery_args: Callable[[list[str]], Any],
) -> dict[str, Any]:
    """构造 POLICY 专用原子最小投影；未知站点只计数，不回显 ID 或配置。"""

    default_state = _policy_state(
        default_policy,
        reason="unsafe_default_policy",
        validate_gallery_args=validate_gallery_args,
    )
    by_site: dict[str, dict[str, Any]] = {}
    unknown_override_count = 0
    for raw in stored_items:
        if not isinstance(raw, dict):
            unknown_override_count += 1
            continue
        site = raw.get("site")
        if not isinstance(site, str) or site not in _POLICY_SITE_DEFINITIONS:
            unknown_override_count += 1
            continue
        by_site[site] = raw

    items: list[dict[str, Any]] = []
    for site in POLICY_SITE_IDS:
        stored = by_site.get(site)
        if stored is None:
            if default_state["editable"]:
                items.append(
                    policy_view_item(
                        site,
                        default_state["policy"],
                        inherited=True,
                        validate_gallery_args=validate_gallery_args,
                    )
                )
            else:
                items.append(
                    {
                        **policy_site_definition(site),
                        "inherited": True,
                        "has_override": False,
                        "editable": False,
                        "reason": "unsafe_default_policy",
                        "updated_at": None,
                        "policy": None,
                    }
                )
            continue
        items.append(
            policy_view_item(
                site,
                stored.get("policy"),
                inherited=False,
                updated_at=stored.get("updated_at"),
                validate_gallery_args=validate_gallery_args,
            )
        )

    return {
        "response_profile": POLICY_RESPONSE_PROFILE,
        "secrets_exposed": False,
        "effect_scope": "new_requests_and_tasks",
        "concurrency_protection": "none",
        "default_source": "startup_snapshot",
        "persistence": "sqlite_atomic",
        "default": default_state,
        "items": items,
        "unknown_override_count": unknown_override_count,
    }
