#!/usr/bin/env python3
"""Persistent workflow features layered between server_plus and server_rag.

This layer owns server-backed prompt queues, per-project instructions and
permission policies, plus safe Git revert helpers. Local model lifecycle and
routing are deliberately not implemented here: manual local-model selection
remains entirely in the pre-existing OpenCode provider path.
"""
from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit
from uuid import uuid4

import server_plus as baseplus

# Re-export server_plus helpers used by the composed production entrypoint.
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
WORKER_STOP = threading.Event()
WORKER_THREAD: threading.Thread | None = None
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_QUEUE_ITEM_BYTES = 10 * 1024 * 1024
MAX_QUEUE_ITEMS_PER_SESSION = 50
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


def _safe_default_model(value: Any) -> str:
    model = str(value or "inherit")[:240] or "inherit"
    # Project automation must not select a local provider on the user's behalf.
    if model == "auto" or model.startswith("ollama/"):
        return "inherit"
    return model


def _sanitize_settings(raw: Any, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = dict(previous or {})
    if not isinstance(raw, dict):
        raw = {}
    result = dict(previous)
    # Discard any stale experimental local-routing settings from early branch builds.
    result.pop("autoRouting", None)
    if "instructions" in raw:
        result["instructions"] = str(raw.get("instructions") or "")[:INSTRUCTION_LIMIT]
    if "defaultMode" in raw:
        mode = str(raw.get("defaultMode") or "inherit")
        result["defaultMode"] = mode if mode in {"inherit", "build", "plan"} else "inherit"
    if "defaultModel" in raw:
        result["defaultModel"] = _safe_default_model(raw.get("defaultModel"))
    if "rag" in raw:
        rag = str(raw.get("rag") or "auto")
        result["rag"] = rag if rag in {"auto", "on", "off"} else "auto"
    if "permissionRules" in raw:
        rows = raw.get("permissionRules") if isinstance(raw.get("permissionRules"), list) else []
        result["permissionRules"] = [rule for item in rows if (rule := _sanitize_rule(item))][:RULE_LIMIT]
    result.setdefault("instructions", "")
    result.setdefault("defaultMode", "inherit")
    result["defaultModel"] = _safe_default_model(result.get("defaultModel"))
    result.setdefault("rag", "auto")
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
        update = dict(update or {})
        update.pop("autoRouting", None)
        if isinstance(update.get("addPermission"), dict):
            rule = _sanitize_rule(update.get("addPermission"))
            if rule:
                rules = list(previous.get("permissionRules") or [])
                if rule not in rules:
                    rules.append(rule)
                update["permissionRules"] = rules
        if "removePermissionIndex" in update:
            try:
                index = int(update["removePermissionIndex"])
            except (TypeError, ValueError):
                index = -1
            rules = list(previous.get("permissionRules") or [])
            if 0 <= index < len(rules):
                rules.pop(index)
            update["permissionRules"] = rules
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
                    "profile": row.get("profile") if row.get("profile") in {"direct", "orchestrated"} else "direct",
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
    profile = str(payload.get("profile") or "direct")
    if profile not in {"direct", "orchestrated"}:
        profile = "direct"
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
        count = len(rows)
    return {"ok": True, "item": {k: item[k] for k in ("id", "text", "profile", "createdAt")}, "count": count}


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
        requested = set(ids)
        ordered = [by_id[item_id] for item_id in ids if item_id in by_id]
        ordered.extend(row for row in rows if str((row or {}).get("id")) not in requested)
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


def _send_backend_prompt(session_id: str, text: str, files: list[Any]) -> Any:
    target = f"/api/session/{quote(session_id, safe='')}/prompt"
    attempts = (
        {"text": text, "files": files, "resume": True},
        {"prompt": {"text": text, "files": files}, "delivery": "immediate"},
        {"prompt": {"text": text, "files": files}, "delivery": "steer"},
        {"text": text, "files": files, "delivery": "steer"},
    )
    last: Exception | None = None
    for body in attempts:
        try:
            return _backend_request_json("POST", target, body, timeout=30.0)
        except BackendHTTPError as exc:
            last = exc
            if exc.status not in (400, 404, 405, 422):
                raise
    raise last or RuntimeError("prompt API unavailable")


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
        _session_directory(session_id)
        # The queued prompt uses the model currently selected for the session.
        # Queue dispatch never changes model/provider and never manages local runtime.
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
    return any(fnmatch.fnmatchcase(resource, pattern) for resource in resources)


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
    while not WORKER_STOP.is_set():
        try:
            state = _with_state_read()
            queues = state.get("queues", {}) if isinstance(state.get("queues"), dict) else {}
            status = _status_payload() if queues else {}
            for session_id in list(queues):
                _dispatch_one_queue_item(str(session_id), status)
            _apply_permission_policies()
        except Exception:
            pass
        WORKER_STOP.wait(1.5)


def _ensure_worker() -> None:
    global WORKER_STARTED, WORKER_THREAD
    if WORKER_STARTED:
        return
    with WORKER_LOCK:
        if WORKER_STARTED:
            return
        WORKER_STOP.clear()
        WORKER_THREAD = threading.Thread(target=_worker, name="custom-opencode-feature-worker", daemon=True)
        WORKER_THREAD.start()
        WORKER_STARTED = True


def _stop_worker(timeout: float = 30.0) -> bool:
    """Stop owned background work before closing/deleting its persistent storage."""
    global WORKER_STARTED
    with WORKER_LOCK:
        WORKER_STOP.set()
        thread = WORKER_THREAD
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=max(0.0, timeout))
    with WORKER_LOCK:
        stopped = thread is None or not thread.is_alive()
        if stopped:
            WORKER_STARTED = False
        return stopped


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
            result = _run_git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", relative])
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
    header_paths: list[str] = []
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
        if parsed.path in {"/client-queue.json", "/client-project-settings.json", "/client-features.json"}:
            if not self.authenticated():
                self.unauthorized()
                return
            params = parse_qs(parsed.query)
            try:
                if parsed.path == "/client-queue.json":
                    sid = (params.get("sessionID") or [None])[0]
                    self.json_response(queue_snapshot(sid))
                    return
                if parsed.path == "/client-project-settings.json":
                    try:
                        directory = _resolve_directory(params=params)
                    except ValueError as exc:
                        if str(exc) != "directory outside allowed project roots":
                            raise
                        self.json_response({"ok": True, "available": False, "reason": "project-outside-roots", "settings": {}})
                        return
                    self.json_response({"directory": directory, "settings": project_settings(directory)})
                    return
                state = _with_state_read()
                self.json_response({
                    "ok": True,
                    "queue": queue_snapshot(),
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
                self.unauthorized()
                return
            try:
                payload = self._feature_body()
                if parsed.path == "/client-queue.json":
                    self.json_response(enqueue_prompt(payload))
                    return
                if parsed.path == "/client-project-settings.json":
                    directory = _resolve_directory(payload=payload)
                    source = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
                    self.json_response(update_project_settings(directory, source if isinstance(source, dict) else {}))
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
                self.unauthorized()
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
                self.unauthorized()
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
