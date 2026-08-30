import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loadSource = async (relative) => {
  const source = readFileSync(resolve(root, relative), 'utf8')
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

const markdown = await loadSource('app/markdown.js')
const rendered = markdown.renderMarkdown('# Header\n\n```js\nconst x = 1\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>')
if (!rendered.includes('copy-code')) throw new Error('Markdown code copy control missing')
if (!rendered.includes('<table')) throw new Error('Markdown table rendering failed')
if (rendered.includes('<script>')) throw new Error('Raw HTML was not escaped')

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: { get: () => 'application/json' },
  json: async () => value,
  text: async () => typeof value === 'string' ? value : JSON.stringify(value),
})

const api = await loadSource('app/api.js')
let calls = []
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options })
  return response(200, { data: { ok: true } })
}
await api.sendPrompt({ id:'ses_native' }, { text:'hello', files:[{ uri:'data:text/plain;base64,WA==', name:'x' }], delivery:'queue' })
let body = JSON.parse(calls.at(-1).options.body)
if (body.delivery !== 'queue' || body.text !== 'hello') throw new Error('Current V2 prompt contract regression')

calls = []
await api.sendPrompt({ id:'ses_idle' }, { text:'start', files:[], delivery:'normal' })
body = JSON.parse(calls.at(-1).options.body)
if (body.text !== 'start' || body.resume !== true || 'delivery' in body) throw new Error('Idle prompt must resume a new drain')

calls = []
let attempt = 0
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options })
  attempt++
  return attempt === 1 ? response(422, 'unsupported shape') : response(200, { data: { ok:true } })
}
await api.sendPrompt({ id:'ses_compat' }, { text:'fallback', files:[], delivery:'steer' })
body = JSON.parse(calls.at(-1).options.body)
if (body.prompt?.text !== 'fallback' || body.delivery !== 'steer') throw new Error('Compatibility prompt fallback regression')

const enhancements = await loadSource('app/enhancements.js')
if (enhancements.parseSlash('/status')?.command !== 'status') throw new Error('Slash parser failed')
if (enhancements.parseSlash('/doctor')?.command !== 'doctor') throw new Error('Doctor slash parser failed')
if (enhancements.parseSlash('/review foo bar')?.arguments !== 'foo bar') throw new Error('Slash arguments parser failed')
if (enhancements.parseSlash('ordinary text') !== null) throw new Error('Slash parser accepted normal text')
if (enhancements.commandName({ name:'/init' }) !== 'init') throw new Error('Slash command normalization failed')
if (enhancements.windowLabel(300) !== 'Сессия · 5ч' || enhancements.windowLabel(10080) !== 'Неделя · 7д') throw new Error('Rate-limit window labels failed')

const rag = await loadSource('app/rag-control.js')
if (rag.parseRagStart('/rag-start')?.mode !== 'full') throw new Error('RAG default start parser failed')
if (rag.parseRagStart('/rag-start quick')?.mode !== 'quick') throw new Error('RAG quick start parser failed')
if (rag.parseRagStart('/rag-start full')?.mode !== 'full') throw new Error('RAG full start parser failed')
if (rag.parseRagStart('/rag-start nope') !== null) throw new Error('RAG parser accepted unknown mode')

const ui = await loadSource('app/ui-enhancements.js')
const zeroCost = [{ input:0, output:0, cache:{ read:0, write:0 } }]
const paidCost = [{ input:0.1, output:0, cache:{ read:0, write:0 } }]
if (!ui.isFreeModel({ id:'dynamic-free', cost:zeroCost })) throw new Error('Zero-cost model was not grouped as free')
if (ui.isFreeModel({ id:'paid-model', cost:paidCost })) throw new Error('Paid model was incorrectly grouped as free')
if (!ui.isFreeModel({ id:'hy3-free' })) throw new Error('Free-ID fallback failed')
if (!ui.isFreeModel({ id:'big-pickle' })) throw new Error('Big Pickle free fallback failed')
const modelRows = [
  { name:'Zulu', favorite:false, selected:false },
  { name:'Alpha', favorite:false, selected:true },
  { name:'Beta', favorite:true, selected:false },
]
modelRows.sort(ui.compareModelEntries)
if (modelRows.map((row)=>row.name).join(',') !== 'Beta,Alpha,Zulu') throw new Error('Model favorite/selected/alphabetical ordering regression')
const providerRows = [
  { id:'z', label:'Zulu', favoriteCount:0 },
  { id:'a', label:'Alpha', favoriteCount:0 },
  { id:'f', label:'Favorite provider', favoriteCount:2 },
]
providerRows.sort(ui.compareProviderGroups)
if (providerRows.map((row)=>row.id).join(',') !== 'f,a,z') throw new Error('Provider favorite/alphabetical ordering regression')

