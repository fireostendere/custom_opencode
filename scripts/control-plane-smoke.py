#!/usr/bin/env python3
"""Zero-token regression tests for the deterministic server control plane."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

import control_plane


def expect(request: dict[str, object], *, effect: str, risk: str | None = None,
           preset: str = "workspace", workspace: str) -> dict[str, object]:
    decision = control_plane.classify_permission(request, workspace=workspace, preset=preset)
    assert decision["effect"] == effect, (request, decision)
    if risk is not None:
        assert decision["risk"] == risk, (request, decision)
    if effect == "allow":
        assert decision["auto"] is True and decision["reply"] == "once", decision
    else:
        assert decision["auto"] is False and decision["reply"] is None, decision
    return decision


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="custom-opencode-control-plane-") as temp:
        root = Path(temp)
        workspace = root / "repo"
        workspace.mkdir()
        state = root / "state"
        os.environ["CUSTOM_OPENCODE_STATE_DIR"] = str(state)
        os.environ["OPENCODE_PERMISSION_AUDIT"] = "1"

        expect({"action": "read", "resources": ["README.md"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action": "read", "resources": [".env"]}, effect="ask", risk="R4", workspace=str(workspace))
        expect({"action": "read", "resources": ["/etc/passwd"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "read", "resources": []}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["cat README.md"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action": "shell", "resources": ["cat .env"]}, effect="ask", risk="R4", workspace=str(workspace))
        expect({"action": "shell", "resources": ["cat /etc/passwd"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["/tmp/cat README.md"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["rg TODO app"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action": "shell", "resources": ["rg --pre 'python helper.py' TODO app"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["tree -o report.txt"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["git status --short"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action": "shell", "resources": ["git diff --output=/tmp/control-plane-diff"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["git diff --ext-diff"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["git tag release-candidate"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["pytest -q"]}, effect="allow", risk="R1", workspace=str(workspace))
        expect({"action": "shell", "resources": ["npm run lint"]}, effect="allow", risk="R1", workspace=str(workspace))
        expect({"action": "shell", "resources": ["rm -rf build"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["sudo apt update"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["git push origin main"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action": "shell", "resources": ["cat README.md && rm -rf build"]}, effect="ask", risk="R3", workspace=str(workspace))

        expect({"action": "edit", "resources": ["app/api.js"]}, effect="allow", risk="R2", workspace=str(workspace))
        expect({"action": "edit", "resources": [str(root / "outside.txt")]}, effect="ask", risk="R2", workspace=str(workspace))
        expect({"action": "edit", "resources": []}, effect="ask", risk="R2", workspace=str(workspace))
        expect({"action": "edit", "resources": ["app/api.js"]}, effect="ask", risk="R2", preset="safe", workspace=str(workspace))

        expect({"action": "webfetch", "resources": ["https://example.invalid/"]}, effect="ask", risk="R1", workspace=str(workspace))
        expect({"action": "webfetch", "resources": ["https://example.invalid/"]}, effect="allow", risk="R1", preset="autonomous", workspace=str(workspace))
        for action in ("external_directory", "subagent", "task", "kb_knowledge_ingest"):
            expect({"action": action, "resources": ["*"]}, effect="ask", risk="R3", workspace=str(workspace))

        audited_request = {"action": "shell", "resources": ["TOKEN=do-not-store cat README.md"]}
        decision = control_plane.classify_permission(audited_request, workspace=str(workspace))
        control_plane.audit_decision(decision, request=audited_request, session_id="session", permission_id="permission")
        audit_path = state / "permission-audit.jsonl"
        event = json.loads(audit_path.read_text(encoding="utf-8").splitlines()[-1])
        assert "do-not-store" not in json.dumps(event), event
        assert event["session"] == "session" and event["permission"] == "permission"

        # Integration regression: the server must classify the backend's actual
        # pending request and never trust action/resources supplied by a client.
        os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "test")
        os.environ.setdefault("OPENCODE_BACKEND_URL", "http://localhost:9")
        os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "test")
        import server_rag

        replies: list[tuple[str, str]] = []
        server_rag._session_directory = lambda session_id: str(workspace)
        server_rag._reply_permission_once = lambda session_id, permission_id: replies.append((session_id, permission_id))
        server_rag._permission_requests = lambda directory: [{
            "id": "p-read",
            "sessionID": "s1",
            "action": "shell",
            "resources": ["cat README.md"],
        }]
        result = server_rag.evaluate_permission("s1", "p-read")
        assert result["ok"] is True and result["autoReplied"] is True, result
        assert replies == [("s1", "p-read")], replies

        replies.clear()
        server_rag._permission_requests = lambda directory: [{
            "id": "p-danger",
            "sessionID": "s1",
            "action": "shell",
            "resources": ["rm -rf build"],
        }]
        result = server_rag.evaluate_permission("s1", "p-danger")
        assert result["ok"] is True and result["effect"] == "ask" and result["autoReplied"] is False, result
        assert not replies, replies

    print("Control-plane smoke passed: low-risk auto-allow + fail-closed boundaries + backend-verified replies")


if __name__ == "__main__":
    main()
