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
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class FixtureState:
    lock = threading.RLock()
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
    message_requests: list[dict[str, list[str]]] = []
    message_order = "desc"
    managed_sends: list[dict[str, object]] = []
    managed_failures = 0
    session_running = False
    queued_prompt_event = threading.Event()
    session_payloads: list[dict[str, object]] = []
    created_sessions: dict[str, dict[str, object]] = {}

    @classmethod
    def reset(cls) -> None:
        """Restore every mutable fixture value between browser scenarios."""
        with cls.lock:
            cls.permission_pending = True
            cls.form_pending = True
            cls.form_reply = None
            cls.form_cancelled = False
            cls.form_reply_delay = False
            cls.question_pending = True
            cls.question_reply = None
            cls.question_rejected = False
            cls.question_event_sent = False
            cls.session_reads = 0
            cls.context_reads = 0
            cls.message_requests = []
            cls.message_order = "desc"
            cls.managed_sends = []
            cls.managed_failures = 0
            cls.session_running = False
            cls.queued_prompt_event.clear()
            cls.session_payloads = []
            cls.created_sessions = {}

    @classmethod
    def session_payload_snapshot(cls) -> list[dict[str, object]]:
        with cls.lock:
            return list(cls.session_payloads)

    @classmethod
    def form_reply_snapshot(cls) -> dict[str, object] | None:
        with cls.lock:
            return dict(cls.form_reply) if cls.form_reply is not None else None

    @classmethod
    def form_cancelled_snapshot(cls) -> bool:
        with cls.lock:
            return cls.form_cancelled

    @classmethod
    def set_form_reply_delay(cls, enabled: bool) -> None:
        with cls.lock:
            cls.form_reply_delay = enabled

    @classmethod
    def clear_message_requests(cls) -> None:
        with cls.lock:
            cls.message_requests = []

    @classmethod
    def message_requests_snapshot(cls) -> list[dict[str, list[str]]]:
        with cls.lock:
            return list(cls.message_requests)

    @classmethod
    def session_reads_snapshot(cls) -> int:
        with cls.lock:
            return cls.session_reads

    @classmethod
    def managed_sends_snapshot(cls) -> list[dict[str, object]]:
        with cls.lock:
            return list(cls.managed_sends)

    @classmethod
    def set_managed_failures(cls, count: int) -> None:
        with cls.lock:
            cls.managed_failures = count

    @classmethod
    def set_session_running(cls, running: bool) -> None:
        with cls.lock:
            cls.session_running = running

    @classmethod
    def clear_queued_prompt_event(cls) -> None:
        with cls.lock:
            cls.queued_prompt_event.clear()


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

    @staticmethod
    def created_session(session_id: str, payload: dict[str, object]) -> dict[str, object]:
        location = payload.get("location") if isinstance(payload.get("location"), dict) else {}
        directory = location.get("directory") if isinstance(location.get("directory"), str) else ""
        return {
            "id": session_id, "title": str(payload.get("title") or "Новая сессия"),
            "projectID": "proj_other" if directory == os.environ["FIXTURE_OTHER_PROJECT"] else "proj_fixture", "agent": payload.get("agent") or "build",
            "model": payload.get("model") or {"providerID":"bailian-cli", "id":"qwen3.8-max"},
            "location": {"directory": directory}, "time":{"created":2_000_000_001_000,"updated":2_000_000_001_000},
        }

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        project = os.environ["FIXTURE_PROJECT"]
        session = self.session(project)
        created_session = None
        if path.startswith("/api/session/"):
            with FixtureState.lock:
                created_session = FixtureState.created_sessions.get(path.split("/")[3])
        if path == "/api/project":
            self.send_json({"data": [{"id": "proj_fixture", "name": "Fixture", "canonical": project}, {"id": "proj_other", "name": "Other", "canonical": os.environ["FIXTURE_OTHER_PROJECT"]}]})
        elif path == "/api/session":
            if "limit=100" in parsed.query:
                with FixtureState.lock:
                    FixtureState.session_reads += 1
            older = {**session, "id":"ses_older", "title":"Older root", "time":{"created":1_999_999_999_000,"updated":1_999_999_999_100}}
            child = {**session, "id":"ses_child_reader", "title":"Reader subagent", "parentID":"ses_fixture", "agent":"explore", "time":{"created":2_000_000_000_100,"updated":2_000_000_000_500}}
            nested = {**session, "id":"ses_child_review", "title":"Reviewer nested", "parentID":"ses_child_reader", "agent":"review", "time":{"created":2_000_000_000_200,"updated":2_000_000_000_600}}
            other = {**session, "id":"ses_other", "title":"Other project chat", "projectID":"proj_other", "location":{"directory":os.environ["FIXTURE_OTHER_PROJECT"]}, "time":{"created":2_000_000_000_050,"updated":2_000_000_000_050}}
            other_child = {**other, "id":"ses_other_agent", "title":"Other agent", "parentID":"ses_other", "agent":"review", "time":{"created":2_000_000_000_110,"updated":2_000_000_000_510}}
            with FixtureState.lock:
                created_sessions = list(FixtureState.created_sessions.values())
            self.send_json({"data": [*created_sessions, older, child, nested, session, other_child, other]})
        elif path == "/api/session/active" or path == "/api/session/status":
            with FixtureState.lock:
                session_running = FixtureState.session_running
            statuses = {"ses_fixture": {"type": "busy" if session_running else "idle"}}
            self.send_json({"data": statuses})
        elif path == "/api/session/ses_fixture":
            self.send_json({"data": session})
        elif path.startswith("/api/session/") and path.endswith("/message") and created_session is not None:
            self.send_json({"data": [], "cursor":{"next":None}})
        elif created_session is not None:
            self.send_json({"data": created_session})
        elif path == "/api/session/ses_child_reader":
            child = {**session, "id":"ses_child_reader", "title":"Reader subagent", "parentID":"ses_fixture", "agent":"explore", "time":{"created":2_000_000_000_100,"updated":2_000_000_000_500}}
            self.send_json({"data": child})
        elif path == "/api/session/ses_child_reader/message":
            rows = [
                {"info":{"id":"child_tool","role":"assistant","time":{"created":2_000_000_000_103}},"parts":[{"type":"tool","id":"child_shell","name":"shell","state":{"status":"completed","content":"technical output"}}]},
                {"info":{"id":"child_assistant","role":"assistant","time":{"created":2_000_000_000_102}},"parts":[{"type":"text","text":"Delegated answer"}]},
                {"info":{"id":"child_user","role":"user","time":{"created":2_000_000_000_101}},"parts":[{"type":"text","text":"Delegated request"}]},
            ]
            self.send_json({"data": rows, "cursor":{"next": None}})
        elif path == "/api/session/ses_other":
            self.send_json({"data": {**session, "id":"ses_other", "title":"Other project chat", "projectID":"proj_other", "location":{"directory":os.environ["FIXTURE_OTHER_PROJECT"]}}})
        elif path == "/api/session/ses_other_agent/message":
            self.send_json({"data": [{"info":{"id":"other_agent_assistant","role":"assistant","time":{"created":2_000_000_000_510}},"parts":[{"type":"tool","id":"other_tool","name":"other_tool","state":{"status":"completed","content":"other result"}}]}]})
        elif path == "/api/session/ses_other/message":
            self.send_json({"data": [], "cursor":{"next": None}})
        elif path == "/api/session/ses_fixture/context":
            with FixtureState.lock:
                FixtureState.context_reads += 1
            self.send_json({"error": "context endpoint unavailable"}, status=404)
        elif path == "/api/session/ses_fixture/message":
            query = parse_qs(parsed.query)
            with FixtureState.lock:
                FixtureState.message_requests.append(query)
                if "cursor" not in query:
                    FixtureState.message_order = query.get("order", ["desc"])[0]
                message_order = FixtureState.message_order
            history = []
            for index in range(241):
                role = "user" if index % 2 == 0 else "assistant"
                history.append({
                    "info": {
                        "id": f"msg_{index:03d}",
                        "role": role,
                        "time": {"created": 2_000_000_000_000 + index},
                    },
                    "parts": [{"type": "text", "text": f"History {role} {index:03d}"}],
                })
            if message_order == "desc":
                history.reverse()
            start = int(query.get("cursor", ["0"])[0])
            limit = int(query.get("limit", ["200"])[0])
            rows = history[start:start + limit]
            next_cursor = str(start + limit) if start + limit < len(history) else (str(start) if "cursor" in query else None)
            self.send_json({"data": rows, "cursor": {"next": next_cursor}})
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
            with FixtureState.lock:
                permission_pending = FixtureState.permission_pending
            rows = []
            if permission_pending:
                rows.append({
                    "sessionID": "ses_fixture",
                    "requestID": "perm_fixture",
                    "action": "shell",
                    "resources": ["echo fixture"],
                    "metadata": {"command": "echo fixture"},
                })
            self.send_json({"data": rows})
        elif path == "/api/form/request":
            with FixtureState.lock:
                form_pending = FixtureState.form_pending
            rows = []
            if form_pending:
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
            with FixtureState.lock:
                question_pending = FixtureState.question_pending
            rows = []
            if question_pending:
                rows.append({
                    "sessionID": "ses_fixture",
                    "requestID": "question_fixture",
                    "questions": [{
                        "header": "Среда",
                        "question": "Как продолжить fixture?",
                        "multiple": False,
                        "options": [
                            {"label": "Использовать fixture", "description": "Проверка native question reply с длинным описанием для тестирования переполнения на мобильных устройствах"},
                            {"label": "Альтернативный подход", "description": "Еще один вариант с подробным описанием, чтобы карточка вопроса переполняла экран мобильного устройства"},
                            {"label": "Третий вариант", "description": "Дополнительное описание для третьего варианта, увеличивающее высоту карточки вопроса"},
                            {"label": "Четвертый вариант", "description": "Подробное описание четвертого варианта для создания переполнения контента в мобильном вьюпорте"},
                            {"label": "Пятый вариант", "description": "Еще одно длинное описание для пятого варианта, чтобы гарантировать переполнение карточки на экране 412x915"},
                            {"label": "Шестой вариант", "description": "Финальное описание для шестого варианта, завершающее список опций для тестирования мобильной верстки"}
                        ],
                    }],
                })
            self.send_json({"data": rows})
        elif path == "/api/event":
            with FixtureState.lock:
                question_event_sent = FixtureState.question_event_sent
                if not question_event_sent:
                    FixtureState.question_event_sent = True
            if not question_event_sent:
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
        if path == "/api/session":
            with FixtureState.lock:
                FixtureState.session_payloads.append(payload)
                session_id = f"ses_created_{len(FixtureState.session_payloads)}"
                created = self.created_session(session_id, payload)
                FixtureState.created_sessions[session_id] = created
            self.send_json({"data": created})
            return
        if path in ("/api/session/ses_fixture/prompt_async", "/api/session/ses_fixture/prompt"):
            text = str(payload.get("text") or "")
            if not text and isinstance(payload.get("prompt"), dict):
                text = str(payload["prompt"].get("text") or "")
            if not text and isinstance(payload.get("parts"), list):
                text = "\n".join(str(part.get("text") or "") for part in payload["parts"] if isinstance(part, dict) and part.get("type") == "text").strip()
            with FixtureState.lock:
                FixtureState.managed_sends.append({"text": text})
                should_fail = FixtureState.managed_failures > 0
                if should_fail:
                    FixtureState.managed_failures -= 1
            if should_fail:
                self.send_json({"error": "fixture managed send failure"}, status=500)
                return
            self.send_json({"data": {"ok": True}})
            if text == "queue exactly once":
                FixtureState.queued_prompt_event.set()
            return
        if "/permission/" in path or "/permissions/" in path:
            with FixtureState.lock:
                FixtureState.permission_pending = False
        if path.startswith("/api/session/ses_fixture/form/") and path.endswith("/reply"):
            with FixtureState.lock:
                form_reply_delay = FixtureState.form_reply_delay
                if form_reply_delay:
                    FixtureState.form_reply_delay = False
            if form_reply_delay:
                time.sleep(0.35)
            with FixtureState.lock:
                FixtureState.form_pending = False
                FixtureState.form_reply = payload
        elif path.startswith("/api/session/ses_fixture/form/") and path.endswith("/cancel"):
            with FixtureState.lock:
                FixtureState.form_pending = False
                FixtureState.form_cancelled = True
        elif path == "/api/question/question_fixture/reply":
            with FixtureState.lock:
                FixtureState.question_pending = False
                FixtureState.question_reply = payload
        elif path.startswith("/api/question/") and path.endswith("/reject"):
            with FixtureState.lock:
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
    page.locator("#sessions .session").first.wait_for(state="visible", timeout=60000)