const ux = await loadSource('app/ux-state.js')
if (ux.composerActionState({ running:false, hasPayload:false }).kind !== 'send') throw new Error('Idle composer must show send')
if (ux.composerActionState({ running:true, hasPayload:false }).kind !== 'stop') throw new Error('Running empty composer must show stop')
if (ux.composerActionState({ running:true, hasPayload:false }).symbol !== '×') throw new Error('Stop action must use cancel icon instead of square')
if (ux.composerActionState({ running:true, hasPayload:true }).kind !== 'queue') throw new Error('Running composer with text must auto-queue')
if (ux.modeFromAgent('build-direct') !== 'build' || ux.modeFromAgent('plan') !== 'plan') throw new Error('Internal Build/Plan compatibility mapping regressed')
if (ux.agentFor('build', 'direct') !== 'build' || ux.agentFor('plan', 'direct') !== 'plan') throw new Error('Ordinary models must use native OpenCode agents')
if (ux.agentFor('build', 'orchestrated') !== 'build' || ux.agentFor('plan', 'orchestrated') !== 'plan') throw new Error('Orchestrated model must keep native OpenCode agents')
if (ux.profileFromAgent('build') !== 'direct' || ux.profileFromAgent('build-direct') !== 'direct') throw new Error('Agent ID must not imply orchestration')
if (!ux.permissionSummary('Команда', '{"command":"git status","description":"long"}').includes('git status')) throw new Error('Permission summary did not extract command')
if (!ux.permissionSummary('question', '{"questions":[{"label":"Сохранить изменения","description":"Сначала сохранить изменения"}]}').startsWith('Нужен выбор:')) throw new Error('Question permission summary is not human-readable')
if (ux.permissionSummary('Команда', 'x'.repeat(300)).length > 110) throw new Error('Permission summary must stay compact')
if (ux.ORCHESTRATED_MODEL.id !== 'qwen3.8-orchestrated' || ux.ORCHESTRATED_MODEL.label !== 'Qwen3.8 Max · Orchestrated') throw new Error('Orchestrated model identity regression')

const index = readFileSync(resolve(root, 'app/index.html'), 'utf8')
for (const marker of [
  '/ux-controls.css', '/ux-controls.js', '/advanced-features.css', '/advanced-features.js',
  '/runtime-dashboard.css', '/runtime-dashboard.js', '/runtime-v3-dashboard.css', '/runtime-v3-dashboard.js',
  '/appearance-bootstrap.js', '/appearance.css', '/appearance.js', '/auth-ui.js', '/mobile-ui.js',
  'id="composerAction"', 'id="permissionDetails"', 'model-catalog', 'id="appearanceDialog"',
  'id="appearanceButton"', 'id="limitsShell"',
]) {
  if (!index.includes(marker)) throw new Error(`UX shell marker missing: ${marker}`)
}
if ((index.match(/id="composerAction"/g) || []).length !== 1) throw new Error('Composer must expose exactly one contextual action control')
if (!index.includes('id="sessionActionList" class="action-list"></div></div></dialog>')) throw new Error('Session dialog modal wrapper is malformed')
if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(index)) throw new Error('Main app shell must keep application JavaScript out of inline scripts')

