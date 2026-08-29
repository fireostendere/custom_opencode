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

assert "directory=" in server_rag._v2_workspace_target("/api/mcp", "/tmp/project")
assert "location%5Bdirectory%5D" not in server_rag._v2_workspace_target("/api/mcp", "/tmp/project")
config = server_rag._dynamic_mcp_config()
assert config["type"] == "local"
assert config["enabled"] is True
assert config["timeout"] == 60_000
assert config["command"][0] == "bash"
assert config["command"][1].endswith("scripts/rag-mcp.sh")

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
server_rag._persist_kb_enabled = lambda: {"ok": True, "changed": True, "path": "/tmp/opencode.json"}
server_rag._connect_kb = lambda directory: {
    "ok": directory == "/tmp/selected-project",
    "action": "connected",
    "status": {"status": "connected"},
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
assert result["persisted"]["changed"] is True
assert result["protocol"]["requiredToolsReady"] is True
assert result["mcp"]["action"] == "connected"

print("RAG start smoke passed: preflight gate + V2 workspace + persistence + MCP ready flow")
