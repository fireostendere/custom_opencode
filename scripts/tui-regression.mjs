import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const helperUrl = new URL('config/plugins/tui/lib/limits-helper.js', root)
const panelCommandUrl = new URL('config/plugins/tui/lib/panel-command.js', root)
const promptHistory = await readFile(new URL('config/plugins/tui/prompt-history.jsx', root), 'utf8')
const panelSlash = await readFile(new URL('config/plugins/tui/panel-slash.jsx', root), 'utf8')
const workspacePanel = await readFile(new URL('config/plugins/tui/workspace-panel.jsx', root), 'utf8')
const panelViews = await readFile(new URL('config/plugins/tui/lib/panel-views.jsx', root), 'utf8')
const retiredPanel = await readFile(new URL('config/plugins/tui/limits-panels.jsx', root), 'utf8')
const cliConfig = JSON.parse(await readFile(new URL('config/cli.json', root), 'utf8'))
const envExample = await readFile(new URL('.env.example', root), 'utf8')
const updater = await readFile(new URL('scripts/update.sh', root), 'utf8')

assert.equal(cliConfig.keybinds['prompt.history.previous'], 'none')
assert.equal(cliConfig.keybinds['prompt.history.next'], 'none')
assert.equal(cliConfig.keybinds['app.exit'], 'ctrl+shift+q')
assert.equal(cliConfig.mouse, true, 'TUI mouse support must stay enabled for clickable controls')
assert.match(envExample, /^OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1$/m)
assert.ok(
  updater.includes("^OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=") &&
    updater.includes('OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1'),
  'Updater must migrate existing .env files to explicit Ctrl+C copy mode',
)

for (const marker of [
  'session_prompt',
  'context.state.session.messages',
  'custom.prompt-history.previous',
  'custom.prompt-history.next',
  'context.ui.Prompt',
]) {
  assert.ok(promptHistory.includes(marker), `TUI prompt/history marker missing: ${marker}`)
}
for (const retired of [
  'parsePanelCommand',
  'panelCommandID',
  'custom.panels.inline-submit',
  'bind: "enter"',
  'currentFocusedEditor',
]) {
  assert.ok(!promptHistory.includes(retired), `Prompt history must not intercept /panel through Enter: ${retired}`)
}

for (const marker of [
  'id: "custom.panel-slash"',
  'slash: { name: slashName }',
  'panel left',
  'panel right',
  'panel top',
  'panel bottom',
  'panel reset',
  'panel ${side} off',
  'panel ${side} pin',
  'panel ${side} unpin',
  'panel ${side} collapse',
  'panel ${side} expand',
  'panel ${side} ${view}',
  'context.keymap.dispatchCommand?.(target)',
]) {
  assert.ok(panelSlash.includes(marker), `Native panel slash marker missing: ${marker}`)
}
assert.ok(!panelSlash.includes('bind: "enter"'), 'Native /panel commands must never override prompt Enter')
assert.ok(!panelSlash.includes('context.ui.Prompt'), 'Native /panel commands must not touch prompt submission')
assert.ok(!panelSlash.includes('context.client'), 'Native /panel commands must not call model/client APIs')

for (const marker of [
  'id: "custom.workspace-panel"',
  'workspace-panel.state',
  'version: 3',
  'universal-panel.state',
  'migratedUniversalV1',
  'function freshZones()',
  'left:',
  'right:',
  'top:',
  'bottom:',
  'function Zone(props)',
  'function configurePanels()',
  'context.ui.DialogSelect',
  'slash: { name: "panel" }',
  'custom.panels.configure',
  'PANEL_SIDES',
  'PANEL_VIEWS',
  'scrollPositions',
  'verticalScrollbarOptions',
  'scrollY={true}',
  'target.paddingLeft',
  'target.paddingRight',
  'target.paddingTop',
  'target.paddingBottom',
  '📌',
  'live updates keep scroll',
  'jumpToEnd',
  'cursorUnderOverlay',
  'addPostProcessFn',
  'append: "sidebar_content"',
  'session.sidebar.toggle',
  'custom.panel.toggle',
  'custom.panel.activity',
  'custom.panel.plan',
  'custom.panel.limits',
  'custom.panel.end',
]) {
  assert.ok(workspacePanel.includes(marker), `Four-zone workspace dock marker missing: ${marker}`)
}
assert.ok(!workspacePanel.includes('context.ui.dialog.select('), 'Configurator must use the current DialogSelect component API')
assert.ok(!workspacePanel.includes('function EdgePanel('), 'Legacy independent EdgePanel abstraction must stay removed')
assert.ok(!workspacePanel.includes('planPinned'), 'Feature view must not own a plan pin')
assert.ok(!workspacePanel.includes('homePinned'), 'Feature view must not own a limits pin')

