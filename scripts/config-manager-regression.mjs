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
//   7. the orchestration context hook injects the managed policy exactly once.
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
const pluginModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const plugin = pluginModule.default
assert.equal(plugin.id, 'custom.config-manager')

const STORAGE_KEY = 'registry-v1'
const store = new Map()
let saveFailures = 0
let reloadFailures = 0
const synthetics = []
const hooks = {}
const commands = new Map()
let catalogTransform = null
let mcpTransform = null
let skillTransform = null
const deferred = () => {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}
let nextStorageSetGate = null

const ctx = {
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
    reload: async () => {},
    transform: async (callback) => { mcpTransform = callback },
  },
  skill: {
    reload: async () => {},
    transform: async (callback) => { skillTransform = callback },
  },
  session: {
    hook: async (name, callback) => { hooks[name] = callback },
    synthetic: async ({ text }) => { synthetics.push(text) },
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

const snapshot = () => {
  const providers = []
  const models = []
  const mcp = new Map()
  const skills = []
  catalogTransform({
    provider: { update: (id, updater) => { const draft = {}; updater(draft); providers.push(id) } },
    model: {
      get: () => undefined,
      update: (providerID, id, updater) => { const draft = {}; updater(draft); models.push(`${providerID}/${id}`) },
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
await exec('addmcp', { name: 'docs', config: { type: 'remote', url: 'https://mcp.example.com?api_key={env:DOCS_KEY}' } })
await exec('addmcp', { name: 'fs', config: { type: 'local', command: ['npx', '-y', 'example-mcp'] } })
await exec('addskill', { id: 'review', name: 'Review', description: 'Review changes', content: 'Review the current changes.' })
await exec('addorchestration', { providerID: 'acme', id: 'coder-orchestrated', baseModelID: 'coder', prompt: 'Verify before completion.' })

let state = snapshot()
assert.deepEqual(state.providers, ['acme'])
assert.ok(state.models.includes('acme/coder'), state.models.join(','))
assert.ok(state.models.includes('acme/coder-orchestrated'), 'orchestration alias must reach the catalog')
assert.deepEqual([...state.mcp.keys()].sort(), ['docs', 'fs'])
assert.deepEqual(state.skills, ['review'])

await exec('managed')
assert.ok(synthetics.at(-1).includes('"acme"'), synthetics.at(-1))

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

// 9. Orchestration context hook injects the managed policy exactly once.
const contextHook = hooks['context']
assert.ok(contextHook, 'context hook must be registered')
const event = { model: { providerID: 'acme', id: 'coder-orchestrated' }, system: [] }
await contextHook(event)
assert.equal(event.system.length, 1)
assert.ok(event.system[0].text.includes('Managed orchestration acme/coder-orchestrated'))
await contextHook(event)
assert.equal(event.system.length, 1, 'hook must not duplicate the policy')
const plain = { model: { providerID: 'acme', id: 'coder' }, system: [] }
await contextHook(plain)
assert.equal(plain.system.length, 0)

console.log('config-manager regression OK: self-check, happy path, secret rejection, rollback, gated failed-save serialization, remove-managed, context hook')
