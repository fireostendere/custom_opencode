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

const layers = []
let dialogOptions = null
const dialogCurrents = []
let switched = null
let persisted = null
let cleared = 0
let selectCalls = 0
let simulateJump = false
const toasts = []
let route = { type: 'session', sessionID: 'ses_test' }
const current = { providerID: 'bailian-cli', modelID: 'qwen3.8-max' }
const recentState = {
  models: [
    { providerID: 'openai', modelID: 'gpt-test' },
    { providerID: 'bailian-cli', modelID: 'qwen3.8-max' },
  ],
}

const models = [
  { providerID: 'bailian-cli', id: 'qwen3.8-max', name: 'Qwen Max', enabled: true, status: 'active', cost: [{ input: 0.1 }] },
  { providerID: 'bailian-cli', id: 'qwen-flash', name: 'Qwen Flash', enabled: true, status: 'active', cost: [{ input: 0.01 }] },
  { providerID: 'bailian-cli', id: 'qwen3.7-plus', name: 'Qwen Plus', enabled: true, status: 'active', cost: [{ input: 0.04 }] },
  { providerID: 'openai', id: 'gpt-test', name: 'GPT Test', enabled: true, status: 'active', cost: [{ input: 0.2 }] },
  { providerID: 'opencode', id: 'free-model', name: 'Free Model', enabled: true, status: 'active', cost: [{ input: 0 }] },
  { providerID: 'other', id: 'z-model', name: 'Z Model', enabled: true, status: 'active', cost: [{ input: 1 }] },
]
const providers = [
  { id: 'bailian-cli', name: 'Alibaba Cloud' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'other', name: 'Other Provider' },
]

const context = {
  storage: {
    store() {
      return [recentState, async (mutate) => {
        const draft = structuredClone(recentState)
        mutate(draft)
        recentState.models = draft.models
        persisted = structuredClone(draft.models)
      }]
    },
  },
  ui: {
    router: { current: () => route },
    dialog: {
      async select(value) {
        dialogOptions = value.options
        dialogCurrents.push(value.current)
        selectCalls++
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
    session: { switchModel: async (value) => { switched = value } },
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
  model: { id: 'qwen-flash', providerID: 'bailian-cli' },
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

// ── Scenario 2: home screen → highlight default model, warn instead of switching ──
route = { type: 'home' }
simulateJump = false
switched = null
persisted = null
dialogCurrents.length = 0
toasts.length = 0
command.run()
await poll(() => toasts.length > 0)
assert.equal(switched, null, 'home screen selection must not call switchModel')
assert.deepEqual(dialogCurrents[0], current, 'home screen must highlight the default model')
assert.equal(toasts[0].variant, 'warning')

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

cleanup()
console.log('TUI model selector smoke passed: native dialog + categories + dedupe + recent + switchModel + jump reopen + home guard')

async function poll(check) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(check(), 'timed out waiting for the selector to settle')
}
