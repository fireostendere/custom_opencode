import assert from 'node:assert/strict'
import { installCompactionRecovery } from '../config/plugins/tui/lib/compaction-recovery.js'

const compaction = (id, status = 'running') => ({ id, type: 'compaction', status, summary: '', time: { created: 1 } })
const stale = compaction('stale')
const active = compaction('active')
const sessions = new Map([['one', [stale]], ['two', [active]]])
const messages = {
  list(id) { return sessions.get(id) ?? [] },
  get(id, messageID) { return sessions.get(id)?.find(row => row.id === messageID) },
}
const original = { ...messages }
const dispose = installCompactionRecovery({ data: { session: { message: messages } } })
assert.deepEqual(messages.list('missing'), [])
assert.equal(messages.get('one', 'missing'), undefined)
assert.equal(messages.get('one', 'stale'), stale, 'Age alone must not end a live compaction')
sessions.get('one').push({ id: 'queued', type: 'user' }, { id: 'control', type: 'model-switched' })
assert.equal(messages.get('one', 'stale'), stale, 'Queued input and control events are not completion evidence')

for (const next of [{ id: 'step', type: 'assistant' }, compaction('next'), compaction('done', 'completed'), compaction('failed', 'failed')]) {
  sessions.set('one', [stale, next])
  const view = messages.list('one')
  assert.equal(view[0].status, 'failed')
  assert.equal(view[0].error.type, 'compaction.interrupted')
  assert.deepEqual(messages.get('one', 'stale'), view[0], 'Rows and individual messages must agree')
  assert.equal(view[1], next, 'Leave the latest operation untouched')
  assert.equal(stale.status, 'running', 'Never rewrite native history')
  assert.equal(messages.get('two', 'active'), active, 'Never use progress from another session')
}

Object.assign(stale, { status: 'completed', summary: 'Recovered native summary' })
assert.equal(messages.get('one', 'stale'), stale, 'A late native completion must replace the recovered view')
assert.equal(messages.list('one')[0].summary, 'Recovered native summary')
dispose()
assert.equal(messages.list, original.list)
assert.equal(messages.get, original.get)
console.log('Compaction recovery passed: live operations preserved, stale markers settled, native history unchanged')
