import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
process.env.OPENCODE_CONFIG_DIR = new URL('config/', root).pathname
const plugin = await import(new URL('config/plugins/orchestrated-qwen.js', root))
let hook
await plugin.default.setup({ session: { hook: async (name, fn) => { assert.equal(name, 'context'); hook = fn } } })

const dnd = { model: { providerID: 'openai', id: 'gpt-5.6-dnd-edition' }, system: [], tools: ['odm_narrator', 'skill', 'shell', 'kb_knowledge_search', 'edit'] }
await hook(dnd)
assert.deepEqual(dnd.tools, ['odm_narrator', 'skill', 'kb_knowledge_search'])
assert.match(dnd.system[0].text, /Live D&D only/)

const sol = { model: { providerID: 'openai', id: 'gpt-5.6-sol-orchestrated' }, system: [], tools: ['shell'] }
await hook(sol)
assert.deepEqual(sol.tools, ['shell'], 'SOL alias must retain its tools')
const qwen = { model: { providerID: 'bailian-cli', id: 'qwen3.8-orchestrated' }, system: [], tools: ['edit'] }
await hook(qwen)
assert.deepEqual(qwen.tools, ['edit'], 'Qwen alias must retain its tools')
const direct = { model: { providerID: 'openai', id: 'gpt-5.6-sol' }, system: [], tools: ['shell'] }
await hook(direct)
assert.equal(direct.system.length, 0, 'ordinary SOL must stay direct')

let ux = await readFile(new URL('app/ux-state.js', root), 'utf8')
const uxState = await import(`data:text/javascript;base64,${Buffer.from(ux).toString('base64')}`)
assert.equal(uxState.agentFor('build', 'dnd-edition'), 'dnd-narrator')
assert.equal(uxState.agentFor('build', 'direct'), 'build-direct')
assert.equal(uxState.agentFor('build', 'orchestrated'), 'build')
assert.equal(uxState.profileFromAgent('dnd-narrator'), 'dnd-edition')
assert.equal(uxState.profileFromAgent('build-direct'), 'direct')

const dashboard = await readFile(new URL('app/runtime-dashboard.js', root), 'utf8')
assert.match(dashboard, /gpt-5\.6-dnd-edition':'dnd-edition/)
assert.match(dashboard, /DnD Edition · ODM/)
console.log('DnD Edition UI/plugin contract passed')
