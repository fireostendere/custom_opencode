import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const sourceUrl = new URL('config/plugins/tui/model-selector.jsx', root)
let source = await readFile(sourceUrl, 'utf8')

// The smoke tests this repository's plugin logic without requiring a packaged
// OpenCode installation. Replace only the external Plugin import with its
// minimal define contract; all context APIs below are explicit fakes.
source = source.replace(
  'import { Plugin } from "@opencode-ai/plugin/tui"',
  'const Plugin = { define(value) { return value } }',
)
source = source.replace(
  './lib/limits-helper.js',
  new URL('config/plugins/tui/lib/limits-helper.js', root).href,
)
source = source.replace(
  './lib/agent-sync.js',
  new URL('config/plugins/tui/lib/agent-sync.js', root).href,
)
// Solid's reactive scheduler is outside this smoke; effects run eagerly and
// are re-run explicitly through rerunEffects().
source = source.replace(
  'import { createEffect } from "solid-js"',
  'const createEffect = (fn) => { (globalThis.__effects ||= []).push(fn); fn() }',
)
source = source.replace(/<span[^>]*>\{([^}]+)\}<\/span>/g, '$1')
assert.ok(!source.includes('@opencode-ai/plugin/tui'), 'plugin import replacement failed')
for (const modelID of ['gpt-6-astra', 'gpt-6-astra-orchestrated', 'gpt-6-sol-orchestrated', 'gpt-6-dnd-edition', 'gpt-6-sol-direct', 'gpt-6-luna-direct']) {
  assert.ok(source.includes(`openai/${modelID}`), `SOL orchestration model missing from TUI grouping: ${modelID}`)
}
assert.ok(!source.includes('openai/gpt-6-sol-fast'), 'SOL Fast must not be used by the TUI orchestration grouping')
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const plugin = (await import(moduleUrl)).default
assert.equal(plugin.id, 'custom.model-selector')
assert.equal(typeof plugin.setup, 'function')

globalThis.Bun = {
  file() {
    return {
      async json() {
        return { variant: { 'bailian-cli/qwen-flash': 'medium' } }
      },
    }
  },
}

const layers = []
let dialogOptions = null
const dialogCurrents = []
let switched = null
let created = null
let navigated = null
let persisted = null
let persistedFavorites = null
let cleared = 0
let selectCalls = 0
let simulateJump = false
let simulateFavorite = false
let failSwitch = false
let createResponse = { id: 'ses_home' }
let freshRecent = null
let modelChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }
let currentAgent = 'build'
const agentChanges = []
let sessionStatus = 'idle'
let sessionParent
let sessionModel = null
let agentChoice = 'plan'
const agentList = [
  { id: 'build', mode: 'primary' },
  { id: 'general', mode: 'subagent' },
  { id: 'plan', mode: 'primary' },
  { id: 'build-direct', mode: 'primary', hidden: true },
  { id: 'dnd-narrator', mode: 'primary', model: { providerID: 'openai', id: 'gpt-6-dnd-edition', variant: 'auto' } },
]
const toasts = []
let route = { type: 'session', sessionID: 'ses_test' }
const current = { providerID: 'bailian-cli', modelID: 'qwen3.8-max' }
const recentState = {
  models: [
    { providerID: 'openai', modelID: 'gpt-test' },
    { providerID: 'bailian-cli', modelID: 'qwen3.8-max' },
  ],
}
const favoriteState = { models: [] }
let toggleFavoriteChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }
const dialogHistory = []

