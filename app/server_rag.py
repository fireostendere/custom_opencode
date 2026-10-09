#!/usr/bin/env python3
"""RAG lifecycle control layered on top of the existing web server."""
from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import server_plus as plus

RAG_START_LOCK = threading.Lock()
RAG_QUERY = "DipTrace PCB layout"
# Knowledge MCP servers: the global `kb`, project-scoped `<name>_kb`, the D&D table's `dnd`.
RAG_SERVER = re.compile(r"^(?:kb|dnd|\w+_kb)$")


def _v2_workspace_target(path: str, directory: str | None = None) -> str:
    """Encode the V2 deep-object location query used by the HTTP API."""
    if not directory:
        return path
    return f"{path}?{urlencode({'location[directory]': directory})}"


plus._workspace_target = _v2_workspace_target


def _session_directory(session_id: str | None) -> str:
    if session_id:
        try:
            sid = quote(session_id, safe="")
            value = plus._data(plus._backend_request_json(
                "GET", f"/api/session/{sid}", timeout=15.0))
            directory = ((value or {}).get("location") or {}).get("directory") if isinstance(value, dict) else None
            if isinstance(directory, str) and directory:
                return directory
        except Exception:
            pass
    return str(plus.ext.base.SCRATCH_ROOT)


def _rag_servers(directory: str) -> dict[str, Any]:
    """Enabled knowledge (mcp-rag) servers the workspace already has, by name.

    RAG can be project-scoped (a plugin or project config adds `engineering_kb`,
    `cossacks_kb`, `dnd`, ...), so the global `kb` may legitimately be absent.
    """
    try:
        payload = plus._backend_request_json(
            "GET", _v2_workspace_target("/api/mcp", directory), timeout=15.0)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    value = plus._data(payload)
    # A list is the V2 shape; a name -> status object is the older beta shape.
    if isinstance(value, dict):
        value = [{"name": name, "status": status} for name, status in value.items()]
    if not isinstance(value, list):
        return {"error": "OpenCode returned invalid MCP status"}
    servers = {}
    for server in value:
        name = server.get("name") if isinstance(server, dict) else None
        if isinstance(name, str) and RAG_SERVER.match(name):
            status = server.get("status")
            status = status if isinstance(status, dict) else {"status": "failed"}
            if status.get("status") != "disabled":
                servers[name] = status
    return {"servers": servers}


def _invoke_runtime(runtime: dict[str, object], args: list[str], timeout: float) -> dict[str, Any]:
    python = str(runtime["python"])
    root = str(runtime["root"])
    command = [python, "-m", "knowledge_base.runtime", "--json", *args]
    try:
        proc = subprocess.run(
            command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "runtime": runtime}
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        report = {
            "ok": False,
            "error": (proc.stderr or proc.stdout or f"knowledge runtime exit {proc.returncode}")[-1500:].strip(),
        }
    if not isinstance(report, dict):
        report = {"ok": False, "error": "RAG runtime returned invalid JSON"}
    report.setdefault("runtime", runtime)
    report["exitCode"] = proc.returncode
    if proc.returncode != 0:
        report["ok"] = False
        report.setdefault("error", (proc.stderr or "RAG runtime is not ready")[-1200:].strip())
    return report


def _run_runtime_start(mode: str) -> dict[str, Any]:
    runtime = plus._rag_runtime()
    if not runtime.get("available"):
        return {
            "ok": False,
            "stage": "runtime",
            "error": "RAG runtime not found. Set MCP_RAG_ROOT/MCP_RAG_BIN or create the mcp-rag venv.",
            "runtime": runtime,
        }

    # Always perform a model-free preflight first. This ensures a missing vector
    # collection fails before any retrieval code can create/modify one.
    preflight = _invoke_runtime(runtime, ["--wait", "20"], 60.0)
    if not preflight.get("ok") or mode == "quick":
        preflight["preflight"] = True
        return preflight

    full = _invoke_runtime(
        runtime,
        ["--no-start", "--search", RAG_QUERY],
        180.0,
    )
    full["preflight"] = preflight
    return full


