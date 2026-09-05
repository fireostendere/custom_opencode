import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

register('./opencode-plugin-stub-hooks.mjs', import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = mkdtempSync(join(tmpdir(), 'custom-opencode-gemini-'))
process.env.CUSTOM_OPENCODE_STATE_DIR = state

try {
  const source = readFileSync(resolve(root, 'config/plugins/gemini-rate-limit.js'), 'utf8')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  assert.equal(mod.parseRetrySeconds('Please retry in 1.2s.', null), 2)
  assert.equal(mod.quotaBucket('input_token_count'), 'tpm')
  assert.equal(mod.quotaBucket('generate_requests', 'per day'), 'rpd')
  assert.equal(mod.quotaBucket('generate_requests'), 'rpm')
  assert.ok(mod.parseRetrySeconds('', new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() })) <= 5)

  let calls = 0
  let now = Date.now()
  const realNow = Date.now
  Date.now = () => now
  const retrying = mod.createRetryFetch(async (input) => {
    calls += 1
    if (input instanceof Request) await input.text()
    return new Response(calls === 1 ? 'Please retry in 1s.' : 'ok', { status: calls === 1 ? 429 : 200 })
  }, { sleepFn: async (ms) => { now += ms } })
  assert.equal(mod.createRetryFetch(retrying), retrying, 'fetch wrapping must be idempotent')
  const response = await retrying(new Request('https://generativelanguage.googleapis.com/v1/test', { method: 'POST', body: 'payload' }))
  assert.equal(await response.text(), 'ok')
  assert.equal(calls, 2, 'one 429 must cause one retry, not nested retry trees')
  now += 86_400_000
  await retrying('https://generativelanguage.googleapis.com/v1/test')
  assert.equal(mod.getUsageSnapshot().requestsToday, 1, 'the first request after UTC rollover must be counted')

  let limitedCalls = 0
  const terminal = mod.createRetryFetch(async () => {
    limitedCalls += 1
    return new Response('Please retry in 1s.', { status: 429 })
  }, { sleepFn: async (ms) => { now += ms } })
  const terminalResponse = await terminal('https://generativelanguage.googleapis.com/v1/test')
  assert.equal(limitedCalls, 6)
  assert.equal(await terminalResponse.text(), 'Please retry in 1s.', 'terminal 429 body must remain readable')
  assert.equal(JSON.parse(readFileSync(join(state, 'rate-limit.json'), 'utf8')).active, true)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(retrying('https://generativelanguage.googleapis.com/v1/test', { signal: controller.signal }), { name: 'AbortError' })
  Date.now = realNow

  const original = globalThis.fetch
  let sdkHook
  const cleanup = await mod.default.setup({ aisdk: { hook: (_name, callback) => { sdkHook = callback } } })
  const installed = globalThis.fetch
  const hook = { options: {} }
  await sdkHook(hook)
  assert.equal(hook.options.fetch, installed, 'SDK hook must reuse the global wrapper')
  cleanup()
  assert.equal(globalThis.fetch, original, 'plugin cleanup must restore global fetch')
  assert.equal(statSync(join(state, 'rate-limit.json')).mode & 0o777, 0o600)
  console.log('Gemini rate-limit regression OK: single wrapper, bounded retry, abort, cleanup, private atomic state')
} finally {
  rmSync(state, { recursive: true, force: true })
}
