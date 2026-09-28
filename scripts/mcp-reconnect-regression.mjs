import assert from 'node:assert/strict'
import { createMcpRecovery } from '../config/plugins/mcp-reconnect.js'
import router from '../config/plugins/lazy-local-router.js'

let disposed = false
const cleanup = await router.setup({ session: { hook: async () => ({ dispose() { disposed = true } }) } })
assert.equal(typeof cleanup, 'function', 'Native plugin cleanup must be callable during hot reload')
await cleanup()
assert.equal(disposed, true)

// A server that never connected (doomed first start) is never retried.
{
  let clock = 0
  const attempts = []
  const doomed = createMcpRecovery({
    now: () => clock,
    list: async () => [{ name:'fabric', status:{ status:'failed', error:'Connection closed' } }],
    connect: async name => { attempts.push(name) },
  })
  for (const at of [0, 2000, 12000, 42000]) { clock = at; await doomed.tick() }
  assert.equal(attempts.length, 0, 'a never-connected server must not be reconnected')
}

let clock = 0
let rows = [{ name:'diptrace', status:{ status:'connected' } }]
const calls = []
let finish
const recovery = createMcpRecovery({
  now: () => clock,
  list: async () => structuredClone(rows),
  connect: async name => { calls.push(name); if (finish) await new Promise(resolve => { finish = resolve }) },
})
await recovery.tick()
rows[0].status = { status:'failed', error:'Connection closed' }
await recovery.tick()
assert.equal(calls.length, 0)
clock = 2000
finish = true
const running = recovery.tick()
await new Promise(resolve => setImmediate(resolve))
await recovery.tick()
assert.equal(calls.length, 1, 'Concurrent scans must not duplicate a connection')
finish(); finish = null
await running
clock = 11999; await recovery.tick(); assert.equal(calls.length, 1)
clock = 12000; await recovery.tick(); assert.equal(calls.length, 2)
clock = 42000; await recovery.tick(); assert.equal(calls.length, 3)
clock = 999999; await recovery.tick(); assert.equal(calls.length, 3, 'An outage has a finite retry budget')
rows[0].status = { status:'connected' }; await recovery.tick()
clock += 1000; rows[0].status = { status:'failed', error:'Connection closed' }; await recovery.tick()
assert.equal(calls.length, 3, 'A brief connection must not reset the budget')
rows[0].status = { status:'connected' }; await recovery.tick()
clock += 60000; await recovery.tick()
rows[0].status = { status:'failed', error:'Connection closed' }; await recovery.tick()
clock += 2000; await recovery.tick(); assert.equal(calls.length, 4)
for (const status of [{ status:'disabled' }, { status:'needs_auth' }, { status:'failed', error:'401 Unauthorized' }]) {
  rows[0].status = status
  clock += 100000; await recovery.tick()
}
assert.equal(calls.length, 4, 'Disabled/auth failures must not reconnect')
rows[0].status = { status:'failed', error:'Connection closed' }; await recovery.tick()
rows = []; clock += 2000; await recovery.tick()
assert.equal(calls.length, 4, 'Removed server must remain removed')
rows = [{ name:'diptrace', status:{ status:'connected' } }]
await recovery.tick()
rows[0].status = { status:'failed', error:'Connection closed' }
await recovery.tick(); recovery.stop(); clock += 2000; await recovery.tick()
assert.equal(calls.length, 4, 'Disposed plugin must stop retrying')
let reads = 0
let unwanted = 0
clock = 0
const manualDisconnect = createMcpRecovery({
  now: () => clock,
  list: async () => [{ name:'diptrace', status: ++reads === 1 ? { status:'connected' } : reads < 4 ? { status:'failed', error:'Connection closed' } : { status:'disabled' } }],
  connect: async () => { unwanted++ },
})
await manualDisconnect.tick(); await manualDisconnect.tick(); clock = 2000; await manualDisconnect.tick()
assert.equal(unwanted, 0, 'Recheck a manual disconnect immediately before reconnect')
console.log('MCP recovery regression passed: never-connected skip, backoff, bounded retries, flapping, concurrency, disabled/auth/removal, cleanup')
