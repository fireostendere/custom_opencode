import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionsWorker } from './decisions-worker.mjs'

const input = { id: 'a'.repeat(64), input: 'A task has made no progress for 20 seconds.',
  questions: [{ name: 'script_plan', type: 'choice', instructions: 'Choose the supplied plan.',
    choices: [{ value: '0', description: 'Continue' }, { value: '1', description: 'Stop' }, { value: 'abstain' }] }] }
const result = { model: 'gpt-6-luna', usage: { input_tokens: 120, output_tokens: 0 },
  answers: [{ name: 'script_plan', type: 'choice', choice: '1', confidence: 1,
    probabilities: [{ value: '0', probability: 0 }, { value: '1', probability: 1 }, { value: 'abstain', probability: 0 }] }] }

test('autonomous Decisions worker shares the typed transport and bounds its lifetime', async () => {
  const calls = []
  const worker = new DecisionsWorker({ apiKey: 'fixture', maxCalls: 1, fetcher: async (...args) => { calls.push(args); return result } })
  assert.deepEqual((await worker.handle(input)).result, result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].apiKey, 'fixture')
  assert(!JSON.stringify(await worker.handle(input)).includes('fixture'))
  assert.equal((await worker.handle({ ...input, id: 'b'.repeat(64) })).error, 'LANE_UNAVAILABLE')
  assert.equal(calls.length, 1)
})

test('missing API key, duplicate requests and malformed input never dispatch', async () => {
  let calls = 0
  const worker = new DecisionsWorker({ apiKey: '', fetcher: async () => { calls++; return result } })
  assert.equal((await worker.handle(input)).error, 'API_KEY_UNAVAILABLE')
  assert.equal((await worker.handle({ ...input, id: 'wrong' })).error, 'INVALID_REQUEST')
  assert.equal((await worker.handle({ ...input, url: 'https://elsewhere.invalid' })).error, 'INVALID_REQUEST')
  assert.equal(calls, 0)
  worker.apiKey = 'fixture'
  await worker.handle(input)
  assert.equal((await worker.handle(input)).error, 'LANE_UNAVAILABLE')
  assert.equal(calls, 1)
})

test('unknown billing or failed inference suspends the lane without retry or secret output', async () => {
  for (const fetcher of [async () => { throw Error('Bearer fixture-secret') },
    async () => ({ ...result, usage: null }), async () => ({ ...result, model: 'different' }),
    async () => ({ ...result, answers: [] })]) {
    let calls = 0
    const worker = new DecisionsWorker({ apiKey: 'fixture-secret', fetcher: async (...args) => { calls++; return fetcher(...args) } })
    const first = await worker.handle(input)
    assert.equal(first.error, 'PROVIDER_FAILED')
    assert.equal(first.suspended, true)
    assert(!JSON.stringify(first).includes('fixture-secret'))
    assert.equal((await worker.handle({ ...input, id: 'b'.repeat(64) })).error, 'LANE_UNAVAILABLE')
    assert.equal(calls, 1)
  }
})

test('worker bounds survive malformed configuration and large context', async () => {
  for (const maxCalls of [0, 257, 1.5]) assert.throws(() => new DecisionsWorker({ maxCalls }))
  for (const timeoutMs of [0, 5001]) assert.throws(() => new DecisionsWorker({ timeoutMs }))
  let calls = 0
  const worker = new DecisionsWorker({ apiKey: 'fixture', fetcher: async () => { calls++; return result } })
  assert.equal((await worker.handle({ ...input, input: 'x'.repeat(32768) })).error, 'CONTEXT_OVERFLOW')
  assert.equal(calls, 0)
})
