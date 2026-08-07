from __future__ import annotations

import json
import requests
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from gdl_backend.encrypted_dns import (
    EncryptedDNSError,
    EncryptedDNSResolver,
    NetworkTargetValidator,
    normalize_doh_endpoint,
)


class _Response:
    def __init__(
        self,
        body: bytes = b"",
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        chunks: list[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body
        self._chunks = chunks
        self.closed = False

    def iter_content(self, chunk_size: int = 8192):
        del chunk_size
        yield from self._chunks if self._chunks is not None else [self._body]

    def close(self) -> None:
        self.closed = True


class _Session:
    def __init__(self, outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, dict]] = []
        self.trust_env = True
        self.closed = False

    def get(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def close(self) -> None:
        self.closed = True


def _dns_body(
    hostname: str,
    query_type: int,
    addresses: list[str] | None = None,
    *,
    status: int = 0,
    question_hostname: str | None = None,
    answers: list[dict] | None = None,
) -> bytes:
    payload = {
        "Status": status,
        "TC": False,
        "Question": [
            {
                "name": question_hostname or hostname,
                "type": query_type,
            }
        ],
        "Answer": answers
        if answers is not None
        else [
            {
                "name": hostname,
                "type": query_type,
                "TTL": 60,
                "data": address,
            }
            for address in addresses or []
        ],
    }
    return json.dumps(payload).encode("utf-8")


def _dns_record(name: str, record_type: int, data: str) -> dict:
    return {"name": name, "type": record_type, "TTL": 60, "data": data}


class _MonotonicClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = float(now)

    def __call__(self) -> float:
        return self.now


class EncryptedDNSResolverTests(unittest.TestCase):
    hostname = "images.example"
    proxy_url = "http://127.0.0.1:29077"

    def _resolver(self, outcomes, *, max_response_bytes: int = 65536):
        session = _Session(outcomes)
        resolver = EncryptedDNSResolver(
            endpoint="https://dns.example/dns-query",
            timeout_seconds=4.5,
            max_response_bytes=max_response_bytes,
            session_factory=lambda: session,
        )
        return resolver, session

    def test_a_and_aaaa_public_answers_use_one_secure_proxy_session(self):
        a = _Response(_dns_body(self.hostname, 1, ["1.1.1.1"]))
        aaaa = _Response(
            _dns_body(self.hostname, 28, ["2001:4860:4860::8888"])
        )
        resolver, session = self._resolver([a, aaaa])

        addresses = resolver.resolve(self.hostname, proxy_url=self.proxy_url)

        self.assertEqual(addresses, ("1.1.1.1", "2001:4860:4860::8888"))
        self.assertFalse(session.trust_env)
        self.assertTrue(session.closed)
        self.assertTrue(a.closed)
        self.assertTrue(aaaa.closed)
        self.assertEqual([call[1]["params"]["type"] for call in session.calls], ["A", "AAAA"])
        for url, kwargs in session.calls:
            self.assertEqual(url, "https://dns.example/dns-query")
            self.assertEqual(
                kwargs["proxies"],
                {"http": self.proxy_url, "https": self.proxy_url},
            )
            self.assertEqual(kwargs["timeout"], 4.5)
            self.assertEqual(kwargs["headers"], {"Accept": "application/dns-json"})
            self.assertFalse(kwargs["allow_redirects"])
            self.assertTrue(kwargs["stream"])
            self.assertTrue(kwargs["verify"])

    def test_empty_aaaa_is_accepted_when_a_returns_public_address(self):
        resolver, session = self._resolver(
            [
                _Response(_dns_body(self.hostname, 1, ["8.8.8.8"])),
                _Response(_dns_body(self.hostname, 28, [])),
            ]
        )

        self.assertEqual(
            resolver.resolve(self.hostname, proxy_url=self.proxy_url),
            ("8.8.8.8",),
        )
        self.assertEqual(len(session.calls), 2)

    def test_direct_owner_address_is_selected_from_mixed_answers(self):
        resolver, _session = self._resolver(
            [
                _Response(
                    _dns_body(
                        self.hostname,
                        1,
                        answers=[
                            _dns_record("unrelated.example", 1, "9.9.9.9"),
                            _dns_record(self.hostname, 1, "8.8.8.8"),
                        ],
                    )
                ),
                _Response(_dns_body(self.hostname, 28, [])),
            ]
        )

        self.assertEqual(
            resolver.resolve(self.hostname, proxy_url=self.proxy_url),
            ("8.8.8.8",),
        )

    def test_single_and_multilevel_cname_chains_select_final_addresses(self):
        cases = (
            (
                "single",
                [
                    _dns_record(self.hostname, 5, "edge.example."),
                    _dns_record("edge.example", 1, "1.1.1.1"),
                ],
                "1.1.1.1",
            ),
            (
                "multi",
                [
                    _dns_record(self.hostname, 5, "first.example"),
                    _dns_record("first.example", 5, "second.example"),
                    _dns_record("second.example", 1, "8.8.4.4"),
                ],
                "8.8.4.4",
            ),
        )
        for name, answers, expected in cases:
            with self.subTest(name=name):
                resolver, _session = self._resolver(
                    [
                        _Response(
                            _dns_body(
                                self.hostname,
                                1,
                                answers=answers,
                            )
                        ),
                        _Response(_dns_body(self.hostname, 28, [])),
                    ]
                )
                self.assertEqual(
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url),
                    (expected,),
                )

    def test_unordered_cname_chain_is_followed_from_the_query(self):
        resolver, _session = self._resolver(
            [
                _Response(
                    _dns_body(
                        self.hostname,
                        1,
                        answers=[
                            _dns_record("final.example", 1, "1.0.0.1"),
                            _dns_record("middle.example", 5, "final.example"),
                            _dns_record(self.hostname, 5, "middle.example"),
                        ],
                    )
                ),
                _Response(_dns_body(self.hostname, 28, [])),
            ]
        )

        self.assertEqual(
            resolver.resolve(self.hostname, proxy_url=self.proxy_url),
            ("1.0.0.1",),
        )

    def test_unrelated_owner_address_is_not_an_answer(self):
        resolver, _session = self._resolver(
            [
                _Response(
                    _dns_body(
                        self.hostname,
                        1,
                        answers=[
                            _dns_record("unrelated.example", 1, "9.9.9.9"),
                        ],
                    )
                ),
                _Response(_dns_body(self.hostname, 28, [])),
            ]
        )

        with self.assertRaises(EncryptedDNSError) as caught:
            resolver.resolve(self.hostname, proxy_url=self.proxy_url)

        self.assertEqual(caught.exception.code, "encrypted_dns_no_answer")
        self.assertFalse(caught.exception.proxy_fault)

    def test_valid_cname_without_final_address_is_no_answer(self):
        resolver, _session = self._resolver(
            [
                _Response(
                    _dns_body(
                        self.hostname,
                        1,
                        answers=[
                            _dns_record(self.hostname, 5, "final.example"),
                            _dns_record("unrelated.example", 1, "9.9.9.9"),
                        ],
                    )
                ),
                _Response(_dns_body(self.hostname, 28, [])),
            ]
        )

        with self.assertRaises(EncryptedDNSError) as caught:
            resolver.resolve(self.hostname, proxy_url=self.proxy_url)

        self.assertEqual(caught.exception.code, "encrypted_dns_no_answer")
        self.assertFalse(caught.exception.proxy_fault)

    def test_malformed_cname_owner_and_target_are_protocol_faults(self):
        cases = (
            [_dns_record("bad..owner.example", 5, "target.example")],
            [_dns_record(self.hostname, 5, "RAW_CNAME_SECRET/invalid")],
        )
        for answers in cases:
            with self.subTest(answers=answers):
                resolver, _session = self._resolver(
                    [
                        _Response(
                            _dns_body(
                                self.hostname,
                                1,
                                answers=answers,
                            )
                        )
                    ]
                )
                with self.assertRaises(EncryptedDNSError) as caught:
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url)
                error = caught.exception
                self.assertEqual(error.code, "encrypted_dns_protocol")
                self.assertTrue(error.retryable)
                self.assertTrue(error.proxy_fault)
                self.assertNotIn("RAW_CNAME_SECRET", error.message)
                self.assertNotIn(self.hostname, error.message)
                self.assertNotIn(self.proxy_url, error.message)

    def test_cname_loop_and_excessive_depth_are_protocol_faults(self):
        loop = [
            _dns_record(self.hostname, 5, "loop.example"),
            _dns_record("loop.example", 5, self.hostname),
        ]
        deep = [
            _dns_record(
                self.hostname if index == 0 else f"hop-{index}.example",
                5,
                f"hop-{index + 1}.example",
            )
            for index in range(17)
        ]
        deep.append(_dns_record("hop-17.example", 1, "8.8.8.8"))
        for name, answers in (("loop", loop), ("deep", deep)):
            with self.subTest(name=name):
                resolver, _session = self._resolver(
                    [
                        _Response(
                            _dns_body(
                                self.hostname,
                                1,
                                answers=answers,
                            )
                        )
                    ]
                )
                with self.assertRaises(EncryptedDNSError) as caught:
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url)
                error = caught.exception
                self.assertEqual(error.code, "encrypted_dns_protocol")
                self.assertTrue(error.retryable)
                self.assertTrue(error.proxy_fault)
                self.assertNotIn(self.hostname, error.message)
                self.assertNotIn(self.proxy_url, error.message)

    def test_second_query_transport_failure_invalidates_the_lease(self):
        resolver, session = self._resolver(
            [
                _Response(_dns_body(self.hostname, 1, ["8.8.4.4"])),
                requests.exceptions.Timeout("PRIVATE_QUERY timeout"),
            ]
        )

        with self.assertRaises(EncryptedDNSError) as caught:
            resolver.resolve(self.hostname, proxy_url=self.proxy_url)

        error = caught.exception
        self.assertEqual(error.code, "encrypted_dns_unavailable")
        self.assertTrue(error.retryable)
        self.assertTrue(error.proxy_fault)
        self.assertNotIn("PRIVATE_QUERY", error.message)
        self.assertEqual(len(session.calls), 2)
        self.assertTrue(session.closed)

    def test_tls_eof_certificate_and_timeout_are_retryable_proxy_faults(self):
        failures = (
            requests.exceptions.SSLError("EOF PRIVATE_QUERY"),
            requests.exceptions.SSLError("certificate PRIVATE_QUERY"),
            requests.exceptions.Timeout("timeout PRIVATE_QUERY"),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__, text=str(failure)):
                resolver, session = self._resolver([failure])
                with self.assertRaises(EncryptedDNSError) as caught:
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url)
                error = caught.exception
                self.assertEqual(error.code, "encrypted_dns_unavailable")
                self.assertTrue(error.retryable)
                self.assertTrue(error.proxy_fault)
                self.assertNotIn("PRIVATE_QUERY", error.message)
                self.assertTrue(session.closed)

    def test_invalid_json_redirect_http_error_large_and_empty_are_controlled(self):
        secret_body = b"SECRET_RESPONSE_BODY"
        cases = [
            (
                "invalid_json",
                [_Response(secret_body)],
                "encrypted_dns_protocol",
                True,
            ),
            (
                "redirect",
                [_Response(status_code=302)],
                "encrypted_dns_redirect",
                True,
            ),
            (
                "http_error",
                [_Response(secret_body, status_code=503)],
                "encrypted_dns_http_error",
                True,
            ),
            (
                "large_declared",
                [_Response(b"", headers={"Content-Length": "4097"})],
                "encrypted_dns_response_too_large",
                True,
            ),
            (
                "large_streamed",
                [_Response(chunks=[b"a" * 3000, b"b" * 2000])],
                "encrypted_dns_response_too_large",
                True,
            ),
            (
                "empty",
                [
                    _Response(_dns_body(self.hostname, 1, [])),
                    _Response(_dns_body(self.hostname, 28, [])),
                ],
                "encrypted_dns_no_answer",
                False,
            ),
        ]
        for name, outcomes, expected_code, proxy_fault in cases:
            with self.subTest(name=name):
                resolver, _session = self._resolver(
                    outcomes,
                    max_response_bytes=4096,
                )
                with self.assertRaises(EncryptedDNSError) as caught:
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url)
                error = caught.exception
                self.assertEqual(error.code, expected_code)
                self.assertEqual(error.proxy_fault, proxy_fault)
                safe = f"{error.code} {error.message}"
                for private in (
                    self.hostname,
                    "SECRET_RESPONSE_BODY",
                    self.proxy_url,
                    "29077",
                ):
                    self.assertNotIn(private, safe)

    def test_nxdomain_is_target_level_and_does_not_query_aaaa(self):
        resolver, session = self._resolver(
            [_Response(_dns_body(self.hostname, 1, status=3))]
        )

        with self.assertRaises(EncryptedDNSError) as caught:
            resolver.resolve(self.hostname, proxy_url=self.proxy_url)

        error = caught.exception
        self.assertEqual(error.code, "encrypted_dns_nxdomain")
        self.assertFalse(error.retryable)
        self.assertFalse(error.proxy_fault)
        self.assertEqual(len(session.calls), 1)

    def test_mismatched_question_and_malformed_address_are_proxy_faults(self):
        cases = [
            _dns_body(
                self.hostname,
                1,
                ["1.1.1.1"],
                question_hostname="other.example",
            ),
            _dns_body(self.hostname, 1, ["not-an-address"]),
            _dns_body(self.hostname, 1, ["2001:4860:4860::8888"]),
        ]
        for body in cases:
            with self.subTest(body=body):
                resolver, _session = self._resolver([_Response(body)])
                with self.assertRaises(EncryptedDNSError) as caught:
                    resolver.resolve(self.hostname, proxy_url=self.proxy_url)
                self.assertEqual(caught.exception.code, "encrypted_dns_protocol")
                self.assertTrue(caught.exception.proxy_fault)

    def test_disabled_and_missing_proxy_fail_without_network(self):
        session = _Session([])
        disabled = EncryptedDNSResolver(
            enabled=False,
            session_factory=lambda: session,
        )
        with self.assertRaises(EncryptedDNSError) as caught:
            disabled.resolve(self.hostname, proxy_url=self.proxy_url)
        self.assertEqual(caught.exception.code, "encrypted_dns_unavailable")
        self.assertEqual(session.calls, [])

        enabled = EncryptedDNSResolver(session_factory=lambda: session)
        with self.assertRaises(EncryptedDNSError) as caught:
            enabled.resolve(self.hostname, proxy_url="")
        self.assertEqual(caught.exception.code, "proxy_dns_failed")
        self.assertEqual(session.calls, [])


