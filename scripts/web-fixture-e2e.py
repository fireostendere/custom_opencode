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
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class FixtureState:
    permission_pending = True
    form_pending = True
    form_reply: dict[str, object] | None = None
    form_cancelled = False
    form_reply_delay = False
    question_pending = True
    question_reply: dict[str, object] | None = None
    question_rejected = False
    question_event_sent = False
    session_reads = 0
    context_reads = 0
    managed_sends: list[dict[str, object]] = []
    managed_failures = 0
    session_running = False


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
            if "limit=100" in parsed.query:
                FixtureState.session_reads += 1
            self.send_json({"data": [session]})
        elif path == "/api/session/active" or path == "/api/session/status":
            statuses = {"ses_fixture": {"type": "busy"}} if FixtureState.session_running else {}
            self.send_json({"data": statuses})
        elif path == "/api/session/ses_fixture":
            self.send_json({"data": session})
        elif path == "/api/session/ses_fixture/context":
            FixtureState.context_reads += 1
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
        elif path == "/api/form/request":
            rows = []
            if FixtureState.form_pending:
                rows.append({
                    "id": "frm_fixture",
                    "sessionID": "ses_fixture",
                    "title": "Среда fixture",
                    "fields": [{
                        "key": "environment",
                        "title": "Среда",
                        "description": "Как продолжить fixture?",
                        "type": "string",
                        "required": True,
                        "custom": True,
                        "options": [{"value": "fixture", "label": "Использовать fixture", "description": "Проверка native form reply"}],
                    }],
                })
            self.send_json({"location": {"directory": project}, "data": rows})
        elif path == "/api/question":
            rows = []
            if FixtureState.question_pending:
                rows.append({
                    "sessionID": "ses_fixture",
                    "requestID": "question_fixture",
                    "questions": [{
                        "header": "Среда",
                        "question": "Как продолжить fixture?",
                        "multiple": False,
                        "options": [{"label": "Использовать fixture", "description": "Проверка native question reply"}],
                    }],
                })
            self.send_json({"data": rows})
        elif path == "/api/event":
            if not FixtureState.question_event_sent:
                FixtureState.question_event_sent = True
                event = {
                    "type": "question.asked",
                    "properties": {
                        "sessionID": "ses_fixture",
                        "requestID": "question_fixture",
                        "questions": [{
                            "header": "Среда",
                            "question": "Как продолжить fixture?",
                            "multiple": False,
                            "options": [{"label": "Использовать fixture", "description": "Проверка native question event"}],
                        }],
                    },
                }
            else:
                event = {"type": "server.connected"}
            body = f"data: {json.dumps(event)}\n\n".encode()
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
        payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        if "/permission/" in path or "/permissions/" in path:
            FixtureState.permission_pending = False
        if path.startswith("/api/session/ses_fixture/form/") and path.endswith("/reply"):
            if FixtureState.form_reply_delay:
                time.sleep(0.35)
                FixtureState.form_reply_delay = False
            FixtureState.form_pending = False
            FixtureState.form_reply = payload
        elif path.startswith("/api/session/ses_fixture/form/") and path.endswith("/cancel"):
            FixtureState.form_pending = False
            FixtureState.form_cancelled = True
        elif path == "/api/question/question_fixture/reply":
            FixtureState.question_pending = False
            FixtureState.question_reply = payload
        elif path.startswith("/api/question/") and path.endswith("/reject"):
            FixtureState.question_pending = False
            FixtureState.question_rejected = True
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


