#!/usr/bin/env python3
from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from urllib.parse import quote

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

    class _StubBackend(BaseHTTPRequestHandler):
        def _reply(self):
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
        method: str, path: str, body=None, *, authenticated: bool = True, internal: bool = False
    ):
        connection = http.client.HTTPConnection(host, port, timeout=8)
        try:
            headers = {}
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
        status, _, body = request(
            "GET", f"/client-repo-index-v3.json?directory={q}&query=runtime_symbol"
        )
        assert status == 200
        index = json.loads(body)
        assert any(hit.get("qualified") == "runtime_symbol" for hit in index.get("hits") or [])

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
    finally:
        server.shutdown()
        server.server_close()
        assert server_workflow.features._stop_worker(timeout=10), "runtime worker failed to stop"
        stub_backend.shutdown()
        stub_backend.server_close()
        thread.join(timeout=5)

print(
    "Composed web-server smoke passed: auth + Runtime V2/V3 + semantic index + MCP + pre-exec cache + remote actions"
)
