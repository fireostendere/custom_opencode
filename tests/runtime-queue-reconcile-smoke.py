#!/usr/bin/env python3
"""Regression for a short backend busy->idle edge missed by the Runtime V2 poller."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(root / "runtime.sqlite3")

    from runtime_store import RuntimeStore, now_ms
    import server_runtime

    store = RuntimeStore(root / "runtime.sqlite3")
    store.initialize()
    project = root / "project"
    project.mkdir()
    session_id = "ses_missed_busy_edge"

    first = store.create_task(
        task_id="t_first",
        session_id=session_id,
        project_dir=str(project),
        text="first prompt",
        profile="direct",
        metadata={"usageBaseline": {"signature": ""}},
    )
    claimed = store.claim_dispatch(first["id"])
    assert claimed and claimed["state"] == "submitted"

    old = now_ms() - 4000
    with store.transaction() as db:
        db.execute("UPDATE tasks SET started_at=? WHERE id=?", (old, first["id"]))
    store.update_task(first["id"], metadata_patch={"dispatchAcceptedAt": old, "usageBaseline": {"signature": ""}})

    second = store.create_task(
        task_id="t_second",
        session_id=session_id,
        project_dir=str(project),
        text="queued prompt",
        profile="direct",
    )
    assert second["state"] == "queued"

    class FakeFeatures:
        @staticmethod
        def _status_busy(value):
            if isinstance(value, dict):
                value = value.get("type") or value.get("status") or value.get("state")
            return str(value or "").lower() in {"running", "busy", "working", "pending", "retry"}

        @staticmethod
        def _permission_requests(directory):
            return []

        @staticmethod
        def _data(value):
            return value.get("data") if isinstance(value, dict) and "data" in value else value

        @staticmethod
        def _backend_request_json(method, target, payload=None, timeout=20.0):
            if method == "GET" and "/message" in target:
                return []
            raise AssertionError((method, target, payload))

    features = FakeFeatures()
    original_store = server_runtime.STORE
    original_finish = server_runtime._finish_async
    original_dispatch = server_runtime._dispatch_task
    dispatched: list[str] = []

    try:
        server_runtime.STORE = store

        def finish_now(_features, task):
            store.transition(task["id"], "completed", event="test.completed", data={})

        def dispatch_now(_features, task):
            claimed_task = store.claim_dispatch(task["id"])
            assert claimed_task is not None
            dispatched.append(claimed_task["id"])
            return {"ok": True}

        server_runtime._finish_async = finish_now
        server_runtime._dispatch_task = dispatch_now

        # The backend is already idle. The worker never observed its short busy edge.
        server_runtime._monitor_active(features, {session_id: {"type": "idle"}})
        first_after = store.get_task(first["id"])
        assert first_after and first_after["state"] == "completed", first_after
        idle_events = [event for event in store.events(task_id=first["id"]) if event["kind"] == "task.agent_idle"]
        assert idle_events, "stale submitted task was not reconciled"
        assert idle_events[-1]["data"].get("reconciledForQueue") is True

        server_runtime._dispatch_ready(features, {session_id: {"type": "idle"}})
        assert dispatched == [second["id"]], dispatched
        second_after = store.get_task(second["id"])
        assert second_after and second_after["state"] == "submitted", second_after
    finally:
        server_runtime.STORE = original_store
        server_runtime._finish_async = original_finish
        server_runtime._dispatch_task = original_dispatch

print("Runtime queue reconciliation smoke passed: missed busy edge cannot strand the next queued prompt")
