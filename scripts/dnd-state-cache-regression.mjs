import assert from 'node:assert/strict'
import plugin, { createDndStateCache } from '../config/plugins/dnd-state-cache.js'

const campaignId = '11111111-1111-4111-8111-111111111111'
const epoch = 'e'.repeat(64), revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64)
const query = { operation: 'read', campaignId, afterSeq: 10 }
const baseline = { currentSeq: 10, nextCursor: 10, hasMore: false, timelineEpoch: epoch,
  sheets: [{ id: 'hero', hp: 20 }], stateDelta: { format: 'odm.state.delta.v1', full: true, revision, checksum: revision } }
const result = value => ({ content: JSON.stringify(value), metadata: {} })
const cache = createDndStateCache()
let calls = 0, last
const execute = cache.wrap(async input => {
  calls++; last = input
  return result(calls === 1 ? baseline : { ...baseline, sheets: undefined,
    stateDelta: { ...baseline.stateDelta, full: false, baseRevision: revision, revision: nextRevision, checksum: nextRevision, patch: {} } })
})
const context = { sessionID: 'one' }
await execute(query, context)
assert.equal(last.stateDelta, true)
await execute(query, context)
assert.equal(last.knownStateRevision, revision, 'the client, not the model, carries the acknowledged revision')
assert.equal(calls, 2, 'the cache must never bypass a fresh authorized server read')
assert.equal(query.stateDelta, undefined, 'do not mutate model inputs')
assert.equal(cache.prepare('two', query).knownStateRevision, undefined, 'sessions are isolated')
assert.equal(cache.prepare('one', { ...query, campaignId: 'other' }).knownStateRevision, undefined)
assert.equal(cache.prepare('one', { ...query, projection: 'full' }).knownStateRevision, undefined)
assert.equal(cache.prepare('one', { ...query, stateDelta: false }).knownStateRevision, undefined)
assert.equal(cache.prepare('one', query).maxBytes, 45056, 'pages fit the host tool_output cap')
assert.equal(cache.prepare('one', { ...query, maxBytes: 131072 }).maxBytes, 45056, 'an oversized model request is clamped')
assert.equal(cache.prepare('one', { ...query, maxBytes: 8192 }).maxBytes, 8192, 'a smaller model request is kept')
assert.deepEqual(cache.prepare('one', { ...query, pageCursor: 'frozen', maxBytes: 4096 }), { ...query, pageCursor: 'frozen', maxBytes: 4096 }, 'an unknown cursor passes through')
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, category: 'combat' }).summaryOnly, true)
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, action: 'cast_buff' }).summaryOnly, undefined)
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, summaryOnly: false }).summaryOnly, false)

const write = { operation: 'invoke', campaignId, commandId: 'original', expectedSeq: 10, timelineEpoch: epoch,
  name: 'pc_attack', args: { characterId: 'hero' }, readAfter: { afterSeq: 10, knownSections: {} } }
const prepared = cache.prepare('one', write)
assert.equal(prepared.readAfter.knownStateRevision, nextRevision)
assert.deepEqual({ ...prepared, readAfter: write.readAfter }, write, 'never change command identity, CAS or engine arguments')
assert.equal(cache.prepare('one', { ...write, readAfter: false }).readAfter, false)
{
  const { readAfter: _omitted, ...bare } = write
  const injected = cache.prepare('one', bare)
  assert.deepEqual({ ...injected, readAfter: undefined }, { ...bare, readAfter: undefined }, 'injecting readAfter never touches the command')
  assert.equal(injected.readAfter.stateDelta, true)
  assert.equal(injected.readAfter.knownStateRevision, nextRevision, 'a write without readAfter still gets the bounded delta')
  assert.equal(injected.readAfter.maxBytes, 45056)
  assert.equal(cache.prepare('one', { operation: 'answer_ask', campaignId, askId: 'x' }).readAfter, undefined, 'non-story writes are untouched')
  assert.equal(cache.prepare('one', { ...bare, readAfter: true }).readAfter.knownStateRevision, nextRevision, 'readAfter:true means the default bounded delta, not a full state')
  assert.deepEqual(cache.prepare('one', { operation: 'snapshot', campaignId, sections: ['party'], projection: 'live', stateDelta: true }), { operation: 'snapshot', campaignId, sections: ['party'] })
}

