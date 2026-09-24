import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HARDWARE_MODEL, ROLES, JevRouter, classify, digest, isHardwareLane,
  resolveModel, routeBody, userTurn, validatePacket, workerBody, readProvider,
} from '../config/plugins/tui/lib/hardware-core.js'
import plugin, { filterHardwareTools } from '../config/plugins/hardware-orchestrator.js'
import { resolveContextClass, resolveContextPolicy } from '../config/plugins/tui/lib/context-policy.js'

const endpoint = 'https://chatgpt.com/backend-api/codex/responses'
const models = ['luna', 'sol', 'astra'].map(family => ({
  providerID: 'openai', id: `gpt-6-${family}-direct`, modelID: `gpt-6-${family}`,
  name: family, capabilities: { tools: true, input: ['text', 'image', 'pdf'] },
  variants: ['low', 'xhigh', 'max'].map(id => ({ id })),
}))
const eventModel = { providerID: 'openai', id: HARDWARE_MODEL }
const packet = () => ({
  project: 'board-a', boardRevision: 'sha256:revision-a', corpusRevision: 'index:17',
  task: 'Check U1 supply and startup against primary evidence.',
  constraints: ['3 x AA cells', 'No electrolytic capacitor', 'Do not change the connector'],
  evidence: [{ kind: 'datasheet', source: 'kb:doc-123', locator: 'rev B, page 7, table 2', text: 'Illustrative test fixture, not an electrical recommendation.' }],
  unknowns: ['U1 switching waveform has not been measured'],
})
const image = { type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==' }
const parent = (text = 'Design a battery board', images = []) => ({
  model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images] }],
  reasoning: { effort: 'xhigh', summary: 'auto' }, service_tier: 'priority',
})
const answer = () => Response.json({ status: 'completed', output_text: '{"summary":"advisory","findings":[],"unknowns":["no live board tested"]}', usage: { input_tokens: 100, output_tokens: 20 }, service_tier: 'default' })
const sse = (events, step = 7) => {
  const text = events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\r\n\r\n').join('')
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close()
    controller.enqueue(bytes.slice(offset, offset += Math.min(step, bytes.length - offset)))
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

async function harness(t, options = {}) {
  const hooks = new Map(), tools = new Map(), commands = new Map(), calls = [], aliases = new Map()
  const env = { ...process.env }, originalFetch = globalThis.fetch
  process.env.HARDWARE_JEV = options.jev ? 'on' : 'off'
  delete process.env.HARDWARE_ORCHESTRATOR
  for (const key of ['HARDWARE_LUNA_MODEL', 'HARDWARE_SOL_MODEL', 'HARDWARE_ASTRA_MODEL']) delete process.env[key]
  const rows = structuredClone(options.models || models)
  globalThis.fetch = async (request, init) => {
    const url = typeof request === 'string' || request instanceof URL ? String(request) : request.url
    const body = JSON.parse(init?.body || await request.clone().text())
    calls.push({ url, body, headers: new Headers(init?.headers || request.headers) })
    return options.fetcher ? options.fetcher(request, init, body) : answer()
  }
  let dispose
  t.after(async () => {
    await dispose?.()
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
  })
  const ctx = {
    catalog: {
      model: { list: async () => rows },
      transform: async fn => fn({ model: {
        get: (provider, id) => rows.find(row => row.providerID === provider && row.id === id),
        update: (provider, id, update) => { const value = {}; update(value); aliases.set(id, value) },
      } }),
    },
    session: {
      hook: async (name, fn) => { hooks.set(name, fn) },
      synthetic: async message => message,
    },
    tool: { transform: async fn => fn({ add: item => tools.set(item.name, item) }) },
    command: { transform: async fn => fn({ add: item => commands.set(item.name, item) }) },
  }
  dispose = await plugin.setup(ctx)
  const request = async (body = parent(), id = 's1', model = eventModel, signal) => {
    const event = { sessionID: id, agent: 'build', model,
      request: new Request(endpoint, { method: 'POST', body: JSON.stringify(body),
        headers: { authorization: 'Bearer secret-fixture', 'chatgpt-account-id': 'fixture-account',
          'x-client-request-id': 'parent-id', 'idempotency-key': 'parent-key' }, signal }),
    }
    await hooks.get('http.request')(event)
    return event
  }
  const consult = (role, p = packet(), extra = {}, id = 's1', signal) => tools.get('hardware_consult').execute({ role, packet: p, ...extra }, { sessionID: id, signal })
  const status = async (id = 's1') => JSON.parse((await tools.get('hardware_status').execute({}, { sessionID: id })).content)
  return { hooks, tools, commands, calls, aliases, rows, request, consult, status }
}

test('deterministic routing keeps Luna XHIGH default and promotes substantive reviews', () => {
  assert.equal(classify('Спроектируй питание платы').family, 'luna')
  assert.equal(classify('PCB review of U1 layout').family, 'sol')
  assert.equal(classify('Сделай ревью платы').family, 'sol')
  assert.equal(classify('Check mains isolation barrier').family, 'astra')
  assert.equal(classify('Питание от 230 В').family, 'astra')
  assert.equal(classify('Есть противоречие в первичных данных').family, 'astra')
  assert.equal(ROLES.critical_design.family, 'astra')
})

test('hardware lane is exact; direct models and D&D policy are untouched', () => {
  const hw = { model: eventModel, agent: 'build' }
  assert.equal(isHardwareLane(hw), true)
  assert.equal(isHardwareLane({ model: { providerID: 'openai', id: 'gpt-6-luna-direct' } }), false)
  assert.equal(isHardwareLane({ model: { providerID: 'other', id: HARDWARE_MODEL } }), false)
  assert.equal(resolveContextClass(hw), 'bare')
  const policy = resolveContextPolicy(hw)
  assert.equal(policy.clearNative, false)
  for (const key of ['engineering', 'ponytail', 'planPrompt', 'runtime', 'rag', 'automaticReview']) assert.equal(policy[key], false)
  assert.equal(resolveContextPolicy({ model: { providerID: 'openai', id: 'gpt-6-dnd-edition' } }).lane, 'dnd')
  assert.equal(resolveContextPolicy({ model: { providerID: 'openai', id: 'gpt-6-sol-direct' } }).runtime, true)
})

test('model resolution uses catalog variants, supports explicit mapping, and never invents Astra', () => {
  assert.equal(resolveModel(models, 'luna').model, 'gpt-6-luna')
  assert.equal(resolveModel(models, 'astra', 'max').effort, 'max')
  const reduced = [{ ...models[2], variants: { xhigh: {}, high: {} } }]
  assert.throws(() => resolveModel(reduced, 'astra', 'max'), /required reasoning effort max/)
  assert.throws(() => resolveModel(models.slice(0, 2), 'astra', 'max'), /unavailable/)
  assert.throws(() => resolveModel([{ ...models[0], variants: [] }], 'luna'), /required reasoning effort xhigh/)
  assert.throws(() => resolveModel([{ ...models[0], enabled: false }], 'luna'), /unavailable/)
  assert.equal(resolveModel([{ ...models[2], id: 'verified-expert', name: 'custom' }], 'astra', 'max', 'verified-expert').id, 'verified-expert')
})

test('routing preserves history and media without mutating request; OAuth tier is explicit', () => {
  const original = parent('Image review', [image]); original.reasoning_effort = 'low'
  const routed = routeBody(original, resolveModel(models, 'sol'), endpoint)
  assert.equal(routed.input, original.input)
  assert.equal(routed.model, 'gpt-6-sol')
  assert.equal(routed.reasoning.effort, 'xhigh')
  assert.equal(routed.reasoning.summary, 'auto')
  assert.equal(routed.service_tier, undefined)
  assert.equal(routed.reasoning_effort, undefined)
  assert.equal(original.service_tier, 'priority')
  assert.equal(routeBody(original, resolveModel(models, 'luna'), 'https://api.openai.com/v1/responses').service_tier, 'priority')
  const chat = routeBody({ messages: [], reasoning: { effort: 'low' } }, resolveModel(models, 'sol'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chat.reasoning_effort, 'xhigh'); assert.equal(chat.reasoning, undefined)
})

test('last-user identity is stable through tool continuations, changes for new turn and image changes', () => {
  const p = parent('Review', [image]); const a = userTurn(p)
  const b = userTurn({ ...p, input: [...p.input, { type: 'function_call_output', output: 'OK' }] })
  assert.equal(a.key, b.key); assert.equal(a.images.length, 1)
  assert.notEqual(a.key, userTurn({ ...p, input: [...p.input, ...p.input] }).key)
  assert.notEqual(a.key, userTurn(parent('Review', [{ ...image, image_url: 'changed' }])).key)
  assert.equal(userTurn({ input: 'abc' }).text, 'abc')
})

test('revision-scoped packets reject unknown fields, missing locators and oversize rather than truncate', () => {
  assert.deepEqual(validatePacket(packet()), packet())
  for (const key of ['project', 'boardRevision', 'corpusRevision', 'constraints', 'unknowns']) {
    const value = packet(); delete value[key]; assert.throws(() => validatePacket(value))
  }
  assert.throws(() => validatePacket({ ...packet(), endpoint: 'https://evil' }), /Unknown/)
  const locator = packet(); locator.evidence[0].locator = ''; assert.throws(() => validatePacket(locator), /locator/)
  const big = packet(); big.constraints = Array(20).fill('я'.repeat(900)); assert.throws(() => validatePacket(big), /18000/)
})

test('worker has fresh evidence-only context, exact selected images, no recursive tools/history/IDs', () => {
  const p = { ...parent('PRIVATE HISTORY'), previous_response_id: 'private-conversation', instructions: 'PRIVATE SYSTEM', prompt_cache_key: 'private-key' }
  const body = workerBody(p, 'pcb_review', packet(), [image], resolveModel(models, 'sol'), endpoint)
  assert.equal(body.model, 'gpt-6-sol'); assert.equal(body.input.length, 1)
  assert.deepEqual(body.input[0].content[1], image)
  assert.equal(body.store, false); assert.deepEqual(body.tools, [])
  assert.equal(JSON.stringify(body).includes('PRIVATE'), false)
  assert.equal(body.previous_response_id, undefined); assert.equal(body.prompt_cache_key, undefined)
  assert.equal(JSON.stringify(body).includes('No electrolytic capacitor'), true)
  assert.throws(() => workerBody(p, 'vision', packet(), [image], { ...resolveModel(models, 'luna'), input: ['text'] }, endpoint), /image input/)
})

test('Responses SSE handles fragmented UTF8, CRLF, completion, usage and tier', async () => {
  const result = await readProvider(sse([
    { type: 'response.output_text.delta', delta: '{"summary":"Плата' },
    { type: 'response.output_text.delta', delta: ' неизвестна"}' },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } }, service_tier: 'default' } },
  ], 1))
  assert.equal(result.text, '{"summary":"Плата неизвестна"}')
  assert.equal(result.usage.input_tokens_details.cached_tokens, 3)
  assert.equal(result.actualServiceTier, 'default')
})