def pull_messages(page, cdp, distance: int, hold_ms: int) -> None:
    box = page.locator("#messages").bounding_box()
    assert box
    x = round(box["x"] + box["width"] / 2)
    start_y = round(box["y"] + box["height"] / 2)
    end_y = start_y + distance
    point = lambda y: {"x": x, "y": y, "id": 1, "radiusX": 2, "radiusY": 2, "force": 1}
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(end_y)]})
    page.wait_for_timeout(hold_ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def desktop(browser, base_url: str) -> None:
    FixtureState.managed_sends = []
    FixtureState.managed_failures = 0
    FixtureState.session_running = False
    context = browser.new_context(viewport={"width": 1366, "height": 850})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"HTTP {response.status} {response.url}") if response.status >= 500 else None)
    login(page, base_url)
    open_session(page)

    page.locator("#questionHost .question-card").wait_for(state="visible")
    page.locator('[data-question-option="0:0"]').click()
    page.click("[data-question-submit]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")
    assert FixtureState.form_reply == {"answer": {"environment": "fixture"}}

    page.evaluate("""() => window.dispatchEvent(new CustomEvent('custom-opencode:event', {detail: {
        type: 'form.asked',
        properties: {
            sessionID: 'ses_fixture',
            formID: 'frm_event_fixture',
            title: 'Событие формы',
            fields: [
                {key: 'ratio', title: 'Коэффициент', type: 'number', required: true},
                {key: 'count', title: 'Количество', type: 'integer', required: true},
                {key: 'enabled', title: 'Включить', type: 'boolean', required: true},
            ],
        },
    }}))""")
    page.locator("#questionHost .question-card").wait_for(state="visible")
    page.locator('[data-question-custom="0"]').fill("2.5")
    page.locator('[data-question-custom="1"]').fill("3")
    page.locator('[data-question-boolean="2"]').select_option("false")
    FixtureState.form_reply_delay = True
    page.click("[data-question-submit]")
    page.evaluate("""() => window.dispatchEvent(new CustomEvent('custom-opencode:event', {detail: {
        type: 'form.asked',
        properties: {
            sessionID: 'ses_fixture',
            formID: 'frm_late_fixture',
            title: 'Поздняя форма',
            fields: [{key: 'late_value', title: 'Новое значение', type: 'string', required: true}],
        },
    }}))""")
    page.locator("#questionHost .question-title").wait_for(state="visible")
    page.wait_for_timeout(700)
    assert "Поздняя форма" in page.locator("#questionHost .question-title").inner_text()
    page.evaluate("""() => window.dispatchEvent(new CustomEvent('custom-opencode:event', {detail: {
        type: 'form.cancelled',
        properties: {sessionID: 'ses_fixture', formID: 'frm_late_fixture'},
    }}))""")
    page.wait_for_function("document.querySelector('#questionHost').hidden")

    page.evaluate("""() => window.dispatchEvent(new CustomEvent('custom-opencode:event', {detail: {
        type: 'question.asked',
        properties: {
            sessionID: 'ses_fixture',
            requestID: 'question_event_fixture',
            questions: [{header: 'Событие', question: 'Проверить event flow?', multiple: false, options: [{label: 'Да', description: ''}] }],
        },
    }}))""")
    page.locator("#questionHost .question-card").wait_for(state="visible")
    page.click("[data-question-reject]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")
    assert FixtureState.question_rejected

    page.wait_for_function("!document.querySelector('#modelButton').disabled")
    page.click("#modelButton")
    page.locator("#modelDialog[open]").wait_for(state="visible")
    assert page.locator("#modelChoices .choice").count() == 1
    assert "Qwen3.8 Max" in page.locator("#modelChoices").inner_text()
    page.locator("#modelDialog [data-close='modelDialog']").click()

    control_order = page.locator(".controls").evaluate("el => [...el.children].map(child => child.id || child.querySelector('#variantSelect')?.id)")
    assert control_order == ["modelButton", "variantSelect", "agentControls"], control_order
    assert page.locator("#agentControls").is_visible()
    assert page.locator("#agentControls [data-agent='build']").is_visible()
    assert page.locator("#agentControls [data-agent='plan']").is_visible()
    page.locator("#agentControls [data-agent='plan']").click()
    page.locator("#agentControls [data-agent='plan'].active").wait_for()
    page.locator("#agentControls [data-agent='build']").click()
    page.locator("#agentControls [data-agent='build'].active").wait_for()

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

    FixtureState.managed_failures = 1
    page.fill("#input", "send exactly once")
    page.click("#composerAction")
    page.wait_for_function("document.querySelector('#input').value === 'send exactly once'")
    page.wait_for_function("document.querySelector('#composerAction').getAttribute('aria-label') === 'Отправить'")
    assert len(FixtureState.managed_sends) == 1

    page.evaluate("""() => {
        const button = document.querySelector('#composerAction')
        button.click(); button.click(); button.click()
    }""")
    page.wait_for_function("document.querySelector('#input').value === '' && !document.querySelector('#stop').hidden")
    page.wait_for_timeout(200)
    assert len(FixtureState.managed_sends) == 2, FixtureState.managed_sends
    assert [payload.get("text") for payload in FixtureState.managed_sends] == ["send exactly once", "send exactly once"]

    page.click("#refresh")
    page.wait_for_function("!document.querySelector('#stop').hidden")
    page.fill("#input", "queue exactly once")
    page.wait_for_function("document.querySelector('#composerAction').getAttribute('aria-label') === 'Отправить в очередь'")
    page.evaluate("""() => {
        const button = document.querySelector('#composerAction')
        button.click(); button.click(); button.click()
    }""")
    page.locator('[data-session-drag="ses_fixture"] .queued').wait_for()
    assert page.locator('[data-session-drag="ses_fixture"] .queued').inner_text() == "очередь 1"
    assert len(FixtureState.managed_sends) == 2

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
    FixtureState.session_running = False
    FixtureState.permission_pending = True
    FixtureState.form_pending = True
    FixtureState.form_reply = None
    FixtureState.form_cancelled = False
    FixtureState.form_reply_delay = False
    FixtureState.question_pending = True
    FixtureState.question_reply = None
    FixtureState.question_rejected = False
    FixtureState.question_event_sent = False
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

    page.locator("#questionHost .question-card").wait_for(state="visible")
    page.click("[data-question-reject]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")
    assert FixtureState.form_cancelled

    page.locator("#permissionBanner").wait_for(state="visible")
    page.locator("#permissionBanner [data-permission='once']").click()
    page.wait_for_function("document.querySelector('#permissionBanner').hidden")
    page.wait_for_timeout(2200)
    assert page.locator("#permissionBanner").is_hidden()

    page.fill("#input", "mobile fixture")
    assert page.locator("#composerAction").is_visible()
    page.fill("#input", "")

    cdp = context.new_cdp_session(page)
    messages = page.locator("#messages")
    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh hint is visible without a gesture"
    reads = (FixtureState.session_reads, FixtureState.context_reads)
    pull_messages(page, cdp, 104, 720)
    assert (FixtureState.session_reads, FixtureState.context_reads) == reads, "downward pull refreshed session data"
    assert page.locator(".pull-refresh").is_hidden()

    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    pull_messages(page, cdp, -8, 720)
    assert (FixtureState.session_reads, FixtureState.context_reads) == reads, "short pull refreshed session data"
    assert page.locator(".pull-refresh").is_hidden()

    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    pull_messages(page, cdp, -44, 180)
    page.wait_for_timeout(700)
    assert (FixtureState.session_reads, FixtureState.context_reads) == reads, "early release refreshed session data"
    assert page.locator(".pull-refresh").is_hidden()

    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    box = page.locator("#messages").bounding_box()
    assert box
    x = round(box["x"] + box["width"] / 2)
    start_y = round(box["y"] + box["height"] / 2)
    point = lambda y: {"x": x, "y": y, "id": 1, "radiusX": 2, "radiusY": 2, "force": 1}
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y - 44)]})
    assert page.locator(".pull-refresh").get_attribute("data-state") == "holding"
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y - 4)]})
    page.wait_for_timeout(700)
    assert page.locator(".pull-refresh").is_hidden(), "reversed pull kept holding"
    assert (FixtureState.session_reads, FixtureState.context_reads) == reads, "reversed pull refreshed session data"
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y - 16)]})
    pull_state = page.locator(".pull-refresh").get_attribute("data-state")
    assert pull_state == "pulling", f"expected pulling state, got {pull_state!r}"
    assert page.locator(".pull-refresh-label").inner_text() == "Тяните вверх для обновления"
    assert page.locator(".pull-refresh-icon").evaluate("el => getComputedStyle(el).animationName") == "pull-refresh-pull"
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y - 44)]})
    assert page.locator(".pull-refresh").get_attribute("data-state") == "holding"
    assert page.locator(".pull-refresh-label").inner_text() == "Удерживайте для обновления"
    progress_before = float(page.locator(".pull-refresh").evaluate("el => getComputedStyle(el).getPropertyValue('--pull-progress')"))
    page.wait_for_timeout(180)
    progress_after = float(page.locator(".pull-refresh").evaluate("el => getComputedStyle(el).getPropertyValue('--pull-progress')"))
    assert progress_after > progress_before, "hold progress did not animate"
    page.wait_for_function("document.querySelector('.pull-refresh')?.dataset.state === 'refreshing'")
    assert page.locator(".pull-refresh-icon").evaluate("el => getComputedStyle(el).animationName") == "pull-refresh-spin"
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and not (FixtureState.session_reads > reads[0] and FixtureState.context_reads > reads[1]):
        page.wait_for_timeout(20)
    assert FixtureState.session_reads > reads[0] and FixtureState.context_reads > reads[1]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(500)
    assert page.locator(".pull-refresh").get_attribute("data-state") == "done"
    assert page.locator(".pull-refresh svg").count() == 1
    page.wait_for_timeout(600)
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh result did not dismiss"
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

        def fixture_dispatch(_features, *, session_id: str, text: str, files: list[object], profile: str) -> dict[str, object]:
            FixtureState.managed_sends.append({"sessionID": session_id, "text": text, "files": files, "profile": profile})
            if FixtureState.managed_failures:
                FixtureState.managed_failures -= 1
                raise ValueError("fixture send failed")
            FixtureState.session_running = True
            return {"task": {"id": f"task_fixture_{len(FixtureState.managed_sends)}"}}

        server_workflow.runtime.dispatch_immediate = fixture_dispatch

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

    print("Web fixture E2E passed: desktop + mobile + native forms/questions + model picker + permission lifecycle + composer + pull refresh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
