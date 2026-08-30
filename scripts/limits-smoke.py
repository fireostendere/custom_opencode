#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import py_compile
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "test")
os.environ.setdefault("OPENCODE_BACKEND_URL", "http://localhost:9")
os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "test")
os.environ.setdefault("OPENCODE_SCRATCH_DIRECTORY", str(Path(tempfile.gettempdir()) / "custom-opencode-limits-smoke-scratch"))
sys.path.insert(0, str(ROOT / "app"))
py_compile.compile(str(ROOT / "scripts/rag-probe.py"), doraise=True)
py_compile.compile(str(ROOT / "scripts/control-plane-smoke.py"), doraise=True)
py_compile.compile(str(ROOT / "app/control_plane.py"), doraise=True)
py_compile.compile(str(ROOT / "app/server_control.py"), doraise=True)
py_compile.compile(str(ROOT / "app/server_features.py"), doraise=True)
py_compile.compile(str(ROOT / "app/server_workflow.py"), doraise=True)

with tempfile.TemporaryDirectory() as temp:
    fake_codex = Path(temp) / "codex"
    fake_codex.write_text(
        "#!/usr/bin/env python3\n"
        "import json,sys\n"
        "for line in sys.stdin:\n"
        " r=json.loads(line)\n"
        " if r.get('method')=='initialize': print(json.dumps({'id':r['id'],'result':{'ok':True}}),flush=True)\n"
        " elif r.get('method')=='account/rateLimits/read': print(json.dumps({'id':r['id'],'result':{'rateLimits':{},'rateLimitsByLimitId':{'codex':{'planType':'plus','primary':{'usedPercent':37,'windowDurationMins':300,'resetsAt':2000000000},'secondary':{'usedPercent':72,'windowDurationMins':10080,'resetsAt':2000100000}}}}}),flush=True)\n",
        encoding="utf-8",
    )
    fake_codex.chmod(fake_codex.stat().st_mode | stat.S_IXUSR)

    fake_bl = Path(temp) / "bl"
    fake_bl.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "print(json.dumps({'per5HourPercentage':0.375,'per5HourResetTime':2000000000000,'per1WeekPercentage':0.72,'per1WeekResetTime':2000100000000}))\n",
        encoding="utf-8",
    )
    fake_bl.chmod(fake_bl.stat().st_mode | stat.S_IXUSR)

    os.environ["CODEX_BIN"] = str(fake_codex)
    os.environ["BAILIAN_CLI_BIN"] = str(fake_bl)

    import server_ext

    server_ext.base.backend_json = lambda method, target: {
        "data": [{"title": "Smoke · Qwen exhausted→08-29 02:00 UTC"}]
    }
    server_ext._codex_cache.update(at=0.0, value=None)
    server_ext._bailian_cache.update(at=0.0, value=None)

    codex = server_ext.query_codex_rate_limits()
    assert codex["available"] is True
    assert codex["primary"]["remainingPercent"] == 63
    assert codex["primary"]["windowDurationMins"] == 300
    assert codex["secondary"]["remainingPercent"] == 28
    assert codex["secondary"]["windowDurationMins"] == 10080

    qwen = server_ext.query_qwen_status()
    assert qwen["available"] is True
    assert qwen["source"] == "bailian-cli"
    assert qwen["state"] == "ok"
    assert qwen["fiveHour"]["remainingPercent"] == 62.5
    assert qwen["fiveHour"]["remainingCredits"] == 7_500
    assert qwen["fiveHour"]["resetsAt"] == 2_000_000_000
    assert qwen["sevenDay"]["remainingPercent"] == 28.0
    assert qwen["sevenDay"]["remainingCredits"] == 11_200
    assert qwen["sevenDay"]["resetsAt"] == 2_000_100_000

    import server_plus

    assert server_plus._model_ids({"data": [
        {"providerID": "bailian-cli", "id": "qwen3.8-max"},
        {"providerID": "bailian-cli", "id": "qwen3.6-flash"},
    ]}) == {"bailian-cli/qwen3.8-max", "bailian-cli/qwen3.6-flash"}
    assert server_plus._assistant_messages([
        {"info": {"role": "user"}, "parts": [{"type": "text", "text": "DOCTOR_OK"}]},
        {"info": {"role": "assistant"}, "parts": [{"type": "text", "text": "waiting"}]},
    ]) == [{"info": {"role": "assistant"}, "parts": [{"type": "text", "text": "waiting"}]}]

    def fake_backend(method, target, payload=None, timeout=20.0):
        if target.startswith("/api/model"):
            return {"data": [
                {"providerID": "bailian-cli", "id": "qwen3.8-max"},
                {"providerID": "bailian-cli", "id": "qwen3.6-flash"},
            ]}
        if target.startswith("/api/mcp"):
            return {"data": {"kb": {"status": "disabled"}}}
        raise AssertionError(target)

    server_plus._backend_request_json = fake_backend
    server_plus._read_runtime_config = lambda: ({
        "model": "bailian-cli/qwen3.8-max",
        "agents": {
            "fast-reader": {"model": "bailian-cli/qwen3.6-flash"},
            "title": {"model": "bailian-cli/qwen3.6-flash"},
        },
    }, "/tmp/opencode.json")
    server_plus.ext.query_bailian_token_plan = lambda: {"available": True}
    server_plus._rag_runtime = lambda: {
        "root": None, "executable": None, "python": None, "available": False,
    }
    snapshot = server_plus.doctor_snapshot()
    checks = {item["id"]: item for item in snapshot["checks"]}
    assert snapshot["zeroToken"] is True
    assert checks["backend"]["status"] == "pass"
    assert checks["max-catalog"]["status"] == "pass"
    assert checks["flash-catalog"]["status"] == "pass"
    assert checks["primary-route"]["status"] == "pass"
    assert checks["flash-route"]["status"] == "pass"
    assert checks["no-auto-local"]["status"] == "pass"
    assert checks["mcp-kb"]["status"] == "warn"

    project = Path(temp) / "project"
    project.mkdir()
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(project)
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(Path(temp) / "features.json")

    import server_features

    prompt_calls = []
    server_features._backend_request_json = lambda method, target, payload=None, timeout=20.0: prompt_calls.append((method, target, payload))
    server_features._send_backend_prompt("ses_idle", "start", [])
    assert prompt_calls[0][2] == {"text": "start", "files": [], "resume": True}

    settings_value = server_features.update_project_settings(str(project), {
        "instructions": "run tests before finishing",
        "defaultMode": "plan",
        "defaultModel": "bailian-cli/qwen3.8-max",
        "rag": "on",
        "permissionRules": [
            {"action": "shell", "resource": "git status*", "effect": "allow"},
            {"action": "shell", "resource": "rm *", "effect": "deny"},
        ],
    })
    assert settings_value["settings"]["defaultMode"] == "plan"
    assert settings_value["settings"]["defaultModel"] == "bailian-cli/qwen3.8-max"
    assert len(settings_value["settings"]["permissionRules"]) == 2

    stale = server_features.update_project_settings(str(project), {
        "defaultModel": "auto",
        "autoRouting": {"localModel": "ollama/example"},
    })
    assert stale["settings"]["defaultModel"] == "inherit"
    assert "autoRouting" not in stale["settings"]
    local_default = server_features.update_project_settings(str(project), {"defaultModel": "ollama/qwen3.8:27b"})
    assert local_default["settings"]["defaultModel"] == "inherit"

    server_features._session_directory = lambda session_id: str(project)
    queued_a = server_features.enqueue_prompt({"sessionID": "ses_test", "text": "first", "files": [], "profile": "direct"})
    queued_b = server_features.enqueue_prompt({"sessionID": "ses_test", "text": "second", "files": [], "profile": "orchestrated"})
    queue = server_features.queue_snapshot("ses_test")
    assert queue["count"] == 2
    assert [item["text"] for item in queue["items"]] == ["first", "second"]
    server_features.reorder_queue("ses_test", [queued_b["item"]["id"], queued_a["item"]["id"]])
    assert [item["text"] for item in server_features.queue_snapshot("ses_test")["items"]] == ["second", "first"]
    server_features.delete_queue_item("ses_test", queued_b["item"]["id"])
    assert server_features.queue_snapshot("ses_test")["count"] == 1

    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "config", "user.email", "smoke@example.invalid"], check=True)
    subprocess.run(["git", "-C", str(project), "config", "user.name", "Smoke"], check=True)
    tracked = project / "tracked.txt"
    tracked.write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)
    tracked.write_text("changed\n", encoding="utf-8")
    result = server_features.git_revert({"directory": str(project), "path": "tracked.txt", "mode": "file"})
    assert result["ok"] is True and tracked.read_text(encoding="utf-8") == "base\n"
    try:
        server_features.git_revert({"directory": str(project), "path": "../outside.txt", "mode": "file"})
    except ValueError:
        pass
    else:
        raise AssertionError("git revert containment accepted parent traversal")

# Keep permission policy regression in the normal verifier path. It uses only
# fake backend hooks and local temporary files; no model inference is performed.
subprocess.run([sys.executable, str(ROOT / "scripts/control-plane-smoke.py")], check=True)

print("Limits + Doctor + workflow + control-plane zero-token smoke passed")
