import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock } from 'node:test'
import { createPendingProviderRequests, linkProviderRequest } from '../config/plugins/tui/lib/pending-provider-requests.js'
import { createDndStateCache } from '../config/plugins/dnd-state-cache.js'

const filename = fileURLToPath(import.meta.url)
const root = join(dirname(filename), '..')
const state = mkdtempSync(join(tmpdir(), 'plugin-memory-'))
process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
process.env.XDG_STATE_HOME = state
process.env.DND_FAST_TIER = 'priority'
process.env.TYPED_OUTPUT = 'on'
const immediate = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let i = 0; i < 5; i++) await immediate() }
const heap = async () => { await flush(); global.gc(); await immediate(); global.gc(); return process.memoryUsage().heapUsed }
const mib = bytes => Number((bytes / 1048576).toFixed(2))
let serial = 0

function request(sessionID, body = 'body', model = 'fixture-wire') {
  const controller = new AbortController()
  return { controller, sessionID, kind: 'primary', agent: 'dnd-narrator', model: { providerID: 'openai', id: 'gpt-6-dnd-edition' },
    request: new Request('https://example.invalid/responses', { method: 'POST', signal: controller.signal,
      body: JSON.stringify({ model, input: [{ role: 'user', content: body }] }) }) }
}

async function hooksFor(name) {
  const { default: plugin } = await import(`../config/plugins/${name}.js?memory=${++serial}`)
  const hooks = new Map()
  let events, registrations = 0, disposed = 0
  const stream = new ReadableStream({ start(controller) { events = controller } })
  const register = (name, fn) => { registrations++; hooks.set(name, fn); return { dispose() { disposed++; hooks.delete(name) } } }
  const close = await plugin.setup({
    session: { hook: async (name, fn) => register(name, fn) },
    tool: { hook: async (name, fn) => register('tool.' + name, fn) },
    event: { subscribe({ signal }) { signal.addEventListener('abort', () => events.close(), { once: true }); return stream } },
  })
  const emit = async (type, sessionID) => { events.enqueue({ type, data: { sessionID } }); await flush() }
  const send = async event => {
    if (name === 'typed-output') event.agent = 'narrator-actor'
    await hooks.get('http.request')(event)
    return event
  }
  return { hooks, emit, send, async close() { await close(); assert.equal(disposed, registrations) } }
}

