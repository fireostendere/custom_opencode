#!/usr/bin/env python3
"""Web server extensions: provider rate-limit snapshot for the OpenCode web UI."""

from __future__ import annotations

import json
import re
import selectors
import shutil
import subprocess
import threading
import time
from urllib.parse import urlsplit

import server as base


QWEN_FIVE_HOUR_LIMIT = 12_000
QWEN_SEVEN_DAY_LIMIT = 40_000
QWEN_SUFFIX_RE = re.compile(r"\s·\sQwen\s+(OK|exhausted→([^·]+))\s*$")
try:
    LIMITS_CACHE_SECONDS = max(10.0, float(base.setting("OPENCODE_LIMITS_CACHE_SECONDS", "60") or "60"))
except ValueError:
    LIMITS_CACHE_SECONDS = 60.0

_codex_cache: dict[str, object] = {"at": 0.0, "value": None}
_codex_lock = threading.Lock()


def _rpc_write(process: subprocess.Popen[str], payload: dict[str, object]) -> None:
    if process.stdin is None:
        raise RuntimeError("Codex app-server stdin is unavailable")
    process.stdin.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _rpc_wait(process: subprocess.Popen[str], request_id: int, timeout: float) -> object:
    if process.stdout is None:
        raise RuntimeError("Codex app-server stdout is unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Codex app-server response timeout")
            events = selector.select(remaining)
            if not events:
                raise TimeoutError("Codex app-server response timeout")
            line = process.stdout.readline()
            if not line:
                code = process.poll()
                raise RuntimeError(f"Codex app-server exited before response ({code})")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("id") != request_id:
                continue
            if "error" in payload:
                error = payload.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise RuntimeError(str(message or "Codex app-server RPC failed"))
            return payload.get("result")
    finally:
        selector.close()


def _normalize_window(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    used = value.get("usedPercent")
    if not isinstance(used, (int, float)):
        return None
    used_percent = min(100, max(0, int(round(float(used)))))
    duration = value.get("windowDurationMins")
    reset_at = value.get("resetsAt")
    return {
        "usedPercent": used_percent,
        "remainingPercent": 100 - used_percent,
        "windowDurationMins": int(duration) if isinstance(duration, (int, float)) else None,
        "resetsAt": int(reset_at) if isinstance(reset_at, (int, float)) else None,
    }


def _normalize_codex_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict):
        return {"available": False, "reason": "invalid-response"}
    by_id = result.get("rateLimitsByLimitId")
    snapshot = None
    if isinstance(by_id, dict):
        snapshot = by_id.get("codex")
        if not isinstance(snapshot, dict) and by_id:
            snapshot = next((item for item in by_id.values() if isinstance(item, dict)), None)
    if not isinstance(snapshot, dict):
        candidate = result.get("rateLimits")
        snapshot = candidate if isinstance(candidate, dict) else None
    if not isinstance(snapshot, dict):
        return {"available": False, "reason": "no-rate-limit-snapshot"}
    return {
        "available": True,
        "planType": snapshot.get("planType"),
        "limitId": snapshot.get("limitId") or "codex",
        "limitName": snapshot.get("limitName") or "Codex",
        "primary": _normalize_window(snapshot.get("primary")),
        "secondary": _normalize_window(snapshot.get("secondary")),
        "credits": snapshot.get("credits") if isinstance(snapshot.get("credits"), dict) else None,
        "rateLimitReachedType": snapshot.get("rateLimitReachedType"),
        "spendControlReached": snapshot.get("spendControlReached"),
    }


def query_codex_rate_limits() -> dict[str, object]:
    with _codex_lock:
        now = time.monotonic()
        cached = _codex_cache.get("value")
        cached_at = float(_codex_cache.get("at") or 0.0)
        if isinstance(cached, dict) and now - cached_at < LIMITS_CACHE_SECONDS:
            return cached

        configured = base.setting("CODEX_BIN")
        codex = configured or shutil.which("codex")
        if not codex:
            home = base.Path.home()
            candidates = [
                home / ".local/bin/codex",
                home / ".npm-global/bin/codex",
                home / ".bun/bin/codex",
                home / "bin/codex",
            ]
            candidates.extend(sorted((home / ".nvm/versions/node").glob("*/bin/codex"), reverse=True))
            codex = next((str(path) for path in candidates if path.is_file()), None)
        if not codex:
            value = {"available": False, "reason": "codex-not-found"}
            _codex_cache.update(at=now, value=value)
            return value

        process: subprocess.Popen[str] | None = None
        try:
            process = subprocess.Popen(
                [codex, "app-server"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            _rpc_write(process, {
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "custom_opencode_web",
                        "title": "custom_opencode web limits",
                        "version": "1",
                    }
                },
            })
            _rpc_wait(process, 1, 5.0)
            _rpc_write(process, {"method": "initialized", "params": {}})
            _rpc_write(process, {"method": "account/rateLimits/read", "id": 2, "params": {}})
            value = _normalize_codex_result(_rpc_wait(process, 2, 10.0))
        except (OSError, RuntimeError, TimeoutError):
            value = {"available": False, "reason": "codex-rate-limits-unavailable"}
        finally:
            if process is not None:
                try:
                    process.terminate()
                    process.wait(timeout=1.0)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        process.kill()
                    except OSError:
                        pass

        _codex_cache.update(at=now, value=value)
        return value


def query_qwen_status() -> dict[str, object]:
    payload = base.backend_json("GET", "/api/session?limit=100&order=desc")
    sessions: list[object]
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        sessions = payload["data"]
    elif isinstance(payload, list):
        sessions = payload
    else:
        sessions = []

    state = "unknown"
    reset_at = None
    for session in sessions:
        if not isinstance(session, dict):
            continue
        title = session.get("title")
        if not isinstance(title, str):
            continue
        match = QWEN_SUFFIX_RE.search(title)
        if not match:
            continue
        if match.group(1) == "OK":
            state = "ok"
        else:
            state = "exhausted"
            reset_at = (match.group(2) or "").strip() or None
        break

    return {
        "available": state != "unknown",
        "state": state,
        "resetAt": reset_at,
        "fiveHour": {"limit": QWEN_FIVE_HOUR_LIMIT, "windowDurationMins": 300},
        "sevenDay": {"limit": QWEN_SEVEN_DAY_LIMIT, "windowDurationMins": 10_080},
        "remainingPercent": None,
    }


def limits_snapshot() -> dict[str, object]:
    return {
        "generatedAt": int(time.time()),
        "qwen": query_qwen_status(),
        "openai": query_codex_rate_limits(),
    }


class Handler(base.Handler):
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/client-limits.json":
            if not self.authenticated():
                return
            self.json_response(limits_snapshot())
            return
        super().do_GET()


def main() -> None:
    base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = base.ThreadingHTTPServer((base.WEB_HOST, base.WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
