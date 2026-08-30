#!/usr/bin/env python3
"""RuntimeStore invariant layer used by the production workflow server.

RuntimeStore intentionally stays a small persistence primitive. This module adds
workflow-level invariants at composition time without making schema migrations
or changing standalone storage tooling:
- dependencies must reference existing tasks;
- dependency updates cannot introduce cycles;
- task states follow the runtime's explicit lifecycle rather than accepting an
  arbitrary valid-state jump.
"""
from __future__ import annotations

from typing import Any, Iterable


ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"blocked", "paused", "submitted", "cancelled", "failed"},
    "blocked": {"queued", "paused", "submitted", "cancelled", "failed"},
    "paused": {"queued", "blocked", "cancelled", "failed", "recovering"},
    "submitted": {"running", "waiting_permission", "paused", "verifying", "failed", "cancelled", "recovering"},
    "running": {"submitted", "waiting_permission", "paused", "verifying", "failed", "cancelled", "recovering"},
    "waiting_permission": {"running", "submitted", "paused", "failed", "cancelled", "recovering"},
    "verifying": {"running", "needs_attention", "completed", "failed", "cancelled", "recovering"},
    "needs_attention": {"queued", "paused", "cancelled", "failed", "recovering"},
    "recovering": {"queued", "paused", "submitted", "running", "waiting_permission", "verifying", "needs_attention", "completed", "failed", "cancelled"},
    "failed": {"recovering", "queued"},
    "completed": set(),
    "cancelled": set(),
}


def _unique_dependencies(values: Iterable[object] | None, task_id: str | None = None) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in values or ():
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        if task_id and value == task_id:
            raise ValueError("task cannot depend on itself")
        seen.add(value)
        result.append(value)
    return result


def _validate_existing(store: Any, dependencies: list[str]) -> None:
    missing = [dependency for dependency in dependencies if store.get_task(dependency) is None]
    if missing:
        raise ValueError("unknown task dependencies: " + ", ".join(missing[:20]))


def _depends_on(store: Any, start: str, target: str, seen: set[str] | None = None) -> bool:
    if start == target:
        return True
    visited = seen if seen is not None else set()
    if start in visited:
        return False
    visited.add(start)
    for dependency in store.dependencies(start):
        if dependency == target or _depends_on(store, dependency, target, visited):
            return True
    return False


def _validate_cycle(store: Any, task_id: str, dependencies: list[str]) -> None:
    for dependency in dependencies:
        if _depends_on(store, dependency, task_id):
            raise ValueError(f"dependency cycle: {task_id} -> {dependency} -> ... -> {task_id}")


def install(store: Any) -> None:
    """Install invariant guards once on a RuntimeStore instance."""
    if getattr(store, "_workflow_invariants_installed", False):
        return

    original_create = store.create_task
    original_update = store.update_task
    original_transition = store.transition

    def create_task(*, dependencies=(), task_id=None, **kwargs):
        deps = _unique_dependencies(dependencies, str(task_id) if task_id else None)
        _validate_existing(store, deps)
        return original_create(dependencies=deps, task_id=task_id, **kwargs)

    def update_task(task_id: str, *, dependencies=None, **kwargs):
        if dependencies is None:
            return original_update(task_id, dependencies=None, **kwargs)
        deps = _unique_dependencies(dependencies, task_id)
        _validate_existing(store, deps)
        _validate_cycle(store, task_id, deps)
        return original_update(task_id, dependencies=deps, **kwargs)

    def transition(task_id: str, state: str, **kwargs):
        task = store.get_task(task_id)
        if task is None:
            raise KeyError(task_id)
        current = str(task.get("state") or "")
        target = str(state)
        if current != target and target not in ALLOWED_TRANSITIONS.get(current, set()):
            raise ValueError(f"invalid task transition: {current} -> {target}")
        return original_transition(task_id, target, **kwargs)

    store.create_task = create_task
    store.update_task = update_task
    store.transition = transition
    store._workflow_invariants_installed = True
