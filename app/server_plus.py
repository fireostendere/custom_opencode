#!/usr/bin/env python3
"""Web UI extensions: safe project browser and shared backend helpers."""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import server_ext as ext


REPO_ROOT = Path(__file__).resolve().parents[1]
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


def _child_name(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 120:
        return None
    if value in (".", "..") or "/" in value or "\\" in value:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value


def _creation_root(parent: Path, roots: tuple[Path, ...]) -> Path | None:
    # Prefer the deepest root so the descriptor walk is as short as possible.
    matches = [root for root in roots if _inside(parent, root)]
    return max(matches, key=lambda root: len(root.parts), default=None)


def create_child_directory(raw_parent: object, raw_name: object) -> tuple[int, dict[str, object]]:
    """Create one directory below an allowed parent without following links."""
    name = _child_name(raw_name)
    if not isinstance(raw_parent, str) or not name:
        return 400, {"ok": False, "error": "invalid-directory"}
    try:
        parent = Path(raw_parent).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return 404, {"ok": False, "error": "directory-not-found"}
    if not parent.is_dir():
        return 404, {"ok": False, "error": "directory-not-found"}
    roots = _project_roots()
    root = _creation_root(parent, roots)
    if root is None:
        return 403, {"ok": False, "error": "directory-outside-allowed-roots"}

    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        if not hasattr(os, "supports_dir_fd") or os.open not in os.supports_dir_fd:
            raise NotImplementedError
        fd = os.open(root, flags)
        try:
            for part in parent.relative_to(root).parts:
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            os.mkdir(name, mode=0o700, dir_fd=fd)
        finally:
            os.close(fd)
    except FileExistsError:
        return 409, {"ok": False, "error": "directory-exists"}
    except (NotImplementedError, TypeError):
        # Platforms without dir_fd still get a post-create containment check.
        try:
            target = parent / name
            target.mkdir(mode=0o700, exist_ok=False)
            resolved = target.resolve(strict=True)
            if not resolved.is_dir() or not _allowed(resolved, roots):
                return 403, {"ok": False, "error": "directory-outside-allowed-roots"}
        except FileExistsError:
            return 409, {"ok": False, "error": "directory-exists"}
        except OSError:
            return 500, {"ok": False, "error": "directory-create-failed"}
    except FileNotFoundError:
        return 404, {"ok": False, "error": "directory-not-found"}
    except OSError:
        return 500, {"ok": False, "error": "directory-create-failed"}
    return 201, {"ok": True, "directory": str(parent / name), "name": name}


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


class Handler(ext.Handler):
    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-directories.json":
            if not self.authenticated():
                self.json_response({"ok": False, "error": "authentication-required"}, status=401)
                return
            params = parse_qs(parsed.query)
            raw_path = (params.get("path") or [None])[0]
            self.json_response(directory_snapshot(raw_path))
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/client-directories.json":
            return super().do_POST()
        if not self.authenticated():
            self.json_response({"ok": False, "error": "authentication-required"}, status=401)
            self.close_connection = True
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16_384:
                raise ValueError
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.json_response({"ok": False, "error": "invalid-directory"}, status=400)
            return
        if not isinstance(payload, dict):
            self.json_response({"ok": False, "error": "invalid-directory"}, status=400)
            return
        status, value = create_child_directory(payload.get("parent"), payload.get("name"))
        self.json_response(value, status=status)

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
