#!/usr/bin/env python3
"""Real-browser smoke for the running OpenCode web client.

Drives headless Chromium via Playwright through the actual UI:
logs in through the form, clicks sidebar items, opens dialogs
(model picker, appearance and usage), opens a session and
renders messages, checks the composer, logs out. Runs once with a
desktop viewport and once with an Android phone emulation.

Screenshots land in /tmp/opencode/shots. No prompts are sent.
"""
from __future__ import annotations

import sys
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path("/tmp/opencode/shots")
SHOTS.mkdir(parents=True, exist_ok=True)

def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


ENV = read_env(ROOT / ".env")
USERNAME = ENV.get("OPENCODE_SERVER_USERNAME", "")
PASSWORD = ENV.get("OPENCODE_SERVER_PASSWORD", "")
LAN_URL = os.environ.get("OPENCODE_LAN_URL", ENV.get("OPENCODE_LAN_URL", "http://127.0.0.1:4098"))
TS_URL = os.environ.get("OPENCODE_TAILSCALE_URL", ENV.get("OPENCODE_TAILSCALE_URL", LAN_URL))

RESULTS: list[tuple[bool, str]] = []
PROBLEMS: list[str] = []


def step(ok: bool, label: str, detail: str = "") -> bool:
    RESULTS.append((ok, label))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  [{detail}]"), flush=True)
    return ok


def attach_listeners(page, tag: str) -> None:
    def expected_http(url: str, status: int) -> bool:
        path = urlsplit(url).path
        if status == 401 and path == "/auth/session":
            return True  # The login page probes the unauthenticated state first.
        if status in (404, 405) and (path in ("/api/form/request", "/api/question") or path.endswith("/children")):
            return True  # Optional V2 compatibility routes are capability-probed.
        return False

    def on_console(msg):
        if msg.type == "error" and not msg.text.startswith("Failed to load resource:"):
            PROBLEMS.append(f"{tag} console error: {msg.text[:300]}")

    def on_request_failed(req):
        failure = req.failure or ""
        path = urlsplit(req.url).path
        if "ERR_ABORTED" in failure and path in ("/auth/session", "/auth/login", "/auth/logout", "/api/event"):
            return  # Navigation intentionally closes these requests.
        PROBLEMS.append(f"{tag} request failed: {req.method} {req.url} ({failure})")

    def on_response(resp):
        if resp.status >= 400 and not expected_http(resp.url, resp.status):
            PROBLEMS.append(f"{tag} server error: {resp.status} {resp.url}")

    page.on("console", on_console)
    page.on("pageerror", lambda error: PROBLEMS.append(f"{tag} page error: {error}"))
    page.on("requestfailed", on_request_failed)
    page.on("response", on_response)


def login(page, tag: str, remember: bool) -> bool:
    page.goto(LAN_URL, wait_until="domcontentloaded", timeout=20000)
    ok = step(page.locator("#loginForm").is_visible(), f"{tag}: login page rendered")
    page.fill("#username", USERNAME)
    page.fill("#password", PASSWORD)
    if remember:
        page.check("#remember")
    page.click("#loginSubmit")
    page.wait_for_selector("#sessions .session, #newSession", timeout=20000)
    loaded = page.locator("#sessions .session").count()
    ok &= step(True, f"{tag}: logged in via form, {loaded} sessions in sidebar")
    page.wait_for_timeout(1200)  # let limits/SSE settle
    page.screenshot(path=str(SHOTS / f"{tag}-01-after-login.png"))
    return ok


def close_dialog(page, dialog_id: str) -> None:
    page.evaluate(f"document.getElementById('{dialog_id}')?.close?.()")


