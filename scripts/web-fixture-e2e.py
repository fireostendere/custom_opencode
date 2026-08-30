#!/usr/bin/env python3
"""Deterministic real-browser regression for the production web composition.

Runs the actual server_workflow.Handler and actual static UI against a tiny
in-process V2 fixture backend. No model inference, external network or user's
OpenCode state is touched.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class FixtureState:
    permission_pending = True


class Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def session(project: str) -> dict[str, object]:
        return {
            "id": "ses_fixture",
            "title": "Fixture session",
            "projectID": "proj_fixture",
            "agent": "build",
            "model": {"providerID": "bailian-cli", "id": "qwen3.8-max"},
            "location": {"directory": project},
            "time": {"created": 2_000_000_000_000, "updated": 2_000_000_000_000},
        }

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        project = os.environ["FIXTURE_PROJECT"]
        session = self.session(project)
        if path == "/api/project":
            self.send_json({"data": [{"id": "proj_fixture", "name": "Fixture", "canonical": project}]})
        elif path == "/api/session":
            self.send_json({"data": [session]})
        elif path == "/api/session/active" or path == "/api/session/status":
            self.send_json({"data": {}})
        elif path == "/api/session/ses_fixture":
            self.send_json({"data": session})
        elif path == "/api/session/ses_fixture/context":
            self.send_json({"data": [{
                "id": "msg_fixture",
                "type": "assistant",
                "role": "assistant",
                "text": "Fixture ready",
                "time": {"created": 2_000_000_000_000},
            }]})
        elif path == "/api/session/ses_fixture/message":
            self.send_json({"data": []})
        elif path == "/api/agent":
            self.send_json({"data": [
                {"id": "build", "name": "Build", "mode": "primary"},
                {"id": "plan", "name": "Plan", "mode": "primary"},
            ]})
        elif path == "/api/model":
            self.send_json({"data": [{
                "providerID": "bailian-cli",
                "id": "qwen3.8-max",
                "name": "Qwen3.8 Max",
                "enabled": True,
                "status": "active",
                "cost": [{"input": 0.1, "output": 0.1}],
                "capabilities": {"input": ["text"], "output": ["text"], "tools": True},
            }]})
        elif path == "/api/model/default":
            self.send_json({"data": {"providerID": "bailian-cli", "id": "qwen3.8-max"}})
        elif path == "/api/provider":
            self.send_json({"data": [{"id": "bailian-cli", "name": "Alibaba Cloud"}]})
        elif path in ("/api/permission/request", "/api/permission"):
            rows = []
            if FixtureState.permission_pending:
                rows.append({
                    "sessionID": "ses_fixture",
                    "requestID": "perm_fixture",
                    "action": "shell",
                    "resources": ["echo fixture"],
                    "metadata": {"command": "echo fixture"},
                })
            self.send_json({"data": rows})
        elif path == "/api/event":
            body = b'data: {"type":"server.connected"}\n\n'
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path in ("/api/vcs/status", "/api/file/status", "/api/vcs/diff", "/api/session/ses_fixture/diff", "/api/command"):
            self.send_json({"data": []})
        elif path == "/api/vcs":
            self.send_json({"data": {"branch": "main"}})
        elif path == "/api/mcp":
            self.send_json({"data": {"kb": {"status": "disabled"}}})
        else:
            self.send_json({"data": []})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(length)
        if "/permission/" in path or "/permissions/" in path:
            FixtureState.permission_pending = False
        self.send_json({"data": {"ok": True}})

    do_PATCH = do_POST
    do_DELETE = do_POST


def login(page, base_url: str) -> None:
    page.goto(base_url, wait_until="domcontentloaded")
    page.locator("#loginForm").wait_for(state="visible")
    page.fill("#username", "opencode")
    page.fill("#password", "fixture-password")
    page.click("#loginSubmit")
    page.locator("#sessions .session").first.wait_for(state="visible")


def open_session(page) -> None:
    menu = page.locator("#menu")
    if menu.is_visible():
        menu.click()
    page.locator("#sessions .session").first.click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_fixture')")
    page.locator("#messagesInner").wait_for(state="visible")


def desktop(browser, base_url: str) -> None:
    context = browser.new_context(viewport={"width": 1366, "height": 850})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"HTTP {response.status} {response.url}") if response.status >= 500 else None)
    login(page, base_url)
    open_session(page)

    page.wait_for_function("!document.querySelector('#modelButton').disabled")
    page.click("#modelButton")
    page.locator("#modelDialog[open]").wait_for(state="visible")
    assert page.locator("#modelChoices .choice").count() == 1
    assert "Qwen3.8 Max" in page.locator("#modelChoices").inner_text()
    page.locator("#modelDialog [data-close='modelDialog']").click()

    page.locator("#permissionBanner").wait_for(state="visible")
    summary = page.locator("#permissionSummary").inner_text()
    assert "echo fixture" in summary, summary
    page.locator("#permissionBanner [data-permission='once']").click()
    page.wait_for_function("document.querySelector('#permissionBanner').hidden")
    page.wait_for_timeout(2200)
    assert page.locator("#permissionBanner").is_hidden(), "permission banner reappeared after reply"

    page.fill("#input", "fixture text")
    page.wait_for_timeout(100)
    assert page.locator("#composerAction").is_enabled()
    assert page.locator("#composerAction").get_attribute("aria-label") in ("Отправить", "Добавить в очередь")
    page.fill("#input", "")

    page.click("#appearanceButton")
    page.locator("#appearanceDialog[open]").wait_for(state="visible")
    page.click('[data-theme-mode="dark"]')
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.evaluate("document.getElementById('appearanceDialog').close()")

    page.click("#logoutButton")
    page.locator("#loginForm").wait_for(state="visible")
    assert not errors, errors
    context.close()


def mobile(browser, base_url: str) -> None:
    FixtureState.permission_pending = True
    context = browser.new_context(
        viewport={"width": 412, "height": 915},
        is_mobile=True,
        has_touch=True,
        user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36",
    )
    page = context.new_page()
    login(page, base_url)
    page.click("#menu")
    assert page.locator("#sidebar").evaluate("el => el.classList.contains('open')")
    page.locator("#sessions .session").first.click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_fixture')")
    page.wait_for_timeout(250)
    assert not page.locator("#sidebar").evaluate("el => el.classList.contains('open')")

    page.locator("#permissionBanner").wait_for(state="visible")
    page.locator("#permissionBanner [data-permission='once']").click()
    page.wait_for_function("document.querySelector('#permissionBanner').hidden")
    page.wait_for_timeout(2200)
    assert page.locator("#permissionBanner").is_hidden()

    page.fill("#input", "mobile fixture")
    assert page.locator("#composerAction").is_visible()
    page.fill("#input", "")
    context.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        project = root / "project"
        project.mkdir()
        os.environ.update({
            "FIXTURE_PROJECT": str(project),
            "OPENCODE_SERVER_USERNAME": "opencode",
            "OPENCODE_SERVER_PASSWORD": "fixture-password",
            "OPENCODE_WEB_ALLOW_LOCAL": "0",
            "OPENCODE_AUTH_ALLOW_BASIC": "0",
            "OPENCODE_SCRATCH_DIRECTORY": str(root / "scratch"),
            "OPENCODE_PROJECT_ROOTS": str(project),
            "CUSTOM_OPENCODE_FEATURE_STATE": str(root / "features.json"),
            "CUSTOM_OPENCODE_RUNTIME_DB": str(root / "runtime.sqlite3"),
            "MCP_RAG_ENABLED": "0",
            "OPENCODE_RESOURCE_SCHEDULER": "off",
        })

        backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        backend_thread = threading.Thread(target=backend.serve_forever, daemon=True)
        backend_thread.start()
        backend_host, backend_port = backend.server_address[:2]
        os.environ["OPENCODE_BACKEND_URL"] = f"http://{backend_host}:{backend_port}"
        os.environ["OPENCODE_BACKEND_PASSWORD"] = "fixture-backend"

        sys.path.insert(0, str(ROOT / "app"))
        import server_workflow

        base = server_workflow.rag.plus.ext.base
        web = base.ThreadingHTTPServer(("127.0.0.1", 0), server_workflow.Handler)
        web_thread = threading.Thread(target=web.serve_forever, daemon=True)
        web_thread.start()
        web_host, web_port = web.server_address[:2]
        base_url = f"http://{web_host}:{web_port}"

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
                desktop(browser, base_url)
                mobile(browser, base_url)
                browser.close()
        finally:
            web.shutdown(); web.server_close(); web_thread.join(timeout=5)
            backend.shutdown(); backend.server_close(); backend_thread.join(timeout=5)

    print("Web fixture E2E passed: desktop + mobile + model picker + permission lifecycle + composer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
