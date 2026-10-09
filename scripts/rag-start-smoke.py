#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "test")
os.environ.setdefault("OPENCODE_BACKEND_URL", "http://localhost:9")
os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "test")
os.environ.setdefault("OPENCODE_SCRATCH_DIRECTORY", str(Path(tempfile.gettempdir()) / "custom-opencode-rag-start-smoke"))
sys.path.insert(0, str(ROOT / "app"))

import server_rag

target = server_rag._v2_workspace_target("/api/mcp", "/tmp/project")
assert "location%5Bdirectory%5D" in target
assert "?directory=" not in target

# Only the workspace's own enabled RAG servers are reconnected; nothing is ever
# added (PUT) or persisted, so a project without RAG never gets a global kb.
workspaces = {
    "/tmp/pcb": [{"name": "engineering_kb", "status": {"status": "failed"}},
                 {"name": "diptrace", "status": {"status": "failed"}}],
    "/tmp/table": [{"name": "kb", "status": {"status": "disabled"}},
                   {"name": "dnd", "status": {"status": "connected"}}],
    "/tmp/plain": [{"name": "diptrace", "status": {"status": "connected"}}],
}
requests = []
def fake_backend(method, target, body=None, timeout=0):
    requests.append((method, target))
    directory = target.split("location%5Bdirectory%5D=")[1].replace("%2F", "/")
    if method == "GET":
        return {"data": workspaces[directory]}
    assert method == "POST" and "/connect" in target, (method, target)
    name = target.split("/api/mcp/")[1].split("/connect")[0]
    for server in workspaces[directory]:
        if server["name"] == name:
            server["status"] = {"status": "connected"}
    return {}
server_rag.plus._backend_request_json = fake_backend
server_rag.plus._data = lambda payload: payload.get("data")

pcb = server_rag._connect_rag("/tmp/pcb")
assert pcb["ok"] is True and pcb["action"] == "connected", pcb
assert [m for m, t in requests if m != "GET"] == ["POST"]
assert any("/api/mcp/engineering_kb/connect" in t for _, t in requests)
requests.clear()
table = server_rag._connect_rag("/tmp/table")
assert table["ok"] is True and table["action"] == "already-connected" and list(table["servers"]) == ["dnd"], table
plain = server_rag._connect_rag("/tmp/plain")
assert plain["ok"] is False and plain["action"] == "none", plain
assert all(method == "GET" for method, _ in requests), requests
assert not hasattr(server_rag, "_persist_kb_enabled") and not hasattr(server_rag, "_dynamic_mcp_config")

# Full mode must never enter retrieval before a model-free readiness preflight.
server_rag.plus._rag_runtime = lambda: {
    "available": True, "python": "/fake/python", "root": "/fake/rag",
}
runtime_calls = []
def fake_runtime(runtime, args, timeout):
    runtime_calls.append(list(args))
    if len(runtime_calls) == 1:
        return {"ok": True, "collectionReady": True, "corpusReady": True}
    return {"ok": True, "retrieval": {"ok": True}}
server_rag._invoke_runtime = fake_runtime
full = server_rag._run_runtime_start("full")
assert full["ok"] is True
assert runtime_calls[0] == ["--wait", "20"]
assert runtime_calls[1][0] == "--no-start"
assert "--search" in runtime_calls[1]

runtime_calls.clear()
def failed_preflight(runtime, args, timeout):
    runtime_calls.append(list(args))
    return {"ok": False, "collectionReady": False}
server_rag._invoke_runtime = failed_preflight
failed = server_rag._run_runtime_start("full")
assert failed["ok"] is False
assert len(runtime_calls) == 1

# End-to-end control-flow smoke uses mocks only: no real backend/config/Docker.
server_rag._run_runtime_start = lambda mode: {
    "ok": True,
    "registry": {"documents": 500, "chunks": 1234},
    "qdrant": {"qdrant": {"reachable": True, "collectionExists": True, "indexedPoints": 1234}},
    "retrieval": {"ok": mode == "full"},
}
server_rag._session_directory = lambda session_id: "/tmp/selected-project" if session_id else "/tmp/scratch"
server_rag._rag_servers = lambda directory: {
    "servers": {"engineering_kb": {"status": "connected"}} if directory == "/tmp/selected-project" else {}}
server_rag._connect_rag = lambda directory: {
    "ok": directory == "/tmp/selected-project",
    "action": "connected",
    "servers": {"engineering_kb": {"status": "connected"}},
}
server_rag.plus._run_rag_probe = lambda mode: {
    "ok": True,
    "tools": ["knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status", "knowledge_ingest"],
    "status": {"qdrant_reachable": True},
}
result = server_rag.run_rag_start("full", session_id="ses_smoke")
assert result["ok"] is True
assert result["stage"] == "ready"
assert result["workspace"] == "/tmp/selected-project"
assert result["protocol"]["requiredToolsReady"] is True
assert result["mcp"]["action"] == "connected"


# A workspace without its own RAG server stops before any Qdrant/runtime work.
server_rag._run_runtime_start = lambda mode: (_ for _ in ()).throw(AssertionError("runtime must not start"))
none = server_rag.run_rag_start("quick")
assert none["ok"] is False and none["stage"] == "workspace", none

print("RAG start smoke passed: preflight gate + V2 workspace + project-scoped reconnect + MCP ready flow")
