// Behavioral regression for config/plugins/config-manager.js.
//
// Covers what marker assertions cannot:
//   1. the OPENCODE_CONFIG_MANAGER_SELF_CHECK block runs at import time;
//   2. happy-path mutations persist, reach the catalog/mcp/skill transforms and
//      emit synthetic receipts;
//   3. literal-secret validation rejects before any write;
//   4. rollback restores the previous registry when save or reload fails, and
//      aggregates errors when the rollback itself fails;
//   5. enqueueMutation serializes concurrent mutations without lost updates;
//   6. remove-managed lifecycle and type guard;
//   7. orchestration policy is registered for the central context-lanes injector.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

register('./opencode-plugin-stub-hooks.mjs', import.meta.url)
process.env.OPENCODE_CONFIG_MANAGER_SELF_CHECK = '1'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'config/plugins/config-manager.js'), 'utf8')
// Imported through a data: URL so the module is always treated as ESM — the same
// technique web-smoke.mjs uses for browser modules.
const pluginModule = await import('../config/plugins/config-manager.js')
const plugin = pluginModule.default
assert.equal(plugin.id, 'custom.config-manager')

const STORAGE_KEY = 'registry-v2'
const store = new Map()
let saveFailures = 0
let reloadFailures = 0
const synthetics = []
const hooks = {}
const registeredTools = new Map()
const commands = new Map()
let catalogTransform = null
let mcpTransform = null
let skillTransform = null
let mcpListCalls = 0
const deferred = () => {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}
let nextStorageSetGate = null
let sessionGets = 0
let emitEvent
const managerEvents = new ReadableStream({ start(controller) { emitEvent = (event) => controller.enqueue(event) } })

const ctx = {
  tool: { transform: async callback => callback({ add: definition => registeredTools.set(definition.name, definition) }) },
  storage: {
    get: async (key) => (key === STORAGE_KEY ? store.get(key) : undefined),
    set: async (key, value) => {
      assert.equal(key, STORAGE_KEY)
      const gate = nextStorageSetGate
      if (gate) {
        nextStorageSetGate = null
        gate.entered.resolve()
        await gate.release.promise
        if (gate.failAfterRelease) throw new Error('simulated gated storage failure')
      }
      if (saveFailures > 0) {
        saveFailures -= 1
        throw new Error('simulated storage failure')
      }
      store.set(key, structuredClone(value))
    },
  },
  catalog: {
    reload: async () => {
      if (reloadFailures > 0) {
        reloadFailures -= 1
        throw new Error('simulated catalog reload failure')
      }
    },
    transform: async (callback) => { catalogTransform = callback },
    provider: { update: () => {} },
    model: { get: () => undefined, update: () => {} },
  },
  mcp: {
    list: async () => { mcpListCalls += 1 },
    reload: async () => {},
    transform: async (callback) => { mcpTransform = callback },
  },
  skill: {
    reload: async () => {},
    transform: async (callback) => { skillTransform = callback },
  },
  event: { subscribe: () => managerEvents.values() },
  session: {
    get: async ({ sessionID }) => {
      sessionGets += 1
      return { parentID: sessionID === 'child-session' ? 'parent-session' : null }
    },
    hook: async (name, callback) => { hooks[name] = callback },
    synthetic: async ({ text, resume }) => {
      assert.equal(resume, false, 'Configuration receipts must not start model inference')
      synthetics.push(text)
    },
  },
  command: {
    transform: async (callback) => {
      await callback({ add: (definition) => commands.set(definition.name, definition) })
    },
  },
}

await plugin.setup(ctx)
for (const name of ['addprovider', 'addmodel', 'addmcp', 'addskill', 'addorchestration', 'managed', 'remove-managed']) {
  assert.ok(commands.has(name), `command ${name} must be registered`)
}

