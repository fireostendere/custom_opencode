#!/usr/bin/env python3
"""Browser regressions for the web client's session/model/stream behaviour.

Serves app/ read-only next to a fake OpenCode backend (no real server, provider
or user state) and drives headless Chromium through the failures fixed in the
2026-09-28 review: wrong-session sends, silent agent/model rewrites, stale
model overrides, project defaults on existing chats, lost attachments/focus,
dead event streams, streaming scroll and lost words, hidden subagent
permissions and duplicated slash commands.
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parents[1] / "app"
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".png": "image/png",
         ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}
QWEN = {"providerID": "bailian-cli", "id": "qwen3.8-max"}
SOL = {"providerID": "openai", "id": "gpt-6-sol"}
AGENTS = [
    {"id": "build", "name": "build", "mode": "primary"},
    {"id": "plan", "name": "plan", "mode": "primary"},
    {"id": "review", "name": "review", "mode": "primary"},
    {"id": "build-direct", "name": "build-direct", "mode": "primary", "hidden": True},
    {"id": "plan-direct", "name": "plan-direct", "mode": "primary", "hidden": True},
]
MODELS = [
    {"providerID": "bailian-cli", "id": "qwen3.8-max", "name": "Qwen3.8 Max", "enabled": True, "cost": [{"input": 1, "output": 1}], "limit": {"context": 262144}},
    {"providerID": "openai", "id": "gpt-6-sol", "name": "GPT-6 Sol", "enabled": True, "cost": [{"input": 1, "output": 1}], "variants": {"low": {}, "high": {}}},
]


def now_ms() -> int:
    return int(time.time() * 1000)


def message(sid: str, index: int, role: str, text: str) -> dict:
    return {"info": {"id": f"{sid}_m{index}", "role": role, "time": {"created": now_ms() - 10_000 + index}},
            "parts": [{"type": "text", "text": text}]}


class World:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.log: list[dict] = []
        self.sessions: dict[str, dict] = {}
        self.messages: dict[str, list] = {}
        self.delays: dict[str, float] = {}
        self.event_status = 200
        self.clients: list[queue.Queue] = []
        self.active: dict = {}
        self.permissions: list[dict] = []
        self.settings: dict = {}
        self.live_words: list[str] = []

    def add(self, sid: str, *, agent: str = "build", model: dict | None = None, parent: str | None = None, messages: list | None = None) -> None:
        self.sessions[sid] = {"id": sid, "title": f"Chat {sid}", "agent": agent, "model": dict(model or QWEN), "projectID": "p1",
                              "location": {"directory": "/tmp/proj"}, "time": {"created": now_ms() - 100_000, "updated": now_ms() - len(self.sessions) * 1000},
                              **({"parentID": parent} if parent else {})}
        self.messages[sid] = messages if messages is not None else [message(sid, 1, "user", "hi"), message(sid, 2, "assistant", "hello")]

    def broadcast(self, payload: dict) -> None:
        for client in list(self.clients):
            client.put(json.dumps(payload))

    def requests(self, predicate=None) -> list[dict]:
        with self.lock:
            rows = list(self.log)
        return [row for row in rows if predicate is None or predicate(row)]


def serve(world: World) -> str:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:
            pass

        def record(self, body: bytes | None) -> dict:
            parsed = urlsplit(self.path)
            row = {"t": time.time(), "method": self.command, "path": parsed.path, "query": parsed.query}
            if body:
                try:
                    row["body"] = json.loads(body)
                except ValueError:
                    row["body"] = None
            with world.lock:
                world.log.append(row)
            for key, seconds in list(world.delays.items()):
                if key in self.path:
                    time.sleep(seconds)
            return row

        def send_json(self, value, status: int = 200) -> None:
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: C901 - one routing table for the fake backend
            parsed = urlsplit(self.path)
            path = parsed.path
            if path == "/api/event":
                self.record(None)
                return self.events()
            if not path.startswith(("/api/", "/client-", "/auth/")):
                return self.static(path)
            self.record(None)
            query = parse_qs(parsed.query)
            parts = path.split("/")
            if path == "/auth/session":
                return self.send_json({"user": "opencode", "localBypass": True})
            if path == "/client-config.json":
                return self.send_json({"scratchDirectory": "/tmp/scratch"})
            if path == "/api/project":
                return self.send_json({"data": [{"id": "p1", "canonical": "/tmp/proj", "name": "proj"}]})
            if path == "/api/session":
                rows = sorted(world.sessions.values(), key=lambda row: -row["time"]["updated"])
                return self.send_json({"data": rows, "cursor": {"next": None}})
            if path in ("/api/session/active", "/api/session/status"):
                return self.send_json({"data": world.active})
            if len(parts) == 4 and path.startswith("/api/session/"):
                session = world.sessions.get(parts[3])
                return self.send_json({"data": session} if session else {"error": "missing"}, 200 if session else 404)
            if len(parts) == 5 and parts[4] == "message":
                rows = list(world.messages.get(parts[3], []))
                if world.live_words and parts[3] == "s0":
                    snapshot = " ".join(world.live_words)
                    time.sleep(0.8)  # slow history read while deltas keep streaming
                    rows.append({"info": {"id": "s0_live", "role": "assistant", "time": {"created": now_ms()}}, "parts": [{"type": "text", "text": snapshot}]})
                limit = int((query.get("limit") or ["80"])[0])
                return self.send_json({"data": list(reversed(rows))[:limit], "cursor": {"next": None}})
            if len(parts) == 5 and parts[4] == "children":
                return self.send_json({"error": "not found"}, 404)  # like the native V2 server
            if path == "/api/agent":
                return self.send_json({"data": AGENTS})
            if path == "/api/model":
                return self.send_json({"data": MODELS})
            if path == "/api/model/default":
                return self.send_json({"data": QWEN})
            if path == "/api/provider":
                return self.send_json({"data": [{"id": "bailian-cli", "name": "Bailian"}, {"id": "openai", "name": "OpenAI"}]})
            if path == "/api/permission/request":
                return self.send_json({"data": world.permissions})
            if path == "/api/command":
                return self.send_json({"data": [{"name": "review"}, {"name": "compact"}]})
            if path == "/client-project-settings.json":
                return self.send_json({"available": True, "settings": world.settings})
            if path == "/client-queue.json":
                return self.send_json({"count": 0, "items": [], "counts": {}})
            return self.send_json({"data": []} if path.startswith("/api/") else {})

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            row = self.record(self.rfile.read(length) if length else None)
            payload = row.get("body") if isinstance(row.get("body"), dict) else {}
            parts = row["path"].split("/")
            if len(parts) == 5 and parts[4] in ("agent", "model"):
                session = world.sessions.get(parts[3])
                if session:
                    session[parts[4]] = payload.get(parts[4])
                return self.send_json({"data": session})
            if row["path"] == "/api/session":
                sid = f"ses_new{len(world.sessions)}"
                world.add(sid, agent=payload.get("agent") or "build", model=payload.get("model") or QWEN, messages=[])
                return self.send_json({"data": world.sessions[sid]})
            return self.send_json({"ok": True, "task": {"id": "t1"}})

        def events(self) -> None:
            if world.event_status != 200:
                return self.send_json({"error": "backend unavailable"}, world.event_status)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            inbox: queue.Queue = queue.Queue()
            world.clients.append(inbox)
            try:
                self.wfile.write(b": hello\n\n")
                self.wfile.flush()
                while True:
                    try:
                        data = inbox.get(timeout=15)
                    except queue.Empty:
                        data = None
                    if data == "__close__":
                        break
                    self.wfile.write(f"data: {data}\n\n".encode() if data else b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                if inbox in world.clients:
                    world.clients.remove(inbox)
                self.close_connection = True

        def static(self, path: str) -> None:
            candidate = (APP / (path.lstrip("/") or "index.html")).resolve()
            if APP not in candidate.parents or candidate.suffix not in TYPES or not candidate.is_file():
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = candidate.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES[candidate.suffix])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def scenario(browser, setup):
    world = World()
    setup(world)
    base = serve(world)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    return world, base, page


def check(condition: bool, message_text: str) -> None:
    if not condition:
        raise AssertionError(message_text)


def wrong_session_send(browser) -> None:
    world, base, page = scenario(browser, lambda w: [w.add(f"s{i}", agent="build-direct") for i in range(3)])
    page.goto(f"{base}/#/session/s0")
    time.sleep(3)
    world.delays["/client-plan.json?sessionID=s1"] = 3.0
    page.click('[data-session="s1"]')
    time.sleep(0.4)
    page.click('[data-session="s2"]')
    time.sleep(0.8)
    page.fill("#input", "for s2")
    page.press("#input", "Enter")
    time.sleep(1.0)
    sends = [row["body"]["sessionID"] for row in world.requests(lambda row: row["path"] == "/client-send.json")]
    check(sends == ["s2"], f"a send after a quick switch went to {sends}, expected s2")
    page.close()


def passive_agents(browser) -> None:
    cases = [("s_bd", "build-direct"), ("s_pd", "plan-direct"), ("s_plan", "plan"), ("s_review", "review"), ("s_build", "build")]
    world, base, page = scenario(browser, lambda w: [w.add(sid, agent=agent) for sid, agent in cases])
    for sid, _ in cases:
        page.goto(f"{base}/#/session/{sid}")
        time.sleep(2.5)
    writes = world.requests(lambda row: row["method"] == "POST" and row["path"].endswith("/agent"))
    check(not writes, f"opening chats switched agents: {[(row['path'], row['body']) for row in writes]}")
    page.close()


def live_model_and_plan_chip(browser) -> None:
    world, base, page = scenario(browser, lambda w: w.add("s0"))
    page.goto(f"{base}/#/session/s0")
    time.sleep(3.5)
    label = "document.getElementById('modelButton').textContent"
    world.sessions["s0"]["model"] = dict(SOL)
    world.broadcast({"type": "session.model.selected", "data": {"sessionID": "s0", "model": dict(SOL), "previous": dict(QWEN)}})
    time.sleep(1.0)
    check("Sol" in page.evaluate(label), "a model switched in the TUI must show up live")
    world.sessions["s0"]["agent"] = "plan"
    world.broadcast({"type": "session.agent.selected", "data": {"sessionID": "s0", "agent": "plan", "previous": "build"}})
    time.sleep(1.0)
    check(page.evaluate("!document.getElementById('planModeChip')?.hidden"), "a Plan chat must show the Plan chip")
    page.click("#planModeChip")
    time.sleep(1.2)
    check(world.sessions["s0"]["agent"] == "build", "the Plan chip must switch the chat back to Build")
    page.close()


def stale_override_expires(browser) -> None:
    world, base, page = scenario(browser, lambda w: w.add("s0"))
    page.goto(f"{base}/#/session/s0")
    time.sleep(3.5)
    page.click("#modelButton")
    time.sleep(1.0)
    page.click('#modelChoices [data-model="gpt-6-sol"][data-provider="openai"]')
    time.sleep(1.5)
    world.sessions["s0"]["model"] = {**SOL, "variant": "high"}  # backend normalises the variant
    time.sleep(2.5)
    world.sessions["s0"]["model"] = dict(QWEN)  # later the TUI switches the model
    page.click("#refresh")
    time.sleep(1.5)
    check("Qwen" in page.evaluate("document.getElementById('modelButton').textContent"), "a stale web override must not hide a later TUI model switch")
    page.close()


def project_defaults_only_new_chats(browser) -> None:
    def setup(world: World) -> None:
        world.add("e1", messages=[])
        world.settings = {"defaultModel": "openai/gpt-6-sol"}
    world, base, page = scenario(browser, setup)
    page.goto(f"{base}/#/session/e1")
    time.sleep(4)
    writes = world.requests(lambda row: row["method"] == "POST" and row["path"] == "/api/session/e1/model")
    check(not writes, "project defaults must not rewrite the model of an existing chat")
    page.close()


def composer_focus_and_attachments(browser, scratch: Path) -> None:
    world, base, page = scenario(browser, lambda w: w.add("s0"))
    files = []
    for name in ("f1.txt", "f2.txt", "f3.txt"):
        path = scratch / name
        path.write_text(name)
        files.append(str(path))
    world.delays["/client-send.json"] = 0.6
    page.goto(f"{base}/#/session/s0")
    time.sleep(3)
    page.click("#input")
    page.keyboard.type("first")
    page.keyboard.press("Enter")
    time.sleep(1.5)
    check(page.evaluate("document.activeElement.id") == "input", "the composer must keep focus after sending")
    page.keyboard.type("typed after")
    check(page.evaluate("document.getElementById('input').value") == "typed after", "text typed after a send was lost")
    page.fill("#input", "with files")
    page.set_input_files("#fileInput", files)
    time.sleep(0.5)
    page.press("#input", "Enter")
    time.sleep(1.5)
    check(page.evaluate("document.querySelectorAll('#attachments .attachment').length") == 0, "attachment chips survived the send")
    before = len(world.requests(lambda row: row["path"] == "/client-send.json"))
    page.click("#input")
    page.press("#input", "Enter")
    time.sleep(1.0)
    check(len(world.requests(lambda row: row["path"] == "/client-send.json")) == before, "Enter on an empty composer sent a prompt")
    page.close()


def event_stream_recovers(browser) -> None:
    world, base, page = scenario(browser, lambda w: w.add("s0"))
    page.goto(f"{base}/#/session/s0")
    time.sleep(3)
    world.event_status = 502
    for client in list(world.clients):
        client.put("__close__")
    time.sleep(4)
    world.event_status = 200
    time.sleep(12)
    connections = len(world.requests(lambda row: row["path"] == "/api/event"))
    check(connections >= 3 and world.clients, f"the event stream did not reconnect after a 502 ({connections} connections)")
    page.close()


def streaming_scroll_and_words(browser) -> None:
    long_text = "Explanation with **bold** and `code`.\n\n```python\n" + "\n".join(f"def f{i}(x):\n    return x * {i}" for i in range(20)) + "\n```\n"
    history = [message("s0", i, "user" if i % 2 == 0 else "assistant", f"question {i}" if i % 2 == 0 else long_text) for i in range(40)]
    world, base, page = scenario(browser, lambda w: w.add("s0", messages=history))
    page.goto(f"{base}/#/session/s0")
    time.sleep(4)

    def stream(words: int, reload_at: int | None = None) -> None:
        world.broadcast({"type": "session.execution.started", "data": {"sessionID": "s0"}})
        world.broadcast({"type": "session.text.started", "data": {"sessionID": "s0", "assistantMessageID": "s0_live"}})
        for index in range(words):
            word = f"w{index}"
            world.live_words.append(word)
            world.broadcast({"type": "session.text.delta", "data": {"sessionID": "s0", "assistantMessageID": "s0_live", "delta": (" " if index else "") + word}})
            if index == reload_at:
                world.broadcast({"type": "session.updated", "data": {"sessionID": "s0"}})
            time.sleep(0.05)

    thread = threading.Thread(target=stream, args=(80, 20))
    thread.start()
    time.sleep(1.5)
    view = page.locator("#messages").bounding_box()
    page.mouse.move(view["x"] + view["width"] / 2, view["y"] + view["height"] / 2)
    page.mouse.wheel(0, -1500)
    time.sleep(1.2)
    distance = page.evaluate("(() => { const v = document.getElementById('messages'); return v.scrollHeight - v.clientHeight - v.scrollTop })()")
    check(distance > 1000, f"scrolling up during a stream was reverted (distance from bottom {distance})")
    thread.join()
    time.sleep(0.8)
    shown = page.evaluate("[...document.querySelectorAll('#messagesInner article.assistant .markdown')].pop().innerText").split()
    missing = [f"w{n}" for n in range(80) if f"w{n}" not in shown]
    check(not missing, f"streamed words vanished after a racing reload: {missing[:10]}")
    page.close()


def subagent_permission_visible(browser) -> None:
    def setup(world: World) -> None:
        world.add("s0")
        world.add("s0c", agent="general", parent="s0", messages=[])
        world.active = {"s0": {"type": "busy"}, "s0c": {"type": "busy"}}
        world.permissions = [{"id": "per_child", "sessionID": "s0c", "permission": "bash", "metadata": {"command": "npm test"}}]
    world, base, page = scenario(browser, setup)
    page.goto(f"{base}/#/session/s0")
    time.sleep(6)
    check(page.evaluate("!document.getElementById('permissionBanner').hidden"), "a subagent's pending permission must show in the parent chat")
    check("npm test" in page.evaluate("document.getElementById('permissionSummary').textContent"), "the subagent permission summary is missing")
    page.close()


def slash_commands(browser) -> None:
    world, base, page = scenario(browser, lambda w: w.add("s0"))
    page.goto(f"{base}/#/session/s0")
    time.sleep(3)
    mark = time.time()
    page.click("#input")
    page.keyboard.type("/review")
    time.sleep(1.0)
    lookups = world.requests(lambda row: row["t"] >= mark and row["path"] == "/api/session/s0")
    check(len(lookups) <= 1, f"the slash palette fetched the session per keystroke ({len(lookups)} times)")
    page.fill("#input", "/compact")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    time.sleep(1.2)
    posts = world.requests(lambda row: row["path"] == "/api/session/s0/command")
    check(len(posts) == 1, f"a double Enter ran the command {len(posts)} times")
    page.close()


def main() -> int:
    scratch = Path(__file__).resolve().parent / ".web-ux-regression-files"
    scratch.mkdir(exist_ok=True)
    checks = [
        ("wrong-session send", wrong_session_send),
        ("passive agents", passive_agents),
        ("live model + plan chip", live_model_and_plan_chip),
        ("stale model override", stale_override_expires),
        ("project defaults", project_defaults_only_new_chats),
        ("composer focus + attachments", lambda browser: composer_focus_and_attachments(browser, scratch)),
        ("event stream recovery", event_stream_recovers),
        ("streaming scroll + words", streaming_scroll_and_words),
        ("subagent permission", subagent_permission_visible),
        ("slash commands", slash_commands),
    ]
    failures = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for name, run in checks:
                try:
                    run(browser)
                    print(f"PASS {name}")
                except AssertionError as error:
                    failures.append(name)
                    print(f"FAIL {name}: {error}")
            browser.close()
    finally:
        for path in scratch.glob("*.txt"):
            path.unlink()
        scratch.rmdir()
    if failures:
        print(f"Web UX regression failed: {', '.join(failures)}")
        return 1
    print("Web UX regression passed: session identity, passive agents, live models, streams, permissions, slash commands")
    return 0


if __name__ == "__main__":
    sys.exit(main())