for (const marker of [
  'export const PANEL_DEFS',
  '{ id: "activity"',
  'createPanelViews',
  'function ActivityView',
  'function PlanView',
  'function OrchestrationView',
  'function HistoryView',
  'function SessionView',
  'function LimitsView',
]) {
  assert.ok(panelViews.includes(marker), `Panel view registry marker missing: ${marker}`)
}
assert.ok(!panelViews.includes('target.padding'), 'Feature views must never mutate root layout')
assert.ok(!panelViews.includes('<scrollbox'), 'Only the dock host may own panel scrollboxes')
assert.ok(retiredPanel.includes('id: "custom.limits-panels-retired"'), 'Old universal panel filename must be an inert migration tombstone')
assert.ok(!retiredPanel.includes('custom.universal-panel'), 'Old universal host must not remain active')

const commands = await import(`${panelCommandUrl.href}?contract=${Date.now()}`)
assert.deepEqual(commands.parsePanelCommand('/panel'), { type: 'configure' })
assert.deepEqual(commands.parsePanelCommand('/panel reset'), { type: 'reset' })
assert.deepEqual(commands.parsePanelCommand('/panel left'), { type: 'zone', side: 'left', action: 'show' })
assert.deepEqual(commands.parsePanelCommand('/panel top limits'), { type: 'zone', side: 'top', action: 'view', view: 'limits' })
assert.deepEqual(commands.parsePanelCommand('/panel right activity'), { type: 'zone', side: 'right', action: 'view', view: 'activity' })
assert.deepEqual(commands.parsePanelCommand('/panel bottom history'), { type: 'zone', side: 'bottom', action: 'view', view: 'history' })
assert.deepEqual(commands.parsePanelCommand('/panel слева план'), { type: 'zone', side: 'left', action: 'view', view: 'plan' })
assert.deepEqual(commands.parsePanelCommand('/panel снизу орк'), { type: 'zone', side: 'bottom', action: 'view', view: 'orchestration' })
assert.deepEqual(commands.parsePanelCommand('/panel right off'), { type: 'zone', side: 'right', action: 'disable' })
assert.deepEqual(commands.parsePanelCommand('/panel top pin'), { type: 'zone', side: 'top', action: 'pin' })
assert.deepEqual(commands.parsePanelCommand('/panel top unpin'), { type: 'zone', side: 'top', action: 'unpin' })
assert.deepEqual(commands.parsePanelCommand('/panel bottom collapse'), { type: 'zone', side: 'bottom', action: 'collapse' })
assert.deepEqual(commands.parsePanelCommand('/panel bottom expand'), { type: 'zone', side: 'bottom', action: 'expand' })
assert.deepEqual(commands.parsePanelCommand('/panel left end'), { type: 'zone', side: 'left', action: 'end' })
assert.equal(commands.parsePanelCommand('/not-panel left'), null)
assert.equal(commands.parsePanelCommand('/panel nowhere').type, 'error')
assert.equal(commands.panelCommandID(commands.parsePanelCommand('/panel left')), 'custom.panels.left.show')
assert.equal(commands.panelCommandID(commands.parsePanelCommand('/panel right activity')), 'custom.panels.right.view.activity')
assert.equal(commands.panelCommandID(commands.parsePanelCommand('/panel bottom end')), 'custom.panels.bottom.end')

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
process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS = '3000'

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
  timeoutMs: 3000,
})
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 1)
assert.equal(helper.getAutoRefreshState().active, true, 'one plugin cleanup must not stop another plugin timer')
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 0)
assert.equal(helper.getAutoRefreshState().active, false)

const beforeNight = Date.UTC(2026, 7, 30, 13, 59)
const atNight = Date.UTC(2026, 7, 30, 14, 0)
assert.equal(helper.getNightPromoStatus(beforeNight).active, false)
assert.equal(helper.getNightPromoStatus(beforeNight).minutesToToggle, 1)
assert.equal(helper.getNightPromoStatus(atNight).active, true)
assert.equal(helper.getNightPromoStatus(atNight).minutesToToggle, 600)

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
console.log('TUI regression passed: native local /panel + four-zone dock + unified Activity/scroll + copy/mouse + limits watchdog')
