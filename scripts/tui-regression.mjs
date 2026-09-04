import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const root = new URL('../', import.meta.url)
const helperUrl = new URL('config/plugins/tui/lib/limits-helper.js', root)
const panelDataUrl = new URL('config/plugins/tui/lib/panel-data.js', root)
const panelCommandUrl = new URL('config/plugins/tui/lib/panel-command.js', root)
const promptHistory = await readFile(new URL('config/plugins/tui/prompt-history.jsx', root), 'utf8')
const panelSlash = await readFile(new URL('config/plugins/tui/panel-slash.jsx', root), 'utf8')
const workspacePanel = await readFile(new URL('config/plugins/tui/workspace-panel.jsx', root), 'utf8')
const panelViews = await readFile(new URL('config/plugins/tui/lib/panel-views.jsx', root), 'utf8')
const retiredPanel = await readFile(new URL('config/plugins/tui/limits-panels.jsx', root), 'utf8')
const tuiPackage = JSON.parse(await readFile(new URL('config/plugins/tui/package.json', root), 'utf8'))
const tuiServerEntry = await readFile(new URL('config/plugins/tui/index.js', root), 'utf8')
const tuiEntry = await readFile(new URL('config/plugins/tui/tui.js', root), 'utf8')
const addWizard = await readFile(new URL('config/plugins/tui/add-wizard.js', root), 'utf8')
const addCommand = await readFile(new URL('config/plugins/tui/lib/add-command.js', root), 'utf8')
const wslClipboard = await readFile(new URL('config/plugins/tui/wsl-clipboard.jsx', root), 'utf8')
const cliConfig = JSON.parse(await readFile(new URL('config/cli.json', root), 'utf8'))
const envExample = await readFile(new URL('.env.example', root), 'utf8')
const updater = await readFile(new URL('scripts/update.sh', root), 'utf8')
const agentsPolicy = await readFile(new URL('config/AGENTS.md', root), 'utf8')
const orchestratorPolicy = await readFile(new URL('config/prompts/orchestrator.md', root), 'utf8')
const solOrchestratorPolicy = await readFile(new URL('config/prompts/orchestrator-sol.md', root), 'utf8')

async function runtimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources.push(...await runtimeSources(path))
    else if (/\.[jt]sx?$/.test(entry.name)) sources.push(path)
  }
  return sources
}

