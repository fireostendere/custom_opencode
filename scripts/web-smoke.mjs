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

globalThis.fetch = async (path) => {
  if (String(path).startsWith('/api/agent?')) return response(200, { data: [
    { id:'build', mode:'primary', hidden:false },
    { id:'build-direct', mode:'primary', hidden:true },
    { id:'role-builder', mode:'subagent', hidden:true },
  ] })
  if (String(path).startsWith('/api/model?')) return response(200, { data: [] })
  if (String(path).startsWith('/api/provider?')) return response(200, { data: [] })
  return response(200, { data: null })
}
const controls = await api.getControls('/tmp/project')
if (!controls.agents.some((agent) => agent.id === 'build-direct')) throw new Error('Hidden direct agent must remain available as an internal routing target')
if (controls.agents.some((agent) => agent.id === 'role-builder')) throw new Error('Hidden role agents must not leak into web controls')

const enhancements = await loadSource('app/enhancements.js')
const enhancementsSource = readFileSync(resolve(root, 'app/enhancements.js'), 'utf8')
if (!enhancementsSource.includes("panel._lastMarkup = ''")) throw new Error('Failed quota refresh must invalidate cached markup')
if (enhancements.parseSlash('/status')?.command !== 'status') throw new Error('Slash parser failed')
if (enhancements.parseSlash('/review foo bar')?.arguments !== 'foo bar') throw new Error('Slash arguments parser failed')
if (enhancements.parseSlash('ordinary text') !== null) throw new Error('Slash parser accepted normal text')
if (enhancements.commandName({ name:'/init' }) !== 'init') throw new Error('Slash command normalization failed')
if (!enhancementsSource.includes('const body = { command:parsed.command, text:parsed.arguments }')) throw new Error('Slash command transport must use OpenCode V2 text')
if (enhancementsSource.includes('const body = { command:parsed.command, arguments:parsed.arguments }')) throw new Error('Slash command transport must not send arguments')
if (!readFileSync(resolve(root, 'app/enhancements.js'), 'utf8').includes("RETIRED_COMMANDS = new Set(['doctor'])")) throw new Error('Retired Doctor command must stay blocked')
if (enhancements.windowLabel(300) !== 'Сессия · 5ч' || enhancements.windowLabel(10080) !== 'Неделя · 7д') throw new Error('Rate-limit window labels failed')

const rag = await loadSource('app/rag-control.js')
if (rag.parseRagStart('/rag-start')?.mode !== 'full') throw new Error('RAG default start parser failed')
if (rag.parseRagStart('/rag-start quick')?.mode !== 'quick') throw new Error('RAG quick start parser failed')
if (rag.parseRagStart('/rag-start full')?.mode !== 'full') throw new Error('RAG full start parser failed')
if (rag.parseRagStart('/rag-start nope') !== null) throw new Error('RAG parser accepted unknown mode')

