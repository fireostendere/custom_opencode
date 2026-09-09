#!/usr/bin/env python3
"""Check task scope, quiet background polling, visible failures and reduced motion."""
from pathlib import Path
import runpy
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    harness = runpy.run_path(str(ROOT / 'scripts/web-critical-controls-e2e.py'))['load_harness']()
    with tempfile.TemporaryDirectory(prefix='opencode-status-') as temp:
        root = Path(temp)
        outside = root / 'outside'
        outside.mkdir()
        with harness.isolated_environment(root):
            harness.reset_fixture_state()
            stack = harness.LocalStack(root)
            url = stack.start()
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True)
                    page = browser.new_page(reduced_motion='reduce')
                    errors = []
                    requests = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('request', lambda request: requests.append(request.url))
                    page.route('**/api/vcs?*', lambda route: route.fulfill(json={'data':{'branch':{}}}))
                    harness.fixture.login(page, url)
                    harness.fixture.open_session(page)
                    page.locator('#permissionBanner .permission-project-button').wait_for(state='visible', timeout=5000)
                    assert page.locator('#gitButton').inner_text() == 'Git'
                    page.wait_for_function("document.querySelector('#taskCenterButton').getAttribute('aria-busy') === 'false'")
                    await_refresh = "() => window.CustomOpenCodeRuntime.refresh(true)"
                    page.evaluate(await_refresh)
                    assert not any('/client-resource-status.json' in path for path in requests), 'Hidden resources polled'
                    assert not any('/client-runtime-telemetry.json' in path for path in requests), 'Hidden telemetry polled'
                    count = lambda: sum('/client-tasks.json' in path for path in requests)
                    before = count()
                    page.wait_for_timeout(5200)
                    assert count() == before, 'Closed task center polled every four seconds'

                    # The real handler must keep an out-of-root session isolated,
                    # while reporting an unavailable feature instead of repeated 400s.
                    original = harness.fixture.Backend.session
                    harness.fixture.Backend.session = staticmethod(lambda project: {**original(project), 'location': {'directory': str(outside)}})
                    try:
                        result = page.request.get(url + '/client-tasks.json?sessionID=ses_fixture')
                        assert result.status == 200
                        unavailable = result.json()
                        assert unavailable['available'] is False and unavailable['tasks'] == []
                        for path in ('client-project-settings.json', 'client-unified.json', 'client-activity.json'):
                            scoped = page.request.get(url + '/' + path + '?sessionID=ses_fixture')
                            assert scoped.status == 200 and scoped.json()['available'] is False, path
                    finally:
                        harness.fixture.Backend.session = staticmethod(original)
                    page.route('**/client-tasks.json?*', lambda route: route.fulfill(json=unavailable))
                    page.evaluate(await_refresh)
                    assert 'недоступны' in page.locator('#taskCenterButton').inner_text()
                    before = count()
                    page.evaluate('() => Promise.all([window.CustomOpenCodeRuntime.refresh(), window.CustomOpenCodeRuntime.refresh()])')
                    assert count() == before, 'Unavailable scope keeps polling'
                    page.click('#taskCenterButton')
                    page.locator('#taskCenterDialog[open]').wait_for()
                    assert 'вне разрешённых корней' in page.locator('#runtimeSummary').inner_text()
                    assert page.locator('#runtimeV3Panel').is_hidden()
                    assert page.locator('#taskCenterDialog').evaluate("el => getComputedStyle(el).animationName") == 'none'
                    page.unroute('**/client-tasks.json?*')
                    page.click('#runtimeRefresh')
                    page.wait_for_function("!document.querySelector('#taskCenterButton').textContent.includes('недоступны')")
                    assert not errors, errors
                    page.locator('[data-runtime-close]').click()
                    page.route('**/client-diagnostic-fixture*', lambda route: route.fulfill(status=503, json={'error':'fixture'}))
                    page.evaluate("() => fetch('/client-diagnostic-fixture?token=secret-marker-not-for-export')")
                    page.click('#networkButton')
                    page.locator('#networkDialog[open]').wait_for()
                    page.check('#networkErrors')
                    assert '503' in page.locator('#networkRows').inner_text()
                    snapshot = page.evaluate('window.CustomOpenCodeNetwork.snapshot()')
                    import json
                    assert 'secret-marker-not-for-export' not in json.dumps(snapshot)
                    assert all(set(row) == {'id','method','route','queryKeys','source','status','ms'} for row in snapshot['requests'])
                    assert any('.js:' in row['source'] for row in snapshot['requests'])
                    with page.expect_download() as download:
                        page.click('#networkExport')
                    exported = json.loads(Path(download.value.path()).read_text())
                    assert exported['version'] == 1 and 'secret-marker-not-for-export' not in json.dumps(exported)
                    page.click('#networkClear')
                    assert page.evaluate('window.CustomOpenCodeNetwork.snapshot().total') == 0
                    browser.close()
            finally:
                stack.stop()
                import server_workflow
                assert server_workflow.features._stop_worker()
    print('Runtime status Playwright passed: scope isolation, quiet polling, recovery, reduced motion')


if __name__ == '__main__':
    main()