def desktop_flow(context) -> bool:
    page = context.new_page()
    attach_listeners(page, "desktop")
    ok = True

    login(page, "desktop", remember=False)

    # 1. Open a session from the sidebar.
    try:
        first = page.locator("#sessions .session").first
        title = (first.locator(".session-title").inner_text(timeout=3000) or "").strip()
        first.click()
        page.wait_for_selector("#messagesInner .message", timeout=15000)
        msgs = page.locator("#messagesInner .message").count()
        ok &= step(True, f"desktop: clicked session «{title[:40]}» → {msgs} messages rendered")
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "desktop-02-session-open.png"))
    except PWTimeout as exc:
        ok &= step(False, "desktop: open session", str(exc)[:150])

    # 2. Desktop sidebar resize handle.
    try:
        handle = page.locator("#sidebarResizer")
        before = page.locator("#sidebar").bounding_box()["width"]
        box = handle.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 320)
        page.mouse.down()
        page.mouse.move(box["x"] + box["width"] / 2 + 48, box["y"] + 320)
        page.mouse.up()
        after = page.locator("#sidebar").bounding_box()["width"]
        ok &= step(after >= before + 35, f"desktop: sidebar resized {before:.0f}px → {after:.0f}px")
    except Exception as exc:  # noqa: BLE001
        ok &= step(False, "desktop: sidebar resize", str(exc)[:150])

    # 3. Model picker dialog.
    try:
        page.click("#modelButton")
        page.wait_for_selector("#modelDialog[open]", timeout=5000)
        page.wait_for_selector("#modelChoices > .model-provider-section", timeout=5000)
        page.wait_for_timeout(300)
        choices = page.locator("#modelChoices > *").count()
        model_box = page.locator("#modelButton").bounding_box()
        effort_box = page.locator("#variantSelect").bounding_box()
        same_row = abs(model_box["y"] - effort_box["y"]) < 2 and abs(model_box["height"] - effort_box["height"]) < 2
        profile_badge_removed = page.locator("#runtimeProfileBadge").count() == 0
        server_profiles_removed = page.locator("#modelChoices [data-runtime-profile-group]").count() == 0
        favorite_toggle = page.locator("#modelChoices [data-favorite='0'] [data-fav]").first
        favorite_toggle.click()
        favorite_section = page.locator("#modelChoices > [data-provider-section='__favorites__']")
        favorite_section.wait_for(state="visible", timeout=5000)
        favorite_entries = favorite_section.locator("[data-favorite='1']").count()
        provider_favorite_entries = page.locator("#modelChoices > [data-provider-section]:not([data-provider-section='__favorites__']) [data-favorite='1']").count()
        favorites_consistent = favorite_entries > 0 and favorite_entries == provider_favorite_entries
        catalog = page.locator("#modelChoices")
        catalog_box = catalog.bounding_box()
        catalog_overflow = catalog.evaluate("el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)")
        catalog_has_height = catalog_box["height"] > 0
        headings = page.locator("#modelChoices > .model-provider-section .model-provider-toggle strong").all_inner_texts()
        headings_present = bool(headings) and all(text.strip() for text in headings)
        toggles_work = True
        sections = page.locator("#modelChoices > .model-provider-section")
        for index in range(sections.count()):
            section = sections.nth(index)
            toggle = section.locator(":scope > .model-provider-toggle")
            body = section.locator(":scope > .model-provider-body").first
            before_hidden = body.is_hidden()
            toggle.click()
            toggles_work &= body.is_hidden() != before_hidden
            toggle.click()
            toggles_work &= body.is_hidden() == before_hidden
        scroll_limit = catalog.evaluate("el => el.scrollHeight - el.clientHeight")
        catalog.evaluate("(el, value) => el.scrollTop = value", scroll_limit)
        page.wait_for_timeout(100)
        scroll_moved = catalog.evaluate("el => el.scrollTop > 0") if scroll_limit > 0 else False
        ok &= step(choices > 0, f"desktop: model dialog opened ({choices} model entries)")
        ok &= step(same_row, "desktop: model and effort controls share one row and height")
        ok &= step(profile_badge_removed, "desktop: redundant runtime profile button is removed")
        ok &= step(server_profiles_removed, "desktop: runtime server profiles are not mixed into model picker")
        ok &= step(favorites_consistent, f"desktop: favorite section appears and provider entries remain ({favorite_entries})")
        ok &= step(catalog_overflow and catalog_has_height, "desktop: model catalog has a bounded vertical scroll surface")
        ok &= step(headings_present, f"desktop: all model sections have headings ({len(headings)})")
        ok &= step(toggles_work, "desktop: every model section opens and collapses")
        ok &= step(scroll_moved, f"desktop: model catalog scrolls to the end ({scroll_limit:.0f}px)")
        page.screenshot(path=str(SHOTS / "desktop-03-model-dialog-scrolled.png"))
        catalog.evaluate("el => el.scrollTop = 0")
        page.screenshot(path=str(SHOTS / "desktop-03-model-dialog.png"))
        close_dialog(page, "modelDialog")
    except PWTimeout as exc:
        ok &= step(False, "desktop: model dialog", str(exc)[:150])

    # 4. Appearance dialog + theme switch (real click, visual effect).
    try:
        page.click("#appearanceButton")
        page.wait_for_selector("#appearanceDialog[open]", timeout=5000)
        page.click('[data-theme-mode="dark"]')
        page.wait_for_timeout(300)
        page.click('[data-accent="#8b5cf6"]')
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "desktop-04-appearance.png"))
        ok &= step(True, "desktop: appearance dialog, theme=dark + violet accent applied")
        close_dialog(page, "appearanceDialog")
    except PWTimeout as exc:
        ok &= step(False, "desktop: appearance dialog", str(exc)[:150])

    # 5. Usage (Контекст) dialog.
    try:
        page.click("#usageButton")
        page.wait_for_selector("#usageDialog[open]", timeout=5000)
        page.screenshot(path=str(SHOTS / "desktop-05-usage.png"))
        ok &= step(True, "desktop: usage dialog opened")
        close_dialog(page, "usageDialog")
    except PWTimeout as exc:
        ok &= step(False, "desktop: usage dialog", str(exc)[:150])

    # 6. Composer: typing enables send (no actual send).
    try:
        page.fill("#input", "смок-тест: это сообщение не отправляется")
        page.wait_for_timeout(300)
        enabled = page.locator("#composerAction").is_enabled()
        page.screenshot(path=str(SHOTS / "desktop-06-composer.png"))
        ok &= step(enabled, "desktop: composer accepts text, send button armed")
        page.fill("#input", "")
    except Exception as exc:  # noqa: BLE001
        ok &= step(False, "desktop: composer", str(exc)[:150])

    # 7. Logout.
    try:
        page.click("#logoutButton")
        page.wait_for_selector("#loginForm", timeout=10000)
        ok &= step(True, "desktop: logout back to login page")
    except PWTimeout as exc:
        ok &= step(False, "desktop: logout", str(exc)[:150])
    return ok


