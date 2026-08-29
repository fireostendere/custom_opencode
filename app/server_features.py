#!/usr/bin/env python3
"""Persistent workflow features layered between server_plus and server_rag.

This module deliberately keeps user-facing workflow state outside OpenCode's
runtime database. It adds server-backed prompt queues, per-project preferences,
auto local/cloud routing, project permission policies, and safe git revert
helpers while delegating every unknown route to server_plus.
"""
from __future__ import annotations

import fnmatch
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

import server_plus as baseplus

# Re-export the server_plus surface used by server_rag.py.
ext = baseplus.ext
REPO_ROOT = baseplus.REPO_ROOT
BackendHTTPError = baseplus.BackendHTTPError
_data = baseplus._data
_backend_request_json = baseplus._backend_request_json
_workspace_target = baseplus._workspace_target
_read_runtime_config = baseplus._read_runtime_config
_rag_runtime = baseplus._rag_runtime
_run_rag_probe = baseplus._run_rag_probe

STATE_LOCK = threading.RLock()
WORKER_LOCK = threading.Lock()
WORKER_STARTED = False
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_QUEUE_ITEM_BYTES = 10 * 1024 * 1024
MAX_QUEUE_ITEMS_PER_SESSION = 50
DEFAULT_LOCAL_MODEL = "ollama/qwen3.8:27b"
DEFAULT_CLOUD_MODEL = "bailian-cli/qwen3.8-flash"
INSTRUCTION_LIMIT = 12_000
RULE_LIMIT = 100


def _state_path() -> Path:
    configured = ext.base.setting("CUSTOM_OPENCODE_FEATURE_STATE")
    if configured:
        return Path(configured).expanduser()
    root = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
    return root / "custom-opencode" / "web-features.json"


def _empty_state() -> dict[str, Any]:
    return {"version": 1, "queues": {}, "projects": {}, "queueErrors": {}}


def _load_state_unlocked() -> dict[str, Any]:
    path = _state_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_state()
    if not isinstance(value, dict):
        return _empty_state()
    value.setdefault("version", 1)
    value.setdefault("queues", {})
    value.setdefault("projects", {})
    value.setdefault("queueErrors", {})
    return value