const models = [
  { providerID: 'bailian-cli', id: 'qwen3.8-max', name: 'Qwen Max', enabled: true, status: 'active', cost: [{ input: 0.1 }] },
  { providerID: 'bailian-cli', id: 'qwen-flash', name: 'Qwen Flash', enabled: true, status: 'active', cost: [{ input: 0.01 }], variants: [{ id: 'low' }, { id: 'medium' }] },
  { providerID: 'bailian-cli', id: 'qwen3.7-plus', name: 'Qwen Plus', enabled: true, status: 'active', cost: [{ input: 0.04 }] },
  { providerID: 'openai', id: 'gpt-test', name: 'GPT Test', enabled: true, status: 'active', cost: [{ input: 0.2 }] },
  { providerID: 'openai', id: 'gpt-6-astra', name: 'GPT-6 Astra', enabled: true, status: 'active', cost: [{ input: 1 }] },
  { providerID: 'openai', id: 'gpt-6-astra-orchestrated', name: 'GPT-6 Astra · Orchestrated', enabled: true, status: 'active', cost: [{ input: 1 }] },
  { providerID: 'openai', id: 'gpt-6-sol-orchestrated', name: 'GPT-6 Sol · Orchestrated', enabled: true, status: 'active', cost: [{ input: 1 }] },
  { providerID: 'openai', id: 'gpt-6-dnd-edition', name: 'GPT-6 · DnD Edition', enabled: true, status: 'active', cost: [{ input: 1 }], variants: [{ id: 'auto' }] },
  { providerID: 'opencode', id: 'free-model', name: 'Free Model', enabled: true, status: 'active', cost: [{ input: 0 }] },
  { providerID: 'other', id: 'z-model', name: 'Z Model', enabled: true, status: 'active', cost: [{ input: 1 }] },
  { providerID: 'other', id: 'old-model', name: 'Old Model', enabled: false, status: 'deprecated', cost: [{ input: 0.5 }] },
  { providerID: 'google', id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true, status: 'active' },
  { providerID: 'google', id: 'veo-3.1-generate-preview', name: 'Veo 3.1', enabled: true, status: 'active' },
  { providerID: 'google', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', enabled: true, status: 'active' },
]
const providers = [
  { id: 'bailian-cli', name: 'Alibaba Cloud' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'google', name: 'Google' },
  { id: 'other', name: 'Other Provider' },
]

const context = {
  storage: {
    store(name) {
      const state = name === 'model-selector.favorites' ? favoriteState : recentState
      return [state, async (mutate) => {
        const draft = structuredClone(state)
        mutate(draft)
        state.models = draft.models
        if (name === 'model-selector.favorites') persistedFavorites = structuredClone(draft.models)
        else persisted = structuredClone(draft.models)
      }]
    },
  },
  ui: {
    router: {
      current: () => route,
      navigate: (value) => { navigated = value },
    },
    dialog: {
      async select(value) {
        dialogOptions = value.options
        dialogHistory.push(value.options)
        dialogCurrents.push(value.current)
        selectCalls++
        if (value.title === 'Toggle Favorite') {
          return { ...toggleFavoriteChoice }
        }
        if (value.title === 'Select Agent') return agentChoice
        if (simulateFavorite && selectCalls === 1) {
          const favoriteToggle = commands.find((item) => item.id === 'model-selector.favorite-toggle')
          assert.ok(favoriteToggle, 'favorite-toggle command was not registered')
          favoriteToggle.run()
          return undefined
        }
        if (simulateJump && selectCalls === 1) {
          // Simulate Alt+Down while the dialog is open: the jump command
          // records a reopen target and closes the dialog via clear(), so
          // select() resolves with undefined just like a cancel would.
          const jumpNext = commands.find((item) => item.id === 'model-selector.group-next')
          assert.ok(jumpNext, 'group-next command was not registered')
          jumpNext.run()
          return undefined
        }
        // Choose Qwen Flash to exercise persistence + switchModel.
        return modelChoice
      },
      clear() {
        cleared++
      },
    },
    toast: { show(toast) { toasts.push(toast) } },
    slot({ render }) {
      render()
      return () => {}
    },
  },
  data: {
    session: {
      get: () => ({
        agent: currentAgent,
        parentID: sessionParent,
        location: { directory: '/tmp/project' },
        model: sessionModel ? { ...sessionModel } : { providerID: current.providerID, id: current.modelID },
      }),
      status: () => sessionStatus,
    },
    location: {
      default: () => ({ directory: '/tmp/project' }),
      agent: { list: () => agentList },
    },
  },
  client: {
    model: {
      list: async () => ({ data: models }),
      default: async () => ({ data: { providerID: 'bailian-cli', id: 'qwen3.8-max' } }),
    },
    provider: { list: async () => ({ data: providers }) },
    session: {
      switchAgent: async ({ agent }) => {
        currentAgent = agent
        agentChanges.push(agent)
      },
      switchModel: async (value) => {
        if (failSwitch) throw new Error('switch failed')
        if (freshRecent) recentState.models = freshRecent
        switched = value
        if (sessionModel) sessionModel = { ...value.model }
      },
      create: async (value) => {
        created = value
        return createResponse
      },
    },
  },
  keymap: {
    layer(factory) {
      layers.push(factory())
      return () => {}
    },
  },
}

const cleanup = plugin.setup(context)
assert.equal(typeof cleanup, 'function')
const commands = layers.flatMap((layer) => layer.commands || [])
const command = commands.find((item) => item.id === 'model.list')
assert.ok(command, 'model.list command was not registered')
assert.deepEqual(command.slash, { name: 'models', aliases: ['mo'] })
const groupPrev = commands.find((item) => item.id === 'model-selector.group-prev')
assert.ok(groupPrev, 'group-prev command was not registered')
assert.equal(groupPrev.bind, 'alt+up')
assert.equal(groupPrev.run(), false, 'jump keys must pass through while the dialog is closed')
const favoriteToggle = commands.find((item) => item.id === 'model-selector.favorite-toggle')
assert.ok(favoriteToggle, 'favorite-toggle command was not registered')
assert.equal(favoriteToggle.bind, 'ctrl+f')
assert.equal(favoriteToggle.run(), false, 'favorite key must pass through while the dialog is closed')

// ── Scenario 1: session + Alt+Down category jump, then selection ──
simulateJump = true
command.run()
await poll(() => switched !== null)
assert.equal(selectCalls, 2, 'jump must reopen the select dialog once')
assert.equal(cleared, 1, 'jump must close the dialog via ui.dialog.clear()')
assert.deepEqual(dialogCurrents[0], current)
// Current category is the single-item anchor, so Alt+Down lands on the
// first item of the next section (Recent → openai/gpt-test).
assert.deepEqual(dialogCurrents[1], { providerID: 'openai', modelID: 'gpt-test' })
assert.deepEqual(switched, {
  sessionID: 'ses_test',
  model: { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'medium' },
})
assert.deepEqual(persisted[0], { providerID: 'bailian-cli', modelID: 'qwen-flash' })
assert.equal(persisted.filter((item) => item.providerID === 'bailian-cli' && item.modelID === 'qwen-flash').length, 1)

assert.equal(new Set(dialogOptions.map((item) => `${item.category}:${item.value.providerID}/${item.value.modelID}`)).size, dialogOptions.length, 'model list contains duplicates inside a category')
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'qwen3.8-max').map((item) => item.category), ['Current', 'Orchestrated'])
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'gpt-6-sol-orchestrated').map((item) => item.category), ['Orchestrated'])
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'gpt-6-astra-orchestrated').map((item) => item.category), ['Orchestrated'])
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'gpt-6-dnd-edition').map((item) => item.category), ['Orchestrated'])
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'qwen-flash').map((item) => item.category), ['Alibaba'])
assert.deepEqual(dialogOptions.filter((item) => item.value.modelID === 'gpt-test').map((item) => item.category), ['Recent', 'OpenAI'])
assert.deepEqual(
  dialogOptions
    .filter((item) => item.category === 'Google')
    .map((item) => item.value.modelID),
  ['gemini-3.8-flash'],
)
assert.equal(
  dialogOptions.some((item) => item.value.modelID === 'veo-3.1-generate-preview'),
  false,
  'non-text Google model must be filtered out',
)
assert.equal(
  dialogOptions.some((item) => item.value.modelID === 'gemini-2.5-flash'),
  false,
  'legacy Google model must be filtered out',
)
// Role-routed models land in the dedicated Orchestrated group (after OpenAI),
// not in the generic Alibaba section.
assert.deepEqual(
  dialogOptions
    .filter((item) => item.category === 'Orchestrated')
    .map((item) => item.value.modelID),
  ['gpt-6-dnd-edition', 'gpt-6-astra', 'gpt-6-astra-orchestrated', 'gpt-6-sol-orchestrated', 'qwen3.8-max', 'qwen3.7-plus'],
)
assert.deepEqual(
  dialogOptions
    .filter((item) => item.category === 'Alibaba')
    .map((item) => item.value.modelID),
  ['qwen-flash'],
)

