#!/usr/bin/env python3
"""New-session UI regression against the production web handler; no inference."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("session_create_harness", ROOT / "scripts/local-web-harness.py")
assert spec and spec.loader
harness = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = harness
spec.loader.exec_module(harness)


class Backend(harness.fixture.Backend):
    attempts = 0
    reject = False
    create_entered = threading.Event()
    create_release = threading.Event()
    controls_release = threading.Event()
    controls_entered = threading.Event()

    def do_POST(self):
        if urlsplit(self.path).path == "/api/session":
            type(self).attempts += 1
            self.create_entered.set()
            if not self.create_release.wait(15):
                self.send_json({"error": "create gate timed out"}, status=504)
                return
            if self.reject:
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_json({"error": "fixture: project temporarily unavailable"}, status=503)
                return
        super().do_POST()

    def do_GET(self):
        if urlsplit(self.path).path == "/api/model":
            self.controls_entered.set()
            self.controls_release.wait(15)
        super().do_GET()


def new_dialog(page):
    if not page.locator("#newSession").is_visible():
        page.locator("#menu").click()
    page.locator("#newSession").click()
    expect(page.locator("#projectDialog")).to_be_visible()


def assert_empty(page, directory, *, reload=False):
    page.wait_for_function("!document.querySelector('#projectDialog').open && location.hash.startsWith('#/session/ses_created_')")
    sid = page.evaluate("location.hash.split('/').at(-1)")
    if reload:
        page.reload()
    expect(page.locator("#headerTitle")).to_have_text("Новая сессия")
    expect(page.locator("#headerSub")).to_contain_text(directory)
    expect(page.locator("#messagesInner .welcome")).to_have_text("Пока нет сообщений.")
    expect(page.locator("#messagesInner article")).to_have_count(0)
    expect(page.locator("#input")).to_have_value("")
    expect(page.locator(f'#sessions .project-group .session.active [data-session="{sid}"]')).to_have_count(1)
    created = harness.fixture.FixtureState.created_sessions[sid]
    assert created["location"]["directory"] == directory, created
    return sid


def exercise(browser, base_url, root, mobile=False):
    context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1000}, is_mobile=mobile, has_touch=mobile)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    harness.fixture.login(page, base_url)
    harness.fixture.open_session(page)
    expect(page.locator("#modelButton")).to_be_enabled()
    page.locator("#input").fill("Сохранить старый черновик")
    old_hash = page.evaluate("location.hash")
    target = os.environ["FIXTURE_OTHER_PROJECT"]

    # A failed/slow create must not dismiss the chooser or destroy the old chat.
    Backend.create_entered.clear()
    Backend.create_release.clear()
    Backend.reject = True
    count = Backend.attempts
    new_dialog(page)
    choice = page.locator('#projectChoices [data-project="proj_other"]')
    choice.click()
    page.wait_for_function("document.querySelector('#projectDialog').getAttribute('aria-busy') === 'true'")
    assert Backend.create_entered.wait(2)
    expect(choice).to_be_disabled()
    expect(page.locator("#projectSelectionStatus")).to_contain_text("Создаётся")
    page.keyboard.press("Escape")
    expect(page.locator("#projectDialog")).to_be_visible()
    # The bridge itself must reject duplicate creation, not just disable the UI.
    page.evaluate("directory => { void window.CustomOpenCodeProjects.selectDirectory(directory) }", target)
    Backend.create_release.set()
    expect(page.locator('#projectSelectionStatus[data-state="error"]')).to_contain_text("project temporarily unavailable")
    expect(page.locator("#projectDialog")).to_be_visible()
    expect(choice).to_be_enabled()
    assert page.evaluate("location.hash") == old_hash
    expect(page.locator("#input")).to_have_value("Сохранить старый черновик")
    assert Backend.attempts == count + 1

    # Successful retry must open immediately even if the model catalog stalls.
    Backend.reject = False
    Backend.controls_release.clear()
    Backend.controls_entered.clear()
    choice.click()
    sid = assert_empty(page, target)
    assert Backend.controls_entered.wait(2)
    assert not Backend.controls_release.is_set()
    assert Backend.attempts == count + 2
    assert page.locator("#input").evaluate("el => el === document.activeElement")
    Backend.controls_release.set()
    assert assert_empty(page, target, reload=True) == sid
    saved = page.evaluate("JSON.parse(localStorage.getItem('opencode:web:drafts-v2'))")
    assert saved["ses_fixture"] == "Сохранить старый черновик", saved

    # Browser selection, child-folder creation, and exact paths share the same flow.
    new_dialog(page)
    page.locator("#browseProjects").click()
    existing = os.environ["FIXTURE_EXISTING_PROJECT"]
    page.locator(f'[data-directory="{existing}"]').click()
    page.locator("[data-open-directory]").click()
    assert_empty(page, existing, reload=True)

    new_dialog(page)
    page.locator("#browseProjects").click()
    child = "mobile child" if mobile else "desktop child"
    page.locator('[data-create-directory] input').fill(child)
    page.locator('[data-create-directory] button').click()
    assert_empty(page, str(Path(os.environ["FIXTURE_PROJECT"]) / child), reload=True)

    new_dialog(page)
    arbitrary = str(root / "Внешний проект with spaces")
    Path(arbitrary).mkdir(exist_ok=True)
    page.locator("#projectPathInput").fill(arbitrary)
    page.locator("#projectPathForm button").click()
    assert_empty(page, arbitrary, reload=True)
    assert not errors, errors
    context.close()
    print(f"PASS {'mobile' if mobile else 'desktop'}: pending, failure/retry, duplicate guard, slow controls, known/browser/child/exact paths, empty chat, draft isolation, reload")


def main():
    with tempfile.TemporaryDirectory(prefix="web-session-create-") as tmp:
        root = Path(tmp)
        with harness.isolated_environment(root):
            harness.reset_fixture_state()
            harness.BrowserBackend = Backend
            Backend.create_release.set()
            Backend.controls_release.set()
            stack = harness.LocalStack(root)
            try:
                base_url = stack.start()
                with sync_playwright() as pw:
                    options = {"headless": True, "args": ["--no-sandbox"]}
                    if os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                        options["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
                    browser = pw.chromium.launch(**options)
                    try:
                        exercise(browser, base_url, root)
                        exercise(browser, base_url, root, mobile=True)
                    finally:
                        Backend.create_release.set()
                        Backend.controls_release.set()
                        browser.close()
            finally:
                Backend.create_release.set()
                Backend.controls_release.set()
                stack.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