test('Chat SSE retains terminal usage after stop', async () => {
  const result = await readProvider(sse([
    { choices: [{ delta: { content: 'review' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }, '[DONE]',
  ]))
  assert.equal(result.text, 'review'); assert.equal(result.usage.prompt_tokens, 4)
})

test('incomplete, refused, oversized or failed provider response never becomes a completed review', async () => {
  await assert.rejects(readProvider(sse([{ type: 'response.output_text.delta', delta: 'partial' }, '[DONE]'])), /incomplete/)
  await assert.rejects(readProvider(sse([{ type: 'response.incomplete' }])), /incomplete/)
  await assert.rejects(readProvider(sse([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }])), /stopped/)
  await assert.rejects(readProvider(sse([{ type: 'response.output_text.delta', delta: 'abcd' }]), 3), /budget/)
  await assert.rejects(readProvider(Response.json({ status: 'incomplete', output_text: 'partial' })), /complete/)
  await assert.rejects(readProvider(Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'tool_calls' }] })), /empty or over budget/)
  await assert.rejects(readProvider(new Response('secret-error', { status: 403 })), error => /403/.test(error.message) && !error.message.includes('secret-error'))
})

test('JEV only classifies bounded text and cannot downgrade deterministic high risk', async () => {
  let calls = 0, input
  const router = new JevRouter({ env: {}, fetcher: async (_url, options) => {
    calls++; input = JSON.parse(options.body)
    return Response.json({ message: { content: JSON.stringify({ role: 'pcb_review', confidence: 0.95 }) } })
  } })
  assert.equal((await router.route('ordinary design')).family, 'sol')
  assert.equal(input.think, false); assert.equal(input.options.num_predict, 96)
  assert.equal(input.messages.length, 2); assert.equal(input.stream, false)
  assert.equal((await router.route('mains isolation')).family, 'astra')
  assert.equal(calls, 1)
})