def _connect_rag(directory: str) -> dict[str, Any]:
    """Reconnect the workspace's own RAG servers. Never adds or persists one."""
    found = _rag_servers(directory)
    if "error" in found:
        return {"ok": False, "action": "status-failed", "error": found["error"]}
    servers = found["servers"]
    if not servers:
        return {"ok": False, "action": "none", "servers": {},
                "error": "this workspace has no RAG MCP server (kb, *_kb or dnd)"}
    pending = [name for name, status in servers.items() if status.get("status") != "connected"]
    if not pending:
        return {"ok": True, "action": "already-connected", "servers": servers}

    errors = {}
    for name in pending:
        try:
            plus._backend_request_json(
                "POST",
                _v2_workspace_target(f"/api/mcp/{quote(name, safe='')}/connect", directory),
                None,
                timeout=75.0,
            )
        except plus.BackendHTTPError as exc:
            if exc.status not in (404, 405):
                raise
            errors[name] = str(exc)

    deadline = time.monotonic() + 12.0
    while True:
        latest = _rag_servers(directory).get("servers") or {}
        down = [name for name in servers if (latest.get(name) or {}).get("status") != "connected"]
        if not down or time.monotonic() >= deadline:
            break
        time.sleep(0.4)
    if not down:
        return {"ok": True, "action": "connected", "servers": latest}
    return {
        "ok": False,
        "action": "connect-failed",
        "servers": latest,
        "error": "; ".join(f"{name}: {(latest.get(name) or {}).get('error') or errors.get(name) or 'not connected'}"
                           for name in down),
    }


def run_rag_start(mode: str = "full", session_id: str | None = None) -> dict[str, Any]:
    if not RAG_START_LOCK.acquire(blocking=False):
        return {"ok": False, "busy": True, "error": "RAG start/check is already running"}
    started = time.monotonic()
    try:
        directory = _session_directory(session_id)
        # A workspace without its own RAG server needs no Qdrant start at all.
        found = _rag_servers(directory)
        if not found.get("servers"):
            return {
                "ok": False,
                "stage": "workspace",
                "workspace": directory,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "error": found.get("error") or "this workspace has no RAG MCP server (kb, *_kb or dnd)",
            }

        runtime = _run_runtime_start(mode)
        if not runtime.get("ok"):
            return {
                "ok": False,
                "stage": "runtime",
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "runtime": runtime,
            }

        connection = _connect_rag(directory)
        protocol = plus._run_rag_probe("status")
        tools = set(protocol.get("tools") or []) if protocol.get("ok") else set()
        required = {"knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status"}
        tools_ok = required.issubset(tools)

        ok = bool(connection.get("ok") and protocol.get("ok") and tools_ok)
        return {
            "ok": ok,
            "stage": "ready" if ok else "verification",
            "mode": mode,
            "workspace": directory,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "runtime": runtime,
            "mcp": connection,
            "protocol": {
                "ok": bool(protocol.get("ok")),
                "tools": sorted(tools),
                "requiredTools": sorted(required),
                "requiredToolsReady": tools_ok,
                "status": protocol.get("status"),
                "error": protocol.get("error"),
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "stage": "exception",
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
        }
    finally:
        RAG_START_LOCK.release()


class Handler(plus.Handler):
    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-rag-start.json":
            if not self.authenticated():
                self.unauthorized()
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "Invalid Content-Length")
                return
            if length < 0 or length > 4096:
                self.send_error(400, "Invalid RAG request size")
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid RAG JSON")
                return
            mode = str(payload.get("mode") or "full").lower() if isinstance(payload, dict) else "full"
            session_id = payload.get("sessionID") if isinstance(payload, dict) else None
            if mode not in {"quick", "full"}:
                self.send_error(400, "Unknown RAG start mode")
                return
            if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 256):
                self.send_error(400, "Invalid session id")
                return
            self.json_response(run_rag_start(mode, session_id=session_id))
            return
        super().do_POST()


def main() -> None:
    plus.ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = plus.ext.base.ThreadingHTTPServer((plus.ext.base.WEB_HOST, plus.ext.base.WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {plus.ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
