#!/usr/bin/env python3
"""Check task scope, quiet background polling, visible failures and reduced motion."""
from pathlib import Path
import runpy
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def check_workspace_settings(page, url, root):
    # Real server persistence, with no provider calls or user configuration.
    page.click('#networkClose')
    original_model = page.evaluate('window.CustomOpenCodeControls.activeModel()')
    page.click('#projectSettingsButton')
    page.locator('#projectSettingsDialog[open]').wait_for()
    page.fill('#projectInstructions', 'Fixture project instruction')
    page.select_option('#projectDefaultModel', 'sol-orchestrated')
    page.select_option('#projectRag', 'off')
    page.click('#projectSettingsSave')
    page.wait_for_function("document.querySelector('#projectSettingsStatus').textContent.startsWith('Сохранено на сервере')")
    saved = page.request.get(url + '/client-project-settings.json?sessionID=ses_fixture').json()['settings']
    assert saved['instructions'] == 'Fixture project instruction'
    assert saved['defaultModel'] == 'sol-orchestrated' and saved['rag'] == 'off'
    assert page.evaluate('window.CustomOpenCodeControls.activeModel()') == original_model
    assert not (root / 'project/AGENTS.md').exists(), 'Private preferences leaked into the project'
    page.locator('[data-workflow-close="projectSettingsDialog"]').first.click()
    page.click('#projectSettingsButton')
    assert page.input_value('#projectInstructions') == 'Fixture project instruction'
    page.route('**/client-project-settings.json', lambda route: route.fulfill(status=503, json={'error':'fixture save failure'}))
    page.click('#projectSettingsSave')
    page.wait_for_function("document.querySelector('#projectSettingsStatus').textContent.startsWith('Не сохранено:')")
    assert page.locator('#projectSettingsDialog').evaluate('el => el.open')
    page.unroute('**/client-project-settings.json')
    page.locator('[data-workflow-close="projectSettingsDialog"]').first.click()

    import server_workflow
    store = server_workflow.runtime.STORE
    task = store.create_task(session_id='ses_fixture', project_dir=str(root / 'project'),
                             text='Fixture failed task', profile='architect',
                             route={'selectedModel':'bailian-cli/qwen3.8-orchestrated'})
    store.transition(task['id'], 'failed', error='Fixture diagnostic: missing input')
    store.event(task_id=task['id'], session_id='ses_fixture', project_dir=str(root / 'project'),
                kind='task.updated', data={'priority':None})
    page.click('#unifiedPanelToggle')
    page.evaluate("window.CustomOpenCodeWorkspace.tab('activity')")
    page.evaluate('window.CustomOpenCodeWorkspace.refresh()')
    assert 'priority": null' not in page.locator('#unified-activity').inner_text()
    assert 'task.created' in page.locator('#unified-activity').inner_text()
    for width in (1280, 390):
        page.set_viewport_size({'width':width, 'height':850})
        assert page.locator('#unifiedTabs').evaluate('''el => {
            const bounds = el.getBoundingClientRect(), tabs = [...el.children].map(b => b.getBoundingClientRect());
            return new Set(tabs.map(b => Math.round(b.top))).size > 1 && tabs.every(b =>
                b.left >= bounds.left && b.right <= bounds.right + 1 && b.bottom <= bounds.bottom);
        }'''), f'Tabs overflow at {width}px'
        page.click('[data-unified-tab="search"]')
        assert page.locator('#unifiedSearchInput').is_visible()
    page.set_viewport_size({'width':1280, 'height':850})
    page.click('[data-unified-tab="runtime"]')
    page.click('#unifiedAdvancedRuntime')
    page.wait_for_function("document.querySelector('#runtimeSummary').textContent.includes('Обновлено')")
    assert page.locator('#runtimeTop .runtime-stat').count() == 2
    assert 'Cloud fallback' not in page.locator('#runtimeTop').inner_text()
    assert page.locator('#runtimeProfileOptions').evaluate('el => !el.open')
    card = page.locator(f'[data-task-detail="{task["id"]}"]')
    assert 'Fixture diagnostic: missing input' in card.inner_text()
    assert 'bailian-cli/qwen3.8-orchestrated' in card.inner_text()
    assert page.locator(f'[data-priority^="{task["id"]}"]').count() == 0
    card.click()
    page.wait_for_function("document.querySelector('#runtimeTaskDetail').textContent.includes('Fixture diagnostic: missing input')")
    page.locator('#runtimeProfileOptions > summary').click()
    page.click('[data-runtime-profile="fast"]')
    assert page.evaluate('window.CustomOpenCodeRuntime.currentProfile()') == 'fast'
    assert page.evaluate('window.CustomOpenCodeControls.activeModel()') == original_model
    assert 'Быстрая задача' in page.locator('#runtimeTop').inner_text()
    page.click('[data-runtime-profile="direct"]')
    page.evaluate("document.documentElement.dataset.orchestratedModel='gpt-5.6-sol-orchestrated';document.documentElement.dataset.modelProfile='orchestrated'")
    assert page.evaluate('window.CustomOpenCodeRuntime.currentProfile()') == 'direct', 'Stale DOM changed the actual route'
    page.locator('[data-runtime-close]').click()


