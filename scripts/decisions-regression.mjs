import assert from 'node:assert/strict'
import test from 'node:test'
import plugin, { decisionBody, decisionResult } from '../config/plugins/decisions.js'

const endpoint = 'https://api.openai.com/v1/decisions'
const predicate = { type: 'predicate', name: 'blocked', instructions: 'Does the evidence show a blocked task?' }
const choice = { type: 'choice', name: 'queue', instructions: 'Choose a queue.', choices: [{ value: false }, { value: 'false', description: 'A distinct string value' }] }
const score = { type: 'score', name: 'severity', instructions: 'Rate severity.', levels: [{ label: 'Low', description: 'Workaround exists' }, { label: 'High', description: 'Fully blocked' }] }
const input = { input: 'Export fails only in Safari.', questions: [predicate, choice, score] }
const usage = { input_tokens: 100, output_tokens: 0, total_tokens: 100, input_tokens_details: { cached_tokens: 10 } }
const result = { model: 'gpt-6-luna', usage, answers: [
  { type: 'predicate', name: 'blocked', probability: 0.1 },
  { type: 'choice', name: 'queue', choice: false, confidence: 0.9, probabilities: [{ value: false, probability: 0.95 }, { value: 'false', probability: 0.05 }] },
  { type: 'score', name: 'severity', score: 0.2, confidence: 0.7, probabilities: [{ value: 0, probability: 0.8 }, { value: 1, probability: 0.2 }] },
] }

async function harness(t, { key = 'fixture-decisions', respond = () => Response.json(result), denied = false } = {}) {
  for (const name of ['OPENAI_DECISIONS_API_KEY', 'OPENCODE_RUNTIME_PLUGIN_TOKEN', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_POLICY_COMMAND']) {
    const previous = process.env[name]
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
    delete process.env[name]
  }
  process.env.OPENAI_DECISIONS_API_KEY = key
  const calls = [], permissions = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const call = { url, ...init, body: JSON.parse(init.body) }
    calls.push(call)
    return respond(call)
  })
  let tool, disposed = false
  const dispose = await plugin.setup({
    tool: { transform: async fn => { fn({ add: value => { tool = value } }); return { dispose: () => { disposed = true } } } },
    permission: { assert: async request => { permissions.push(request); if (denied) throw Error('Permission denied') } },
  })
  t.after(dispose)
  const run = (context = {}) => tool.execute(input, { sessionID: 'session', agent: 'build', messageID: 'message', id: 'tool-call', ...context })
  return { calls, permissions, tool, run, dispose, disposed: () => disposed }
}

test('bounded request uses the official model and preserves typed choices', () => {
  const body = decisionBody(input)
  assert.equal(body.model, 'gpt-6-luna')
  assert.equal(body.questions[1].choices[0].value, false)
  assert.equal(body.questions[1].choices[1].value, 'false')
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions'])
  assert.equal(decisionBody({ input: 'x', questions: Array.from({ length: 400 }, (_, i) => ({ ...predicate, name: String(i) })) }).questions.length, 400)
  const invalid = [null, { ...input, input: '' }, { ...input, input: 'x'.repeat(200001) }, { ...input, questions: [] },
    { ...input, questions: Array(401).fill(predicate) }, { ...input, model: 'other' }, { ...input, url: 'https://other.invalid' },
    ...[null, { ...predicate, type: 'other' }, { ...predicate, instructions: ' ' }, { ...predicate, name: '' },
      { ...predicate, choices: [] }, { ...choice, choices: [{ value: false }, { value: false }] },
      { ...choice, choices: [{ value: 1 }, { value: 2 }] }, { ...choice, choices: [{ value: 'x', apiKey: 'no' }, { value: 'y' }] },
      { ...score, levels: [] }, { ...score, levels: [{ label: 'x' }, { label: 'y' }] },
    ].map(q => ({ input: 'x', questions: [q] })), { input: 'x', questions: [predicate, predicate] }]
  for (const value of invalid) assert.throws(() => decisionBody(value))
  assert.throws(() => decisionBody({ input: 'x', questions: Array.from({ length: 400 }, (_, i) => ({ ...predicate, name: String(i), instructions: 'x'.repeat(4000) })) }), /1 MiB/)
})

test('validates answer alignment, distributions and allowed values; refusals remain explicit', () => {
  assert.deepEqual(decisionResult(result, input.questions), result)
  const refused = structuredClone(result)
  refused.answers[1] = { type: 'refusal', name: 'queue' }
  assert.equal(decisionResult(refused, input.questions).answers[1].type, 'refusal')
  for (const mutate of [
    r => r.answers.pop(), r => { r.answers[0].name = 'wrong' }, r => { r.answers[0].probability = 2 },
    r => { r.answers[0].probability = NaN }, r => { r.answers[1].choice = 'not-an-option' },
    r => { r.answers[1].confidence = Infinity }, r => { r.answers[1].probabilities[0].value = 'false' },
    r => { r.answers[2].score = -1 }, r => { r.answers[2].score = 2 }, r => { r.answers[2].score = '0' },
    r => { r.answers[2].probabilities = [] }, r => { r.answers[0].type = 'score' },
  ]) {
    const bad = structuredClone(result); mutate(bad)
    assert.throws(() => decisionResult(bad, input.questions))
  }
})

