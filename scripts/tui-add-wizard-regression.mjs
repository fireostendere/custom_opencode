// Integration regression for the TUI configuration wizard.
//
// The test exercises the actual TUI command rows and dialog flow, then routes
// the generated JSON through the real config-manager command handlers. The
// storage adapter is file-backed and isolated in /tmp; no provider inference or
// network access is used.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

register('./opencode-plugin-stub-hooks.mjs', import.meta.url)

const root = new URL('../', import.meta.url)
const fixture = JSON.parse(await readFile(new URL('docs/artifacts/tui-add-wizard-cases.json', root), 'utf8'))
const addCommand = await import(new URL('config/plugins/tui/lib/add-command.js', root).href)

const expectedKinds = ['provider', 'model', 'mcp', 'skill', 'orchestration']
assert.deepEqual(addCommand.ADD_KINDS, expectedKinds)
for (const kind of expectedKinds) {
  assert.deepEqual(addCommand.parseAddCommand(`/add ${kind}`), {
    type: 'wizard',
    kind,
    command: addCommand.nativeAddCommand(kind),
    arguments: '',
  })
  assert.deepEqual(addCommand.parseAddCommand(`/${addCommand.nativeAddCommand(kind)}`), {
    type: 'wizard',
    kind,
    command: addCommand.nativeAddCommand(kind),
    arguments: '',
  })
  const payload = JSON.stringify({ probe: kind })
  assert.equal(addCommand.parseAddCommand(`/add ${kind} ${payload}`).type, 'native')
  assert.equal(addCommand.parseAddCommand(`/${addCommand.nativeAddCommand(kind)} ${payload}`).type, 'native')
}
assert.equal(addCommand.parseAddCommand('/add unknown').type, 'error')
assert.equal(addCommand.parseAddCommand('not a slash command'), null)

const testTmpRoot = process.env.CUSTOM_OPENCODE_TEST_TMP || fileURLToPath(root)
await mkdir(testTmpRoot, { recursive: true })
const configRoot = await mkdtemp(join(testTmpRoot, 'custom-opencode-add-wizard-'))
process.once('exit', () => rmSync(configRoot, { recursive: true, force: true }))
process.env.OPENCODE_CONFIG_DIR = configRoot
const configManager = await import(`${new URL('config/plugins/config-manager.js', root).href}?wizard-regression=${Date.now()}`)
assert.equal(configManager.default.id, 'custom.config-manager')

