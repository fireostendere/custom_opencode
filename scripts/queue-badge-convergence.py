"""Convergence test for syncQueueBadges in a real browser.

The #sessions container is observed with MutationObserver(childList+subtree)
whose callback IS syncQueueBadges. If syncQueueBadges unconditionally removes
and re-adds badges, every run mutates the observed subtree → infinite loop →
tab freeze.

To make the test deterministic (no frozen page), the observer callback is
capped at LIMIT invocations:
  - looping implementation  → hits the cap (callbacks == LIMIT)
  - converging implementation → settles at a handful of callbacks (≤ 3)
"""
import sys
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / 'app' / 'advanced-features.js').read_text(encoding='utf-8')
start = SRC.index('function syncQueueBadges()')
depth = 0
end = start
for i, ch in enumerate(SRC[start:], start):
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
NEW_FN = SRC[start:end]
assert 'ВАЖНО' in NEW_FN, 'expected the patched implementation'

OLD_FN = """function syncQueueBadges() {
  document.querySelectorAll('[data-persistent-queue]').forEach((el) => el.remove())
  for (const [sessionID, count] of Object.entries(state.queueCounts || {})) {
    if (!count) continue
    const button = document.querySelector(`[data-session="${CSS.escape(sessionID)}"]`)
    const meta = button?.querySelector('.session-meta')
    if (!meta) continue
    const badge = document.createElement('span')
    badge.dataset.persistentQueue = '1'
    badge.className = 'queued'
    badge.textContent = `очередь ${count}`
    meta.append(badge)
  }
}"""

LIMIT = 60

def harness(fn_source):
    return f"""<!doctype html><html><body>
<div id="sessions">
  <div class="session">
    <button class="session-main" data-session="ses_aaa">
      <div class="session-title">A</div><div class="session-meta"><span>now</span></div>
    </button>
  </div>
  <div class="session">
    <button class="session-main" data-session="ses_bbb">
      <div class="session-title">B</div><div class="session-meta"><span>now</span></div>
    </button>
  </div>
</div>
<script type="module">
const state = {{ queueCounts: {{ ses_aaa: 2, ses_bbb: 5 }} }}
{fn_source}
let callbacks = 0
const LIMIT = {LIMIT}
const sessions = document.getElementById('sessions')
new MutationObserver(() => {{ callbacks++; if (callbacks < LIMIT) syncQueueBadges() }})
  .observe(sessions, {{ childList:true, subtree:true }})
window.__test = {{
  callbacks: () => callbacks,
  setCounts: (c) => {{ state.queueCounts = c; syncQueueBadges() }},
  rerender: () => {{ sessions.innerHTML = sessions.innerHTML; syncQueueBadges() }},
}}
syncQueueBadges()
</script></body></html>"""

def run(page, name, html, expect_converge):
    page.goto('about:blank')
    page.set_content(html)
    page.wait_for_timeout(700)
    c = page.evaluate('window.__test.callbacks()')
    alive = page.evaluate('1+1')
    looping = c >= LIMIT
    print(f'{name}: callbacks={c} (cap={LIMIT}) looping={looping} alive={alive}')
    if expect_converge and looping:
        print(f'{name}: FAIL — patched code still loops')
        return False
    if not expect_converge and not looping:
        print(f'{name}: FAIL — old code was expected to loop')
        return False

    if expect_converge:
        # count change → badge text updated, still converges
        page.evaluate('window.__test.setCounts({ ses_bbb: 7 })')
        page.wait_for_timeout(400)
        c1 = page.evaluate('window.__test.callbacks()')
        page.wait_for_timeout(400)
        c2 = page.evaluate('window.__test.callbacks()')
        badges = page.evaluate("document.querySelectorAll('[data-persistent-queue]').length")
        text = page.evaluate("[...document.querySelectorAll('[data-persistent-queue]')].map(e=>e.textContent).join('|')")
        print(f'{name}: after count change callbacks {c1}->{c2} badges={badges} text={text!r}')
        if c2 != c1 or badges != 1 or text != 'очередь 7':
            print(f'{name}: FAIL — update path did not converge')
            return False
        # full re-render of the list → re-add missing badge, still converges
        page.evaluate('window.__test.rerender()')
        page.wait_for_timeout(400)
        c3 = page.evaluate('window.__test.callbacks()')
        page.wait_for_timeout(400)
        c4 = page.evaluate('window.__test.callbacks()')
        badges2 = page.evaluate("document.querySelectorAll('[data-persistent-queue]').length")
        print(f'{name}: after re-render callbacks {c3}->{c4} badges={badges2}')
        if c4 != c3 or badges2 != 1:
            print(f'{name}: FAIL — re-render path did not converge')
            return False
    return True

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-dev-shm-usage', '--no-sandbox'])
    page = browser.new_page()
    page.set_default_timeout(10000)

    ok_old = run(page, 'OLD', harness(OLD_FN), expect_converge=False)
    page.close()
    page = browser.new_page()
    page.set_default_timeout(10000)

    ok_new = run(page, 'NEW', harness(NEW_FN), expect_converge=True)
    browser.close()
    ok = ok_old and ok_new
    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
