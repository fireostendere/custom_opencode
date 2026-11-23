#!/usr/bin/env python3
"""Final control-plane completion layer for Runtime V3.

Keeps small cross-cutting policies out of the core runtime modules: semantic
permission previews, wasted-retry accounting, and compact
remote approve/cancel APIs.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
from typing import Any
from urllib.parse import parse_qs

from runtime_store import now_ms

_INSTALLED = False
_ORIGINAL_DECISION = None
_ORIGINAL_USAGE_STAGE = None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _resource_strings(request: dict[str, Any]) -> list[str]:
    raw = request.get("resources", request.get("resource", request.get("patterns")))
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        out = []
        for item in raw:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                for key in ("path", "command", "resource", "pattern", "value"):
                    value = item.get(key)
                    if isinstance(value, str) and value:
                        out.append(value)
                        break
        return out
    if isinstance(raw, dict):
        for key in ("path", "command", "resource", "pattern", "value"):
            value = raw.get(key)
            if isinstance(value, str) and value:
                return [value]
    return []


def _compact_path(path: str, workspace: str) -> str:
    try:
        root = Path(workspace).resolve(strict=False)
        target = Path(path).expanduser()
        target = (
            target.resolve(strict=False)
            if target.is_absolute()
            else (root / target).resolve(strict=False)
        )
        if _inside(target, root):
            rel = target.relative_to(root).as_posix()
            return rel or "."
    except Exception:
        pass
    return str(path)[:100]


def _common_location(paths: list[str], workspace: str) -> str:
    if not paths:
        return "проекте"
    root = Path(workspace).resolve(strict=False)
    compact = [_compact_path(item, workspace) for item in paths]
    parents = []
    for original, item in zip(paths, compact):
        p = Path(item)
        is_dir = original.endswith(("/", "\\"))
        try:
            raw = Path(original).expanduser()
            target = (
                raw.resolve(strict=False)
                if raw.is_absolute()
                else (root / raw).resolve(strict=False)
            )
            is_dir = is_dir or (_inside(target, root) and target.is_dir())
        except (OSError, RuntimeError, ValueError):
            pass
        parents.append(p if is_dir else p.parent)
    try:
        common = os.path.commonpath([str(p) for p in parents])
    except ValueError:
        common = ""
    return "проекте" if common in {"", "."} else f"{common.rstrip('/')}/"


def _count_delete_targets(argv: list[str], workspace: str) -> tuple[int, list[str]]:
    root = Path(workspace).resolve(strict=False)
    targets = []
    count = 0
    for arg in argv[1:]:
        if not arg or arg.startswith("-"):
            continue
        candidate = Path(arg).expanduser()
        candidate = (
            candidate.resolve(strict=False)
            if candidate.is_absolute()
            else (root / candidate).resolve(strict=False)
        )
        if not _inside(candidate, root):
            continue
        targets.append(arg)
        if candidate.is_dir():
            local = 0
            try:
                for base, dirs, files in os.walk(candidate, followlinks=False):
                    dirs[:] = [d for d in dirs if _inside(Path(base) / d, root)]
                    local += len(files)
                    if local >= 10000:
                        break
            except OSError:
                local = 1
            count += max(1, local)
        else:
            count += 1
    return count, targets


def permission_preview(request: dict[str, Any], workspace: str) -> str:
    action = (
        str(request.get("action") or request.get("permission") or request.get("type") or "")
        .strip()
        .lower()
    )
    resources = _resource_strings(request)
    metadata = request.get("metadata") if isinstance(request.get("metadata"), dict) else {}
    if action in {"edit", "write", "patch", "apply_patch"}:
        n = max(1, len(resources))
        noun = "файл" if n == 1 else "файла" if 2 <= n <= 4 else "файлов"
        return f"Изменить {n} {noun} в {_common_location(resources,workspace)}"
    if action in {"read", "glob", "grep", "list", "lsp"}:
        if resources:
            n = len(resources)
            noun = "ресурс" if n == 1 else "ресурса" if 2 <= n <= 4 else "ресурсов"
            return f"Прочитать {n} {noun} в {_common_location(resources,workspace)}"
        return "Прочитать данные проекта"
    if action in {"shell", "bash"}:
        command = str(
            metadata.get("command") or metadata.get("cmd") or (resources[0] if resources else "")
        ).strip()
        try:
            argv = shlex.split(command, posix=True)
        except ValueError:
            argv = []
        if argv and Path(argv[0]).name == "rm":
            count, targets = _count_delete_targets(argv, workspace)
            if targets:
                noun = "объект" if count == 1 else "объекта" if 2 <= count <= 4 else "объектов"
                return f"Удалить {count} {noun} в {_common_location(targets,workspace)}"
        if argv and Path(argv[0]).name == "git" and len(argv) > 1:
            return f"Git: {argv[1]}" + (f" · {' '.join(argv[2:])[:90]}" if len(argv) > 2 else "")
        return "Выполнить команду: " + (
            " ".join(command.split())[:130] if command else "неизвестная команда"
        )
    if action in {"webfetch", "fetch", "http"}:
        return "Получить данные из сети"
    if action == "external_directory":
        return "Дать доступ за пределы проекта"
    if action in {"subagent", "task"}:
        return "Запустить дополнительного агента"
    if action == "kb_knowledge_ingest":
        return "Добавить новые данные в базу знаний"
    return f"Разрешить действие: {action or 'unknown'}"


def _wrap_permission_decision(control: Any) -> None:
    global _ORIGINAL_DECISION
    if _ORIGINAL_DECISION is not None:
        return
    _ORIGINAL_DECISION = control.decision_for

    def decision_for(request: dict[str, Any], directory: str) -> dict[str, Any]:
        value = _ORIGINAL_DECISION(request, directory)
        value["preview"] = permission_preview(request, directory)
        return value

    control.decision_for = decision_for


def _wrap_usage_stage(runtime: Any) -> None:
    global _ORIGINAL_USAGE_STAGE
    if _ORIGINAL_USAGE_STAGE is not None:
        return
    _ORIGINAL_USAGE_STAGE = runtime._usage_stage

    def usage_stage(task: dict[str, Any]) -> str:
        metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
        kind = str(task.get("kind") or "")
        if metadata.get("avoidableWasteReason"):
            return "wasted_retries"
        if kind == "verification-fix" or metadata.get("repairOf"):
            return "verification_fix"
        if kind in {"retry", "recovery"}:
            return kind
        return _ORIGINAL_USAGE_STAGE(task)

    runtime._usage_stage = usage_stage


def install(runtime: Any, v3mod: Any, control: Any, features: Any) -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _wrap_permission_decision(control)
    _wrap_usage_stage(runtime)
    runtime.STORE.event(
        kind="runtime.completion_installed",
        data={
            "features": [
                "semantic-permission-preview",
                "wasted-retry-accounting",
                "remote-actions",
            ]
        },
    )
    _INSTALLED = True


def _json_body(handler: Any, limit: int = 2_000_000) -> dict[str, Any]:
    if hasattr(handler, "_feature_body"):
        return handler._feature_body(limit)
    length = int(handler.headers.get("Content-Length", "0"))
    if length < 0 or length > limit:
        raise ValueError("request too large")
    value = json.loads(handler.rfile.read(length).decode()) if length else {}
    if not isinstance(value, dict):
        raise ValueError("JSON object required")
    return value


def handle_get(handler: Any, parsed: Any, runtime: Any, control: Any, features: Any) -> bool:
    if parsed.path != "/client-remote-status.json":
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        params = parse_qs(parsed.query)
        sid = str((params.get("sessionID") or [""])[0])
        tasks = (
            runtime.STORE.list_tasks(session_id=sid, limit=100, projection="public")
            if sid
            else runtime.STORE.list_tasks(limit=100, projection="public")
        )
        permissions = []
        if sid:
            directory = features._session_directory(sid)
            for request in features._permission_requests(directory):
                if str(request.get("sessionID") or "") != sid:
                    continue
                pid = str(request.get("requestID") or request.get("id") or "")
                if not pid:
                    continue
                decision = control.decision_for(request, directory)
                permissions.append(
                    {
                        "permissionID": pid,
                        "sessionID": sid,
                        "risk": decision.get("risk"),
                        "preview": decision.get("preview"),
                        "actions": ["once", "reject"],
                    }
                )
        handler.json_response(
            {
                "ok": True,
                "tasks": [runtime._public(task) for task in tasks],
                "permissions": permissions,
                "actions": {
                    "endpoint": "/client-remote-action.json",
                    "task": ["cancel", "pause", "resume"],
                    "permission": ["once", "reject"],
                },
            }
        )
    except Exception as exc:
        handler._feature_error(exc)
    return True


def handle_post(handler: Any, parsed: Any, runtime: Any, control: Any, features: Any) -> bool:
    if parsed.path != "/client-remote-action.json":
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        payload = _json_body(handler)
        kind = str(payload.get("kind") or "task")
        action = str(payload.get("action") or "")
        if kind == "task":
            if action not in {"cancel", "pause", "resume"}:
                raise ValueError("invalid task action")
            result = runtime.task_control(
                features, {"taskID": str(payload.get("taskID") or ""), "action": action}
            )
        elif kind == "permission":
            if action not in {"once", "reject"}:
                raise ValueError("invalid permission action")
            sid = str(payload.get("sessionID") or "")
            pid = str(payload.get("permissionID") or "")
            directory = features._session_directory(sid)
            pending = None
            for request in features._permission_requests(directory):
                if (
                    str(request.get("sessionID") or "") == sid
                    and str(request.get("requestID") or request.get("id") or "") == pid
                ):
                    pending = request
                    break
            if pending is None:
                raise KeyError(pid)
            features._permission_reply(pending, action)
            runtime.STORE.event(
                kind="remote.permission_reply",
                session_id=sid,
                project_dir=directory,
                data={"permissionID": pid, "reply": action, "at": now_ms()},
            )
            result = {"ok": True, "permissionID": pid, "reply": action}
        else:
            raise ValueError("invalid remote action kind")
        handler.json_response(result)
    except Exception as exc:
        handler._feature_error(exc)
    return True
