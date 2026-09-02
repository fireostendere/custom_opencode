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
advanced_features_js = (APP / "advanced-features.js").read_text(encoding="utf-8")
workspace_css = (APP / "unified-workspace.css").read_text(encoding="utf-8")
loader_js = (APP / "access-fix-limits.js").read_text(encoding="utf-8")
workflow_py = (APP / "server_workflow.py").read_text(encoding="utf-8")
config_manager_js = (ROOT / "config/plugins/config-manager.js").read_text(encoding="utf-8")
tui_host = (ROOT / "config/plugins/tui/workspace-panel.jsx").read_text(encoding="utf-8")
tui_views = (ROOT / "config/plugins/tui/lib/panel-views.jsx").read_text(encoding="utf-8")
retired_host = (ROOT / "config/plugins/tui/limits-panels.jsx").read_text(encoding="utf-8")

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
    "openConfigWizard('mcp')",
    "openConfigWizard('skill')",
    "/api/session/${encodeURIComponent(session)}/command",
    "command:isMcp?'addmcp':'addskill',text:JSON.stringify(input)",
    "data-mcp-remote",
    "data-mcp-local",
    "parseLocalCommand",
    "const sensitiveName=",
    "function isSensitiveName(value)",
    "function localCredentialArgument",
    "Credentials must use env references.",
    "safeRemoteMcpURL",
    "if(response.status===204)return null",
    "req(qs('/client-plan.json'))",
    "const sessionID=sid(),planSeq=++state.planSeq;try{const value=await req(qs('/client-plan.json'));if(sid()!==sessionID||state.planSeq!==planSeq)return",
    "if(sid()!==session||state.refreshSeq!==refreshSeq)return\n    state.snapshot=snapshot",
    "state.plan=null;state.lastEventID=0",
    "^[A-Za-z][A-Za-z0-9._-]{0,63}$",
    "refreshSeq:0",
    "planSeq:0",
    "const refreshSeq=++state.refreshSeq",
    "state.refreshSeq!==refreshSeq",
    "const sessionID=sid(),planSeq=++state.planSeq",
    "state.planSeq!==planSeq",
    "state.refreshSeq+=1;state.planSeq+=1",
):
    assert marker in workspace_js, marker
assert "arguments:JSON.stringify(input)" not in workspace_js

wizard_action = workspace_js[workspace_js.index("function runAction"):workspace_js.index("function filteredActions")]
assert "prefillCommand(action.command)" in wizard_action
assert "if(id==='mcp.add'){openConfigWizard('mcp');return}" in wizard_action
assert "if(id==='skill.add'){openConfigWizard('skill');return}" in wizard_action
assert wizard_action.index("if(id==='mcp.add')") < wizard_action.index("prefillCommand(action.command)")
assert wizard_action.index("if(id==='skill.add')") < wizard_action.index("prefillCommand(action.command)")
assert "sendMessage" not in workspace_js
assert "prompt(" not in workspace_js

# Each independently-polled advanced surface must reject a reverse-order result.
for marker in (
    "queueRefreshSeq: 0",
    "orchestrationRefreshSeq: 0",
    "planRefreshSeq: 0",
    "state.queueRefreshSeq += 1",
    "state.orchestrationRefreshSeq += 1",
    "state.planRefreshSeq += 1",
    "const refreshSeq = ++state.queueRefreshSeq",
    "state.queueRefreshSeq === refreshSeq",
    "const refreshSeq = ++state.orchestrationRefreshSeq",
    "state.orchestrationRefreshSeq === refreshSeq",
    "const refreshSeq = ++state.planRefreshSeq",
    "state.planRefreshSeq === refreshSeq",
    "if (current() && [404,405].includes(error.status)) state.childrenTransport = 'unsupported'",
    "try { statuses = dataOf(await request('/api/session/active')) || {}; if (!current()) return } catch {}\n  if (!current()) return",
    "if (!current()) return\n      if (!state.activityItems.length)",
    "state.activityHydrated = true\n    }).catch(() => {})",
):
    assert marker in advanced_features_js, marker

for marker in (
    "parsed.username || parsed.password",
    "const SENSITIVE_NAME_RE =",
    "function assertCredentialReference",
    'replace(/([a-z])([A-Z])/g, "$1_$2")',
    "function rejectLocalCommandSecrets(command)",
    "function rejectLocalCredentialArgument(argument)",
    "Promise.allSettled([ctx.catalog.reload(), ctx.mcp.reload(), ctx.skill.reload()])",
    "managed reload failed:",
    "let mutationQueue = Promise.resolve()",
    "const enqueueMutation = (operation)",
    "mutationQueue = result.catch(() => {})",
    "const rollback = async (previous)",
    "try { await save() } catch (error) { failures.push(error) }",
    "try { await reloadAll() } catch (error) { failures.push(error) }",
    "rollback failed:",
    "registry === previous ? [] : await rollback(previous)",
    "name: \"remove-managed\"",
    "enqueueMutation(async () => {",
    "throw failure",
    "registry = { ...registry, mcp:",
    "registry = { ...registry, skills:",
    "api_key={env:DOCS_TOKEN}",
    "clientSecret={env:CLIENT_SECRET}",
    "--refreshToken",
    "--xApiKey",
    "--api_key",
    "X-Api-Key: {env:API_KEY}",
    "PASSWORD=literal",
    "Authorization: literal",
):
    assert marker in config_manager_js, marker

