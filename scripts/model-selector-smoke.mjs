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
assert.ok(!source.includes('@opencode-ai/plugin/tui'), 'plugin import replacement failed')
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
  { providerID: 'opencode', id: 'free-model', name: 'Free Model', enabled: true, status: 'active', cost: [{ input: 0 }] },
  { providerID: 'other', id: 'z-model', name: 'Z Model', enabled: true, status: 'active', cost: [{ input: 1 }] },
  { providerID: 'other', id: 'old-model', name: 'Old Model', enabled: false, status: 'deprecated', cost: [{ input: 0.5 }] },
]
const providers = [
  { id: 'bailian-cli', name: 'Alibaba Cloud' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'opencode', name: 'OpenCode' },
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
        if (simulateFavorite && selectCalls === 1) {
          const favoriteToggle = commands.find((item) => item.id === 'model-selector.favorite-toggle')
          assert.ok(favoriteToggle, 'favorite-toggle command was not registered')
          favoriteToggle.run()
          return undefined
        }
        if (simulateJump && selectCalls === 1) {
          // Simulate Shift+Down while the dialog is open: the jump command
          // records a reopen target and closes the dialog via clear(), so
          // select() resolves with undefined just like a cancel would.
          const jumpNext = commands.find((item) => item.id === 'model-selector.group-next')
          assert.ok(jumpNext, 'group-next command was not registered')
          jumpNext.run()
          return undefined
        }
        // Choose Qwen Flash to exercise persistence + switchModel.
        return { providerID: 'bailian-cli', modelID: 'qwen-flash' }
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
    session: { get: () => ({ model: { providerID: current.providerID, id: current.modelID } }) },
    location: { default: () => ({ directory: '/tmp/project' }) },
  },
  client: {
    model: {
      list: async () => ({ data: models }),
      default: async () => ({ data: { providerID: 'bailian-cli', id: 'qwen3.8-max' } }),
    },
    provider: { list: async () => ({ data: providers }) },
    session: {
      switchModel: async (value) => { switched = value },
      create: async (value) => {
        created = value
        return { id: 'ses_home' }
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
assert.equal(groupPrev.bind, 'shift+up')
assert.equal(groupPrev.run(), false, 'jump keys must pass through while the dialog is closed')
const favoriteToggle = commands.find((item) => item.id === 'model-selector.favorite-toggle')
assert.ok(favoriteToggle, 'favorite-toggle command was not registered')
assert.equal(favoriteToggle.bind, 'ctrl+f')
assert.equal(favoriteToggle.run(), false, 'favorite key must pass through while the dialog is closed')

// ── Scenario 1: session + Shift+Down category jump, then selection ──
simulateJump = true
command.run()
await poll(() => switched !== null)
assert.equal(selectCalls, 2, 'jump must reopen the select dialog once')
assert.equal(cleared, 1, 'jump must close the dialog via ui.dialog.clear()')
assert.deepEqual(dialogCurrents[0], current)
// Current category is the single-item anchor, so Shift+Down lands on the
// first item of the next section (Recent → openai/gpt-test).
assert.deepEqual(dialogCurrents[1], { providerID: 'openai', modelID: 'gpt-test' })
assert.deepEqual(switched, {
  sessionID: 'ses_test',
  model: { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'medium' },
})
assert.deepEqual(persisted[0], { providerID: 'bailian-cli', modelID: 'qwen-flash' })
assert.equal(persisted.filter((item) => item.providerID === 'bailian-cli' && item.modelID === 'qwen-flash').length, 1)

const keys = dialogOptions.map((item) => `${item.value.providerID}/${item.value.modelID}`)
assert.equal(new Set(keys).size, keys.length, 'model list contains duplicates')
assert.equal(keys.filter((item) => item === 'bailian-cli/qwen3.8-max').length, 1)
assert.deepEqual(
  dialogOptions.map((item) => item.category),
  ['Current', 'Recent', 'Alibaba', 'Orchestrated', 'Free', 'Others'],
)
// Role-routed models land in the dedicated Orchestrated group (after OpenAI),
// not in the generic Alibaba section.
assert.deepEqual(
  dialogOptions
    .filter((item) => item.category === 'Orchestrated')
    .map((item) => item.value.modelID),
  ['qwen3.7-plus'],
)
assert.deepEqual(
  dialogOptions
    .filter((item) => item.category === 'Alibaba')
    .map((item) => item.value.modelID),
  ['qwen-flash'],
)

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

// ── Scenario 3: Shift+Up from an unknown category lands on the last section ──
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
assert.equal(cleared, 2, 'Shift+Up must also reopen via ui.dialog.clear()')
assert.deepEqual(dialogCurrents[1], { providerID: 'other', modelID: 'z-model' })
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
  ['Current', 'Favorites', 'Recent', 'Alibaba', 'Orchestrated', 'Free', 'Others'],
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
  1,
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

cleanup()
console.log('TUI model selector smoke passed: native dialog + favorites mirror + categories + recent + switchModel + jump reopen + home session creation + home favorite toggle + disabled favorite removal')

async function poll(check) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(check(), 'timed out waiting for the selector to settle')
}