// A single-variant routed alias must pass its valid variant explicitly
// instead of relying on the old session model's variant.
simulateJump = false
modelChoice = { providerID: 'openai', modelID: 'gpt-6-dnd-edition' }
switched = null
selectCalls = 0
command.run()
await poll(() => switched !== null)
assert.deepEqual(switched, {
  sessionID: 'ses_test',
  model: { id: 'gpt-6-dnd-edition', providerID: 'openai', variant: 'auto' },
})
assert.equal(currentAgent, 'dnd-narrator')
assert.deepEqual(agentChanges, ['dnd-narrator'])
await poll(() => recentState.models[0]?.modelID === 'gpt-6-dnd-edition')
recentState.models = [
  { providerID: 'bailian-cli', modelID: 'qwen-flash' },
  { providerID: 'openai', modelID: 'gpt-test' },
  { providerID: 'bailian-cli', modelID: 'qwen3.8-max' },
]
modelChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }

const qwenMaxOpt = dialogOptions.find((item) => item.value.modelID === 'qwen3.8-max')
assert.ok(qwenMaxOpt, 'qwen3.8-max option missing')
assert.match(qwenMaxOpt.footer, /^[🌙☀] −50%$/u, 'qwen3.8-max must display night promo footer')
assert.ok(qwenMaxOpt.footerColor, 'qwen3.8-max must have promo color')
const qwenFlashOpt = dialogOptions.find((item) => item.value.modelID === 'qwen-flash')
assert.equal(qwenFlashOpt.footer, undefined, 'qwen-flash must not have night promo footer')

