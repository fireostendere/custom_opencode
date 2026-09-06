#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
env = {}
for line in (ROOT / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage","--no-sandbox","--disable-gpu","--disable-software-rasterizer","--js-flags=--max-old-space-size=512"])
    page = browser.new_page(viewport={"width": 1366, "height": 850})
    events = []
    page.on("console", lambda m: events.append(f"console[{m.type}] {m.text[:200]}"))
    page.on("requestfailed", lambda r: events.append(f"reqfail {r.method} {r.url} {r.failure}"))
    page.on("response", lambda r: events.append(f"http {r.status} {r.url[:90]}") if r.status >= 400 else None)
    page.on("crash", lambda p: events.append("PAGE CRASHED"))

    page.goto(env.get("OPENCODE_E2E_URL", "http://127.0.0.1:4098"), wait_until="domcontentloaded", timeout=20000)
    page.fill("#username", env["OPENCODE_SERVER_USERNAME"])
    page.fill("#password", env["OPENCODE_SERVER_PASSWORD"])
    page.click("#loginSubmit")
    page.wait_for_timeout(6000)
    print("URL:", page.url)
    print("title:", page.title())
    try:
        sessions_html = page.evaluate("document.getElementById('sessions').innerText.slice(0,300)")
        print("sessions box:", repr(sessions_html))
    except Exception as exc:
        print("sessions box error:", exc)
    try:
        print("session count:", page.locator("#sessions .session").count())
    except Exception as exc:
        print("count error:", exc)
    print("--- events ---")
    for e in events[:40]:
        print(e)
    try:
        page.screenshot(path="/tmp/opencode/shots/debug-1.png", timeout=8000)
        print("screenshot ok")
    except Exception as exc:
        print("screenshot FAILED:", str(exc)[:200])
    browser.close()
