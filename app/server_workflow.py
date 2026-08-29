#!/usr/bin/env python3
"""Production web entrypoint composing RAG and advanced workflow features."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path
import shutil
import subprocess
from urllib.parse import quote, urlsplit

import server_features as features
import server_rag as rag


_ORIGINAL_SEND = features._send_backend_prompt
_ORIGINAL_PROCESS_NAMES = features._process_names
_ORIGINAL_GPU_LOAD = features._gpu_load


def _windows_process_names() -> set[str]:
    """Best-effort Windows host process discovery when running under WSL."""
    names: set[str] = set()
    candidates = [
        shutil.which("powershell.exe"),
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ]
    powershell = next((value for value in candidates if value and Path(value).exists()), None)
    if powershell:
        try:
            proc = subprocess.run(
                [powershell, "-NoProfile", "-NonInteractive", "-Command", "Get-Process | Select-Object -ExpandProperty ProcessName"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2.5,
                check=False,
            )
            if proc.returncode == 0:
                names.update(line.strip().lower() for line in proc.stdout.splitlines() if line.strip())
        except (OSError, subprocess.TimeoutExpired):
            pass
    tasklist = shutil.which("tasklist.exe") or "/mnt/c/Windows/System32/tasklist.exe"
    if Path(tasklist).exists():
        try:
            proc = subprocess.run(
                [tasklist, "/FO", "CSV", "/NH"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2.5,
                check=False,
            )
            if proc.returncode == 0:
                for row in csv.reader(io.StringIO(proc.stdout)):
                    if row and row[0]:
                        name = row[0].strip().lower()
                        names.add(name)
                        if name.endswith(".exe"):
                            names.add(name[:-4])
        except (OSError, subprocess.TimeoutExpired, csv.Error):
            pass
    return names


def _process_names_cross_platform() -> set[str]:
    names = set(_ORIGINAL_PROCESS_NAMES())
    names.update(_windows_process_names())
    return names


def _gpu_load_cross_platform() -> tuple[int | None, str | None]:
    # AMD exposes this cheaply on Linux/WSL kernels with amdgpu. Prefer it over
    # spawning ROCm tools because it works for consumer Radeon cards too.
    values: list[int] = []
    for path in Path("/sys/class/drm").glob("card*/device/gpu_busy_percent"):
        try:
            value = int(path.read_text(encoding="utf-8").strip())
            if 0 <= value <= 100:
                values.append(value)
        except (OSError, ValueError):
            continue
    if values:
        return max(values), "sysfs-amdgpu"

    # ROCm JSON commonly reports `GPU use (%)` as a quoted number without a `%`
    # suffix, which the generic text parser cannot reliably detect.
    rocm = shutil.which("rocm-smi")
    if rocm:
        try:
            proc = subprocess.run(
                [rocm, "--showuse", "--json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2.5,
                check=False,
            )
            if proc.returncode == 0:
                payload = json.loads(proc.stdout)
                found: list[int] = []
                stack = [payload]
                while stack:
                    node = stack.pop()
                    if isinstance(node, dict):
                        for key, value in node.items():
                            if isinstance(value, (dict, list)):
                                stack.append(value)
                            elif "gpu use" in str(key).lower() or "gpu busy" in str(key).lower():
                                try:
                                    number = int(float(str(value).strip().rstrip("%")))
                                except ValueError:
                                    continue
                                if 0 <= number <= 100:
                                    found.append(number)
                    elif isinstance(node, list):
                        stack.extend(node)
                if found:
                    return max(found), "rocm-smi"
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            pass
    return _ORIGINAL_GPU_LOAD()


features._process_names = _process_names_cross_platform
features._gpu_load = _gpu_load_cross_platform


def _file_parts(files: list[object]) -> list[dict[str, object]]:
    parts: list[dict[str, object]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        url = item.get("uri") or item.get("url")
        if not isinstance(url, str) or not url:
            continue
        part: dict[str, object] = {"type": "file", "url": url}
        if item.get("name"):
            part["filename"] = str(item["name"])
        if item.get("mime"):
            part["mime"] = str(item["mime"])
        parts.append(part)
    return parts


def _send_with_project_context(session_id: str, text: str, files: list[object]) -> object:
    """Prefer the async message API so project instructions remain system-only."""
    directory = features._session_directory(session_id)
    settings = features.project_settings(directory)
    instructions = str(settings.get("instructions") or "").strip()
    target = f"/api/session/{quote(session_id, safe='')}/prompt_async"
    parts: list[dict[str, object]] = []
    if text:
        parts.append({"type": "text", "text": text})
    parts.extend(_file_parts(files))
    payload: dict[str, object] = {"parts": parts}
    if instructions:
        payload["system"] = (
            "Project-specific persistent instructions configured by the user for this workspace. "
            "Treat them as project policy unless they conflict with higher-priority instructions.\n\n"
            + instructions
        )
    try:
        return features._backend_request_json("POST", target, payload, timeout=30.0)
    except features.BackendHTTPError as exc:
        if exc.status not in (400, 404, 405, 422):
            raise
    # Compatibility fallback for the repository's pinned V2 build. This path
    # still preserves queue delivery even if the newer `system` field is not available.
    return _ORIGINAL_SEND(session_id, text, files)


features._send_backend_prompt = _send_with_project_context


class Handler(rag.Handler, features.Handler):
    """RAG routes first, then persistent workflow routes, then the base proxy."""

    def json_response(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-send.json":
            if not self.authenticated():
                return
            try:
                payload = self._feature_body()
                session_id = str(payload.get("sessionID") or "")
                if not session_id or len(session_id) > 256:
                    raise ValueError("invalid session id")
                text = str(payload.get("text") or "")
                files = payload.get("files") if isinstance(payload.get("files"), list) else []
                if not text.strip() and not files:
                    raise ValueError("empty message")
                profile = str(payload.get("profile") or "direct")
                route = None
                if profile == "auto":
                    route = features.auto_route(session_id, apply=True)
                result = _send_with_project_context(session_id, text, files)
                self.json_response({"ok": True, "route": route, "result": result})
            except Exception as exc:
                self._feature_error(exc)
            return
        super().do_POST()


def main() -> None:
    rag.plus.ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = rag.plus.ext.base.ThreadingHTTPServer((rag.plus.ext.base.WEB_HOST, rag.plus.ext.base.WEB_PORT), Handler)
    features._ensure_worker()
    print(f"OpenCode web client started on configured port {rag.plus.ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