// ── Scenario 2: home screen → create the first session with selected model ──
route = { type: 'home' }
simulateJump = false
switched = null
created = null
navigated = null
persisted = null
dialogCurrents.length = 0
toasts.length = 0
command.run()
await poll(() => created !== null)
assert.equal(switched, null, 'home screen selection must not call switchModel')
assert.deepEqual(dialogCurrents[0], { providerID: 'bailian-cli', modelID: 'qwen-flash' }, 'home screen must highlight the last selected model')
assert.deepEqual(created, {
  model: { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'medium' },
  location: { directory: '/tmp/project' },
})
assert.deepEqual(navigated, { type: 'session', sessionID: 'ses_home' })

modelChoice = { providerID: 'openai', modelID: 'gpt-6-dnd-edition' }
created = null
command.run()
await poll(() => created !== null)
assert.equal(created.agent, 'dnd-narrator', 'a home DnD choice must create a narrator session')
modelChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }

// ── Scenario 3: Alt+Up from an unknown category lands on the last section ──
route = { type: 'session', sessionID: 'ses_test' }
simulateJump = false
switched = null
dialogCurrents.length = 0
selectCalls = 0
let jumpOnce = true
const originalSelect = context.ui.dialog.select
context.ui.dialog.select = async function (value) {
  selectCalls++
  dialogCurrents.push(value.current)
  if (jumpOnce) {
    jumpOnce = false
    groupPrev.run()
    return undefined
  }
  return originalSelect(value)
}
command.run()
await poll(() => switched !== null)
assert.equal(cleared, 2, 'Alt+Up must also reopen via ui.dialog.clear()')
assert.deepEqual(dialogCurrents[1], { providerID: 'other', modelID: 'z-model' })
assert.equal(currentAgent, 'build', 'choosing another model must leave narrator mode')
context.ui.dialog.select = originalSelect

