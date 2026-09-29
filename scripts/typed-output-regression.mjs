import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'typed-output-'))
process.env.OPENCODE_CONFIG_DIR = join(ROOT, 'config')
const { default: plugin, loadRegistry, shapeBody, checkDelegation, strictProblems, validate } =
  await import('../config/plugins/typed-output.js')

const registry = loadRegistry(join(ROOT, 'config', 'prompts'))

// Every strict schema in the shipped registry is strict-mode compatible.
for (const [agent, entry] of Object.entries(registry.agents)) {
  if (entry.format?.type === 'json_schema') assert.deepEqual(strictProblems(entry.format.schema), [], agent)
  assert.ok(!(entry.kinds || []).some(kind => ['title', 'compaction'].includes(kind)), `${agent} must not type title/compaction`)
}
assert.equal(registry.agents['narrator-writer'], undefined, 'writer output is player prose')
assert.deepEqual(strictProblems({ type: 'object', additionalProperties: false, required: [], properties: { a: { type: 'string' } } }),
  ['$.a: must be required (use a nullable type instead)'])

// ODM role contracts accept what the ODM validators accept, and nothing else.
const ask = registry.agents['narrator-ask'].format.schema
const actor = registry.agents['narrator-actor'].format.schema
assert.deepEqual(validate(ask, { answer: 'Да, может.' }), [])
assert.ok(validate(ask, { answer: 'x', citations: [] }).length)
assert.deepEqual(validate(actor, { kind: 'do', content: 'Бью орка' }), [])
assert.ok(validate(actor, { kind: 'say', content: 'x' }).length)

// Responses bodies get text.format; existing text options survive; input is not mutated.
const responses = { model: 'gpt-6-luna', input: [{ role: 'user', content: '{}' }], text: { verbosity: 'low' } }
const shaped = shapeBody(responses, { agent: 'narrator-ask', kind: 'generate' }, registry)
assert.deepEqual(shaped.text, { verbosity: 'low', format: { type: 'json_schema', name: 'odm_ask_answer_v1', schema: ask, strict: true } })
assert.equal(responses.text.format, undefined)
assert.deepEqual(shapeBody(responses, { agent: 'narrator-referee', kind: 'generate' }, registry).text.format, { type: 'json_object' })
// Chat Completions bodies get response_format.
const chat = shapeBody({ model: 'm', messages: [] }, { agent: 'narrator-actor', kind: 'primary' }, registry)
assert.equal(chat.response_format.json_schema.name, 'odm_actor_turn_v1')
assert.equal(chat.response_format.json_schema.strict, true)
// Untouched: other agents, the writer, title/compaction kinds, and models that rejected the format.
for (const [agent, kind] of [['dnd-narrator', 'primary'], ['narrator-writer', 'generate'], ['narrator-ask', 'title'], ['narrator-ask', 'compaction']])
  assert.equal(shapeBody(responses, { agent, kind }, registry), responses, `${agent}/${kind}`)
assert.equal(shapeBody(responses, { agent: 'narrator-ask', kind: 'generate' }, registry, new Set(['gpt-6-luna'])), responses)

// Delegations to an agent with a task schema must be JSON packets of that schema.
const withTask = { agents: { worker: { task: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal: { type: 'string' } } } } } }
assert.match(checkDelegation({ agent: 'worker', prompt: 'please do it' }, withTask)[0], /JSON task packet/)
assert.deepEqual(checkDelegation({ agent: 'worker', prompt: '{"goal":"x"}' }, withTask), [])
assert.ok(checkDelegation({ agent: 'worker', prompt: '{"goal":"x","extra":1}' }, withTask).length)
assert.deepEqual(checkDelegation({ agent: 'other', prompt: 'prose is fine here' }, withTask), [])

// Plugin: shapes the wire request, retries once without the format on a format 400, then remembers.
const hooks = {}
const registration = { dispose() {} }
await plugin.setup({
  session: { hook: async (name, fn) => ((hooks[name] = fn), registration) },
  tool: { hook: async (name, fn) => ((hooks[`tool.${name}`] = fn), registration) },
})
const url = 'https://example.invalid/v1/responses'
const body = { model: 'gpt-6-luna', input: [{ role: 'user', content: '{"task":"answer_ask"}' }] }
const request = { sessionID: 's', agent: 'narrator-ask', kind: 'generate', request: new Request(url, { method: 'POST', body: JSON.stringify(body) }) }
await hooks['http.request'](request)
assert.equal((await request.request.clone().json()).text.format.type, 'json_schema')
const sent = []
const realFetch = globalThis.fetch
globalThis.fetch = async req => (sent.push(await req.clone().json()), new Response('{"output":[]}', { status: 200 }))
try {
  const response = { sessionID: 's', request: request.request,
    response: new Response('{"error":{"message":"Unsupported parameter: text.format"}}', { status: 400 }) }
  await hooks['http.response'](response)
  assert.equal(response.response.status, 200)
  assert.deepEqual(sent[0], body, 'the retry is exactly the original request')
  const ok = { sessionID: 's2', agent: 'narrator-ask', kind: 'generate', request: new Request(url, { method: 'POST', body: JSON.stringify(body) }) }
  await hooks['http.request'](ok)
  assert.equal((await ok.request.clone().json()).text, undefined, 'a rejecting model is not re-typed for a day')
} finally {
  globalThis.fetch = realFetch
}
// An unrelated 400 is passed through untouched.
const other = { sessionID: 's3', agent: 'narrator-actor', kind: 'generate', request: new Request(url, { method: 'POST', body: JSON.stringify({ ...body, model: 'gpt-6-sol' }) }) }
await hooks['http.request'](other)
const passthrough = { sessionID: 's3', request: other.request, response: new Response('{"error":"quota"}', { status: 400 }) }
await hooks['http.response'](passthrough)
assert.equal(passthrough.response.status, 400)
await assert.rejects(hooks['tool.execute.before']({ tool: 'subagent', input: { agent: 'narrator-ask', prompt: 'x' } }).then(() => { throw new Error('no task schema: must pass') }), /must pass/)

console.log('typed-output regression OK')