cache.reset('one')
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'compaction/reconnect discards the baseline')
const failing = cache.wrap(async () => { throw new Error('ambiguous write') })
await assert.rejects(failing(write, context), /ambiguous write/)

// A byte-page prefix is not a baseline. Only a contiguous completed snapshot is.
const page1 = { format: 'odm.read.page.v1', hash: 'h', offset: 0, complete: false, nextPage: 'p2',
  entries: [{ key: 'timelineEpoch', value: epoch }], currentSeq: 10, nextCursor: 10, hasMore: false }
const page2 = { ...page1, offset: 1, complete: true, nextPage: null,
  entries: [{ key: 'stateDelta', value: baseline.stateDelta }] }
let page = page1, sent = []
const paged = cache.wrap(async input => { sent.push(input); return result(page) })
await paged(query, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined)
await assert.rejects(execute(write, context), /Finish reading ODM.*pageCursor.*p2/)
assert.equal(calls, 2, 'an incomplete byte page must block the write before the server is called')
assert.equal(cache.prepare('two', write).operation, 'invoke', 'another session is not blocked')
assert.equal(cache.prepare('one', { ...write, campaignId: 'other' }).operation, 'invoke', 'another campaign is not blocked')
page = page2
await paged({ ...query, pageCursor: 'p2' }, context)
assert.deepEqual(sent[1], { ...sent[0], pageCursor: 'p2' }, 'a continuation replays the exact first-page query the server froze')
assert.equal(cache.prepare('one', query).knownStateRevision, revision)
assert.equal(cache.prepare('one', write).operation, 'invoke', 'draining the last byte page permits the write')

cache.reset('one')
page = page1
await paged({ ...query, stateDelta: false }, context)
page = { ...page2, entries: [{ key: 'currentSeq', value: 10 }] }
await paged({ ...query, stateDelta: false, pageCursor: 'p2' }, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'no baseline is acknowledged without stateDelta')
assert.equal(cache.prepare('one', write).operation, 'invoke', 'a completed non-delta page clears the write barrier')
assert.equal(cache.takePendingRead('one'), undefined, 'a completed non-delta page cannot wake another continuation')

cache.reset('one')
page = page1
await paged({ ...query, projection: 'full' }, context)
await assert.rejects(execute(write, context), /Finish reading ODM.*"projection":"full".*pageCursor.*p2/)
assert.equal(calls, 2, 'a pending full-projection page blocks a default-projection write')
for (const operation of ['set_floor', 'request_response', 'end_campaign']) {
  assert.throws(() => cache.prepare('one', { campaignId, operation }), /Finish reading ODM/)
  assert.equal(cache.prepare('two', { campaignId, operation }).readAfter, undefined, 'the guard never injects readAfter into these operations')
}

cache.reset('one')
page = page2
await paged({ ...query, pageCursor: 'p2' }, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'never acknowledge an orphan last page')
const oversized = cache.wrap(async () => result({ ...baseline, sheets: [{ id: 'huge', text: 'x'.repeat(140000) }] }))
await oversized(query, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'artifact-sized output was not fully delivered to the model')
const clipped = cache.wrap(async () => ({ ...result(baseline), metadata: { truncated: true } }))
await clipped(query, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined)

const good = cache.wrap(async () => result(baseline))
await good(query, { ...context, odmBackgroundRead: true })
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'watcher-only reads must never acknowledge state on behalf of the model')
await good(query, context)
const readback = cache.wrap(async () => result({ committedSeq: 11, readRequired: false, readAfter: prepared.readAfter,
  state: { ...baseline, stateDelta: { ...baseline.stateDelta, revision: nextRevision, checksum: nextRevision } } }))