const catalogDrafts = new Map()
const snapshot = () => {
  const providers = []
  const models = []
  const mcp = new Map()
  const skills = []
  catalogDrafts.clear()
  catalogTransform({
    provider: { update: (id, updater) => { const draft = {}; updater(draft); providers.push(id) } },
    model: {
      get: (providerID, id) => catalogDrafts.get(`${providerID}/${id}`),
      update: (providerID, id, updater) => {
        const draft = { ...catalogDrafts.get(`${providerID}/${id}`) }
        updater(draft)
        catalogDrafts.set(`${providerID}/${id}`, draft)
        models.push(`${providerID}/${id}`)
      },
    },
  })
  mcpTransform({ set: (name, config) => mcp.set(name, config) })
  skillTransform({ add: (definition) => skills.push(definition.id) })
  return { providers, models, mcp, skills }
}

const exec = (name, input, sessionID = 'ses_regression') =>
  commands.get(name).execute({ sessionID, prompt: { text: JSON.stringify(input) } })

// 1. Happy path: every managed type persists and reaches its transform.
await exec('addprovider', {
  id: 'acme',
  name: 'Acme',
  env: ['ACME_API_KEY'],
  settings: { baseURL: 'https://llm.example/v1', apiKey: '{env:ACME_API_KEY}' },
})
assert.ok(synthetics.at(-1).startsWith('addprovider: saved'), synthetics.at(-1))
assert.ok(store.get(STORAGE_KEY).providers.acme, 'provider must be persisted')

await exec('addmodel', { providerID: 'acme', id: 'coder', modelID: 'qwen3-coder', name: 'Coder' })
await assert.rejects(exec('addmodel', { providerID: 'acme', id: 'coder', enabled: 'true' }), /enabled must be a boolean/)
assert.equal(store.get(STORAGE_KEY).models['acme/coder'].enabled, undefined)
await exec('addmodel', { providerID: 'acme', id: 'coder', modelID: 'qwen3-coder', enabled: true })
assert.equal(store.get(STORAGE_KEY).models['acme/coder'].enabled, true)
await exec('addmcp', { name: 'docs', config: { type: 'remote', url: 'https://mcp.example.com?api_key={env:DOCS_KEY}' } })
await exec('addmcp', { name: 'fs', config: { type: 'local', command: ['npx', '-y', 'example-mcp'] } })
await exec('addskill', { id: 'review', name: 'Review', description: 'Review changes', content: 'Review the current changes.' })
await exec('addorchestration', { providerID: 'acme', id: 'coder-orchestrated', baseModelID: 'coder', contextClass: 'bare', prompt: 'Verify before completion.' })

let state = snapshot()
assert.deepEqual(state.providers, ['acme'])
assert.ok(state.models.includes('acme/coder'), state.models.join(','))
assert.ok(state.models.includes('acme/coder-orchestrated'), 'orchestration alias must reach the catalog')
assert.equal(store.get(STORAGE_KEY).orchestrations['acme/coder-orchestrated'].contextClass, 'bare')
// The alias must call the base model's upstream ID, not the base's catalog alias.
assert.equal(catalogDrafts.get('acme/coder-orchestrated').modelID, 'qwen3-coder')
assert.equal(catalogDrafts.get('acme/coder-orchestrated').id, 'coder-orchestrated')
assert.deepEqual([...state.mcp.keys()].sort(), ['docs', 'fs'])
const projectMcp = new Map([['docs', { type: 'remote', url: 'https://project.example/mcp', disabled: true }]])
mcpTransform({ get: name => projectMcp.get(name), list: () => [...projectMcp], set: (name, config) => projectMcp.set(name, config) })
assert.equal(projectMcp.get('docs').disabled, true, 'managed defaults must respect project disables')
assert.equal(projectMcp.get('docs').url, 'https://project.example/mcp', 'project endpoint must win over managed defaults')
assert.ok(projectMcp.has('fs'), 'managed servers missing from native config remain available')
assert.deepEqual(state.skills, ['review'])