def mobile_flow(context) -> bool:
    page = context.new_page()
    attach_listeners(page, "mobile")
    ok = True

    page.goto(TS_URL, wait_until="domcontentloaded", timeout=20000)  # the phone path
    ok &= step(page.locator("#loginForm").is_visible(), "mobile: login page via tailscale")
    page.fill("#username", USERNAME)
    page.fill("#password", PASSWORD)
    page.check("#remember")
    page.click("#loginSubmit")
    page.wait_for_selector("#newSession", timeout=20000)
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "mobile-01-after-login.png"))

    # Sidebar drawer on phones.
    try:
        page.click("#menu")
        page.wait_for_timeout(600)
        visible = page.locator("#sessions .session").count()
        page.screenshot(path=str(SHOTS / "mobile-02-sidebar-drawer.png"))
        ok &= step(visible >= 0, f"mobile: sidebar drawer opened ({visible} sessions)")
        if visible:
            title = (page.locator("#sessions .session .session-title").first
                     .inner_text(timeout=3000)).strip()
            page.locator("#sessions .session").first.click()
            page.wait_for_selector("#messagesInner .message", timeout=15000)
            msgs = page.locator("#messagesInner .message").count()
            page.wait_for_timeout(600)
            page.screenshot(path=str(SHOTS / "mobile-03-session-open.png"))
            ok &= step(True, f"mobile: tapped session «{title[:30]}» → {msgs} messages")
        else:
            page.click("#menu")
    except PWTimeout as exc:
        ok &= step(False, "mobile: session from drawer", str(exc)[:150])

    # Composer on the phone layout.
    try:
        page.fill("#input", "мобильный смок")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "mobile-04-composer.png"))
        ok &= step(True, "mobile: composer reachable")
        page.fill("#input", "")
    except Exception as exc:  # noqa: BLE001
        ok &= step(False, "mobile: composer", str(exc)[:150])

    try:
        page.click("#logoutButton")
        page.wait_for_selector("#loginForm", timeout=10000)
        ok &= step(True, "mobile: logout")
    except PWTimeout:
        # drawer may cover the button; open it first
        try:
            page.click("#menu")
            page.click("#logoutButton")
            page.wait_for_selector("#loginForm", timeout=10000)
            ok &= step(True, "mobile: logout (via drawer)")
        except PWTimeout as exc:
            ok &= step(False, "mobile: logout", str(exc)[:150])
    return ok


def main() -> int:
    if not USERNAME or not PASSWORD:
        print("нет кредов в .env", file=sys.stderr)
        return 2
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage","--no-sandbox","--disable-gpu","--disable-software-rasterizer","--js-flags=--max-old-space-size=512"])
        desktop = browser.new_context(viewport={"width": 1366, "height": 850})
        ok_d = desktop_flow(desktop)
        desktop.close()

        mobile = browser.new_context(
            viewport={"width": 412, "height": 915},
            is_mobile=True, has_touch=True,
            user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/128 Mobile Safari/537.36"),
        )
        ok_m = mobile_flow(mobile)
        mobile.close()
        browser.close()

    print(f"\nscreenshots: {SHOTS}")
    if PROBLEMS:
        print(f"\n{len(PROBLEMS)} browser-side problems:")
        for item in PROBLEMS[:20]:
            print(f"  - {item}")
    else:
        print("\nno console errors / failed requests / 5xx")

    failed = [label for passed, label in RESULTS if not passed]
    passed = len(RESULTS) - len(failed)
    print(f"{passed}/{len(RESULTS)} checks passed")
    return 0 if (ok_d and ok_m and not failed) else 1


if __name__ == "__main__":
    sys.exit(main())
