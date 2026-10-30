#!/usr/bin/env python3
"""Offline owner-cookie / root-task sandbox regression; no host commands."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TEMP = tempfile.TemporaryDirectory(prefix="owner-access-")
os.environ.update({
    "HOME": TEMP.name, "XDG_STATE_HOME": TEMP.name,
    "OPENCODE_SERVER_USERNAME": "owner", "OPENCODE_SERVER_PASSWORD": "fixture-password",
    "OPENCODE_BACKEND_URL": "http://127.0.0.1:9", "OPENCODE_BACKEND_PASSWORD": "fixture",
    "OPENCODE_USERS_FILE": TEMP.name + "/users.json",
    "CUSTOM_OPENCODE_RUNTIME_DB": TEMP.name + "/runtime.sqlite3",
    "CUSTOM_OPENCODE_FEATURE_STATE": TEMP.name + "/features.json",
    "OPENCODE_SCRATCH_DIRECTORY": TEMP.name + "/scratch",
    "OPENCODE_PROJECT_ROOTS": TEMP.name, "MCP_RAG_ENABLED": "0",
    "OPENCODE_REPO_EMBEDDINGS": "hash", "OPENCODE_RESOURCE_SCHEDULER": "off",
})
sys.path.insert(0, str(ROOT / "app"))
import server_workflow as web
import server_users

runtime = web.runtime
base = web.rag.plus.ext.base
server_users.add_user("other", "fixture-password")


class OwnerAccess(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, OPENCODE_OWNER_SANDBOX="full-machine", OPENCODE_ALLOW_FULL_MACHINE="1")
        self.env.start()
        self.addCleanup(self.env.stop)
        self.session = {"agent": "build", "model": {"providerID": "test", "id": "model"}}
        self.features = SimpleNamespace(
            _session_directory=lambda sid: TEMP.name,
            _session_info=lambda sid: self.session,
        )
        profiles = {p: {"sandbox": "safe" if p in {"review", "research"} else "repo-write"}
                    for p in runtime.PROFILE_IDS}
        profiles["dnd-edition"]["dndMinimalContext"] = True
        profiles["dnd-edition"]["cloudModel"] = "test/dnd"
        ctx = patch.object(web, "features", self.features)
        ctx.start()
        self.addCleanup(ctx.stop)
        for target, value in [("REGISTRY", SimpleNamespace(profiles=lambda: profiles, refresh=lambda _: None)),
                              ("_catalog", lambda *a: []), ("git_snapshot", lambda *a: {}),
                              ("_usage_totals", lambda *a: {}), ("_dispatch_task", lambda *a: {})]:
            ctx = patch.object(runtime, target, value)
            ctx.start()
            self.addCleanup(ctx.stop)

    def handler(self, token=None):
        h = web.Handler.__new__(web.Handler)
        h.headers = {}
        h.command = "POST"
        h.path = "/client-send.json"
        h.proxy = lambda: setattr(h, "result", {"error": "unexpected backend proxy"})
        h.client_address = ("127.0.0.1", 1)
        h.cookie_token = lambda: token
        h.internal_route_denied = lambda parsed: False
        h.json_response = lambda result, **kw: setattr(h, "result", result)
        h._feature_error = lambda exc: setattr(h, "result", {"error": str(exc)})
        h.unauthorized = lambda: setattr(h, "result", {"error": "unauthorized"})
        return h

    def submit(self, route, token, *, basic=False, local=False, **extra):
        h = self.handler(token)
        if basic:
            h.headers["Authorization"] = "Basic b3duZXI6Zml4dHVyZS1wYXNzd29yZA=="
        if local:
            h.local_bypass = lambda: True
        h.path = route
        payload = {"sessionID": "root", "text": "code", "sandboxOverride": "full-machine",
                   "username": "owner", "isOwner": True, **extra}
        h._feature_body = lambda *a: payload
        h.do_POST()
        return h.result

    def sandbox(self, result):
        self.assertNotIn("error", result)
        return result["task"]["sandbox"]

    def test_owner_all_root_submission_routes_require_both_flags(self):
        token = base.issue_session_token(300, "owner")
        for route in ("/client-send.json", "/client-queue.json", "/client-task-create.json"):
            for setting, gate, expected in (("full-machine", "1", "full-machine"),
                                            ("repo-write", "1", "repo-write"),
                                            ("full-machine", "0", "repo-write")):
                with self.subTest(route=route, setting=setting, gate=gate), patch.dict(
                    os.environ, OPENCODE_OWNER_SANDBOX=setting, OPENCODE_ALLOW_FULL_MACHINE=gate
                ):
                    self.assertEqual(self.sandbox(self.submit(route, token)), expected)

    def test_nonowner_and_cookie_substitutes_never_elevate(self):
        revoked = base.issue_session_token(300, "owner")
        web._revoke_token(revoked)
        for token in (None, "forged", base.issue_session_token(-10, "owner"), revoked,
                      base.issue_session_token(300, "other")):
            for route in ("/client-send.json", "/client-queue.json", "/client-task-create.json"):
                h = self.handler(token)
                h.headers["Authorization"] = "Basic b3duZXI6Zml4dHVyZS1wYXNzd29yZA=="
                self.assertIsNone(h.owner_sandbox())
                result = self.submit(route, token)
                if "error" not in result:
                    self.assertNotEqual(self.sandbox(result), "full-machine")
        for route in ("/client-send.json", "/client-queue.json", "/client-task-create.json"):
            with patch.object(base, "ALLOW_BASIC_AUTH", True):
                self.assertEqual(self.sandbox(self.submit(route, None, basic=True)), "repo-write")
            self.assertEqual(self.sandbox(self.submit(route, None, local=True)), "repo-write")

    def test_children_gameplay_roles_and_internal_calls_stay_restricted(self):
        token = base.issue_session_token(300, "owner")
        for route in ("/client-send.json", "/client-queue.json", "/client-task-create.json"):
            for profile in ("dnd-edition", "review", "research", "sol-review"):
                self.assertNotEqual(self.sandbox(self.submit(route, token, profile=profile)), "full-machine")
            self.session["parentID"] = "parent"
            self.assertNotEqual(self.sandbox(self.submit(route, token)), "full-machine")
            self.session.pop("parentID")
        self.session["model"]["id"] = "dnd"
        self.assertNotEqual(self.sandbox(self.submit("/client-send.json", token)), "full-machine")
        for create in (runtime.enqueue_prompt, runtime.create_task_request):
            self.assertNotEqual(self.sandbox(create(self.features, {
                "sessionID": "root", "text": "internal", "sandboxOverride": "full-machine"
            })), "full-machine")
        self.session["model"]["id"] = "model"
        for kind in ("review", "research", "verification-fix", "aggregate"):
            result = self.submit("/client-queue.json", token, kind=kind)
            self.assertNotEqual(self.sandbox(result), "full-machine")
        runtime.STORE.cache_set("native-context-binding", "root", {"parentID": "parent"}, ttl_seconds=300)
        try:
            self.assertNotEqual(self.sandbox(self.submit("/client-send.json", token)), "full-machine")
        finally:
            runtime.STORE.cache_set("native-context-binding", "root", {}, ttl_seconds=300)

    def test_host_profile_api_requires_owner_and_root_coding_task(self):
        task = runtime.STORE.create_task(session_id="root", project_dir=TEMP.name, profile="build")
        for sandbox in ("full-machine", "wsl"):
            for user, gate, parent, allowed in (("other", "1", None, False), ("owner", "1", None, True),
                                               ("owner", "0", None, False), ("owner", "1", "parent", False)):
                h = self.handler(base.issue_session_token(300, user))
                h.path = "/client-task-sandbox.json"
                h._feature_body = lambda: {"taskID": task["id"], "sandbox": sandbox}
                self.session["parentID"] = parent
                with patch.dict(os.environ, OPENCODE_ALLOW_FULL_MACHINE=gate):
                    h.do_POST()
                self.assertEqual("error" not in h.result, allowed)

    def test_enforcement_gate_survives_metadata_tampering(self):
        sandbox = web.runtime_v3.SandboxManager()
        with patch.dict(os.environ, OPENCODE_ALLOW_FULL_MACHINE="0"):
            self.assertFalse(sandbox.path_allowed("/outside", TEMP.name, "full-machine", write=True))
            with self.assertRaises(PermissionError):
                sandbox.wrap_shell("pwd", TEMP.name, "full-machine")

    def test_planning_sessions_and_explicit_plan_tasks_stay_restricted(self):
        token = base.issue_session_token(300, "owner")
        for planning in ({"agent": "plan"}, {"agent": "plan-direct"},
                         {"agent": "planning"}, {"mode": "plan"}):
            original = dict(self.session)
            self.session.update(planning)
            for route in ("/client-send.json", "/client-queue.json", "/client-task-create.json"):
                with self.subTest(planning=planning, route=route):
                    self.assertNotEqual(self.sandbox(self.submit(route, token)), "full-machine")
            self.session = original
        result = self.submit("/client-task-create.json", token, mode="plan")
        self.assertNotEqual(self.sandbox(result), "full-machine")

    def test_manual_host_profile_rejects_persisted_plan_mode(self):
        task = runtime.STORE.create_task(session_id="root", project_dir=TEMP.name,
                                        profile="build", metadata={"modeAtCreate": "plan"})
        for sandbox in ("full-machine", "wsl"):
            h = self.handler(base.issue_session_token(300, "owner"))
            h.path = "/client-task-sandbox.json"
            h._feature_body = lambda: {"taskID": task["id"], "sandbox": sandbox}
            h.do_POST()
            self.assertIn("error", h.result)

    def test_dispatch_downgrades_new_plan_or_child_scope(self):
        token = base.issue_session_token(300, "owner")
        backend_calls = []
        self.features._backend_request_json = lambda *a, **kw: backend_calls.append(a)
        runtime.REGISTRY.profiles()["direct"].update(agentBuild="build", agentPlan="plan")
        decision = SimpleNamespace(selected_model="test/other", as_dict=lambda: {})
        for change in ({"agent": "plan"}, {"agent": "plan-direct"}, {"mode": "plan"},
                       {"parentID": "parent"}):
            created = self.submit("/client-queue.json", token)
            self.assertEqual(self.sandbox(created), "full-machine")
            task = runtime.STORE.get_task(created["task"]["id"])
            original = dict(self.session)
            self.session.update(change)
            backend_calls.clear()
            with patch.object(runtime.SCHEDULER, "decide", return_value=decision):
                runtime._switch_session(self.features, task)
            self.assertEqual(runtime.STORE.get_task(task["id"])["metadata"]["sandbox"], "repo-write")
            if "parentID" not in change:
                self.assertFalse(any(call[1].endswith("/model") for call in backend_calls))
                self.assertFalse(any("permission" in call[1] for call in backend_calls))
                self.assertFalse(any(call[1].endswith("/agent") and call[2]["agent"] == "build"
                                     for call in backend_calls))
            self.session = original

    def test_internal_native_registration_does_not_create_host_task(self):
        before = runtime.STORE.list_tasks(limit=1000)
        for sid, parent in (("native-root", None), ("native-child", "native-root")):
            h = self.handler()
            h.path = "/internal/runtime/bind"
            h.headers["X-OpenCode-Runtime"] = "fixture-password"
            h._feature_body = lambda *a: {"sessionID": sid, "parentID": parent,
                "directory": TEMP.name, "turnID": "turn", "sandboxOverride": "full-machine",
                "sandbox": "full-machine", "isOwner": True}
            h.do_POST()
            self.assertNotIn("error", h.result)
        self.assertEqual(runtime.STORE.list_tasks(limit=1000), before)

    def test_isolated_root_creation_and_queued_switch_to_gameplay(self):
        self.features._canonical_directory = lambda directory: TEMP.name
        self.features._backend_request_json = lambda *a, **kw: {"id": "isolated-root"}
        self.features._data = lambda data: data
        with patch.object(runtime, "_create_worktree", return_value=TEMP.name), patch.object(
            runtime, "_git_toplevel", return_value=TEMP.name
        ):
            result = self.submit("/client-task-create.json", base.issue_session_token(300, "owner"),
                                 sessionID="", directory=TEMP.name, isolate=True)
            self.assertEqual(self.sandbox(result), "full-machine")
            result = self.submit("/client-task-create.json", base.issue_session_token(300, "owner"),
                                 sessionID="", directory=TEMP.name, isolate=True, mode="plan")
            self.assertEqual(self.sandbox(result), "repo-write")
        created = self.submit("/client-queue.json", base.issue_session_token(300, "owner"))
        task = runtime.STORE.get_task(created["task"]["id"])
        self.session["model"]["id"] = "dnd"
        runtime._switch_session(self.features, task)
        self.assertEqual(runtime.STORE.get_task(task["id"])["metadata"]["sandbox"], "repo-write")


if __name__ == "__main__":
    unittest.main(verbosity=2)