def open_session(page) -> None:
    menu = page.locator("#menu")
    if menu.is_visible():
        menu.click()
    page.locator('[data-session="ses_fixture"]').click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_fixture')")
    page.locator("#messagesInner").wait_for(state="visible")


def assert_created_session(page, previous_hash: str, payload_count: int, directory: str) -> None:
    page.wait_for_function("document.querySelector('#projectDialog').open === false")
    page.wait_for_function("previousHash => location.hash !== previousHash && location.hash.startsWith('#/session/')", arg=previous_hash)
    payloads = FixtureState.session_payload_snapshot()
    assert len(payloads) == payload_count + 1
    assert payloads[payload_count]["location"]["directory"] == directory


def universal_plan_session_switch(browser, base_url: str) -> None:
    context = browser.new_context(viewport={"width": 1366, "height": 850})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"HTTP {response.status} {response.url}") if response.status >= 500 else None)
    login(page, base_url)
    open_session(page)
    page.evaluate("window.CustomOpenCodeWorkspace.open('plan')")
    page.wait_for_function("document.querySelector('#unified-plan').innerText.includes('Fixture plan') && document.querySelector('#unified-plan').innerText.includes('Fixture step 00')", timeout=15000)
    unified_plan = page.locator('#unified-plan')
    assert "Fixture plan" in unified_plan.inner_text()
    assert "Fixture step 00" in unified_plan.inner_text()

    page.evaluate("location.hash = '#/session/ses_other'")
    page.wait_for_function("location.hash.startsWith('#/session/ses_other')")
    page.wait_for_function("document.querySelector('#unified-plan').innerText.includes('Other root plan') && document.querySelector('#unified-plan').innerText.includes('Other isolated step')", timeout=15000)
    assert "Other root plan" in unified_plan.inner_text()
    assert "Other isolated step" in unified_plan.inner_text()
    assert "Fixture plan" not in unified_plan.inner_text()
    assert "Fixture step 00" not in unified_plan.inner_text()

    page.evaluate("window.CustomOpenCodeWorkspace.close()")
    page.click("#logoutButton")
    page.locator("#loginForm").wait_for(state="visible")
    assert not errors, errors
    context.close()
    print("Universal Plan session-switch scenario passed", flush=True)


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