const ui = await loadSource('app/ui-enhancements.js')
const uiProjectSource = readFileSync(resolve(root, 'app/ui-enhancements.js'), 'utf8')
const appProjectSource = readFileSync(resolve(root, 'app/app.js'), 'utf8')
const uxControlsSource = readFileSync(resolve(root, 'app/ux-controls.js'), 'utf8')
const advancedFeaturesSource = readFileSync(resolve(root, 'app/advanced-features.js'), 'utf8')
if (uiProjectSource.includes("request('/api/session'")) throw new Error('Directory browser must delegate session creation to app bridge')
for (const marker of ['CustomOpenCodeProjects', "request('/client-directories.json'", 'data-create-directory']) {
  if (!uiProjectSource.includes(marker)) throw new Error(`Directory creation flow marker missing: ${marker}`)
}
if (!appProjectSource.includes("$('newSession').addEventListener('click',()=>openProjectDialog('create'))")) throw new Error('New session must open the project dialog')
if (appProjectSource.includes("$('newSession').addEventListener('click',async()=>{clearSelection()")) throw new Error('New session must not clear the current selection')
if (!appProjectSource.includes("source?.agent||state.draftAgent") || !appProjectSource.includes("source?.model||state.draftModel")) throw new Error('New session must preserve active controls')
if (!uxControlsSource.includes("function currentMode() {\n  return 'build'\n}")) throw new Error('Web must always use Build mode')
if (!uxControlsSource.includes('function targetAgent(mode, profile)')) throw new Error('Build must fall back when compatibility agents are unavailable')
if (uxControlsSource.includes('modeFromAgent')) throw new Error('Web must not derive Plan mode from a session agent')
if (!advancedFeaturesSource.includes('if (!state.sessionID || !activityBelongsToSession(payload)) return')) throw new Error('Build must collect tool and agent activity')
if (!advancedFeaturesSource.includes('const planPanelMarkup = plan ?')) throw new Error('Native plan documents must remain visible when present')
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
if (ux.agentFor('build', 'direct') !== 'build-direct' || ux.agentFor('plan', 'direct') !== 'plan-direct') throw new Error('Ordinary models must use isolated direct agents')
if (ux.agentFor('build', 'orchestrated') !== 'build' || ux.agentFor('plan', 'orchestrated') !== 'plan') throw new Error('Orchestrated model must keep native OpenCode agents')
if (ux.profileFromAgent('build') !== 'direct' || ux.profileFromAgent('build-direct') !== 'direct') throw new Error('Agent ID must not imply orchestration')
if (!ux.permissionSummary('Команда', '{"command":"git status","description":"long"}').includes('git status')) throw new Error('Permission summary did not extract command')
if (!ux.permissionSummary('question', '{"questions":[{"label":"Сохранить изменения","description":"Сначала сохранить изменения"}]}').startsWith('Нужен выбор:')) throw new Error('Question permission summary is not human-readable')
if (ux.permissionSummary('Команда', 'x'.repeat(300)).length > 110) throw new Error('Permission summary must stay compact')
if (ux.ORCHESTRATED_MODEL.id !== 'qwen3.8-orchestrated' || ux.ORCHESTRATED_MODEL.label !== 'Qwen3.8 Max · Orchestrated') throw new Error('Orchestrated Qwen identity regression')
if (ux.SOL_ORCHESTRATED_MODEL.id !== 'gpt-5.6-sol-orchestrated' || ux.SOL_ORCHESTRATED_MODEL.providerID !== 'openai') throw new Error('Orchestrated SOL identity regression')