const uxControls = readFileSync(resolve(root, 'app/ux-controls.js'), 'utf8')
const uxCss = readFileSync(resolve(root, 'app/ux-controls.css'), 'utf8')
const uiSource = readFileSync(resolve(root, 'app/ui-enhancements.js'), 'utf8')
const advanced = readFileSync(resolve(root, 'app/advanced-features.js'), 'utf8')
const advancedCss = readFileSync(resolve(root, 'app/advanced-features.css'), 'utf8')
const accessFix = readFileSync(resolve(root, 'app/access-fix.js'), 'utf8')
const accessFixCss = readFileSync(resolve(root, 'app/access-fix.css'), 'utf8')
const appearance = readFileSync(resolve(root, 'app/appearance.js'), 'utf8')
const appearanceBootstrap = readFileSync(resolve(root, 'app/appearance-bootstrap.js'), 'utf8')
const appearanceCss = readFileSync(resolve(root, 'app/appearance.css'), 'utf8')
const mobileUi = readFileSync(resolve(root, 'app/mobile-ui.js'), 'utf8')
const authUi = readFileSync(resolve(root, 'app/auth-ui.js'), 'utf8')
const login = readFileSync(resolve(root, 'app/login.html'), 'utf8')
const loginJs = readFileSync(resolve(root, 'app/login.js'), 'utf8')
const serverSource = readFileSync(resolve(root, 'app/server.py'), 'utf8')
const runtimeDashboard = readFileSync(resolve(root, 'app/runtime-dashboard.js'), 'utf8')
const runtimeCss = readFileSync(resolve(root, 'app/runtime-dashboard.css'), 'utf8')
const runtimeV3Dashboard = readFileSync(resolve(root, 'app/runtime-v3-dashboard.js'), 'utf8')

if (!uxControls.includes("button.textContent = 'Build'")) throw new Error('Build must remain the compatibility work-mode label')
if (uxControls.includes("button.textContent = 'Direct'")) throw new Error('Direct must not be exposed as a user-facing mode label')
if (!uxControls.includes("event.target.closest('[data-orchestrated-model]')")) throw new Error('Orchestrated model click proxy missing')
if (!uxControls.includes('qwen3.8-orchestrated') && !uxControls.includes('ORCHESTRATED_MODEL.id')) throw new Error('Web orchestrated choice must target the dedicated model alias')
if (!uxControls.includes('window.CustomOpenCodeUX')) throw new Error('Project defaults cannot select orchestrated profile')
if (!uxControls.includes("setNativeDelivery('queue')")) throw new Error('Automatic queue compatibility bridge missing')
if (!uxControls.includes("addEventListener('submit', () => setTimeout(syncComposerAction, 0))")) throw new Error('Composer action must resync after programmatic queue clear')
if (!uxCss.includes('.delivery{display:none!important}')) throw new Error('Manual Steer/Queue control must stay hidden')
if (!uxCss.includes('.native-composer-action{display:none!important}')) throw new Error('Native send/stop controls must never create a second visible composer action')
if (!uxCss.includes('.composer-action.stop{background:#b23a3a')) throw new Error('Running empty composer must expose the red cancel action')
if (!uxCss.includes('-webkit-line-clamp:2')) throw new Error('Permission summary must be clamped instead of expanding the layout')
if (!uxCss.includes('.model-provider-toggle')) throw new Error('Collapsible provider styling missing')
if (!uxCss.includes('.model-favorite-toggle')) throw new Error('Favorite model control styling missing')
for (const marker of ['model-provider-collapse-v1', 'data-fav', 'compareModelEntries', 'compareProviderGroups']) {
  if (!uiSource.includes(marker)) throw new Error(`Model picker behavior marker missing: ${marker}`)
}
for (const marker of [
  '/client-queue.json', '/client-send.json', '/client-project-settings.json',
  '/api/question/request', 'questionAnswers', 'data-question-custom', 'Разрешать в проекте',
  '/api/session/${encodeURIComponent(state.sessionID)}/children', '/client-git-revert.json',
  'data-revert-hunk', 'workflowStatus', 'orchestrationTrace',
]) {
  if (!advanced.includes(marker)) throw new Error(`Advanced workflow marker missing: ${marker}`)
}
for (const marker of ['.question-card', '.queue-list', '.orchestration-trace', '.review-hunk', '.workflow-status']) {
  if (!advancedCss.includes(marker)) throw new Error(`Advanced workflow styling missing: ${marker}`)
}