def wait_for_task_state(page, task_id: str, state: str, timeout_ms: int = 5000):
    deadline = time.monotonic() + timeout_ms / 1000
    detail = None
    while time.monotonic() < deadline:
        result = page.evaluate("""async taskID => {
            const response = await fetch(`/client-task.json?id=${encodeURIComponent(taskID)}`, {cache: 'no-store'})
            return {ok: response.ok, detail: await response.json()}
        }""", task_id)
        assert result["ok"], result["detail"]
        detail = result["detail"]
        if detail.get("task", {}).get("state") == state:
            return detail
        page.wait_for_timeout(min(50, max(0, (deadline - time.monotonic()) * 1000)))
    raise AssertionError(f"task {task_id} did not reach {state}; last detail={detail}")


def clear_non_terminal_tasks(server_workflow) -> None:
    terminal = {"completed", "failed", "cancelled"}
    tasks = server_workflow.runtime.STORE.list_tasks(session_id="ses_fixture", limit=200)
    for task in tasks:
        if task["state"] not in terminal:
            try:
                server_workflow.runtime.task_control(
                    server_workflow.features,
                    {"taskID": task["id"], "action": "cancel"},
                )
            except ValueError:
                current = server_workflow.runtime.STORE.get_task(task["id"])
                if current is None or current["state"] not in terminal:
                    raise
    remaining = [
        task
        for task in server_workflow.runtime.STORE.list_tasks(session_id="ses_fixture", limit=200)
        if task["state"] not in terminal
    ]
    assert not remaining, remaining


