#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(Path(temp) / "runtime.sqlite3")
    from runtime_resume import continuation_payload
    from runtime_store import RuntimeStore

    store = RuntimeStore(os.environ["CUSTOM_OPENCODE_RUNTIME_DB"])
    task = store.create_task(
        session_id="ses_resume",
        project_dir=temp,
        text="Implement the requested change once.",
        files=[{"name": "input.txt", "uri": "data:text/plain;base64,WA=="}],
    )

    # First dispatch must remain byte-for-byte equivalent to the original user work.
    store.transition(task["id"], "submitted")
    store.checkpoint(task["id"], "dispatched", summary="first dispatch")
    text, files, resume = continuation_payload(store, "ses_resume", task["text"], task["files"])
    assert text == task["text"]
    assert files == task["files"]
    assert resume is None

    # A paused/recovered task gets another dispatch checkpoint. Its second model
    # call must be a continuation, not a replay of the original prompt/files.
    store.transition(task["id"], "paused")
    paused = store.checkpoint(task["id"], "paused", summary="analysis complete; implementation remains")
    store.transition(task["id"], "queued")
    store.transition(task["id"], "submitted")
    store.checkpoint(task["id"], "dispatched", summary="resume dispatch")
    text, files, resume = continuation_payload(store, "ses_resume", task["text"], task["files"])
    assert text != task["text"]
    assert "Continue the existing task" in text
    assert "analysis complete; implementation remains" in text
    assert "Implement the requested change once." in text
    assert files == []
    assert resume and resume["taskID"] == task["id"]
    assert resume["checkpointID"] == paused["id"]
    assert resume["checkpointStage"] == "paused"
    assert resume["dispatchCount"] == 2
    assert resume["attachmentsReplayed"] is False

print("Runtime resume smoke passed: first dispatch unchanged; resumed task continues from durable checkpoint")