class NetworkTargetValidatorTests(unittest.TestCase):
    lease = SimpleNamespace(endpoint="http://127.0.0.1:29001")

    def test_strict_proxy_validation_rejects_non_global_ranges(self):
        resolver = Mock()
        validator = NetworkTargetValidator(
            allow_private_targets=False,
            strict_target_dns=True,
            encrypted_dns=resolver,
        )
        rejected = (
            "2001::4a56:cac",
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "fd00::1",
            "fe80::1",
        )
        for address in rejected:
            with self.subTest(address=address):
                resolver.resolve.return_value = (address,)
                with self.assertRaises(EncryptedDNSError) as caught:
                    validator.validate_proxy("https://target.example/path", self.lease)
                error = caught.exception
                self.assertEqual(error.code, "invalid_network_target")
                self.assertFalse(error.retryable)
                self.assertFalse(error.proxy_fault)
                self.assertNotIn(address, error.message)

    def test_allow_private_still_uses_doh_for_hostname(self):
        resolver = Mock()
        resolver.resolve.return_value = ("127.0.0.1", "fd00::1")
        validator = NetworkTargetValidator(
            allow_private_targets=True,
            strict_target_dns=True,
            encrypted_dns=resolver,
        )
        getaddrinfo = Mock(side_effect=AssertionError("不应调用本机 DNS"))

        with patch("gdl_backend.encrypted_dns.socket.getaddrinfo", getaddrinfo):
            addresses = validator.validate_proxy(
                "https://private-target.example/path",
                self.lease,
            )

        self.assertEqual(addresses, ("127.0.0.1", "fd00::1"))
        resolver.resolve.assert_called_once_with(
            "private-target.example",
            proxy_url=self.lease.endpoint,
        )
        getaddrinfo.assert_not_called()

    def test_proxy_validation_uses_doh_and_never_local_getaddrinfo(self):
        resolver = Mock()
        resolver.resolve.return_value = ("1.1.1.1",)
        validator = NetworkTargetValidator(
            allow_private_targets=False,
            strict_target_dns=True,
            encrypted_dns=resolver,
        )
        getaddrinfo = Mock(side_effect=AssertionError("不应调用本机 DNS"))

        with patch("gdl_backend.encrypted_dns.socket.getaddrinfo", getaddrinfo):
            self.assertEqual(
                validator.validate_proxy("https://target.example/a", self.lease),
                ("1.1.1.1",),
            )

        getaddrinfo.assert_not_called()

    def test_direct_mode_keeps_local_strict_dns(self):
        resolver = Mock()
        validator = NetworkTargetValidator(
            allow_private_targets=False,
            strict_target_dns=True,
            encrypted_dns=resolver,
        )
        entries = [(None, None, None, None, ("1.1.1.1", 443))]
        with patch(
            "gdl_backend.encrypted_dns.socket.getaddrinfo",
            return_value=entries,
        ) as getaddrinfo:
            self.assertEqual(
                validator.validate_direct("https://target.example/a"),
                ("1.1.1.1",),
            )
        getaddrinfo.assert_called_once()
        resolver.resolve.assert_not_called()

    def test_literal_private_target_is_rejected_without_doh(self):
        resolver = Mock()
        validator = NetworkTargetValidator(
            allow_private_targets=False,
            strict_target_dns=True,
            encrypted_dns=resolver,
        )
        with self.assertRaises(EncryptedDNSError) as caught:
            validator.validate_proxy("http://127.0.0.1:8080/a", self.lease)
        self.assertEqual(caught.exception.code, "invalid_network_target")
        resolver.resolve.assert_not_called()


