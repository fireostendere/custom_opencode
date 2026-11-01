import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionsWorker } from './cossacks-advisor.mjs'
import plugin, { labCommand, projectFile, runLab } from '../config/plugins/cossacks.js'

const input = { id: 'a'.repeat(64), input: 'A single unit has been chased without damage for 20 seconds.',
  questions: [{ name: 'script_plan', type: 'choice', instructions: 'Choose the supplied plan.',
    choices: [{ value: '0', description: 'Continue' }, { value: '1', description: 'Disengage' }, { value: 'abstain' }] }] }
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

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'cossacks-plugin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'data/derived'), { recursive: true })
  writeFileSync(join(root, 'scripts/run_script_advisor.py'), 'import json\nprint(json.dumps({"mode":"fixture-read-only"}))\n')
  writeFileSync(join(root, 'data/derived/request.json'), '{}')
  return root
}

test('lab commands cannot become shell, game actions, training or cross-project file reads', t => {
  const root = project(t)
  assert.deepEqual(labCommand(root, { action: 'status' }), [join(root, 'scripts/run_script_advisor.py'), 'status'])
  assert.equal(labCommand(root, { action: 'review-input', artifact: 'data/derived/request.json' })[1], 'inspect')
  for (const action of ['apply', 'train', 'start', 'shell']) assert.throws(() => labCommand(root, { action }))
  assert.throws(() => labCommand(root, { action: 'status', command: 'evil' }))
  assert.throws(() => projectFile(root, 'scripts/run_script_advisor.py'))
  assert.throws(() => projectFile(root, '/etc/passwd'))
  symlinkSync(join(root, 'scripts/run_script_advisor.py'), join(root, 'data/derived/escape.json'))
  assert.throws(() => projectFile(root, 'data/derived/escape.json'))
})

test('model-free lab actually executes the fixed CLI with no shell', async t => {
  const root = project(t)
  assert.deepEqual(await runLab('python3', labCommand(root, { action: 'status' }), { cwd: root }), { mode: 'fixture-read-only' })
  await assert.rejects(runLab('python3', labCommand(root, { action: 'status' }), { cwd: root, signal: AbortSignal.abort() }))
})

test('native offline tool checks permission and does not register outside Cossacks', async t => {
  const root = project(t)
  const previous = process.env.COSSACKS_PROJECT_ROOT
  process.env.COSSACKS_PROJECT_ROOT = root
  t.after(() => { if (previous === undefined) delete process.env.COSSACKS_PROJECT_ROOT; else process.env.COSSACKS_PROJECT_ROOT = previous })
  const permissions = []
  let tool, disposed = false
  const dispose = await plugin.setup({ location: { directory: root },
    permission: { assert: async value => { permissions.push(value) } },
    tool: { transform: async f => { f({ add: value => { tool = value } }); return { dispose: () => { disposed = true } } } } })
  t.after(dispose)
  const reply = await tool.execute({ action: 'status' }, { sessionID: 'session', agent: 'build', id: 'call', messageID: 'message' })
  assert.equal(JSON.parse(reply.content).mode, 'fixture-read-only')
  assert.equal(permissions[0].action, 'cossacks_lab')
  assert.deepEqual(permissions[0].resources, [root])
  await dispose()
  assert.equal(disposed, true)
  process.env.COSSACKS_PROJECT_ROOT = join(root, 'missing')
  assert.equal(await plugin.setup({ location: { directory: root } }), undefined)
})
