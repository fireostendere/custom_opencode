#!/usr/bin/env python3
"""Native browser regression: preserve the item being read through live updates."""
from pathlib import Path
import runpy
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def check(browser, base_url, width, fixture):
    context = browser.new_context(viewport={"width": width, "height": 850})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    fixture.login(page, base_url)
    fixture.open_session(page)
    page.locator('.live-panel > summary').click()
    panel = page.locator('.live-panel .activity-panel-body')
    panel.wait_for(state='visible')

    def emit(index, lines=90):
        page.evaluate("""({index, lines}) => window.dispatchEvent(new CustomEvent('custom-opencode:event', {
            detail: {type: 'session.tool.succeeded', data: {
                sessionID: 'ses_fixture', id: `scroll-${index}`, name: `scroll tool ${index}`,
                input: 'input\\n'.repeat(90), content: Array.from({length:lines}, (_, i) => `output ${index} line ${i}`).join('\\n'),
            }}
        }))""", {'index': index, 'lines': lines})
        page.wait_for_function("""({index, lines}) => {
            const current = document.querySelector('.activity-item.current')
            return current?.dataset.scrollKey === `tool:scroll-${index}` && current.querySelector('.activity-output')?.textContent.includes(`line ${lines - 1}`)
        }""", arg={'index': index, 'lines': lines})
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

    for index in range(4):
        emit(index)
        assert panel.evaluate('el => el.scrollTop') == 0, 'Top-follow jumped down on insertion'

    # Actual wheel input inside the nested output, followed by streaming growth.
    output = page.locator('.activity-item.current .activity-output')
    output.scroll_into_view_if_needed()
    output.hover()
    page.mouse.wheel(0, 100)
    page.wait_for_function("document.querySelector('.activity-item.current .activity-output').scrollTop > 0")
    nested_top = output.evaluate('el => el.scrollTop')
    emit(3, 110)
    assert abs(output.evaluate('el => el.scrollTop') - nested_top) <= 1, 'Nested output lost reading position'
    output.evaluate('el => el.scrollTop = 0')
    emit(3, 120)
    assert output.evaluate('el => el.scrollTop') == 0, 'Nested top-follow jumped down'

    # Hold an older card at a specific screen offset while content above it grows.
    anchor = page.locator('[data-scroll-key="tool:scroll-2"]')
    anchor.evaluate("""el => {
        const panel = el.closest('.activity-panel-body')
        panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20
    }""")
    offset = lambda: anchor.evaluate("el => el.getBoundingClientRect().top - el.closest('.activity-panel-body').getBoundingClientRect().top")
    before = offset()
    old_output = anchor.locator('.activity-output')
    old_output.evaluate('el => el.scrollTop = 70')
    old_input = anchor.locator('.activity-code')
    old_input.evaluate('el => el.scrollTop = 50')
    emit(4)
    assert abs(offset() - before) <= 1, ('Card moved on prepend', before, offset())
    assert old_output.evaluate('el => el.scrollTop') == 70, 'Nested scroll reset when another card was added'
    assert old_input.evaluate('el => el.scrollTop') == 50, 'Nested input scroll reset when another card was added'
    emit(4, 130)
    assert abs(offset() - before) <= 1, 'Card moved on live output update'
    panel.evaluate('el => el.scrollTop = 0')
    emit(5)
    assert panel.evaluate('el => el.scrollTop') == 0
    assert not errors, errors
    context.close()
    print(f'Panel scroll Playwright passed at {width}px: top-follow, reading anchor, nested output, live updates')


def main():
    harness = runpy.run_path(str(ROOT / 'scripts/web-critical-controls-e2e.py'))['load_harness']()
    with tempfile.TemporaryDirectory(prefix='opencode-scroll-') as temp:
        root = Path(temp)
        with harness.isolated_environment(root):
            harness.reset_fixture_state()
            stack = harness.LocalStack(root)
            base_url = stack.start()
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True)
                    try:
                        for width in (1366, 390):
                            check(browser, base_url, width, harness.fixture)
                    finally:
                        browser.close()
            finally:
                stack.stop()
                import server_workflow
                assert server_workflow.features._stop_worker()


if __name__ == '__main__':
    main()
