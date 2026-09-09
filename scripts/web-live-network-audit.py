#!/usr/bin/env python3
"""Read-only browser audit of the running server; no fixtures, prompts or model changes."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import runpy
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--session', required=True)
    parser.add_argument('--output', type=Path, default=Path('/tmp/opencode-live-audit'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    native = runpy.run_path(str(ROOT / 'scripts/web-e2e.py'))
    rows, errors, phases, failures = [], [], [], []
    start = time.monotonic()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1440,'height':900})
        def response(value):
            path = urlsplit(value.url).path
            if path.startswith(('/api/', '/client-')):
                rows.append({'second':round(time.monotonic()-start,2),'method':value.request.method,'path':re.sub(r'/(?:ses_|msg_|part_)[^/]+','/:id',path),'status':value.status})
        page.on('response', response)
        page.on('requestfailed', lambda request: failures.append({'path':re.sub(r'/(?:ses_|msg_|part_)[^/]+','/:id',urlsplit(request.url).path),'error':request.failure}))
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            native['login'](page)
            page.locator(f'[data-session="{args.session}"]').click(timeout=60000)
            page.wait_for_function("sid => location.hash === '#/session/' + sid", arg=args.session)
            page.wait_for_function("!document.querySelector('#modelButton').disabled",timeout=60000)
            page.locator('.live-panel').wait_for()
            page.wait_for_timeout(2000)
            phases.append({'phase':'loaded','at':len(rows)})
            page.wait_for_timeout(30000)
            assert native['session_id'](page) == args.session, 'Selected session changed during idle'
            phases.append({'phase':'idle-30s','at':len(rows)})
            live=page.locator('.live-panel')
            if live.count() and not live.evaluate('el => el.open'):
                live.locator(':scope > summary').click()
            page.wait_for_timeout(5000)
            page.screenshot(path=str(args.output/'desktop.png'))
            assert '[object Object]' not in page.locator('.header').inner_text(), 'Object rendered as UI text'
            page.evaluate("document.documentElement.dataset.theme = 'dark'")
            page.screenshot(path=str(args.output/'desktop-dark.png'))
            page.evaluate("document.documentElement.dataset.theme = 'light'")
            page.locator('#networkButton').click()
            page.wait_for_timeout(3000)
            page.screenshot(path=str(args.output/'diagnostics.png'))
            diagnostics=page.evaluate('window.CustomOpenCodeNetwork.snapshot()')
            page.locator('#networkClose').click()
            page.locator('#unifiedPanelToggle').click()
            page.locator('[data-unified-tab="runtime"]').click()
            page.wait_for_timeout(5000)
            page.screenshot(path=str(args.output/'runtime.png'))
            page.keyboard.press('Escape')
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_timeout(3000)
            page.screenshot(path=str(args.output/'mobile.png'))
            phases.append({'phase':'interactions','at':len(rows)})
            report={'errors':errors,'failures':failures,'phases':phases,'requests':rows,'diagnostics':diagnostics}
            (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
            print(json.dumps({'errors':errors,'phases':phases,'counts':dict(Counter(f"{r['method']} {r['path']} {r['status']}" for r in rows))},ensure_ascii=False,indent=2),flush=True)
            assert not errors, errors
            unexpected = [row for row in rows if row['status'] >= 400 and not (row['status'] == 404 and row['path'] == '/api/session/:id/children')]
            assert not unexpected, unexpected
            assert '[object Object]' not in page.locator('.header').inner_text(), 'Object rendered as UI text'
            idle = rows[phases[0]['at']:phases[1]['at']]
            assert sum(row['path'] == '/api/permission/request' for row in idle) <= 7, 'Permission polling storm'
        finally:
            browser.close()


if __name__ == '__main__':
    main()
