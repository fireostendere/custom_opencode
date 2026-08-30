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
    projects = Path(temp) / "projects"
    project = projects / "alpha"
    project.mkdir(parents=True)
    subprocess.run(["git","init","-q",str(project)],check=True)
    subprocess.run(["git","-C",str(project),"config","user.email","smoke@example.invalid"],check=True)
    subprocess.run(["git","-C",str(project),"config","user.name","Web Smoke"],check=True)
    (project/"main.py").write_text("def runtime_symbol():\n    return 1\n",encoding="utf-8")
    subprocess.run(["git","-C",str(project),"add","."],check=True)
    subprocess.run(["git","-C",str(project),"commit","-qm","base"],check=True)
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
            body = json.dumps({"data": []}).encode("utf-8")
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
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(projects)
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(state / "features.json")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(state / "runtime.sqlite3")
    os.environ["MCP_RAG_ENABLED"] = "0"
    os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "off"
    os.environ["OPENCODE_REPO_EMBEDDINGS"] = "hash"

    sys.path.insert(0, str(ROOT / "app"))
    import server_workflow

    base = server_workflow.rag.plus.ext.base
    server = base.ThreadingHTTPServer(("localhost", 0), server_workflow.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    auth = "Basic " + base64.b64encode(b"opencode:test").decode("ascii")

    def request(method: str, path: str, body=None, *, authenticated: bool = True, internal: bool = False):
        connection = http.client.HTTPConnection(host, port, timeout=8)
        try:
            headers={}
            if authenticated: headers["Authorization"]=auth
            if internal: headers["X-OpenCode-Runtime"]="runtime-test-token"
            data=None
            if body is not None:
                data=json.dumps(body).encode(); headers["Content-Type"]="application/json"
            connection.request(method,path,body=data,headers=headers)
            response=connection.getresponse(); payload=response.read()
            return response.status,response.getheader("Content-Type") or "",payload
        finally: connection.close()

    try:
        status, content_type, body = request("GET","/")
        assert status == 200, status
        assert "text/html" in content_type
        assert b"OpenCode" in body and b"runtime-dashboard.js" in body and b"runtime-v3-dashboard.js" in body

        denied, _, _ = request("GET","/client-runtime-v3.json",authenticated=False)
        assert denied == 401, denied
        remote_denied,_,_=request("GET","/client-remote-status.json",authenticated=False)
        assert remote_denied==401,remote_denied

        status, content_type, body = request("GET","/client-runtime.json")
        assert status == 200, status
        payload = json.loads(body)
        assert payload["version"] == 2
        assert payload["services"]["durableQueue"] is True

        status, content_type, body = request("GET","/client-runtime-v3.json")
        assert status == 200, status
        assert "application/json" in content_type
        payload = json.loads(body)
        assert payload["version"] == 3
        for key in ("nativeDynamicCompaction","astIndex","repoEmbeddings","semanticSymbolDiff","mcpCodeMode","sandboxEnforcement","sharedNativeRAG","zeroTokenReplay","remoteNotificationAPI"):
            assert payload["services"][key] is True, key

        q=quote(str(project),safe='')
        status, _, body=request("GET",f"/client-repo-index-v3.json?directory={q}&query=runtime_symbol")
        assert status==200
        index=json.loads(body)
        assert any(hit.get("qualified")=="runtime_symbol" for hit in index.get("hits") or [])

        status, _, body=request("GET",f"/client-mcp-gateway-v3.json?directory={q}")
        assert status==200
        mcp=json.loads(body)
        assert mcp["codeMode"] is True and mcp["lazyLoading"] is True and mcp["credentialsExposed"] is False

        forbidden,_,_=request("POST","/internal/runtime/tool-before",{"cwd":str(project),"tool":"read","input":{"path":"main.py"}},authenticated=False,internal=False)
        assert forbidden==403
        allowed,_,body=request("POST","/internal/runtime/tool-before",{"cwd":str(project),"tool":"read","input":{"path":"main.py"}},authenticated=False,internal=True)
        assert allowed==200
        assert json.loads(body).get("allow") is True

        cache_forbidden,_,_=request("POST","/internal/runtime/tool-cache",{"op":"get","cwd":str(project),"tool":"read","input":{"path":"main.py"}},authenticated=False,internal=False)
        assert cache_forbidden==403
        miss,_,body=request("POST","/internal/runtime/tool-cache",{"op":"get","cwd":str(project),"tool":"read","input":{"path":"main.py"}},authenticated=False,internal=True)
        assert miss==200 and json.loads(body).get("hit") is False
        stored,_,_=request("POST","/internal/runtime/tool-cache",{"op":"put","cwd":str(project),"tool":"read","input":{"path":"main.py"},"result":{"text":"cached"}},authenticated=False,internal=True)
        assert stored==200
        hit,_,body=request("POST","/internal/runtime/tool-cache",{"op":"get","cwd":str(project),"tool":"read","input":{"path":"main.py"}},authenticated=False,internal=True)
        assert hit==200 and json.loads(body).get("hit") is True and json.loads(body).get("result",{}).get("text")=="cached"

        remote,_,body=request("GET","/client-remote-status.json")
        assert remote==200
        remote_payload=json.loads(body)
        assert remote_payload["actions"]["task"]==["cancel","pause","resume"]
        assert remote_payload["actions"]["permission"]==["once","reject"]

        status, _, body = request("GET","/client-resource-status.json")
        assert status == 200
        resources = json.loads(body)
        assert resources["mode"] == "provider-pinned"
        assert "decisions" in resources
    finally:
        server.shutdown()
        server.server_close()
        stub_backend.shutdown()
        stub_backend.server_close()
        thread.join(timeout=5)

print("Composed web-server smoke passed: auth + Runtime V2/V3 + semantic index + MCP + pre-exec cache + remote actions")
