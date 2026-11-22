#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createAdaptivePoller, createRefreshCoalescer } from '../app/refresh-coalescer.js'

const calls = []
let releaseFirst
const first = new Promise((resolve) => { releaseFirst = resolve })
const oldRefresh = async (force) => {
  calls.push(['old', force])
  await first
}
const coalesce = createRefreshCoalescer()
const active = coalesce(oldRefresh, false)
assert.strictEqual(coalesce(oldRefresh, false), active, 'ordinary overlap must share the request')
let releaseReplay
const replay = new Promise((resolve) => { releaseReplay = resolve })
const latestRefresh = async (force) => { calls.push(['latest', force]); await replay }
assert.strictEqual(coalesce(latestRefresh, true), active, 'forced overlap must share the active request')
assert.deepEqual(calls, [['old', false]], 'only one request may start while in flight')
releaseFirst()
let settled = false
active.finally(() => { settled = true })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(settled, false, 'the shared promise must include the forced replay')
releaseReplay()
await active
assert.deepEqual(calls, [['old', false], ['latest', true]], 'a forced session change replays the latest refresh once')

let recover
const failedThenForced = createRefreshCoalescer()
const failed = failedThenForced(async () => { await new Promise((resolve) => { recover = resolve }); throw new Error('stale failure') })
failedThenForced(async () => 'fresh result', true)
recover()
assert.equal(await failed, 'fresh result', 'a successful forced replay supersedes a stale failure')

const timers = []
let activeRun = false
let pollCalls = 0
let releasePoll
const pendingPoll = new Promise((resolve) => { releasePoll = resolve })
const poller = createAdaptivePoller({
  run: async () => { pollCalls += 1; if (pollCalls === 1) await pendingPoll },
  isActive: () => activeRun,
  activeDelay: 5,
  idleDelay: 15,
  setTimeoutFn: (callback, delay) => { const timer = { callback, delay, cleared:false }; timers.push(timer); return timer },
  clearTimeoutFn: (timer) => { timer.cleared = true },
})
poller.start()
const initialTimer = timers.shift()
assert.equal(initialTimer.delay, 0, 'poller starts promptly')
const firstTick = initialTimer.callback()
assert.equal(pollCalls, 1, 'the first poll starts once')
assert.equal(timers.length, 0, 'the next poll is not scheduled while work is in flight')
poller.stop()
poller.start()
assert.equal(timers.length, 0, 'restarting during an active poll must not create a second timer chain')
poller.reschedule()
assert.equal(timers.length, 0, 'rescheduling during an active poll must not request an immediate follow-up')
poller.wake()
assert.equal(timers.length, 0, 'a lifecycle wake waits for the in-flight poll')
releasePoll()
await firstTick
const wakeTimer = timers.shift()
assert.equal(wakeTimer.delay, 0, 'a lifecycle wake runs immediately after the active poll')
await wakeTimer.callback()
const idleTimer = timers.shift()
assert.equal(idleTimer.delay, 15, 'idle polling backs off')
activeRun = true
await idleTimer.callback()
const activeTimer = timers.shift()
assert.equal(activeTimer.delay, 5, 'active polling remains responsive')
poller.stop()
assert.equal(activeTimer.cleared, true, 'stopping cancels the scheduled poll')
poller.start({ immediate:false })
assert.equal(timers.pop().delay, 5, 'already loaded screens wait before polling again')
poller.stop()
console.log('refresh coalescing regression: ok')
