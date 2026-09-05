#!/usr/bin/env python3
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    os.environ["OPENCODE_SERVER_USERNAME"] = "opencode"
    os.environ["OPENCODE_SERVER_PASSWORD"] = "test-password"
    os.environ["OPENCODE_WEB_ALLOW_LOCAL"] = "1"
    os.environ["OPENCODE_AUTH_ALLOW_BASIC"] = "0"
    os.environ["OPENCODE_BACKEND_URL"] = "http://127.0.0.1:9"
    os.environ["OPENCODE_BACKEND_PASSWORD"] = "backend-test"
    os.environ["OPENCODE_SCRATCH_DIRECTORY"] = str(root / "scratch")
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(root / "projects")
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(root / "features.json")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(root / "runtime.sqlite3")
    os.environ["MCP_RAG_ENABLED"] = "0"
    os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "off"
    (root / "projects").mkdir()

    sys.path.insert(0, str(ROOT / "app"))
    import server_workflow

    base = server_workflow.rag.plus.ext.base
    with patch.object(base.time, "time", return_value=2_000_000_000):
        assert base.issue_session_token(300) != base.issue_session_token(300)
    server = base.ThreadingHTTPServer(("127.0.0.1", 0), server_workflow.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]

    def request(method: str, path: str, *, body=None, headers=None):
        connection = http.client.HTTPConnection(host, port, timeout=5)
        payload = None
        request_headers = dict(headers or {})
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=payload, headers=request_headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw
        finally:
            connection.close()

    try:
        # Explicit local bypass remains available for direct localhost tools.
        status, _, raw = request("GET", "/auth/session", headers={"Host": f"127.0.0.1:{port}"})
        assert status == 200, (status, raw)
        assert json.loads(raw)["localBypass"] is True

        # A local reverse proxy is still a loopback TCP peer, but forwarded
        # traffic must never inherit localhost bypass.
        status, _, _ = request(
            "GET",
            "/auth/session",
            headers={
                "Host": "custom-opencode.example.invalid",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "198.51.100.25",
            },
        )
        assert status == 401, status

        # Even a proxy that does not add forwarding headers is denied when it
        # preserves the external Host header.
        status, _, _ = request("GET", "/auth/session", headers={"Host": "custom-opencode.example.invalid"})
        assert status == 401, status

        remote_headers = {
            "Host": "custom-opencode.example.invalid",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "198.51.100.77",
        }
        status, _, _ = request("GET", "/client-integration.json", headers=remote_headers)
        assert status == 401, status
        status, response_headers, _ = request("POST", "/client-send.json", body={"sessionID": "x", "text": "x"}, headers=remote_headers)
        assert status == 401, status
        assert any(key.lower() == "connection" and value.lower() == "close" for key, value in response_headers.items()), response_headers
        for method, path, body in (
            ("GET", "/client-queue.json", None),
            ("POST", "/client-queue.json", {}),
            ("PATCH", "/client-queue.json", {}),
            ("DELETE", "/client-queue.json", None),
            ("POST", "/client-rag-start.json", {}),
        ):
            status, _, _ = request(method, path, body=body, headers=remote_headers)
            assert status == 401, (method, path, status)

        status, response_headers, _ = request(
            "POST",
            "/auth/login",
            body={"username": "opencode", "password": "test-password", "remember": True},
            headers=remote_headers,
        )
        assert status == 204, status
        cookie_header = response_headers.get("Set-Cookie", "")
        cookie = cookie_header.split(";", 1)[0]
        assert cookie.startswith("opencode_session=")
        assert "HttpOnly" in cookie_header and "SameSite=Strict" in cookie_header and "Secure" in cookie_header

        authed_headers = {**remote_headers, "Cookie": cookie}
        status, _, _ = request("GET", "/auth/session", headers=authed_headers)
        assert status == 200, status

        # Logout must revoke the exact token server-side; replaying a copied
        # cookie in the same server lifetime is rejected.
        status, _, _ = request("POST", "/auth/logout", headers=authed_headers)
        assert status == 204, status
        status, _, _ = request("GET", "/auth/session", headers=authed_headers)
        assert status == 401, status

        # Revocation is persisted in RuntimeStore (SQLite/WAL), not merely kept
        # in process memory. Simulate a service restart by clearing the local
        # revocation map; the copied cookie must remain rejected.
        with server_workflow._revoked_lock:
            server_workflow._revoked_tokens.clear()
        status, _, _ = request("GET", "/auth/session", headers=authed_headers)
        assert status == 401, status

        # A new login in the same second must issue a distinct token rather than
        # inheriting the prior logout's revocation.
        status, response_headers, _ = request(
            "POST",
            "/auth/login",
            body={"username": "opencode", "password": "test-password", "remember": True},
            headers=remote_headers,
        )
        assert status == 204, status
        fresh_cookie = response_headers.get("Set-Cookie", "").split(";", 1)[0]
        assert fresh_cookie != cookie
        status, _, _ = request("GET", "/auth/session", headers={**remote_headers, "Cookie": fresh_cookie})
        assert status == 200, status

        # Eight failures in a minute are bounded; the next attempt is 429.
        brute_headers = {
            "Host": "custom-opencode.example.invalid",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "198.51.100.88",
        }
        for _ in range(server_workflow._LOGIN_MAX_FAILURES):
            status, _, _ = request(
                "POST",
                "/auth/login",
                body={"username": "opencode", "password": "wrong"},
                headers=brute_headers,
            )
            assert status == 401, status
        status, _, _ = request(
            "POST",
            "/auth/login",
            body={"username": "opencode", "password": "wrong"},
            headers=brute_headers,
        )
        assert status == 429, status
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("Web security smoke passed: direct-local only bypass + proxy auth + durable revocation + throttle")
