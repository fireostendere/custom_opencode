#!/usr/bin/env python3
from __future__ import annotations

import base64
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as temp:
    state = Path(temp) / "state"
    scratch = Path(temp) / "scratch"
    plan_dir = Path(temp) / "plans"
    projects = Path(temp) / "projects"
    project = projects / "alpha"
    project.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "smoke@example.invalid"], check=True
    )
    subprocess.run(["git", "-C", str(project), "config", "user.name", "Web Smoke"], check=True)
    (project / "main.py").write_text("def runtime_symbol():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)
    os.environ["OPENCODE_SERVER_USERNAME"] = "opencode"
    os.environ["OPENCODE_SERVER_PASSWORD"] = "test"
    os.environ["OPENCODE_RUNTIME_PLUGIN_TOKEN"] = "runtime-test-token"
    os.environ["OPENCODE_WEB_ALLOW_LOCAL"] = "0"
    os.environ["OPENCODE_AUTH_ALLOW_BASIC"] = "1"
    # Hermetic: never fall back to the real service.json discovery file.
    os.environ["OPENCODE_SERVICE_FILE"] = str(state / "service.json")
    # Fast stub backend: a dead port can blackhole connects for seconds in WSL,
    # so backend probes must fail (or answer) instantly.
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    backend_hits: dict[str, int] = {}

    class _StubBackend(BaseHTTPRequestHandler):
        def _reply(self):
            backend_hits[self.path] = backend_hits.get(self.path, 0) + 1
            value = (
                {"data": {"id": "ses_web_plan", "location": {"directory": str(project)}}}
                if self.path == "/api/session/ses_web_plan"
                else {"data": []}
            )
            body = json.dumps(value).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_DELETE = _reply

        def log_message(self, *args):
            pass

    stub_backend = ThreadingHTTPServer(("127.0.0.1", 0), _StubBackend)
    threading.Thread(target=stub_backend.serve_forever, daemon=True).start()
    stub_host, stub_port = stub_backend.server_address[:2]
    os.environ["OPENCODE_BACKEND_URL"] = f"http://127.0.0.1:{stub_port}"
    os.environ["OPENCODE_BACKEND_PASSWORD"] = "test"
    os.environ["OPENCODE_SCRATCH_DIRECTORY"] = str(scratch)
    os.environ["OPENCODE_PLAN_DIRECTORY"] = str(plan_dir)
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(projects)
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(state / "features.json")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(state / "runtime.sqlite3")
    os.environ["MCP_RAG_ENABLED"] = "0"
    os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "off"
    os.environ["OPENCODE_REPO_EMBEDDINGS"] = "hash"
    plan_dir.mkdir(parents=True)
    (plan_dir / "ses_web_plan-plan.md").write_text(
        "# Web V2 plan\n\n- [x] Expose the plan\n- [>] Render checklist\n- [ ] Keep Build/Plan UI\n",
        encoding="utf-8",
    )
    second_plan = plan_dir / "ses_web_plan_two-plan.md"
    second_plan.write_text("# Second web plan\n\n- [ ] Keep sessions isolated\n", encoding="utf-8")
    os.utime(second_plan, (2_000_000_000, 2_000_000_000))

    sys.path.insert(0, str(ROOT / "app"))
    import server_workflow

    base = server_workflow.rag.plus.ext.base
    server = base.ThreadingHTTPServer(("localhost", 0), server_workflow.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    auth = "Basic " + base64.b64encode(b"opencode:test").decode("ascii")

    def request(
        method: str, path: str, body=None, *, authenticated: bool = True, internal: bool = False,
        extra_headers: dict[str, str] | None = None, full: bool = False,
    ):
        connection = http.client.HTTPConnection(host, port, timeout=8)
        try:
            headers = dict(extra_headers or {})
            if authenticated:
                headers["Authorization"] = auth
            if internal:
                headers["X-OpenCode-Runtime"] = "runtime-test-token"
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            payload = response.read()
            if full:
                return response.status, dict(response.getheaders()), payload
            return response.status, response.getheader("Content-Type") or "", payload
        finally:
            connection.close()

    try:
        status, content_type, body = request("GET", "/")
        assert status == 200, status
        assert "text/html" in content_type
        assert (
            b"OpenCode" in body
            and b"runtime-dashboard.js" in body
            and b"runtime-v3-dashboard.js" in body
        )

        denied, _, _ = request("GET", "/client-runtime-v3.json", authenticated=False)
        assert denied == 401, denied
        plan_denied, _, _ = request(
            "GET", "/client-plan.json?sessionID=ses_web_plan", authenticated=False
        )
        assert plan_denied == 401, plan_denied
        remote_denied, _, _ = request("GET", "/client-remote-status.json", authenticated=False)
        assert remote_denied == 401, remote_denied
        create_denied, _, _ = request(
            "POST",
            "/client-directories.json",
            {"parent": str(project), "name": "denied"},
            authenticated=False,
        )
        assert create_denied == 401, create_denied

        status, _, body = request(
            "POST", "/client-directories.json", {"parent": str(project), "name": "created"}
        )
        created = json.loads(body)
        assert status == 201 and created == {
            "ok": True,
            "directory": str(project / "created"),
            "name": "created",
        }
        duplicate, _, _ = request(
            "POST", "/client-directories.json", {"parent": str(project), "name": "created"}
        )
        assert duplicate == 409, duplicate
        for invalid in ("", ".", "..", "../escape", "a/b", "a\\b", "bad\x00name", "bad\nname"):
            bad, _, _ = request(
                "POST", "/client-directories.json", {"parent": str(project), "name": invalid}
            )
            assert bad == 400, (invalid, bad)
        outside = Path(temp) / "outside"
        outside.mkdir()
        exact_status, _, exact_body = request(
            "POST", "/client-directories.json", {"path": str(outside)}
        )
        exact = json.loads(exact_body)
        assert exact_status == 200 and exact["ok"] is True, exact
        assert exact["directory"] == str(outside) and exact["browsable"] is False, exact
        missing_status, _, _ = request(
            "POST", "/client-directories.json", {"path": str(outside / "missing")}
        )
        assert missing_status == 404, missing_status
        invalid_status, _, _ = request(
            "POST", "/client-directories.json", {"path": ""}
        )
        assert invalid_status == 400, invalid_status
        forbidden, _, _ = request(
            "POST", "/client-directories.json", {"parent": str(outside), "name": "nope"}
        )
        assert forbidden == 403, forbidden
        try:
            link = project / "outside-link"
            link.symlink_to(outside, target_is_directory=True)
            forbidden, _, _ = request(
                "POST", "/client-directories.json", {"parent": str(link), "name": "nope"}
            )
            assert forbidden == 403, forbidden
        except (NotImplementedError, OSError):
            pass

        status, content_type, body = request("GET", "/client-runtime.json")
        assert status == 200, status
        payload = json.loads(body)
        assert payload["version"] == 2
        assert payload["services"]["durableQueue"] is True

        status, _, body = request("GET", "/client-plan.json?sessionID=ses_web_plan")
        assert status == 200
        plan = json.loads(body)["plan"]
        assert plan["source"] == "native-v2"
        assert plan["title"] == "Web V2 plan"
        assert plan["total"] == 3 and plan["completed"] == 1 and plan["truncated"] is False
        assert [item["status"] for item in plan["todos"]] == ["completed", "in_progress", "pending"]
        status, _, body = request("GET", "/client-plan.json?sessionID=missing-backend-session")
        assert status == 200 and json.loads(body)["plan"] is None
        status, _, body = request("GET", "/client-plan.json?sessionID=ses_web_plan_two")
        assert status == 200 and json.loads(body)["plan"]["title"] == "Second web plan"
        status, _, body = request("GET", "/client-plan.json")
        assert status == 200 and json.loads(body)["plan"]["title"] == "Second web plan"
        plain = server_workflow.runtime._parse_plan_document(
            "# Plain\n\n- First\n- Second\n\n```\n- ignored\n```", "fallback"
        )
        assert plain["title"] == "Plain" and [item["content"] for item in plain["todos"]] == [
            "First",
            "Second",
        ]

        status, content_type, body = request("GET", "/client-runtime-v3.json")
        assert status == 200, status
        assert "application/json" in content_type
        payload = json.loads(body)
        assert payload["version"] == 3
        assert payload["services"]["astLanguages"] == ["python"]
        assert payload["services"]["otherLanguageIndex"] == "lexical"
        for key in (
            "nativeDynamicCompaction",
            "astIndex",
            "repoEmbeddings",
            "semanticSymbolDiff",
            "mcpCodeMode",
            "sandboxEnforcement",
            "sharedNativeRAG",
            "zeroTokenReplay",
            "remoteNotificationAPI",
        ):
            assert payload["services"][key] is True, key

        q = quote(str(project), safe="")
        # The interactive endpoint is stale-while-rebuild: the first query may
        # answer from a placeholder while the index builds in the background.
        deadline = time.monotonic() + 60
        while True:
            status, _, body = request(
                "GET", f"/client-repo-index-v3.json?directory={q}&query=runtime_symbol"
            )
            assert status == 200
            index = json.loads(body)
            if any(hit.get("qualified") == "runtime_symbol" for hit in index.get("hits") or []):
                break
            assert time.monotonic() < deadline, index
            time.sleep(0.2)

        status, _, body = request("GET", f"/client-mcp-gateway-v3.json?directory={q}")
        assert status == 200
        mcp = json.loads(body)
        assert (
            mcp["codeMode"] is True
            and mcp["lazyLoading"] is True
            and mcp["credentialsExposed"] is False
        )

        forbidden, _, _ = request(
            "POST",
            "/internal/runtime/tool-before",
            {"cwd": str(project), "tool": "read", "input": {"path": "main.py"}},
            authenticated=False,
            internal=False,
        )
        assert forbidden == 403
        allowed, _, body = request(
            "POST",
            "/internal/runtime/tool-before",
            {"cwd": str(project), "tool": "read", "input": {"path": "main.py"}},
            authenticated=False,
            internal=True,
        )
        assert allowed == 200
        assert json.loads(body).get("allow") is True

        retired_cache, _, _ = request(
            "POST",
            "/internal/runtime/tool-cache",
            {"op": "get"},
            authenticated=False,
            internal=True,
        )
        assert retired_cache == 401

        remote, _, body = request("GET", "/client-remote-status.json")
        assert remote == 200
        remote_payload = json.loads(body)
        assert remote_payload["actions"]["task"] == ["cancel", "pause", "resume"]
        assert remote_payload["actions"]["permission"] == ["once", "reject"]

        status, _, body = request("GET", "/client-resource-status.json")
        assert status == 200
        resources = json.loads(body)
        assert resources["mode"] == "provider-pinned"
        assert "decisions" in resources

        # ---- Static client: allowlisted assets served from memory ----
        app_dir = ROOT / "app"
        status, headers, body = request("GET", "/login.html", full=True, extra_headers={"Accept-Encoding": "identity"})
        assert status == 200 and body == (app_dir / "login.html").read_bytes()
        assert headers["Content-Type"] == "text/html; charset=utf-8" and "Content-Encoding" not in headers
        assert headers["X-Content-Type-Options"] == "nosniff" and headers["Referrer-Policy"] == "same-origin"
        assert headers["Cache-Control"] == "no-cache" and headers["Vary"] == "Accept-Encoding"
        inline = re.search(rb"<script>(.*?)</script>", body, re.S).group(1)
        inline_hash = base64.b64encode(hashlib.sha256(inline).digest()).decode()
        csp = headers["Content-Security-Policy"]
        script_src = csp.split("script-src", 1)[1].split(";", 1)[0]
        assert f"'sha256-{inline_hash}'" in script_src and "'unsafe-inline'" not in script_src, csp
        assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp and "connect-src 'self'" in csp, csp
        etag = headers["ETag"]
        status, revalidated, empty = request("GET", "/login.html", full=True, extra_headers={"If-None-Match": f'W/"x", {etag}'})
        assert status == 304 and empty == b"" and revalidated["ETag"] == etag, (status, revalidated)
        status, zipped_headers, zipped = request("GET", "/login.html", full=True, extra_headers={"Accept-Encoding": "br, gzip;q=0.8"})
        assert status == 200 and zipped_headers["Content-Encoding"] == "gzip" and gzip.decompress(zipped) == body
        assert zipped_headers["ETag"] != etag and zipped_headers["Vary"] == "Accept-Encoding"
        status, _, _ = request("GET", "/login.html", full=True, extra_headers={"Accept-Encoding": "gzip", "If-None-Match": zipped_headers["ETag"]})
        assert status == 304, status
        status, plain_headers, _ = request("GET", "/login.html", full=True, extra_headers={"Accept-Encoding": "gzip;q=0, deflate"})
        assert status == 200 and "Content-Encoding" not in plain_headers
        status, index_headers, _ = request("GET", "/", full=True)
        assert status == 200 and "script-src 'self' 'unsafe-eval';" in index_headers["Content-Security-Policy"]
        status, js_headers, js_body = request("HEAD", "/app.js", full=True)
        assert status == 200 and js_body == b"" and js_headers["Content-Type"] == "text/javascript; charset=utf-8"
        assert int(js_headers["Content-Length"]) == (app_dir / "app.js").stat().st_size
        assert "Content-Security-Policy" not in js_headers
        for path in (
            "/server.py", "/server_users.py", "/README.md", "/__pycache__/server.cpython-312.pyc",
            "/.env", "/.gitignore", "/../.env", "/%2e%2e/.env", "/./login.html", "/sub//login.html",
            "/login.html/", "/LOGIN.HTML", "/login.html%00", "/app.js.map",
        ):
            status, _, _ = request("GET", path)
            assert status == 404, (path, status)

        # Files changed on disk are picked up; the stat check is rate-limited.
        static_root = Path(temp) / "static-root"
        (static_root / "sub" / "__pycache__").mkdir(parents=True)
        (static_root / "ok.js").write_text("console.log(1)\n", encoding="utf-8")
        for name in (".env", ".hidden.js", "tool.py", "notes.txt", "sub/__pycache__/cached.js"):
            (static_root / name).write_text("SECRET=1\n", encoding="utf-8")
        outside_js = Path(temp) / "outside.js"
        outside_js.write_text("outside\n", encoding="utf-8")
        (static_root / "escape.js").symlink_to(outside_js)
        saved_static = (base.ROOT, base.STATIC_REVALIDATE_SECONDS)
        base.ROOT, base.STATIC_REVALIDATE_SECONDS = static_root.resolve(), 0.0
        base._static_cache.clear()
        try:
            for path in ("/.env", "/.hidden.js", "/tool.py", "/notes.txt", "/sub/__pycache__/cached.js", "/escape.js", "/OK.js"):
                status, _, _ = request("GET", path)
                assert status == 404, (path, status)
            status, first_headers, first = request("GET", "/ok.js", full=True)
            assert status == 200 and first == b"console.log(1)\n"
            (static_root / "ok.js").write_text("console.log(22)\n", encoding="utf-8")
            status, second_headers, second = request("GET", "/ok.js", full=True)
            assert second == b"console.log(22)\n" and second_headers["ETag"] != first_headers["ETag"]
            base.STATIC_REVALIDATE_SECONDS = 60.0
            (static_root / "ok.js").write_text("console.log(333)\n", encoding="utf-8")
            status, _, cached = request("GET", "/ok.js", full=True)
            assert cached == b"console.log(22)\n", cached
            base.STATIC_REVALIDATE_SECONDS = 0.0
            (static_root / "ok.js").unlink()
            status, _, _ = request("GET", "/ok.js")
            assert status == 404, status
        finally:
            base.ROOT, base.STATIC_REVALIDATE_SECONDS = saved_static
            base._static_cache.clear()

        # ---- Listener backlog / session-directory cache ----
        assert base.ThreadingWebServer.request_queue_size == 128
        assert "ThreadingWebServer(" in (ROOT / "app/server_workflow.py").read_text(encoding="utf-8")
        features = server_workflow.features
        features._forget_session_directory()
        canonicalized: list[str] = []
        original_canonical = features._canonical_directory
        features._canonical_directory = lambda raw, **kwargs: canonicalized.append(raw) or original_canonical(raw, **kwargs)
        try:
            hits_before = backend_hits.get("/api/session/ses_web_plan", 0)
            expected_directory = str(project.resolve())
            assert features._session_directory("ses_web_plan") == expected_directory
            assert features._session_directory("ses_web_plan") == expected_directory
            # Sessions can move, so the location is read every time; only the
            # 9P canonicalization of an unchanged location string is cached.
            assert backend_hits.get("/api/session/ses_web_plan", 0) == hits_before + 2
            assert canonicalized == [str(project)], canonicalized
            original_info = features._session_info
            features._session_info = lambda session_id: {"location": {"directory": str(outside)}}
            try:
                for _ in range(2):
                    try:
                        features._session_directory("ses_web_plan")
                    except ValueError as exc:
                        assert "outside allowed project roots" in str(exc), exc
                    else:
                        raise AssertionError("moved-out session served from cache")
            finally:
                features._session_info = original_info
            assert canonicalized == [str(project), str(outside), str(outside)], canonicalized
        finally:
            features._canonical_directory = original_canonical

        # ---- Private policy listener: local plugins only ----
        with socket.socket() as probe_socket:
            probe_socket.bind(("127.0.0.1", 0))
            policy_port = probe_socket.getsockname()[1]
        policy_env = {**os.environ, "OPENCODE_POLICY_PORT": str(policy_port), "XDG_STATE_HOME": str(state / "policy-xdg")}
        policy = subprocess.Popen(
            [sys.executable, str(ROOT / "app/policy_server.py"), "serve"],
            env=policy_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )

        def policy_get(headers):
            try:
                with urlopen(Request(f"http://127.0.0.1:{policy_port}/internal/runtime/health", headers=headers), timeout=3) as response:
                    return response.status, json.load(response)
            except HTTPError as error:
                return error.code, None

        try:
            good = {"X-OpenCode-Runtime": "runtime-test-token"}
            deadline = time.monotonic() + 45
            while True:
                try:
                    status, health = policy_get(good)
                    break
                except OSError:
                    if policy.poll() is not None or time.monotonic() > deadline:
                        raise AssertionError("policy server did not start")
                    time.sleep(0.2)
            assert status == 200 and health["service"] == "custom-opencode-private-policy", (status, health)
            assert policy_get({**good, "Sec-Fetch-Mode": "cors"})[0] == 200
            for hostile in ({"Origin": "http://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Host": "evil.example"}):
                assert policy_get({**good, **hostile})[0] == 403, hostile
            assert policy_get({"X-OpenCode-Runtime": "wrong"})[0] == 403
        finally:
            policy.send_signal(signal.SIGTERM)
            try:
                policy.wait(timeout=20)
            except subprocess.TimeoutExpired:
                policy.kill()
    finally:
        server.shutdown()
        server.server_close()
        assert server_workflow.features._stop_worker(timeout=10), "runtime worker failed to stop"
        stub_backend.shutdown()
        stub_backend.server_close()
        thread.join(timeout=5)

print(
    "Composed web-server smoke passed: auth + Runtime V2/V3 + semantic index + MCP + pre-exec cache + remote actions"
    " + static allowlist/ETag/gzip/CSP + session-directory cache + private policy listener"
)