class ProxyDoHCacheTests(unittest.TestCase):
    lease = SimpleNamespace(endpoint="http://127.0.0.1:29001")

    @staticmethod
    def _validator(
        resolver: Mock,
        *,
        allow_private_targets: bool = False,
        strict_target_dns: bool = True,
        ttl_seconds: float = 300.0,
        max_entries: int = 512,
        clock: _MonotonicClock | None = None,
    ) -> NetworkTargetValidator:
        return NetworkTargetValidator(
            allow_private_targets=allow_private_targets,
            strict_target_dns=strict_target_dns,
            encrypted_dns=SimpleNamespace(resolve=resolver),
            proxy_doh_cache_ttl_seconds=ttl_seconds,
            proxy_doh_cache_max_entries=max_entries,
            monotonic_clock=clock,
        )

    def test_public_proxy_doh_result_populates_boolean_exact_hostname_fallback(self):
        resolver = Mock(return_value=("1.1.1.1", "2606:4700:4700::1111"))
        validator = self._validator(resolver)

        addresses = validator.validate_proxy(
            "https://EXAMPLE.com./posts/1",
            self.lease,
        )
        fallback = validator.validate_proxy_cache_fallback(
            "https://example.com/posts/2"
        )

        self.assertEqual(addresses, ("1.1.1.1", "2606:4700:4700::1111"))
        self.assertIs(fallback, True)
        self.assertIsInstance(fallback, bool)
        self.assertFalse(
            validator.validate_proxy_cache_fallback("https://sub.example.com/posts/2")
        )
        resolver.assert_called_once_with(
            "example.com",
            proxy_url=self.lease.endpoint,
        )

    def test_fallback_normalizes_case_trailing_dot_and_idna_without_suffix_match(self):
        resolver = Mock(return_value=("8.8.8.8",))
        validator = self._validator(resolver)

        validator.validate_proxy("https://TÄST.Example./path", self.lease)

        resolver.assert_called_once_with(
            "xn--tst-qla.example",
            proxy_url=self.lease.endpoint,
        )
        self.assertTrue(
            validator.validate_proxy_cache_fallback(
                "https://xn--tst-qla.example/other"
            )
        )
        self.assertFalse(
            validator.validate_proxy_cache_fallback(
                "https://sub.xn--tst-qla.example/other"
            )
        )

    def test_fallback_expires_using_injected_monotonic_clock(self):
        clock = _MonotonicClock(100.0)
        resolver = Mock(return_value=("9.9.9.9",))
        validator = self._validator(resolver, ttl_seconds=5.0, clock=clock)

        validator.validate_proxy("https://ttl.example/path", self.lease)
        clock.now = 104.999
        self.assertTrue(validator.validate_proxy_cache_fallback("https://ttl.example/"))
        clock.now = 105.0
        self.assertFalse(validator.validate_proxy_cache_fallback("https://ttl.example/"))

    def test_cache_capacity_is_bounded_and_tie_eviction_is_deterministic(self):
        clock = _MonotonicClock()
        resolver = Mock(return_value=("1.0.0.1",))
        validator = self._validator(
            resolver,
            max_entries=2,
            clock=clock,
        )

        for hostname in ("z.example", "a.example", "m.example"):
            validator.validate_proxy(f"https://{hostname}/path", self.lease)

        # 三项 TTL 相同，容量超过上限时按 hostname 作为稳定平局规则淘汰 a。
        self.assertFalse(validator.validate_proxy_cache_fallback("https://a.example/"))
        self.assertTrue(validator.validate_proxy_cache_fallback("https://m.example/"))
        self.assertTrue(validator.validate_proxy_cache_fallback("https://z.example/"))
        self.assertEqual(resolver.call_count, 3)

    def test_doh_failures_nxdomain_and_no_answer_do_not_populate_cache(self):
        cases = (
            "encrypted_dns_unavailable",
            "encrypted_dns_nxdomain",
            "encrypted_dns_no_answer",
        )
        for code in cases:
            with self.subTest(code=code):
                resolver = Mock(
                    side_effect=EncryptedDNSError(
                        code,
                        "受控测试错误",
                        retryable=code == "encrypted_dns_unavailable",
                        proxy_fault=code == "encrypted_dns_unavailable",
                    )
                )
                validator = self._validator(resolver)
                with self.assertRaises(EncryptedDNSError) as caught:
                    validator.validate_proxy("https://failure.example/path", self.lease)
                self.assertEqual(caught.exception.code, code)
                self.assertFalse(
                    validator.validate_proxy_cache_fallback("https://failure.example/")
                )

    def test_permissive_runtime_policy_never_caches_non_public_or_mixed_answers(self):
        cases = {
            "private": ("127.0.0.1",),
            "teredo": ("2001::4a56:cac",),
            "mixed": ("1.1.1.1", "fd00::1"),
        }
        for name, addresses in cases.items():
            with self.subTest(name=name):
                resolver = Mock(return_value=addresses)
                validator = self._validator(
                    resolver,
                    allow_private_targets=True,
                    strict_target_dns=False,
                )
                self.assertEqual(
                    validator.validate_proxy(
                        f"https://{name}.example/path",
                        self.lease,
                    ),
                    addresses,
                )
                self.assertFalse(
                    validator.validate_proxy_cache_fallback(
                        f"https://{name}.example/"
                    )
                )

    def test_ip_literal_cannot_be_cached_or_use_hostname_fallback(self):
        resolver = Mock()
        validator = self._validator(resolver)

        self.assertEqual(
            validator.validate_proxy("https://1.1.1.1/path", self.lease),
            ("1.1.1.1",),
        )
        self.assertFalse(validator.validate_proxy_cache_fallback("https://1.1.1.1/"))
        self.assertFalse(validator.validate_proxy_cache_fallback("http://127.0.0.1/"))
        resolver.assert_not_called()


class NormalizeDoHEndpointTests(unittest.TestCase):
    def test_normalizes_public_https_endpoint(self):
        self.assertEqual(
            normalize_doh_endpoint(" HTTPS://Cloudflare-DNS.com:443/dns-query "),
            "https://cloudflare-dns.com:443/dns-query",
        )

    def test_rejects_non_https_private_credentials_and_query(self):
        for value in (
            "http://dns.example/dns-query",
            "https://127.0.0.1/dns-query",
            "https://user:secret@dns.example/dns-query",
            "https://dns.example/dns-query?name=private.example",
            "https://dns.example/",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_doh_endpoint(value)


if __name__ == "__main__":
    unittest.main()
