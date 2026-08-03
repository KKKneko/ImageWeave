from __future__ import annotations

from dataclasses import dataclass

from .redaction import redact_text


@dataclass(slots=True)
class FailureDecision:
    error_class: str
    retryable: bool
    proxy_fault: bool
    message: str


_PROXY_MARKERS = (
    "proxyerror",
    "proxy error",
    "tunnel connection failed",
    "connect tunnel failed",
    "proxy authentication required",
    "407 proxy",
    "socks error",
    "connection refused",
    "connection aborted",
    "connection reset",
    "connectionreseterror",
    "failed to establish a new connection",
    "tls handshake",
    "ssl handshake",
    "sslerror",
    "ssleoferror",
    "unexpected_eof_while_reading",
    "eof occurred in violation of protocol",
    "remote end closed connection without response",
    "cloudflare challenge",
    "just a moment...",
)
_AUTH_MARKERS = (
    "authenticationerror",
    "authorizationerror",
    "authrequired",
    "invalid login",
    "login required",
    "credentials required",
    "authenticated cookies needed",
    "could not authenticate you",
    "not authenticated",
    "insufficient privileges",
)
_PROXY_ACCESS_MARKERS = (
    "insufficient privileges to access this resource",
)
_NOT_FOUND_MARKERS = ("notfounderror", "could not be found", "404 not found")
_TRANSIENT_SITE_MARKERS = (
    "429 too many requests",
    "rate limit",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "temporarily unavailable",
)
_CONTINUATION_MARKERS = (
    "as input url to continue downloading from the current position",
    "as input url to continue downloading from current position",
)


def classify_result(
    exit_code: int | None,
    output_tail: str,
    *,
    cancelled: bool = False,
    timed_out: bool = False,
) -> FailureDecision:
    text = str(output_tail or "")
    lower = text.lower()
    message = redact_text(text.strip().splitlines()[-1] if text.strip() else "gallery-dl 任务失败", limit=1000)

    if cancelled:
        return FailureDecision("cancelled", False, False, "任务已取消")
    proxy_fault = any(marker in lower for marker in _PROXY_MARKERS)
    if timed_out:
        return FailureDecision("task_timeout", True, proxy_fault, "任务超过执行时限")
    if exit_code == 0:
        return FailureDecision("success", False, False, "")
    code = int(exit_code or 0)
    # gallery-dl's main() maps a top-level NoExtractorError to exit bit 64
    # (__init__.py: `retval |= 64`), NOT to NoExtractorError.code (32) — so this
    # branch is the authoritative signal for an unsupported input URL and must
    # stay. The text fallback additionally catches a NoExtractorError that
    # surfaces mid-run (e.g. a child extractor) and only prints "Unsupported URL".
    if code & 64 or "unsupported url" in lower:
        return FailureDecision("unsupported_url", False, False, message)
    if code & 32:
        return FailureDecision("input_error", False, False, message)
    if any(marker in lower for marker in _PROXY_ACCESS_MARKERS):
        return FailureDecision("proxy_access_failure", True, True, message)
    if code & 16 or any(marker in lower for marker in _AUTH_MARKERS):
        return FailureDecision("authentication", False, False, message)
    if code & 8:
        # ChallengeError (Cloudflare / DDoS-Guard challenge) — exception.py sets
        # ChallengeError.code = 8, OR-accumulated into the exit status by job.py.
        # A challenge is proxy/IP-specific, so rotate to another node and retry:
        # proxy_fault=True marks the current node tried, retryable=True requeues.
        # Checked before code & 4 so a combined status (e.g. 8|4=12) stays a challenge.
        return FailureDecision("cloudflare_challenge", True, True, message)
    if any(marker in lower for marker in _NOT_FOUND_MARKERS):
        return FailureDecision("not_found", False, False, message)
    if any(marker in lower for marker in _CONTINUATION_MARKERS):
        return FailureDecision("download_error", True, proxy_fault, message)
    if proxy_fault:
        return FailureDecision("proxy_failure", True, True, message)
    if any(marker in lower for marker in _TRANSIENT_SITE_MARKERS):
        return FailureDecision("site_transient", True, False, message)
    if "timed out" in lower or "timeout" in lower:
        return FailureDecision("network_timeout", True, False, message)
    if code & 128:
        return FailureDecision("download_error", True, False, message)
    if code & 4:
        return FailureDecision("extraction_error", False, False, message)
    return FailureDecision("gallery_error", False, False, message)