await exec('managed')
assert.ok(synthetics.at(-1).includes('"acme"'), synthetics.at(-1))
const receiptCount = synthetics.length
const external = structuredClone(store.get(STORAGE_KEY))
external.models['acme/from-another-workspace'] = { modelID: 'coder', name: 'External' }
store.set(STORAGE_KEY, external)
await exec('refreshmodels')
assert.ok(snapshot().models.includes('acme/from-another-workspace'))
assert.equal(synthetics.length, receiptCount, 'Refresh must not enqueue any model input')
await exec('remove-managed', { type: 'models', id: 'acme/from-another-workspace' })

// 2. Literal secrets are rejected before any write.
const before = structuredClone(store.get(STORAGE_KEY))
await assert.rejects(
  exec('addprovider', { id: 'evil', settings: { apiKey: 'literal-secret' } }),
  (error) => error.message.includes('must use {env:VAR}'),
)
assert.deepEqual(store.get(STORAGE_KEY), before, 'rejected mutation must not touch storage')
assert.ok(!snapshot().providers.includes('evil'))
assert.ok(synthetics.at(-1).includes('must use {env:VAR}'), synthetics.at(-1))

// 3. Rollback on storage failure restores the previous registry.
saveFailures = 1
await assert.rejects(
  exec('addskill', { id: 'tmp', name: 'Tmp', description: 'd', content: 'c' }),
  (error) => error.message.includes('simulated storage failure'),
)
assert.ok(store.get(STORAGE_KEY).skills.review, 'previous registry must be restored in storage')
assert.ok(!store.get(STORAGE_KEY).skills.tmp)
assert.ok(!snapshot().skills.includes('tmp'))

// 4. Rollback on reload failure rewrites storage back to the previous state.
reloadFailures = 1
await assert.rejects(
  exec('addmcp', { name: 'broken', config: { type: 'remote', url: 'https://mcp.example.com' } }),
  (error) => error.message.includes('managed reload failed'),
)
assert.ok(!store.get(STORAGE_KEY).mcp.broken, 'reload failure must roll storage back')
assert.ok(!snapshot().mcp.has('broken'))

// 5. When the rollback itself fails, both errors are surfaced.
saveFailures = 2
reloadFailures = 1
await assert.rejects(
  exec('addskill', { id: 'ghost', name: 'Ghost', description: 'd', content: 'c' }),
  (error) => error.message.includes('simulated storage failure') && error.message.includes('rollback failed'),
)
assert.ok(!store.get(STORAGE_KEY).skills.ghost)

// 6. The queued second mutation must run only after the first mutation rolls
// back from a gated save failure; without serialization that rollback loses it.
const firstSave = { entered: deferred(), release: deferred(), failAfterRelease: true }
nextStorageSetGate = firstSave
const failedConcurrentMutation = exec('addskill', { id: 'failed-concurrent', name: 'Failed concurrent', description: 'd', content: 'c' })
await firstSave.entered.promise
const savedConcurrentMutation = exec('addskill', { id: 'saved-concurrent', name: 'Saved concurrent', description: 'd', content: 'c' })
firstSave.release.resolve()
await assert.rejects(failedConcurrentMutation, /simulated gated storage failure/)
await savedConcurrentMutation
state = snapshot()
assert.ok(state.skills.includes('saved-concurrent'), 'queued mutation must persist after the failed mutation rolls back')
assert.ok(!state.skills.includes('failed-concurrent'), 'failed mutation must not remain after rollback')

// 7. remove-managed lifecycle and guards.
await exec('remove-managed', { type: 'skills', id: 'review' })
assert.equal(synthetics.at(-1), 'remove-managed: removed')
assert.ok(!snapshot().skills.includes('review'))
await assert.rejects(exec('remove-managed', { type: 'skills', id: 'missing' }), /managed item not found/)
await assert.rejects(exec('remove-managed', { type: 'version', id: '1' }), /type must be/)
await assert.rejects(exec('remove-managed', { type: 'bogus', id: 'x' }), /type must be/)

