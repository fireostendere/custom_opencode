#!/usr/bin/env python3
"""Web UI extensions: safe project browser and zero-token/explicit-paid doctor."""
from __future__ import annotations

import http.client
import json
from pathlib import Path
import secrets
import subprocess
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import server_ext as ext


REPO_ROOT = Path(__file__).resolve().parents[1]
DOCTOR_SMOKE_LOCK = threading.Lock()
MAX_MODEL = "bailian-cli/qwen3.8-max"
FLASH_MODEL = "bailian-cli/qwen3.6-flash"


class BackendHTTPError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _project_roots() -> tuple[Path, ...]:
    raw = ext.base.setting("OPENCODE_PROJECT_ROOTS", "~") or "~"
    roots: list[Path] = []
    for item in raw.split(";"):
        value = item.strip()
        if not value:
            continue
        try:
            candidate = Path(value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if candidate.is_dir() and candidate not in roots:
            roots.append(candidate)
    return tuple(roots)


def _inside(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def _allowed(candidate: Path, roots: tuple[Path, ...]) -> bool:
    return any(_inside(candidate, root) for root in roots)


def directory_snapshot(raw_path: str | None = None) -> dict[str, object]:
    roots = _project_roots()
    root_rows = [{"name": root.name or str(root), "path": str(root)} for root in roots]
    if not raw_path:
        return {"roots": root_rows, "current": None, "parent": None, "directories": []}

    try:
        current = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return {"error": "directory-not-found", "roots": root_rows}
    if not current.is_dir() or not _allowed(current, roots):
        return {"error": "directory-outside-allowed-roots", "roots": root_rows}

    parent = current.parent.resolve(strict=False)
    parent_value = str(parent) if parent != current and _allowed(parent, roots) else None
    directories: list[dict[str, str]] = []
    try:
        children = sorted(current.iterdir(), key=lambda path: path.name.casefold())
    except OSError:
        children = []
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            resolved = child.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not resolved.is_dir() or not _allowed(resolved, roots):
            continue
        directories.append({"name": child.name, "path": str(resolved)})
        if len(directories) >= 250:
            break

    return {
        "roots": root_rows,
        "current": str(current),
        "name": current.name or str(current),
        "parent": parent_value,
        "directories": directories,
    }


def _data(value: Any) -> Any:
    return value.get("data") if isinstance(value, dict) and "data" in value else value


def _backend_request_json(method: str, target: str, payload: object | None = None,
                          timeout: float = 20.0) -> Any:
    body = None
    headers = {
        "Accept": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))

    def _attempt(host: str, port: int, auth: str) -> Any:
        request_headers = dict(headers)
        request_headers["Authorization"] = auth
        request_headers["Host"] = host or "localhost"
        connection = ext.base.backend_connection(host, port, read_timeout=timeout)
        try:
            connection.request(method, target, body=body, headers=request_headers)
            response = connection.getresponse()
            raw = response.read()
            if response.status < 200 or response.status >= 300:
                detail = raw.decode("utf-8", errors="replace")[:500]
                raise BackendHTTPError(response.status, f"OpenCode {response.status}: {detail or response.reason}")
            if not raw:
                return None
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return raw.decode("utf-8", errors="replace")
        finally:
            connection.close()

    host, port, auth = ext.base.current_backend()
    try:
        return _attempt(host, port, auth)
    except (OSError, http.client.HTTPException):
        # Backend restarted on a new port; re-read service discovery and retry once.
        refreshed = ext.base.current_backend(force_refresh=True)
        if refreshed == (host, port, auth):
            raise
        host, port, auth = refreshed
        return _attempt(host, port, auth)
    except BackendHTTPError as exc:
        # Backend restarted keeping its port but rotated its password: 401/403.
        if exc.status not in (401, 403):
            raise
        refreshed = ext.base.current_backend(force_refresh=True)
        if refreshed == (host, port, auth):
            raise
        host, port, auth = refreshed
        return _attempt(host, port, auth)


def _workspace_target(path: str, directory: str | None = None) -> str:
    if not directory:
        return path
    return f"{path}?{urlencode({'location[directory]': directory})}"


def _read_runtime_config() -> tuple[dict[str, Any] | None, str]:
    raw_dir = ext.base.setting("OPENCODE_CONFIG_DIR") or str(Path.home() / ".config/opencode")
    path = Path(raw_dir).expanduser() / "opencode.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return (value if isinstance(value, dict) else None), str(path)
    except (OSError, json.JSONDecodeError):
        return None, str(path)


def _model_ids(payload: Any) -> set[str]:
    payload = _data(payload)
    result: set[str] = set()
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            provider = item.get("providerID") or item.get("provider")
            model = item.get("id") or item.get("modelID")
            if isinstance(provider, str) and isinstance(model, str):
                result.add(f"{provider}/{model}")
    return result


def _check(checks: list[dict[str, object]], check_id: str, group: str, label: str,
           status: str, detail: str, **extra: object) -> None:
    checks.append({
        "id": check_id,
        "group": group,
        "label": label,
        "status": status,
        "detail": detail,
        **extra,
    })


def _rag_runtime() -> dict[str, object]:
    configured_root = ext.base.setting("MCP_RAG_ROOT")
    candidates: list[Path] = []
    if configured_root:
        candidates.append(Path(configured_root).expanduser())
    candidates.extend([REPO_ROOT.parent / "mcp-rag", Path.home() / "mcp-rag"])

    root = next((candidate.resolve() for candidate in candidates if candidate.is_dir()), None)
    configured_bin = ext.base.setting("MCP_RAG_BIN")
    executable = Path(configured_bin).expanduser() if configured_bin else (
        root / ".venv/bin/knowledge-mcp" if root else None)
    if executable:
        try:
            executable = executable.resolve()
        except OSError:
            pass
    python = executable.parent / "python" if executable else None
    return {
        "root": str(root) if root else None,
        "executable": str(executable) if executable else None,
        "python": str(python) if python and python.is_file() else None,
        "available": bool(root and executable and executable.is_file() and python and python.is_file()),
    }


def _run_rag_probe(mode: str = "status", query: str = "DipTrace PCB layout") -> dict[str, Any]:
    runtime = _rag_runtime()
    if not runtime["available"]:
        return {"ok": False, "error": "RAG runtime not found", "runtime": runtime}
    command = [
        str(runtime["python"]),
        str(REPO_ROOT / "scripts/rag-probe.py"),
        "--executable", str(runtime["executable"]),
        "--cwd", str(runtime["root"]),
        "--mode", mode,
    ]
    if mode == "search":
        command.extend(["--query", query])
    # FastEmbed/Qdrant imports and MCP initialization can take just over twenty
    # seconds on a cold WSL process. Keep the probe bounded, but avoid a false
    # negative at the old 20-second edge.
    timeout = 180.0 if mode == "search" else 60.0
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "runtime": runtime}
    if result.returncode != 0:
        return {
            "ok": False,
            "error": (result.stderr or result.stdout or f"exit {result.returncode}")[-1000:].strip(),
            "runtime": runtime,
        }
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": "Invalid RAG probe JSON", "runtime": runtime}
    return {"ok": True, "runtime": runtime, **payload}