test('JEV invalid response falls back with cooldown; low confidence does not promote', async () => {
  let calls = 0
  const router = new JevRouter({ env: {}, fetcher: async () => { calls++; return Response.json({ message: { content: '{"role":"astra","confidence":1}' } }) } })
  assert.equal((await router.route('abc')).family, 'luna')
  assert.equal((await router.route('abc')).fallback, 'jev-busy-or-cooling'); assert.equal(calls, 1)
  const low = new JevRouter({ env: {}, fetcher: async () => Response.json({ message: { content: '{"role":"pcb_review","confidence":0.5}' } }) })
  assert.equal((await low.route('abc')).family, 'luna')
  const remote = new JevRouter({ env: { HARDWARE_QWEN_URL: 'https://example.org/api/chat' } })
  await assert.rejects(remote.route('abc'), /loopback/)
})

test('JEV timeout is bounded and busy requests do not queue', async () => {
  let calls = 0
  const router = new JevRouter({ env: { HARDWARE_QWEN_TIMEOUT_MS: '50' }, fetcher: async (_url, { signal }) => {
    calls++
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const keepAlive = setTimeout(() => {}, 500)
  try {
    const first = router.route('abc')
    assert.equal((await router.route('def')).fallback, 'jev-busy-or-cooling')
    assert.equal((await first).fallback, 'jev-unavailable'); assert.equal(calls, 1)
  } finally { clearTimeout(keepAlive) }
})

test('filter keeps hardware/KB/CAD discovery; excludes game/coding writes and hides helpers elsewhere', () => {
  const list = ['hardware_consult', 'hardware_status', 'kb_knowledge_search', 'diptrace', 'code', 'mcp_discover', 'odm_narrator', 'shell', 'edit']
  assert.deepEqual(filterHardwareTools(list, true), list.slice(0, 6))
  assert.deepEqual(filterHardwareTools(list, false), list.slice(2))
  assert.deepEqual(filterHardwareTools([{ type: 'function', function: { name: 'hardware_consult' } }, { name: 'shell' }], true).length, 1)
})

test('native manifest registers alias, prompt, tools and slash status without changing project instructions', async t => {
  const h = await harness(t)
  assert.equal(h.aliases.get(HARDWARE_MODEL).modelID, 'gpt-6-luna')
  assert.equal(h.aliases.get(HARDWARE_MODEL).variants, undefined)
  assert.equal(h.aliases.get(HARDWARE_MODEL).settings?.reasoningEffort, undefined)
  assert.equal(h.commands.has('hardware-status'), true)
  const event = { model: eventModel, agent: 'build', system: [{ type: 'text', text: 'PROJECT CONSTRAINTS' }], tools: ['hardware_consult', 'shell'] }
  await h.hooks.get('context')(event); await h.hooks.get('context')(event)
  assert.equal(event.system.length, 2); assert.equal(event.system[0].text, 'PROJECT CONSTRAINTS')
  assert.deepEqual(event.tools, ['hardware_consult'])
})

test('native routing respects manual direct selection and isolates sessions', async t => {
  const h = await harness(t)
  const routed = await h.request(parent('Design'))
  assert.equal((await routed.request.json()).model, 'gpt-6-luna')
  await h.request(parent('PCB review'), 's2')
  assert.equal((await h.status('s2')).parentModel, 'gpt-6-sol')
  assert.equal((await h.status('s1')).parentModel, 'gpt-6-luna')
  const direct = await h.request(parent('Other'), 's1', { providerID: 'openai', id: 'gpt-6-sol-direct' })
  assert.equal((await direct.request.json()).model, 'gpt-6-luna') // Exact unchanged fixture.
  await assert.rejects(h.status('s1'), /Select/)
  assert.equal((await h.status('s2')).parentModel, 'gpt-6-sol')
})

test('specialists reuse exact native transport but never credentials/history in receipts; requests deduplicate', async t => {
  const h = await harness(t)
  await h.request(parent('PRIVATE MAIN HISTORY', [image]))
  const [a, b] = await Promise.all([h.consult('pcb_review', packet(), { imageIndices: [0] }), h.consult('pcb_review', packet(), { imageIndices: [0] })])
  assert.equal(a.content, b.content); assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.url, endpoint); assert.equal(call.headers.get('authorization'), 'Bearer secret-fixture')
  assert.equal(call.headers.get('idempotency-key'), null); assert.equal(call.headers.get('x-client-request-id'), null)
  assert.equal(call.body.model, 'gpt-6-sol'); assert.equal(JSON.stringify(call.body).includes('PRIVATE MAIN HISTORY'), false)
  assert.equal(a.content.includes('secret-fixture'), false)
  assert.equal(JSON.parse(a.content).advisoryOnly, true)
  assert.equal(JSON.parse(a.content).usage.input_tokens, 100)
  const changed = packet(); changed.boardRevision = 'revision-b'
  await h.consult('pcb_review', changed, { imageIndices: [0] }); assert.equal(h.calls.length, 2)
  await assert.rejects(h.consult('vision'), /original image/)
  await assert.rejects(h.consult('vision', packet(), { imageIndices: [10] }), /imageIndices/)
})

test('new user turn invalidates exact worker cache; repeated continuation does not reset budget', async t => {
  const h = await harness(t)
  const body = parent()
  await h.request(body)
  await h.consult('design')
  await h.request({ ...body, input: [...body.input, { type: 'function_call_output', output: 'OK' }] })
  await h.consult('design'); assert.equal(h.calls.length, 1)
  await h.request({ ...body, input: [...body.input, ...body.input] })
  await h.consult('design'); assert.equal(h.calls.length, 2)
})

test('worker budget, explicit missing Astra and failed-call deduplication are enforced', async t => {
  const h = await harness(t, { models: models.slice(0, 2) })
  await h.request()
  await assert.rejects(h.consult('critical_review'), /unavailable/)
  for (let i = 0; i < 4; i++) await h.consult('design', { ...packet(), task: `block ${i}` })
  await assert.rejects(h.consult('design', { ...packet(), task: 'fifth' }), /budget exhausted/)
  assert.equal(h.calls.length, 4)
  await assert.rejects(h.request(parent('mains')), /unavailable/)
})

test('failed provider call is cached instead of silently retried', async t => {
  const h = await harness(t, { fetcher: async () => new Response('error', { status: 500 }) })
  await h.request()
  await assert.rejects(h.consult('design'), /500/)
  await assert.rejects(h.consult('design'), /500/)
  assert.equal(h.calls.length, 1); assert.equal((await h.status()).inFlight, 0)
})

test('at most two simultaneous workers; superseding turn cancels both with no stale result', async t => {
  let entered = 0
  const h = await harness(t, { fetcher: async request => {
    entered++
    return new Promise((_resolve, reject) => {
      if (request.signal.aborted) return reject(request.signal.reason)
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    })
  } })
  await h.request()
  const first = h.consult('design'); const failure1 = assert.rejects(first, /superseded/)
  const second = h.consult('pcb_review'); const failure2 = assert.rejects(second, /superseded/)
  while (entered < 2) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(h.consult('critical_review'), /already running/)
  await h.request(parent('Different task'))
  await Promise.all([failure1, failure2])
  assert.equal((await h.status()).consultationsStarted, 0)
})

test('abort before worker dispatch spends nothing', async t => {
  const h = await harness(t)
  await h.request()
  const controller = new AbortController(); controller.abort()
  await assert.rejects(h.consult('design', packet(), {}, 's1', controller.signal), /cancelled/)
  assert.equal(h.calls.length, 0)
})

test('router runs once per user turn, not per tool continuation', async t => {
  const h = await harness(t, { jev: true, fetcher: async request => String(request).includes('11434') ?
    Response.json({ message: { content: '{"role":"design","confidence":1}' } }) : answer() })
  const body = parent()
  await Promise.all([h.request(body), h.request(body)])
  await h.request({ ...body, input: [...body.input, { type: 'function_call_output', output: 'readback' }] })
  assert.equal(h.calls.length, 1)
})

test('image capability and excessive retained images are explicit, not text-only pretend vision', async t => {
  const h = await harness(t, { models: [{ ...models[0], capabilities: { input: ['text'] } }, models[1], models[2]] })
  await assert.rejects(h.request(parent('Design', [image])), /image input/)
})

test('incremental Responses continuation retains original route, image indices and consultation budget', async t => {
  const h = await harness(t)
  await h.request(parent('PCB review', [image]))
  await h.consult('vision', packet(), { imageIndices: [0] })
  const continued = await h.request({ model: 'gpt-6-luna', previous_response_id: 'fixture-prior', input: [{ type: 'function_call_output', call_id: 'fixture-call', output: 'Done' }] })
  assert.equal((await continued.request.json()).model, 'gpt-6-sol')
  assert.deepEqual((await h.status()).availableImages, [0])
  assert.equal((await h.status()).consultationsStarted, 1)
  await h.consult('vision', packet(), { imageIndices: [0] })
  assert.equal(h.calls.length, 1)
  await assert.rejects(h.request({ previous_response_id: 'missing-state', input: [] }, 'unknown-session'), /lost its turn state/)
})

test('session memory bounds cannot retain a seventeenth session transport', async t => {
  const h = await harness(t)
  for (let i = 0; i < 17; i++) await h.request(parent('Design'), `s-${i}`)
  await assert.rejects(h.status('s-0'), /Select/)
  assert.equal((await h.status('s-16')).parentModel, 'gpt-6-luna')
})

test('same packet in two sessions is never served from another session cache', async t => {
  const h = await harness(t)
  await h.request(parent(), 'a'); await h.request(parent(), 'b')
  await h.consult('design', packet(), {}, 'a'); await h.consult('design', packet(), {}, 'b')
  assert.equal(h.calls.length, 2)
})
