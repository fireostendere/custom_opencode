#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    temp_root = Path(temp)
    runtime_db = temp_root / "state" / "runtime.sqlite3"
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(runtime_db)
    os.environ["OPENCODE_PROCESS_SNAPSHOT"] = "steam.exe;game.exe"
    os.environ["OPENCODE_GAME_PROCESSES"] = "game.exe"
    os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "auto"
    os.environ["MCP_SMOKE_TOKEN"] = "runtime-smoke-secret"

    from model_registry import CapabilityRegistry, ResourceScheduler
    from repo_services import (
        ArtifactStore,
        ContextService,
        RepoIndexer,
        SecretBroker,
        VerificationPipeline,
        classify_failure,
        git_snapshot,
        semantic_diff,
    )
    from runtime_store import RuntimeStore
    import server_runtime

    store = RuntimeStore(runtime_db)
    store.initialize()
    assert runtime_db.is_file()

    project = temp_root / "project"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "config", "user.email", "smoke@example.invalid"], check=True)
    subprocess.run(["git", "-C", str(project), "config", "user.name", "Runtime Smoke"], check=True)
    (project / "package.json").write_text(json.dumps({"scripts": {"lint": "echo lint", "test": "echo test"}}), encoding="utf-8")
    (project / "src.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)

    baseline = git_snapshot(str(project))
    first = store.create_task(
        session_id="ses_first",
        project_dir=str(project),
        text="first",
        profile="qwen3.8-coder",
        priority=5,
        baseline=baseline,
    )
    second = store.create_task(
        session_id="ses_second",
        project_dir=str(project),
        text="second",
        dependencies=[first["id"]],
        baseline=baseline,
    )
    assert second["state"] == "blocked"
    assert store.next_ready(session_id="ses_second") is None
    store.transition(first["id"], "completed")
    ready = store.next_ready(session_id="ses_second")
    assert ready and ready["id"] == second["id"] and ready["state"] == "queued"

    checkpoint = store.checkpoint(second["id"], "planning", summary="plan persisted", data={"step": 1})
    assert checkpoint["stage"] == "planning"
    assert store.checkpoints(second["id"])[0]["summary"] == "plan persisted"
    assert any(event["kind"] == "checkpoint.created" for event in store.events(task_id=second["id"]))

    store.memory_set(str(project), "testing", "run smoke before merge", "policy")
    assert store.memory_list(str(project))[0]["key"] == "testing"
    decision = store.decision_add(str(project), "Runtime store", "Use SQLite WAL", "durable local state")
    assert decision["decision"] == "Use SQLite WAL"
    mail = store.mailbox_send(
        project_dir=str(project),
        from_task=first["id"],
        to_task=second["id"],
        message_type="finding",
        payload={"text": "shared finding"},
    )
    assert mail["type"] == "finding"
    assert store.mailbox_receive(second["id"])[0]["payload"]["text"] == "shared finding"

    store.add_usage(task_id=first["id"], model_ref="bailian-cli/qwen3.8-max", stage="implementation", input_tokens=120, output_tokens=30, latency_ms=250, success=True)
    usage = store.usage_summary(first["id"])
    assert usage["total"]["inputTokens"] == 120
    assert store.model_stats("bailian-cli/qwen3.8-max")["samples"] >= 1

    catalog = [
        {
            "providerID": "bailian-cli",
            "id": "qwen3.8-max",
            "name": "Qwen3.8 Max",
            "capabilities": {"tools": True, "input": ["text", "image"]},
            "limit": {"context": 983616},
        },
        {
            "providerID": "bailian-cli",
            "id": "qwen3.6-flash",
            "name": "Qwen3.6 Flash",
            "capabilities": {"tools": True, "input": ["text"]},
            "limit": {"context": 983616},
        },
    ]
    registry = CapabilityRegistry(catalog)
    max_caps = registry.get("bailian-cli/qwen3.8-max")
    assert max_caps and max_caps["vision"] is True and max_caps["tools"] is True
    assert max_caps["contextClass"] == "huge" and max_caps["review"] >= 0.9
    profiles = registry.profiles()
    assert {"qwen3.8-coder", "qwen3.8-orchestrated", "qwen3.8-review"}.issubset(profiles)

    scheduler = ResourceScheduler()
    scheduler.local_available = lambda force=False: True  # deterministic smoke, no network
    constrained = scheduler.decide(profiles["qwen3.8-coder"])
    assert constrained.game_detected is True
    assert constrained.selected_model == profiles["qwen3.8-coder"]["cloudModel"]
    direct = scheduler.decide(profiles["direct"], selected_model="manual/model")
    assert direct.selected_model == "manual/model"

    indexer = RepoIndexer(store)
    index = indexer.refresh(str(project), force=True)
    assert index["files"] >= 2
    hits = indexer.search(str(project), "alpha")
    assert any(hit.get("name") == "alpha" for hit in hits["hits"])

    (project / "src.py").write_text("def alpha():\n    return 2\n\ndef beta():\n    return 3\n", encoding="utf-8")
    diff = semantic_diff(str(project), baseline)
    assert "src.py" in diff["changedFiles"]

    artifacts = ArtifactStore(store)
    artifact = artifacts.put(
        task_id=first["id"], project_dir=str(project), kind="log", title="large log",
        content=("line\n" * 7000) + "needle\n", summary="smoke log",
    )
    ranged = artifacts.get(artifact["id"], offset=0, limit=100)
    assert ranged and len(ranged["content"]) <= 100
    searched = artifacts.get(artifact["id"], query="needle")
    assert searched and searched["content"] and searched["content"][0]["context"].endswith("needle")

    context = ContextService(store, indexer).envelope(
        project_dir=str(project), task=store.get_task(second["id"]),
        project_instructions="run tests before merge", budget_chars=8000,
    )
    assert context["usedChars"] <= context["budgetChars"]
    assert "Project instructions" in context["text"]
    assert "Project memory" in context["text"]

    pipeline = VerificationPipeline(artifacts)
    discovered = {item["name"] for item in pipeline.discover(str(project))}
    assert {"lint", "test"}.issubset(discovered)
    assert classify_failure("temporary failure in name resolution", 1) == "network"
    assert classify_failure("permission denied", 1) == "environment"
    assert classify_failure("assert 1 == 2", 1) == "code"

    broker = SecretBroker()
    assert broker.resolve("MCP_SMOKE_TOKEN", scope="test") == "runtime-smoke-secret"
    assert "runtime-smoke-secret" not in json.dumps(broker.snapshot())

    # Worktree isolation is fail-closed: clean managed worktrees can be removed,
    # dirty ones are deliberately refused by server_runtime._remove_worktree().
    server_runtime.STORE = store
    worktree_task_id = "t_worktree_smoke"
    worktree = server_runtime._create_worktree(str(project), worktree_task_id)
    worktree_task = store.create_task(
        task_id=worktree_task_id,
        session_id="ses_worktree",
        project_dir=worktree,
        text="isolated",
        metadata={"worktree": worktree, "ownershipRoot": str(project)},
        baseline=git_snapshot(worktree),
    )
    cleanup = server_runtime._remove_worktree(worktree_task)
    assert cleanup["ok"] is True and not Path(worktree).exists()

    class FakeFeatures:
        def __init__(self):
            self.forks = 0
        def _session_directory(self, sid):
            return str(project)
        @staticmethod
        def _data(value):
            return value.get("data") if isinstance(value, dict) and "data" in value else value
        @staticmethod
        def _workspace_target(path, directory):
            return path
        def _backend_request_json(self, method, target, payload=None, timeout=20.0):
            if target.endswith("/fork") and method == "POST":
                self.forks += 1
                return {"id": f"ses_fork_{self.forks}"}
            if "/message" in target:
                return []
            if target == "/api/mcp":
                return {"kb": {"status": "connected"}, "github": {"status": "connected"}}
            if target == "/api/model":
                return catalog
            raise AssertionError((method, target, payload))
        @staticmethod
        def _run_rag_probe(mode):
            assert mode == "status"
            return {"tools": ["kb_knowledge_search", "kb_knowledge_get"]}

    fake = FakeFeatures()
    server_runtime.STORE = store
    server_runtime.INDEXER = indexer
    server_runtime.ARTIFACTS = artifacts
    server_runtime.CONTEXT = ContextService(store, indexer)
    speculative = server_runtime.spawn_speculative(fake, {"sessionID": "ses_root", "text": "investigate", "count": 2})
    assert len(speculative["children"]) == 2
    assert len(speculative["parent"]["dependencies"]) == 2
    gateway = server_runtime.mcp_gateway(fake, str(project), "kb")
    assert gateway["lazyCatalog"] is True
    assert gateway["detail"]["tools"] == ["kb_knowledge_get", "kb_knowledge_search"]

print("Server runtime v2 smoke passed: durable tasks + profiles/scheduler + repo/context/artifacts + worktrees/speculation/MCP metadata")