test('native tool checks permission, sends a fixed HTTPS request and returns usage without credentials', async t => {
  const h = await harness(t)
  const answer = await h.run()
  assert.equal(h.tool.name, 'decisions')
  assert.deepEqual(h.permissions[0].resources, [endpoint])
  assert.equal(h.permissions[0].action, 'decisions')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, endpoint)
  assert.equal(h.calls[0].method, 'POST')
  assert.equal(h.calls[0].redirect, 'error')
  assert.equal(h.calls[0].headers.Authorization, 'Bearer fixture-decisions')
  assert.deepEqual(h.calls[0].body, decisionBody(input))
  assert.deepEqual(JSON.parse(answer.content), result)
  assert.deepEqual(answer.metadata.usage, usage)
  assert(!JSON.stringify(answer).includes('fixture-decisions'))
})

test('missing key refuses locally, and cannot reuse ChatGPT OAuth', async t => {
  const h = await harness(t, { key: '' })
  await assert.rejects(h.run(), /OPENAI_DECISIONS_API_KEY.*ChatGPT OAuth/)
  assert.equal(h.calls.length, 0)
})

test('permission denial stops the request', async t => {
  const h = await harness(t, { denied: true })
  await assert.rejects(h.run(), /Permission denied/)
  assert.equal(h.calls.length, 0)
})

for (const status of [401, 403, 429, 500]) test(`HTTP ${status} is explicit, sanitized and never retried`, async t => {
  const h = await harness(t, { respond: () => Response.json({ error: { message: 'fixture-decisions' } }, { status }) })
  await assert.rejects(h.run(), error => error.message.includes(`HTTP ${status}`) && !error.message.includes('fixture-decisions'))
  assert.equal(h.calls.length, 1)
})

test('network exceptions do not expose request credentials', async t => {
  const h = await harness(t, { respond: () => { throw Error('Bearer fixture-decisions') } })
  await assert.rejects(h.run(), /^Error: Decisions network request failed$/)
  assert.equal(h.calls.length, 1)
})

test('oversized or malformed provider replies fail without replay', async t => {
  let response = 'not-json'
  const h = await harness(t, { respond: () => new Response(response) })
  await assert.rejects(h.run(), /Invalid or oversized/)
  response = 'x'.repeat(1024 * 1024 + 1)
  await assert.rejects(h.run(), /Invalid or oversized/)
  assert.equal(h.calls.length, 2)
})

test('native cancellation and plugin disposal abort pending requests', async t => {
  const h = await harness(t, { respond: call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true })) })
  await assert.rejects(h.run({ signal: AbortSignal.abort() }), /abort/i)
  assert.equal(h.calls.length, 0)
  const pending = h.run()
  await new Promise(resolve => setImmediate(resolve))
  const rejection = assert.rejects(pending, /cancelled or timed out/)
  await h.dispose()
  await rejection
  assert.equal(h.disposed(), true)
  await assert.rejects(h.run(), /abort/i)
  assert.equal(h.calls.length, 1)
})

test('shares the root request ledger and refuses exhausted budgets before paid dispatch', async t => {
  let exhausted = false
  const h = await harness(t, { respond: call => {
    if (call.url.endsWith('/request-before')) return exhausted
      ? new Response('BudgetExceeded: model call budget exhausted', { status: 503 })
      : Response.json({ maxOutputTokens: 1 })
    if (call.url.endsWith('/request-after')) return Response.json({ ok: true })
    return Response.json(result)
  } })
  process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN = 'fixture-runtime'
  await h.run()
  await new Promise(resolve => setImmediate(resolve))
  const ledger = h.calls.filter(c => c.url !== endpoint)
  assert.deepEqual(ledger.map(c => c.url.split('/').at(-1)), ['request-before', 'request-after'])
  assert.equal(ledger[0].body.outputLimit, 1)
  assert.equal(ledger[0].body.requestID, ledger[1].body.requestID)
  assert.deepEqual(ledger[1].body.usage, { input: 100, output: 0, cacheRead: 10 })
  assert(!JSON.stringify(ledger.map(c => c.body)).includes(input.input))
  exhausted = true
  await assert.rejects(h.run(), /BudgetExceeded/)
  assert.equal(h.calls.filter(c => c.url === endpoint).length, 1)
})

test('failed provider calls release their ledger reservation once', async t => {
  const h = await harness(t, { respond: call => call.url === endpoint ? new Response('error', { status: 429 }) : Response.json({ ok: true }) })
  process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN = 'fixture-runtime'
  await assert.rejects(h.run(), /HTTP 429/)
  await new Promise(resolve => setImmediate(resolve))
  const settled = h.calls.filter(c => c.url.endsWith('/request-after'))
  assert.equal(settled.length, 1)
  assert.equal(settled[0].body.status, 429)
  assert.equal(settled[0].body.usage, null)
})
