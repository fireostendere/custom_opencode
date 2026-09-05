import assert from 'node:assert/strict'
import { register } from 'node:module'
import { resolveMcpProfile, filterMcpTools } from '../config/plugins/tui/lib/mcp-profiles.js'
register('./opencode-plugin-stub-hooks.mjs', import.meta.url)
const { default: plugin } = await import('../config/plugins/config-manager.js')

const legacy = { version: 1, providers: { old: { name: 'Old' } }, models: {}, mcp: {
  docs: { type: 'remote', url: 'https://example.com/mcp', codemode: true },
  browser: { type: 'local', command: ['example-browser'] },
  serial: { type: 'local', command: ['serial'], disabled: true },
}, skills: { review: { id: 'review', content: 'Keep me' } }, orchestrations: {} }
const store = new Map([['registry-v1', structuredClone(legacy)]])
const commands = new Map(), hooks = new Map(), receipts = []
let mcpTransform, reloads = 0
const ctx = {
  storage: { get: async (k) => structuredClone(store.get(k)), set: async (k, v) => store.set(k, structuredClone(v)) },
  catalog: { transform: async () => {}, reload: async () => {} },
  skill: { transform: async () => {}, reload: async () => {} },
  mcp: { transform: async (f) => { mcpTransform = f }, reload: async () => { reloads++ } },
  command: { transform: async (f) => f({ add: (c) => commands.set(c.name, c) }) },
  session: { hook: async (n, f) => hooks.set(n, f), synthetic: async ({ text }) => receipts.push(text), get: async () => ({}) },
}
await plugin.setup(ctx)
const registry = () => store.get('registry-v2')
assert.equal(registry().version, 2, 'v1 must migrate before any mutation')
assert.deepEqual(store.get('registry-v1'), legacy, 'legacy backup remains intact')
assert.deepEqual(registry().providers, legacy.providers)
assert.deepEqual(registry().skills, legacy.skills)
const run = (name, input, sessionID = 'session-a') => commands.get(name).execute({ sessionID, prompt: { text: JSON.stringify(input) } })
await run('addmcpprofile', { id: 'core', name: 'Core', mcp: ['docs', 'docs', 'missing'] })
assert.deepEqual(registry().mcpProfiles.core.mcp, ['docs', 'missing'])
await run('addmcpprofile', { id: 'frontend', name: 'Frontend', mcp: ['docs', 'browser'], keywords: ['frontend', 'css'], agents: ['frontend-builder'] })
await run('addmcpprofile', { id: 'hardware', mcp: ['serial'], risk: 'elevated', keywords: ['hardware'] })
await assert.rejects(run('addmcpprofile', { id: 'all', mcp: [] }), /reserved/)
await assert.rejects(run('addmcpprofile', { id: 'bad', mcp: 'docs' }), /array/)
await assert.rejects(run('addmcpprofile', { id: 'bad', mcp: [], risk: 'extreme' }), /risk/)
const installed = new Map()
mcpTransform({ set: (n, c) => installed.set(n, c), list: () => [...installed] })
assert.equal(installed.get('docs').codemode, false, 'profiles need filterable native definitions')
assert.equal(registry().mcp.docs.codemode, true, 'stored code mode is preserved')
const catalog = { docs_find: {}, browser_tabs: {}, serial_read: {}, read: {} }
let tools = structuredClone(catalog)
const report = filterMcpTools(tools, registry().mcp, registry().mcpProfiles, { id: 'core' })
assert.deepEqual(Object.keys(tools), ['docs_find', 'read'])
assert.equal(report.excluded.length, 2)
assert.ok(report.warnings.some((x) => x.includes('missing')))
assert.deepEqual(resolveMcpProfile(registry(), { text: 'Fix the CSS frontend' }), { id: 'frontend', reason: 'task keywords' })
assert.equal(resolveMcpProfile(registry(), { agent: 'frontend-builder', text: 'unknown' }).id, 'frontend')
assert.equal(resolveMcpProfile(registry(), { text: 'hardware' }).id, 'core', 'elevated profiles require explicit assignment')
assert.equal(resolveMcpProfile(registry(), { mode: 'core', text: 'frontend' }).id, 'core')
await run('mcp-profile', { mode: 'frontend', scope: 'fallback' })
assert.equal(resolveMcpProfile(registry(), { text: 'unknown' }).id, 'frontend')
await assert.rejects(run('mcp-profile', { mode: 'hardware', scope: 'fallback' }), /fallback/)
await run('mcp-profile', { mode: 'core', scope: 'fallback' })
await run('mcp-profile', { mode: 'core' })
const event = (sessionID, agent) => ({ sessionID, agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'CSS frontend' }] }], system: [], tools: structuredClone(catalog) })
const a = event('session-a', 'build'), b = event('session-b', 'frontend-builder')
await Promise.all([hooks.get('context')(a), hooks.get('context')(b)])
assert.deepEqual(Object.keys(a.tools), ['docs_find', 'read'])
assert.deepEqual(Object.keys(b.tools), ['docs_find', 'browser_tabs', 'read'], 'parallel workers have separate tool sets')
await run('addmcp', { name: 'browser', config: legacy.mcp.browser, profiles: ['core'] })
assert.ok(registry().mcpProfiles.core.mcp.includes('browser'))
assert.ok(!registry().mcpProfiles.frontend.mcp.includes('browser'))
await run('addmcp', { name: 'browser', config: legacy.mcp.browser, profiles: [] })
assert.ok(!registry().mcpProfiles.core.mcp.includes('browser'))
assert.ok(reloads > 0)
await plugin.setup(ctx)
assert.equal(registry().mcpSettings.sessions['session-a'], 'core', 'override survives restart')
await run('remove-managed', { type: 'mcpProfiles', id: 'hardware' })
assert.ok(!registry().mcpProfiles.hardware)
await assert.rejects(run('remove-managed', { type: 'mcpSettings', id: 'sessions' }), /type must/)
console.log('MCP profiles regression OK: migration, CRUD, missing/duplicate/disabled MCP, routing, context filtering, parallel workers, reload, persistence (native API mocks)')
