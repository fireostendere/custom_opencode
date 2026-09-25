#!/usr/bin/env python3
"""Real native engine + local MCP/provider fixtures; no paid inference or live campaign."""
import base64
import json
import os
from pathlib import Path
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
CAMPAIGN = "343ed859-02a4-41f0-85cc-a1b228c503c4"
requests = []


def mcp(path):
    for line in sys.stdin:
        message = json.loads(line)
        if "id" not in message:
            continue
        method = message["method"]
        if method == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "watch-fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "odm_narrator", "description": "Read-only ODM fixture", "inputSchema": {"type": "object", "properties": {"operation": {"type": "string"}}}}]}
        elif method == "tools/call":
            args = message["params"]["arguments"]
            assert args["operation"] == "read", args
            with open(path + ".reads", "a") as log:
                log.write(json.dumps(args) + "\n")
            result = {"content": [{"type": "text", "text": Path(path).read_text()}]}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        tools = {tool["function"]["name"] for tool in body.get("tools", [])}
        if "dnd_watch" in tools:
            requests.append(body)
        text = json.dumps(body.get("messages", []))
        start = "dnd_watch" in tools and "tool_call_id" not in text
        delta = {"tool_calls": [{"index": 0, "id": "call_watch", "type": "function", "function": {
            "name": "dnd_watch", "arguments": json.dumps({"action": "start", "campaignId": CAMPAIGN, "afterSeq": 10}),
        }}]} if start else {"content": "WOKEN" if "wake signal" in text else "WAITING"}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for change, finish in [(delta, None), ({}, "tool_calls" if start else "stop")]:
            chunk = {"id": "chatcmpl-watch", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                     "choices": [{"index": 0, "delta": change, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    binary = shutil.which("opencode2")
    assert binary, "opencode2 required"
    with tempfile.TemporaryDirectory(prefix="dnd-watch-", dir="/tmp/opencode") as temporary:
        home = Path(temporary)
        project = home / "project"
        project.mkdir()
        config = home / ".config/opencode"
        (config / "plugins").mkdir(parents=True)
        for name in ["dnd-watch.js", "orchestrated-qwen.js"]:
            shutil.copy2(ROOT / "config/plugins" / name, config / "plugins" / name)
        shutil.copy2(ROOT / "config/events.js", config / "events.js")
        state = home / "odm.json"
        state.write_text(json.dumps({"campaignId": CAMPAIGN, "currentSeq": 10, "nextCursor": 10, "hasMore": False, "messages": [], "events": [], "asks": []}))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        (config / "service.json").write_text(json.dumps({"hostname": "127.0.0.1", "port": port, "password": "watch-fixture"}))
        (config / "opencode.json").write_text(json.dumps({
            "update": "disable", "model": "fixture/fixture", "providers": {"fixture": {
                "package": "aisdk:@ai-sdk/openai-compatible", "name": "Local fixture",
                "settings": {"baseURL": f"http://127.0.0.1:{provider.server_port}/v1", "apiKey": "fixture"},
                "models": {"fixture": {"name": "Fixture", "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}, "limit": {"context": 32000, "output": 2048}}},
            }}, "agents": {"dnd-narrator": {"mode": "primary", "permissions": [
                {"action": "*", "resource": "*", "effect": "deny"},
                *[{"action": action, "resource": "*", "effect": "allow"} for action in ["dnd_watch", "odm_narrator_odm_narrator"]],
            ]}, "dnd-denied": {"mode": "primary", "permissions": [
                {"action": "*", "resource": "*", "effect": "deny"}, {"action": "dnd_watch", "resource": "*", "effect": "allow"},
            ]}}, "mcp": {"servers": {"odm_narrator": {"type": "local", "command": [sys.executable, str(Path(__file__).resolve()), "--mcp", str(state)]}}},
        }))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENCODE_", "CUSTOM_OPENCODE_", "XDG_"))}
        env["HOME"] = str(home)
        for key, folder in [("CONFIG", ".config"), ("DATA", ".local/share"), ("STATE", ".local/state"), ("CACHE", ".cache")]:
            env[f"XDG_{key}_HOME"] = str(home / folder)
        try:
            subprocess.run([binary, "service", "start"], env=env, cwd=project, check=True, capture_output=True, timeout=45)
            service = json.loads((home / ".local/state/opencode/service.json").read_text())
            headers = {"Authorization": "Basic " + base64.b64encode(("opencode:" + service["password"]).encode()).decode(), "Content-Type": "application/json"}

            def api(method, path, body=None):
                with urlopen(Request(service["url"] + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode()), timeout=15) as response:
                    raw = response.read()
                    return json.loads(raw).get("data") if raw else None

            def until(check):
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    value = check()
                    if value:
                        return value
                    time.sleep(.2)
                raise AssertionError("Timed out waiting for native watcher: " + json.dumps(api("GET", f"/api/session/{sid}/context"))[-6000:])

            sid = api("POST", "/api/session", {"title": "Watch acceptance", "agent": "dnd-narrator", "model": {"providerID": "fixture", "id": "fixture"}, "location": {"directory": str(project)}})["id"]
            query = "?" + urlencode({"location[directory]": str(project)})
            until(lambda: any(row["name"] == "odm_narrator" and row["status"]["status"] == "connected" for row in api("GET", "/api/mcp" + query)))
            api("POST", f"/api/session/{sid}/prompt", {"text": "Watch this campaign", "files": []})
            until(lambda: len(requests) >= 2)
            until(lambda: Path(str(state) + ".reads").exists())
            time.sleep(4)
            assert len(requests) == 2, "idle wait made model calls"
            state.write_text(json.dumps({"campaignId": CAMPAIGN, "currentSeq": 11, "nextCursor": 11, "hasMore": False, "messages": [{"seq": 11, "authorType": "player", "content": "PRIVATE INTENT"}], "events": [], "asks": []}))
            until(lambda: len(requests) == 3)
            until(lambda: "WOKEN" in json.dumps(api("GET", f"/api/session/{sid}/context")))
            assert "PRIVATE INTENT" not in json.dumps(requests), "wake leaked player text"
            time.sleep(4)
            assert len(requests) == 3, "one event woke the model twice"
            api("POST", f"/api/session/{sid}/command", {"command": "dnd-watch", "text": "status"})
            inbox = api("GET", f"/api/session/{sid}/inbox")
            assert any('"status":"triggered"' in item.get("payload", {}).get("text", "") for item in inbox), inbox
            api("POST", f"/api/session/{sid}/command", {"command": "dnd-watch", "text": "stop"})
            assert len(requests) == 3, "status/stop ran inference"

            # Nested polling must still use native MCP permission enforcement.
            read_log = Path(str(state) + ".reads")
            reads_before = read_log.read_text()
            sid = api("POST", "/api/session", {"title": "Denied read", "agent": "dnd-denied", "model": {"providerID": "fixture", "id": "fixture"}, "location": {"directory": str(project)}})["id"]
            api("POST", f"/api/session/{sid}/prompt", {"text": "Watch this campaign", "files": []})
            until(lambda: len(requests) == 6)
            assert read_log.read_text() == reads_before, "watcher bypassed denied MCP permission"
            assert "odm_read_failed" in json.dumps(requests[-1])

            state.write_text(json.dumps({"campaignId": CAMPAIGN, "currentSeq": 10, "nextCursor": 10, "hasMore": False, "messages": [], "events": [], "asks": []}))
            sid = api("POST", "/api/session", {"title": "Stop wait", "agent": "dnd-narrator", "model": {"providerID": "fixture", "id": "fixture"}, "location": {"directory": str(project)}})["id"]
            api("POST", f"/api/session/{sid}/prompt", {"text": "Watch this campaign", "files": []})
            until(lambda: len(requests) == 8)
            api("POST", f"/api/session/{sid}/command", {"command": "dnd-watch", "text": "stop"})
            reads_before = read_log.read_text()
            time.sleep(4)
            assert read_log.read_text() == reads_before and len(requests) == 8, "stop left a live poller"
            print("Native DnD watcher passed: tool call → idle MCP polling (0 model calls) → one synthetic continuation; status/stop without inference; denied MCP permission; live cancellation. Paid calls: 0")
        except Exception:
            log = home / ".local/share/opencode/log/opencode.log"
            if log.exists():
                print(log.read_text()[-7000:], file=sys.stderr)
            raise
        finally:
            subprocess.run([binary, "service", "stop"], env=env, cwd=project, capture_output=True, timeout=20)
            provider.shutdown()


if __name__ == "__main__":
    mcp(sys.argv[2]) if len(sys.argv) > 1 and sys.argv[1] == "--mcp" else main()
