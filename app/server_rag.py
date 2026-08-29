#!/usr/bin/env python3
"""RAG lifecycle control layered on top of the existing web server."""
from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import server_plus as plus

RAG_START_LOCK = threading.Lock()
RAG_QUERY = "DipTrace PCB layout"


def _mcp_status(directory: str) -> dict[str, Any]:
    try:
        value = plus._data(plus._backend_request_json(
            "GET", plus._workspace_target("/api/mcp", directory), timeout=15.0))
    except Exception as exc:
        return {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
    if not isinstance(value, dict):
        return {"status": "failed", "error": "OpenCode returned invalid MCP status"}
    kb = value.get("kb")
    return kb if isinstance(kb, dict) else {"status": "missing"}


def _run_runtime_start(mode: str) -> dict[str, Any]:
    runtime = plus._rag_runtime()
    if not runtime.get("available"):
        return {
            "ok": False,
            "stage": "runtime",
            "error": "RAG runtime not found. Set MCP_RAG_ROOT/MCP_RAG_BIN or create the mcp-rag venv.",
            "runtime": runtime,
        }

    python = str(runtime["python"])
    root = str(runtime["root"])
    command = [python, "-m", "knowledge_base.runtime", "--json", "--wait", "20"]
    if mode != "quick":
        command.extend(["--search", RAG_QUERY])
    try:
        proc = subprocess.run(
            command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180 if mode != "quick" else 60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "ok": False,
            "stage": "runtime",
            "error": f"{type(exc).__name__}: {exc}",
            "runtime": runtime,
        }

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


def _dynamic_mcp_config() -> dict[str, Any]:
    """Use the current V2 HTTP add endpoint's V1 MCP config schema."""
    script = (plus.REPO_ROOT / "scripts/rag-mcp.sh").resolve()
    return {
        "type": "local",
        "command": ["bash", str(script)],
        "cwd": str(plus.REPO_ROOT.resolve()),
        "enabled": True,
        "timeout": 60_000,
    }


def _connect_kb(directory: str) -> dict[str, Any]:
    current = _mcp_status(directory)
    if current.get("status") == "connected":
        return {"ok": True, "action": "already-connected", "status": current}

    add_error = None
    try:
        plus._backend_request_json(
            "POST",
            plus._workspace_target("/api/mcp", directory),
            {"name": "kb", "config": _dynamic_mcp_config()},
            timeout=20.0,
        )
    except plus.BackendHTTPError as exc:
        # Older compatible builds may reject dynamic add while still supporting
        # connect for the statically configured kb entry.
        if exc.status not in (400, 404, 405, 409, 422):
            raise
        add_error = str(exc)

    after_add = _mcp_status(directory)
    if after_add.get("status") != "connected":
        try:
            plus._backend_request_json(
                "POST",
                plus._workspace_target("/api/mcp/kb/connect", directory),
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


def run_rag_start(mode: str = "full") -> dict[str, Any]:
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

        directory = str(plus.ext.base.SCRATCH_ROOT)
        connection = _connect_kb(directory)
        protocol = plus._run_rag_probe("status")
        tools = set(protocol.get("tools") or []) if protocol.get("ok") else set()
        required = {"knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status"}
        tools_ok = required.issubset(tools)

        ok = bool(connection.get("ok") and protocol.get("ok") and tools_ok)
        return {
            "ok": ok,
            "stage": "ready" if ok else "verification",
            "mode": mode,
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
            if mode not in {"quick", "full"}:
                self.send_error(400, "Unknown RAG start mode")
                return
            self.json_response(run_rag_start(mode))
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