// ── Scenario 4: Ctrl+F mirrors a favorite without removing its normal row ──
simulateFavorite = true
selectCalls = 0
switched = null
persistedFavorites = null
dialogCurrents.length = 0
command.run()
await poll(() => switched !== null)
assert.deepEqual(persistedFavorites, [
  { providerID: 'bailian-cli', modelID: 'qwen-flash' },
])
assert.equal(cleared, 3, 'favorite toggle must close the main dialog once')
const favoriteRows = dialogOptions.filter(
  (item) => item.value.providerID === 'bailian-cli' && item.value.modelID === 'qwen-flash',
)
assert.equal(favoriteRows.length, 3, 'favorite model must be mirrored without leaving its normal group')
assert.deepEqual(favoriteRows.map((item) => item.category), ['Favorites', 'Recent', 'Alibaba'])
assert.ok(favoriteRows.every((item) => item.title.startsWith('★ ')), 'both rows must show a star')
assert.deepEqual(
  [...new Set(dialogOptions.map((item) => item.category))],
  ['Current', 'Favorites', 'Recent', 'Alibaba', 'OpenAI', 'Orchestrated', 'Google', 'Free', 'Others'],
)

// ── Scenario 5: toggling the last favorite removes the dedicated section ──
selectCalls = 0
switched = null
persistedFavorites = null
command.run()
await poll(() => switched !== null)
assert.deepEqual(persistedFavorites, [])
assert.equal(cleared, 4)
assert.equal(dialogOptions.some((item) => item.category === 'Favorites'), false)
assert.equal(
  dialogOptions.filter(
    (item) => item.value.providerID === 'bailian-cli' && item.value.modelID === 'qwen-flash',
  ).length,
  2,
)
assert.deepEqual(
  dialogOptions
    .filter((item) => item.value.providerID === 'bailian-cli' && item.value.modelID === 'qwen-flash')
    .map((item) => item.category),
  ['Recent', 'Alibaba'],
)

// ── Scenario 6: a current favorite remains in its normal category ──
simulateFavorite = false
favoriteState.models = [structuredClone(current)]
selectCalls = 0
switched = null
command.run()
await poll(() => switched !== null)
const currentFavoriteRows = dialogOptions.filter(
  (item) => item.value.providerID === current.providerID && item.value.modelID === current.modelID,
)
assert.deepEqual(currentFavoriteRows.map((item) => item.category), ['Current', 'Favorites', 'Orchestrated'])
assert.ok(currentFavoriteRows.every((item) => item.title.startsWith('★ ')))

// ── Scenario 7: Ctrl+F works from the home screen (no session) ──
route = { type: 'home' }
recentState.models = []
favoriteState.models = []
simulateFavorite = true
toggleFavoriteChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }
selectCalls = 0
switched = null
created = null
navigated = null
persistedFavorites = null
dialogCurrents.length = 0
dialogHistory.length = 0
toasts.length = 0
command.run()
await poll(() => created !== null)
assert.deepEqual(persistedFavorites, [
  { providerID: 'bailian-cli', modelID: 'qwen-flash' },
])
assert.equal(cleared, 5, 'home-screen favorite toggle must close the main dialog once')
assert.equal(switched, null, 'home screen must not call switchModel')
assert.deepEqual(dialogCurrents[0], current, 'home screen without recents must fall back to the default model')
assert.deepEqual(created, {
  model: { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'medium' },
  location: { directory: '/tmp/project' },
})
assert.deepEqual(navigated, { type: 'session', sessionID: 'ses_home' })
assert.ok(toasts.some((item) => item.message === 'Added to Favorites'))