await readback(write, context)
assert.equal(cache.prepare('one', query).knownStateRevision, nextRevision)
await cache.wrap(async () => result({ readRequired: true }))(write, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'failed readback cannot advance a cache')

// Invalid/partial replies and an in-flight response after reset cannot restore stale context.
let finish
const inFlight = cache.wrap(() => new Promise(resolve => { finish = resolve }))
const pending = inFlight(query, context)
cache.reset('one')
finish(result(baseline)); await pending
assert.equal(cache.prepare('one', query).knownStateRevision, undefined)
{
  // A refused call keeps the acknowledged baseline; a repeated identical catalog is not resent.
  const errors = createDndStateCache()
  let fail = false
  const call = errors.wrap(async input => {
    if (fail) throw new Error('engine refused')
    return result(input.operation === 'catalog' ? { groups: [{ name: 'pc_attack' }] } : baseline)
  })
  const ctx = { sessionID: 'err' }
  await call(query, ctx)
  fail = true
  await assert.rejects(call({ operation: 'invoke', campaignId, name: 'pc_attack', expectedSeq: 10 }, ctx), /engine refused/)
  assert.equal(errors.prepare('err', query).knownStateRevision, revision, 'an engine refusal must not force a full resync')
  fail = false
  const catalog = { operation: 'catalog', campaignId, action: 'pc_attack' }
  assert.match((await call(catalog, ctx)).content, /pc_attack/)
  assert.match((await call(catalog, ctx)).content, /unchanged/, 'the second identical lookup is a stub')
  assert.match((await call({ ...catalog, action: 'heal' }, ctx)).content, /pc_attack/, 'other arguments are answered in full')
  errors.reset('err')
  assert.match((await call(catalog, ctx)).content, /pc_attack/, 'after a reset the schema is sent again')
}
{
  // Unknown sheet references need a fresh roster, even at the same sequence.
  // Ordinary engine refusals and ambiguous transport errors keep their baseline.
  const refs = createDndStateCache(), ctx = { sessionID: 'refs' }
  const read = refs.wrap(async () => result(baseline))
  for (const message of ['Unknown characterId; use one from GAME STATE.', 'Unknown targetCharacterId; use one from GAME STATE.', 'Take an item needs character (characterId).']) {
    await read(query, ctx)
    await read({ ...query, projection: 'full' }, ctx)
    await read({ ...query, campaignId: 'other' }, ctx)
    let attempts = 0
    const refused = refs.wrap(async () => { attempts++; throw new Error(message) })
    await assert.rejects(refused(write, ctx), error => error.message === message)
    assert.equal(attempts, 1, 'never retry or rewrite a refused write')
    for (const projection of ['live', 'full']) assert.equal(refs.prepare('refs', { ...query, projection }).knownStateRevision, undefined, 'the next read must restore the whole roster')
    const recovery = refs.prepare('refs', { ...query, knownStateRevision: revision, knownSeq: 10, knownSections: { sheets: revision } })
    assert.equal(recovery.knownStateRevision, undefined, 'model-supplied stale hints cannot suppress the roster')
    assert.equal(recovery.knownSections, undefined)
    assert.equal(recovery.delta, false)
    assert.equal(refs.prepare('refs', { ...query, campaignId: 'other' }).knownStateRevision, revision, 'other campaigns keep their baseline')
  }
  await read(query, ctx)
  const errorResult = { isError: true, content: [{ type: 'text', text: 'Unknown characterId; use one from GAME STATE.' }] }
  assert.deepEqual(await refs.wrap(async () => errorResult)(write, ctx), errorResult)
  assert.equal(refs.prepare('refs', query).knownStateRevision, undefined, 'structured MCP errors also restore the roster')
  await read(query, ctx)
  const nativeError = { type: 'tool.execution', message: 'Unknown characterId; use one from GAME STATE.' }
  await assert.rejects(refs.wrap(async () => { throw nativeError })(write, ctx), error => error === nativeError)
  assert.equal(refs.prepare('refs', query).knownStateRevision, undefined, 'native plain-object tool errors also restore the roster')
  await read(query, ctx)
  assert.equal(refs.prepare('refs', query).knownStateRevision, revision, 'a confirmed full read restores ordinary deltas')
  await assert.rejects(refs.wrap(async () => { throw new Error('Transport closed') })(write, ctx), /Transport closed/)
  assert.equal(refs.prepare('refs', query).knownStateRevision, revision, 'ambiguous transport failures do not invalidate a confirmed roster')
}
{
  // A complete single page reaches the model as a plain object; a partial page stays a page.
  const plain = createDndStateCache()
  const single = { format: 'odm.read.page.v1', hash: 'h', shape: { currentSeq: 'value', events: 'array', stateDelta: 'value' }, offset: 0,
    entries: [{ key: 'currentSeq', value: 10 }, { key: 'events', index: 0, value: { seq: 10 } }, { key: 'timelineEpoch', value: epoch },
      { key: 'stateDelta', value: baseline.stateDelta }], nextPage: null, complete: true, currentSeq: 10, nextCursor: 10, hasMore: false }
  let reply = single
  const read = plain.wrap(async () => result(reply))
  assert.deepEqual(JSON.parse((await read(query, { sessionID: 'p' })).content),
    { currentSeq: 10, events: [{ seq: 10 }], timelineEpoch: epoch, stateDelta: baseline.stateDelta })
  assert.equal(plain.prepare('p', query).knownStateRevision, revision, 'the unwrapped page still acknowledges its baseline')
  reply = { ...single, complete: false, nextPage: 'p2' }
  assert.equal(JSON.parse((await read(query, { sessionID: 'p' })).content).format, 'odm.read.page.v1')
  await assert.rejects(read({ operation: 'narrate', campaignId, expectedSeq: 10 }, { sessionID: 'p' }), /Finish reading ODM/)
  plain.reset('p')
  reply = { committedSeq: 11, readRequired: false, readAfter: { afterSeq: 10 }, state: single }
  assert.equal(JSON.parse((await read({ operation: 'narrate', campaignId, expectedSeq: 10 }, { sessionID: 'p' })).content).state.currentSeq, 10)
}
console.log('D&D state cache regression passed: isolation, paging, readAfter, clipping and command identity')

