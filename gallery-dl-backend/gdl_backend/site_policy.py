from __future__ import annotations

from types import MappingProxyType
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ProxyMode = Literal["direct", "prefer", "required"]

EDITABLE_SITE_POLICY_FIELDS = (
    "max_concurrency",
    "retry_limit",
    "backoff_base_seconds",
    "proxy_mode",
)
DEFAULT_EDITABLE_SITE_POLICY = MappingProxyType(
    {
        "max_concurrency": 20,
        "retry_limit": 2,
        "backoff_base_seconds": 2.0,
        "proxy_mode": "prefer",
    }
)


class EditableSitePolicy(BaseModel):
    """POLICY API 与站点覆盖唯一允许编辑的四个字段。"""

    model_config = ConfigDict(extra="forbid")

    max_concurrency: int = Field(default=20, ge=1, le=128, strict=True)
    retry_limit: int = Field(default=2, ge=0, le=20, strict=True)
    backoff_base_seconds: float = Field(
        default=2.0,
        ge=0.0,
        le=3600.0,
        strict=True,
    )
    proxy_mode: ProxyMode = "prefer"