async function memoryChecks() {
  const memory = {}
  const cache = createDndStateCache()
  const catalog = cache.wrap(async () => ({ content: JSON.stringify({ schema: randomBytes(33000).toString('base64') }) }))
  let baseline = await heap()
  for (let i = 0; i < 1000; i++) await catalog({ operation: 'catalog', campaignId: 'fixture', action: 'action-' + i }, { sessionID: 'catalog-session' })
  memory.catalog1000MiB = mib((await heap()) - baseline)
  assert.ok(memory.catalog1000MiB < 8, 'catalog cache retained full ~44 MB response history')
  cache.reset('catalog-session')

  const { default: goalPlugin } = await import('../config/plugins/goal.js')
  const commands = [], registrations = [], completed = i => ({ id: 'goal-' + i, status: 'completed', objective: randomBytes(12000).toString('base64'), summary: randomBytes(1500).toString('base64'), turns: 1, failures: 0 })
  let events, gets = 0, pages = 0
  const stream = new ReadableStream({ start(controller) { events = controller } })
  const registration = { dispose() {} }
  baseline = await heap()
  const cleanup = await goalPlugin.setup({
    location: { directory: '/fixture/project' },
    rpc: { register: async () => ({ ...registration, events: { emit: async () => {} } }) },
    storage: {
      async scan({ prefix, after, limit }) {
        pages++
        const start = Number(after || 0)
        return { entries: Array.from({ length: Math.min(limit, 2000 - start) }, (_, offset) => ({ key: prefix + 'session-' + (start + offset), value: completed(start + offset) })),
          next: start + limit < 2000 ? String(start + limit) : undefined }
      },
      async get(key) { gets++; return completed(key) },
      async set() { throw new Error('Completed history must not resume or write') },
    },
    command: { transform: async fn => { fn({ add(command) { commands.push(command) } }); return registration } },
    tool: { transform: async fn => { registrations.push(fn); return registration } },
    session: { hook: async (_name, fn) => { registrations.push(fn); return registration }, synthetic: async () => {} },
    event: { subscribe({ signal }) { signal.addEventListener('abort', () => events.close(), { once: true }); return stream } },
  })
  assert.equal(pages, 20)
  memory.completedGoals2000MiB = mib((await heap()) - baseline)
  assert.ok(memory.completedGoals2000MiB < 8, 'startup retained all completed goal texts')
  for (let i = 0; i < 200; i++) await commands[0].execute({ sessionID: 'session-' + i, prompt: { text: 'status' } })
  assert.equal(gets, 200, 'historical goals must be restored on demand')
  memory.goalHistory200MiB = mib((await heap()) - baseline)
  assert.ok(memory.goalHistory200MiB < 3, 'on-demand history cache is unbounded')
  await cleanup()

  for (const name of ['dnd-fast-tier', 'typed-output']) {
    const h = await hooksFor(name)
    baseline = await heap()
    for (let i = 0; i < 32; i++) {
      const event = await h.send(request('aborted-' + i, randomBytes(750000).toString('base64')))
      event.controller.abort()
    }
    memory[name + 'Aborted32MiB'] = mib((await heap()) - baseline)
    assert.ok(memory[name + 'Aborted32MiB'] < 8, name + ' retained aborted request transcripts')
    for (let i = 0; i < 32; i++) await h.send(request('missing-response-' + i, randomBytes(750000).toString('base64')))
    memory[name + 'NoResponse32MiB'] = mib((await heap()) - baseline)
    assert.ok(memory[name + 'NoResponse32MiB'] < 24, name + ' exceeded its total fallback byte budget')
    await h.close()
    memory[name + 'DisposedMiB'] = mib((await heap()) - baseline)
    assert.ok(memory[name + 'DisposedMiB'] < 8, name + ' dispose retained fallback bodies')
  }
  console.log('Plugin retained heap checks:', JSON.stringify(memory))
}

