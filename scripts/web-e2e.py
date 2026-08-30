#!/usr/bin/env python3
"""Small Playwright E2E checks for the running OpenCode web client.

The server and browser are real; only permission responses are mocked so the
test never sends a real permission reply or spends model tokens.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import Page, Route, TimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "http://127.0.0.1:4098"
TIMEOUT = 15_000


def read_env() -> dict[str, str]:
    values = dict(os.environ)
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values.setdefault(key.strip(), value.strip())
    return values


ENV = read_env()
BASE_URL = ENV.get("OPENCODE_E2E_URL", DEFAULT_URL).rstrip("/")
USERNAME = ENV.get("OPENCODE_SERVER_USERNAME", "")
PASSWORD = ENV.get("OPENCODE_SERVER_PASSWORD", "")


def session_id(page: Page) -> str:
    path = urlsplit(page.url).fragment
    if not path.startswith("/session/"):
        raise AssertionError(f"session route was not selected: {page.url}")
    return unquote(path.removeprefix("/session/").split("/", 1)[0])


def login(page: Page) -> None:
    page.goto(BASE_URL, wait_until="domcontentloaded", timeout=TIMEOUT)
    login_form = page.locator("#loginForm")
    if login_form.count() and login_form.first.is_visible():
        if not USERNAME or not PASSWORD:
            raise AssertionError("OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD are required for cookie login")
        page.fill("#username", USERNAME)
        page.fill("#password", PASSWORD)
        page.click("#loginSubmit")
    page.locator("#sessions .session").first.wait_for(state="visible", timeout=TIMEOUT)


def open_first_session(page: Page) -> str:
    menu = page.locator("#menu")
    if menu.is_visible():
        menu.click()
    page.locator("#sessions .session").first.click()
    page.wait_for_function("location.hash.startsWith('#/session/')", timeout=TIMEOUT)
    sid = session_id(page)
    page.locator("#messagesInner").wait_for(state="visible", timeout=TIMEOUT)
    return sid


def test_desktop_model_dialog(page: Page) -> None:
    login(page)
    open_first_session(page)
    page.locator("#modelButton").wait_for(state="visible", timeout=TIMEOUT)
    page.locator("#modelButton").wait_for(state="attached", timeout=TIMEOUT)
    page.wait_for_function("!document.querySelector('#modelButton').disabled", timeout=TIMEOUT)
    page.click("#modelButton")
    page.locator("#modelDialog[open]").wait_for(state="visible", timeout=TIMEOUT)
    assert page.locator("#modelChoices .choice").count() > 0, "model picker is empty"
    assert page.locator("#modelChoices").evaluate(
        "el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)"
    ), "model catalog is not scrollable"
    page.locator("#modelDialog [data-close='modelDialog']").click()
    page.locator("#modelDialog[open]").wait_for(state="detached", timeout=5_000)


def permission_response(page: Page, route: Route) -> None:
    sid = session_id(page)
    route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps([{
            "sessionID": sid,
            "requestID": "e2e-permission-1",
            "action": "shell",
            "resources": ["echo e2e"],
        }]),
    )


def reply_response(route: Route) -> None:
    route.fulfill(status=200, content_type="application/json", body='{"ok":true}')


def quiet_risk_response(route: Route) -> None:
    route.fulfill(status=200, content_type="application/json", body='{"stale":true}')


def test_mobile_permission_lifecycle(page: Page) -> None:
    page.route("**/api/permission/request*", lambda route: permission_response(page, route))
    page.route("**/permission/*/reply", reply_response)
    page.route("**/client-permission-risk.json*", quiet_risk_response)
    login(page)
    sid = open_first_session(page)
    assert sid

    page.locator("#permissionBanner").wait_for(state="visible", timeout=5_000)
    assert page.locator("#permissionBanner").get_attribute("data-permission-id") == "e2e-permission-1"
    page.locator("#permissionBanner [data-permission='once']").click()
    page.wait_for_function("document.querySelector('#permissionBanner').hidden", timeout=5_000)

    # Covers app.js, access-fix.js and control-plane.js polling races.
    page.wait_for_timeout(2_200)
    assert page.locator("#permissionBanner").is_hidden(), "permission banner reappeared after reply"


def run_test(name: str, test, context_options: dict) -> bool:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(**context_options)
        page = context.new_page()
        try:
            test(page)
            print(f"PASS  {name}")
            return True
        except (AssertionError, TimeoutError) as exc:
            print(f"FAIL  {name}: {exc}", file=sys.stderr)
            return False
        finally:
            context.close()
            browser.close()


def main() -> int:
    desktop = run_test("desktop model dialog", test_desktop_model_dialog, {
        "base_url": BASE_URL,
        "viewport": {"width": 1366, "height": 850},
    })
    mobile = run_test("mobile permission lifecycle", test_mobile_permission_lifecycle, {
        "base_url": BASE_URL,
        "viewport": {"width": 412, "height": 915},
        "is_mobile": True,
        "has_touch": True,
        "user_agent": (
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/128 Mobile Safari/537.36"
        ),
    })
    return 0 if desktop and mobile else 1


if __name__ == "__main__":
    raise SystemExit(main())
