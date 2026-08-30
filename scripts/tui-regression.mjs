import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const helperUrl = new URL('config/plugins/tui/lib/limits-helper.js', root)
const temp = await mkdtemp(join(tmpdir(), 'custom-opencode-tui-'))

async function executable(name, source) {
  const path = join(temp, name)
  await writeFile(path, source, 'utf8')
  await chmod(path, 0o755)
  return path
}

const codex = await executable('codex', `#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
    row=json.loads(line)
    if row.get('method')=='initialize':
        print(json.dumps({'id':row['id'],'result':{'ok':True}}),flush=True)
    elif row.get('method')=='account/rateLimits/read':
        print(json.dumps({'id':row['id'],'result':{'rateLimitsByLimitId':{'codex':{'planType':'plus','primary':{'usedPercent':37,'windowDurationMins':300,'resetsAt':2000000000},'secondary':{'usedPercent':72,'windowDurationMins':10080,'resetsAt':2000100000}}}}}),flush=True)
`)
const bailian = await executable('bl', `#!/usr/bin/env python3
import json
print(json.dumps({'planName':'Personal Pro','per5HourPercentage':0.375,'per5HourResetTime':2000000000000,'per1WeekPercentage':0.72,'per1WeekResetTime':2000100000000}))
`)

process.env.CODEX_BIN = codex
process.env.BAILIAN_CLI_BIN = bailian
process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS = '1200'

const helper = await import(`${helperUrl.href}?normal=${Date.now()}`)
const limits = await helper.getLimits()
assert.equal(limits.codex.available, true)
assert.equal(limits.codex.primary.remainingPercent, 63)
assert.equal(limits.codex.secondary.remainingPercent, 28)
assert.equal(limits.qwen.available, true)
assert.equal(limits.qwen.planName, 'Personal Pro')
assert.equal(limits.qwen.fiveHour.remainingPercent, 62.5)
assert.equal(limits.qwen.fiveHour.remainingCredits, 7500)
assert.equal(limits.qwen.sevenDay.remainingCredits, 11200)

helper.startAutoRefresh()
helper.startAutoRefresh()
assert.deepEqual(helper.getAutoRefreshState(), {
  owners: 2,
  active: true,
  pending: false,
  timeoutMs: 1200,
})
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 1)
assert.equal(helper.getAutoRefreshState().active, true, 'one plugin cleanup must not stop another plugin timer')
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 0)
assert.equal(helper.getAutoRefreshState().active, false)

// 21:59 Beijing is still daytime; 22:00 starts the discounted window.
const beforeNight = Date.UTC(2026, 7, 30, 13, 59)
const atNight = Date.UTC(2026, 7, 30, 14, 0)
assert.equal(helper.getNightPromoStatus(beforeNight).active, false)
assert.equal(helper.getNightPromoStatus(beforeNight).minutesToToggle, 1)
assert.equal(helper.getNightPromoStatus(atNight).active, true)
assert.equal(helper.getNightPromoStatus(atNight).minutesToToggle, 600)

// A wedged `bl` must be killed and must not hold refreshPending forever.
const slowBailian = await executable('bl-slow', `#!/usr/bin/env python3
import time
time.sleep(10)
`)
process.env.BAILIAN_CLI_BIN = slowBailian
process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS = '500'
const timeoutHelper = await import(`${helperUrl.href}?timeout=${Date.now()}`)
const started = Date.now()
const timed = await timeoutHelper.getLimits()
const elapsed = Date.now() - started
assert.equal(timed.qwen.available, false)
assert.equal(timed.qwen.reason, 'bailian-cli-timeout')
assert.ok(elapsed < 2500, `Bailian watchdog took ${elapsed}ms`)
assert.equal(timeoutHelper.getAutoRefreshState().pending, false)

await rm(temp, { recursive: true, force: true })
console.log('TUI limits regression passed: parsing + promo + refcount + bounded child process')