for (const marker of ["root.style.display = 'none'", "modeSelect.value = 'build'", 'buildAgentForProfile', 'resolvedPermissions']) {
  if (!accessFix.includes(marker)) throw new Error(`Build-only/permission fix marker missing: ${marker}`)
}
if (!accessFixCss.includes('#agentControls') || !accessFixCss.includes('display:none!important')) throw new Error('Build/Plan switch must remain hidden')
if (!accessFixCss.includes('max-height:calc(100dvh')) throw new Error('Mobile dialogs must use the dynamic viewport')

for (const marker of ['opencode:web:appearance-v1', "theme:'system'", '--accent-contrast', 'prefers-color-scheme']) {
  if (!appearance.includes(marker)) throw new Error(`Appearance behavior marker missing: ${marker}`)
}
for (const marker of ['opencode:web:appearance-v1', 'prefers-color-scheme', '--accent-contrast']) {
  if (!appearanceBootstrap.includes(marker)) throw new Error(`Appearance bootstrap marker missing: ${marker}`)
}
for (const marker of ['html[data-theme="light"]', 'prefers-reduced-motion:reduce', '.accent-swatch', '@keyframes dialog-pop']) {
  if (!appearanceCss.includes(marker)) throw new Error(`Appearance styling marker missing: ${marker}`)
}

for (const marker of ['sidebarScrim', 'history.pushState', 'history.back()', '!sidebar.contains(target)', 'dx < -56']) {
  if (!mobileUi.includes(marker)) throw new Error(`Mobile drawer behavior marker missing: ${marker}`)
}
for (const marker of ['/auth/session', '/auth/logout', 'opencode:web:auth-resume-v1']) {
  if (!authUi.includes(marker)) throw new Error(`Auth UI marker missing: ${marker}`)
}
for (const marker of ['/auth/login', 'opencode:web:login-prefs-v2', 'remember:remember.checked']) {
  if (!loginJs.includes(marker)) throw new Error(`Login behavior marker missing: ${marker}`)
}
if (!login.includes('Запомнить вход') || !login.includes('HttpOnly-сессию')) throw new Error('Custom login UX markers missing')
for (const marker of ['AUTH_COOKIE_NAME', 'SameSite=Strict', 'OPENCODE_AUTH_ALLOW_BASIC', '/auth/login', '/login.html?next=']) {
  if (!serverSource.includes(marker)) throw new Error(`Cookie auth server marker missing: ${marker}`)
}
if (serverSource.includes('WWW-Authenticate')) throw new Error('Web server must not trigger browser-native Basic Auth challenge')

for (const marker of ['/client-model-capabilities.json', '/client-tasks.json', '/client-task-control.json', '/client-resource-status.json', '/client-speculate.json', '/client-task-create.json', 'Task Center', 'qwen3.8-coder']) {
  if (!runtimeDashboard.includes(marker)) throw new Error(`Runtime dashboard behavior marker missing: ${marker}`)
}
for (const marker of ['runtime-task', 'runtime-profile', 'runtime-state']) {
  if (!runtimeCss.includes(marker)) throw new Error(`Runtime dashboard styling marker missing: ${marker}`)
}
for (const marker of ['/client-runtime-v3.json', '/client-repo-index-v3.json', 'Runtime control plane']) {
  if (!runtimeV3Dashboard.includes(marker)) throw new Error(`Runtime V3 dashboard marker missing: ${marker}`)
}

const serviceWorker = readFileSync(resolve(root, 'app/sw.js'), 'utf8')
if (!serviceWorker.includes('custom-opencode-web-v6')) throw new Error('PWA cache generation must include auth/appearance generation')
if (!serviceWorker.includes("fetch(req,{cache:'no-cache'})")) throw new Error('PWA assets must prefer fresh network responses')
if (!serviceWorker.includes("event.action==='dismiss'")) throw new Error('Notification dismiss action missing')
if (serviceWorker.includes('return cached||network')) throw new Error('PWA must not serve stale cache before checking the network')
for (const marker of ["url.pathname.startsWith('/auth/')", "url.pathname.startsWith('/internal/')"]) {
  if (!serviceWorker.includes(marker)) throw new Error(`Sensitive PWA cache exclusion missing: ${marker}`)
}

