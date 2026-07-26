from __future__ import annotations

import unittest

from gdl_backend.classifier import classify_result
from gdl_backend.redaction import redact_data, redact_text


class RedactionTests(unittest.TestCase):
    def test_redacts_proxy_userinfo_query_and_headers(self):
        text = (
            "proxy=http://user:pass@example.test:8080/a?token=abc&x=1 "
            "Authorization: Bearer xyz Cookie=session123"
        )
        safe = redact_text(text)
        self.assertNotIn("user:pass", safe)
        self.assertNotIn("abc", safe)
        self.assertNotIn("session123", safe)
        self.assertIn("***", safe)

    def test_redacts_nested_secret_keys(self):
        value = redact_data({"token": "abc", "nested": {"password": "p", "ok": "yes"}})
        self.assertEqual(value["token"], "***")
        self.assertEqual(value["nested"]["password"], "***")
        self.assertEqual(value["nested"]["ok"], "yes")

    def test_redacts_eh_temporary_image_tokens(self):
        safe = redact_text("https://host/h/file/keystamp=temporary;fileindex=123;xres=1280/a.webp")
        self.assertNotIn("temporary", safe)
        self.assertNotIn("fileindex=123", safe)
        self.assertIn("keystamp=***", safe)


class ClassifierTests(unittest.TestCase):
    def test_proxy_failure_is_retryable_and_penalizes_node(self):
        result = classify_result(4, "ProxyError: tunnel connection failed")
        self.assertEqual(result.error_class, "proxy_failure")
        self.assertTrue(result.retryable)
        self.assertTrue(result.proxy_fault)

    def test_connection_reset_extraction_exit_is_retried_on_another_node(self):
        result = classify_result(
            4,
            "gallery_dl.exception.HttpError: ConnectionError: "
            "ConnectionResetError(10054, 'connection aborted')",
        )
        self.assertEqual(result.error_class, "proxy_failure")
        self.assertTrue(result.retryable)
        self.assertTrue(result.proxy_fault)

    def test_cloudflare_challenge_rotates_proxy_node(self):
        result = classify_result(
            4,
            "Cloudflare challenge (403 Forbidden) for 'https://x.com/account/access'",
        )
        self.assertEqual(result.error_class, "proxy_failure")
        self.assertTrue(result.retryable)
        self.assertTrue(result.proxy_fault)

    def test_public_gallery_access_denial_rotates_proxy_node(self):
        result = classify_result(
            16,
            "AuthorizationError: Insufficient privileges to access this resource",
        )
        self.assertEqual(result.error_class, "proxy_access_failure")
        self.assertTrue(result.retryable)
        self.assertTrue(result.proxy_fault)

    def test_auth_and_unsupported_are_permanent(self):
        self.assertFalse(classify_result(16, "AuthRequired").retryable)
        self.assertEqual(classify_result(64, "Unsupported URL").error_class, "unsupported_url")

    def test_unsupported_url_exit_code_64_is_authoritative(self):
        # gallery-dl's main() maps a top-level NoExtractorError to exit bit 64,
        # so the exit code alone (no matching log text) must still classify.
        decision = classify_result(64, "")
        self.assertEqual(decision.error_class, "unsupported_url")
        self.assertFalse(decision.retryable)

    def test_unsupported_url_text_without_code_still_classifies(self):
        decision = classify_result(1, "Unsupported URL 'https://example.test/x'")
        self.assertEqual(decision.error_class, "unsupported_url")
        self.assertFalse(decision.retryable)

    def test_cloudflare_challenge_exit_code_8_rotates_and_retries(self):
        # ChallengeError.code == 8; no proxy/CF text marker here, so only the
        # bitmask branch can produce this classification.
        decision = classify_result(8, "ChallengeError for 'https://danbooru.donmai.us/'")
        self.assertEqual(decision.error_class, "cloudflare_challenge")
        self.assertTrue(decision.retryable)
        self.assertTrue(decision.proxy_fault)

    def test_challenge_bit_combined_with_extraction_bit_stays_challenge(self):
        decision = classify_result(12, "ChallengeError for 'https://x.test/'")  # 8 | 4
        self.assertEqual(decision.error_class, "cloudflare_challenge")
        self.assertTrue(decision.retryable)

    def test_plain_extraction_error_stays_non_retryable(self):
        decision = classify_result(
            4, "gallery_dl.exception.ExtractionError: unable to parse gallery page"
        )
        self.assertEqual(decision.error_class, "extraction_error")
        self.assertFalse(decision.retryable)
        self.assertFalse(decision.proxy_fault)

    def test_transient_site_and_success(self):
        self.assertTrue(classify_result(4, "503 Service Unavailable").retryable)
        self.assertEqual(classify_result(0, "").error_class, "success")

    def test_exhentai_continuation_hint_is_retryable(self):
        result = classify_result(
            4,
            "[exhentai][info] Use 'https://e-hentai.org/s/TOKEN/123-4' "
            "as input URL to continue downloading from the current position",
        )
        self.assertEqual(result.error_class, "download_error")
        self.assertTrue(result.retryable)


if __name__ == "__main__":
    unittest.main()