// 8. Malformed command input surfaces the usage help.
await assert.rejects(
  commands.get('addskill').execute({ sessionID: 'ses_regression', prompt: { text: 'not json' } }),
  /JSON argument is required/,
)

// 9. The config manager no longer injects system policy itself; it registers
// managed orchestration metadata for context-lanes so bare replacement is atomic.
const contextHook = hooks['context']
assert.ok(contextHook, 'context hook must remain registered for MCP exposure')
const event = { model: { providerID: 'acme', id: 'coder-orchestrated' }, system: [] }
await contextHook(event)
assert.equal(event.system.length, 0, 'config-manager must not race context-lanes system injection')
const dndEvent = {
  sessionID: 'dnd-tools',
  agent: 'dnd-narrator',
  model: { providerID: 'openai', id: 'gpt-6-dnd-edition' },
  tools: { odm_narrator: {}, shell: {} },
}
const mcpListCallsBeforeDnd = mcpListCalls
await contextHook(dndEvent)
assert.equal(mcpListCalls, mcpListCallsBeforeDnd + 1, 'D&D context must load MCP tools before filtering')
assert.deepEqual(Object.keys(dndEvent.tools), ['odm_narrator'], 'D&D lane must keep narrator MCP')
const discover = registeredTools.get('mcp_discover').execute
const found = JSON.parse((await discover({ query: 'odm_narrator' }, { sessionID: 'dnd-tools' })).content)
assert.deepEqual(found.tools.map(tool => tool.name), ['odm_narrator'], 'D&D discovery must have a current snapshot')
await contextHook({ ...dndEvent, sessionID: 'dnd-offline', tools: { skill: {}, mcp_discover: {} } })
const missing = JSON.parse((await discover({ query: 'odm' }, { sessionID: 'dnd-offline' })).content)
assert.equal(missing.availableNextStep, false, 'offline MCP must not cause an endless next-step retry')
assert.ok(!('mcp_discover' in dndEvent.tools), 'the eager D&D allowlist never needs discovery')
// MCP status is observed once per session, not per step; a status change re-observes.
const mcpBeforeSteps = mcpListCalls
for (let step = 0; step < 3; step++)
  await contextHook({ ...dndEvent, tools: { odm_narrator: {}, shell: {}, mcp_discover: {} } })