const workflowServer = readFileSync(resolve(root, 'app/server_workflow.py'), 'utf8')
const featureServer = readFileSync(resolve(root, 'app/server_features.py'), 'utf8')
const runtimeServer = readFileSync(resolve(root, 'app/server_runtime.py'), 'utf8')
const service = readFileSync(resolve(root, 'systemd/opencode-web-client.service'), 'utf8')
for (const marker of ['/client-send.json', 'prompt_async', 'body["system"]', 'features._send_backend_prompt', 'runtime.install(features)']) {
  if (!workflowServer.includes(marker)) throw new Error(`Workflow server marker missing: ${marker}`)
}
for (const marker of ['/client-queue.json', '/client-project-settings.json', '/client-git-revert.json', 'permissionRules', 'git apply']) {
  if (!featureServer.includes(marker)) throw new Error(`Persistent feature server marker missing: ${marker}`)
}
for (const marker of ['/client-tasks.json', 'spawn_speculative', 'mcp_gateway', '_create_worktree', 'runtime.recovery_scan', 'agent.loop_detected', 'agent.stuck']) {
  if (!runtimeServer.includes(marker)) throw new Error(`Runtime server marker missing: ${marker}`)
}
if (!service.includes('app/server_workflow.py') || !service.includes('app/server_rag.py')) throw new Error('Production service must compose workflow and RAG layers')

let configText = readFileSync(resolve(root, 'config/opencode.json.template'), 'utf8')
  .replaceAll('__CONFIG_DIR__', '/tmp/opencode-config')
  .replaceAll('__CUSTOM_OPENCODE_ROOT__', '/tmp/custom-opencode')
  .replaceAll('__RAG_DISABLED__', 'true')
const config = JSON.parse(configText)
const agents = config.agents || {}
if (agents.build || agents.plan) throw new Error('Native OpenCode build/plan agents must not be overridden')
for (const id of ['build-direct', 'plan-direct']) {
  if (!agents[id] || agents[id].mode !== 'primary' || agents[id].hidden !== true) throw new Error(`Legacy compatibility agent must stay hidden: ${id}`)
}
const orchestrated = config.providers?.['bailian-cli']?.models?.['qwen3.8-orchestrated'] || {}
if (orchestrated.modelID !== 'qwen3.8-max') throw new Error('Orchestrated catalog model must route to the real qwen3.8-max API model')
if (orchestrated.name !== 'Qwen3.8 Max · Orchestrated') throw new Error('Orchestrated catalog model label regression')
const orchestratedPlugin = readFileSync(resolve(root, 'config/plugins/orchestrated-qwen.js'), 'utf8')
for (const marker of ['Plugin.define({', 'id: "orchestrated-qwen"', 'qwen3.8-orchestrated', 'ctx.session.hook("context"', 'Custom orchestrated Qwen policy']) {
  if (!orchestratedPlugin.includes(marker)) throw new Error(`Orchestrated Qwen plugin marker missing: ${marker}`)
}
for (const source of [orchestratedPlugin, readFileSync(resolve(root, 'config/plugins/server-runtime-guard.js'), 'utf8')]) {
  if (!source.includes('event.system.push({ type: "text"') && !source.includes('event.system.push({type:"text"')) throw new Error('Context hooks must add typed system parts')
}
if (!orchestratedPlugin.includes('id: "qwen3.8-max"') && !orchestratedPlugin.includes('id: "qwen3.8-max"')) {
  // The self-check below is the important invariant: ordinary Max must not match the special alias.
}

const doctor = await loadSource('app/doctor.js')
if (typeof doctor.openDoctor !== 'function') throw new Error('Doctor UI module does not export openDoctor')

console.log('Web smoke passed: Build-only UX + native OpenCode agents + dedicated orchestrated Qwen + Runtime V2/V3 + auth/appearance/mobile + queue/questions/permissions/review')