async function behaviorChecks() {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let clock = 0
    const pending = createPendingProviderRequests({ maxEntries: 3, maxBytes: 1000, ttlMs: 100, now: () => clock })
    const consume = event => {
      const entry = pending.claim(event)
      if (!entry) return
      const body = entry.body
      pending.release(entry)
      return body
    }
    const a = request('a'), b = request('b'), c = request('c')
    assert.equal(pending.add(a, 'a'.repeat(500)), true)
    assert.equal(pending.add(b, 'b'.repeat(500)), true)
    assert.deepEqual(pending.stats(), { entries: 2, bytes: 1000 })
    pending.add(c, 'c'.repeat(500))
    assert.equal(getEventListeners(a.request.signal, 'abort').length, 0, 'byte eviction detaches listeners')
    assert.equal(consume(a), undefined)
    assert.deepEqual(pending.stats(), { entries: 2, bytes: 1000 })
    b.controller.abort()
    assert.deepEqual(pending.stats(), { entries: 1, bytes: 500 })
    const expired = pending.claim(c)
    assert.equal(expired.body.length, 500)
    assert.equal(pending.claim(c), undefined, 'only one response may claim a fallback')
    clock = 100
    mock.timers.tick(100)
    assert.equal(getEventListeners(c.request.signal, 'abort').length, 0, 'TTL clears idle state without another request')
    assert.equal(expired.body, undefined, 'TTL clears a claimed body across an asynchronous response read')
    assert.equal(expired.signal.aborted, true)
    assert.deepEqual(pending.stats(), { entries: 0, bytes: 0 })
    const old = request('same'), fresh = request('same')
    pending.add(old, 'old')
    pending.add(fresh, 'fresh')
    assert.equal(consume({ sessionID: 'same' }), undefined, 'ambiguous legacy response cannot consume a body')
    assert.equal(consume(old), 'old')
    assert.equal(consume(old), undefined, 'late old response cannot take newer state')
    assert.equal(consume({ ...old, request: new Request(old.request) }), undefined, 'unknown replacement cannot replay another request')
    assert.equal(consume(fresh), 'fresh')
    const shared = request('shared-input'), first = new Request(shared.request, { body: 'first' }), second = new Request(shared.request, { body: 'second' })
    pending.add({ ...shared, request: first }, 'first', {}, [shared.request])
    pending.add({ ...shared, request: second }, 'second', {}, [shared.request])
    assert.equal(consume(shared), undefined, 'a reused input alias is ambiguous')
    assert.equal(consume({ ...shared, request: first }), 'first')
    assert.equal(consume({ ...shared, request: second }), 'second')
    for (let i = 0; i < 4; i++) pending.add(request('count-' + i), 'small')
    assert.equal(pending.stats().entries, 3, 'entry cap applies even below the byte cap')
    pending.forget('count-1'); pending.forget('count-2'); pending.forget('count-3')
    pending.add(a, 'a')
    pending.forget('a')
    assert.deepEqual(pending.stats(), { entries: 0, bytes: 0 })
    pending.add(c, 'c')
    pending.dispose()
    assert.equal(getEventListeners(c.request.signal, 'abort').length, 0)
    assert.equal(pending.add(request('later'), 'later'), false)
  } finally { mock.timers.reset() }

  const cache = createDndStateCache()
  let answer = '{"schema":"one"}'
  const call = cache.wrap(async () => ({ content: answer }))
  const ctx = { sessionID: 'catalog' }, original = { operation: 'catalog', action: 'pc_attack', campaignId: 'fixture' }
  await call(original, ctx)
  assert.match((await call({ campaignId: 'fixture', action: 'pc_attack', operation: 'catalog' }, ctx)).content, /unchanged/, 'key order does not duplicate catalog state')
  answer = '{"schema":"changed"}'
  assert.equal((await call(original, ctx)).content, answer, 'changed schema must be sent even for a known key')
  for (let i = 0; i < 100; i++) await call({ ...original, action: 'fixture-' + i }, ctx)
  assert.equal((await call(original, ctx)).content, answer, 'an evicted lookup must be sent in full')
  cache.reset(ctx.sessionID)
  assert.equal((await call(original, ctx)).content, answer)

  const realFetch = globalThis.fetch
  const replays = []
  globalThis.fetch = async value => { replays.push(await value.clone().json()); return new Response('{"ok":true}') }
  try {
    for (const name of ['dnd-fast-tier', 'typed-output']) {
      const h = await hooksFor(name)
      const response = (event, status = 400) => h.hooks.get('http.response')({ ...event, response: new Response('Unsupported service_tier and text.format schema', { status }) })
      for (const type of ['session.execution.failed', 'session.execution.interrupted', 'session.deleted', 'session.moved', 'session.agent.selected', 'session.model.selected']) {
        const event = await h.send(request(type, type, name + type))
        const before = replays.length
        await h.emit(type, event.sessionID)
        await response(event)
        assert.equal(replays.length, before, name + ' retained state after ' + type)
      }
      const aborted = await h.send(request('aborted', 'cancelled', name + 'abort'))
      aborted.controller.abort()
      let before = replays.length
      await response(aborted)
      assert.equal(replays.length, before)
      const old = await h.send(request('same-session', 'old prompt', name + 'old'))
      await response(old, 200)
      const fresh = await h.send(request('same-session', 'new prompt', name + 'fresh'))
      await response(old)
      assert.equal(replays.length, before, 'late response must not consume a newer fallback')
      await response(fresh)
      assert.equal(replays.length, before + 1, 'unsupported tier/schema still retries once')
      assert.equal(replays.at(-1).input[0].content, 'new prompt')
      await response(fresh)
      assert.equal(replays.length, before + 1, 'a duplicate response must not replay twice')
      const large = request('large', 'x'.repeat(17 * 1048576), name + 'large'), original = large.request
      await h.send(large)
      assert.equal(large.request, original, 'an uncacheable body must keep its original wire format/tier')
      await h.close()
    }
    for (const name of ['dnd-fast-tier', 'typed-output']) {
      for (const type of ['session.execution.failed', 'session.execution.interrupted', 'session.deleted', 'session.moved', 'session.agent.selected', 'session.model.selected', 'abort', 'dispose']) {
        const h = await hooksFor(name)
        try {
          const event = await h.send(request('delayed-' + (++serial), 'fallback awaiting error detail', name + serial))
          let controller, settled = false
          event.response = new Response(new ReadableStream({ start(value) { controller = value } }), { status: 400 })
          const before = replays.length
          const reading = h.hooks.get('http.response')(event).finally(() => { settled = true })
          await flush()
          assert.equal(settled, false, 'the fixture must reach a deferred response body')
          if (type === 'abort') event.controller.abort()
          else if (type === 'dispose') await h.close()
          else await h.emit(type, event.sessionID)
          await flush()
          assert.equal(settled, true, name + ' must stop reading a response on ' + type)
          controller.enqueue(new TextEncoder().encode('Unsupported service_tier and text.format schema'))
          controller.close()
          await reading
          assert.equal(replays.length, before, name + ' must not retry after invalidation during response reading: ' + type)
        } finally { if (type !== 'dispose') await h.close() }
      }
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
      const h = await hooksFor(name)
      try {
        const success = await h.send(request('slow-success', 'slow successful request', name + 'slow-success'))
        const failure = await h.send(request('slow-failure', 'slow rejected request', name + 'slow-failure'))
        mock.timers.tick(5 * 60_000)
        const before = replays.length, response = new Response('late success')
        success.response = response
        await h.hooks.get('http.response')(success)
        assert.equal(success.response, response, 'fallback expiry must not cancel a long successful primary request')
        failure.response = new Response('Unsupported service_tier and text.format schema', { status: 400 })
        await h.hooks.get('http.response')(failure)
        assert.equal(replays.length, before, 'a late rejection passes through after fallback retention expires')
      } finally { await h.close(); mock.timers.reset() }
    }
    for (const order of [['dnd-fast-tier', 'typed-output'], ['typed-output', 'dnd-fast-tier']]) {
      for (const reverse of [false, true]) {
        const hosts = await Promise.all(order.map(hooksFor))
        try {
          for (const failure of ['service_tier', 'text.format json_schema']) {
            const event = request('combined-' + (++serial), 'combined prompt', 'combined-model-' + serial)
            event.agent = 'narrator-actor'
            for (const h of hosts) await h.send(event)
            const body = await event.request.clone().json()
            assert.equal(body.service_tier, 'priority')
            assert.equal(body.text.format.type, 'json_schema')
            // Model/runtime capping can replace the final Request yet again.
            event.request = linkProviderRequest(event.request, new Request(event.request, { body: JSON.stringify({ ...body, max_output_tokens: 1000 }) }))
            event.response = new Response('Unsupported ' + failure, { status: 400 })
            const before = replays.length
            for (const h of reverse ? [...hosts].reverse() : hosts) await h.hooks.get('http.response')(event)
            assert.equal(replays.length, before + 1, 'combined request hooks lost fallback identity: ' + order.join(' -> ') + ' / ' + failure)
            assert.equal(event.response.status, 200)
            assert.equal(replays.at(-1).input[0].content, 'combined prompt')
          }
        } finally { for (const h of hosts) await h.close() }
      }
    }
  } finally { globalThis.fetch = realFetch }
  console.log('Plugin memory lifecycle passed: bytes/count/TTL/abort/dispose, event cleanup, response identity, schema fallback, catalog LRU and canonical keys')
}

try {
  assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc scripts/plugin-memory-regression.mjs')
  await behaviorChecks()
  await memoryChecks()
} finally { rmSync(state, { recursive: true, force: true }) }