def check_session_mirrors(page):
    page.click('#unifiedClose')
    rows = page.evaluate("fetch('/api/session?limit=100').then(response => response.json()).then(value => value.data)")
    service = {**next(row for row in rows if row['id'] == 'ses_fixture'), 'id':'ses_admin',
               'title':'Refresh model catalog', 'tokens':{'input':0,'output':0},
               'time':{'created':2_000_000_000_000,'updated':2_000_000_001_000}}
    admin_reads = []
    def admin_history(route):
        admin_reads.append(route.request.url)
        route.fulfill(json={'data':[]} if 'cursor=' in route.request.url else
                      {'data':[{'id':'admin_event','type':'agent-switched','agent':'build'}], 'cursor':{'next':'admin-end'}})
    page.route('**/api/session?*', lambda route: route.fulfill(json={'data':[*rows,service]}))
    page.route('**/api/session/ses_admin/message?*', admin_history)
    page.click('#refresh')
    page.locator('[data-session="ses_admin"]').wait_for(state='attached')
    page.wait_for_function("!document.querySelector('[data-session-shortcut=\"ses_admin\"]')")
    assert len(admin_reads) == 2, 'Confirm empty history through its last page'
    page.click('#refresh')
    page.wait_for_timeout(200)
    assert len(admin_reads) == 2, 'Cache the probe until the session changes'
    assert page.locator('[data-session="ses_admin"]').count() == 1, 'Do not delete the original session'
    mirrors = page.locator('#sessions > [data-session-mirror]')
    active = page.locator('[data-session-mirror="current"]')
    recent = page.locator('[data-session-mirror="recent"]')
    assert page.locator('.session-shortcuts, #sessionShortcutTabs').count() == 0
    assert mirrors.count() == 2
    assert active.locator('summary > span').first.inner_text() == 'Текущее'
    assert recent.locator('summary > span').first.inner_text() == 'Последнее'
    assert page.locator('#sessions > details').evaluate_all(
        "rows => rows.slice(0,2).map(row => row.dataset.sessionMirror)") == ['current', 'recent']
    current = active.locator('[data-session-shortcut="ses_fixture"]')
    assert current.is_visible() and current.get_attribute('aria-current') == 'page'
    assert active.locator('.count').inner_text() == '1'
    assert mirrors.locator('[draggable="true"], [data-project], [data-session-drag], [data-session-more]').count() == 0
    assert mirrors.locator('button:not([data-session-shortcut])').count() == 0

    # Native details remain independent and remember collapse across renders.
    recent.locator('summary').focus()
    page.keyboard.press('Enter')
    page.wait_for_function("JSON.parse(localStorage.getItem('opencode:web:project-collapse-v1')).includes('mirror:recent')")
    page.fill('#search', 'no-matching-fixture-session')
    assert current.is_visible(), 'Searching projects must not hide the current chat'
    assert not recent.evaluate('el => el.open')
    page.fill('#search', '')
    recent.locator('summary').click()

    # Mirrors are neither drag sources nor drop targets, for sessions or projects.
    writes = []
    record_write = lambda request: writes.append(request.url) if request.method in ('POST', 'PATCH', 'DELETE') and '/api/' in request.url else None
    page.on('request', record_write)
    order = page.locator('#sessions > [data-project]').evaluate_all('rows => rows.map(row => row.dataset.project)')
    assert page.evaluate('''() => {
        const mirrors = [...document.querySelectorAll('[data-session-mirror]')];
        for (const mirror of mirrors) {
            for (const target of [mirror.querySelector('summary'), mirror.querySelector('button')]) {
                const start = new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});
                target.dispatchEvent(start);
                if (!start.defaultPrevented || start.dataTransfer.types.length) return false;
                for (const source of document.querySelectorAll('.project-group > summary, [data-session-drag="ses_fixture"]')) {
                    const dataTransfer = new DataTransfer();
                    source.dispatchEvent(new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer}));
                    const over = new DragEvent('dragover', {bubbles:true,cancelable:true,dataTransfer});
                    target.dispatchEvent(over);
                    if (over.defaultPrevented) return false;
                    target.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer}));
                    source.dispatchEvent(new DragEvent('dragend', {bubbles:true,dataTransfer}));
                }
            }
        }
        return true;
    }'''), 'Mirror accepted a drag source or target'
    page.wait_for_timeout(150)
    page.remove_listener('request', record_write)
    assert not writes, writes
    assert not page.locator('#confirmDialog').evaluate('el => el.open')
    assert page.locator('#sessions > [data-project]').evaluate_all('rows => rows.map(row => row.dataset.project)') == order
    page.click('#newSession')
    assert page.locator('#projectChoices [data-project]').evaluate_all('rows => rows.map(row => row.dataset.project)') == ['proj_fixture', 'proj_other']
    page.locator('#projectDialog').evaluate('el => el.close()')

    page.route('**/api/session/active', lambda route: route.fulfill(json={'data':{
        'ses_fixture':{'type':'idle'}, 'ses_child_review':{'type':'busy'}}}))
    page.click('#refresh')
    page.wait_for_function("document.querySelector('[data-session-mirror=\"current\"]').textContent.includes('Работают агенты')")
    assert mirrors.locator('[data-session-shortcut="ses_child_review"]').count() == 0
    assert active.locator('.count').inner_text() == '1', 'A worker and its root are one conversation'
    recent.locator('[data-session-shortcut="ses_other"]').click()
    page.wait_for_function("location.hash === '#/session/ses_other'")
    assert recent.locator('button').first.get_attribute('data-session-shortcut') == 'ses_other'
    assert active.locator('button').first.get_attribute('data-session-shortcut') == 'ses_other'
    page.evaluate("location.hash = '#/session/ses_child_review'")
    page.wait_for_function("location.hash === '#/session/ses_child_review'")
    page.wait_for_function("document.querySelector('#stop').hidden === false")
    assert recent.locator('button').first.get_attribute('data-session-shortcut') == 'ses_fixture', 'Visited workers belong to their root in Recent'
    assert active.locator('button').first.get_attribute('data-session-shortcut') == 'ses_fixture'
    assert mirrors.locator('[data-session-shortcut="ses_child_review"]').count() == 0
    assert page.locator('[data-session="ses_child_review"]').count() == 1, 'Keep the worker in the project tree'
    page.wait_for_timeout(300)
    assert page.locator('#workflowStatus .wf-dot').count() == 0, 'Opening an already-running session must not invent a start time'
    page.evaluate("window.dispatchEvent(new CustomEvent('custom-opencode:event',{detail:{type:'session.execution.started',data:{sessionID:'ses_child_review'}}}))")
    page.locator('#workflowStatus .wf-dot').wait_for(state='visible')
    recent.locator('[data-session-shortcut="ses_fixture"]').click()
    page.wait_for_function("location.hash === '#/session/ses_fixture'")
    page.unroute('**/api/session/active')
    page.wait_for_timeout(5100)
    page.click('#refresh')
    page.wait_for_function("!document.querySelector('[data-session-mirror=\"current\"]').textContent.includes('Работают агенты')")
    assert active.locator('.count').inner_text() == '1'
    assert page.locator('#workflowStatus .wf-dot').count() == 0, 'Do not carry another session\'s duration across navigation'
    for width in (1280, 390):
        page.set_viewport_size({'width':width,'height':600})
        if width == 390:
            page.click('#menu')
        page.wait_for_function("""() => {
            const rect = document.querySelector('[data-session-mirror="current"] > summary').getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
        }""")
        page.locator('#sessions').evaluate('el => el.scrollTop = 0')
        assert active.bounding_box()['y'] >= page.locator('#search').bounding_box()['y'] + page.locator('#search').bounding_box()['height']
        assert current.is_visible()
        assert mirrors.evaluate_all('rows => rows.every(el => el.scrollWidth <= el.clientWidth)'), f'Mirrors overflow at {width}px'
        if width == 390:
            recent.locator('[data-session-shortcut="ses_other"]').click()
            page.wait_for_function("location.hash === '#/session/ses_other'")
            assert page.locator('#sidebarScrim').is_hidden()
            assert not page.evaluate('Boolean(history.state?.__customOpenCodeSidebar)')
            page.go_back()
            page.wait_for_function("location.hash === '#/session/ses_fixture'")
            assert not page.evaluate('Boolean(history.state?.__customOpenCodeSidebar)'), 'Mirror navigation left an extra Back entry'

    # No selection or running chat: only Recent remains. No sessions: neither exists.
    page.set_viewport_size({'width':1280,'height':850})
    page.evaluate("location.hash = ''")
    active.wait_for(state='detached')
    assert recent.count() == 1
    page.route('**/api/session?*', lambda route: route.fulfill(json={'data':[]}))
    page.click('#refresh')
    recent.wait_for(state='detached')
    assert mirrors.count() == 0
    page.unroute('**/api/session?*')


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
                    check_workspace_settings(page, url, root)
                    check_session_mirrors(page)
                    assert not errors, errors
                    browser.close()
            finally:
                stack.stop()
                import server_workflow
                assert server_workflow.features._stop_worker()
    print('Runtime status Playwright passed: scope, quiet polling, responsive tabs, project settings, task errors, profiles and read-only session mirrors')


if __name__ == '__main__':
    main()
