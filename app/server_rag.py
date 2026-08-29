#!/usr/bin/env python3
"""RAG lifecycle and server control-plane endpoints for the web client."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import control_plane
import server_plus as plus

RAG_START_LOCK = threading.Lock()
RAG_QUERY = "DipTrace PCB layout"


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


def _mcp_status(directory: str) -> dict[str, Any]:
    try:
        payload = plus._backend_request_json(
            "GET", _v2_workspace_target("/api/mcp", directory), timeout=15.0)
    except Exception as exc:
        return {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
    value = plus._data(payload)
    if isinstance(value, list):
        for server in value:
            if not isinstance(server, dict) or server.get("name") != "kb":
                continue
            status = server.get("status")
            return status if isinstance(status, dict) else {"status": "failed"}
        return {"status": "missing"}
    # Compatibility with an older beta response shape.
    if isinstance(value, dict):
        kb = value.get("kb")
        if isinstance(kb, dict):
            return kb
    return {"status": "failed", "error": "OpenCode returned invalid MCP status"}


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


def _dynamic_mcp_config() -> dict[str, Any]:
    script = (plus.REPO_ROOT / "scripts/rag-mcp.sh").resolve()
    return {
        "type": "local",
        "command": ["bash", str(script)],
        "cwd": str(plus.REPO_ROOT.resolve()),
        "disabled": False,
        "timeout": {
            "startup": 10_000,
            "catalog": 10_000,
            "execution": 60_000,
        },
    }


def _persist_kb_enabled() -> dict[str, Any]:
    """Persist exactly one safe bit so future workspaces/restarts auto-connect kb."""
    config, path_text = plus._read_runtime_config()
    if not isinstance(config, dict):
        return {"ok": False, "changed": False, "error": f"runtime config is not readable: {path_text}"}
    mcp = config.get("mcp")
    servers = mcp.get("servers") if isinstance(mcp, dict) else None
    kb = servers.get("kb") if isinstance(servers, dict) else None
    if not isinstance(kb, dict):
        return {"ok": False, "changed": False, "error": "runtime config has no mcp.servers.kb"}
    if kb.get("disabled") is False:
        return {"ok": True, "changed": False, "path": path_text}

    kb["disabled"] = False
    path = Path(path_text)
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temp_name = tempfile.mkstemp(prefix=".opencode-rag-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, previous_mode)
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass
    return {"ok": True, "changed": True, "path": path_text}


def _connect_kb(directory: str) -> dict[str, Any]:
    current = _mcp_status(directory)
    if current.get("status") == "connected":
        return {"ok": True, "action": "already-connected", "status": current}

    add_error = None
    try:
        plus._backend_request_json(
            "PUT",
            _v2_workspace_target("/api/mcp/kb", directory),
            {"config": _dynamic_mcp_config()},
            timeout=20.0,
        )
    except plus.BackendHTTPError as exc:
        if exc.status not in (400, 404, 405, 409, 422):
            raise
        add_error = str(exc)

    after_add = _mcp_status(directory)
    if after_add.get("status") != "connected":
        try:
            plus._backend_request_json(
                "POST",
                _v2_workspace_target("/api/mcp/kb/connect", directory),
                None,
                timeout=20.0,
            )
        except plus.BackendHTTPError as exc:
            if exc.status not in (404, 405):
                raise
            if add_error is None:
                add_error = str(exc)

    deadline = time.monotonic() + 12.0
    latest = _mcp_status(directory)
    while latest.get("status") != "connected" and time.monotonic() < deadline:
        time.sleep(0.4)
        latest = _mcp_status(directory)

    if latest.get("status") == "connected":
        return {
            "ok": True,
            "action": "connected",
            "status": latest,
            "compatibilityNote": add_error,
        }
    return {
        "ok": False,
        "action": "connect-failed",
        "status": latest,
        "error": str(latest.get("error") or add_error or "kb MCP did not reach connected state"),
    }


def run_rag_start(mode: str = "full", session_id: str | None = None) -> dict[str, Any]:
    if not RAG_START_LOCK.acquire(blocking=False):
        return {"ok": False, "busy": True, "error": "RAG start/check is already running"}
    started = time.monotonic()
    try:
        runtime = _run_runtime_start(mode)
        if not runtime.get("ok"):
            return {
                "ok": False,
                "stage": "runtime",
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "runtime": runtime,
            }

        directory = _session_directory(session_id)
        connection = _connect_kb(directory)
        persisted = _persist_kb_enabled() if connection.get("ok") else {
            "ok": False,
            "changed": False,
            "skipped": True,
            "error": "kb was not persisted because the live workspace connection failed",
        }
        protocol = plus._run_rag_probe("status")
        tools = set(protocol.get("tools") or []) if protocol.get("ok") else set()
        required = {"knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status"}
        tools_ok = required.issubset(tools)

        ok = bool(connection.get("ok") and persisted.get("ok") and protocol.get("ok") and tools_ok)
        return {
            "ok": ok,
            "stage": "ready" if ok else "verification",
            "mode": mode,
            "workspace": directory,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "runtime": runtime,
            "persisted": persisted,
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


def _permission_requests(directory: str) -> list[dict[str, Any]]:
    payload = plus._backend_request_json(
        "GET", _v2_workspace_target("/api/permission/request", directory), timeout=15.0)
    value = plus._data(payload)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _reply_permission_once(session_id: str, permission_id: str) -> None:
    sid = quote(session_id, safe="")
    pid = quote(permission_id, safe="")
    try:
        plus._backend_request_json(
            "POST",
            f"/api/session/{sid}/permission/{pid}/reply",
            {"reply": "once"},
            timeout=15.0,
        )
        return
    except plus.BackendHTTPError as exc:
        if exc.status != 404:
            raise
    plus._backend_request_json(
        "POST",
        f"/api/session/{sid}/permissions/{pid}",
        {"response": "once", "remember": False},
        timeout=15.0,
    )


def evaluate_permission(session_id: str, permission_id: str) -> dict[str, Any]:
    """Evaluate an actual pending backend request and auto-reply only if safe.

    The browser supplies only identifiers. Action/resources are fetched again
    from OpenCode so a modified client cannot label a destructive permission as
    a harmless read and trick the server into approving it.
    """
    workspace = _session_directory(session_id)
    try:
        requests = _permission_requests(workspace)
    except Exception as exc:
        return {
            "ok": False,
            "autoReplied": False,
            "effect": "ask",
            "risk": "R3",
            "reason": f"permission lookup failed: {type(exc).__name__}: {exc}",
        }

    request = next((item for item in requests if str(item.get("id")) == permission_id and str(item.get("sessionID")) == session_id), None)
    if request is None:
        return {"ok": True, "stale": True, "autoReplied": False, "effect": "ask", "reason": "permission is no longer pending"}

    decision = control_plane.classify_permission(request, workspace=workspace)
    control_plane.audit_decision(
        decision,
        request=request,
        session_id=session_id,
        permission_id=permission_id,
    )
    result = {"ok": True, "autoReplied": False, **decision}
    if decision.get("effect") != "allow" or decision.get("reply") != "once":
        return result

    try:
        _reply_permission_once(session_id, permission_id)
    except Exception as exc:
        result["ok"] = False
        result["error"] = f"auto-reply failed: {type(exc).__name__}: {exc}"
        return result
    result["autoReplied"] = True
    return result


class Handler(plus.Handler):
    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-control-plane.json":
            if not self.authenticated():
                return
            self.json_response(control_plane.snapshot())
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-permission-evaluate.json":
            if not self.authenticated():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "Invalid Content-Length")
                return
            if length < 0 or length > 4096:
                self.send_error(400, "Invalid permission request size")
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid permission JSON")
                return
            session_id = payload.get("sessionID") if isinstance(payload, dict) else None
            permission_id = payload.get("permissionID") if isinstance(payload, dict) else None
            if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
                self.send_error(400, "Invalid session id")
                return
            if not isinstance(permission_id, str) or not permission_id or len(permission_id) > 256:
                self.send_error(400, "Invalid permission id")
                return
            self.json_response(evaluate_permission(session_id, permission_id))
            return

        if parsed.path == "/client-rag-start.json":
            if not self.authenticated():
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
