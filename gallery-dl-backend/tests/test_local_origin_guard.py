from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI

from gdl_backend.app import create_app
from tests.helpers import local_test_client, make_settings


async def _get_without_host(app: FastAPI, path: str) -> tuple[int, dict]:
    messages: list[dict] = []
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 19091),
        "state": {},
    }

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        messages.append(message)

    await app(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    return int(start["status"]), json.loads(body)


class LocalOriginGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temporary.name))
        self.settings.server.port = 19091
        self.app = create_app(self.settings, start_background=False)
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def test_allows_loopback_hosts(self) -> None:
        port = self.settings.server.port
        hosts = (
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
            f"localhost.:{port}",
            f" LOCALHOST.:{port} ",
            "127.0.0.1",
            "localhost",
            "[::1]",
        )
        for host in hosts:
            with self.subTest(host=host):
                response = self.client.get("/healthz", headers={"Host": host})
                self.assertNotEqual(response.status_code, 403, response.text)

    def test_rejects_foreign_host(self) -> None:
        request_id = "foreign-host-request"
        response = self.client.get(
            "/healthz",
            headers={
                "Host": "evil.example.com",
                "X-Request-ID": request_id,
            },
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.json(),
            {
                "error": {
                    "code": "forbidden_host",
                    "message": "仅允许从本机回环地址访问",
                    "details": None,
                    "request_id": request_id,
                }
            },
        )

    def test_rejects_lan_host(self) -> None:
        response = self.client.get(
            "/healthz",
            headers={"Host": f"192.168.1.5:{self.settings.server.port}"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "forbidden_host")

    def test_rejects_missing_host(self) -> None:
        status, payload = asyncio.run(_get_without_host(self.app, "/healthz"))
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "forbidden_host")

        empty = self.client.get("/healthz", headers={"Host": ""})
        self.assertEqual(empty.status_code, 403)
        self.assertEqual(empty.json()["error"]["code"], "forbidden_host")

    def test_rejects_cross_site_fetch(self) -> None:
        host = f"127.0.0.1:{self.settings.server.port}"
        for fetch_site in ("cross-site", "same-site"):
            with self.subTest(fetch_site=fetch_site):
                response = self.client.get(
                    "/healthz",
                    headers={
                        "Host": host,
                        "Sec-Fetch-Site": fetch_site,
                    },
                )
                self.assertEqual(response.status_code, 403)
                self.assertEqual(
                    response.json()["error"]["code"],
                    "forbidden_cross_site",
                )

    def test_allows_same_origin_and_none_fetch_site(self) -> None:
        host = f"127.0.0.1:{self.settings.server.port}"
        for fetch_site in ("same-origin", "none", None):
            with self.subTest(fetch_site=fetch_site):
                headers = {"Host": host}
                if fetch_site is not None:
                    headers["Sec-Fetch-Site"] = fetch_site
                response = self.client.get("/healthz", headers=headers)
                self.assertNotEqual(response.status_code, 403, response.text)

    def test_guard_covers_ui_and_docs(self) -> None:
        paths = (
            "/ui/",
            "/docs",
            "/openapi.json",
            "/healthz",
            "/readyz",
            "/api/v1/tasks",
        )
        for path in paths:
            with self.subTest(path=path):
                response = self.client.get(
                    path,
                    headers={"Host": "evil.example.com"},
                )
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(response.json()["error"]["code"], "forbidden_host")

    def test_forbidden_response_does_not_echo_host(self) -> None:
        submitted_host = "private-host-token.evil.example.com:19091"
        response = self.client.get(
            "/healthz",
            headers={"Host": submitted_host},
        )

        self.assertEqual(response.status_code, 403)
        self.assertNotIn(submitted_host, response.text)

    def test_forbidden_response_has_request_id(self) -> None:
        provided_id = "provided-guard-request-id"
        provided = self.client.get(
            "/healthz",
            headers={
                "Host": "evil.example.com",
                "X-Request-ID": provided_id,
            },
        )
        self.assertEqual(provided.headers["X-Request-ID"], provided_id)
        self.assertEqual(provided.json()["error"]["request_id"], provided_id)

        generated = self.client.get(
            "/healthz",
            headers={"Host": "evil.example.com"},
        )
        generated_id = generated.headers["X-Request-ID"]
        self.assertRegex(generated_id, r"^[0-9a-f]{32}$")
        self.assertEqual(generated.json()["error"]["request_id"], generated_id)


if __name__ == "__main__":
    unittest.main()
