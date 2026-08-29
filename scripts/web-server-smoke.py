#!/usr/bin/env python3
from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as temp:
    state = Path(temp) / "state"
    scratch = Path(temp) / "scratch"
    projects = Path(temp) / "projects"
    projects.mkdir()
    os.environ["OPENCODE_SERVER_USERNAME"] = "opencode"
    os.environ["OPENCODE_SERVER_PASSWORD"] = "test"
    os.environ["OPENCODE_WEB_ALLOW_LOCAL"] = "0"
    os.environ["OPENCODE_BACKEND_URL"] = "http://localhost:9"
    os.environ["OPENCODE_BACKEND_PASSWORD"] = "test"
    os.environ["OPENCODE_SCRATCH_DIRECTORY"] = str(scratch)
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(projects)
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(state / "features.json")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(state / "runtime.sqlite3")
    os.environ["MCP_RAG_ENABLED"] = "0"
    os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "off"

    sys.path.insert(0, str(ROOT / "app"))
    import server_workflow

    base = server_workflow.rag.plus.ext.base
    server = base.ThreadingHTTPServer(("localhost", 0), server_workflow.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    auth = "Basic " + base64.b64encode(b"opencode:test").decode("ascii")

    def get(path: str, *, authenticated: bool = True):
        connection = http.client.HTTPConnection(host, port, timeout=5)
        try:
            headers = {"Authorization": auth} if authenticated else {}
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, response.getheader("Content-Type") or "", body
        finally:
            connection.close()

    try:
        status, content_type, body = get("/")
        assert status == 200, status
        assert "text/html" in content_type
        assert b"OpenCode" in body and b"runtime-dashboard.js" in body

        denied, _, _ = get("/client-runtime.json", authenticated=False)
        assert denied == 401, denied

        status, content_type, body = get("/client-runtime.json")
        assert status == 200, status
        assert "application/json" in content_type
        payload = json.loads(body)
        assert payload["version"] == 2
        assert payload["services"]["durableQueue"] is True
        assert payload["services"]["capabilityRegistry"] is True
        assert payload["services"]["worktreeIsolation"] is True

        status, _, body = get("/client-resource-status.json")
        assert status == 200
        resources = json.loads(body)
        assert resources["mode"] == "off"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("Composed web-server smoke passed: static UI + auth boundary + Runtime V2 endpoints")
