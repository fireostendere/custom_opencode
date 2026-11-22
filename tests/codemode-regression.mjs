import assert from 'node:assert/strict'
import plugin, { parseCodemodeAction, CODEMODE_POLICY } from '../config/plugins/codemode.js'

// 1. Test parseCodemodeAction
assert.deepEqual(parseCodemodeAction(''), { action: 'toggle' })
assert.deepEqual(parseCodemodeAction(null), { action: 'toggle' })
assert.deepEqual(parseCodemodeAction('status'), { action: 'status' })
assert.deepEqual(parseCodemodeAction('STATUS'), { action: 'status' })
assert.deepEqual(parseCodemodeAction('on'), { action: 'on' })
assert.deepEqual(parseCodemodeAction('enable'), { action: 'on' })
assert.deepEqual(parseCodemodeAction('1'), { action: 'on' })
assert.deepEqual(parseCodemodeAction('off'), { action: 'off' })
assert.deepEqual(parseCodemodeAction('disable'), { action: 'off' })
assert.deepEqual(parseCodemodeAction('0'), { action: 'off' })
assert.deepEqual(parseCodemodeAction('toggle'), { action: 'toggle' })
assert.deepEqual(parseCodemodeAction('on run tests'), { action: 'on', prompt: 'run tests' })
assert.deepEqual(parseCodemodeAction('enable find leaks'), { action: 'on', prompt: 'find leaks' })
assert.deepEqual(parseCodemodeAction('find all unused imports'), { action: 'task', prompt: 'find all unused imports' })

// 2. Test Plugin lifecycle and Command & Context Hook interactions
const storageData = new Map()
const mockStorage = {
  get: async (key) => storageData.get(key),
  set: async (key, val) => storageData.set(key, val),
  remove: async (key) => storageData.delete(key),
}

let commandDef
let contextHook
let disposedCount = 0
const receipts = []

const registration = () => ({
  dispose: () => {
    disposedCount++
  },
})

const cleanup = await plugin.setup({
  storage: mockStorage,
  command: {
    transform: async (fn) => {
      fn({
        add: (def) => {
          commandDef = def
        },
      })
      return registration()
    },
  },
  session: {
    hook: async (name, fn) => {
      if (name === 'context') contextHook = fn
      return registration()
    },
    synthetic: async (receipt) => {
      receipts.push(receipt)
    },
  },
})

assert.equal(commandDef.name, 'codemode')
assert.ok(contextHook, 'context hook must be registered')

const sessionID = 'session-test-1'

// Check initial status
await commandDef.execute({ sessionID, prompt: { text: 'status' } })
assert.equal(receipts.at(-1).resume, false)
assert.match(receipts.at(-1).text, /ВЫКЛЮЧЕН/)

// Context hook should not inject when off
const event1 = { sessionID, system: [] }
await contextHook(event1)
assert.equal(event1.system.length, 0)

// Turn on
await commandDef.execute({ sessionID, prompt: { text: 'on' } })
assert.equal(receipts.at(-1).resume, false)
assert.match(receipts.at(-1).text, /ВКЛЮЧЁН/)
assert.equal(storageData.get(`codemode:session:${sessionID}`), true)

// Context hook should inject when on
const event2 = { sessionID, system: [{ type: 'text', text: 'Base prompt' }] }
await contextHook(event2)
assert.equal(event2.system.length, 2)
assert.equal(event2.system[1].text, CODEMODE_POLICY)

// Duplicate context run must not inject twice
await contextHook(event2)
assert.equal(event2.system.length, 2)

// Toggle (should turn off)
await commandDef.execute({ sessionID, prompt: { text: 'toggle' } })
assert.equal(receipts.at(-1).resume, false)
assert.match(receipts.at(-1).text, /ВЫКЛЮЧЕН/)
assert.equal(storageData.has(`codemode:session:${sessionID}`), false)

const event3 = { sessionID, system: [] }
await contextHook(event3)
assert.equal(event3.system.length, 0)

// Toggle back on
await commandDef.execute({ sessionID, prompt: { text: '' } })
assert.equal(receipts.at(-1).resume, false)
assert.match(receipts.at(-1).text, /ВКЛЮЧЁН/)

// Turn off explicitly
await commandDef.execute({ sessionID, prompt: { text: 'off' } })
assert.equal(receipts.at(-1).resume, false)
assert.match(receipts.at(-1).text, /ВЫКЛЮЧЕН/)

// Direct task execution: /codemode optimize bundle
await commandDef.execute({ sessionID, prompt: { text: 'optimize bundle' } })
assert.equal(receipts.at(-1).resume, true)
assert.equal(receipts.at(-1).text, '[Code Mode] optimize bundle')

const event4 = { sessionID, system: [] }
await contextHook(event4)
assert.equal(event4.system.length, 1)
assert.equal(event4.system[0].text, CODEMODE_POLICY)

// Direct task execution with "on": /codemode on refactor api
await commandDef.execute({ sessionID, prompt: { text: 'on refactor api' } })
assert.equal(receipts.at(-1).resume, true)
assert.equal(receipts.at(-1).text, '[Code Mode активирован] refactor api')

// Memory limit pruning test
for (let i = 0; i < 600; i++) {
  await commandDef.execute({ sessionID: `bulk-session-${i}`, prompt: { text: 'on' } })
}

// Cleanup and verify disposal
await cleanup()
assert.equal(disposedCount, 2, 'all registrations must be disposed')

// Disabled via env flag
process.env.CODEMODE_ENABLED = '0'
let disabledRegistered = false
await plugin.setup({
  command: {
    transform: async () => {
      disabledRegistered = true
    },
  },
})
assert.equal(disabledRegistered, false, 'plugin must exit immediately when CODEMODE_ENABLED=0')
delete process.env.CODEMODE_ENABLED

console.log('Code Mode plugin regression passed: parsing, state toggle, context hook, synthetic dispatch, storage persistence, and clean disposal.')