def doctor_snapshot() -> dict[str, object]:
    checks: list[dict[str, object]] = []
    directory = str(ext.base.SCRATCH_ROOT)

    models_payload = None
    try:
        models_payload = _backend_request_json("GET", _workspace_target("/api/model", directory))
        _check(checks, "backend", "System", "OpenCode V2 backend", "pass", "HTTP API отвечает")
    except Exception as exc:
        _check(checks, "backend", "System", "OpenCode V2 backend", "fail", str(exc))

    config, config_path = _read_runtime_config()
    if config:
        _check(checks, "runtime-config", "System", "Runtime config", "pass", config_path)
    else:
        _check(checks, "runtime-config", "System", "Runtime config", "fail", f"Не читается {config_path}")

    model_ids = _model_ids(models_payload)
    for check_id, model_id, label in (
        ("max-catalog", MAX_MODEL, "Qwen 3.8 Max в catalog"),
        ("flash-catalog", FLASH_MODEL, "Qwen 3.6 Flash в catalog"),
    ):
        _check(
            checks, check_id, "Alibaba", label,
            "pass" if model_id in model_ids else "fail",
            model_id if model_id in model_ids else f"Не найден {model_id}",
        )

    usage = ext.query_bailian_token_plan()
    _check(
        checks, "token-plan-auth", "Alibaba", "Token Plan authorization",
        "pass" if usage.get("available") else "warn",
        "Bailian usage API отвечает без inference" if usage.get("available") else str(usage.get("reason") or "usage недоступен"),
    )

    agents = config.get("agents", {}) if config else {}
    primary_model = config.get("model") if config else None
    fast_model = (agents.get("fast-reader") or {}).get("model") if isinstance(agents, dict) else None
    auto_local = [
        name for name, agent in (agents.items() if isinstance(agents, dict) else [])
        if isinstance(agent, dict) and str(agent.get("model") or "").startswith("ollama/")
    ]
    _check(
        checks, "primary-route", "Router", "Primary → Qwen 3.8 Max",
        "pass" if primary_model == MAX_MODEL else "fail", str(primary_model or "не задан"),
    )
    _check(
        checks, "flash-route", "Router", "fast-reader → Qwen 3.6 Flash",
        "pass" if fast_model == FLASH_MODEL else "fail", str(fast_model or "не задан"),
    )
    _check(
        checks, "no-auto-local", "Router", "Автоматический Ollama выключен",
        "pass" if not auto_local else "fail",
        "Автоматические agents не используют local models" if not auto_local else ", ".join(auto_local),
    )

    mcp_payload = None
    try:
        mcp_payload = _data(_backend_request_json("GET", _workspace_target("/api/mcp", directory)))
    except Exception as exc:
        _check(checks, "mcp-kb", "RAG", "OpenCode MCP kb", "fail", str(exc))
    if isinstance(mcp_payload, dict):
        kb = mcp_payload.get("kb")
        status = kb.get("status") if isinstance(kb, dict) else None
        detail = str((kb or {}).get("error") or status or "kb отсутствует") if isinstance(kb, dict) else "kb отсутствует"
        _check(
            checks, "mcp-kb", "RAG", "OpenCode MCP kb",
            "pass" if status == "connected" else ("warn" if status == "disabled" else "fail"),
            detail,
        )

    runtime = _rag_runtime()
    _check(
        checks, "rag-runtime", "RAG", "RAG executable",
        "pass" if runtime["available"] else "warn",
        str(runtime.get("executable") or "MCP_RAG_ROOT/MCP_RAG_BIN не найдены"),
    )

    probe = _run_rag_probe("status") if runtime["available"] else {"ok": False}
    if probe.get("ok"):
        tools = set(probe.get("tools") or [])
        required_tools = {"knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status"}
        _check(
            checks, "rag-tools", "RAG", "MCP tools зарегистрированы",
            "pass" if required_tools.issubset(tools) else "fail",
            f"{len(tools)} tools · required {'OK' if required_tools.issubset(tools) else 'missing'}",
        )
        status = probe.get("status") if isinstance(probe.get("status"), dict) else {}
        qdrant = bool(status.get("qdrant_reachable"))
        registry = status.get("registry") if isinstance(status.get("registry"), dict) else {}
        docs = registry.get("documents")
        chunks = registry.get("chunks")
        _check(
            checks, "qdrant", "RAG", "Qdrant",
            "pass" if qdrant else "fail",
            f"online · {status.get('indexed_points')} points" if qdrant else str(status.get("error") or "offline"),
        )
        _check(
            checks, "rag-corpus", "RAG", "Corpus",
            "pass" if isinstance(docs, int) and docs > 0 else "warn",
            f"{docs or 0} docs · {chunks or 0} chunks",
        )
        _check(
            checks, "rag-lifecycle", "RAG", "Model idle unload",
            "pass" if status.get("model_idle_seconds") else "warn",
            f"{status.get('model_idle_seconds', 0)} s · Qdrant timeout {status.get('qdrant_timeout_seconds', '—')} s",
        )
    elif runtime["available"]:
        _check(checks, "rag-tools", "RAG", "MCP protocol probe", "fail", str(probe.get("error") or "probe failed"))

    return {
        "generatedAt": int(time.time()),
        "zeroToken": True,
        "checks": checks,
        "smokes": [
            {"id": "rag", "label": "RAG retrieval", "paid": False, "note": "0 LLM tokens; local embedding/reranker"},
            {"id": "flash", "label": "Qwen Flash inference", "paid": True, "note": "1 короткий запрос qwen3.6-flash"},
            {"id": "max", "label": "Qwen Max inference", "paid": True, "note": "1 короткий запрос qwen3.8-max"},
            {"id": "router", "label": "Router E2E", "paid": True, "note": "Max → fast-reader/Flash"},
            {"id": "router-rag", "label": "Router + RAG E2E", "paid": True, "note": "Max → Flash → kb_knowledge_search"},
        ],
    }