assert.equal(mcpListCalls, mcpBeforeSteps, 'no per-step MCP list for a known session')
emitEvent({ type: 'mcp.status.changed', data: { server: 'odm_narrator' } })
await new Promise((resolve) => setImmediate(resolve))
await contextHook({ ...dndEvent, tools: { odm_narrator: {} } })
assert.equal(mcpListCalls, mcpBeforeSteps + 1, 'an MCP status change invalidates the observation')
// Non-D&D: discovery is exposed only while schemas are actually deferred.
const buildEvent = { sessionID: 'build-tools', agent: 'build', model: { providerID: 'acme', id: 'coder' }, messages: [], tools: { read: {}, mcp_discover: {} } }
await contextHook(buildEvent)
assert.ok(!('mcp_discover' in buildEvent.tools), 'nothing deferred: no discovery tool overhead')
const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`fs_tool_${index}`, { description: 'x'.repeat(50) }]))
const lazyEvent = { ...buildEvent, sessionID: 'build-lazy', tools: { ...many, mcp_discover: {} } }
await exec('mcp-profile', { mode: 'all' }, 'build-lazy')
await contextHook(lazyEvent)
assert.ok('mcp_discover' in lazyEvent.tools, 'deferred schemas keep the discovery tool')
// The parent chain is resolved with session.get once per session.
sessionGets = 0
for (let step = 0; step < 3; step++) await contextHook({ ...buildEvent, sessionID: 'child-session', tools: { read: {} } })
assert.equal(sessionGets, 2, 'child and parent are looked up once, not per step')
// Config receipts are wizard replies and must never reach the model.
const receiptEvent = { ...buildEvent, sessionID: 'receipt-session', tools: undefined, messages: [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'user', content: [{ type: 'text', text: 'custom.config.receipt:6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f\n{"registry":{"mcp":{}}}' }] },
  { role: 'user', content: 'custom.config.receipt:0f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f\n{"ok":true}' },
  { role: 'user', content: 'custom.config.receipt:legitimate user text' },
  { role: 'assistant', content: [{ type: 'text', text: 'custom.config.receipt: quoted by the model' }] },
] }
await contextHook(receiptEvent)
assert.deepEqual(receiptEvent.messages.map((message) => typeof message.content === 'string' ? message.content : message.content[0].text), ['hello', 'custom.config.receipt:legitimate user text', 'custom.config.receipt: quoted by the model'], 'only real config receipts are stripped from model context')
// Free-only providers (unsubscribed OpenCode Zen/Go): paid models leave the catalog.
{
  const { removePaidModels, isFreeModel } = await import('../config/plugins/config-manager.js')
  assert.equal(isFreeModel({ cost: [{ input: 0, output: 0, cache: { read: 0 } }] }), true)
  assert.equal(isFreeModel({ cost: { input: 0, output: 0 } }), true)
  assert.equal(isFreeModel({ cost: [{ input: 0, output: 0 }, { input: 1, output: 2 }] }), false)
  assert.equal(isFreeModel({}), false, 'an unknown price is not free')
  const removed = []
  const entries = [
    { provider: { id: 'opencode' }, models: new Map([['a-free', { id: 'a-free', cost: [{ input: 0, output: 0 }] }], ['paid', { id: 'paid', cost: [{ input: 3, output: 15 }] }]]) },
    { id: 'opencode-go', models: [{ id: 'go-paid', cost: { input: 1, output: 1 } }, { id: 'go-free', cost: { input: 0, output: 0 } }] },
    { provider: { id: 'openai' }, models: { luna: { id: 'luna', cost: [{ input: 1, output: 1 }] } } },
  ]
  const result = removePaidModels({ provider: { list: () => entries }, model: { remove: (providerID, id) => removed.push(`${providerID}/${id}`) } }, new Set(['opencode', 'opencode-go']))
  assert.deepEqual(removed.sort(), ['opencode-go/go-paid', 'opencode/paid'])
  assert.deepEqual(result.sort(), removed)
  assert.deepEqual(removePaidModels({ provider: { list: () => entries }, model: { remove: () => { throw new Error('must not remove') } } }, new Set()), [])
  // A service respawned by an older client lacks new service env; the
  // persisted service config is the fallback, and the process env wins.
  const { serviceSetting } = await import('../config/plugins/config-manager.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(resolve(tmpdir(), 'cm-service-'))
  const file = resolve(dir, 'service.json')
  writeFileSync(file, JSON.stringify({ password: 'x', env: { OPENCODE_FREE_ONLY_PROVIDERS: 'opencode,opencode-go' } }))
  assert.equal(serviceSetting('OPENCODE_FREE_ONLY_PROVIDERS', {}, file), 'opencode,opencode-go')
  assert.equal(serviceSetting('OPENCODE_FREE_ONLY_PROVIDERS', { OPENCODE_FREE_ONLY_PROVIDERS: '' }, file), '')
  assert.equal(serviceSetting('OPENCODE_DEFAULT_MODEL', {}, file), undefined)
  assert.equal(serviceSetting('OPENCODE_FREE_ONLY_PROVIDERS', {}, resolve(dir, 'missing.json')), undefined)
  rmSync(dir, { recursive: true, force: true })
}
const policyModule = await import('../config/plugins/tui/lib/context-policy.js')
assert.equal(policyModule.resolveContextClass({ sessionID: 'managed', model: event.model }), 'bare')
assert.equal(policyModule.managedOrchestration(event).prompt, 'Verify before completion.')

console.log('config-manager regression OK: self-check, happy path, secret rejection, rollback, serialization, managed context metadata')