assert "#taskCenterButton{display:none!important}" in workspace_css
assert "@media(prefers-reduced-motion:reduce)" in workspace_css
for marker in (".unified-wizard{", "100dvh", "calc(100vw - 24px)", ".unified-wizard-form"):
    assert marker in workspace_css, marker
assert "import('./unified-workspace.js')" in loader_js
assert "/unified-workspace.css" in loader_js

# TUI still implements the unified workspace contract, but the single right-side
# host has evolved into one four-zone host with the same Activity/Plan/Limits
# behaviors plus Session/Orchestration/History views.
for marker in (
    'id: "custom.workspace-panel"',
    'workspace-panel.state',
    'universal-panel.state',
    'function freshZones()',
    'left:',
    'right:',
    'top:',
    'bottom:',
    'custom.panel.activity',
    'custom.panel.plan',
    'custom.panel.limits',
    'custom.panel.end',
    'stickyScroll={true}',
    'jumpToEnd',
    'cursorUnderOverlay',
    'context.ui.DialogSelect',
    'session.sidebar.toggle',
):
    assert marker in tui_host, marker
for marker in (
    'function ActivityView',
    'function PlanView',
    'function LimitsView',
    'function SessionView',
    'function OrchestrationView',
    'function HistoryView',
):
    assert marker in tui_views, marker
for retired in ("function EdgePanel(props)", "planPinned", "homePinned", 'id: "custom.universal-panel"'):
    assert retired not in tui_host, retired
assert 'id: "custom.limits-panels-retired"' in retired_host
assert 'id: "custom.universal-panel"' not in retired_host


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
            {"id": 1, "kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
            {"id": 2, "kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
            {"id": 3, "kind": "permission.resolved", "data": {"action": "shell", "resource": "pytest *"}},
        ]
        self.created = None
        self.checkpointed = None
        self.emitted = []
        self.event_calls = []

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
        self.event_calls.append(dict(kwargs))
        rows = list(self.events_rows)
        session_id = kwargs.get("session_id")
        if session_id is not None:
            rows = [row for row in rows if row.get("session_id") == session_id]
        after = int(kwargs.get("after") or 0)
        rows = [row for row in rows if int(row.get("id") or 0) > after]
        return rows[:int(kwargs.get("limit") or len(rows))]

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

# A session-scoped activity feed must never inherit project/global events from
# another dialog.  The unscoped feed intentionally remains the project view.
runtime.STORE.events_rows = [
    *[{"id": index, "kind": "session.tool.completed", "session_id": "s2", "project_dir": "/tmp/project", "data": {"name": "s2-tool"}} for index in range(1, 301)],
    {"id": 301, "kind": "runtime.status", "session_id": None, "project_dir": "/tmp/project", "data": {"name": "global-runtime"}},
    {"id": 302, "kind": "session.tool.completed", "session_id": "s1", "project_dir": "/tmp/project", "data": {"name": "s1-tool"}},
]
scoped_activity = unified._activity(runtime, directory="/tmp/project", session_id="s1", limit=20)
assert [event["sessionID"] for event in scoped_activity] == ["s1"]
assert runtime.STORE.event_calls[-1]["session_id"] == "s1"
global_activity = unified._activity(runtime, directory="/tmp/project", session_id=None, limit=500)
assert {event["sessionID"] for event in global_activity} == {"s1", "s2", None}

assert {profile["id"] for profile in unified.RESOURCE_PROFILES.values()} == {"normal", "gaming", "remote"}
assert all(action.get("id") for action in unified.ACTION_REGISTRY)
assert any(action["id"] == "model.add" and action.get("command") == "/addmodel" for action in unified.ACTION_REGISTRY)
assert any(action["id"] == "orchestration.add" and action.get("command") == "/addorchestration" for action in unified.ACTION_REGISTRY)

# The wizard, config-manager and unified-workspace behavioral suites must stay
# wired into the local gate; marker checks alone cannot catch their regressions.
verify_sh = (ROOT / "scripts/verify.sh").read_text(encoding="utf-8")
config_manager_regression_js = (ROOT / "scripts/config-manager-regression.mjs").read_text(encoding="utf-8")
wizard_validation_js = (ROOT / "scripts/wizard-validation-smoke.mjs").read_text(encoding="utf-8")
workflow_yml = (ROOT / ".github/workflows/unified-workspace.yml").read_text(encoding="utf-8")
for marker in (
    "OPENCODE_CONFIG_MANAGER_SELF_CHECK",
    "config/plugins/config-manager.js",
    "opencode-plugin-stub-hooks.mjs",
    "reloadFailures",
    "rollback failed",
    "failAfterRelease",
    "remove-managed",
):
    assert marker in config_manager_regression_js, marker
for marker in (
    "function validID(value)",
    "function openConfigWizard(",
    "isSensitiveName",
    "parseLocalCommand",
    "safeRemoteMcpURL",
):
    assert marker in wizard_validation_js, marker
for script in ("wizard-validation-smoke.mjs", "config-manager-regression.mjs", "unified-workspace-regression.py"):
    assert script in verify_sh, script
assert "'config/plugins/**'" in workflow_yml

print("Unified workspace regression passed: state/actions/events + durable retry + permission advice + Web/four-zone TUI contracts")
