#!/usr/bin/env python3
"""Zero-token regression checks for workflow-integrated permission policy."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "test")
os.environ.setdefault("OPENCODE_BACKEND_URL", "http://localhost:9")
os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "test")
sys.path.insert(0, str(ROOT / "app"))

import control_plane
import server_control


def expect(request: dict[str, object], *, effect: str, risk: str, workspace: str,
           preset: str = "workspace") -> dict[str, object]:
    decision = control_plane.classify_permission(request, workspace=workspace, preset=preset)
    assert decision["effect"] == effect, (request, decision)
    assert decision["risk"] == risk, (request, decision)
    return decision


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="custom-opencode-control-plane-") as temp:
        root = Path(temp)
        workspace = root / "repo"
        workspace.mkdir()
        os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(root / "state" / "web-features.json")
        os.environ["OPENCODE_PERMISSION_AUDIT"] = "1"

        expect({"action":"read", "resources":["README.md"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action":"read", "resources":[".env"]}, effect="ask", risk="R4", workspace=str(workspace))
        expect({"permission":"read", "patterns":["../outside.txt"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action":"shell", "resources":["git status --short"]}, effect="allow", risk="R0", workspace=str(workspace))
        expect({"action":"shell", "metadata":{"command":"pytest -q"}}, effect="allow", risk="R1", workspace=str(workspace))
        expect({"action":"shell", "resources":["rm -rf build"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action":"shell", "resources":["cat README.md && rm -rf build"]}, effect="ask", risk="R3", workspace=str(workspace))
        expect({"action":"edit", "resources":["app/api.js"]}, effect="allow", risk="R2", workspace=str(workspace))
        expect({"action":"edit", "resources":["app/api.js"]}, effect="ask", risk="R2", workspace=str(workspace), preset="safe")
        expect({"action":"webfetch", "resources":["https://example.invalid/"]}, effect="ask", risk="R1", workspace=str(workspace))
        expect({"action":"webfetch", "resources":["https://example.invalid/"]}, effect="allow", risk="R1", workspace=str(workspace), preset="autonomous")

        original_settings = server_control.features.project_settings
        original_reply = server_control.features._permission_reply
        original_directory = server_control.features._session_directory
        original_requests = server_control.features._permission_requests
        try:
            os.environ["OPENCODE_PERMISSION_POLICY"] = "workspace"
            server_control.features.project_settings = lambda directory: {
                "permissionRules": [{"action":"read", "resource":"*", "effect":"ask"}]
            }
            decision = server_control.decision_for({"action":"read", "resources":["README.md"]}, str(workspace))
            assert decision["effect"] == "ask" and decision["source"] == "project", decision

            os.environ["OPENCODE_PERMISSION_POLICY"] = "safe"
            server_control.features.project_settings = lambda directory: {
                "permissionRules": [{"action":"edit", "resource":"*", "effect":"allow"}]
            }
            decision = server_control.decision_for({"action":"edit", "resources":["app/api.js"]}, str(workspace))
            assert decision["effect"] == "allow" and decision["risk"] == "R2", decision

            server_control.features.project_settings = lambda directory: {
                "permissionRules": [{"action":"shell", "resource":"*", "effect":"allow"}]
            }
            decision = server_control.decision_for({"action":"shell", "resources":["rm -rf build"]}, str(workspace))
            assert decision["effect"] == "ask" and decision["risk"] == "R3", decision

            server_control.features.project_settings = lambda directory: {
                "permissionRules": [{"action":"shell", "resource":"*", "effect":"deny"}]
            }
            decision = server_control.decision_for({"action":"shell", "resources":["rm -rf build"]}, str(workspace))
            assert decision["effect"] == "deny" and decision["reply"] == "reject", decision

            # Client supplies only IDs. The server re-fetches the actual pending
            # permission before deciding, so action/resources cannot be forged.
            replies: list[str] = []
            os.environ["OPENCODE_PERMISSION_POLICY"] = "workspace"
            server_control.features.project_settings = lambda directory: {"permissionRules": []}
            server_control.features._session_directory = lambda session_id: str(workspace)
            server_control.features._permission_requests = lambda directory: [{
                "id":"p1", "sessionID":"s1", "action":"shell", "resources":["git status --short"]
            }]
            server_control.features._permission_reply = lambda request, reply: replies.append(reply)
            result = server_control.evaluate_permission("s1", "p1")
            assert result["autoReplied"] is True and replies == ["once"], (result, replies)

            replies.clear()
            server_control.features._permission_requests = lambda directory: [{
                "id":"p2", "sessionID":"s1", "action":"shell", "resources":["git push origin main"]
            }]
            result = server_control.evaluate_permission("s1", "p2")
            assert result["autoReplied"] is False and result["risk"] == "R3" and not replies, (result, replies)
        finally:
            server_control.features.project_settings = original_settings
            server_control.features._permission_reply = original_reply
            server_control.features._session_directory = original_directory
            server_control.features._permission_requests = original_requests

        secret_request = {"action":"shell", "resources":["TOKEN=do-not-store cat README.md"]}
        decision = control_plane.classify_permission(secret_request, workspace=str(workspace))
        control_plane.audit_decision(decision, request=secret_request, session_id="s", permission_id="p")
        audit_path = root / "state" / "permission-audit.jsonl"
        event = json.loads(audit_path.read_text(encoding="utf-8").splitlines()[-1])
        assert "do-not-store" not in json.dumps(event), event

    print("Control-plane smoke passed: R0-R2 automation + project overrides + hard R3/R4 boundary")


if __name__ == "__main__":
    main()