const registryPath = join(configRoot, 'registry.json')
const store = {
  async get(key) {
    if (key !== 'registry-v1') return undefined
    try {
      return JSON.parse(await readFile(registryPath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  },
  async set(key, value) {
    assert.equal(key, 'registry-v1')
    writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  },
}

const serverCommands = new Map()
const synthetic = []
const reloads = []
const hooks = new Map()
let catalogTransform
let mcpTransform
let skillTransform
const serverContext = {
  storage: store,
  catalog: {
    transform: async (callback) => { catalogTransform = callback },
    reload: async () => { reloads.push('catalog') },
    provider: { update: () => {} },
    model: { get: () => undefined, update: () => {} },
  },
  mcp: {
    transform: async (callback) => { mcpTransform = callback },
    reload: async () => { reloads.push('mcp') },
  },
  skill: {
    transform: async (callback) => { skillTransform = callback },
    reload: async () => { reloads.push('skill') },
  },
  session: {
    hook: async (name, callback) => { hooks.set(name, callback) },
    synthetic: async ({ text, resume }) => {
      assert.equal(resume, false, 'Wizard receipts must not start model inference')
      synthetic.push(text)
    },
  },
  command: {
    transform: async (callback) => {
      await callback({ add: (definition) => serverCommands.set(definition.name, definition) })
    },
  },
}
await configManager.default.setup(serverContext)
for (const kind of expectedKinds) assert.ok(serverCommands.has(addCommand.nativeAddCommand(kind)))

function appliedSettings() {
  const providers = {}
  const models = {
    'acme-ui/coder': {
      id: 'coder',
      modelID: 'qwen3-coder',
      name: 'Existing Coder',
      capabilities: { tools: true },
      limit: { context: 32768 },
    },
  }
  const mcp = new Map()
  const skills = {}
  catalogTransform({
    provider: {
      update: (id, updater) => {
        const draft = {}
        updater(draft)
        providers[id] = draft
      },
    },
    model: {
      get: (providerID, id) => models[`${providerID}/${id}`],
      update: (providerID, id, updater) => {
        const key = `${providerID}/${id}`
        const draft = structuredClone(models[key] || {})
        updater(draft)
        models[key] = draft
      },
    },
  })
  mcpTransform({ set: (name, config) => mcp.set(name, config) })
  skillTransform({ add: (definition) => { skills[definition.id] = definition } })
  return { providers, models, mcp, skills }
}

const commandCalls = []
const prompts = []
const selects = []
const alerts = []
const toasts = []
const slotRenders = []
const keymapLayers = []
let submitListener
let dialogPrompts = []
let dialogSelects = []

const dialog = {
  async prompt(input) {
    prompts.push(input.title)
    if (!dialogPrompts.length) throw new Error(`Unexpected prompt: ${input.title}`)
    return dialogPrompts.shift()
  },
  async select(input) {
    selects.push(input.title)
    if (!dialogSelects.length) throw new Error(`Unexpected select: ${input.title}`)
    return { value: dialogSelects.shift() }
  },
  async alert(input) {
    alerts.push(input.message)
  },
}

const context = {
  renderer: {
    currentFocusedRenderable: null,
    keyInput: {
      prependListener(name, listener) {
        assert.equal(name, 'keypress')
        submitListener = listener
      },
      off(name, listener) {
        assert.equal(name, 'keypress')
        assert.equal(listener, submitListener)
        submitListener = null
      },
    },
  },
  ui: {
    router: { current: () => ({ type: 'session', sessionID: 'ses_add_wizard_regression' }) },
    dialog,
    toast: { show: (input) => toasts.push(input) },
    slot: ({ render }) => {
      slotRenders.push(render)
      return () => {}
    },
  },
  keymap: {
    layer: (factory) => keymapLayers.push(factory()),
  },
  client: {
    session: {
      command: async ({ sessionID, command, text: argumentsText }) => {
        assert.equal(typeof argumentsText, 'string', 'V2 session.command requires text')
        commandCalls.push({ sessionID, command, arguments: argumentsText })
        const call = commandCalls.at(-1)
        const definition = serverCommands.get(command)
        assert.ok(definition, `unknown native command: ${command}`)
        try {
          await definition.execute({ sessionID, prompt: { text: argumentsText } })
        } catch (error) {
          call.error = error
        } finally {
          call.completed = true
        }
      },
    },
  },
}

const wizardModule = await import(`${new URL('config/plugins/tui/add-wizard.js', root).href}?wizard-regression=${Date.now()}`)
const cleanup = wizardModule.default.setup(context)
assert.equal(slotRenders.length, 1)
slotRenders[0]()
assert.equal(keymapLayers.length, 1)

const rows = keymapLayers[0].commands
assert.equal(rows.length, expectedKinds.length + 3)
for (const kind of expectedKinds) {
  assert.ok(rows.some((row) => row.id === `custom.add-wizard.${kind}`), `missing ${kind} button`)
}
const genericRow = rows.find((row) => row.id === 'custom.add-wizard.add')
assert.ok(genericRow, 'missing generic /add button')

function configureDialog(promptsToReturn, selectsToReturn = []) {
  dialogPrompts = [...promptsToReturn]
  dialogSelects = [...selectsToReturn]
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({ prompts, alerts, toasts, remainingPrompts: dialogPrompts, commandCalls })}`)
}

async function runButton(id, promptsToReturn, selectsToReturn = []) {
  const row = rows.find((item) => item.id === `custom.add-wizard.${id}`)
  assert.ok(row, `missing button ${id}`)
  configureDialog(promptsToReturn, selectsToReturn)
  const before = commandCalls.length
  assert.equal(row.run(''), true)
  await waitFor(() => commandCalls.length === before + 1 && commandCalls.at(-1).completed, `${id} mutation`)
  if (commandCalls.at(-1).error) throw new Error(`${id} mutation failed: ${commandCalls.at(-1).error.message}`)
}

const providerCase = fixture.buttons.find((item) => item.id === 'provider')
await runButton('provider', providerCase.prompts, providerCase.selects)
assert.ok(alerts.some((message) => message.includes('Provider ID must start with a letter')))

const modelCase = fixture.buttons.find((item) => item.id === 'model')
await runButton('model', modelCase.prompts, modelCase.selects)

const remoteCase = fixture.buttons.find((item) => item.id === 'mcp-remote')
await runButton('mcp', remoteCase.prompts, remoteCase.selects)
assert.ok(alerts.some((message) => message.includes('api_key must use {env:VAR}')))

const localCase = fixture.buttons.find((item) => item.id === 'mcp-local')
await runButton('mcp', localCase.prompts, localCase.selects)

const skillCase = fixture.buttons.find((item) => item.id === 'skill')
await runButton('skill', skillCase.prompts, skillCase.selects)
assert.ok(alerts.some((message) => message.includes('Skill content is required')))

const orchestrationCase = fixture.buttons.find((item) => item.id === 'orchestration')
await runButton('orchestration', orchestrationCase.prompts, orchestrationCase.selects)

// The generic command button must route canonical `/add provider` to the same wizard.
configureDialog(['acme-generic', 'Generic', '', '', '', ''], [])
const beforeGeneric = commandCalls.length
assert.equal(genericRow.run('provider'), true)
await waitFor(() => commandCalls.length === beforeGeneric + 1 && commandCalls.at(-1).completed, 'generic /add provider mutation')

// Typed canonical route is handled before native prompt submission.
const canonicalEditor = {
  traits: { owner: 'opencode', role: 'prompt', status: 'INPUT' },
  plainText: '/add model',
  clear() { this.plainText = '' },
  gotoBufferEnd() {},
}
context.renderer.currentFocusedRenderable = canonicalEditor
configureDialog(['acme-ui', 'alias-model', 'alias-upstream', 'Alias model'], [])
const beforeCanonical = commandCalls.length
const canonicalEvent = {
  name: 'return', eventType: 'press', ctrl: false, meta: false, alt: false,
  option: false, super: false, hyper: false, shift: false,
  preventDefault() { this.prevented = true },
  stopPropagation() { this.stopped = true },
}
submitListener(canonicalEvent)
await waitFor(() => commandCalls.length === beforeCanonical + 1 && commandCalls.at(-1).completed, 'typed canonical /add model mutation')
assert.equal(canonicalEditor.plainText, '')
assert.equal(canonicalEvent.prevented, true)
assert.equal(canonicalEvent.stopped, true)

// The exact beta-18743 field must route an empty native alias into the wizard.
canonicalEditor.plainText = '/addmcp'
configureDialog(['typed-docs', 'https://mcp.example.com/typed'], ['remote', false, false])
const beforeEmptyAlias = commandCalls.length
const emptyAliasEvent = {
  name: 'return', eventType: 'press', ctrl: false, meta: false, alt: false,
  option: false, super: false, hyper: false, shift: false,
  preventDefault() { this.prevented = true },
  stopPropagation() { this.stopped = true },
}
submitListener(emptyAliasEvent)
await waitFor(() => commandCalls.length === beforeEmptyAlias + 1 && commandCalls.at(-1).completed, 'typed empty /addmcp wizard mutation')
assert.equal(canonicalEditor.plainText, '')
assert.equal(emptyAliasEvent.prevented, true)
assert.equal(emptyAliasEvent.stopped, true)

// A native alias with JSON bypasses the wizard and still reaches the real handler.
const aliasInput = { name: 'alias-docs', config: { type: 'remote', url: 'https://mcp.example.com' } }
canonicalEditor.plainText = `/addmcp ${JSON.stringify(aliasInput)}`
const beforeAlias = commandCalls.length
submitListener(canonicalEvent)
await waitFor(() => commandCalls.length === beforeAlias + 1 && commandCalls.at(-1).completed, 'native /addmcp alias mutation')

// Cancellation must not call a native command or write a new registry item.
configureDialog([null], [])
const beforeCancel = commandCalls.length
assert.equal(genericRow.run('provider'), true)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(commandCalls.length, beforeCancel)

const registry = JSON.parse(await readFile(registryPath, 'utf8'))
assert.ok(registry.providers['acme-ui'])
assert.ok(registry.providers['acme-generic'])
assert.equal(registry.providers['acme-ui'].settings.apiKey, '{env:ACME_UI_KEY}')
assert.ok(registry.models['acme-ui/coder'])
assert.ok(registry.models['acme-ui/alias-model'])
assert.ok(registry.mcp.docs)
assert.ok(registry.mcp.filesystem)
assert.ok(registry.mcp['alias-docs'])
assert.equal(registry.skills.review.content, 'Review the current changes.\nVerify the result.')
assert.ok(registry.orchestrations['acme-ui/coder-orchestrated'])
assert.equal(registry.orchestrations['acme-ui/coder-orchestrated'].prompt, 'Verify before completion.')

const applied = appliedSettings()
assert.deepEqual(applied.providers['acme-ui'], {
  name: 'Acme UI',
  package: 'aisdk:@ai-sdk/openai-compatible',
  env: ['REGION', 'ACME_UI_KEY'],
  settings: {
    baseURL: 'https://llm.example/v1',
    apiKey: '{env:ACME_UI_KEY}',
  },
})
assert.deepEqual(applied.models['acme-ui/coder'], {
  id: 'coder',
  modelID: 'qwen3-coder',
  name: 'Coder',
  capabilities: { tools: true },
  limit: { context: 32768 },
})
assert.deepEqual(applied.models['acme-ui/alias-model'], {
  modelID: 'alias-upstream',
  name: 'Alias model',
})
assert.deepEqual(applied.models['acme-ui/coder-orchestrated'], {
  id: 'coder-orchestrated',
  modelID: 'coder',
  name: 'Coder · Orchestrated',
  capabilities: { tools: true },
  limit: { context: 32768 },
})
assert.deepEqual(applied.mcp.get('docs'), {
  type: 'remote',
  url: 'https://mcp.example.com?api_key={env:DOCS_TEST_KEY}',
  codemode: false,
  disabled: false,
})
assert.deepEqual(applied.mcp.get('filesystem'), {
  type: 'local',
  command: ['npx', '-y', 'example-mcp', '--header', 'Authorization: {env:MCP_TEST_KEY}'],
  codemode: false,
  disabled: false,
})
assert.equal(applied.skills.review.name, 'Review')
assert.equal(applied.skills.review.description, 'Review changes')
assert.equal(applied.skills.review.content, 'Review the current changes.\nVerify the result.')
assert.equal(applied.skills.review.autoinvoke, false)
assert.match(applied.skills.review.location, /managed-skills[\\/]review[\\/]SKILL\.md$/)
const orchestrationEvent = { model: { providerID: 'acme-ui', id: 'coder-orchestrated' }, system: [] }
await hooks.get('context')(orchestrationEvent)
assert.equal(orchestrationEvent.system.length, 1)
assert.equal(orchestrationEvent.system[0].text, 'Managed orchestration acme-ui/coder-orchestrated:\nVerify before completion.')
await configManager.default.setup(serverContext)
assert.deepEqual(appliedSettings(), applied, 'persisted settings must apply after a fresh config-manager setup')
assert.equal(hooks.has('context'), true)
assert.equal(synthetic.filter((item) => item.includes(': saved\n')).length, commandCalls.length)
assert.equal(reloads.length, commandCalls.length * 3)
assert.equal(toasts.filter((item) => item.variant === 'success').length, commandCalls.length)
assert.ok(prompts.length >= 20)
assert.ok(selects.length >= 6)

const report = {
  schema: 1,
  status: 'passed',
  runtime: 'OpenCode V2 TUI command layer + real config-manager handlers',
  buttons: rows.filter((row) => row.id.startsWith('custom.add-wizard.')).map((row) => row.id),
  routes: fixture.additionalRoutes,
  nativeCommands: commandCalls.map((call) => call.command),
  mutations: {
    providers: Object.keys(registry.providers).sort(),
    models: Object.keys(registry.models).sort(),
    mcp: Object.keys(registry.mcp).sort(),
    skills: Object.keys(registry.skills).sort(),
    orchestrations: Object.keys(registry.orchestrations).sort(),
  },
  checks: ['canonical /add routing', 'all five wizard buttons', 'currentFocusedRenderable submit interception', 'empty /addmcp opens wizard', 'applied provider/model settings', 'applied orchestration policy', 'applied remote and local MCP', 'applied skill content', 'native JSON alias', 'cancel', 'secret validation', 'file-backed registry persistence', 'fresh setup reapplies persisted settings'],
}

const reportArgument = process.argv.find((argument) => argument.startsWith('--report='))
if (reportArgument) await writeFile(reportArgument.slice('--report='.length), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

cleanup?.()
await rm(configRoot, { recursive: true, force: true })
console.log(`TUI add wizard regression passed: ${commandCalls.length} real mutations, ${rows.length} buttons, ${alerts.length} validation alerts`)
