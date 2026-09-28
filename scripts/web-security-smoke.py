#!/usr/bin/env python3
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
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
    original_proxy = server_workflow.Handler.proxy
    def proxy_ok(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.json_response({"proxied": True})
    server_workflow.Handler.proxy = proxy_ok
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base.WEB_HOST, base.WEB_PORT = host, port

    def request(method: str, path: str, *, body=None, headers=None, raw_body: bytes | None = None):
        connection = http.client.HTTPConnection(host, port, timeout=5)
        payload = raw_body
        request_headers = dict(headers or {})
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
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

        # Installer health checks must authenticate when Basic and localhost
        # bypass are unavailable, without changing production auth defaults.
        from install_health import web_auth_headers
        health_headers = web_auth_headers(base)
        assert "Authorization" not in health_headers and "Cookie" in health_headers
        status, _, _ = request("GET", "/auth/session", headers={**remote_headers, **health_headers})
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

        # Budget forms are an explicit human-consent boundary. Loopback,
        # Basic/internal headers and path spelling tricks cannot submit them.
        with server_workflow.runtime.STORE.transaction() as db:
            db.execute("INSERT INTO budget_approvals VALUES(?,?,?,?,?,?,?,?)", ("root", "ses budget", "execution", "{}", "frm_budget", "pending", 1, 1))
        protected = "/api/session/ses%20budget/form/frm_budget/reply/"
        for protected_path in (protected, "/api/session/ses%20budget/%66orm/frm_budget/%72eply", "/api/session/ses%20budget/%66orm/frm_budget/%72eply/"):
            status, _, _ = request("POST", protected_path, body={"decision":"approve"}, headers={"Host": f"127.0.0.1:{port}"})
            assert status == 401, (protected_path, status)
        status, _, _ = request("POST", protected, body={"decision":"approve"}, headers={"Host": f"127.0.0.1:{port}", "Authorization":"Basic b3BlbmNvZGU6dGVzdC1wYXNzd29yZA==", "X-OpenCode-Runtime":"ignored"})
        assert status == 401, status
        status, _, _ = request("POST", protected, body={"decision":"approve"}, headers={**remote_headers, "Cookie": fresh_cookie})
        assert status != 401, status
        status, _, _ = request("POST", protected, body={"decision":"approve"}, headers={**remote_headers, "Cookie": cookie})
        assert status == 401, status
        expired_cookie = "opencode_session=" + base.issue_session_token(-1)
        status, _, _ = request("POST", protected, body={"decision":"approve"}, headers={**remote_headers, "Cookie": expired_cookie})
        assert status == 401, status
        ordinary = "/api/session/ses%20budget/form/ordinary/reply/"
        status, _, _ = request("POST", ordinary, body={"answer":"ok"}, headers={"Host": f"127.0.0.1:{port}"})
        assert status != 401, status

        # ---- Cross-origin request policy (CSRF) and local-bypass scope ----
        local = {"Host": f"127.0.0.1:{port}"}
        own_origin = f"http://127.0.0.1:{port}"
        prompt = "/api/session/ses/prompt"
        # The app's own same-origin page keeps the loopback convenience bypass.
        status, _, raw = request("GET", "/auth/session", headers={**local, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"})
        assert status == 200, (status, raw)
        assert json.loads(raw) == {"ok": True, "user": "opencode", "localBypass": True, "human": False}, raw
        status, _, raw = request("GET", "/auth/session", headers={**local, "Cookie": fresh_cookie})
        assert status == 200 and json.loads(raw)["human"] is True, raw
        status, _, _ = request("POST", prompt, body={"text": "x"}, headers={**local, "Origin": own_origin, "Sec-Fetch-Site": "same-origin"})
        assert status == 200, status
        # Node's fetch (runtime plugins, TUI) sends only sec-fetch-mode: a local tool.
        status, _, _ = request("POST", prompt, body={"text": "x"}, headers={**local, "Sec-Fetch-Mode": "cors"})
        assert status == 200, status
        # Pages on another site or another localhost port get neither the
        # bypass nor the SameSite=Strict cookie (sent same-site) as authority.
        hostile_contexts = (
            {"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"},
            {"Origin": "http://127.0.0.1:3000", "Sec-Fetch-Site": "same-site"},
            {"Origin": "http://localhost:3000"},  # browser without fetch metadata
            {"Origin": "null"},
            {"Sec-Fetch-Site": "cross-site"},
            {"Origin": own_origin, "Sec-Fetch-Site": "same-site"},
        )
        for hostile in hostile_contexts:
            for credential in ({}, {"Cookie": fresh_cookie}):
                for method, path in (("POST", prompt), ("POST", "/client-send.json"), ("DELETE", "/api/session/ses"), ("POST", "/auth/logout")):
                    status, response_headers, _ = request(method, path, body={"text": "x"}, headers={**local, **hostile, **credential})
                    assert status == 403, (hostile, credential, method, path, status)
                    assert response_headers.get("Connection", "").lower() == "close", response_headers
        # Side-effecting GETs (index refresh) and every endpoint are isolated too.
        for path in ("/client-repo-index.json?directory=/tmp", "/auth/session", "/api/session"):
            status, _, _ = request("GET", path, headers={**local, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"})
            assert status == 403, (path, status)
        status, _, _ = request("GET", "/client-integration.json", headers={**local, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate"})
        assert status == 403, status
        # A link from another site may still open the app, but only via login.
        status, response_headers, _ = request("GET", "/", headers={**local, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})
        assert status == 302 and response_headers["Location"].startswith("/login.html?next="), (status, response_headers)
        status, _, _ = request("GET", "/login.html", headers={**local, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"})
        assert status == 200, status
        # JSON bodies must be declared as JSON: simple cross-site forms cannot.
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""):
            for path in (prompt, "/auth/login", "/client-send.json"):
                status, _, _ = request("POST", path, raw_body=b'{"text":"x"}', headers={**local, "Content-Type": content_type} if content_type else local)
                assert status == 415, (content_type, path, status)
        status, _, _ = request("POST", prompt, raw_body=b'{"text":"x"}', headers={**local, "Content-Type": "application/json; charset=utf-8"})
        assert status == 200, status
        # Reverse proxies: the public origin is accepted when a same-host proxy
        # names it (X-Forwarded-Host) or it is configured explicitly.
        proxied = {
            "Host": f"127.0.0.1:{port}",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "198.51.100.31",
            "Origin": "https://phone.example.invalid",
            "Sec-Fetch-Site": "same-origin",
            "Cookie": fresh_cookie,
        }
        status, _, _ = request("POST", prompt, body={"text": "x"}, headers=proxied)
        assert status == 403, status
        status, _, _ = request("POST", prompt, body={"text": "x"}, headers={**proxied, "X-Forwarded-Host": "phone.example.invalid"})
        assert status == 200, status
        with patch.object(base, "ALLOWED_ORIGINS", frozenset({base.parse_origin("https://phone.example.invalid")})):
            status, _, _ = request("POST", prompt, body={"text": "x"}, headers=proxied)
            assert status == 200, status
        # The proxied request still never inherits the loopback bypass.
        status, _, _ = request("POST", prompt, body={"text": "x"}, headers={k: v for k, v in proxied.items() if k != "Cookie"} | {"X-Forwarded-Host": "phone.example.invalid"})
        assert status == 401, status

        # ---- Consent/credential/destructive routes need a login session ----
        human_only = (
            ("POST", "/api/session/ses/permission/per/reply"),
            ("POST", "/api/session/ses/%70ermission/per/reply"),
            ("POST", "/API/Session/ses/Permission/per/reply"),
            ("POST", "/api/session/ses/permissions/per"),
            ("POST", "/api/permission/per/reply"),
            ("POST", "/api/session/ses/command"),
            ("PATCH", "/api/config"),
            ("PUT", "/api/mcp/kb"),
            ("PUT", "/api/auth/openai"),
            ("POST", "/api/provider/openai/oauth/authorize"),
            ("POST", "/client-git-revert.json"),
            ("POST", "/client-project-settings.json"),
            ("POST", "/client-provider-config.json"),
            ("POST", "/client-remote-action.json"),
            ("POST", "/client-task-sandbox.json"),
            ("POST", "/client-worktree-merge.json"),
        )
        for method, path in human_only:
            for headers in (local, {**local, "Origin": own_origin, "Sec-Fetch-Site": "same-origin"}):
                status, _, raw = request(method, path, body={}, headers=headers)
                assert status == 401, (method, path, status)
                assert "локальный доступ" in json.loads(raw)["error"], raw
            status, _, _ = request(method, path, body={}, headers={**local, "Cookie": fresh_cookie})
            assert status != 401, (method, path, status)
        # Reads of the same resources and ordinary actions keep the bypass.
        for method, path in (("GET", "/client-project-settings.json"), ("GET", "/api/session/ses/permission"), ("POST", "/api/session/ses/question/q/reply")):
            status, _, _ = request(method, path, body={} if method == "POST" else None, headers=local)
            assert status != 401, (method, path, status)

        # ---- /internal/runtime/* on the public listener: local plugins only ----
        internal = "/internal/runtime/budget-status"
        token = {**local, "X-OpenCode-Runtime": "test-password"}
        for extra in (
            {"X-Forwarded-For": "198.51.100.40"},
            {"Host": "custom-opencode.example.invalid"},
            {"Origin": own_origin},
            {"Sec-Fetch-Site": "same-origin"},
        ):
            status, _, _ = request("POST", internal, body={"sessionID": "s"}, headers={**token, **extra})
            assert status == 404, (extra, status)
        status, _, _ = request("POST", internal, body={"sessionID": "s"}, headers={**token, "Sec-Fetch-Mode": "cors"})
        assert status not in (401, 403, 404), status
        started = time.monotonic()
        status, _, _ = request("POST", internal, body={"sessionID": "s"}, headers={**local, "X-OpenCode-Runtime": "wrong-guess"})
        assert status == 403 and time.monotonic() - started >= 0.2, status

        # ---- HTTP framing: no Transfer-Encoding, no leftover-body requests ----
        def raw_exchange(data: bytes) -> bytes:
            with socket.create_connection((host, port), timeout=5) as sock:
                sock.sendall(data)
                chunks = []
                while True:
                    try:
                        chunk = sock.recv(65536)
                    except socket.timeout:
                        raise AssertionError("connection left open after an unread body")
                    if not chunk:
                        return b"".join(chunks)
                    chunks.append(chunk)

        smuggled = f"POST /client-send.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}".encode()
        head = f"Host: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n".encode()
        reply = raw_exchange(b"POST /client-send.json HTTP/1.1\r\n" + head + b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n" + smuggled)
        assert reply.startswith(b"HTTP/1.1 400") and reply.count(b"HTTP/1.1 ") == 1, reply[:200]
        reply = raw_exchange(b"POST /auth/logout HTTP/1.1\r\n" + head + f"Content-Length: {len(smuggled)}\r\n\r\n".encode() + smuggled)
        assert reply.startswith(b"HTTP/1.1 204") and reply.count(b"HTTP/1.1 ") == 1, reply[:200]
        assert b"connection: close" in reply.lower(), reply[:200]
        reply = raw_exchange(b"POST /auth/login HTTP/1.1\r\n" + head + b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}")
        assert reply.startswith(b"HTTP/1.1 400"), reply[:200]
        # Fully consumed bodies keep HTTP/1.1 keep-alive working.
        reply = raw_exchange(
            f"GET /auth/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode()
            + f"GET /auth/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n".encode()
        )
        assert reply.count(b"HTTP/1.1 200") == 2, reply[:300]

        # ---- login.html next= must stay same-origin (open redirect) ----
        login_js = (ROOT / "app/login.js").read_text(encoding="utf-8")
        function = re.search(r"function sameOriginTarget\(value\) \{.*?\n\}\n", login_js, re.S)
        assert function, "login.js must validate next= with the URL parser"
        probe = function.group(0) + r"""
globalThis.location = new URL('http://127.0.0.1:4098/login.html')
const cases = JSON.parse(process.argv[1])
console.log(JSON.stringify(cases.map(sameOriginTarget)))
"""
        cases = ["/\t/evil.example", "/\n/evil.example", "/\\evil.example", "//evil.example", "/\\/evil.example",
                 "https://evil.example/", "/login.html", " /x", "/#/session/ses_1", "/?a=1#/session/x", "/a\tb"]
        output = subprocess.run(["node", "-e", probe, json.dumps(cases)], capture_output=True, text=True, check=True).stdout
        assert json.loads(output) == [None, None, None, None, None, None, None, None,
                                      "/#/session/ses_1", "/?a=1#/session/x", "/ab"], output

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
        server_workflow.Handler.proxy = original_proxy
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("Web security smoke passed: direct-local only bypass + cross-origin isolation + JSON-only bodies + human-only consent routes + local-only internal routes + HTTP framing + same-origin login redirect + proxy auth + durable revocation + throttle")