def desktop(browser, base_url: str, server_workflow) -> None:
    FixtureState.reset()
    context = browser.new_context(viewport={"width": 1366, "height": 850})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"HTTP {response.status} {response.url}") if response.status >= 500 else None)
    login(page, base_url)
    # New session is a target chooser: it must not create a scratch session.
    page.click("#newSession")
    page.locator("#projectDialog[open]").wait_for(state="visible")
    assert FixtureState.session_payload_snapshot() == []
    previous_hash = page.evaluate("location.hash")
    payload_count = len(FixtureState.session_payload_snapshot())
    page.locator('#projectDialog button[data-project="proj_other"]').click()
    assert_created_session(page, previous_hash, payload_count, os.environ["FIXTURE_OTHER_PROJECT"])

    # Browsing an existing directory and creating a child both use the same bridge.
    page.click("#chooseProject")
    page.click("#browseProjects")
    page.locator("#projectBrowser .directory-choice").filter(has_text="existing").click()
    previous_hash = page.evaluate("location.hash")
    payload_count = len(FixtureState.session_payload_snapshot())
    page.locator("[data-open-directory]").click()
    assert_created_session(page, previous_hash, payload_count, os.environ["FIXTURE_EXISTING_PROJECT"])
    page.click("#chooseProject")
    page.click("#browseProjects")
    form = page.locator("[data-create-directory]")
    form.locator("input").fill("child-created")
    previous_hash = page.evaluate("location.hash")
    payload_count = len(FixtureState.session_payload_snapshot())
    form.locator("button").click()
    child_directory = str(Path(os.environ["FIXTURE_PROJECT"]) / "child-created")
    assert_created_session(page, previous_hash, payload_count, child_directory)
    assert Path(child_directory).is_dir()
    fixture_group = page.locator('#sessions .project-group[data-project="proj_fixture"]')
    other_group = page.locator('#sessions .project-group[data-project="proj_other"]')
    assert fixture_group.get_attribute("open") is not None and other_group.get_attribute("open") is not None
    root_titles = fixture_group.locator(':scope > .project-sessions > .session-node > .session [data-session] .session-title').all_inner_texts()
    assert root_titles == ["Новая сессия", "Новая сессия", "Fixture session", "Older root"], root_titles
    parent_folder = fixture_group.locator('[data-agent-folder="ses_fixture"]')
    parent_children = fixture_group.locator('[data-session-children="ses_fixture"]')
    assert parent_folder.count() == 1
    assert "Агентские диалоги" in parent_folder.locator(':scope > summary').inner_text()
    if parent_folder.get_attribute("open") is not None:
        parent_folder.locator(':scope > summary').click()
    assert parent_folder.get_attribute("open") is None and parent_children.is_hidden()
    parent_folder.locator(':scope > summary').click()
    assert parent_folder.get_attribute("open") is not None and parent_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_folder = fixture_group.locator('[data-agent-folder="ses_child_reader"]')
    child_children = fixture_group.locator('[data-session-children="ses_child_reader"]')
    assert child_folder.count() == 1
    child_folder.locator(':scope > summary').click()
    assert child_folder.get_attribute("open") is not None and child_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
    fixture_group.locator('[data-session="ses_child_reader"]').click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_child_reader')")
    page.wait_for_function("document.querySelectorAll('#messages .message').length === 2")
    assert page.locator('#messages .message.user').get_attribute('data-origin') == 'agent-prompt'
    assert page.locator('#messages .message.user .message-role').inner_text() == 'Запрос модели/агента → explore'
    assert page.locator('#messages .message.assistant').get_attribute('data-origin') == 'agent-response'
    assert page.locator('#messages .message.assistant .message-role').inner_text().startswith('Агент explore')
    open_session(page)
    fixture_group.locator(':scope > summary').click()
    assert fixture_group.get_attribute("open") is None and other_group.get_attribute("open") is not None
    fixture_group.locator(':scope > summary').click()
    FixtureState.clear_message_requests()
    open_session(page)
    page.wait_for_function("document.querySelectorAll('#messages .message').length === 80")
    page.wait_for_function("document.querySelector('#messages').scrollHeight - document.querySelector('#messages').clientHeight - document.querySelector('#messages').scrollTop < 4")
    assert page.locator("#messages").evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop < 4"), "initial session viewport must start at the newest messages"
    page.wait_for_timeout(1600)  # Let the initial 1.5 s resize-stabilization window close.
    page.locator("#messages").evaluate("el => el.scrollTo({ top:el.scrollHeight-el.clientHeight-150, behavior:'instant' })")
    page.locator("#scrollToBottom").wait_for(state="visible")
    page.wait_for_timeout(100)
    assert page.locator("#scrollToBottom").is_visible(), "scroll-to-bottom visibility must have one stable threshold"
    page.locator("#scrollToBottom").click()
    page.wait_for_function("document.querySelector('#messages').scrollHeight - document.querySelector('#messages').clientHeight - document.querySelector('#messages').scrollTop < 4")
    assert page.locator("#scrollToBottom").is_hidden()
    initial_history_requests = [request for request in FixtureState.message_requests_snapshot() if request.get("limit") == ["80"]]
    assert initial_history_requests == [{"limit": ["80"], "order": ["desc"]}], "initial layout must not page older history"
    page.locator("#messages").hover()
    page.mouse.wheel(0, 100000)
    page.wait_for_timeout(150)
    assert page.locator("#messages .message").count() == 80, "downward wheel must not page older history"
    page.locator("#messages").evaluate("el => { el.tabIndex = -1; el.focus() }")
    page.keyboard.press("Home")
    page.wait_for_function("document.querySelectorAll('#messages .message').length >= 160")
    for minimum in (240, 241):
        page.locator("#messages").hover()
        page.mouse.wheel(0, -100000)
        page.wait_for_function(f"document.querySelectorAll('#messages .message').length >= {minimum}")
    assert page.locator("#messages .message").count() == 241
    user_messages = page.locator("#messages .message.user")
    user_texts = user_messages.evaluate_all("els => els.map(el => el.querySelector('.markdown')?.innerText)")
    assert user_texts == [f"History user {index:03d}" for index in range(0, 241, 2)]
    history_requests = [request for request in FixtureState.message_requests_snapshot() if request.get("limit") == ["80"]]
    assert history_requests == [
        {"limit": ["80"], "order": ["desc"]},
        {"limit": ["80"], "cursor": ["80"]},
        {"limit": ["80"], "cursor": ["160"]},
        {"limit": ["80"], "cursor": ["240"]},
    ]

    page.locator("#questionHost .question-card").wait_for(state="visible")
    page.locator('[data-question-option="0:0"]').click()
    page.click("[data-question-submit]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")
    assert FixtureState.form_reply_snapshot() == {"answer": {"environment": "fixture"}}

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
    FixtureState.set_form_reply_delay(True)
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
            questions: [{
                header: 'Source',
                question: 'Event question?',
                multiple: false,
                options: [{label:'Continue',description:'Question event'}],
            }],
        },
    }}))""")
    page.locator("#questionHost .question-card").wait_for(state="visible")
    assert page.locator("#questionHost .question-title").inner_text() == "Source"
    page.click("[data-question-reject]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")

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
    # The scroll affordance appears at the top and remains within its frame.
    page.locator("#messages").evaluate("el => el.scrollTop = 0")
    page.locator("#scrollToBottom").wait_for(state="visible")
    box = page.locator("#scrollToBottom").bounding_box()
    frame = page.locator(".messages-frame").bounding_box()
    assert box and frame and frame["y"] <= box["y"] and box["y"] + box["height"] <= frame["y"] + frame["height"], (box, frame)
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] - 2)
    page.wait_for_function("el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2", arg=page.locator("#messages").element_handle())
    page.locator("#scrollToBottom").wait_for(state="hidden")

    assert not errors, errors
    FixtureState.set_managed_failures(1)
    page.fill("#input", "send exactly once")
    page.click("#composerAction")
    page.wait_for_function("document.querySelector('#input').value === 'send exactly once'")
    page.wait_for_function("document.querySelector('#composerAction').getAttribute('aria-label') === 'Отправить'")
    assert page.locator("#messages .chat-status").is_hidden()
    assert len(FixtureState.managed_sends_snapshot()) == 1
    assert errors == [f"HTTP 500 {base_url}/client-send.json"], errors
    errors.clear()

    page.evaluate("""() => {
        const button = document.querySelector('#composerAction')
        button.click(); button.click(); button.click()
    }""")
    page.wait_for_function("document.querySelector('#input').value === '' && !document.querySelector('#stop').hidden")
    assert page.locator("#messages .chat-status").is_visible()
    assert page.locator("#messages .chat-status").inner_text() == "Модель работает…"
    page.wait_for_timeout(200)
    managed_sends = FixtureState.managed_sends_snapshot()
    assert len(managed_sends) == 2, managed_sends
    assert [payload.get("text") for payload in managed_sends] == ["send exactly once", "send exactly once"]

    task_id = page.evaluate("""async () => {
        const response = await fetch('/client-tasks.json?sessionID=ses_fixture&limit=20', {cache: 'no-store'})
        if (!response.ok) throw new Error(`task list failed: ${response.status}`)
        const payload = await response.json()
        return (payload.tasks || [])
            .filter(task => task.text === 'send exactly once' && task.state === 'submitted' && !task.error)
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0]?.id
    }""")
    assert task_id
    FixtureState.clear_queued_prompt_event()
    FixtureState.set_session_running(True)
    wait_for_task_state(page, task_id, "running")
    page.wait_for_function("!document.querySelector('#stop').hidden")
    page.fill("#input", "queue exactly once")
    page.wait_for_function("document.querySelector('#composerAction').getAttribute('aria-label') === 'Отправить в очередь'")
    page.evaluate("""() => {
        const button = document.querySelector('#composerAction')
        button.click(); button.click(); button.click()
    }""")
    page.locator('[data-session-drag="ses_fixture"] .queued').wait_for()
    assert page.locator('[data-session-drag="ses_fixture"] .queued').inner_text() == "очередь 1"
    assert len(FixtureState.managed_sends_snapshot()) == 2

    FixtureState.set_session_running(False)
    page.evaluate("""() => {
        Object.defineProperty(document, 'hidden', {configurable: true, value: false})
        document.dispatchEvent(new Event('visibilitychange'))
    }""")
    page.wait_for_function("document.querySelector('#composerAction').getAttribute('aria-label') === 'Отправить'")
    page.wait_for_function("document.querySelector('#messages .chat-status').hidden")
    completed_task = wait_for_task_state(page, task_id, "completed")
    assert any(event.get("kind") == "task.completed" for event in completed_task.get("events", [])), completed_task
    queued_prompt_deadline = time.monotonic() + 5
    while not FixtureState.queued_prompt_event.is_set() and time.monotonic() < queued_prompt_deadline:
        page.wait_for_timeout(50)
    if not FixtureState.queued_prompt_event.is_set():
        tasks = page.evaluate("""async () => {
            const response = await fetch('/client-tasks.json?sessionID=ses_fixture&limit=20', {cache: 'no-store'})
            const payload = await response.json()
            return Promise.all((payload.tasks || []).map(async ({id, text, state, error}) => {
                const detail = await fetch(`/client-task.json?id=${encodeURIComponent(id)}`, {cache: 'no-store'})
                const task = await detail.json()
                return {
                    id, text, state, error,
                    events: (task.events || []).map(({kind, created_at}) => ({kind, created_at})),
                }
            }))
        }""")
        assert False, f"queued prompt was not dispatched; tasks={tasks}"
    assert [payload.get("text") for payload in FixtureState.managed_sends_snapshot()] == [
        "send exactly once", "send exactly once", "queue exactly once",
    ]

    sends_before_enter = len(FixtureState.managed_sends_snapshot())
    page.fill("#input", "desktop enter")
    page.locator("#input").press("Enter")
    page.wait_for_function("document.querySelector('#input').value === ''")
    page.wait_for_function("!document.querySelector('#stop').hidden")
    assert [payload.get("text") for payload in FixtureState.managed_sends_snapshot()][sends_before_enter:] == ["desktop enter"]

    page.fill("#input", "desktop shift")
    page.locator("#input").press("Shift+Enter")
    assert page.locator("#input").input_value() == "desktop shift\n"
    assert len(FixtureState.managed_sends_snapshot()) == sends_before_enter + 1
    page.fill("#input", "")

    page.wait_for_function("document.documentElement.dataset.executionMode === 'build' && document.querySelector('.live-panel')")
    assert page.locator("#agentControls").is_hidden()

    page.click("#appearanceButton")
    page.locator("#appearanceDialog[open]").wait_for(state="visible")
    page.click('[data-theme-mode="dark"]')
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.evaluate("document.getElementById('appearanceDialog').close()")

    page.evaluate("document.documentElement.dataset.modelProfile = 'orchestrated'")
    page.wait_for_function("document.querySelectorAll('.orchestration-plan-list li').length === 48", timeout=5000)
    assert page.locator(".activity-chevron").count() == 0
    assert page.locator(".plan-panel > summary").evaluate("el => getComputedStyle(el, '::after').content") != "none"
    assert not page.locator('.plan-panel').evaluate('el => el.open')
    assert not page.locator('.live-panel').evaluate('el => el.open')
    messages = page.locator("#messages")
    conversation_before = messages.evaluate("""el => {
        const scrollBehavior = el.style.scrollBehavior
        el.style.scrollBehavior = 'auto'
        el.scrollTop = Math.min(1, Math.max(0, el.scrollHeight - el.clientHeight))
        const top = el.scrollTop
        el.style.scrollBehavior = scrollBehavior
        return top
    }""")
    assert conversation_before <= 1
    page.locator(".plan-panel > summary").click()
    assert page.locator('.plan-panel').evaluate('el => el.open')
    assert not page.locator('.live-panel').evaluate('el => el.open')
    plan_body = page.locator(".plan-panel-body")
    page.wait_for_function("() => { const el = document.querySelector('.plan-panel-body'); return el && el.scrollHeight > el.clientHeight }")
    before = plan_body.evaluate("el => { el.scrollTop = Math.max(1, el.scrollHeight - el.clientHeight - 30); return el.scrollTop }")
    page.wait_for_timeout(1200)  # The live one-second render must not reset an expanded plan.
    after = plan_body.evaluate("el => el.scrollTop")
    assert abs(after - before) <= 2, (before, after)
    conversation_after = page.locator("#messages").evaluate("el => el.scrollTop")
    assert abs(conversation_after - conversation_before) <= 2, (conversation_before, conversation_after)
    page.locator('.live-panel > summary').click()
    assert page.locator('.plan-panel').evaluate('el => el.open') and page.locator('.live-panel').evaluate('el => el.open')
    page.locator('.live-panel > summary').click()
    assert page.locator('.plan-panel').evaluate('el => el.open') and not page.locator('.live-panel').evaluate('el => el.open')

    # A root-session switch must replace all orchestration data, rather than
    # briefly retaining the prior root's plan, child agent, or tool output.
    # Hash navigation restores the model profile per session.
    page.evaluate("""() => {
        const key = 'opencode:web:model-profiles-v1'
        const profiles = JSON.parse(localStorage.getItem(key) || '{}') || {}
        profiles.ses_other = 'orchestrated'
        localStorage.setItem(key, JSON.stringify(profiles))
    }""")
    other_group.locator('[data-session="ses_other"]').click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_other')")
    page.wait_for_function("""() =>
        document.querySelectorAll('.orchestration-plan-list li').length === 1 &&
        document.querySelector('.orchestration-plan-copy strong')?.textContent === 'Other root plan'
    """, timeout=5000)
    trace = page.locator('#orchestrationTrace')
    page.wait_for_function("""() => {
        const trace = document.querySelector('#orchestrationTrace')
        return trace?.textContent.includes('Other agent') && trace?.textContent.includes('other_tool')
    }""", timeout=5000)
    trace_text = trace.text_content() or ''
    assert "Other root plan" in trace_text
    assert "Fixture step 00" not in trace_text
    assert "Reader subagent" not in trace_text
    live_panel = page.locator('.live-panel')
    if not live_panel.evaluate('el => el.open'):
        live_panel.locator(':scope > summary').click()
    page.wait_for_function("""() => {
        const panel = document.querySelector('.live-panel')
        const trace = document.querySelector('#orchestrationTrace')
        return panel?.open === true && trace?.innerText.includes('Other agent') && trace?.innerText.includes('other_tool')
    }""", timeout=5000)

    clear_non_terminal_tasks(server_workflow)
    page.click("#logoutButton")
    page.locator("#loginForm").wait_for(state="visible")
    assert not errors, errors
    context.close()


def mobile(browser, base_url: str) -> None:
    FixtureState.reset()
    context = browser.new_context(
        viewport={"width": 412, "height": 915},
        is_mobile=True,
        has_touch=True,
        user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36",
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"HTTP {response.status} {response.url}") if response.status >= 500 else None)
    login(page, base_url)
    page.click("#menu")
    assert page.locator("#sidebar").evaluate("el => el.classList.contains('open')")
    page.locator('[data-session="ses_fixture"]').click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_fixture')")
    page.wait_for_timeout(250)
    assert not page.locator("#sidebar").evaluate("el => el.classList.contains('open')")

    page.locator("#questionHost .question-card").wait_for(state="visible")

    # Проверка видимости кнопки "Продолжить" и её положения в viewport
    submit_button = page.locator("[data-question-submit]")
    assert submit_button.is_visible(), "[data-question-submit] должна быть видима"
    submit_box = submit_button.bounding_box()
    viewport = page.viewport_size
    assert submit_box is not None, "bounding_box кнопки submit не должен быть None"
    assert submit_box["y"] + submit_box["height"] <= viewport["height"], \
        f"Кнопка submit выходит за нижнюю границу viewport: bottom={submit_box['y'] + submit_box['height']}, viewport_height={viewport['height']}"
    assert submit_box["y"] >= 0, f"Кнопка submit выходит за верхнюю границу viewport: top={submit_box['y']}"
    assert submit_box["x"] >= 0, f"Кнопка submit выходит за левую границу viewport: left={submit_box['x']}"
    assert submit_box["x"] + submit_box["width"] <= viewport["width"], \
        f"Кнопка submit выходит за правую границу viewport: right={submit_box['x'] + submit_box['width']}, viewport_width={viewport['width']}"

    page.click("[data-question-reject]")
    page.wait_for_function("document.querySelector('#questionHost').hidden")
    assert FixtureState.form_cancelled_snapshot()

    page.locator("#permissionBanner").wait_for(state="visible")
    page.locator("#permissionBanner [data-permission='once']").click()
    page.wait_for_function("document.querySelector('#permissionBanner').hidden")
    page.wait_for_timeout(2200)
    assert page.locator("#permissionBanner").is_hidden()

    page.fill("#input", "mobile enter")
    page.locator("#input").press("Enter")
    assert page.locator("#input").input_value() == "mobile enter\n"
    assert FixtureState.managed_sends_snapshot() == []
    with page.expect_response(lambda response: "/client-send.json" in response.url and response.request.method == "POST") as response_info:
        page.click("#composerAction")
    assert response_info.value.ok, f"mobile send failed: {response_info.value.status} {response_info.value.url}"
    page.wait_for_function("document.querySelector('#input').value === ''")
    page.wait_for_function("!document.querySelector('#stop').hidden")
    assert [payload.get("text") for payload in FixtureState.managed_sends_snapshot()] == ["mobile enter"]

    page.fill("#input", "mobile fixture")
    assert page.locator("#composerAction").is_visible()
    page.fill("#input", "")
    page.locator("#messages").evaluate("el => el.scrollTop = 0")
    page.locator("#scrollToBottom").wait_for(state="visible")
    box = page.locator("#scrollToBottom").bounding_box()
    frame = page.locator(".messages-frame").bounding_box()
    assert box and frame and frame["y"] <= box["y"] and box["y"] + box["height"] <= frame["y"] + frame["height"], (box, frame)
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] - 2)
    page.wait_for_function("el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2", arg=page.locator("#messages").element_handle())
    page.locator("#scrollToBottom").wait_for(state="hidden")

    cdp = context.new_cdp_session(page)
    messages = page.locator("#messages")
    messages.evaluate("el => { el.scrollTop = 0 }")
    box = messages.bounding_box()
    assert box
    x = round(box["x"] + box["width"] / 2)
    start_y = round(box["y"] + box["height"] / 2)
    point = lambda y: {"x": x, "y": y, "id": 1, "radiusX": 2, "radiusY": 2, "force": 1}
    initial_messages = messages.locator(".message").count()
    messages.evaluate("el => { el.scrollTop = el.scrollHeight / 2 }")
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y + 24)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(1100)
    messages.evaluate("el => { el.scrollTop = 0 }")
    page.wait_for_timeout(150)
    assert messages.locator(".message").count() == initial_messages, "completed touch gesture must not leave stale pagination intent"
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(150)
    assert messages.locator(".message").count() == initial_messages, "touch tap must not page older history"
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point(start_y)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point(start_y + 24)]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_function(f"document.querySelectorAll('#messages .message').length >= {initial_messages + 80}")
    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh hint is visible without a gesture"
    def pull_len() -> int:
        return len([q for q in FixtureState.message_requests_snapshot() if q.get("limit") == ["80"] and "cursor" not in q])
    # Snapshot only the pull-specific counter; background session polling
    # (every 30s) would otherwise make the combined (session,context) tuple flaky.
    reads = (FixtureState.session_reads_snapshot(), pull_len())
    pull_messages(page, cdp, 104, 720)
    assert pull_len() == reads[1], "downward pull refreshed session data"
    assert page.locator(".pull-refresh").is_hidden()

    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    pull_messages(page, cdp, -8, 720)
    assert pull_len() == reads[1], "short pull refreshed session data"
    assert page.locator(".pull-refresh").is_hidden()

    messages.evaluate("el => { el.scrollTop = el.scrollHeight }")
    pull_messages(page, cdp, -44, 180)
    page.wait_for_timeout(700)
    assert pull_len() == reads[1], "early release refreshed session data"
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
    assert pull_len() == reads[1], "reversed pull refreshed session data"
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
    while time.monotonic() < deadline and not (FixtureState.session_reads_snapshot() > reads[0] and pull_len() > reads[1]):
        page.wait_for_timeout(20)
    assert FixtureState.session_reads_snapshot() > reads[0] and pull_len() > reads[1]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(500)
    assert page.locator(".pull-refresh").get_attribute("data-state") == "done"
    assert page.locator(".pull-refresh svg").count() == 1
    page.wait_for_timeout(600)
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh result did not dismiss"
    page.evaluate("document.documentElement.dataset.modelProfile = 'orchestrated'")
    page.wait_for_function("document.querySelectorAll('.orchestration-plan-list li').length === 48", timeout=5000)
    plan = page.locator('.plan-panel')
    live = page.locator('.live-panel')
    assert not plan.evaluate('el => el.open') and not live.evaluate('el => el.open')
    plan.locator(':scope > summary').click()
    assert plan.evaluate('el => el.open') and not live.evaluate('el => el.open')
    live.locator(':scope > summary').click()
    assert plan.evaluate('el => el.open') and live.evaluate('el => el.open')
    plan.locator(':scope > summary').click()
    assert not plan.evaluate('el => el.open') and live.evaluate('el => el.open')
    assert not errors, errors
    context.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        project = root / "project"
        project.mkdir()
        existing = project / "existing"
        existing.mkdir()
        other_project = project / "other-known"
        other_project.mkdir()
        (root / "ses_fixture-plan.md").write_text("# Fixture plan\n" + "\n".join(f"- [ ] Fixture step {index:02d}" for index in range(48)), encoding="utf-8")
        (root / "ses_other-plan.md").write_text("# Other root plan\n\n- [ ] Other isolated step\n", encoding="utf-8")
        os.environ.update({
            "FIXTURE_PROJECT": str(project),
            "FIXTURE_EXISTING_PROJECT": str(existing),
            "FIXTURE_OTHER_PROJECT": str(other_project),
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
        try:
            backend_host, backend_port = backend.server_address[:2]
            os.environ["OPENCODE_BACKEND_URL"] = f"http://{backend_host}:{backend_port}"
            os.environ["OPENCODE_BACKEND_PASSWORD"] = "fixture-backend"

            sys.path.insert(0, str(ROOT / "app"))
            import server_workflow
            server_workflow.runtime.PLAN_DIRECTORY = root
            server = ThreadingHTTPServer(("127.0.0.1", 0), server_workflow.Handler)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            try:
                host, port = server.server_address[:2]
                base_url = f"http://{host}:{port}"
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True)
                    try:
                        universal_plan_session_switch(browser, base_url)
                        desktop(browser, base_url, server_workflow)
                        mobile(browser, base_url)
                    finally:
                        browser.close()
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=2)
        finally:
            backend.shutdown()
            backend.server_close()
            backend_thread.join(timeout=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
