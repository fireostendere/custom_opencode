#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    temp_root = Path(temp)
    runtime_db = temp_root / "state" / "runtime.sqlite3"
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(runtime_db)
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
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "smoke@example.invalid"], check=True
    )
    subprocess.run(["git", "-C", str(project), "config", "user.name", "Runtime Smoke"], check=True)
    (project / "package.json").write_text(
        json.dumps({"scripts": {"lint": "echo lint", "test": "echo test"}}), encoding="utf-8"
    )
    (project / "src.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (project / "rename-me.txt").write_text("rename\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)

    baseline = git_snapshot(str(project))
    subprocess.run(["git", "-C", str(project), "mv", "rename-me.txt", "renamed.txt"], check=True)
    renamed = git_snapshot(str(project))
    assert {"rename-me.txt", "renamed.txt"}.issubset(renamed["changed"])
    assert len(renamed["status"]) == 1
    subprocess.run(["git", "-C", str(project), "mv", "renamed.txt", "rename-me.txt"], check=True)
    first = store.create_task(
        session_id="ses_first",
        project_dir=str(project),
        text="first",
        profile="build",
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
    events_before = store.events(task_id=first["id"])
    store.update_task(first["id"], metadata_patch={"progressCheckedAt": 123})
    assert store.get_task(first["id"])["metadata"]["progressCheckedAt"] == 123
    assert (
        store.events(task_id=first["id"]) == events_before
    ), "Internal observations must not emit null-priority edits"
    store.update_task(first["id"], priority=5)
    assert (
        store.events(task_id=first["id"]) == events_before
    ), "Unchanged priorities must not emit edits"
    store.update_task(first["id"], priority=10)
    assert store.events(task_id=first["id"])[-1]["data"] == {"priority": 10}
    store.update_task(first["id"], route={"selectedModel": "test/model"})
    assert store.events(task_id=first["id"])[-1]["data"] == {
        "route": {"selectedModel": "test/model"}
    }
    store.update_task(first["id"], verification={"ok": False})
    assert store.events(task_id=first["id"])[-1]["data"] == {"verification": {"ok": False}}
    store.update_task(first["id"], verification={})
    assert store.next_ready(session_id="ses_second") is None
    store.transition(first["id"], "completed")
    ready = store.next_ready(session_id="ses_second")
    assert ready and ready["id"] == second["id"] and ready["state"] == "queued"

    claimed = []
    gate = threading.Barrier(3)

    def claim_once() -> None:
        gate.wait()
        claimed.append(store.claim_dispatch(second["id"]))

    threads = [threading.Thread(target=claim_once) for _ in range(2)]
    for thread in threads:
        thread.start()
    gate.wait()
    for thread in threads:
        thread.join()
    assert sum(item is not None for item in claimed) == 1
    assert store.get_task(second["id"])["dispatch_attempts"] == 1

    checkpoint = store.checkpoint(
        second["id"], "planning", summary="plan persisted", data={"step": 1}
    )
    assert checkpoint["stage"] == "planning"
    assert store.checkpoints(second["id"])[0]["summary"] == "plan persisted"
    assert any(event["kind"] == "checkpoint.saved" for event in store.events(task_id=second["id"]))

    store.memory_set(str(project), "testing", "run smoke before merge", "policy")
    assert store.memory_list(str(project))[0]["key"] == "testing"
    decision = store.decision_add(
        str(project), "Runtime store", "Use SQLite WAL", "durable local state"
    )
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

    store.add_usage(
        task_id=first["id"],
        model_ref="bailian-cli/qwen3.7-plus",
        stage="implementation",
        input_tokens=120,
        output_tokens=30,
        latency_ms=250,
        success=True,
    )
    usage = store.usage_summary(first["id"])
    assert usage["total"]["inputTokens"] == 120
    assert store.model_stats("bailian-cli/qwen3.7-plus")["samples"] >= 1

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
            "id": "qwen3.7-plus",
            "name": "Qwen3.7 Plus",
            "capabilities": {"tools": True, "input": ["text", "image"]},
            "limit": {"context": 1000000},
        },
        {
            "providerID": "bailian-cli",
            "id": "qwen3.8-flash",
            "name": "Qwen3.8 Flash",
            "capabilities": {"tools": True, "input": ["text", "image"]},
            "limit": {"context": 983616},
        },
        {
            "providerID": "bailian-cli",
            "id": "deepseek-v4-pro-0813",
            "name": "DeepSeek V4 Pro 0813",
            "capabilities": {"tools": True, "input": ["text"]},
            "limit": {"context": 262144},
        },
        {
            "providerID": "bailian-cli",
            "id": "glm-5.2",
            "name": "GLM-5.2",
            "capabilities": {"tools": True, "input": ["text"]},
            "limit": {"context": 262144},
        },
    ]
    registry = CapabilityRegistry(catalog)
    max_caps = registry.get("bailian-cli/qwen3.8-max")
    assert max_caps and max_caps["vision"] is True and max_caps["tools"] is True
    assert max_caps["contextClass"] == "huge" and max_caps["review"] >= 0.9
    profiles = registry.profiles()
    assert {
        "direct",
        "fast",
        "build",
        "architect",
        "sol-orchestrated",
        "sol-review",
        "critical",
        "review",
        "research",
        "long-horizon",
    } == set(profiles)

    scheduler = ResourceScheduler()
    build_route = scheduler.decide(profiles["build"])
    assert build_route.mode == "provider-pinned"
    assert build_route.selected_model == "bailian-cli/qwen3.7-plus"
    fast_route = scheduler.decide(profiles["fast"])
    assert fast_route.selected_model == "bailian-cli/qwen3.8-flash"
    review_route = scheduler.decide(profiles["review"])
    assert review_route.selected_model == "bailian-cli/deepseek-v4-pro-0813"
    direct = scheduler.decide(profiles["direct"], selected_model="manual/model")
    assert direct.selected_model == "manual/model"
    assert (
        server_runtime._model_ref(
            {"model": {"providerID": "openai", "id": "gpt-test", "variant": "high"}}
        )
        == "openai/gpt-test#high"
    )

    indexer = RepoIndexer(store)
    index = indexer.refresh(str(project), force=True)
    assert index["files"] >= 2
    hits = indexer.search(str(project), "alpha")
    assert any(hit.get("name") == "alpha" for hit in hits["hits"])

    (project / "src.py").write_text(
        "def alpha():\n    return 2\n\ndef beta():\n    return 3\n", encoding="utf-8"
    )
    diff = semantic_diff(str(project), baseline)
    assert "src.py" in diff["changedFiles"]
    subprocess.run(["git", "-C", str(project), "add", "src.py"], check=True)
    assert "src.py" in semantic_diff(str(project), baseline)["changedFiles"]
    subprocess.run(["git", "-C", str(project), "reset", "-q", "HEAD", "--", "src.py"], check=True)

    artifacts = ArtifactStore(store)
    artifact = artifacts.put(
        task_id=first["id"],
        project_dir=str(project),
        kind="log",
        title="large log",
        content=("line\n" * 7000) + "needle\n",
        summary="smoke log",
    )
    ranged = artifacts.get(artifact["id"], offset=0, limit=100)
    assert ranged and len(ranged["content"]) <= 100
    searched = artifacts.get(artifact["id"], query="needle")
    assert searched and searched["content"] and searched["content"][0]["context"].endswith("needle")
    binary = artifacts.put(
        task_id=first["id"],
        project_dir=str(project),
        kind="binary",
        title="binary",
        content=b"\xff\x00",
        mime="application/octet-stream",
    )
    binary_value = artifacts.get(binary["id"])
    assert (
        binary_value and binary_value["encoding"] == "base64" and binary_value["content"] == "/wA="
    )

    context = ContextService(store, indexer).envelope(
        project_dir=str(project),
        task=store.get_task(second["id"]),
        project_instructions="run tests before merge",
        budget_chars=8000,
    )
    assert context["usedChars"] <= context["budgetChars"]
    assert "Project instructions" in context["text"]
    assert "Project memory" in context["text"]

    pipeline = VerificationPipeline(artifacts)
    discovered = {item["name"] for item in pipeline.discover(str(project))}
    assert {"lint", "test"}.issubset(discovered)
    assert classify_failure("assertion: expected no such file or directory", 1) == "code"
    assert classify_failure("assertion: operation timed out", 1) == "code"
    assert classify_failure("assert 1 == 2", 1) == "code"

    broker = SecretBroker()
    assert broker.resolve("MCP_SMOKE_TOKEN", scope="test") == "runtime-smoke-secret"
    assert "runtime-smoke-secret" not in json.dumps(broker.snapshot())

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
            self.session = {
                "agent": "build",
                "model": {"providerID": "openai", "id": "gpt-5.6-luna", "variant": "high"},
            }
            self.agent_switches = []
            self.model_switches = []

        def _session_directory(self, sid):
            return str(project)

        def _session_info(self, sid):
            return dict(self.session)

        @staticmethod
        def _data(value):
            return value.get("data") if isinstance(value, dict) and "data" in value else value

        @staticmethod
        def _workspace_target(path, directory):
            return path

        def _backend_request_json(self, method, target, payload=None, timeout=20.0):
            if target.endswith("/fork") and method == "POST":
                assert (payload or {}).get("boundary", {}).get("type") in ("before", "through"), payload
                self.forks += 1
                return {"id": f"ses_fork_{self.forks}"}
            if target.endswith("/agent") and method == "POST":
                self.agent_switches.append(payload)
                self.session["agent"] = payload["agent"]
                return {"ok": True}
            if target.endswith("/model") and method == "POST":
                self.model_switches.append(payload)
                return {"ok": True}
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
    assert server_runtime._profile_id("orchestrated") == "architect"
    assert server_runtime._profile_id("qwen3.8-orchestrated") == "architect"
    assert server_runtime._profile_id("gpt-5.6-sol-orchestrated") == "sol-orchestrated"
    try:
        server_runtime._profile_id("unknown-profile")
    except ValueError as error:
        assert "unknown model profile" in str(error)
    else:
        raise AssertionError("unknown profile must not silently become direct")
    direct_task = store.create_task(
        task_id="t_direct_agent_smoke",
        session_id="ses_direct_agent",
        project_dir=str(project),
        text="direct",
        profile="direct",
        kind="prompt",
        baseline=git_snapshot(str(project)),
    )
    server_runtime._switch_session(fake, direct_task)
    assert fake.agent_switches == [
        {"agent": "build-direct"}
    ], "direct dispatch must select the deny-delegation agent"
    # Plan routing changes the agent only: Qwen alias, SOL alias and a direct
    # model with a variant all retain their exact model selection.
    for profile, model, expected_agent in (
        ("architect", {"providerID": "bailian-cli", "id": "qwen3.8-orchestrated"}, "plan"),
        ("sol-orchestrated", {"providerID": "openai", "id": "gpt-5.6-sol-orchestrated"}, "plan"),
        ("direct", {"providerID": "custom", "id": "manual", "variant": "precise"}, "plan-direct"),
    ):
        fake.session = {"agent": "build", "model": dict(model)}
        fake.model_switches.clear()
        plan_task = store.create_task(
            session_id=f"ses_plan_{profile}",
            project_dir=str(project),
            text="plan",
            profile=profile,
            kind="prompt",
            metadata={"modeAtCreate": "plan"},
            baseline=git_snapshot(str(project)),
        )
        server_runtime._switch_session(fake, plan_task)
        assert fake.agent_switches[-1] == {"agent": expected_agent}
        assert fake.model_switches == [], f"plan routing rewrote {profile} model"
        assert fake.session["model"] == model
    # Provider-pinned build routes split the variant out of id; direct routes
    # never issue a model switch.
    fake.session = {
        "agent": "build",
        "model": {"providerID": "custom", "id": "manual", "variant": "precise"},
    }
    fake.model_switches.clear()
    original_profiles = server_runtime.REGISTRY.profiles
    server_runtime.REGISTRY.profiles = lambda: {
        "direct": {"id": "direct", "route": "selected", "agentBuild": "build-direct"},
        "build": {
            "id": "build",
            "route": "cloud",
            "cloudModel": "openai/gpt-test#high",
            "agentBuild": "build",
            "agentPlan": "plan",
        },
    }
    try:
        direct_switch = store.create_task(
            session_id="ses_direct_no_rewrite",
            project_dir=str(project),
            text="direct",
            profile="direct",
            baseline=git_snapshot(str(project)),
        )
        server_runtime._switch_session(fake, direct_switch)
        assert fake.model_switches == []
        pinned_switch = store.create_task(
            session_id="ses_pinned_variant",
            project_dir=str(project),
            text="pinned",
            profile="build",
            baseline=git_snapshot(str(project)),
        )
        server_runtime._switch_session(fake, pinned_switch)
        assert fake.model_switches == [
            {"model": {"providerID": "openai", "id": "gpt-test", "variant": "high"}}
        ]
    finally:
        server_runtime.REGISTRY.profiles = original_profiles

    class FailingSessionFeatures(FakeFeatures):
        def _backend_request_json(self, method, target, payload=None, timeout=20.0):
            if method == "POST" and target == "/api/session":
                return {"data": {}}
            return super()._backend_request_json(method, target, payload, timeout)

    before_worktrees = {
        line.split()[0]
        for line in subprocess.run(
            ["git", "-C", str(project), "worktree", "list", "--porcelain"],
            text=True,
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.splitlines()
        if line.startswith("worktree ")
    }
    try:
        server_runtime.create_task_request(
            FailingSessionFeatures(),
            {"sessionID": "ses_failure", "text": "isolated", "isolate": True, "profile": "direct"},
        )
    except RuntimeError as error:
        assert "session creation failed" in str(error)
    else:
        raise AssertionError("failed session creation must fail task request")
    after_worktrees = {
        line.split()[0]
        for line in subprocess.run(
            ["git", "-C", str(project), "worktree", "list", "--porcelain"],
            text=True,
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.splitlines()
        if line.startswith("worktree ")
    }
    assert after_worktrees == before_worktrees, "failed isolated creation orphaned a worktree"

    class SuccessfulVerification:
        @staticmethod
        def run(task):
            return {
                "enabled": False,
                "ok": True,
                "actionableFailures": [],
                "environmentFailures": [],
            }

    original_verify = server_runtime.VERIFY
    original_review_decision = server_runtime.review_decision
    server_runtime.VERIFY = SuccessfulVerification()
    server_runtime.review_decision = lambda project_dir, baseline: {"needed": True}
    try:
        direct_finish = store.create_task(
            task_id="t_direct_review_smoke",
            session_id="ses_direct_review",
            project_dir=str(project),
            text="direct",
            profile="direct",
            kind="prompt",
            baseline=git_snapshot(str(project)),
        )
        server_runtime._verify_finish(fake, direct_finish["id"])
        assert not [
            item
            for item in store.list_tasks(session_id="ses_direct_review")
            if item.get("kind") == "review"
        ]

        orchestrated_finish = store.create_task(
            task_id="t_orchestrated_review_smoke",
            session_id="ses_orchestrated_review",
            project_dir=str(project),
            text="orchestrated",
            profile="architect",
            kind="prompt",
            baseline=git_snapshot(str(project)),
        )
        server_runtime._verify_finish(fake, orchestrated_finish["id"])
        assert not [
            item
            for item in store.list_tasks(session_id="ses_orchestrated_review")
            if item.get("kind") == "review"
        ], "native orchestrator must not receive a duplicate server review"
        with store.connect() as db:
            assert (
                db.execute(
                    "SELECT owner FROM execution_review_claims WHERE root_id=?",
                    (orchestrated_finish["id"],),
                ).fetchone()[0]
                == "orchestrator"
            )
    finally:
        server_runtime.VERIFY = original_verify
        server_runtime.review_decision = original_review_decision
    speculative = server_runtime.spawn_speculative(
        fake, {"sessionID": "ses_root", "text": "investigate", "count": 2}
    )
    assert len(speculative["children"]) == 2
    assert len(speculative["parent"]["dependencies"]) == 2
    gateway = server_runtime.mcp_gateway(fake, str(project), "kb")
    assert gateway["lazyCatalog"] is True
    assert gateway["detail"]["tools"] == ["kb_knowledge_get", "kb_knowledge_search"]

    old = store.create_task(
        task_id="t_prune_old", session_id="ses_old", project_dir=str(project), text="old"
    )
    store.transition(old["id"], "completed")
    old_artifact = artifacts.put(
        task_id=old["id"], project_dir=str(project), kind="log", title="old", content="x" * 30000
    )
    with store.transaction() as database:
        stale = server_runtime.now_ms() - 2 * 86_400_000
        database.execute(
            "UPDATE tasks SET updated_at=?,finished_at=? WHERE id=?", (stale, stale, old["id"])
        )
        database.execute("UPDATE cache SET expires_at=?", (stale,))
    pruned = store.prune(retention_days=1)
    assert pruned["tasks"] == 1 and store.get_task(old["id"]) is None
    assert not (store.paths.artifacts / old["id"] / old_artifact["id"]).exists()
    failed_dependency = store.create_task(
        session_id="ses_retained", project_dir=str(project), text="failed prerequisite"
    )
    store.transition(failed_dependency["id"], "failed")
    dependent = store.create_task(
        session_id="ses_dependent",
        project_dir=str(project),
        text="blocked",
        dependencies=[failed_dependency["id"]],
    )
    with store.transaction() as database:
        database.execute(
            "UPDATE tasks SET finished_at=? WHERE id=?", (stale, failed_dependency["id"])
        )
    store.prune(retention_days=1)
    assert store.get_task(failed_dependency["id"]) is not None
    assert not store.dependency_state(dependent["id"])[0]

print(
    "Server runtime v2 smoke passed: durable tasks + provider-pinned profiles + repo/context/artifacts + worktrees/speculation/MCP metadata"
)