// Plugin wiring: compaction is observed through native session events.
{
  let emit
  const events = new ReadableStream({ start(controller) { emit = (event) => controller.enqueue(event) } })
  let wrapped
  const hooks = []
  const inputs = []
  const cleanup = await plugin.setup({
    tool: { transform: async (apply) => {
      apply({
        get: (name) => name === 'odm_narrator' ? {} : undefined,
        update: (name, update) => {
          const tool = { execute: async (input) => { inputs.push(input); return result(inputs.length === 1 ? baseline : { ...baseline, sheets: undefined, stateDelta: { ...baseline.stateDelta, full: false, baseRevision: revision, revision: nextRevision, checksum: nextRevision } }) } }
          update(tool)
          wrapped = tool.execute
        },
      })
      return { dispose: async () => {} }
    } },
    session: { hook: async (name) => { hooks.push(name); return { dispose: async () => {} } } },
    event: { subscribe: () => events.values() },
  })
  assert.deepEqual(hooks, [], 'no hook on a name the native host never fires')
  const session = { sessionID: 'compacted' }
  await wrapped(query, session)
  await wrapped(query, session)
  assert.equal(inputs.at(-1).knownStateRevision, revision, 'baseline acknowledged before compaction')
  emit({ type: 'session.compaction.started', data: { sessionID: 'compacted', reason: 'auto' } })
  await new Promise((resolve) => setImmediate(resolve))
  await wrapped(query, session)
  assert.equal(inputs.at(-1).knownStateRevision, undefined, 'compaction discards the acknowledged baseline')
  await cleanup()
}
console.log('D&D state cache plugin wiring passed: compaction events reset the baseline')

