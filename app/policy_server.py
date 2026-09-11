#!/usr/bin/env python3
"""Private authenticated policy listener, independent of the optional web UI.

The installer supplies the launcher/environment. `ensure` starts a supervised
local process only when its authenticated health probe fails; it never retries
model or tool operations. This server deliberately does not expose web routes.
"""
from __future__ import annotations
import argparse
import contextlib
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def token() -> str:
    value = (
        os.environ.get("OPENCODE_RUNTIME_PLUGIN_TOKEN")
        or os.environ.get("OPENCODE_SERVER_PASSWORD")
        or ""
    )
    if not value or value == "CHANGE_ME":
        raise RuntimeError("Private policy token is not configured")
    return value


def port() -> int:
    value = int(os.environ.get("OPENCODE_POLICY_PORT", "4099"))
    if not 1024 <= value <= 65535:
        raise ValueError("OPENCODE_POLICY_PORT must be 1024..65535")
    return value


def health() -> bool:
    request = Request(
        f"http://127.0.0.1:{port()}/internal/runtime/health",
        headers={"X-OpenCode-Runtime": token()},
    )
    try:
        with urlopen(request, timeout=0.8) as response:
            result = json.load(response)
        return (
            result.get("service") == "custom-opencode-private-policy" and result.get("ok") is True
        )
    except HTTPError as error:
        # Never start a replacement on a port occupied by a different principal.
        if error.code in (401, 403):
            raise RuntimeError(
                "Private policy port has an incompatible token; stop/reconfigure the old service"
            ) from error
        return False
    except (OSError, ValueError):
        return False


def state_dir() -> Path:
    root = (
        Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
        / "custom-opencode-policy"
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def ensure() -> None:
    if health():
        return
    lockpath = state_dir() / f"start-{port()}.lock"
    fd = os.open(lockpath, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if health():
            return
        logfd = os.open(
            state_dir() / f"policy-{port()}.log",
            os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        try:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "serve"],
                stdin=subprocess.DEVNULL,
                stdout=logfd,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            os.close(logfd)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if health():
                return
            if process.poll() is not None:
                raise RuntimeError(
                    f"Private policy startup failed ({process.returncode}); see {state_dir()}"
                )
            time.sleep(0.1)
        process.terminate()
        raise TimeoutError("Private policy health did not become ready; no model request was sent")
    finally:
        os.close(fd)


def serve() -> None:
    token()
    # Compose exactly the same policies as production; only worker leadership,
    # not import order, is allowed to trigger recovery of persisted tasks.
    import server_workflow as production
    from runtime_v3 import _internal_auth, handle_post

    runtime, features = production.runtime, production.features

    class Handler(BaseHTTPRequestHandler):
        server_version = "OpenCodePrivatePolicy/1"

        def log_message(self, fmt, *args):
            # Paths/status only; request bodies and credentials are never logged.
            sys.stderr.write((fmt % args) + "\n")

        def json_response(self, value, status=200):
            data = json.dumps(value, ensure_ascii=False, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _feature_error(self, error):
            self.json_response(
                {"ok": False, "error": f"{type(error).__name__}: {error}"[:1000]},
                (
                    403
                    if isinstance(error, PermissionError)
                    else 400 if isinstance(error, ValueError) else 503
                ),
            )

        def do_GET(self):
            if not _internal_auth(self):
                return self.json_response({"ok": False, "error": "forbidden"}, 403)
            if self.path != "/internal/runtime/health":
                return self.json_response({"ok": False, "error": "not found"}, 404)
            self.json_response(
                {
                    "ok": True,
                    "service": "custom-opencode-private-policy",
                    "pid": os.getpid(),
                    "webListenerRequired": False,
                }
            )

        def do_POST(self):
            parsed = urlsplit(self.path)
            if not parsed.path.startswith("/internal/runtime/"):
                return self.json_response({"ok": False, "error": "not found"}, 404)
            if not handle_post(self, parsed, runtime, features):
                self.json_response({"ok": False, "error": "not found"}, 404)

    httpd = ThreadingHTTPServer(("127.0.0.1", port()), Handler)
    httpd.daemon_threads = True
    # Holding this lock avoids stale PID files and two private processes.
    fd = os.open(
        state_dir() / f"server-{port()}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    (state_dir() / f"pid-{port()}").write_text(str(os.getpid()))
    features._ensure_worker()

    def shutdown(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        features._stop_worker()
        with contextlib.suppress(FileNotFoundError):
            (state_dir() / f"pid-{port()}").unlink()
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("ensure", "serve", "status", "stop"))
    action = parser.parse_args().action
    if action == "ensure":
        ensure()
    elif action == "serve":
        serve()
    elif action == "status":
        print(json.dumps({"ok": health(), "port": port(), "webListenerRequired": False}))
    else:
        # Authenticate the running process and obtain its PID from health, not
        # a stale or user-modifiable PID file before sending a signal.
        request = Request(
            f"http://127.0.0.1:{port()}/internal/runtime/health",
            headers={"X-OpenCode-Runtime": token()},
        )
        with urlopen(request, timeout=1) as response:
            info = json.load(response)
        if info.get("service") != "custom-opencode-private-policy":
            raise RuntimeError("Unexpected policy listener")
        os.kill(int(info["pid"]), signal.SIGTERM)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
