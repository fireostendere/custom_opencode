#!/usr/bin/env python3
"""Critical browser regression for changing a model in an existing chat.

Runs the production web handler against the isolated fixture backend from
local-web-harness.py and exercises the exact user-facing model picker.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HARNESS_PATH = ROOT / "scripts" / "local-web-harness.py"


def load_harness():
    spec = importlib.util.spec_from_file_location("custom_opencode_local_web_harness", HARNESS_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {HARNESS_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    harness = load_harness()
    with tempfile.TemporaryDirectory(prefix="custom-opencode-critical-web-") as temp:
        root = Path(temp)
        with harness.isolated_environment(root):
            harness.reset_fixture_state()
            stack = harness.LocalStack(root)
            base_url = stack.start()
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(
                        headless=True,
                        args=["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
                    )
                    context = browser.new_context(viewport={"width": 1366, "height": 850})
                    page = context.new_page()
                    problems: list[str] = []
                    page.on("pageerror", lambda error: problems.append(f"page error: {error}"))
                    page.on(
                        "console",
                        lambda message: problems.append(f"console error: {message.text}")
                        if message.type == "error" and not message.text.startswith("Failed to load resource:")
                        else None,
                    )

                    page.goto(base_url, wait_until="domcontentloaded", timeout=20_000)
                    page.locator("#loginForm").wait_for(state="visible", timeout=10_000)
                    page.fill("#username", "opencode")
                    page.fill("#password", "fixture-password")
                    page.click("#loginSubmit")
                    page.locator("#newSession").wait_for(state="visible", timeout=20_000)
                    page.locator("#sessions .session").first.wait_for(state="visible", timeout=20_000)

                    harness.BrowserBackend.model_delay_seconds = 0.35
                    page.locator('[data-session="ses_fixture"]').click()
                    page.wait_for_function("location.hash.startsWith('#/session/ses_fixture')", timeout=5_000)
                    assert page.locator("#modelButton").is_disabled(), "model picker enabled before its catalog loaded"
                    page.wait_for_function("!document.querySelector('#modelButton').disabled", timeout=5_000)

                    # A concrete model entry in an existing chat must remain clickable after
                    # ui-enhancements.js re-groups the catalog and modal-ui restores history.
                    page.click("#modelButton")
                    page.locator("#modelDialog[open]").wait_for(state="visible", timeout=5_000)
                    page.locator("#modelChoices > .model-provider-section").first.wait_for(
                        state="visible", timeout=5_000
                    )
                    target = page.locator(
                        '#modelChoices button[data-provider="bailian-cli"][data-model="qwen-fixture-01"]'
                    ).first
                    target.wait_for(state="visible", timeout=5_000)
                    page.evaluate("""addEventListener('popstate', () => {
                        const root = document.querySelector('#modelChoices')
                        root.innerHTML = root.innerHTML
                    }, { once:true })""")
                    with page.expect_response(
                        lambda response: urlsplit(response.url).path == "/api/session/ses_fixture/model"
                        and response.request.method == "POST",
                        timeout=5_000,
                    ) as model_response:
                        target.click()
                    assert model_response.value.ok, model_response.value.status
                    page.wait_for_function("!document.querySelector('#modelDialog').open", timeout=5_000)
                    page.wait_for_function(
                        "document.querySelector('#modelButton').textContent.includes('Qwen Fixture 01')",
                        timeout=5_000,
                    )

                    # Re-open the catalog to ensure the selected state is renderable, not just
                    # a one-shot POST side effect.
                    page.click("#modelButton")
                    page.locator("#modelDialog[open]").wait_for(state="visible", timeout=5_000)
                    page.wait_for_function(
                        """() => [...document.querySelectorAll('#modelChoices button[data-model="qwen-fixture-01"] .choice-title')]
                            .some((node) => node.textContent.includes('✓'))""",
                        timeout=5_000,
                    )

                    orchestrated = page.locator(
                        '#modelChoices button[data-provider="bailian-cli"][data-model="qwen3.8-orchestrated"]'
                    ).first
                    provider = orchestrated.locator("xpath=ancestor::section[1]")
                    toggle = provider.locator(":scope > .model-provider-toggle")
                    toggle.click()
                    toggle.click()
                    page.locator("#modelChoices").evaluate("el => el.scrollTop = el.scrollHeight")
                    orchestrated.scroll_into_view_if_needed()
                    with page.expect_response(
                        lambda response: urlsplit(response.url).path == "/api/session/ses_fixture/model"
                        and response.request.method == "POST",
                        timeout=5_000,
                    ) as orchestrated_response:
                        orchestrated.click()
                    assert orchestrated_response.value.ok, orchestrated_response.value.status
                    page.wait_for_function("!document.querySelector('#modelDialog').open", timeout=5_000)
                    page.wait_for_function("!document.documentElement.dataset.modelTransition", timeout=5_000)
                    page.wait_for_function(
                        "document.querySelector('#modelButton').textContent.includes('Orchestrated')",
                        timeout=5_000,
                    )
                    assert 'Qwen' in page.locator('#modelButton').inner_text()
                    assert page.evaluate('window.CustomOpenCodeRuntime.currentProfile()') == 'architect'
                    assert page.evaluate('window.CustomOpenCodeControls.activeModel().id') == 'qwen3.8-orchestrated'
                    assert not problems, problems

                    context.close()
                    browser.close()
            finally:
                stack.stop()

    print("Critical web controls regression passed: existing chat model selection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
