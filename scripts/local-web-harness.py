#!/usr/bin/env python3
"""Self-contained localhost harness for the production OpenCode web server.

Modes:
  serve  Start the real production web handler against an in-process fake
         OpenCode backend and keep it available for manual browser testing.
  test   Start the same isolated stack, run scripts/browser-smoke.py against
         it, then shut everything down.

The harness never uses the user's .env, OpenCode state, providers, RAG data,
or model inference. All writable state lives in a TemporaryDirectory and both
HTTP servers bind to 127.0.0.1 on ephemeral ports.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import ModuleType
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fixture = load_module("custom_opencode_web_fixture", SCRIPTS / "web-fixture-e2e.py")


class BrowserBackend(fixture.Backend):
    """Fixture backend shaped for the generic browser-smoke expectations."""

    model_delay_seconds = 0.0

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/api/session/") and path.endswith("/message") and path != "/api/session/ses_fixture/message":
            session_id = path.split("/")[3]
            self.send_json({
                "data": [{
                    "info": {
                        "id": f"{session_id}_assistant",
                        "role": "assistant",
                        "time": {"created": 2_000_000_000_500},
                    },
                    "parts": [{"type": "text", "text": f"Fixture message for {session_id}"}],
                }],
                "cursor": {"next": None},
            })
            return
        if path == "/api/model":
            time.sleep(self.model_delay_seconds)
            models = []
            for index in range(36):
                models.append({
                    "providerID": "bailian-cli",
                    "id": f"qwen-fixture-{index:02d}",
                    "name": f"Qwen Fixture {index:02d}",
                    "enabled": True,
                    "status": "active",
                    "cost": [{"input": 0.1, "output": 0.1}],
                    "capabilities": {"input": ["text"], "output": ["text"], "tools": True},
                })
            self.send_json({"data": models})
            return
        if path == "/api/model/default":
            self.send_json({"data": {"providerID": "bailian-cli", "id": "qwen-fixture-00"}})
            return
        if path == "/api/provider":
            self.send_json({"data": [{"id": "bailian-cli", "name": "Alibaba Cloud Fixture"}]})
            return
        super().do_GET()


@contextmanager
def isolated_environment(root: Path):
    project = root / "project"
    project.mkdir()
    existing = project / "existing"
    existing.mkdir()
    other_project = project / "other-known"
    other_project.mkdir()
    scratch = root / "scratch"
    scratch.mkdir()

    (root / "ses_fixture-plan.md").write_text(
        "# Fixture plan\n" + "\n".join(f"- [ ] Fixture step {index:02d}" for index in range(48)),
        encoding="utf-8",
    )
    (root / "ses_other-plan.md").write_text(
        "# Other root plan\n\n- [ ] Other isolated step\n",
        encoding="utf-8",
    )

    values = {
        "FIXTURE_PROJECT": str(project),
        "FIXTURE_EXISTING_PROJECT": str(existing),
        "FIXTURE_OTHER_PROJECT": str(other_project),
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": "fixture-password",
        "OPENCODE_WEB_ALLOW_LOCAL": "0",
        "OPENCODE_AUTH_ALLOW_BASIC": "0",
        "OPENCODE_SCRATCH_DIRECTORY": str(scratch),
        "OPENCODE_PROJECT_ROOTS": str(project),
        "CUSTOM_OPENCODE_FEATURE_STATE": str(root / "features.json"),
        "CUSTOM_OPENCODE_RUNTIME_DB": str(root / "runtime.sqlite3"),
        "MCP_RAG_ENABLED": "0",
        "OPENCODE_RESOURCE_SCHEDULER": "off",
    }
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class LocalStack:
    def __init__(self, root: Path):
        self.root = root
        self.backend: ThreadingHTTPServer | None = None
        self.backend_thread: threading.Thread | None = None
        self.server: ThreadingHTTPServer | None = None
        self.server_thread: threading.Thread | None = None
        self.base_url = ""
        self._previous_backend_url = os.environ.get("OPENCODE_BACKEND_URL")
        self._previous_backend_password = os.environ.get("OPENCODE_BACKEND_PASSWORD")

    def start(self) -> str:
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), BrowserBackend)
        self.backend_thread = threading.Thread(target=self.backend.serve_forever, daemon=True)
        self.backend_thread.start()
        backend_host, backend_port = self.backend.server_address[:2]
        os.environ["OPENCODE_BACKEND_URL"] = f"http://{backend_host}:{backend_port}"
        os.environ["OPENCODE_BACKEND_PASSWORD"] = "fixture-backend"

        app_path = str(ROOT / "app")
        if app_path not in sys.path:
            sys.path.insert(0, app_path)
        import server_workflow

        server_workflow.runtime.PLAN_DIRECTORY = self.root
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), server_workflow.Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        host, port = self.server.server_address[:2]
        self.base_url = f"http://{host}:{port}"
        return self.base_url

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.backend is not None:
            self.backend.shutdown()
            self.backend.server_close()
        if self.server_thread is not None:
            self.server_thread.join(timeout=2)
        if self.backend_thread is not None:
            self.backend_thread.join(timeout=2)
        if self._previous_backend_url is None:
            os.environ.pop("OPENCODE_BACKEND_URL", None)
        else:
            os.environ["OPENCODE_BACKEND_URL"] = self._previous_backend_url
        if self._previous_backend_password is None:
            os.environ.pop("OPENCODE_BACKEND_PASSWORD", None)
        else:
            os.environ["OPENCODE_BACKEND_PASSWORD"] = self._previous_backend_password


def reset_fixture_state() -> None:
    state = fixture.FixtureState
    state.permission_pending = True
    state.form_pending = True
    state.form_reply = None
    state.form_cancelled = False
    state.form_reply_delay = False
    state.question_pending = True
    state.question_reply = None
    state.question_rejected = False
    state.question_event_sent = False
    state.session_reads = 0
    state.context_reads = 0
    state.message_requests = []
    state.message_order = "desc"
    state.managed_sends = []
    state.managed_failures = 0
    state.session_running = False
    state.queued_prompt_event.clear()
    state.session_payloads = []
    state.created_sessions = {}


def run_browser_smoke(base_url: str) -> int:
    smoke = load_module("custom_opencode_browser_smoke", SCRIPTS / "browser-smoke.py")
    smoke.USERNAME = "opencode"
    smoke.PASSWORD = "fixture-password"
    smoke.LAN_URL = base_url
    smoke.TS_URL = base_url
    smoke.RESULTS.clear()
    smoke.PROBLEMS.clear()
    return int(smoke.main())


def serve() -> int:
    with tempfile.TemporaryDirectory(prefix="custom-opencode-web-") as temp:
        root = Path(temp)
        with isolated_environment(root):
            reset_fixture_state()
            stack = LocalStack(root)
            base_url = stack.start()
            print("Local OpenCode web harness is running.", flush=True)
            print(f"URL:      {base_url}", flush=True)
            print("Username: opencode", flush=True)
            print("Password: fixture-password", flush=True)
            print("Backend and state are isolated; Ctrl+C stops the harness.", flush=True)
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                print("\nStopping local web harness...", flush=True)
            finally:
                stack.stop()
    return 0


def test() -> int:
    with tempfile.TemporaryDirectory(prefix="custom-opencode-web-test-") as temp:
        root = Path(temp)
        with isolated_environment(root):
            reset_fixture_state()
            stack = LocalStack(root)
            base_url = stack.start()
            print(f"Local web test stack: {base_url}", flush=True)
            try:
                result = run_browser_smoke(base_url)
            finally:
                stack.stop()
            if result == 0:
                print("Local browser smoke passed against isolated production web server.", flush=True)
            return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("serve", "test"), help="manual server or automatic browser smoke")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return serve() if args.mode == "serve" else test()


if __name__ == "__main__":
    raise SystemExit(main())