// ── Scenario 8: a disabled favorite stays visible and removable ──
route = { type: 'session', sessionID: 'ses_test' }
favoriteState.models = [{ providerID: 'other', modelID: 'old-model' }]
toggleFavoriteChoice = { providerID: 'other', modelID: 'old-model' }
simulateFavorite = true
selectCalls = 0
switched = null
persistedFavorites = null
dialogCurrents.length = 0
dialogHistory.length = 0
toasts.length = 0
command.run()
await poll(() => switched !== null)
const disabledFavoriteRow = dialogHistory[0].find(
  (item) => item.value.providerID === 'other' && item.value.modelID === 'old-model',
)
assert.ok(disabledFavoriteRow, 'disabled favorite must stay listed')
assert.equal(disabledFavoriteRow.category, 'Favorites')
assert.equal(disabledFavoriteRow.disabled, true, 'disabled favorite must not be selectable as a model')
assert.equal(disabledFavoriteRow.title, '★ Old Model')
assert.equal(
  dialogHistory[0].filter((item) => item.value.modelID === 'old-model').length,
  1,
  'disabled favorite must not mirror into normal categories',
)
const toggleRows = dialogHistory[1].filter(
  (item) => item.value.providerID === 'other' && item.value.modelID === 'old-model',
)
assert.equal(toggleRows.length, 1, 'toggle dialog must dedupe mirrored favorites')
assert.equal(toggleRows[0].disabled, false, 'toggle dialog must keep disabled favorites removable')
assert.deepEqual(persistedFavorites, [], 'disabled favorite must be removable')
assert.equal(dialogOptions.some((item) => item.value.modelID === 'old-model'), false, 'removed favorite must disappear from the list')
assert.equal(cleared, 6)
assert.deepEqual(switched, {
  sessionID: 'ses_test',
  model: { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'medium' },
})

// ── Scenario 9: failed choices must not become the next startup default ──
route = { type: 'session', sessionID: 'ses_test' }
failSwitch = true
modelChoice = { providerID: 'openai', modelID: 'gpt-6-dnd-edition' }
persisted = null
toasts.length = 0
command.run()
await poll(() => toasts.length > 0)
assert.equal(persisted, null, 'failed switch must not persist a recent model')
assert.ok(toasts.some((item) => item.message === 'Failed to switch model'))
assert.equal(currentAgent, 'build', 'a failed model switch must restore the prior agent')
failSwitch = false
modelChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }

route = { type: 'home' }
createResponse = {}
persisted = null
toasts.length = 0
command.run()
await poll(() => toasts.length > 0)
assert.equal(persisted, null, 'session creation without an id must not persist a recent model')
assert.ok(toasts.some((item) => item.message === 'Failed to create session with selected model'))

// ── Scenario 10: persistence must retain history updated during switching ──
route = { type: 'session', sessionID: 'ses_test' }
createResponse = { id: 'ses_home' }
freshRecent = [{ providerID: 'openai', modelID: 'gpt-test' }]
persisted = null
toasts.length = 0
command.run()
await poll(() => persisted !== null)
assert.deepEqual(persisted, [
  { providerID: 'bailian-cli', modelID: 'qwen-flash' },
  { providerID: 'openai', modelID: 'gpt-test' },
], 'recent persistence must start from the fresh storage draft')
freshRecent = null

// ── Scenario 11: hidden legacy agents migrate once, preserving the model ──
const rerunEffects = () => { for (const effect of globalThis.__effects || []) effect() }
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
route = { type: 'session', sessionID: 'ses_legacy' }
currentAgent = 'build-direct'
agentChanges.length = 0
switched = null
rerunEffects()
await poll(() => agentChanges.length === 1)
assert.deepEqual(agentChanges, ['build'], 'legacy build-direct must migrate to the visible build agent')
assert.equal(switched, null, 'migration must not touch the session model')
currentAgent = 'build-direct'
rerunEffects()
await settle()
assert.deepEqual(agentChanges, ['build'], 'migration runs at most once per session')

