import assert from 'node:assert/strict'
import { applyRetryGuard } from '../config/plugins/provider-retry-guard.js'

const decision = (error, attempt = 1, retry = { retry:true, delay:2_000 }) => {
  const event = { error, attempt, decision:retry }
  applyRetryGuard(event)
  return event.decision
}

assert.deepEqual(decision({ status:401, type:'provider.authentication', message:'Unauthorized' }), { retry:false })
assert.deepEqual(decision({ status:403, message:'Forbidden' }), { retry:false })
assert.deepEqual(decision({ type:'provider.transport', message:'ECONNRESET' }, 3), { retry:false })
assert.deepEqual(decision({ status:429, message:'slow down' }, 1, { retry:true, delay:86_400_000 }), { retry:true, delay:30_000 })
assert.deepEqual(decision({ status:500, message:'temporary' }, 1), { retry:true, delay:2_000 })

let hook
let disposed = false
const cleanup = await (await import('../config/plugins/provider-retry-guard.js')).default.setup({
  session:{ hook:async (name, callback) => {
    assert.equal(name, 'retry')
    hook = callback
    return { dispose:() => { disposed = true } }
  } },
})
const event = { error:{ status:401 }, attempt:1, decision:{ retry:true, delay:2_000 } }
hook(event)
assert.deepEqual(event.decision, { retry:false })
await cleanup()
assert.equal(disposed, true)

console.log('Provider retry guard regression OK: auth fail-fast + bounded attempts/delay')
