#!/usr/bin/env python3
"""D&D table watcher status for the web status bar.

The dnd-watch server plugin (config/plugins/dnd-watch.js) writes one JSON
status file per location into <state>/dnd-watch/. GET /client-dnd-watch.json
returns the snapshot of exactly one session (the freshest file wins), minus
the narrator's tool context; the files hold statuses, cursors and a short
journal, never game text. GET /client-dnd-watch-describe.js serves the pure
view model shared with the TUI sidebar panel, so both surfaces show the same
headline, rows and hints without a build step.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
from typing import Any
from urllib.parse import parse_qs

import server as base

SESSION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
# A real status file is a few KB (at most 256 sessions with 8 log lines each).
MAX_FILE_BYTES = 1 << 20
MAX_FILES = 256
# Only display fields reach the browser; the stored tool context stays local.
SNAPSHOT_FIELDS = ("agent", "campaignId", "cursor", "autoWatch", "watch", "link", "turn", "awake", "log")
DESCRIBE_MODULE = base.ROOT.parent / "config" / "plugins" / "tui" / "lib" / "dnd-watch-describe.js"

_lock = threading.Lock()
_files: dict[str, tuple[tuple[int, int], dict[str, Any] | None]] = {}
_module: tuple[tuple[int, int], bytes, str] | None = None


def state_directory() -> Path:
    root = base.setting("CUSTOM_OPENCODE_STATE_DIR") or str(Path.home() / ".local" / "state" / "custom-opencode")
    return Path(root).expanduser() / "dnd-watch"


def _parse(path: Path, details: os.stat_result) -> dict[str, Any] | None:
    if not stat.S_ISREG(details.st_mode) or details.st_size > MAX_FILE_BYTES:
        return None
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return None
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("sessions"), dict):
        return None
    updated = value.get("updatedAt")
    if isinstance(updated, bool) or not isinstance(updated, (int, float)):
        return None
    return value


def _documents(directory: Path) -> list[dict[str, Any]]:
    """Parsed status files; a file is re-read only when its mtime/size change."""
    try:
        names = sorted(name for name in os.listdir(directory) if name.endswith(".json"))[:MAX_FILES]
    except OSError:
        with _lock:
            _files.clear()
        return []
    documents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in names:
        path = directory / name
        key = str(path)
        try:
            details = os.stat(path)
        except OSError:
            continue
        seen.add(key)
        stamp = (details.st_mtime_ns, details.st_size)
        with _lock:
            cached = _files.get(key)
        if cached is not None and cached[0] == stamp:
            value = cached[1]
        else:
            value = _parse(path, details)
            with _lock:
                _files[key] = (stamp, value)
        if value is not None:
            documents.append(value)
    with _lock:
        for key in [key for key in _files if key not in seen]:
            _files.pop(key, None)
    return documents


def session_snapshot(session_id: str, directory: Path | None = None) -> dict[str, Any] | None:
    """One session's display snapshot with its file's updatedAt/stoppedAt, or None."""
    best: tuple[float, dict[str, Any], dict[str, Any]] | None = None
    for document in _documents(directory or state_directory()):
        session = document["sessions"].get(session_id)
        if not isinstance(session, dict):
            continue
        updated = float(document["updatedAt"])
        if best is None or updated > best[0]:
            best = (updated, document, session)
    if best is None:
        return None
    _, document, session = best
    snapshot = {name: session[name] for name in SNAPSHOT_FIELDS if name in session}
    snapshot["updatedAt"] = document["updatedAt"]
    stopped = document.get("stoppedAt")
    if isinstance(stopped, (int, float)) and not isinstance(stopped, bool) and stopped:
        snapshot["stoppedAt"] = stopped
    return snapshot


def status_payload(session_id: str, directory: Path | None = None) -> dict[str, Any]:
    now = int(time.time() * 1000)
    snapshot = session_snapshot(session_id, directory)
    if snapshot is None:
        return {"present": False, "serverNow": now}
    return {"present": True, "serverNow": now, "snapshot": snapshot}


def describe_module() -> tuple[bytes, str] | None:
    """The shared view model file with a strong ETag, cached by mtime/size."""
    global _module
    try:
        details = os.stat(DESCRIBE_MODULE)
    except OSError:
        return None
    stamp = (details.st_mtime_ns, details.st_size)
    with _lock:
        cached = _module
    if cached is not None and cached[0] == stamp:
        return cached[1], cached[2]
    if not stat.S_ISREG(details.st_mode) or details.st_size > MAX_FILE_BYTES:
        return None
    try:
        body = DESCRIBE_MODULE.read_bytes()
    except OSError:
        return None
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    with _lock:
        _module = (stamp, body, etag)
    return body, etag


def _send_module(handler: Any) -> None:
    module = describe_module()
    if module is None:
        handler.json_response({"ok": False, "error": "not found"}, status=404)
        return
    body, etag = module
    fresh = base.etag_matches(handler.headers.get("If-None-Match"), etag)
    handler.send_response(304 if fresh else 200)
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if fresh:
        handler.end_headers()
        return
    handler.send_header("Content-Type", "text/javascript; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        handler.close_connection = True


def handle_get(handler: Any, parsed: Any) -> bool:
    if parsed.path not in ("/client-dnd-watch.json", "/client-dnd-watch-describe.js"):
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    if parsed.path == "/client-dnd-watch-describe.js":
        _send_module(handler)
        return True
    session_id = str((parse_qs(parsed.query).get("sessionID") or [""])[0])
    if not SESSION_ID_RE.fullmatch(session_id):
        handler.json_response({"ok": False, "error": "invalid session id"}, status=400)
        return True
    handler.json_response(status_payload(session_id))
    return True