const rootPath = fileURLToPath(root)
const tuiSourceRoot = join(rootPath, 'config', 'plugins', 'tui')
for (const path of await runtimeSources(tuiSourceRoot)) {
  const source = await readFile(path, 'utf8')
  const file = relative(rootPath, path)
  for (const [name, pattern] of [
    ['direct theme.hue access', /(?:\bcontext\.)?theme\.hue\b/],
    ['hex color literal', /#[0-9a-f]{3,8}\b/i],
    ['rgb()/rgba()/hsl()/hsla() color function', /\b(?:rgba?|hsla?)\s*\(/i],
    ['ANSI escape literal', /\\x1b|\\u001b|\x1b/i],
  ]) {
    assert.doesNotMatch(source, pattern, `${file}: runtime source must not contain ${name}`)
  }
}

function themePathValue(theme, path) {
  return path.split('.').reduce((value, segment) => value?.[segment], theme)
}

const themePaths = [
  'text.formfield.$selected',
  'text.status.running',
  'text.action.secondary.default',
]
const themesRoot = join(rootPath, 'config', 'themes')
for (const entry of await readdir(themesRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue
  const path = join(themesRoot, entry.name)
  const theme = JSON.parse(await readFile(path, 'utf8'))
  for (const mode of ['dark', 'light']) {
    for (const themePath of themePaths) {
      assert.equal(typeof themePathValue(theme[mode], themePath), 'string', `${relative(rootPath, path)}: ${mode}.${themePath} must be a string`)
    }
  }
}

assert.equal(cliConfig.keybinds['prompt.history.previous'], 'none')
assert.equal(cliConfig.keybinds['prompt.history.next'], 'none')
assert.equal(cliConfig.keybinds['app.exit'], 'ctrl+shift+q')
assert.equal(cliConfig.session.thinking, 'hide', 'TUI reasoning must stay out of the conversation')
assert.equal(cliConfig.session.grouping, 'auto', 'TUI tool calls must stay grouped as one compact execution status')
assert.equal(cliConfig.mouse, true, 'TUI mouse support must stay enabled for clickable controls')
assert.equal(tuiPackage.exports['./tui'], './tui.js', 'TUI package must expose the V2 ./tui entrypoint')
assert.equal(tuiPackage.exports['.'], './index.js', 'TUI package must expose a valid server entrypoint')
assert.match(tuiServerEntry, /id: "custom\.tui-bundle"/)
for (const source of [
  'add-wizard.js',
  'effort-indicator.jsx',
  'model-selector.jsx',
  'panel-slash.jsx',
  'prompt-history.jsx',
  'limits-panels.jsx',
  'workspace-panel.jsx',
  'wsl-clipboard.jsx',
]) {
  assert.ok(tuiEntry.includes(`./${source}`), `TUI bundle must include ${source}`)
}
for (const marker of [
  'id: "custom.add-wizard"',
  'installPanelSubmitRouter',
  'currentFocusedRenderable',
  'context.ui.dialog.prompt',
  'context.ui.dialog.select',
  'context.client.session.command',
  'custom.add-wizard.add',
  'custom.add-wizard.${kind}',
]) {
  assert.ok(addWizard.includes(marker), `TUI add wizard marker missing: ${marker}`)
}
for (const marker of [
  'export const ADD_KINDS',
  'parseAddCommand',
  'addprovider',
  'addmodel',
  'addmcp',
  'addskill',
  'addorchestration',
]) {
  assert.ok(addCommand.includes(marker), `TUI add parser marker missing: ${marker}`)
}
for (const marker of [
  'id: "custom.wsl-clipboard"',
  'processPaste',
  'bind: "ctrl+v"',
  'prependListener?.("paste"',
  'powershell.exe',
]) {
  const source = marker === 'powershell.exe'
    ? await readFile(new URL('config/plugins/tui/lib/wsl-clipboard.js', root), 'utf8')
    : wslClipboard
  assert.ok(source.includes(marker), `WSL clipboard bridge marker missing: ${marker}`)
}
for (const forbidden of ['FilePart', 'imageAttachment', 'prependListener("keypress"']) {
  assert.ok(!wslClipboard.includes(forbidden), `WSL clipboard bridge must not use ${forbidden}`)
}
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
  'context.keymap.dispatch(target)',
]) {
  assert.ok(panelSlash.includes(marker), `Native panel slash marker missing: ${marker}`)
}
assert.ok(!panelSlash.includes('bind: "enter"'), 'Native /panel commands must never override prompt Enter')
assert.ok(!panelSlash.includes('context.ui.Prompt'), 'Native /panel commands must not touch prompt submission')
assert.ok(!panelSlash.includes('context.client'), 'Native /panel commands must not call model/client APIs')
assert.ok(!panelSlash.includes('context.keymap.dispatchCommand'), 'Native /panel commands must use the official keymap dispatch API')
assert.ok(!workspacePanel.includes('context.keymap.dispatchCommand'), 'Workspace panel must use the official keymap dispatch API')

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
  'stickyScroll={true}',
  'stickyStart="bottom"',
  'scrollTop',
  'atBottom: top >= max',
  'if (!saved || saved.atBottom) scrollToEnd(scroll)',
  'scrollTo(Number.MAX_SAFE_INTEGER)',
  'target.paddingLeft',
  'target.paddingRight',
  'target.paddingTop',
  'target.paddingBottom',
  'theme.text.formfield.$selected',
  'theme.text.action.secondary.default',
  'theme.border.default',
  'theme.scrollbar.default',
  'theme.background.surface.offset',
  'const PIN_ICON = "📌"',
  'theme.background.action.primary.default',
  'theme.text.action.primary.default',
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
assert.ok(!workspacePanel.includes('scrollTo({ y: Number.MAX_SAFE_INTEGER })'), 'Jump-to-end must use the numeric ScrollBox vertical position API')
assert.ok(!workspacePanel.includes('node?.scrollToBottom'), 'ScrollBox must use its documented scrollTo API')
assert.ok(!workspacePanel.includes('node?.scrollToEnd'), 'ScrollBox must use its documented scrollTo API')
assert.ok(!workspacePanel.includes('scrollPositions.get(key) ?? 0'), 'A new session/view must not override stickyStart by scrolling to the top')
assert.ok(!workspacePanel.includes('live updates keep scroll'), 'The obsolete scroll-status label must be removed')
assert.ok(!workspacePanel.includes('<box onMouseDown={() => setCollapsed(props.side, true)}><text fg={theme.text.subdued}><span>{COLLAPSE_ICON[props.side]}</span></text></box>'), 'Collapse must not remain in the header')
assert.match(workspacePanel, /const HANDLE = 1\b/, 'Panel handles must occupy one terminal cell')
assert.ok(workspacePanel.includes('function ExpandedHandle(props)'), 'ExpandedHandle must exist')
assert.match(workspacePanel, /<box flexDirection="column" flexShrink=\{0\} paddingX=\{1\} paddingTop=\{1\} gap=\{1\}>[\s\S]*?<\/box>[\s\S]*?<ExpandedHandle side=\{props\.side\} \/>/, 'ExpandedHandle must render separately from the header')
assert.ok(workspacePanel.includes('const atStart = props.side === "right" || props.side === "bottom"'), 'ExpandedHandle must derive the internal edge from atStart')
assert.ok(workspacePanel.includes('[atStart ? "left" : "right"]'), 'ExpandedHandle internal edge must map right to left and left to right')
assert.ok(workspacePanel.includes('[atStart ? "top" : "bottom"]'), 'ExpandedHandle internal edge must map bottom to top and top to bottom')
assert.doesNotMatch(
  workspacePanel,
  /padding(?:Left|Right|Top|Bottom)=\{props\.side === "(?:left|right|top|bottom)" && !item\(\)\.collapsed \? HANDLE : 0\}/,
  'Expanded panels must not reserve handle space with outer padding',
)
assert.ok(!workspacePanel.includes('context.ui.dialog.select('), 'Configurator must use the current DialogSelect component API')
assert.ok(!workspacePanel.includes('function EdgePanel('), 'Legacy independent EdgePanel abstraction must stay removed')
assert.ok(!workspacePanel.includes('planPinned'), 'Feature view must not own a plan pin')
assert.ok(!workspacePanel.includes('homePinned'), 'Feature view must not own a limits pin')
assert.ok(!workspacePanel.includes('theme.hue?.orange'), 'Workspace panel must not use a fixed orange accent')
assert.ok(!panelViews.includes('theme.hue?.orange'), 'Panel views must not use a fixed orange accent')
assert.ok(!workspacePanel.includes('function accent('), 'Workspace panel must not retain the accent helper')
assert.ok(!panelViews.includes('function accent('), 'Panel views must not retain the accent helper')
assert.match(workspacePanel, /fg=\{active\(\) \? theme\.text\.formfield\.\$selected : theme\.text\.subdued\}/, 'Active tabs must use the selected form-field token')
assert.match(workspacePanel, /<text fg=\{theme\.text\.action\.secondary\.default\}><span>↓ конец<\/span><\/text>/, 'Jump-to-end must use the secondary action token')
assert.doesNotMatch(
  workspacePanel,
  /setPinned\(props\.side, !item\(\)\.pinned\)[\s\S]{0,250}theme\.text\.feedback\.error\.default/,
  'Pin control must not use an error color',
)
assert.match(workspacePanel, /let disposed = false[\s\S]*?function syncDockLayout\(\) \{\s*if \(disposed\) return/, 'Dock sync must no-op after disposal')
assert.match(workspacePanel, /function scheduleDockLayout\(\) \{\s*if \(disposed \|\| dockScheduled\) return/, 'Dock scheduling must no-op after disposal')
assert.match(workspacePanel, /queueMicrotask\(\(\) => \{\s*if \(!disposed\) syncDockLayout\(\)/, 'Queued dock layout must check disposal')
assert.match(workspacePanel, /return \(\) => \{\s*disposed = true\s*if \(dockRetry\) clearTimeout\(dockRetry\)\s*restoreDockTarget\(\)/, 'Dock cleanup must mark disposed before cancelling retries and restoring layout')

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
assert.equal((panelViews.match(/theme\.text\.status\.running/g) ?? []).length, 3, 'Panel views must use the running status token only for active work')
assert.match(panelViews, /active \? theme\.text\.status\.running : done \? theme\.text\.feedback\.success\.default/, 'Active todo markers must use the running status token')
assert.match(panelViews, /const running = current\.todos\.some\(\(todo\) => todo\.status === "in_progress"\)/, 'Plan progress must detect in-progress todos')
assert.match(panelViews, /completed === current\.todos\.length \? theme\.text\.feedback\.success\.default : running \? theme\.text\.status\.running : theme\.text\.default/, 'Plan progress must distinguish completed, running, and pending states')
assert.match(panelViews, /row\.role === "assistant" \? theme\.text\.default : theme\.text\.subdued/, 'Assistant activity roles must use the default text token')
assert.match(panelViews, /row\.status === "running" \|\| row\.status === "in_progress" \? theme\.text\.status\.running : theme\.text\.default/, 'Only active orchestration statuses must use the running status token')
assert.ok(!panelViews.includes('taskLike:'), 'Task-like orchestration names must not determine color')
for (const marker of [
  'createEffect(() => {',
  'setHistoricalTodos(null)',
  'current && props.sessionID === sessionID',
  'if (found !== null)',
  'function useSessionMessageSync(props)',
  'useSessionMessageSync(props)',
  'context.data.session.root(sessionID)',
  'context.data.session.family(rootID)',
  'context.data.session.sync(rootID)',
  'normalizeFamilyIDs(rootID, family)',
   'context.data.session.message.sync(sessionID)',
   'syncFamilyMessages(ids, (id) => context.data.session.message.sync(id))',
   'readV2Plan(sessionID)',
   'selectV2PlanEntries(entries, sessionID)',
   'selectV2PlanCandidates(candidates, sessionID)',
   'const V2_PLAN_MAX_BYTES = 1_000_000',
   'if (details.size > V2_PLAN_MAX_BYTES) continue',
   'message.updated',
   'message.part.updated',
   'session.message.content.updated',
   'session.created',
   'session.updated',
   'session.deleted',
]) {
  assert.ok(panelViews.includes(marker), `Plan/session/family marker missing: ${marker}`)
}
assert.ok(!panelViews.includes('context.client.session.list'), 'Orchestration must not enumerate global sessions')
assert.ok(!panelViews.includes('const children = new Map()'), 'Orchestration must not reconstruct session families manually')
assert.equal((panelViews.match(/^    useSessionMessageSync\(props\)$/gm) ?? []).length, 4, 'Plan, Session, Activity, and History must each request initial message sync')

const panelData = await import(`${panelDataUrl.href}?fixtures=${Date.now()}`)
const nativeDocument = { todos: [{ content: 'native plan', status: 'pending' }], source: 'native-v2' }
assert.deepEqual(panelData.resolvePlanSources([], [{ content: 'historical', status: 'completed' }], nativeDocument), {
  todos: [], source: 'session-todo', document: null,
}, 'cached empty todo list must suppress historical and native documents')
assert.deepEqual(panelData.resolvePlanSources(null, [], nativeDocument), {
  todos: [], source: 'session-todo', document: null,
}, 'historical empty todo list must suppress native documents')
const cachedTodos = [{ content: 'cached', status: 'in_progress' }]
assert.deepEqual(panelData.resolvePlanSources(cachedTodos, [{ content: 'historical', status: 'completed' }], nativeDocument), {
  todos: cachedTodos, source: 'session-todo', document: null,
}, 'cached todos must win')
const historicalTodos = [{ content: 'historical', status: 'completed' }]
assert.deepEqual(panelData.resolvePlanSources(null, historicalTodos, nativeDocument), {
  todos: historicalTodos, source: 'session-todo', document: null,
}, 'historical todos must win when cache has no signal')
assert.deepEqual(panelData.resolvePlanSources(null, null, nativeDocument), {
  todos: nativeDocument.todos, source: 'native-v2', document: nativeDocument,
}, 'native V2 document must be a fallback in an active session')
assert.equal(panelData.resolveRootID('child', { id: 'root' }), 'root')
assert.deepEqual(panelData.normalizeFamilyIDs('root', [{ id: 'child' }, { id: 'root' }, 'child', { sessionID: 'grandchild' }]), ['root', 'child', 'grandchild'], 'family IDs must include root and remove duplicates')
assert.deepEqual(panelData.normalizeFamilyIDs('root', [{ id: 'child-a' }, { id: 'child-b' }]), ['root', 'child-a', 'child-b'], 'family normalization must not introduce IDs outside the supplied family')

const planEntries = [
  { name: 'active-plan.md', isFile: () => true },
  { name: 'foreign-plan.md', isFile: () => true },
  { name: 'latest-plan.md', isFile: () => true },
  { name: 'active.txt', isFile: () => true },
  { name: 'directory-plan.md', isFile: () => false },
]
assert.deepEqual(
  panelData.selectV2PlanEntries(planEntries, 'active').map((entry) => entry.name),
  ['active-plan.md'],
  'an active session must select only its exact native V2 plan filename',
)
assert.deepEqual(
  panelData.selectV2PlanCandidates([
    { name: 'foreign-plan.md', updated: 300 },
    { name: 'latest-plan.md', updated: 200 },
    { name: 'active-plan.md', updated: 100 },
  ], 'active').map((entry) => entry.name),
  ['active-plan.md'],
  'an active session must not select a foreign or newer native plan document',
)
assert.deepEqual(
  panelData.selectV2PlanCandidates([
    { name: 'older-plan.md', updated: 100 },
    { name: 'latest-plan.md', updated: 300 },
  ], null).map((entry) => entry.name),
  ['latest-plan.md', 'older-plan.md'],
  'home native plan selection must retain latest-document ordering',
)
const syncedIDs = []
await panelData.syncFamilyMessages(['throws', 'after'], (id) => {
  syncedIDs.push(id)
  if (id === 'throws') throw new Error('synchronous sync failure')
})
assert.deepEqual(syncedIDs, ['throws', 'after'], 'one synchronous family message sync failure must not prevent other syncs')

for (const [name, policy, producerMarker] of [
  ['global AGENTS policy', agentsPolicy, 'Вкладки `Сессия`, `Activity`, `История`, `Оркестрация`, `Лимиты` заполняются автоматически из состояния session/provider и реальных tool/subagent событий'],
  ['Qwen orchestrator policy', orchestratorPolicy, 'TUI panels populate automatically from session/provider state and natural plan/tool/subagent events'],
  ['SOL orchestrator policy', solOrchestratorPolicy, 'TUI panels populate automatically from session/provider state and natural plan/tool/subagent events'],
]) {
  for (const marker of ['2-7', '- [ ]', '- [>]', '- [x]', producerMarker]) {
    assert.ok(policy.includes(marker), `${name} must define visible plan status/UI event contract: ${marker}`)
  }
  assert.ok(policy.includes(name === 'global AGENTS policy' ? 'статус' : 'status'), `${name} must require plan status updates`)
  assert.ok(policy.includes(name === 'global AGENTS policy' ? 'не создавай инструменты или подагентов ради UI' : 'never make artificial tool calls merely to populate UI panels'), `${name} must prohibit synthetic UI-producing calls`)
}
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
assert.ok(limits.gemini)
assert.equal(limits.gemini.minuteTokens.limit, 2000000)

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
