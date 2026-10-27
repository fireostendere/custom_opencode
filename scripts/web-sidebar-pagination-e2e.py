#!/usr/bin/env python3
"""Real desktop/mobile sidebar: bounded loading, scroll, retry and server search."""
from pathlib import Path
import runpy
import tempfile
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def check(browser, base_url, width, harness):
    context = browser.new_context(viewport={"width": width, "height": 850})
    page = context.new_page()
    errors, reads, pending, metadata = [], [], [], []
    holding_metadata = True
    page.on("pageerror", lambda error: errors.append(str(error)))

    def session(index):
        return {**harness.BrowserBackend.session(str(ROOT)), "id": f"chat_{index}",
                "title": f"Chat {index:03d}", "tokens": {"input": 1},
                "time": {"updated": 2_000_000_000_000 - index}}

    def listing(route):
        query = parse_qs(urlsplit(route.request.url).query)
        reads.append(query)
        if query.get("search") == ["needle"]:
            route.fulfill(json={"data": [{**session(999), "title": "needle"}], "cursor": {"next": None}})
        elif "cursor" in query:
            pending.append(route)
            page.evaluate("window.__sidebarPageRequests = (window.__sidebarPageRequests || 0) + 1")
        else:
            route.fulfill(json={"data": [session(i) for i in range(50)], "cursor": {"next": "older"}})

    def fulfill_metadata(route):
        route.fulfill(json={"data": [] if urlsplit(route.request.url).path == "/api/project" else {}})

    def read_metadata(route):
        if holding_metadata:
            metadata.append(route)
        else:
            fulfill_metadata(route)

    page.route("**/api/session?*", listing)
    page.route("**/api/project", read_metadata)
    page.route("**/api/session/active", read_metadata)
    # Login without waiting for the mobile drawer (initially off-screen).
    page.goto(base_url, wait_until="domcontentloaded")
    page.fill("#username", "opencode")
    page.fill("#password", "fixture-password")
    page.click("#loginSubmit")
    page.locator('[data-session="chat_0"]').wait_for(state="attached")
    if width < 760:
        page.locator("#menu").click()
        page.locator("#sidebar.open").wait_for()
    page.locator('[data-session="chat_0"]').wait_for(state="visible")
    assert len(reads) == 1 and reads[0]["limit"] == ["50"], reads
    assert page.locator("[data-session-node]").count() == 50
    # Neither still-pending projects nor activity prevented those rows appearing.
    holding_metadata = False
    while metadata:
        fulfill_metadata(metadata.pop())

    sidebar = page.locator("#sessions")
    sidebar.evaluate("el => el.scrollTop = el.scrollHeight")
    page.wait_for_function("document.querySelector('#sessions').textContent.includes('Загрузка ещё')")
    # The spinner is painted before fetch reaches the intercepted network route.
    page.wait_for_function("window.__sidebarPageRequests === 1")
    assert len(pending) == 1, reads
    assert page.locator("[data-session-node]").count() == 50
    before = sidebar.evaluate("el => el.scrollTop")
    # A failed page must not remove rows or trigger an automatic retry storm.
    pending.pop().fulfill(status=503, body="fixture offline")
    page.get_by_role("button", name="Не удалось загрузить — повторить").wait_for()
    assert len(reads) == 2
    page.get_by_role("button", name="Не удалось загрузить — повторить").click()
    page.wait_for_function("document.querySelector('#sessions').textContent.includes('Загрузка ещё')")
    page.wait_for_function("window.__sidebarPageRequests === 2")
    assert len(pending) == 1
    pending.pop().fulfill(json={"data": [session(i) for i in range(50, 100)], "cursor": {"next": None}})
    page.wait_for_function("document.querySelectorAll('[data-session-node]').length === 100")
    assert abs(sidebar.evaluate("el => el.scrollTop") - before) <= 1
    assert not page.locator("[data-session-load-more]").count()

    page.fill("#search", "needle")
    page.locator('[data-session="chat_999"]').wait_for(state="visible")
    assert reads[-1].get("search") == ["needle"], reads
    assert not errors, errors
    context.close()
    print(f"Sidebar pagination passed at {width}px: first 50, independent metadata, scroll, retry, position, server search")


def main():
    harness = runpy.run_path(str(ROOT / "scripts/web-critical-controls-e2e.py"))["load_harness"]()
    with tempfile.TemporaryDirectory(prefix="opencode-sidebar-") as temp:
        root = Path(temp)
        with harness.isolated_environment(root):
            harness.reset_fixture_state()
            stack = harness.LocalStack(root)
            base_url = stack.start()
            stack.server.RequestHandlerClass.log_message = lambda *args: None
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
                    try:
                        for width in (1366, 390):
                            check(browser, base_url, width, harness)
                    finally:
                        browser.close()
            finally:
                stack.stop()
                import server_workflow
                assert server_workflow.features._stop_worker()


if __name__ == "__main__":
    main()
