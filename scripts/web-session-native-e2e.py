#!/usr/bin/env python3
"""Create empty chats through Chromium + production proxy + real native V2.

Only isolated temporary state and a non-networking dummy provider are used.
Missing native/browser dependencies are errors, never silently reported as PASS.
"""
from __future__ import annotations

import base64
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    binary = os.environ.get("OPENCODE2_BIN") or shutil.which("opencode2")
    if not binary:
        raise RuntimeError("Install the pinned opencode2 engine before native web regression")
    with tempfile.TemporaryDirectory(prefix="native-web-create-") as temporary:
        root = Path(temporary)
        home = root / "home"
        config = home / ".config/opencode"
        config.mkdir(parents=True)
        project = root / "project"
        project.mkdir()
        other = root / "Внешний проект with spaces"
        other.mkdir()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (config / "service.json").write_text(json.dumps({"hostname":"127.0.0.1", "port":port, "password":"isolated-fixture"}))
        (config / "opencode.json").write_text(json.dumps({
            "update":"disable", "model":"fixture/fixture", "providers":{"fixture":{
                "package":"aisdk:@ai-sdk/openai-compatible", "name":"Local fixture",
                "settings":{"baseURL":"http://127.0.0.1:1/v1", "apiKey":"fixture"},
                "models":{"fixture":{"name":"Fixture", "capabilities":{"tools":True,"input":["text"],"output":["text"]},"limit":{"context":32000,"output":2048}}},
            }},
        }))
        env = {key:value for key,value in os.environ.items() if not key.startswith(("OPENCODE_", "CUSTOM_OPENCODE_", "XDG_"))}
        env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or str(Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "ms-playwright")
        env.update(HOME=str(home), OPENCODE_DISABLE_AUTOUPDATE="1")
        for key, folder in [("CONFIG",".config"),("DATA",".local/share"),("STATE",".local/state"),("CACHE",".cache")]:
            env[f"XDG_{key}_HOME"] = str(home / folder)
        server = None
        features = None
        original_env = dict(os.environ)
        try:
            subprocess.run([binary,"service","start"], env=env, cwd=project, check=True, timeout=120)
            service = json.loads((home / ".local/state/opencode/service.json").read_text())
            headers = {"Content-Type":"application/json", "Authorization":"Basic " + base64.b64encode(("opencode:" + service["password"]).encode()).decode()}

            def api(method, path, body=None):
                request = Request(service["url"].rstrip("/") + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
                with urlopen(request, timeout=30) as response:
                    return json.load(response)

            seed = api("POST", "/api/session", {"title":"Existing session", "model":{"id":"fixture","providerID":"fixture"}, "location":{"directory":str(project)}})["data"]
            os.environ.clear()
            os.environ.update(env)
            os.environ.update({
                "OPENCODE_BACKEND_URL":service["url"], "OPENCODE_BACKEND_PASSWORD":service["password"],
                "OPENCODE_SERVER_USERNAME":"opencode", "OPENCODE_SERVER_PASSWORD":"fixture-password",
                "OPENCODE_WEB_ALLOW_LOCAL":"0", "OPENCODE_AUTH_ALLOW_BASIC":"0",
                "OPENCODE_SCRATCH_DIRECTORY":str(project), "OPENCODE_PROJECT_ROOTS":str(project),
                "CUSTOM_OPENCODE_FEATURE_STATE":str(root / "features.json"), "CUSTOM_OPENCODE_RUNTIME_DB":str(root / "runtime.sqlite3"),
                "MCP_RAG_ENABLED":"0", "OPENCODE_RESOURCE_SCHEDULER":"off",
            })
            sys.path.insert(0, str(ROOT / "app"))
            import server_workflow
            features = server_workflow.features
            server_workflow.runtime.PLAN_DIRECTORY = root
            server = ThreadingHTTPServer(("127.0.0.1",0), server_workflow.Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            with sync_playwright() as pw:
                options = {"headless":True, "args":["--no-sandbox"]}
                if original_env.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                    options["executable_path"] = original_env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
                with pw.chromium.launch(**options) as browser:
                    for mobile in [False, True]:
                        with browser.new_context(viewport={"width":390 if mobile else 1440,"height":900}, is_mobile=mobile, has_touch=mobile) as context:
                            page = context.new_page()
                            errors = []
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            page.goto(f"http://127.0.0.1:{server.server_port}")
                            page.locator("#username").fill("opencode")
                            page.locator("#password").fill("fixture-password")
                            page.locator("#loginSubmit").click()
                            if mobile:
                                page.locator("#menu").click()
                            page.locator(f'[data-session="{seed["id"]}"]').click(timeout=60000)
                            page.wait_for_function("id => location.hash.endsWith(id)", arg=seed["id"])
                            for target in [project, other]:
                                if mobile:
                                    page.locator("#menu").click()
                                previous_hash = page.evaluate("location.hash")
                                page.locator("#newSession").click()
                                if target == project:
                                    page.locator(f'#projectChoices [data-project="{seed["projectID"]}"]').click()
                                else:
                                    page.locator("#projectPathInput").fill(str(target))
                                    page.locator("#projectPathForm button").click()
                                page.wait_for_function("previous => !document.querySelector('#projectDialog').open && location.hash !== previous", arg=previous_hash, timeout=20000)
                                sid = page.evaluate("location.hash.split('/').at(-1)")
                                expect(page.locator("#headerTitle")).to_have_text("Новая сессия")
                                expect(page.locator("#headerSub")).to_contain_text(str(target))
                                expect(page.locator("#messagesInner .welcome")).to_have_text("Пока нет сообщений.")
                                expect(page.locator("#input")).to_have_value("")
                                detail = api("GET", f"/api/session/{sid}")["data"]
                                assert detail["location"]["directory"] == str(target), detail
                                assert detail["id"] != seed["id"]
                                messages = api("GET", f"/api/session/{sid}/message?limit=20")
                                assert messages.get("data") == [], messages
                                page.reload()
                                expect(page.locator("#headerSub")).to_contain_text(str(target), timeout=20000)
                                expect(page.locator("#messagesInner article")).to_have_count(0)
                                expect(page.locator("#sessions .project-group .session.active")).to_have_count(1)
                                print(f"PASS native {'mobile' if mobile else 'desktop'}: {target.name}, empty persisted session {sid}")
                            assert not errors, errors
        finally:
            if server:
                server.shutdown()
                server.server_close()
            if features and not features._stop_worker(timeout=30):
                raise RuntimeError("Native web regression worker did not stop")
            subprocess.run([binary,"service","stop"], env=env, cwd=project, timeout=30, check=False)
            os.environ.clear()
            os.environ.update(original_env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