// A completed primary narrator resumes an unfinished byte page once, without advancing the story cursor.
{
  let emit, wrapped, page = page1, failDelivery = false
  const wakes = [], inputs = [], directory = '/game'
  const native = { agent: 'dnd-narrator', location: { directory } }
  const sessions = {
    primary: native,
    reserve: { ...native, agent: 'dnd-luna-reserve' },
    child: { ...native, parentID: 'parent' },
    reader: { ...native, agent: 'dnd-reader' },
    planner: { ...native, agent: 'dnd-planner' },
    memory: { ...native, agent: 'dnd-memory' },
    elsewhere: { ...native, location: { directory: '/other' } },
  }
  const events = new ReadableStream({ start(controller) { emit = event => controller.enqueue(event) } })
  const cleanup = await plugin.setup({
    location: { directory },
    tool: { transform: async apply => {
      apply({ get: name => name === 'odm_narrator' ? {} : undefined, update: (_name, update) => {
        const tool = { execute: async input => { inputs.push(input); return result(page) } }
        update(tool); wrapped = tool.execute
      } })
      return { dispose: async () => {} }
    } },
    session: {
      get: async ({ sessionID }) => sessions[sessionID] ?? native,
      synthetic: async value => { wakes.push(value); if (failDelivery) throw new Error('delivery failed') },
    },
    event: { subscribe: () => events.values() },
  })
  const event = async (type, sessionID) => {
    emit({ type, data: { sessionID } })
    await new Promise(resolve => setImmediate(resolve))
  }
  await wrapped(query, { sessionID: 'primary' })
  await event('session.execution.succeeded', 'primary')
  assert.deepEqual(wakes[0].metadata.dndReadContinuation, { ...inputs[0], operation: 'read', pageCursor: 'p2' })
  assert.equal(wakes[0].resume, true)
  assert.equal(wakes[0].delivery, 'queue')
  assert.match(wakes[0].text, /host bookkeeping.*not a player action/)
  await event('session.idle', 'primary')
  await wrapped(query, { sessionID: 'primary' })
  await event('session.idle', 'primary')
  assert.equal(wakes.length, 1, 'success and idle cannot resume the same frozen page twice')
  page = { ...page1, offset: 1, nextPage: 'p3', entries: [{ key: 'currentSeq', value: 10 }] }
  await wrapped({ ...query, pageCursor: 'p2' }, { sessionID: 'primary' })
  await event('session.idle', 'primary')
  assert.equal(wakes.length, 2, 'a new continuation cursor may resume once')
  assert.equal(wakes[1].metadata.dndReadContinuation.pageCursor, 'p3')
  page = { ...page2, offset: 2 }
  await wrapped({ ...query, pageCursor: 'p3' }, { sessionID: 'primary' })
  await event('session.idle', 'primary')
  assert.equal(wakes.length, 2, 'a fully delivered baseline needs no continuation')
  page = page1
  for (const sessionID of ['child', 'reader', 'planner', 'memory', 'elsewhere']) {
    await wrapped(query, { sessionID })
    await event('session.idle', sessionID)
  }
  assert.equal(wakes.length, 2, 'only a primary narrator in this location is resumed')
  await wrapped(query, { sessionID: 'reserve' })
  await event('session.idle', 'reserve')
  assert.equal(wakes.length, 3, 'the primary reserve narrator is supported')
  failDelivery = true
  await wrapped(query, { sessionID: 'failed' })
  await event('session.idle', 'failed')
  await event('session.idle', 'failed')
  assert.equal(wakes.length, 4, 'a failed notification never creates a paid retry loop')
  failDelivery = false
  await wrapped(query, { sessionID: 'interrupted' })
  await event('session.execution.interrupted', 'interrupted')
  await event('session.idle', 'interrupted')
  assert.equal(wakes.length, 4, 'a stopped narrator stays stopped')
  await cleanup()
}
console.log('D&D state cache idle continuation passed: exact query, primary-only, deduplication and interruption')
