from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from .site_policy import EDITABLE_SITE_POLICY_FIELDS, EditableSitePolicy


POLICY_RESPONSE_PROFILE = "policy"
MAX_POLICY_REQUEST_BYTES = 16 * 1024

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
_POLICY_FIELDS = frozenset(EDITABLE_SITE_POLICY_FIELDS)
_SAFE_REASON_CODES = frozenset({"invalid_policy", "missing_field"})


class PolicyViewValidationError(ValueError):
    """站点设置的受控校验错误，不携带用户提交的原文。"""

    def __init__(self, field: str, reason: str) -> None:
        safe_field = field if field in _POLICY_FIELDS else "policy"
        safe_reason = reason if reason in _SAFE_REASON_CODES else "invalid_policy"
        super().__init__(f"{safe_field}: {safe_reason}")
        self.field = safe_field
        self.reason = safe_reason

    def safe_details(self) -> dict[str, str]:
        return {"field": self.field, "reason": self.reason}


def is_policy_site(site: str) -> bool:
    return site in _POLICY_SITE_DEFINITIONS


def policy_site_definition(site: str) -> dict[str, Any]:
    try:
        label, authorization = _POLICY_SITE_DEFINITIONS[site]
    except KeyError as exc:
        raise ValueError("该站点不受支持") from exc
    return {
        "site": site,
        "label": label,
        "supported": True,
        # 以下受控枚举供旧客户端识别来源；简化页面不会展示这些工程信息。
        "authorization": authorization,
        "selection_mode": "per_request",
        "availability": "not_probed",
    }


def safe_policy_dict(
    value: EditableSitePolicy | dict[str, Any],
    *,
    require_complete: bool = False,
) -> dict[str, Any]:
    """严格校验并复制站点设置唯一允许读写的四字段模型。"""

    if require_complete and isinstance(value, EditableSitePolicy):
        missing = [
            field
            for field in EDITABLE_SITE_POLICY_FIELDS
            if field not in value.model_fields_set
        ]
        if missing:
            raise PolicyViewValidationError(missing[0], "missing_field")
    try:
        policy = (
            value
            if isinstance(value, EditableSitePolicy)
            else EditableSitePolicy.model_validate(value)
        )
    except (TypeError, ValueError) as exc:
        raise PolicyViewValidationError("policy", "invalid_policy") from exc
    return policy.model_dump()


def _safe_timestamp(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and 0 <= number <= 4_102_444_800 else None


def _policy_state(
    value: EditableSitePolicy | dict[str, Any],
    *,
    reason: str,
) -> dict[str, Any]:
    try:
        policy = safe_policy_dict(value)
    except PolicyViewValidationError:
        return {"editable": False, "reason": reason, "policy": None}
    return {"editable": True, "reason": "", "policy": policy}


def policy_view_item(
    site: str,
    value: EditableSitePolicy | dict[str, Any],
    *,
    inherited: bool,
    updated_at: Any = None,
) -> dict[str, Any]:
    definition = policy_site_definition(site)
    state = _policy_state(
        value,
        reason="unsafe_stored_policy" if not inherited else "unsafe_default_policy",
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
    default_policy: EditableSitePolicy | dict[str, Any],
    stored_items: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """构造五站四字段快照；未知数据库记录只计数，不读取到页面。"""

    default_state = _policy_state(
        default_policy,
        reason="unsafe_default_policy",
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