def _create_smoke_session(directory: str, model: str, title: str) -> dict[str, Any]:
    value = _data(_backend_request_json("POST", "/api/session", {
        "location": {"directory": directory},
        "title": title,
        "agent": "build",
        "model": {"providerID": model.split("/", 1)[0], "id": model.split("/", 1)[1]},
    }, timeout=20.0))
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        raise RuntimeError("OpenCode did not return a smoke session id")
    return value


def _send_smoke_prompt(session_id: str, text: str, timeout: float = 120.0) -> Any:
    target = f"/api/session/{session_id}/prompt"
    last_error: Exception | None = None
    for payload in (
        {"text": text, "files": [], "resume": True},
        {"prompt": {"text": text, "files": []}, "delivery": "steer"},
        {"text": text, "files": [], "delivery": "steer"},
    ):
        try:
            return _backend_request_json("POST", target, payload, timeout=timeout)
        except BackendHTTPError as exc:
            last_error = exc
            if exc.status not in (400, 404, 405, 422):
                raise
    raise last_error or RuntimeError("Prompt API unavailable")


def _session_messages(session_id: str) -> Any:
    return _data(_backend_request_json(
        "GET", f"/api/session/{session_id}/message?limit=200", timeout=15.0))


def _json_blob(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def _assistant_messages(value: Any) -> list[dict[str, Any]]:
    return [
        row for row in value if isinstance(row, dict)
        and (row.get("info") if isinstance(row.get("info"), dict) else row).get("role") == "assistant"
    ] if isinstance(value, list) else []


def _wait_for_text(session_id: str, needle: str | None = None, timeout: float = 90.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            messages = _assistant_messages(_session_messages(session_id))
            blob = _json_blob(messages)
            if needle and needle in blob:
                return messages
            if not needle and messages:
                return messages
        except Exception:
            pass
        time.sleep(0.75)
    return []


def _all_sessions() -> list[dict[str, Any]]:
    value = _data(_backend_request_json("GET", "/api/session?limit=200&order=desc", timeout=15.0))
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _cleanup_smoke(session_id: str | None, workspace: str, child_ids: list[str] | None = None) -> None:
    for sid in (child_ids or []):
        try:
            _backend_request_json("DELETE", f"/api/session/{sid}", timeout=10.0)
        except Exception:
            pass
    if session_id:
        try:
            _backend_request_json("DELETE", f"/api/session/{session_id}", timeout=10.0)
        except Exception:
            pass
    ext.base.cleanup_scratch_directory(workspace)


def _model_smoke(model: str) -> dict[str, object]:
    workspace = ext.base.allocate_scratch_directory()
    session_id = None
    started = time.monotonic()
    try:
        session = _create_smoke_session(workspace, model, "Doctor model smoke")
        session_id = session["id"]
        _send_smoke_prompt(
            session_id,
            "Reply exactly DOCTOR_OK. Do not call tools or subagents. Output no other text.",
            timeout=90.0,
        )
        messages = _wait_for_text(session_id, "DOCTOR_OK", timeout=30.0)
        blob = _json_blob(messages)
        ok = "DOCTOR_OK" in blob
        return {
            "ok": ok,
            "paid": True,
            "model": model,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "detail": "DOCTOR_OK" if ok else "Model answered but expected marker was not observed",
        }
    finally:
        _cleanup_smoke(session_id, workspace)


def _router_smoke(use_rag: bool) -> dict[str, object]:
    workspace = ext.base.allocate_scratch_directory()
    session_id = None
    child_ids: list[str] = []
    started = time.monotonic()
    marker = f"ROUTER_SMOKE_{secrets.token_hex(4)}"
    try:
        if not use_rag:
            (Path(workspace) / "router-smoke.txt").write_text(marker + "\n", encoding="utf-8")
        session = _create_smoke_session(workspace, MAX_MODEL, "Doctor router smoke")
        session_id = session["id"]
        if use_rag:
            prompt = (
                "Automated router+RAG smoke. You MUST delegate to fast-reader. "
                "The fast-reader MUST call kb_knowledge_search with query 'DipTrace PCB layout' and top_k=1. "
                "Do not answer from memory. After it returns, reply with RAG_SMOKE_OK and the first source/title."
            )
            needle = "RAG_SMOKE_OK"
        else:
            prompt = (
                "Automated router smoke. You MUST delegate exactly one read-only task to fast-reader: "
                "read router-smoke.txt and return the exact marker. Do not read the file yourself. "
                "After the subagent returns, reply exactly that marker and nothing else."
            )
            needle = marker
        _send_smoke_prompt(session_id, prompt, timeout=180.0)
        parent_messages = _wait_for_text(session_id, needle, timeout=60.0)

        children = [item for item in _all_sessions() if item.get("parentID") == session_id]
        child_ids = [str(item["id"]) for item in children if item.get("id")]
        child_messages = []
        for child_id in child_ids:
            try:
                child_messages.append(_session_messages(child_id))
            except Exception:
                child_messages.append(None)

        parent_blob = _json_blob(parent_messages)
        child_blob = _json_blob([children, child_messages])
        flash_seen = "qwen3.6-flash" in child_blob
        local_seen = "ollama" in child_blob.lower()
        delegated = bool(child_ids)
        if use_rag:
            tool_seen = "kb_knowledge_search" in child_blob
            marker_seen = needle in parent_blob
            ok = delegated and flash_seen and tool_seen and marker_seen and not local_seen
            detail = f"child={delegated}, flash={flash_seen}, rag_tool={tool_seen}, result={marker_seen}, ollama={local_seen}"
        else:
            marker_seen = marker in parent_blob or marker in child_blob
            ok = delegated and flash_seen and marker_seen and not local_seen
            detail = f"child={delegated}, flash={flash_seen}, marker={marker_seen}, ollama={local_seen}"
        return {
            "ok": ok,
            "paid": True,
            "kind": "router-rag" if use_rag else "router",
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "detail": detail,
            "childSessions": len(child_ids),
        }
    finally:
        _cleanup_smoke(session_id, workspace, child_ids)


def run_doctor_smoke(kind: str) -> dict[str, object]:
    if not DOCTOR_SMOKE_LOCK.acquire(blocking=False):
        return {"ok": False, "busy": True, "error": "Другой Doctor smoke уже выполняется"}
    try:
        if kind == "rag":
            started = time.monotonic()
            result = _run_rag_probe("search")
            search = result.get("search") if isinstance(result.get("search"), dict) else {}
            hits = search.get("hits") if isinstance(search, dict) else None
            hit = hits[0] if isinstance(hits, list) and hits else None
            return {
                "ok": bool(result.get("ok") and hit),
                "paid": False,
                "kind": "rag",
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "detail": (
                    f"{hit.get('title')} · {hit.get('source')}" if isinstance(hit, dict)
                    else str(result.get("error") or "No retrieval hit")
                ),
            }
        if kind == "flash":
            return _model_smoke(FLASH_MODEL)
        if kind == "max":
            return _model_smoke(MAX_MODEL)
        if kind == "router":
            return _router_smoke(False)
        if kind == "router-rag":
            return _router_smoke(True)
        return {"ok": False, "error": f"Unknown smoke kind: {kind}"}
    except Exception as exc:
        return {"ok": False, "paid": kind != "rag", "kind": kind, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        DOCTOR_SMOKE_LOCK.release()


class Handler(ext.Handler):
    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-directories.json":
            if not self.authenticated():
                return
            params = parse_qs(parsed.query)
            raw_path = (params.get("path") or [None])[0]
            self.json_response(directory_snapshot(raw_path))
            return
        if parsed.path == "/client-doctor.json":
            if not self.authenticated():
                return
            self.json_response(doctor_snapshot())
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-doctor-smoke.json":
            if not self.authenticated():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "Invalid Content-Length")
                return
            if length < 0 or length > 4096:
                self.send_error(400, "Invalid Doctor request size")
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid Doctor JSON")
                return
            kind = payload.get("kind") if isinstance(payload, dict) else None
            if kind not in {"rag", "flash", "max", "router", "router-rag"}:
                self.send_error(400, "Unknown Doctor smoke")
                return
            self.json_response(run_doctor_smoke(kind))
            return
        super().do_POST()


def main() -> None:
    ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ext.base.ThreadingHTTPServer((ext.base.WEB_HOST, ext.base.WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