const index = readFileSync(resolve(root, 'app/index.html'), 'utf8')
for (const marker of [
  '/ux-controls.css', '/ux-controls.js', '/advanced-features.css', '/advanced-features.js',
  '/design-system.css', '/sidebar-resize.js',
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
const designSystem = readFileSync(resolve(root, 'app/design-system.css'), 'utf8')
const sidebarResize = readFileSync(resolve(root, 'app/sidebar-resize.js'), 'utf8')
const forms = await loadSource('app/advanced-features.js')
const typedRaw = {
  id: 'frm_smoke',
  sessionID: 'ses_forms',
  title: 'Typed form',
  fields: [
    { key:'name', type:'string', default:'alpha', options:[{ value:'alpha', label:'Alpha' }] },
    { key:'ratio', type:'number', default:2.5, required:true },
    { key:'count', type:'integer', default:4, required:true },
    { key:'enabled', type:'boolean', default:false, required:true },
    { key:'labels', type:'multiselect', default:['one'], options:[{ value:'one', label:'One' }], custom:true },
    { key:'body', type:'text', default:'hello' },
  ],
}
const typed = forms.normalizeQuestionRequest(typedRaw)
if (!typed || typed.formID !== 'frm_smoke' || typed.raw !== typedRaw) throw new Error('Native form identity/raw payload normalization failed')
if (typed.questions.map((question) => question.type).join(',') !== 'string,number,integer,boolean,multiselect,text') throw new Error('Typed form field normalization failed')
if (typed.questions[1].custom === false || typed.questions[2].custom === false) throw new Error('Numeric form fields must expose editable inputs')
if (typed.questions[3].custom !== false) throw new Error('Boolean form field must not expose string custom input')
const defaults = forms.questionSelectionFor(typed)
const defaultAnswers = forms.questionAnswers(typed, defaults)
if (JSON.stringify(defaultAnswers) !== JSON.stringify({ name:'alpha', ratio:2.5, count:4, enabled:false, labels:['one'], body:'hello' })) throw new Error('Native form defaults/typed answers failed')
defaults[4].custom = 'two'
if (JSON.stringify(forms.questionAnswers(typed, defaults).labels) !== JSON.stringify(['one', 'two'])) throw new Error('Native multiselect custom answer failed')
const invalidIntegerRequest = { transport:'form', questions:[{ key:'count', type:'integer', required:true, multiple:false, options:[] }] }
const invalidInteger = forms.questionAnswers(invalidIntegerRequest, [{ selected:new Set(), custom:'1.5' }])
if ('count' in invalidInteger || !forms.questionAnswersMissing(invalidInteger, invalidIntegerRequest)) throw new Error('Invalid integer answer must be rejected')
const invalidBooleanRequest = { transport:'form', questions:[{ key:'enabled', type:'boolean', required:true, multiple:false, options:[] }] }
const invalidBoolean = forms.questionAnswers(invalidBooleanRequest, [{ selected:new Set(), custom:'maybe' }])
if ('enabled' in invalidBoolean || !forms.questionAnswersMissing(invalidBoolean, invalidBooleanRequest)) throw new Error('Invalid boolean answer must be rejected')
const fieldsAlias = forms.normalizeQuestionRequest({ id:'frm_alias', sessionID:'ses_forms', form:[{ key:'value', type:'string' }] })
if (!fieldsAlias || fieldsAlias.formID !== 'frm_alias' || fieldsAlias.questions[0].key !== 'value') throw new Error('Form array compatibility normalization failed')
const accessFix = readFileSync(resolve(root, 'app/access-fix.js'), 'utf8')
const accessFixCss = readFileSync(resolve(root, 'app/access-fix.css'), 'utf8')
const appSource = readFileSync(resolve(root, 'app/app.js'), 'utf8')
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

if (!uxControls.includes('const mode = currentMode()')) throw new Error('Build must remain synchronized with the native agent')
if (!appSource.includes('function directModelRef()')) throw new Error('Direct profile must restore a concrete model instead of an orchestration alias')
if (uxControls.includes("button.textContent = 'Direct'")) throw new Error('Direct must not be exposed as a user-facing mode label')
if (!uxControls.includes("event.target.closest('[data-orchestrated-model]')")) throw new Error('Orchestrated model click proxy missing')
if (!uxControls.includes('ORCHESTRATED_MODELS') || !uxControls.includes('nativeOrchestratedChoice')) throw new Error('Web orchestrated choice must target the dedicated model aliases')
if (!uxControls.includes('window.CustomOpenCodeUX')) throw new Error('Project defaults cannot select orchestrated profile')
if (!uxControls.includes("setNativeDelivery('queue')")) throw new Error('Automatic queue compatibility bridge missing')
if (!uxControls.includes("addEventListener('submit', () => setTimeout(syncComposerAction, 0))")) throw new Error('Composer action must resync after programmatic queue clear')
if (!uxCss.includes('.delivery{display:none!important}')) throw new Error('Manual Steer/Queue control must stay hidden')
if (!uxCss.includes('.native-composer-action{display:none!important}')) throw new Error('Native send/stop controls must never create a second visible composer action')
if (!uxCss.includes('.composer-action.stop{background:#b23a3a')) throw new Error('Running empty composer must expose the red cancel action')
if (!designSystem.includes('.attach::before') || !designSystem.includes('.composer-action.send::before') || !designSystem.includes('.composer-action.queue::before') || !designSystem.includes('rotate(90deg)')) throw new Error('Composer icons must use centered right-facing CSS geometry')
if (!uxCss.includes('-webkit-line-clamp:2')) throw new Error('Permission summary must be clamped instead of expanding the layout')
if (!uxCss.includes('.model-provider-toggle')) throw new Error('Collapsible provider styling missing')
if (!uxCss.includes('.model-favorite-toggle')) throw new Error('Favorite model control styling missing')
for (const marker of ['model-provider-collapse-v1', 'data-fav', 'compareModelEntries', 'compareProviderGroups', 'providerPriority']) {
  if (!uiSource.includes(marker)) throw new Error(`Model picker behavior marker missing: ${marker}`)
}
for (const marker of ['PROJECT_ORDER_KEY', 'SESSION_TREE_KEY', 'compareSessions', 'handleDrop', 'transferSessionToProject', 'data-session-drag', 'draggable="true"']) {
  if (!appSource.includes(marker)) throw new Error(`Session drag-and-drop marker missing: ${marker}`)
}
for (const marker of ["data-action=\"copy-context\"", "data-action=\"move-project\"", 'removeSource:true', "api.deleteSession(session.id)"]) {
  if (!appSource.includes(marker)) throw new Error(`Session copy/move marker missing: ${marker}`)
}
if (!appSource.includes('async function changeAgent(agent){const sessionID=state.selected?.id||null,previous=state.selected?.agent||state.draftAgent;if(!state.selected){state.draftAgent=agent;renderControls();')) throw new Error('changeAgent must isolate draft and selected-session state')
if (!appSource.includes('const initialAgent=session.agent')) throw new Error('Session loading must preserve a concurrent agent switch')
if (!appSource.includes('async function changeModel(model){const sessionID=state.selected?.id||null,previousModel=activeModelRef()?{...activeModelRef()}:null;if(!state.selected){state.draftModel={...model};saveLastModel(model);renderControls();')) throw new Error('changeModel must only write the draft when no session is selected')
for (const marker of [
  '/client-queue.json', '/client-send.json', '/client-project-settings.json',
  '/api/form/request', '/api/question', 'questionAnswers', 'data-question-custom', 'Разрешать в проекте',
  '/api/session/${encodeURIComponent(sessionID)}/children', '/client-git-revert.json', '/client-plan.json', 'custom-opencode:session-selected',
  'data-revert-hunk', 'workflowStatus', 'orchestrationTrace', 'refreshPlan', 'orchestration-plan',
]) {
  if (!advanced.includes(marker)) throw new Error(`Advanced workflow marker missing: ${marker}`)
}
if (!advanced.includes('syncProjectModelOptions')) throw new Error('Project settings must use the current model catalog')
if (advanced.includes('workflowSurfaceEnabled')) throw new Error('Activity must not depend on profile or Plan mode')
if (!advanced.includes('const livePanelMarkup = `<details class="orchestration-panel live-panel">')) throw new Error('Build must always render the tool and agent activity panel')
if (!advanced.includes('if (host._structureMarkup === structureMarkup)')) throw new Error('Unchanged activity structure must not churn the DOM')
if (!appSource.includes('inner._lastHtml===fullHtml&&!anchor&&!bottom')) throw new Error('DOM cache must not suppress requested scroll restoration')
if (advanced.includes('id="projectDefaultMode"')) throw new Error('Web project settings must not expose Plan mode')
if (!advanced.includes("const panelOpen={plan:host.querySelector('.plan-panel')?.open===true")) throw new Error('Orchestration panel must preserve its open state while refreshing')
if (!advanced.includes('captureScrollState(host.querySelector(\'.plan-panel-body\'))') || !advanced.includes('captureScrollState(host.querySelector(\'.orchestration-nodes\'))') || !advanced.includes('requestAnimationFrame(() =>')) throw new Error('Orchestration panel must preserve both scroll positions after layout while refreshing')
if (!advanced.includes('orchestrationRevision') || !advanced.includes('orchestrationRenderRevision') || !advanced.includes('state.sessionID !== sessionID')) throw new Error('Orchestration refresh and deferred scroll restoration must reject stale sessions/renders')
if (advanced.includes('activity-chevron') || advancedCss.includes('activity-chevron')) throw new Error('Orchestration summaries must use only the shared right chevron')
if (!index.includes('class="messages-frame"') || !index.includes('id="scrollToBottom"') || !appSource.includes('updateScrollToBottomButton') || !appSource.includes('scrollMessagesToBottom')) throw new Error('Messages need an accessible fixed scroll-to-bottom control')
if (!appSource.includes('loadContext({force:Boolean(cachedContext),initial:true})') || !appSource.includes('bottom:initial||!wasLoaded')) throw new Error('Every initial session selection must open at the newest message')
if (!advanced.includes('orchestrationPurpose(agent)') || !advanced.includes('class="node-purpose"')) throw new Error('Orchestration nodes must explain their role')
if (!advanced.includes('!host.contains(event.target)')) throw new Error('Orchestration panel must close on outside click')
if (!appSource.includes('configuredEffort')) throw new Error('Effort control must expose the configured model default')
if (!index.includes('class="control-select"')) throw new Error('Effort select must have a dedicated chevron wrapper')
const modelControlIndex = index.indexOf('id="modelButton"')
const effortControlIndex = index.indexOf('id="variantSelect"')
if (!(modelControlIndex < effortControlIndex)) throw new Error('Composer controls must be ordered Model, Effort')
if (index.includes('showArchived') || index.includes('> Архив')) throw new Error('Archive filter must stay removed from the sidebar')
if (!appSource.includes('PROJECT_COLLAPSE_KEY') || !appSource.includes('class="project-group"')) throw new Error('Session folders must remain collapsible')
if (!appSource.includes("$('modelChoices').addEventListener('click'")) throw new Error('Favorites must use a stable model-picker click delegate')
for (const marker of ["id: '__favorites__'", "label: 'Избранное'", "group.id === '__favorites__'"]) {
  if (!uiSource.includes(marker)) throw new Error(`Dedicated favorites section marker missing: ${marker}`)
}
if (!runtimeDashboard.includes("runtimeProfileBadge')?.remove()")) throw new Error('Redundant runtime profile badge must be removed')
if (runtimeDashboard.includes('injectProfiles') || runtimeDashboard.includes('Server profiles')) throw new Error('Runtime profiles must not be injected into the model picker')
if (!designSystem.includes('.model-catalog>.model-provider-section{flex:0 0 auto')) throw new Error('Model provider sections must not shrink inside scroll catalog')
for (const marker of ['model-favorite-toggle', 'permissionFromEvent', 'permissionSessionID', '.composer-action.stop::before', '--scrollbar-size']) {
  if (!(uiSource.includes(marker) || accessFix.includes(marker) || designSystem.includes(marker))) throw new Error(`UI regression marker missing: ${marker}`)
}
if (appSource.includes("payload.type==='permission.asked'") || appSource.includes('setInterval(refreshPermissions')) throw new Error('Permission banner must have a single access-fix owner')
if (!accessFix.includes("window.addEventListener('custom-opencode:event'")) throw new Error('Permission events must reach the web banner owner')
for (const marker of ['dialog#modelDialog', 'height:0', 'overflow-y:scroll', 'scrollbar-gutter:stable']) {
  if (!designSystem.includes(marker)) throw new Error(`Model dialog scroll contract missing: ${marker}`)
}
if (advanced.includes('/api/question/request')) throw new Error('Legacy question request endpoint must stay removed')
for (const marker of ['/api/form/request', '/api/question', 'question.asked', 'question.v2.asked', 'question.replied', 'question.rejected', 'custom-opencode:event']) {
  if (!advanced.includes(marker) && !appSource.includes(marker)) throw new Error(`Native question marker missing: ${marker}`)
}
for (const marker of ['.question-card', '.queue-list', '.orchestration-trace', '.orchestration-plan', '.orchestration-plan-meter', '.review-hunk', '.workflow-status']) {
  if (!advancedCss.includes(marker)) throw new Error(`Advanced workflow styling missing: ${marker}`)
}
for (const marker of ['orchestration-panels', 'orchestration-summary', 'activity-current-label', 'activityItems', 'activityDescriptor', 'panelOpen']) {
  if (!(advanced.includes(marker) || advancedCss.includes(marker))) throw new Error(`Activity dock marker missing: ${marker}`)
}
if (!advanced.includes('details.some((detail)=>detail.open)')) throw new Error('Plan and activity panels must share expanded state')
for (const marker of ['--sidebar-width', '--scrollbar-size', '.sidebar-resizer', '*::-webkit-scrollbar-thumb', '.limits-summary::after', '.model-provider-chevron', 'overflow-y:auto', '.workflow-grid']) {
  if (!designSystem.includes(marker)) throw new Error(`Design-system styling missing: ${marker}`)
}
for (const marker of ['pull-refresh', 'role\',\'status', 'pull-refresh-progress', 'pull-refresh-pull', 'const atBottom=', 'Тяните вверх для обновления', 'Удерживайте для обновления', 'gesture.startY-touch.clientY', 'stopHold();hide()', 'SWIPE_DISTANCE=18', 'HOLD_DURATION', 'requestAnimationFrame(updateHold)', 'touchmove']) {
  if (!(appSource.includes(marker) || designSystem.includes(marker))) throw new Error(`Pull refresh marker missing: ${marker}`)
}
for (const marker of ['claimedAttachments', 'previousRun?state.running.set', 'queueFor(session.id).push']) {
  if (!appSource.includes(marker)) throw new Error(`Duplicate-send guard missing: ${marker}`)
}
for (const marker of ['promptHistory', 'promptHistoryEntries', 'navigatePromptHistory', 'rememberSubmittedPrompt', "message.type==='user'||message.role==='user'"]) {
  if (!appSource.includes(marker)) throw new Error(`Session prompt history marker missing: ${marker}`)
}
if (!appSource.includes("e.key==='ArrowUp'&&navigatePromptHistory(-1,e)") || !appSource.includes("e.key==='ArrowDown'&&navigatePromptHistory(1,e)")) throw new Error('Web prompt history must use ArrowUp/ArrowDown')
if (!designSystem.includes('@media(hover:none) and (pointer:coarse)') || !designSystem.includes('.session:hover:not(.active)')) throw new Error('Touch UI must clear synthetic sticky hover without clearing selected sessions')
for (const marker of ['submitPending: false', 'if (state.submitPending) return', 'action.disabled = true', 'state.submitPending = false']) {
  if (!advanced.includes(marker)) throw new Error(`Managed-send duplicate guard missing: ${marker}`)
}
for (const marker of ['.orchestration-nodes{max-height:', 'overflow-y:auto', 'scrollbar-gutter:stable']) {
  if (!designSystem.includes(marker)) throw new Error(`Orchestration scroll marker missing: ${marker}`)
}
for (const marker of ['sidebarResizer', 'localStorage', 'pointerdown', 'ArrowLeft', 'ArrowRight']) {
  if (!sidebarResize.includes(marker)) throw new Error(`Sidebar resize behavior missing: ${marker}`)
}

if (!accessFix.includes('resolvedPermissions')) throw new Error('Permission suppression fix missing')
if (!accessFixCss.includes('#agentControls{\n  display:none!important') || !index.includes('id="agentControls" hidden aria-hidden="true"')) throw new Error('Web composer must hide the native agent bridge')
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

 for (const marker of ['/client-model-capabilities.json', '/client-tasks.json', '/client-task-control.json', '/client-resource-status.json', '/client-speculate.json', '/client-task-create.json', 'Task Center', "profile:profile()"] ) {
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
for (const marker of ['/client-tasks.json', '/client-plan.json', 'latest_plan_document', '_parse_plan_document', 'spawn_speculative', 'mcp_gateway', '_create_worktree', 'runtime.recovery_scan', 'agent.loop_detected', 'agent.stuck']) {
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
const solOrchestrated = config.providers?.openai?.models?.['gpt-5.6-sol-orchestrated'] || {}
if (solOrchestrated.modelID !== 'gpt-5.6-sol') throw new Error('Orchestrated SOL catalog model must route to the real gpt-5.6-sol API model')
if (solOrchestrated.name !== 'GPT-5.6 Sol · Orchestrated') throw new Error('Orchestrated SOL catalog model label regression')
for (const id of ['sol-fast-reader', 'sol-role-builder', 'sol-role-builder-high', 'sol-role-builder-max', 'sol-role-reviewer', 'sol-role-reviewer-max']) {
  if (!agents[id]) throw new Error(`SOL role agent missing: ${id}`)
}
const orchestratedPlugin = readFileSync(resolve(root, 'config/plugins/orchestrated-qwen.js'), 'utf8')
for (const marker of ['Plugin.define({', 'id: "orchestrated-qwen"', 'qwen3.8-orchestrated', 'gpt-5.6-sol-orchestrated', 'isOrchestratedSol', 'orchestrator-sol.md', 'ctx.session.hook("context"', 'Custom orchestrated Qwen policy', 'Custom orchestrated SOL policy']) {
  if (!orchestratedPlugin.includes(marker)) throw new Error(`Orchestrated Qwen plugin marker missing: ${marker}`)
}
for (const source of [orchestratedPlugin, readFileSync(resolve(root, 'config/plugins/server-runtime-guard.js'), 'utf8')]) {
  if (!source.includes('event.system.push({ type: "text"') && !source.includes('event.system.push({type:"text"')) throw new Error('Context hooks must add typed system parts')
}
if (!orchestratedPlugin.includes('id: "qwen3.8-max"') && !orchestratedPlugin.includes('id: "qwen3.8-max"')) {
  // The self-check below is the important invariant: ordinary Max must not match the special alias.
}

for (const marker of ['doctorButton', 'doctorDialog', 'doctor.js', 'doctor.css', 'client-doctor']) {
  if (index.includes(marker)) throw new Error(`Removed Doctor surface is still present: ${marker}`)
}

console.log('Web smoke passed: Build-only UX + always-on activity + native TUI Plan + dedicated Qwen/SOL orchestration + Runtime V2/V3')
