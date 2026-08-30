#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from runtime_invariants import install
from runtime_store import RuntimeStore

with tempfile.TemporaryDirectory() as temp:
    store = RuntimeStore(Path(temp) / "runtime.sqlite3")
    install(store)

    root = store.create_task(session_id="ses", project_dir=temp, text="root")

    try:
        store.create_task(
            session_id="ses",
            project_dir=temp,
            text="missing",
            dependencies=["t_missing"],
        )
    except ValueError as exc:
        assert "unknown task dependencies" in str(exc)
    else:
        raise AssertionError("missing dependency was accepted")

    child = store.create_task(
        session_id="ses",
        project_dir=temp,
        text="child",
        dependencies=[root["id"]],
    )
    assert child["state"] == "blocked"

    try:
        store.update_task(root["id"], dependencies=[child["id"]])
    except ValueError as exc:
        assert "dependency cycle" in str(exc)
    else:
        raise AssertionError("dependency cycle was accepted")

    # Concurrent dependency updates must not race past cycle validation.
    left = store.create_task(session_id="race", project_dir=temp, text="left")
    right = store.create_task(session_id="race", project_dir=temp, text="right")
    barrier = threading.Barrier(3)
    results: list[str] = []
    result_lock = threading.Lock()

    def link(task_id: str, dependency_id: str) -> None:
        barrier.wait()
        try:
            store.update_task(task_id, dependencies=[dependency_id])
            outcome = "ok"
        except ValueError as exc:
            assert "dependency cycle" in str(exc)
            outcome = "cycle"
        with result_lock:
            results.append(outcome)

    first = threading.Thread(target=link, args=(left["id"], right["id"]))
    second = threading.Thread(target=link, args=(right["id"], left["id"]))
    first.start(); second.start(); barrier.wait(); first.join(); second.join()
    assert sorted(results) == ["cycle", "ok"], results

    # Normal runtime lifecycle is still accepted.
    store.transition(root["id"], "submitted")
    store.transition(root["id"], "running")
    store.transition(root["id"], "waiting_permission")
    store.transition(root["id"], "running")
    store.transition(root["id"], "verifying")
    store.transition(root["id"], "completed")

    try:
        store.transition(root["id"], "running")
    except ValueError as exc:
        assert "completed -> running" in str(exc)
    else:
        raise AssertionError("terminal task was resurrected by arbitrary transition")

    # Completing the dependency unblocks the child through the native path.
    ready = store.next_ready(session_id="ses")
    assert ready and ready["id"] == child["id"]
    assert ready["state"] == "queued"

print("Runtime invariant smoke passed: missing deps + cycles + concurrency + explicit state machine")
