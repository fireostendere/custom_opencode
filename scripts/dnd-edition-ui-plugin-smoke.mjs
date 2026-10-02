import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
process.env.OPENCODE_CONFIG_DIR = new URL('config/', root).pathname
const plugin = await import(new URL('config/plugins/orchestrated-qwen.js', root))
let hook
await plugin.default.setup({ session: { hook: async (name, fn) => { assert.equal(name, 'context'); hook = fn } } })

const dnd = { model: { providerID: 'openai', id: 'gpt-6-dnd-edition' }, system: [], tools: ['odm_narrator', 'odm_narrator_odm_narrator', 'odm_narrator_odm_campaigns', 'mcp_discover', 'skill', 'shell', 'kb_knowledge_search', 'edit'] }
await hook(dnd)
assert.deepEqual(dnd.tools, ['odm_narrator', 'odm_narrator_odm_narrator', 'mcp_discover', 'skill'])
assert.deepEqual(dnd.system, [], 'context-lanes owns the D&D system prompt')
assert.deepEqual(plugin.filterDndTools(['dnd_knowledge_search', 'dnd_knowledge_get', 'dnd_knowledge_ingest', 'dnd_knowledge_status', 'odm_narrator_odm_campaigns']),
  ['dnd_knowledge_search', 'dnd_knowledge_get', 'dnd_knowledge_status'], 'project D&D RAG stays available without ingest or administration')
const search = { description: 'Search the engineering knowledge base', inputSchema: { type: 'object' }, execute: async () => 'evidence' }
const knowledge = { agent: 'dnd-narrator', tools: { dnd_knowledge_search: search, kb_knowledge_search: search } }
await hook(knowledge)
assert.deepEqual(Object.keys(knowledge.tools), ['dnd_knowledge_search'])
assert.match(knowledge.tools.dnd_knowledge_search.description, /English original rule names.*srd_5_1_ru/)
assert.match(knowledge.tools.dnd_knowledge_search.description, /2014 rules.*forgotten_realms_wiki_ru.*cannot establish 2024/)
assert.equal(knowledge.tools.dnd_knowledge_search.execute, search.execute, 'retrieval execution remains authoritative')
assert.equal(knowledge.tools.dnd_knowledge_search.inputSchema, search.inputSchema)
assert.equal(search.description, 'Search the engineering knowledge base', 'D&D hints do not alter shared tool definitions')
assert.match(plugin.filterDndTools([{ name: 'dnd_knowledge_search', ...search }])[0].description, /English original rule names/)

const sol = { model: { providerID: 'openai', id: 'gpt-6-sol-orchestrated' }, system: [], tools: ['shell'] }
await hook(sol)
assert.deepEqual(sol.tools, ['shell'], 'SOL alias must retain its tools')
const qwen = { model: { providerID: 'bailian-cli', id: 'qwen3.8-orchestrated' }, system: [], tools: ['edit'] }
await hook(qwen)
assert.deepEqual(qwen.tools, ['edit'], 'Qwen alias must retain its tools')
const direct = { model: { providerID: 'openai', id: 'gpt-6-sol-direct' }, system: [], tools: ['shell'] }
await hook(direct)
assert.equal(direct.system.length, 0, 'ordinary SOL must stay direct')

let ux = await readFile(new URL('app/ux-state.js', root), 'utf8')
const uxState = await import(`data:text/javascript;base64,${Buffer.from(ux).toString('base64')}`)
assert.equal(uxState.agentFor('build', 'dnd-edition'), 'dnd-narrator')
assert.equal(uxState.agentFor('build', 'direct'), 'build', 'direct models use the visible native agent')
assert.equal(uxState.agentFor('build', 'orchestrated'), 'build')
assert.equal(uxState.profileFromAgent('dnd-narrator'), 'dnd-edition')
assert.equal(uxState.profileFromAgent('build-direct'), 'direct')

const dashboard = await readFile(new URL('app/runtime-dashboard.js', root), 'utf8')
assert.match(dashboard, /gpt-6-dnd-edition':'dnd-edition/)
assert.match(dashboard, /DnD Edition · ODM/)
console.log('DnD Edition UI/plugin contract passed')
