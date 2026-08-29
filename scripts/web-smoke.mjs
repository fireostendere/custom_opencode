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
await api.sendPrompt({ id: 'ses_native' }, { text: 'hello', files: [{ uri: 'data:text/plain;base64,WA==', name: 'x' }], delivery: 'queue' })
let body = JSON.parse(calls.at(-1).options.body)
if (body.delivery !== 'queue' || body.prompt?.text !== 'hello') throw new Error('Current V2 prompt contract regression')

calls = []
let attempt = 0
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options })
  attempt++
  return attempt === 1 ? response(422, 'unsupported shape') : response(200, { data: { ok: true } })
}
await api.sendPrompt({ id: 'ses_compat' }, { text: 'fallback', files: [], delivery: 'steer' })
body = JSON.parse(calls.at(-1).options.body)
if (body.text !== 'fallback' || body.delivery !== 'steer') throw new Error('Compatibility prompt fallback regression')

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
if (ux.modeFromAgent('build-direct') !== 'build' || ux.modeFromAgent('plan') !== 'plan') throw new Error('Visible mode mapping must be Build/Plan')
if (ux.agentFor('build', 'direct') !== 'build-direct' || ux.agentFor('plan', 'direct') !== 'plan-direct') throw new Error('Direct profile mapping regression')
if (ux.agentFor('build', 'orchestrated') !== 'build' || ux.agentFor('plan', 'orchestrated') !== 'plan') throw new Error('Orchestrated profile mapping regression')
if (!ux.permissionSummary('Команда', '{"command":"git status","description":"long"}').includes('git status')) throw new Error('Permission summary did not extract command')
if (!ux.permissionSummary('question', '{"questions":[{"label":"Сохранить изменения","description":"Сначала сохранить изменения"}]}').startsWith('Нужен выбор:')) throw new Error('Question permission summary is not human-readable')
if (ux.permissionSummary('Команда', 'x'.repeat(300)).length > 110) throw new Error('Permission summary must stay compact')
if (ux.ORCHESTRATED_MODEL.label !== 'Qwen 3.8 Max · Оркестрированная') throw new Error('Orchestrated model label regression')

const index = readFileSync(resolve(root, 'app/index.html'), 'utf8')
for (const marker of ['/ux-controls.css', '/ux-controls.js', 'id="composerAction"', 'id="permissionDetails"', 'model-catalog']) {
  if (!index.includes(marker)) throw new Error(`UX shell marker missing: ${marker}`)
}
if ((index.match(/id="composerAction"/g) || []).length !== 1) throw new Error('Composer must expose exactly one contextual action control')
const uxControls = readFileSync(resolve(root, 'app/ux-controls.js'), 'utf8')
const uxCss = readFileSync(resolve(root, 'app/ux-controls.css'), 'utf8')
const uiSource = readFileSync(resolve(root, 'app/ui-enhancements.js'), 'utf8')
if (!uxControls.includes("button.textContent = 'Build'")) throw new Error('Build must be the user-facing work mode label')
if (uxControls.includes("button.textContent = 'Direct'")) throw new Error('Direct must not be exposed as a user-facing mode label')
if (!uxControls.includes("event.target.closest('[data-orchestrated-model]')")) throw new Error('Orchestrated model click proxy missing')
if (!uxControls.includes('syncOrchestratedChoiceLabel')) throw new Error('Orchestrated model variant label sync missing')
if (!uxControls.includes("setNativeDelivery('queue')")) throw new Error('Automatic queue bridge missing')
if (!uxControls.includes("addEventListener('submit', () => setTimeout(syncComposerAction, 0))")) throw new Error('Composer action must resync after programmatic queue clear')
if (!uxCss.includes('.delivery{display:none!important}')) throw new Error('Manual Steer/Queue control must stay hidden')
if (!uxCss.includes('.native-composer-action{display:none!important}')) throw new Error('Native send/stop controls must never create a second visible composer action')
if (!uxCss.includes('.composer-action.stop{background:#b23a3a')) throw new Error('Running empty composer must expose the red cancel action')
if (!uxCss.includes('-webkit-line-clamp:2')) throw new Error('Permission summary must be clamped instead of expanding the layout')
if (!uxCss.includes('.model-provider-toggle')) throw new Error('Collapsible provider styling missing')
if (!uxCss.includes('.model-favorite-toggle')) throw new Error('Favorite model control styling missing')
for (const marker of ["model-provider-collapse-v1", "data-fav", "compareModelEntries", "compareProviderGroups"]) {
  if (!uiSource.includes(marker)) throw new Error(`Model picker behavior marker missing: ${marker}`)
}

const serviceWorker = readFileSync(resolve(root, 'app/sw.js'), 'utf8')
if (!serviceWorker.includes("custom-opencode-web-v3")) throw new Error('PWA cache generation was not bumped')
if (!serviceWorker.includes("fetch(req,{cache:'no-cache'})")) throw new Error('PWA assets must prefer fresh network responses')
if (serviceWorker.includes('return cached||network')) throw new Error('PWA must not serve stale cache before checking the network')

let configText = readFileSync(resolve(root, 'config/opencode.json.template'), 'utf8')
  .replaceAll('__CONFIG_DIR__', '/tmp/opencode-config')
  .replaceAll('__CUSTOM_OPENCODE_ROOT__', '/tmp/custom-opencode')
  .replaceAll('__RAG_DISABLED__', 'true')
const config = JSON.parse(configText)
const agents = config.agents || {}
for (const id of ['build', 'plan', 'build-direct', 'plan-direct']) {
  if (!agents[id] || agents[id].mode !== 'primary') throw new Error(`Primary profile missing: ${id}`)
}
for (const id of ['build-direct', 'plan-direct']) {
  const rules = agents[id].permissions || []
  if (!rules.some((rule) => rule.action === 'subagent' && rule.effect === 'deny')) throw new Error(`${id} must deny subagents`)
  for (const action of ['kb_knowledge_search', 'kb_knowledge_get', 'kb_knowledge_sources', 'kb_knowledge_status', 'kb_knowledge_ingest']) {
    if (!rules.some((rule) => rule.action === action && rule.effect === 'deny')) throw new Error(`${id} must deny ${action}`)
  }
}
for (const action of ['edit', 'shell']) {
  if (!(agents['plan-direct'].permissions || []).some((rule) => rule.action === action && rule.effect === 'deny')) throw new Error(`plan-direct must deny ${action}`)
}
if (!String(agents.build.system || '').includes('orchestrator.md') || !String(agents.plan.system || '').includes('orchestrator.md')) throw new Error('Underlying orchestrated build/plan agents must keep orchestrator prompt')
if (agents['build-direct'].system || agents['plan-direct'].system) throw new Error('Direct profiles must not inherit orchestrator system prompt')

const doctor = await loadSource('app/doctor.js')
if (typeof doctor.openDoctor !== 'function') throw new Error('Doctor UI module does not export openDoctor')

console.log('Web smoke passed: Build/Plan UX + model-selected orchestration + automatic queue + compact permissions + contextual composer')
