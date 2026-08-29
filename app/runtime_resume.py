#!/usr/bin/env python3
"""Checkpoint-aware continuation policy for resumed Runtime V2 tasks."""
from __future__ import annotations

from typing import Any

_SKIP_STAGES = {"created", "queued", "dispatched"}


def continuation_payload(store: Any, session_id: str, text: str, files: list[Any]) -> tuple[str, list[Any], dict[str, Any] | None]:
    """Return a continuation prompt only after a task has already been dispatched once.

    `_dispatch_task` saves a `dispatched` checkpoint immediately before the model
    call. A normal first dispatch therefore has exactly one such checkpoint. A
    paused/recovered task that is queued again gets a second one. At that point
    replaying the original request would repeat already completed work, so we
    continue in the existing OpenCode session from the last meaningful durable
    checkpoint instead.
    """
    candidates = store.list_tasks(session_id=session_id, states=["submitted"], limit=20)
    if not candidates:
        return text, files, None
    task = candidates[0]
    checkpoints = store.checkpoints(task["id"], limit=50)
    dispatched = [item for item in checkpoints if item.get("stage") == "dispatched"]
    if len(dispatched) <= 1:
        return text, files, None

    meaningful = next((item for item in checkpoints if item.get("stage") not in _SKIP_STAGES), None)
    checkpoint_stage = str((meaningful or {}).get("stage") or "previous-progress")[:120]
    checkpoint_summary = str((meaningful or {}).get("summary") or "Use the current session and repository state.")[:4000]
    original = str(task.get("text") or text).strip()[:8000]
    prompt = (
        "Continue the existing task from its last durable checkpoint. Do not repeat work that is already present "
        "in the current OpenCode session or repository. Treat current tool/session state and the working tree as "
        "authoritative; re-check only what is necessary.\n\n"
        f"Original request:\n{original}\n\n"
        f"Last durable checkpoint [{checkpoint_stage}]:\n{checkpoint_summary}"
    )
    return prompt, [], {
        "taskID": task["id"],
        "checkpointStage": checkpoint_stage,
        "checkpointID": (meaningful or {}).get("id"),
        "dispatchCount": len(dispatched),
        "attachmentsReplayed": False,
    }
