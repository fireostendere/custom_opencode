import assert from 'node:assert/strict'
import { createDndStateCache } from '../config/plugins/dnd-state-cache.js'

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
assert.deepEqual(cache.prepare('one', { ...query, pageCursor: 'frozen', maxBytes: 4096 }), { ...query, pageCursor: 'frozen', maxBytes: 4096 })
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, category: 'combat' }).summaryOnly, true)
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, action: 'cast_buff' }).summaryOnly, undefined)
assert.equal(cache.prepare('one', { operation: 'catalog', campaignId, summaryOnly: false }).summaryOnly, false)

const write = { operation: 'invoke', campaignId, commandId: 'original', expectedSeq: 10, timelineEpoch: epoch,
  name: 'pc_attack', args: { characterId: 'hero' }, readAfter: { afterSeq: 10, knownSections: {} } }
const prepared = cache.prepare('one', write)
assert.equal(prepared.readAfter.knownStateRevision, nextRevision)
assert.deepEqual({ ...prepared, readAfter: write.readAfter }, write, 'never change command identity, CAS or engine arguments')
assert.equal(cache.prepare('one', { ...write, readAfter: false }).readAfter, false)

cache.reset('one')
assert.equal(cache.prepare('one', query).knownStateRevision, undefined, 'compaction/reconnect discards the baseline')
const failing = cache.wrap(async () => { throw new Error('ambiguous write') })
await assert.rejects(failing(write, context), /ambiguous write/)

// A byte-page prefix is not a baseline. Only a contiguous completed snapshot is.
const page1 = { format: 'odm.read.page.v1', hash: 'h', offset: 0, complete: false, nextPage: 'p2',
  entries: [{ key: 'timelineEpoch', value: epoch }], currentSeq: 10, nextCursor: 10, hasMore: false }
const page2 = { ...page1, offset: 1, complete: true, nextPage: null,
  entries: [{ key: 'stateDelta', value: baseline.stateDelta }] }
let page = page1
const paged = cache.wrap(async () => result(page))
await paged(query, context)
assert.equal(cache.prepare('one', query).knownStateRevision, undefined)
page = page2
await paged({ ...query, pageCursor: 'p2' }, context)
assert.equal(cache.prepare('one', query).knownStateRevision, revision)

cache.reset('one')
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
console.log('D&D state cache regression passed: isolation, paging, readAfter, clipping and command identity')