route = { type: 'session', sessionID: 'ses_child' }
sessionParent = 'ses_root'
rerunEffects()
await settle()
assert.deepEqual(agentChanges, ['build'], 'child sessions keep their orchestration agent')
sessionParent = undefined
route = { type: 'session', sessionID: 'ses_busy' }
sessionStatus = 'running'
rerunEffects()
await settle()
assert.deepEqual(agentChanges, ['build'], 'a running turn must not change agent')
sessionStatus = 'idle'
rerunEffects()
await poll(() => agentChanges.length === 2)

// ── Scenario 12: agent cycling persists the agent and keeps the model ──
const cycle = commands.find((item) => item.id === 'agent.cycle')
const cycleReverse = commands.find((item) => item.id === 'agent.cycle.reverse')
assert.ok(cycle && cycleReverse, 'agent cycle commands must override the native draft switch')
route = { type: 'session', sessionID: 'ses_cycle' }
currentAgent = 'build'
sessionModel = { providerID: 'openai', id: 'gpt-test', variant: 'high' }
agentChanges.length = 0
switched = null
assert.equal(cycle.run(), undefined)
await poll(() => agentChanges.length === 1)
await settle()
assert.deepEqual(agentChanges, ['plan'])
assert.equal(switched, null, 'Build → Plan must keep the selected model and effort')
cycle.run()
await poll(() => agentChanges.length === 2 && switched !== null)
assert.deepEqual(agentChanges.at(-1), 'dnd-narrator')
assert.deepEqual(switched.model, { providerID: 'openai', id: 'gpt-6-dnd-edition', variant: 'auto' }, 'the narrator brings its own model')
switched = null
cycle.run()
await poll(() => agentChanges.length === 3 && switched !== null)
assert.deepEqual(agentChanges.at(-1), 'build')
assert.deepEqual(switched.model, { providerID: 'openai', id: 'gpt-test', variant: 'high' }, 'leaving the narrator restores the previous model')
switched = null
cycleReverse.run()
await poll(() => agentChanges.length === 4 && switched !== null)
assert.deepEqual(agentChanges.at(-1), 'dnd-narrator')
switched = null
cycleReverse.run()
await poll(() => agentChanges.length === 5 && switched !== null)
assert.deepEqual(agentChanges.at(-1), 'plan')
assert.deepEqual(switched.model, { providerID: 'openai', id: 'gpt-test', variant: 'high' })

// ── Scenario 13: home and busy sessions keep the native draft behaviour ──
route = { type: 'home' }
assert.equal(cycle.run(), false)
route = { type: 'session', sessionID: 'ses_cycle' }
sessionStatus = 'running'
assert.equal(cycle.run(), false)
sessionStatus = 'idle'

// ── Scenario 14: /agents lists visible primary agents and persists the choice ──
const agentListCommand = commands.find((item) => item.id === 'agent.list')
assert.deepEqual(agentListCommand.slash, { name: 'agents' })
currentAgent = 'build'
agentChoice = 'plan'
agentChanges.length = 0
switched = null
agentListCommand.run()
await poll(() => agentChanges.length === 1)
await settle()
assert.deepEqual(dialogOptions.map((item) => item.value), ['build', 'plan', 'dnd-narrator'])
assert.deepEqual(agentChanges, ['plan'])
assert.equal(switched, null)

// ── Scenario 15: choosing a model in a legacy session migrates its agent ──
sessionModel = null
route = { type: 'session', sessionID: 'ses_pick' }
currentAgent = 'plan-direct'
agentChanges.length = 0
switched = null
modelChoice = { providerID: 'openai', modelID: 'gpt-test' }
command.run()
await poll(() => switched !== null)
assert.deepEqual(agentChanges, ['plan'], 'a hidden plan alias must become the visible plan agent')
modelChoice = { providerID: 'bailian-cli', modelID: 'qwen-flash' }

cleanup()
console.log('TUI model selector smoke passed: native dialog + favorites mirror + fresh recent persistence + failed selection rejection + persisted agent switches')

async function poll(check) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(check(), 'timed out waiting for the selector to settle')
}
