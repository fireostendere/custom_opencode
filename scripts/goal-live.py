#!/usr/bin/env python3
"""Exercise /goal on the pinned native engine with a local provider; no paid calls."""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
requests = []
goal_calls = {}
hold = threading.Event()


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        serialized = json.dumps(body.get("messages", []))
        match = re.search(r"Goal ID: ([0-9a-f-]+)", serialized)
        tools = {tool["function"]["name"] for tool in body.get("tools", [])}
        call = None
        if match and "goal_update" in tools:
            goal_id = match.group(1)
            goal_calls[goal_id] = goal_calls.get(goal_id, 0) + 1
            if "hold-goal" in serialized:
                hold.wait(30)
            if goal_calls[goal_id] > 1 or "blocked-goal" in serialized:
                status = "blocked" if "blocked-goal" in serialized else "completed"
                call = {"index": 0, "id": "call_goal_" + str(goal_calls[goal_id]), "type": "function", "function": {
                    "name": "goal_update", "arguments": json.dumps({"goalID": goal_id, "status": status, "summary": "Needs user input" if status == "blocked" else "Verified fixture result"}),
                }}
        delta = {"tool_calls": [call]} if call else {"content": "VERIFIED" if 'Verified fixture result' in serialized else "PARTIAL"}
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for change, finish in [(delta, None), ({}, "tool_calls" if call else "stop")]:
                chunk = {"id": "chatcmpl-goal", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                         "choices": [{"index": 0, "delta": change, "finish_reason": finish}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    binary = shutil.which("opencode2")
    assert binary, "opencode2 required"
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="goal-native-") as temporary:
        home = Path(temporary)
        project = home / "project"
        project.mkdir()
        config = home / ".config/opencode"
        plugins = config / "plugins"
        plugins.mkdir(parents=True)
        (plugins / "goal.js").write_text(f'export {{ default }} from {json.dumps((ROOT / "config/plugins/goal.js").as_uri())};\n')
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        (config / "service.json").write_text(json.dumps({"hostname": "127.0.0.1", "port": port, "password": "goal-fixture"}))
        (config / "opencode.json").write_text(json.dumps({
            "update": "disable", "model": "fixture/fixture", "permissions": [{"action": "goal_update", "resource": "*", "effect": "allow"}],
            "providers": {"fixture": {"package": "aisdk:@ai-sdk/openai-compatible", "name": "Local goal fixture",
                "settings": {"baseURL": f"http://127.0.0.1:{provider.server_port}/v1", "apiKey": "fixture"},
                "models": {"fixture": {"name": "Fixture", "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}, "limit": {"context": 262144, "output": 2048}}},
            }},
        }))
        env = {key: value for key, value in os.environ.items() if not key.startswith(("OPENCODE_", "CUSTOM_OPENCODE_", "XDG_"))}
        env.update(HOME=str(home), OPENCODE_DISABLE_AUTOUPDATE="1")
        for key, folder in [("CONFIG", ".config"), ("DATA", ".local/share"), ("STATE", ".local/state"), ("CACHE", ".cache")]:
            env[f"XDG_{key}_HOME"] = str(home / folder)

        def service(action):
            result = subprocess.run([binary, "service", action], env=env, cwd=project, capture_output=True, text=True, timeout=45)
            assert result.returncode == 0, result.stderr or result.stdout

        def api(method, path, body=None):
            state = json.loads((home / ".local/state/opencode/service.json").read_text())
            headers = {"Authorization": "Basic " + base64.b64encode(("opencode:" + state["password"]).encode()).decode(), "Content-Type": "application/json"}
            path += "?" + urlencode({"location[directory]": str(project)})
            with urlopen(Request(state["url"] + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode()), timeout=15) as response:
                raw = response.read()
                return json.loads(raw).get("data") if raw else None

        def until(check):
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if value := check():
                    return value
                time.sleep(.1)
            raise AssertionError("Timed out waiting for native goal")

        def session():
            return api("POST", "/api/session", {"agent": "build", "model": {"providerID": "fixture", "id": "fixture"}, "location": {"directory": str(project)}})["id"]

        def command(sid, text):
            return api("POST", f"/api/session/{sid}/command", {"command": "goal", "text": text})

        def status(sid, expected):
            command(sid, "status")
            inbox = api("GET", f"/api/session/{sid}/inbox")
            return any(f"Goal: {expected}" in item.get("payload", {}).get("text", "") for item in inbox)

        try:
            service("start")
            sid = session()
            command(sid, "finite-goal: finish the fixture")
            until(lambda: "VERIFIED" in json.dumps(api("GET", f"/api/session/{sid}/context")))
            assert list(goal_calls.values()) == [2], goal_calls
            until(lambda: status(sid, "completed"))
            before = len(requests)
            time.sleep(1.5)
            command(sid, "status")
            assert len(requests) == before, "completed goal or status triggered inference"

            sid = session()
            command(sid, "blocked-goal: requires user input")
            until(lambda: status(sid, "blocked"))
            before = len(requests)
            time.sleep(1.5)
            assert len(requests) == before, "blocked goal kept calling the model"

            sid = session()
            command(sid, "hold-goal: stop and recover")
            until(lambda: len(goal_calls) == 3)
            command(sid, "stop")
            hold.set()
            until(lambda: status(sid, "paused"))
            before = len(requests)
            time.sleep(1.5)
            assert len(requests) == before, "stop did not cancel continuation"
            command(sid, "resume")
            until(lambda: status(sid, "completed"))

            # Stop the service during a held turn: native plugin storage must restore
            # the active goal, while completed and blocked sessions stay parked.
            hold.clear()
            sid = session()
            command(sid, "hold-goal: restart recovery")
            until(lambda: len(goal_calls) == 4)
            service("stop")
            hold.set()
            service("start")
            until(lambda: status(sid, "completed"))
            before = len(requests)
            time.sleep(1.5)
            assert len(requests) == before, "restart revived a completed or blocked goal"
            print("Native goal passed: premature final resumes, verified completion stops, zero-call status/stop, user blocker, stop/resume and active restart recovery. Paid model calls: 0")
        except Exception:
            print(f"Provider requests: {len(requests)}; goal calls: {goal_calls}", file=sys.stderr)
            try:
                command(sid, "status")
                print(json.dumps(api("GET", f"/api/session/{sid}/inbox"))[-4000:], file=sys.stderr)
                print(json.dumps(api("GET", f"/api/session/{sid}")), file=sys.stderr)
            except Exception as error:
                print(error, file=sys.stderr)
            log = home / ".local/share/opencode/log/opencode.log"
            if log.exists():
                print(log.read_text()[-6000:], file=sys.stderr)
            raise
        finally:
            hold.set()
            service("stop")
            provider.shutdown()


if __name__ == "__main__":
    main()
