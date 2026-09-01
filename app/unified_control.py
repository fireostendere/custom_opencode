#!/usr/bin/env python3
"""Unified client control plane shared by Web/PWA and TUI projections.

The server owns state, actions and events. Clients render those contracts instead
of growing independent workflow logic. This module intentionally composes the
existing Runtime V2/V3 services rather than replacing them.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import parse_qs


RESOURCE_PROFILES: dict[str, dict[str, Any]] = {
    "normal": {
        "id": "normal",
        "title": "Normal",
        "description": "Use the explicitly selected model/profile without host-load switching.",
        "localInference": "manual",
        "remotePreferred": False,
    },
    "gaming": {
        "id": "gaming",
        "title": "Gaming",
        "description": "Visible policy hint: avoid local inference; prefer configured remote profiles when the user selects them.",
        "localInference": "avoid",
        "remotePreferred": True,
    },
    "remote": {
        "id": "remote",
        "title": "Remote",
        "description": "Remote-control friendly policy with conservative local-machine operations.",
        "localInference": "avoid",
        "remotePreferred": True,
    },
}

UI_CAPABILITIES = {
    "unifiedPanel": True,
    "actionRegistry": True,
    "activityTimeline": True,
    "verificationCenter": True,
    "projectControlCenter": True,
    "recoveryCenter": True,
    "permissionAdvisor": True,
    "globalSearch": True,
    "timeTravelFork": True,
    "resourceProfiles": True,
    "capabilityDrivenUI": True,
}

ACTION_REGISTRY: list[dict[str, Any]] = [
    {"id": "panel.activity", "title": "Activity", "group": "Panel", "surface": "client", "shortcut": "ctrl+alt+a"},
    {"id": "panel.plan", "title": "Plan", "group": "Panel", "surface": "client", "shortcut": "ctrl+alt+p"},
    {"id": "panel.changes", "title": "Changes", "group": "Panel", "surface": "client"},
    {"id": "panel.verification", "title": "Verification", "group": "Panel", "surface": "client"},
    {"id": "panel.runtime", "title": "Runtime", "group": "Panel", "surface": "client"},
    {"id": "panel.rag", "title": "RAG / MCP", "group": "Panel", "surface": "client"},
    {"id": "project.control", "title": "Project Control Center", "group": "Project", "surface": "client", "shortcut": "ctrl+alt+c"},
    {"id": "search.global", "title": "Global Search", "group": "Project", "surface": "client", "shortcut": "ctrl+shift+p"},
    {"id": "rag.start", "title": "Start / verify RAG", "group": "Runtime", "surface": "slash", "command": "/rag-start"},
    {"id": "model.add", "title": "Add model", "group": "Configuration", "surface": "slash", "command": "/addmodel"},
    {"id": "provider.add", "title": "Add provider", "group": "Configuration", "surface": "slash", "command": "/addprovider"},
    {"id": "mcp.add", "title": "Add MCP", "group": "Configuration", "surface": "slash", "command": "/addmcp"},
    {"id": "skill.add", "title": "Add skill", "group": "Configuration", "surface": "slash", "command": "/addskill"},
    {"id": "orchestration.add", "title": "Add orchestration", "group": "Configuration", "surface": "slash", "command": "/addorchestration"},
    {"id": "task.retry", "title": "Retry task", "group": "Task", "surface": "server", "parameters": ["taskID"]},
    {"id": "task.cancel", "title": "Cancel task", "group": "Task", "surface": "server", "parameters": ["taskID"]},
    {"id": "task.checkpoint", "title": "Create checkpoint", "group": "Task", "surface": "server", "parameters": ["taskID"]},
    {"id": "time.fork", "title": "Fork from checkpoint", "group": "History", "surface": "server", "parameters": ["taskID", "checkpointID"]},
    {"id": "resource.profile.normal", "title": "Resource profile: Normal", "group": "Runtime", "surface": "server"},
    {"id": "resource.profile.gaming", "title": "Resource profile: Gaming", "group": "Runtime", "surface": "server"},
    {"id": "resource.profile.remote", "title": "Resource profile: Remote", "group": "Runtime", "surface": "server"},
]


def _directory_key(directory: str) -> str:
    return hashlib.sha256(directory.encode("utf-8", errors="replace")).hexdigest()


def _resource_profile(runtime: Any, directory: str | None) -> dict[str, Any]:
    if not directory:
        return RESOURCE_PROFILES["normal"]
    cached = runtime.STORE.cache_get("resource-profile", _directory_key(directory))
    profile_id = str(cached.get("id") if isinstance(cached, dict) else cached or "normal")
    return RESOURCE_PROFILES.get(profile_id, RESOURCE_PROFILES["normal"])


def _set_resource_profile(runtime: Any, directory: str, profile_id: str) -> dict[str, Any]:
    if profile_id not in RESOURCE_PROFILES:
        raise ValueError("unknown resource profile")
    value = dict(RESOURCE_PROFILES[profile_id])
    runtime.STORE.cache_set("resource-profile", _directory_key(directory), value, ttl_seconds=365 * 24 * 3600)
    runtime.STORE.event(kind="resource.profile.changed", project_dir=directory, data={"profile": profile_id})
    return value


def _git_snapshot(directory: str | None) -> dict[str, Any]:
    if not directory:
        return {"available": False}
    root = Path(directory)
    try:
        top = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=4.0,
            check=False,
        )
        if top.returncode != 0:
            return {"available": False}
        canonical = top.stdout.strip()
        branch = subprocess.run(
            ["git", "-C", canonical, "branch", "--show-current"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=4.0,
            check=False,
        )
        status = subprocess.run(
            ["git", "-C", canonical, "status", "--porcelain=v1", "--branch"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5.0,
            check=False,
        )
        lines = status.stdout.splitlines() if status.returncode == 0 else []
        files = []
        for line in lines:
            if not line or line.startswith("## "):
                continue
            files.append({"status": line[:2], "path": line[3:]})
        return {
            "available": True,
            "root": canonical,
            "branch": branch.stdout.strip() if branch.returncode == 0 else "",
            "dirty": bool(files),
            "changed": len(files),
            "files": files[:200],
        }
    except (OSError, subprocess.SubprocessError):
        return {"available": False}


def _event_group(kind: str) -> str:
    prefix = kind.split(".", 1)[0]
    return {
        "task": "task",
        "verification": "verification",
        "review": "review",
        "worktree": "git",
        "permission": "permission",
        "handoff": "agent",
        "resource": "runtime",
        "runtime": "runtime",
        "mcp": "mcp",
        "rag": "rag",
    }.get(prefix, "system")


def _activity(runtime: Any, *, directory: str | None, session_id: str | None, after: int = 0, limit: int = 250) -> list[dict[str, Any]]:
    rows = runtime.STORE.events(
        project_dir=directory,
        after=max(0, int(after)),
        limit=max(1, min(1000, int(limit))),
    )
    if session_id:
        rows = [item for item in rows if not item.get("session_id") or str(item.get("session_id")) == session_id]
    out = []
    for row in rows:
        kind = str(row.get("kind") or "event")
        out.append({
            "id": row.get("id"),
            "taskID": row.get("task_id"),
            "sessionID": row.get("session_id"),
            "projectDir": row.get("project_dir"),
            "kind": kind,
            "group": _event_group(kind),
            "data": row.get("data") if isinstance(row.get("data"), dict) else {},
            "createdAt": row.get("created_at"),
        })
    return out


def _verification_summary(runtime: Any, *, directory: str | None, session_id: str | None) -> dict[str, Any]:
    tasks = runtime.STORE.list_tasks(session_id=session_id, project_dir=directory, limit=150)
    with_verification = [task for task in tasks if isinstance(task.get("verification"), dict) and task.get("verification")]
    latest = max(with_verification, key=lambda item: int(item.get("updated_at") or 0), default=None)
    if not latest:
        return {"state": "idle", "ok": None, "taskID": None, "results": [], "summary": "No verification result yet"}
    verification = latest.get("verification") or {}
    results = verification.get("results") if isinstance(verification.get("results"), list) else []
    return {
        "state": "passed" if verification.get("ok") else "failed",
        "ok": bool(verification.get("ok")),
        "taskID": latest.get("id"),
        "taskState": latest.get("state"),
        "results": results,
        "actionableFailures": verification.get("actionableFailures") or [],
        "environmentFailures": verification.get("environmentFailures") or [],
    }


def _recovery(runtime: Any, *, directory: str | None, session_id: str | None) -> dict[str, Any]:
    states = ["failed", "needs_attention", "paused", "recovering"]
    tasks = runtime.STORE.list_tasks(session_id=session_id, project_dir=directory, states=states, limit=100)
    items = []
    for task in tasks:
        actions = ["task.retry"]
        if task.get("state") not in {"failed", "completed", "cancelled"}:
            actions.append("task.cancel")
        checkpoints = runtime.STORE.checkpoints(str(task.get("id")))
        if checkpoints:
            actions.append("time.fork")
        items.append({
            "taskID": task.get("id"),
            "state": task.get("state"),
            "error": task.get("last_error"),
            "updatedAt": task.get("updated_at"),
            "checkpoint": checkpoints[0] if checkpoints else None,
            "actions": actions,
        })
    return {"count": len(items), "items": items}


def _permission_advice(runtime: Any, *, directory: str | None) -> dict[str, Any]:
    if not directory:
        return {"suggestions": []}
    rows = runtime.STORE.events(project_dir=directory, limit=1000)
    counts: Counter[tuple[str, str]] = Counter()
    examples: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        kind = str(row.get("kind") or "")
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        if "permission" not in kind:
            continue
        action = str(data.get("action") or data.get("permission") or "").strip()
        resource = str(data.get("resource") or data.get("path") or data.get("command") or "").strip()
        if not action:
            continue
        key = (action, resource)
        counts[key] += 1
        examples[key] = data
    suggestions = []
    for (action, resource), count in counts.most_common(12):
        if count < 3:
            continue
        suggestions.append({
            "action": action,
            "resource": resource or "*",
            "count": count,
            "proposedRule": {"action": action, "resource": resource or "*", "effect": "allow"},
            "requiresConfirmation": True,
            "note": "R3/R4 server risk floors remain authoritative and cannot be lowered by this suggestion.",
            "example": examples[(action, resource)],
        })
    return {"suggestions": suggestions}


def _project_snapshot(features: Any, runtime: Any, directory: str | None, session_id: str | None) -> dict[str, Any]:
    tasks = runtime.STORE.list_tasks(session_id=session_id, project_dir=directory, limit=300)
    counts = Counter(str(task.get("state") or "unknown") for task in tasks)
    active = [task for task in tasks if str(task.get("state")) in runtime.ACTIVE_STATES]
    queued = [task for task in tasks if str(task.get("state")) in runtime.QUEUE_STATES]
    mcp = None
    capabilities = None
    settings = None
    if directory:
        try:
            mcp = runtime.mcp_gateway(features, directory)
        except Exception as exc:
            mcp = {"error": f"{type(exc).__name__}: {exc}"}
        try:
            capabilities = runtime.capability_snapshot(features, directory)
        except Exception as exc:
            capabilities = {"error": f"{type(exc).__name__}: {exc}"}
        try:
            settings = features.project_settings(directory)
        except Exception:
            settings = None
    return {
        "directory": directory,
        "sessionID": session_id,
        "git": _git_snapshot(directory),
        "tasks": {"counts": dict(counts), "active": [runtime._public(item) for item in active[:20]], "queued": [runtime._public(item) for item in queued[:50]]},
        "verification": _verification_summary(runtime, directory=directory, session_id=session_id),
        "recovery": _recovery(runtime, directory=directory, session_id=session_id),
        "permissionAdvice": _permission_advice(runtime, directory=directory),
        "resourceProfile": _resource_profile(runtime, directory),
        "mcp": mcp,
        "modelCapabilities": capabilities,
        "projectSettings": settings,
    }


def _global_search(runtime: Any, *, directory: str, query: str, limit: int = 60) -> dict[str, Any]:
    needle = query.strip().lower()
    if not needle:
        return {"query": query, "results": []}
    results: list[dict[str, Any]] = []
    for task in runtime.STORE.list_tasks(project_dir=directory, limit=500):
        hay = " ".join([str(task.get("text") or ""), str(task.get("last_error") or ""), str(task.get("kind") or "")]).lower()
        if needle in hay:
            results.append({"type": "task", "id": task.get("id"), "title": str(task.get("text") or task.get("kind") or "Task")[:160], "state": task.get("state"), "updatedAt": task.get("updated_at")})
    for event in runtime.STORE.events(project_dir=directory, limit=1000):
        blob = json.dumps(event.get("data") or {}, ensure_ascii=False, default=str)
        if needle in str(event.get("kind") or "").lower() or needle in blob.lower():
            results.append({"type": "event", "id": event.get("id"), "title": str(event.get("kind") or "Event"), "taskID": event.get("task_id"), "createdAt": event.get("created_at"), "data": event.get("data")})
    try:
        repo = runtime.INDEXER.search(directory, query, limit=max(5, min(40, limit // 2)))
        rows = repo.get("results") if isinstance(repo, dict) and isinstance(repo.get("results"), list) else repo if isinstance(repo, list) else []
        for row in rows:
            if isinstance(row, dict):
                results.append({"type": "repo", **row})
    except Exception:
        pass
    results.sort(key=lambda item: int(item.get("updatedAt") or item.get("createdAt") or 0), reverse=True)
    return {"query": query, "results": results[: max(1, min(200, limit))]}


def snapshot(features: Any, runtime: Any, *, directory: str | None, session_id: str | None) -> dict[str, Any]:
    runtime_state = runtime.runtime_snapshot(features, directory)
    services = runtime_state.get("services") if isinstance(runtime_state, dict) else {}
    return {
        "ok": True,
        "version": 1,
        "contract": "state-actions-events",
        "capabilities": {**UI_CAPABILITIES, **({key: bool(value) for key, value in services.items()} if isinstance(services, dict) else {})},
        "actions": ACTION_REGISTRY,
        "resourceProfiles": list(RESOURCE_PROFILES.values()),
        "project": _project_snapshot(features, runtime, directory, session_id),
    }


def _resolve_scope(features: Any, params: dict[str, list[str]]) -> tuple[str | None, str | None]:
    session_id = str((params.get("sessionID") or [""])[0]) or None
    directory = None
    if session_id:
        directory = features._session_directory(session_id)
    elif (params.get("directory") or [""])[0]:
        directory = features._canonical_directory(str((params.get("directory") or [""])[0]))
    return directory, session_id


def _retry_task(features: Any, runtime: Any, task_id: str) -> dict[str, Any]:
    task = runtime.STORE.get_task(task_id)
    if not task:
        raise KeyError(task_id)
    if task.get("state") != "failed":
        return runtime.task_control(features, {"taskID": task_id, "action": "resume"})
    metadata = dict(task.get("metadata") or {}) if isinstance(task.get("metadata"), dict) else {}
    metadata.update({
        "retryOf": task_id,
        "usageBaseline": runtime._usage_totals(features, str(task.get("session_id") or "")),
    })
    retried = runtime.STORE.create_task(
        session_id=str(task.get("session_id") or ""),
        project_dir=str(task.get("project_dir") or ""),
        text=str(task.get("text") or ""),
        files=list(task.get("files") or []),
        profile=str(task.get("profile") or "direct"),
        priority=int(task.get("priority") or 0),
        dependencies=list(task.get("dependencies") or []),
        kind=str(task.get("kind") or "prompt"),
        metadata=metadata,
        baseline=runtime.git_snapshot(str(task.get("project_dir") or "")),
    )
    runtime.STORE.checkpoint(
        str(retried.get("id") or ""),
        "retry-created",
        summary=f"Retry created from failed task {task_id}",
        data={"retryOf": task_id},
    )
    runtime.STORE.event(
        kind="task.retry_created",
        task_id=str(retried.get("id") or "") or None,
        session_id=str(task.get("session_id") or "") or None,
        project_dir=str(task.get("project_dir") or "") or None,
        data={"retryOf": task_id},
    )
    return {"ok": True, "retryOf": task_id, "task": runtime._public(retried)}


def execute(features: Any, runtime: Any, payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or payload.get("id") or "")
    session_id = str(payload.get("sessionID") or "") or None
    directory = features._session_directory(session_id) if session_id else None
    if payload.get("directory") and not directory:
        directory = features._canonical_directory(str(payload.get("directory")))

    if action.startswith("resource.profile."):
        if not directory:
            raise ValueError("sessionID or directory is required")
        profile_id = action.rsplit(".", 1)[-1]
        return {"ok": True, "resourceProfile": _set_resource_profile(runtime, directory, profile_id)}

    task_id = str(payload.get("taskID") or payload.get("taskId") or "")
    if action == "task.retry":
        return _retry_task(features, runtime, task_id)
    if action == "task.cancel":
        return runtime.task_control(features, {"taskID": task_id, "action": "cancel"})
    if action == "task.checkpoint":
        return runtime.task_control(features, {"taskID": task_id, "action": "checkpoint", "stage": "manual", "summary": str(payload.get("summary") or "Manual checkpoint")})
    if action == "time.fork":
        task = runtime.STORE.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        checkpoint_id = str(payload.get("checkpointID") or "")
        checkpoints = runtime.STORE.checkpoints(task_id)
        checkpoint = next((item for item in checkpoints if str(item.get("id")) == checkpoint_id), checkpoints[0] if checkpoints else None)
        if not checkpoint:
            raise ValueError("task has no checkpoint")
        fork = runtime._fork(features, str(task.get("session_id")))
        runtime.STORE.event(kind="time.forked", task_id=task_id, session_id=str(fork.get("id") or ""), project_dir=str(task.get("project_dir") or ""), data={"checkpointID": checkpoint.get("id"), "sourceSessionID": task.get("session_id")})
        return {"ok": True, "session": fork, "checkpoint": checkpoint, "note": "Session forked without changing the source task or repository."}
    raise ValueError("unknown unified action")


def handle_get(handler: Any, parsed: Any, runtime: Any, features: Any) -> bool:
    paths = {
        "/client-unified.json",
        "/client-actions.json",
        "/client-activity.json",
        "/client-project-control.json",
        "/client-verification-center.json",
        "/client-recovery-center.json",
        "/client-permission-advice.json",
        "/client-global-search.json",
    }
    if parsed.path not in paths:
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        params = parse_qs(parsed.query)
        directory, session_id = _resolve_scope(features, params)
        if parsed.path == "/client-unified.json":
            handler.json_response(snapshot(features, runtime, directory=directory, session_id=session_id))
        elif parsed.path == "/client-actions.json":
            handler.json_response({"ok": True, "actions": ACTION_REGISTRY, "capabilities": UI_CAPABILITIES})
        elif parsed.path == "/client-activity.json":
            handler.json_response({"ok": True, "events": _activity(runtime, directory=directory, session_id=session_id, after=int((params.get("after") or [0])[0]), limit=int((params.get("limit") or [250])[0]))})
        elif parsed.path == "/client-project-control.json":
            handler.json_response({"ok": True, "project": _project_snapshot(features, runtime, directory, session_id)})
        elif parsed.path == "/client-verification-center.json":
            handler.json_response({"ok": True, "verification": _verification_summary(runtime, directory=directory, session_id=session_id)})
        elif parsed.path == "/client-recovery-center.json":
            handler.json_response({"ok": True, "recovery": _recovery(runtime, directory=directory, session_id=session_id)})
        elif parsed.path == "/client-permission-advice.json":
            handler.json_response({"ok": True, **_permission_advice(runtime, directory=directory)})
        elif parsed.path == "/client-global-search.json":
            if not directory:
                raise ValueError("sessionID or directory is required")
            handler.json_response({"ok": True, **_global_search(runtime, directory=directory, query=str((params.get("q") or [""])[0]), limit=int((params.get("limit") or [60])[0]))})
        return True
    except Exception as exc:
        handler.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=404 if isinstance(exc, KeyError) else 400 if isinstance(exc, (ValueError, PermissionError)) else 500)
        return True


def handle_post(handler: Any, parsed: Any, runtime: Any, features: Any) -> bool:
    if parsed.path != "/client-unified-action.json":
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        payload = handler._feature_body() if hasattr(handler, "_feature_body") else {}
        handler.json_response(execute(features, runtime, payload))
    except Exception as exc:
        handler.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=404 if isinstance(exc, KeyError) else 400 if isinstance(exc, (ValueError, PermissionError)) else 500)
    return True
