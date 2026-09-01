#!/usr/bin/env python3
"""Zero-network regression checks for the unified Web/TUI/backend contract."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
sys.path.insert(0, str(APP))

spec = importlib.util.spec_from_file_location("unified_control", APP / "unified_control.py")
assert spec and spec.loader
unified = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unified)

workspace_js = (APP / "unified-workspace.js").read_text(encoding="utf-8")
workspace_css = (APP / "unified-workspace.css").read_text(encoding="utf-8")
loader_js = (APP / "access-fix-limits.js").read_text(encoding="utf-8")
workflow_py = (APP / "server_workflow.py").read_text(encoding="utf-8")
tui_jsx = (ROOT / "config/plugins/tui/limits-panels.jsx").read_text(encoding="utf-8")

for marker in (
    '"contract": "state-actions-events"',
    '"unifiedPanel": True',
    '"activityTimeline": True',
    '"verificationCenter": True',
    '"permissionAdvisor": True',
    '"globalSearch": True',
    '"resourceProfiles": True',
    '"/client-unified.json"',
    '"/client-activity.json"',
    '"/client-global-search.json"',
    '"/client-unified-action.json"',
    '"permissionAdvice"',
    '"retryOf"',
):
    assert marker in (APP / "unified_control.py").read_text(encoding="utf-8"), marker

for marker in (
    "unified_control.handle_get",
    "unified_control.handle_post",
):
    assert marker in workflow_py, marker

for marker in (
    "Universal Panel",
    "client-unified.json",
    "client-activity.json",
    "client-global-search.json",
    "followActivity",
    "state.unseen",
    "↓ ${state.unseen} new",
    "Ctrl+K",
    "resource.profile.",
    "CustomOpenCodeWorkspace",
):
    assert marker in workspace_js, marker

assert "#taskCenterButton{display:none!important}" in workspace_css
assert "@media(prefers-reduced-motion:reduce)" in workspace_css
assert "import('./unified-workspace.js')" in loader_js
assert "/unified-workspace.css" in loader_js

for marker in (
    'id: "custom.universal-panel"',
    'universal-panel.state',
    'custom.panel.activity',
    'custom.panel.plan',
    'custom.panel.limits',
    'custom.panel.end',
    'обновления не сбрасывают scroll',
):
    assert marker in tui_jsx, marker
for retired in ("function EdgePanel(props)", 'side="left"', "planPinned", "homePinned", "target.paddingLeft"):
    assert retired not in tui_jsx, retired


class FakeStore:
    def __init__(self) -> None:
        self.tasks = {
            "failed-1": {
                "id": "failed-1",
                "session_id": "s1",
                "project_dir": "/tmp/project",
                "text": "repair the failing task",
                "files": [{"name": "a.py"}],
                "profile": "build",
                "priority": 7,
                "dependencies": ["dep-1"],
                "kind": "prompt",
                "metadata": {"sandbox": "repo-write"},
                "state": "failed",
            }
        }
        self.events_rows = [
            {"kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
            {"kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
            {"kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
        ]
        self.created = None
        self.checkpointed = None
        self.emitted = []

    def get_task(self, task_id):
        return self.tasks.get(task_id)

    def create_task(self, **kwargs):
        self.created = {"id": "retry-1", "state": "queued", **kwargs}
        return self.created

    def checkpoint(self, task_id, stage, **kwargs):
        self.checkpointed = (task_id, stage, kwargs)
        return {"id": "cp-retry", "task_id": task_id, "stage": stage}

    def event(self, **kwargs):
        self.emitted.append(kwargs)
        return kwargs

    def events(self, **kwargs):
        return list(self.events_rows)

    def cache_get(self, *_args, **_kwargs):
        return None

    def cache_set(self, *_args, **_kwargs):
        return None


class FakeRuntime:
    def __init__(self) -> None:
        self.STORE = FakeStore()

    @staticmethod
    def _usage_totals(_features, _sid):
        return {"inputTokens": 12, "outputTokens": 3}

    @staticmethod
    def git_snapshot(directory):
        return {"directory": directory, "head": "abc"}

    @staticmethod
    def _public(task):
        return dict(task)

    @staticmethod
    def task_control(_features, payload):
        return {"ok": True, "resumed": payload["taskID"]}


runtime = FakeRuntime()
result = unified._retry_task(object(), runtime, "failed-1")
assert result["ok"] is True
assert result["retryOf"] == "failed-1"
assert result["task"]["id"] == "retry-1"
assert runtime.STORE.created["metadata"]["retryOf"] == "failed-1"
assert runtime.STORE.created["dependencies"] == ["dep-1"]
assert runtime.STORE.checkpointed[1] == "retry-created"
assert runtime.STORE.emitted[-1]["kind"] == "task.retry_created"

advice = unified._permission_advice(runtime, directory="/tmp/project")
assert len(advice["suggestions"]) == 1
rule = advice["suggestions"][0]["proposedRule"]
assert rule == {"action": "shell", "resource": "pytest *", "effect": "allow"}
assert advice["suggestions"][0]["requiresConfirmation"] is True
assert "R3/R4" in advice["suggestions"][0]["note"]

assert {profile["id"] for profile in unified.RESOURCE_PROFILES.values()} == {"normal", "gaming", "remote"}
assert all(action.get("id") for action in unified.ACTION_REGISTRY)
assert any(action["id"] == "model.add" and action.get("command") == "/addmodel" for action in unified.ACTION_REGISTRY)
assert any(action["id"] == "orchestration.add" and action.get("command") == "/addorchestration" for action in unified.ACTION_REGISTRY)

print("Unified workspace regression passed: state/actions/events + durable retry + permission advice + Web/TUI single-panel contracts")
