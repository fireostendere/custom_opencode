#!/usr/bin/env python3
"""Critical browser regression for web model selection and new-session creation.

Runs the production web handler against the isolated fixture backend from
local-web-harness.py. It exercises the exact user-facing controls that must
remain usable after model-catalog changes: New Session -> project selection,
and Model -> concrete model selection for the newly created session.
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

                    # Critical control 1: creating a new dialog must open the project chooser
                    # and create/select exactly one session when a target is chosen.
                    page.click("#newSession")
                    page.locator("#projectDialog[open]").wait_for(state="visible", timeout=5_000)
                    assert harness.fixture.FixtureState.session_payloads == []
                    with page.expect_response(
                        lambda response: urlsplit(response.url).path == "/api/session"
                        and response.request.method == "POST",
                        timeout=5_000,
                    ) as create_response:
                        page.locator('#projectDialog button[data-project="proj_other"]').click()
                    assert create_response.value.ok, create_response.value.status
                    page.wait_for_function("!document.querySelector('#projectDialog').open", timeout=5_000)
                    page.wait_for_function(
                        "location.hash.startsWith('#/session/ses_created_1')",
                        timeout=5_000,
                    )
                    assert len(harness.fixture.FixtureState.session_payloads) == 1
                    assert page.locator("#modelButton").is_enabled()

                    # Critical control 2: a concrete model entry must remain clickable after
                    # ui-enhancements.js re-groups/decorates the model catalog.
                    page.click("#modelButton")
                    page.locator("#modelDialog[open]").wait_for(state="visible", timeout=5_000)
                    page.locator("#modelChoices > .model-provider-section").first.wait_for(
                        state="visible", timeout=5_000
                    )
                    target = page.locator(
                        '#modelChoices button[data-provider="bailian-cli"][data-model="qwen-fixture-01"]'
                    ).first
                    target.wait_for(state="visible", timeout=5_000)
                    with page.expect_response(
                        lambda response: urlsplit(response.url).path == "/api/session/ses_created_1/model"
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
                    assert not problems, problems

                    context.close()
                    browser.close()
            finally:
                stack.stop()

    print("Critical web controls regression passed: new session + model selection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