def _save_state_unlocked(state: dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp_name = tempfile.mkstemp(prefix=".web-features-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass


def _with_state_read() -> dict[str, Any]:
    with STATE_LOCK:
        return _load_state_unlocked()


def _canonical_directory(raw: str | None, *, allow_scratch: bool = True) -> str:
    if not raw:
        raise ValueError("directory is required")
    try:
        path = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError("directory not found") from exc
    if not path.is_dir():
        raise ValueError("directory is not a directory")
    roots = baseplus._project_roots()
    allowed = baseplus._allowed(path, roots)
    if allow_scratch:
        try:
            scratch = ext.base.SCRATCH_ROOT.expanduser().resolve(strict=False)
            allowed = allowed or baseplus._inside(path, scratch)
        except Exception:
            pass
    if not allowed:
        raise ValueError("directory outside allowed project roots")
    return str(path)


def _session_info(session_id: str) -> dict[str, Any]:
    value = _data(_backend_request_json("GET", f"/api/session/{quote(session_id, safe='')}", timeout=12.0))
    if not isinstance(value, dict):
        raise ValueError("session not found")
    return value


def _session_directory(session_id: str) -> str:
    session = _session_info(session_id)
    directory = ((session.get("location") or {}).get("directory"))
    if not isinstance(directory, str) or not directory:
        raise ValueError("session has no directory")
    return _canonical_directory(directory)


def _resolve_directory(payload: dict[str, Any] | None = None, params: dict[str, list[str]] | None = None) -> str:
    payload = payload or {}
    params = params or {}
    session_id = payload.get("sessionID") or ((params.get("sessionID") or [None])[0])
    if isinstance(session_id, str) and session_id:
        return _session_directory(session_id)
    raw = payload.get("directory") or ((params.get("directory") or [None])[0])
    return _canonical_directory(raw if isinstance(raw, str) else None)


def _sanitize_rule(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    effect = str(value.get("effect") or "ask").lower()
    if effect not in {"allow", "deny", "ask"}:
        return None
    action = str(value.get("action") or "*").strip()[:120] or "*"
    resource = str(value.get("resource") or "*").strip()[:1200] or "*"
    return {"action": action, "resource": resource, "effect": effect}


def _sanitize_settings(raw: Any, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = dict(previous or {})
    if not isinstance(raw, dict):
        return previous
    result = dict(previous)
    if "instructions" in raw:
        result["instructions"] = str(raw.get("instructions") or "")[:INSTRUCTION_LIMIT]
    if "defaultMode" in raw:
        mode = str(raw.get("defaultMode") or "inherit")
        result["defaultMode"] = mode if mode in {"inherit", "build", "plan"} else "inherit"
    if "defaultModel" in raw:
        model = str(raw.get("defaultModel") or "inherit")[:240]
        result["defaultModel"] = model or "inherit"
    if "rag" in raw:
        rag = str(raw.get("rag") or "auto")
        result["rag"] = rag if rag in {"auto", "on", "off"} else "auto"
    if "autoRouting" in raw and isinstance(raw.get("autoRouting"), dict):
        current = dict(result.get("autoRouting") or {})
        source = raw["autoRouting"]
        if "localModel" in source:
            current["localModel"] = str(source.get("localModel") or DEFAULT_LOCAL_MODEL)[:240]
        if "cloudModel" in source:
            current["cloudModel"] = str(source.get("cloudModel") or DEFAULT_CLOUD_MODEL)[:240]
        if "gpuBusyPercent" in source:
            try:
                current["gpuBusyPercent"] = max(1, min(100, int(source["gpuBusyPercent"])))
            except (TypeError, ValueError):
                current["gpuBusyPercent"] = 35
        result["autoRouting"] = current
    if "permissionRules" in raw:
        rows = raw.get("permissionRules") if isinstance(raw.get("permissionRules"), list) else []
        result["permissionRules"] = [rule for item in rows if (rule := _sanitize_rule(item))][:RULE_LIMIT]
    result.setdefault("instructions", "")
    result.setdefault("defaultMode", "inherit")
    result.setdefault("defaultModel", "inherit")
    result.setdefault("rag", "auto")
    result.setdefault("autoRouting", {
        "localModel": DEFAULT_LOCAL_MODEL,
        "cloudModel": DEFAULT_CLOUD_MODEL,
        "gpuBusyPercent": 35,
    })
    result.setdefault("permissionRules", [])
    return result


def project_settings(directory: str) -> dict[str, Any]:
    canonical = _canonical_directory(directory)
    with STATE_LOCK:
        state = _load_state_unlocked()
        raw = state.get("projects", {}).get(canonical)
        return _sanitize_settings(raw)


def update_project_settings(directory: str, update: dict[str, Any]) -> dict[str, Any]:
    canonical = _canonical_directory(directory)
    with STATE_LOCK:
        state = _load_state_unlocked()
        projects = state.setdefault("projects", {})
        previous = _sanitize_settings(projects.get(canonical))
        if isinstance(update.get("addPermission"), dict):
            rule = _sanitize_rule(update.get("addPermission"))
            if rule:
                rules = list(previous.get("permissionRules") or [])
                if rule not in rules:
                    rules.append(rule)
                update = {**update, "permissionRules": rules}
        if "removePermissionIndex" in update:
            try:
                index = int(update["removePermissionIndex"])
            except (TypeError, ValueError):
                index = -1
            rules = list(previous.get("permissionRules") or [])
            if 0 <= index < len(rules):
                rules.pop(index)
            update = {**update, "permissionRules": rules}
        current = _sanitize_settings(update, previous)
        projects[canonical] = current
        _save_state_unlocked(state)
    return {"directory": canonical, "settings": current}


def _queue_rows(state: dict[str, Any], session_id: str) -> list[dict[str, Any]]:
    queues = state.setdefault("queues", {})
    rows = queues.setdefault(session_id, [])
    if not isinstance(rows, list):
        rows = []
        queues[session_id] = rows
    return rows


def queue_snapshot(session_id: str | None = None) -> dict[str, Any]:
    with STATE_LOCK:
        state = _load_state_unlocked()
        queues = state.get("queues", {}) if isinstance(state.get("queues"), dict) else {}
        errors = state.get("queueErrors", {}) if isinstance(state.get("queueErrors"), dict) else {}
        if session_id:
            rows = queues.get(session_id) if isinstance(queues.get(session_id), list) else []
            public = [
                {
                    "id": row.get("id"),
                    "text": str(row.get("text") or "")[:500],
                    "files": [str((item or {}).get("name") or "file") for item in (row.get("files") or []) if isinstance(item, dict)],
                    "profile": row.get("profile") or "direct",
                    "createdAt": row.get("createdAt"),
                }
                for row in rows if isinstance(row, dict)
            ]
            return {"sessionID": session_id, "count": len(public), "items": public, "error": errors.get(session_id)}
        counts = {sid: len(rows) for sid, rows in queues.items() if isinstance(rows, list) and rows}
        return {"counts": counts, "total": sum(counts.values()), "errors": errors}


def enqueue_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionID") or "")
    if not session_id or len(session_id) > 256:
        raise ValueError("invalid session id")
    _session_directory(session_id)
    text = str(payload.get("text") or "")
    files = payload.get("files") if isinstance(payload.get("files"), list) else []
    profile = str(payload.get("profile") or "direct")[:40]
    if not text.strip() and not files:
        raise ValueError("empty queue item")
    item = {
        "id": f"q_{uuid4().hex}",
        "text": text,
        "files": files,
        "profile": profile,
        "createdAt": int(time.time() * 1000),
    }
    encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_QUEUE_ITEM_BYTES:
        raise ValueError("queue item too large")
    with STATE_LOCK:
        state = _load_state_unlocked()
        rows = _queue_rows(state, session_id)
        if len(rows) >= MAX_QUEUE_ITEMS_PER_SESSION:
            raise ValueError("queue is full")
        rows.append(item)
        state.setdefault("queueErrors", {}).pop(session_id, None)
        _save_state_unlocked(state)
    return {"ok": True, "item": {k: item[k] for k in ("id", "text", "profile", "createdAt")}, "count": len(rows)}


def delete_queue_item(session_id: str, item_id: str) -> dict[str, Any]:
    with STATE_LOCK:
        state = _load_state_unlocked()
        rows = _queue_rows(state, session_id)
        before = len(rows)
        rows[:] = [row for row in rows if str((row or {}).get("id")) != item_id]
        if not rows:
            state.get("queues", {}).pop(session_id, None)
        _save_state_unlocked(state)
        return {"ok": len(rows) != before, "count": len(rows)}


def reorder_queue(session_id: str, ids: list[str]) -> dict[str, Any]:
    with STATE_LOCK:
        state = _load_state_unlocked()
        rows = _queue_rows(state, session_id)
        by_id = {str((row or {}).get("id")): row for row in rows if isinstance(row, dict)}
        ordered = [by_id[item_id] for item_id in ids if item_id in by_id]
        ordered.extend(row for row in rows if str((row or {}).get("id")) not in set(ids))
        state.setdefault("queues", {})[session_id] = ordered
        _save_state_unlocked(state)
        return {"ok": True, "count": len(ordered)}


def _status_payload() -> dict[str, Any]:
    for path in ("/api/session/active", "/api/session/status"):
        try:
            value = _data(_backend_request_json("GET", path, timeout=8.0))
            if isinstance(value, dict):
                return value
        except Exception:
            pass
    return {}


def _status_busy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        raw = value
    elif isinstance(value, dict):
        raw = value.get("type") or value.get("status") or value.get("state") or ""
    else:
        raw = str(value)
    return bool(re.search(r"running|busy|retry|working|pending", str(raw), re.I))


def _split_model(value: str, fallback: str) -> dict[str, str]:
    raw = value if "/" in value else fallback
    provider, model = raw.split("/", 1)
    return {"providerID": provider, "id": model}


def _switch_session_model(session_id: str, model: dict[str, str]) -> None:
    _backend_request_json(
        "POST", f"/api/session/{quote(session_id, safe='')}/model", {"model": model}, timeout=12.0,
    )


def _send_backend_prompt(session_id: str, text: str, files: list[Any]) -> Any:
    target = f"/api/session/{quote(session_id, safe='')}/prompt"
    attempts = (
        {"prompt": {"text": text, "files": files}, "delivery": "immediate"},
        {"prompt": {"text": text, "files": files}, "delivery": "steer"},
        {"text": text, "files": files, "delivery": "steer"},
    )
    last: Exception | None = None
    for payload in attempts:
        try:
            return _backend_request_json("POST", target, payload, timeout=30.0)
        except BackendHTTPError as exc:
            last = exc
            if exc.status not in (400, 404, 405, 422):
                raise
    raise last or RuntimeError("prompt API unavailable")


def _process_names() -> set[str]:
    names: set[str] = set()
    proc = Path("/proc")
    if not proc.is_dir():
        return names
    for child in proc.iterdir():
        if not child.name.isdigit():
            continue
        try:
            name = (child / "comm").read_text(encoding="utf-8", errors="ignore").strip().lower()
            if name:
                names.add(name)
        except OSError:
            continue
    return names


def _game_processes() -> list[str]:
    raw = ext.base.setting("OPENCODE_AUTO_GAME_PROCESSES", "dota2;cs2;wine64-preloader;wine;proton") or ""
    return [item.strip().lower() for item in raw.split(";") if item.strip()]


def _game_running() -> tuple[bool, str | None]:
    names = _process_names()
    for needle in _game_processes():
        for name in names:
            if needle == name or needle in name:
                return True, name
    return False, None


def _gpu_load() -> tuple[int | None, str | None]:
    probes = [
        (["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], "nvidia-smi"),
        (["rocm-smi", "--showuse", "--json"], "rocm-smi"),
        (["amd-smi", "metric", "-g", "all"], "amd-smi"),
    ]
    for command, source in probes:
        try:
            proc = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2.0, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode != 0:
            continue
        values = [int(value) for value in re.findall(r"(?<!\d)(\d{1,3})(?:\.\d+)?\s*%", proc.stdout)]
        if not values and source == "nvidia-smi":
            values = [int(value) for value in re.findall(r"(?<!\d)(\d{1,3})(?!\d)", proc.stdout)]
        values = [value for value in values if 0 <= value <= 100]
        if values:
            return max(values), source
    return None, None


def _ollama_root() -> str:
    raw = ext.base.setting("OLLAMA_BASE_URL", "http://localhost:11434/v1") or "http://localhost:11434/v1"
    return raw[:-3] if raw.rstrip("/").endswith("/v1") else raw.rstrip("/")


def _ollama_available() -> bool:
    try:
        request = Request(_ollama_root() + "/api/tags", headers={"Accept": "application/json"})
        with urlopen(request, timeout=1.2) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def _unload_ollama(model: str) -> bool:
    model_id = model.split("/", 1)[1] if "/" in model else model
    try:
        data = json.dumps({"model": model_id, "keep_alive": 0}).encode("utf-8")
        request = Request(
            _ollama_root() + "/api/generate",
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=2.5) as response:
            response.read(64)
            return 200 <= response.status < 300
    except Exception:
        return False


def resource_snapshot(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    settings = _sanitize_settings(settings)
    auto = settings.get("autoRouting") or {}
    threshold = int(auto.get("gpuBusyPercent") or 35)
    game, process = _game_running()
    gpu, gpu_source = _gpu_load()
    local_available = _ollama_available()
    busy = game or (gpu is not None and gpu >= threshold)
    reason = f"game:{process}" if game else (f"gpu:{gpu}%" if busy and gpu is not None else ("idle" if not busy else "busy"))
    return {
        "busy": busy,
        "reason": reason,
        "gameProcess": process,
        "gpuPercent": gpu,
        "gpuSource": gpu_source,
        "gpuBusyPercent": threshold,
        "localAvailable": local_available,
    }


def auto_route(session_id: str, directory: str | None = None, *, apply: bool = False) -> dict[str, Any]:
    directory = directory or _session_directory(session_id)
    settings = project_settings(directory)
    auto = settings.get("autoRouting") or {}
    local_name = str(auto.get("localModel") or DEFAULT_LOCAL_MODEL)
    cloud_name = str(auto.get("cloudModel") or DEFAULT_CLOUD_MODEL)
    resources = resource_snapshot(settings)
    use_local = bool(resources.get("localAvailable") and not resources.get("busy"))
    chosen_name = local_name if use_local else cloud_name
    if resources.get("busy"):
        resources["localUnloadRequested"] = _unload_ollama(local_name)
    model = _split_model(chosen_name, DEFAULT_CLOUD_MODEL)
    if apply:
        _switch_session_model(session_id, model)
    return {
        "sessionID": session_id,
        "directory": directory,
        "model": model,
        "modelRef": chosen_name,
        "route": "local" if use_local else "cloud",
        "resources": resources,
        "applied": bool(apply),
    }


def _dispatch_one_queue_item(session_id: str, status: dict[str, Any]) -> None:
    if _status_busy(status.get(session_id)):
        return
    with STATE_LOCK:
        state = _load_state_unlocked()
        rows = _queue_rows(state, session_id)
        if not rows:
            return
        item = dict(rows[0])
    try:
        directory = _session_directory(session_id)
        if item.get("profile") == "auto":
            auto_route(session_id, directory, apply=True)
        _send_backend_prompt(session_id, str(item.get("text") or ""), list(item.get("files") or []))
    except Exception as exc:
        with STATE_LOCK:
            state = _load_state_unlocked()
            state.setdefault("queueErrors", {})[session_id] = f"{type(exc).__name__}: {exc}"[:1000]
            _save_state_unlocked(state)
        return
    with STATE_LOCK:
        state = _load_state_unlocked()
        rows = _queue_rows(state, session_id)
        if rows and str((rows[0] or {}).get("id")) == str(item.get("id")):
            rows.pop(0)
        else:
            rows[:] = [row for row in rows if str((row or {}).get("id")) != str(item.get("id"))]
        if not rows:
            state.setdefault("queues", {}).pop(session_id, None)
        state.setdefault("queueErrors", {}).pop(session_id, None)
        _save_state_unlocked(state)


def _permission_requests(directory: str) -> list[dict[str, Any]]:
    targets = (
        _workspace_target("/api/permission/request", directory),
        _workspace_target("/api/permission", directory),
    )
    for target in targets:
        try:
            value = _data(_backend_request_json("GET", target, timeout=8.0))
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
        except Exception:
            continue
    return []


def _permission_reply(request: dict[str, Any], reply: str) -> None:
    sid = str(request.get("sessionID") or "")
    pid = str(request.get("requestID") or request.get("id") or "")
    if not sid or not pid:
        return
    sid_q, pid_q = quote(sid, safe=""), quote(pid, safe="")
    try:
        _backend_request_json("POST", f"/api/session/{sid_q}/permission/{pid_q}/reply", {"reply": reply}, timeout=10.0)
        return
    except BackendHTTPError as exc:
        if exc.status not in (400, 404, 405, 422):
            raise
    _backend_request_json(
        "POST",
        f"/api/session/{sid_q}/permissions/{pid_q}",
        {"response": "reject" if reply == "reject" else "once", "remember": False},
        timeout=10.0,
    )


def _permission_action(request: dict[str, Any]) -> str:
    return str(request.get("action") or request.get("permission") or "")


def _permission_resources(request: dict[str, Any]) -> list[str]:
    rows = request.get("resources") or request.get("patterns") or request.get("always") or []
    if isinstance(rows, str):
        return [rows]
    if isinstance(rows, list):
        return [str(row) for row in rows if row is not None]
    return []


def _rule_matches(rule: dict[str, str], request: dict[str, Any]) -> bool:
    action = _permission_action(request)
    if not fnmatch.fnmatchcase(action, rule.get("action") or "*"):
        return False
    resources = _permission_resources(request) or ["*"]
    pattern = rule.get("resource") or "*"
    return any(fnmatch.fnmatchcase(resource, pattern) or fnmatch.fnmatchcase(pattern, resource) for resource in resources)


def _apply_permission_policies() -> None:
    with STATE_LOCK:
        state = _load_state_unlocked()
        projects = dict(state.get("projects") or {})
    for directory, raw in projects.items():
        settings = _sanitize_settings(raw)
        rules = settings.get("permissionRules") or []
        active_rules = [rule for rule in rules if rule.get("effect") in {"allow", "deny"}]
        if not active_rules:
            continue
        try:
            requests = _permission_requests(directory)
        except Exception:
            continue
        for request in requests:
            for rule in active_rules:
                if not _rule_matches(rule, request):
                    continue
                try:
                    _permission_reply(request, "once" if rule["effect"] == "allow" else "reject")
                except Exception:
                    pass
                break


def _worker() -> None:
    while True:
        try:
            state = _with_state_read()
            queues = state.get("queues", {}) if isinstance(state.get("queues"), dict) else {}
            status = _status_payload() if queues else {}
            for session_id in list(queues):
                _dispatch_one_queue_item(str(session_id), status)
            _apply_permission_policies()
        except Exception:
            pass
        time.sleep(1.5)


def _ensure_worker() -> None:
    global WORKER_STARTED
    if WORKER_STARTED:
        return
    with WORKER_LOCK:
        if WORKER_STARTED:
            return
        thread = threading.Thread(target=_worker, name="custom-opencode-feature-worker", daemon=True)
        thread.start()
        WORKER_STARTED = True


def _git_path(directory: str, relative: str) -> tuple[Path, Path]:
    root = Path(_canonical_directory(directory)).resolve(strict=True)
    if not relative or relative.startswith(("/", "\\")):
        raise ValueError("invalid file path")
    target = (root / relative).resolve(strict=False)
    if not baseplus._inside(target, root):
        raise ValueError("file outside project")
    return root, target


def _run_git(root: Path, args: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=12.0,
        check=False,
    )


def git_revert(payload: dict[str, Any]) -> dict[str, Any]:
    directory = str(payload.get("directory") or "")
    relative = str(payload.get("path") or "")
    mode = str(payload.get("mode") or "file")
    root, target = _git_path(directory, relative)
    if mode == "file":
        tracked = _run_git(root, ["ls-files", "--error-unmatch", "--", relative])
        if tracked.returncode == 0:
            result = _run_git(root, ["restore", "--worktree", "--", relative])
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or "git restore failed")
            return {"ok": True, "mode": "file", "path": relative, "action": "restored"}
        if target.is_file() or target.is_symlink():
            target.unlink()
            return {"ok": True, "mode": "file", "path": relative, "action": "removed-untracked"}
        raise ValueError("untracked path is not a file")
    if mode != "hunk":
        raise ValueError("unknown revert mode")
    patch = str(payload.get("patch") or "")
    if not patch or len(patch.encode("utf-8")) > 512_000:
        raise ValueError("invalid patch")
    header_paths = []
    for line in patch.splitlines():
        if line.startswith("--- ") or line.startswith("+++ "):
            value = line[4:].split("\t", 1)[0].strip()
            if value == "/dev/null":
                continue
            if value.startswith(("a/", "b/")):
                value = value[2:]
            header_paths.append(value)
    if header_paths and any(value != relative for value in header_paths):
        raise ValueError("patch touches another file")
    result = _run_git(root, ["apply", "-R", "--recount", "--unidiff-zero", "-"], patch)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git apply -R failed")
    return {"ok": True, "mode": "hunk", "path": relative}


class Handler(baseplus.Handler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _ensure_worker()
        super().__init__(*args, **kwargs)

    def _feature_body(self, limit: int = MAX_REQUEST_BYTES) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length < 0 or length > limit:
            raise ValueError("request body too large")
        if not length:
            return {}
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value

    def _feature_error(self, exc: Exception) -> None:
        status = 400 if isinstance(exc, ValueError) else 500
        self.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=status)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path in {"/client-queue.json", "/client-project-settings.json", "/client-auto-route.json", "/client-features.json"}:
            if not self.authenticated():
                return
            params = parse_qs(parsed.query)
            try:
                if parsed.path == "/client-queue.json":
                    sid = (params.get("sessionID") or [None])[0]
                    self.json_response(queue_snapshot(sid))
                    return
                if parsed.path == "/client-project-settings.json":
                    directory = _resolve_directory(params=params)
                    self.json_response({"directory": directory, "settings": project_settings(directory)})
                    return
                if parsed.path == "/client-auto-route.json":
                    sid = (params.get("sessionID") or [None])[0]
                    if not isinstance(sid, str) or not sid:
                        raise ValueError("sessionID is required")
                    apply = ((params.get("apply") or ["0"])[0]) in {"1", "true", "yes"}
                    self.json_response(auto_route(sid, apply=apply))
                    return
                state = _with_state_read()
                self.json_response({
                    "ok": True,
                    "queue": queue_snapshot(),
                    "resource": resource_snapshot(),
                    "projects": len(state.get("projects") or {}),
                    "statePath": str(_state_path()),
                    "worker": WORKER_STARTED,
                })
                return
            except Exception as exc:
                self._feature_error(exc)
                return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path in {"/client-queue.json", "/client-project-settings.json", "/client-git-revert.json"}:
            if not self.authenticated():
                return
            try:
                payload = self._feature_body()
                if parsed.path == "/client-queue.json":
                    self.json_response(enqueue_prompt(payload))
                    return
                if parsed.path == "/client-project-settings.json":
                    directory = _resolve_directory(payload=payload)
                    self.json_response(update_project_settings(directory, payload.get("settings") if isinstance(payload.get("settings"), dict) else payload))
                    return
                self.json_response(git_revert(payload))
                return
            except Exception as exc:
                self._feature_error(exc)
                return
        super().do_POST()

    def do_PATCH(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-queue.json":
            if not self.authenticated():
                return
            try:
                payload = self._feature_body(256_000)
                sid = str(payload.get("sessionID") or "")
                ids = [str(value) for value in (payload.get("ids") or []) if value]
                if not sid:
                    raise ValueError("sessionID is required")
                self.json_response(reorder_queue(sid, ids))
            except Exception as exc:
                self._feature_error(exc)
            return
        super().do_PATCH()

    def do_DELETE(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-queue.json":
            if not self.authenticated():
                return
            params = parse_qs(parsed.query)
            sid = (params.get("sessionID") or [""])[0]
            item_id = (params.get("id") or [""])[0]
            if not sid or not item_id:
                self.json_response({"ok": False, "error": "sessionID and id are required"}, status=400)
                return
            self.json_response(delete_queue_item(sid, item_id))
            return
        super().do_DELETE()
