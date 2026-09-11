#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    db = root / "state" / "runtime.sqlite3"
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(db)
    os.environ["OPENCODE_REPO_EMBEDDINGS"] = "hash"
    os.environ["OPENCODE_SECRET_PREFIXES"] = "MCP_;TOKEN_PLAN_"
    os.environ["OPENCODE_SECRET_SCOPES"] = "shell=MCP_SMOKE_TOKEN;task:t1:shell=MCP_SMOKE_TOKEN"
    os.environ["MCP_SMOKE_TOKEN"] = "never-serialize-this"
    os.environ["OPENCODE_LOOP_LIMIT"] = "3"
    os.environ["OPENCODE_TOOL_ARTIFACT_THRESHOLD"] = "256"

    from model_registry import CapabilityRegistry, ResourceScheduler
    from runtime_store import RuntimeStore
    from repo_services import ArtifactStore, ContextService, RepoIndexer, git_snapshot
    from runtime_v3 import (
        BranchStateService,
        DynamicContextManager,
        ReplayService,
        SandboxManager,
        ScopedSecretBroker,
        SemanticRepoIndexer,
        SharedRAGService,
        ToolGateway,
    )

    store = RuntimeStore(db)
    store.initialize()
    project = root / "project"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "smoke@example.invalid"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.name", "Runtime V3 Smoke"], check=True
    )
    (project / "package.json").write_text(
        json.dumps({"scripts": {"test": "echo ok"}, "dependencies": {"left-pad": "1.3.0"}}),
        encoding="utf-8",
    )
    (project / "dep.py").write_text("def helper():\n    return 1\n", encoding="utf-8")
    (project / "src.py").write_text(
        "from .dep import helper\n\nclass Engine:\n    def alpha(self):\n        return helper()\n",
        encoding="utf-8",
    )
    (project / "ui.js").write_text(
        "import x from './util.js'\nexport function render(){ return x }\n", encoding="utf-8"
    )
    (project / "util.js").write_text("export const x = 1\n", encoding="utf-8")
    (project / "types.ts").write_text(
        "export interface UserConfig { id: string }\nexport type Status = 'active' | 'inactive'\n",
        encoding="utf-8",
    )
    (project / "api.js").write_text(
        "import {\n  x\n} from './util.js'\nexport default function handle() {}\n", encoding="utf-8"
    )
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)
    baseline = git_snapshot(str(project))

    indexer = SemanticRepoIndexer(store)
    index = indexer.refresh(str(project), force=True)
    assert index["version"] == SemanticRepoIndexer.VERSION
    assert index["embeddingBackend"] == "hashed-unicode-lexical-v2"
    assert any(s.get("qualified") == "Engine.alpha" for s in index["symbols"])
    assert any(
        s.get("name") == "UserConfig" and s.get("kind") == "interface" for s in index["symbols"]
    )
    assert any(s.get("name") == "Status" and s.get("kind") == "type" for s in index["symbols"])
    assert any(s.get("name") == "handle" and s.get("kind") == "function" for s in index["symbols"])
    assert any(
        edge.get("from") == "ui.js" and str(edge.get("to")).endswith("util.js")
        for edge in index["dependencyGraph"]
    )
    assert any(
        edge.get("from") == "api.js" and str(edge.get("to")).endswith("util.js")
        for edge in index["dependencyGraph"]
    )
    assert index["gitGraph"] and index["gitGraph"][0]["sha"] == baseline["head"]
    search = indexer.search(str(project), "Engine alpha")
    assert any(hit.get("qualified") == "Engine.alpha" for hit in search["hits"])

    (project / "src.py").write_text(
        "from .dep import helper\n\nclass Engine:\n    def alpha(self):\n        value = helper()\n        return value + 1\n",
        encoding="utf-8",
    )
    diff = indexer.semantic_diff(str(project), baseline)
    assert "src.py" in diff["changedFiles"]
    assert any(item.get("qualified") == "Engine.alpha" for item in diff["changedSymbols"]), diff
    first_dirty = git_snapshot(str(project))["statusHash"]
    (project / "src.py").write_text(
        "from .dep import helper\n\nclass Engine:\n    def alpha(self):\n        value = helper()\n        return value + 2\n",
        encoding="utf-8",
    )
    assert git_snapshot(str(project))["statusHash"] != first_dirty
    (project / "fresh.py").write_text("def untracked_symbol():\n    return 1\n", encoding="utf-8")
    refreshed = indexer.refresh(str(project))
    assert not refreshed["cacheHit"] and any(
        item.get("name") == "untracked_symbol" for item in refreshed["symbols"]
    )

    broker = ScopedSecretBroker()
    lease = broker.issue("MCP_SMOKE_TOKEN", scope="task:t1:shell", ttl=30)
    assert broker.redeem(lease, scope="task:t1:shell") == "never-serialize-this"
    assert "never-serialize-this" not in json.dumps(broker.snapshot())
    try:
        broker.issue("TOKEN_PLAN_API_KEY", scope="untrusted")
    except (PermissionError, KeyError):
        pass
    else:
        raise AssertionError("secret scope was not enforced")

    sandbox = SandboxManager()
    assert sandbox.path_allowed("src.py", str(project), "repo-write", write=True)
    assert not sandbox.path_allowed("../escape", str(project), "repo-write", write=True)
    try:
        sandbox.wrap_shell("rm -rf build", str(project), "safe")
    except PermissionError:
        pass
    else:
        raise AssertionError("safe sandbox accepted destructive shell")
    try:
        sandbox.wrap_shell("echo hi", str(project), "full-machine")
    except PermissionError:
        pass
    else:
        raise AssertionError("full-machine ran without explicit opt-in")
    wrapped = sandbox.wrap_shell("printf ok", str(project), "repo-write")["command"]
    assert "--unshare-net" in wrapped and f"--tmpfs {Path.home().parent}" in wrapped
    assert "--unshare-pid" in wrapped and wrapped.index("--ro-bind / /") < wrapped.index(
        "--proc /proc"
    )
    try:
        sandbox.wrap_shell("printf ok", str(Path.home()), "repo-write")
    except PermissionError:
        pass
    else:
        raise AssertionError("sandbox exposed the entire home directory")
    assert f"--bind {project} {project}" in wrapped

    artifacts = ArtifactStore(store)
    gateway = ToolGateway(store, artifacts, sandbox, broker)
    t1 = store.create_task(
        task_id="t1",
        session_id="s1",
        project_dir=str(project),
        text="Engine alpha edit",
        metadata={"sandbox": "repo-write"},
        baseline=baseline,
    )
    t2 = store.create_task(
        task_id="t2",
        session_id="s2",
        project_dir=str(project),
        text="other",
        metadata={"sandbox": "repo-write"},
        baseline=baseline,
    )
    store.transition(t1["id"], "submitted")
    store.transition(t2["id"], "submitted")
    assert gateway.before({"sessionID": "s1", "tool": "edit", "input": {"path": "src.py"}})["allow"]
    try:
        gateway.before({"sessionID": "s2", "tool": "edit", "input": {"path": "src.py"}})
    except RuntimeError as exc:
        assert "ownership" in str(exc)
    else:
        raise AssertionError("patch ownership conflict was not blocked")
    try:
        gateway.before({"sessionID": "s1", "tool": "edit", "input": {"path": "../escape"}})
    except PermissionError:
        pass
    else:
        raise AssertionError("sandbox traversal was accepted")
    large = gateway.after({"sessionID": "s1", "tool": "grep", "result": "x" * 2000})
    assert large["replace"] and large["result"]["artifactID"]
    duplicate = gateway.after({"sessionID": "s1", "tool": "grep", "result": "x" * 2000})
    assert duplicate["replace"] and duplicate["result"].get("deduplicated") is True
    small = gateway.after({"sessionID": "s1", "tool": "read", "result": "small"})
    assert not small["replace"]
    assert not gateway.after({"sessionID": "s1", "tool": "read", "result": "small"})["replace"]
    for attempt in range(3):
        try:
            gateway.before(
                {"sessionID": "s1", "tool": "edit", "input": {"path": "dep.py", "content": "same"}}
            )
        except RuntimeError:
            assert attempt == 2
            break
    else:
        raise AssertionError("loop detector did not block repeated mutation")
    with store.connect() as database:
        owned = {
            row[0]
            for row in database.execute(
                "SELECT path FROM patch_ownership WHERE task_id='t1'"
            ).fetchall()
        }
    assert {"src.py", "dep.py"}.issubset(owned), owned

    registry = CapabilityRegistry(
        [
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
    )
    profiles = registry.profiles()
    scheduler = ResourceScheduler()
    assert scheduler.decide(profiles["build"]).selected_model == "bailian-cli/qwen3.7-plus"
    assert scheduler.decide(profiles["fast"]).selected_model == "bailian-cli/qwen3.8-flash"
    assert (
        scheduler.decide(profiles["direct"], selected_model="openai/example").selected_model
        == "openai/example"
    )

    class FakeFeatures:
        def __init__(self):
            self.calls = []
            self.forks = 0

        def _session_directory(self, sid):
            return str(project)

        def _canonical_directory(self, value):
            return str(Path(value).resolve())

        @staticmethod
        def _data(value):
            return value.get("data") if isinstance(value, dict) and "data" in value else value

        @staticmethod
        def _workspace_target(path, directory):
            return path

        @staticmethod
        def _rag_runtime():
            return {"available": False}

        def _backend_request_json(self, method, target, payload=None, timeout=20.0):
            self.calls.append((method, target, payload))
            if target.endswith("/context") and method == "GET":
                return [{"type": "message", "text": "z" * 450000}]
            if target.endswith("/compact") and method == "POST":
                return {"ok": True}
            if target.endswith("/summarize") and method == "POST":
                return {"ok": True}
            if target.endswith("/fork") and method == "POST":
                self.forks += 1
                return {"id": f"fork-{self.forks}"}
            if "/message" in target and method == "GET":
                return [
                    {
                        "info": {"role": "assistant"},
                        "parts": [{"type": "text", "text": "recorded answer"}],
                    }
                ]
            if target == "/api/mcp":
                return {"kb": {"status": "connected"}}
            if target == "/api/mcp/resource":
                return [{"uri": "kb://status"}]
            if target in {"/api/experimental/tool/ids", "/experimental/tool/ids"}:
                return ["execute"]
            raise RuntimeError((method, target, payload))

    fake = FakeFeatures()

    legacy_index = RepoIndexer(store)
    legacy_context = ContextService(store, legacy_index)
    rag = SharedRAGService(store)
    manager = DynamicContextManager(store, indexer, rag)
    runtime_stub = SimpleNamespace(
        REGISTRY=SimpleNamespace(
            profiles=lambda: {
                "direct": {"contextPolicy": {"mode": "model-aware", "targetRatio": 0.72}}
            },
            get=lambda ref: {"context": 64000} if ref else None,
        ),
        CONTEXT=legacy_context,
    )
    context = manager.envelope(fake, runtime_stub, "s1", "run tests", rag_mode="off")
    assert context["compaction"]["activeTokens"] > context["compaction"]["budgetTokens"]
    assert context["compaction"]["compactionRequested"] is True
    assert any(call[1].endswith("/compact") for call in fake.calls)
    assert "Semantic repository matches" in context["text"]

    replay = ReplayService(store, artifacts)
    captured = replay.capture(fake, store.get_task("t1"))
    assert captured and captured["kind"] == "run-replay"
    replayed = replay.replay("t1")
    assert replayed["modelCalls"] == 0 and replayed["recording"]
    store.transition("t1", "completed")
    with store.connect() as database:
        assert (
            database.execute("SELECT COUNT(*) FROM patch_ownership WHERE task_id='t1'").fetchone()[
                0
            ]
            == 0
        )

    store.memory_set(str(project), "rule", "source memory", "policy")
    source = store.create_task(session_id="source-session", project_dir=str(project), text="source")
    target = store.create_task(session_id="target-session", project_dir=str(project), text="target")
    branches = BranchStateService(store)
    branched = branches.branch(fake, "source-session")
    assert branched["session"]["id"].startswith("fork-")
    merged = branches.merge(fake, "source-session", "target-session")
    assert merged["ok"] and merged["sourceTasks"] >= 1

print(
    "Runtime V3 smoke passed: AST/embeddings/diff + sandbox/broker/gateway + provider-pinned routing + compaction + replay/branching"
)
