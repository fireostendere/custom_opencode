import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

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
let dialogCurrent = null
let switched = null
let persisted = null
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
    router: { current: () => ({ type: 'session', sessionID: 'ses_test' }) },
    dialog: {
      async select(value) {
        dialogOptions = value.options
        dialogCurrent = value.current
        // Choose Qwen Flash to exercise persistence + switchModel.
        return { providerID: 'bailian-cli', modelID: 'qwen-flash' }
      },
    },
    toast: { show() {} },
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
    model: { list: async () => ({ data: models }) },
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
command.run()

for (let i = 0; i < 100 && !switched; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert.ok(switched, 'selector did not complete switchModel')
assert.deepEqual(dialogCurrent, current)

const keys = dialogOptions.map((item) => `${item.value.providerID}/${item.value.modelID}`)
assert.equal(new Set(keys).size, keys.length, 'model list contains duplicates')
assert.equal(keys.filter((item) => item === 'bailian-cli/qwen3.8-max').length, 1)
assert.deepEqual(
  dialogOptions.map((item) => item.category),
  ['Current', 'Recent', 'Alibaba', 'Free', 'Others'],
)
assert.deepEqual(switched, {
  sessionID: 'ses_test',
  model: { id: 'qwen-flash', providerID: 'bailian-cli' },
})
assert.deepEqual(persisted[0], { providerID: 'bailian-cli', modelID: 'qwen-flash' })
assert.equal(persisted.filter((item) => item.providerID === 'bailian-cli' && item.modelID === 'qwen-flash').length, 1)

cleanup()
console.log('TUI model selector smoke passed: native dialog + categories + dedupe + recent + switchModel')
