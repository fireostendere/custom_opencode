#!/usr/bin/env python3
"""Real production web UI + fixture RPC: persistent session-scoped goal, no inference."""
import json
import importlib.util
from pathlib import Path
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("goal_web_harness", ROOT / "scripts/local-web-harness.py")
harness = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = harness
spec.loader.exec_module(harness)
goals = {"ses_fixture": {"id": "fixture", "status": "active", "objective": "Исправить <ошибку> и проверить результат", "summary": "Осталось прогнать тесты", "turns": 3, "failures": 0}}
commands = []


class Backend(harness.BrowserBackend):
    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/rpc/custom.goal/get":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert parse_qs(parsed.query).get("location[directory]")
            self.send_json({"output": {"goal": goals.get(body["input"]["sessionID"])}})
        elif parsed.path == "/api/session/ses_fixture/command":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["name"] == "goal"
            commands.append(body["text"])
            goals["ses_fixture"]["status"] = "paused" if body["text"] == "stop" else "active"
            self.send_json({"data": None})
        else:
            super().do_POST()


def main():
    harness.BrowserBackend = Backend
    with tempfile.TemporaryDirectory(prefix="goal-web-") as temp, harness.isolated_environment(Path(temp)):
        harness.reset_fixture_state()
        stack = harness.LocalStack(Path(temp))
        url = stack.start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
                context = browser.new_context(viewport={"width": 1280, "height": 850})
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                # The shared module is authenticated, not an accidental public leak.
                assert context.request.get(url + "/client-goal-view.js").status == 401
                page.goto(url)
                page.fill("#username", "opencode")
                page.fill("#password", "fixture-password")
                page.click("#loginSubmit")
                page.locator("#newSession").wait_for(state="visible")
                page.goto(url + "/#/session/ses_fixture")
                banner = page.locator("#goalBanner")
                banner.wait_for(state="visible")
                assert "Исправить <ошибку>" in banner.inner_text()
                assert "Осталось прогнать тесты" in banner.inner_text()
                assert "Достижение цели" in banner.inner_text()
                assert banner.locator("ошибку").count() == 0
                banner.locator('[data-goal-action="stop"]').click()
                page.wait_for_function("document.querySelector('#goalBanner').textContent.includes('Цель на паузе')")
                banner.locator('[data-goal-action="resume"]').click()
                page.wait_for_function("document.querySelector('#goalBanner').textContent.includes('Достижение цели')")
                assert commands == ["stop", "resume"]
                for status, label in [("blocked", "Цель заблокирована"), ("completed", "Цель достигнута")]:
                    goals["ses_fixture"]["status"] = status
                    page.evaluate("dispatchEvent(new CustomEvent('custom-opencode:event', {detail:{type:'rpc.custom.goal.updated',data:{sessionID:'ses_fixture'}}}))")
                    page.wait_for_function("label => document.querySelector('#goalBanner').textContent.includes(label)", arg=label)
                assert banner.locator("button").count() == 0
                page.reload()
                banner.wait_for(state="visible")
                assert "Цель достигнута" in banner.inner_text(), "reload lost the saved goal"
                page.set_viewport_size({"width": 390, "height": 844})
                assert banner.is_visible()
                assert banner.bounding_box()["width"] <= 390
                assert page.locator("#input").is_visible(), "goal must not push mobile input off screen"
                page.evaluate("location.hash = '#/session/ses_other'")
                banner.wait_for(state="hidden")
                assert not errors, errors
                browser.close()
        finally:
            stack.stop()
    print("Goal browser passed: authenticated module, objective/progress, stop/resume, blocked/completed, reload, mobile and session isolation; paid calls: 0")


if __name__ == "__main__":
    main()
