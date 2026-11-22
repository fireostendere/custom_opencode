import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { installLocationRecovery } from '../config/plugins/tui/lib/location-recovery.js'

mock.timers.enable({ apis: ['setTimeout'] })
const flush = () => new Promise(resolve => setImmediate(resolve))
async function tick(ms) { mock.timers.tick(ms); await flush() }

function fixture(failures = 1) {
  const ref = { directory: '/project', workspaceID: 'w1' }
  let route = { type: 'session', sessionID: 's1' }
  let state, nativeError, attempts = 0, hold
  const requests = [], invalidated = [], moves = [], prompts = [], toasts = []
  const error = new Error('Location unavailable')
  const context = {
    ui: {
      router: { current: () => route },
      dialog: { prompt: async options => { prompts.push(options); return '/recovered' } },
      toast: { show: value => toasts.push(value) },
    },
    client: { session: { move: async input => { moves.push(input) } } },
    data: {
      session: { get: () => ({ location: ref }) },
      location: {
        default: () => ({ ...ref }),
        invalidate: value => invalidated.push(value),
        async sync(value) {
          requests.push(value)
          attempts++
          if (hold) await hold
          if (attempts <= failures) throw error
          return 'ready'
        },
      },
    },
  }
  const original = context.data.location.sync
  const recovery = installLocationRecovery(context, value => { state = value })
  return {
    context, ref, requests, invalidated, moves, prompts, toasts, recovery, original, error,
    get state() { return state },
    get nativeError() { return nativeError },
    hold(value) { hold = value },
    navigate(value) { route = value; recovery.cancelStale() },
    // Same rejection contract as the native LocationProvider.
    start(value = ref) {
      nativeError = undefined
      return context.data.location.sync(value).catch(error => { nativeError = error })
    },
  }
}

try {
  const healthy = fixture(0)
  assert.equal(await healthy.start(), 'ready')
  await tick(90_000)
  assert.equal(healthy.requests.length, 1, 'Healthy locations must never be polled')
  assert.equal(healthy.state, undefined)
  healthy.recovery.dispose()

  const recovered = fixture(2)
  const waiting = recovered.start()
  await flush()
  assert.equal(recovered.state.attempt, 1)
  assert.equal(recovered.nativeError, undefined, 'Do not leave a rejected native error behind during retries')
  await tick(14_999)
  assert.equal(recovered.requests.length, 1)
  await tick(1)
  assert.equal(recovered.requests.length, 2, 'First recheck is exactly 15 seconds after failure')
  assert.equal(recovered.state.attempt, 2)
  await tick(15_000)
  assert.equal(await waiting, 'ready')
  assert.equal(recovered.requests.length, 3)
  assert.equal(recovered.invalidated.length, 2, 'Retry must invalidate cached location data')
  assert.equal(recovered.state, undefined, 'Success must remove the warning')
  assert.equal(recovered.nativeError, undefined)
  await tick(90_000)
  assert.equal(recovered.requests.length, 3, 'Success stops all further retries')
  recovered.recovery.dispose()

  const manual = fixture(Infinity)
  const manualSync = manual.start()
  await flush()
  await manual.recovery.chooseDirectory()
  assert.equal(manual.prompts[0].value, '/project')
  assert.deepEqual(manual.moves, [{ sessionID: 's1', directory: '/recovered' }],
    'Move must work while location sync is failing, without looking up source worktrees')
  manual.ref.directory = '/recovered'
  manual.recovery.cancelStale()
  await manualSync
  await tick(90_000)
  assert.equal(manual.requests.length, 1, 'Moving cancels retries for the old location')
  manual.recovery.dispose()

  for (const answer of [undefined, '', '   ']) {
    const cancelled = fixture(Infinity)
    cancelled.context.ui.dialog.prompt = async () => answer
    await cancelled.recovery.chooseDirectory()
    assert.equal(cancelled.moves.length, 0, 'Cancelled or empty paths cannot move the session')
    cancelled.recovery.dispose()
  }

  for (const change of [
    f => f.navigate({ type: 'session', sessionID: 's2' }),
    f => { f.ref.directory = '/elsewhere' },
    f => { f.ref.workspaceID = 'w2' },
    f => f.recovery.dispose(),
  ]) {
    const changed = fixture(Infinity)
    let answer
    changed.context.ui.dialog.prompt = () => new Promise(resolve => { answer = resolve })
    const moving = changed.recovery.chooseDirectory()
    change(changed)
    answer('/recovered')
    await moving
    assert.equal(changed.moves.length, 0, 'An open dialog cannot move a stale or disposed session')
    changed.recovery.dispose()
  }

  const refused = fixture(Infinity)
  const refusedSync = refused.start()
  await flush()
  refused.context.client.session.move = async () => { throw new Error('Directory does not exist') }
  await refused.recovery.chooseDirectory()
  assert.equal(refused.toasts[0].message, 'Directory does not exist')
  assert.equal(refused.state.attempt, 1, 'A failed manual move must leave automatic recovery running')
  refused.context.client.session.move = async input => { refused.moves.push(input) }
  refused.context.ui.dialog.prompt = async () => '  /valid directory  '
  await refused.recovery.chooseDirectory()
  assert.equal(refused.moves[0].directory, '/valid directory', 'Trim only surrounding whitespace')
  refused.recovery.dispose()
  await refusedSync

  const exhausted = fixture(Infinity)
  const failed = exhausted.start()
  await flush()
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(exhausted.state.attempt, attempt)
    await tick(15_000)
  }
  await failed
  assert.equal(exhausted.requests.length, 6, 'Initial request plus exactly five rechecks')
  assert.equal(exhausted.state.exhausted, true, 'Keep the manual move available alongside the native recovery card')
  assert.equal(exhausted.nativeError, exhausted.error)
  await tick(90_000)
  assert.equal(exhausted.requests.length, 6)
  await exhausted.recovery.chooseDirectory()
  assert.equal(exhausted.moves[0].directory, '/recovered', 'Manual move remains available after all retries')
  exhausted.navigate({ type: 'home' })
  assert.equal(exhausted.state, undefined, 'Leaving a failed session clears the final recovery action')
  exhausted.recovery.dispose()

  const reconnected = fixture(6)
  const beforeReconnect = reconnected.start()
  await flush()
  for (let attempt = 1; attempt <= 5; attempt++) await tick(15_000)
  await beforeReconnect
  assert.equal(await reconnected.start(), 'ready', 'A fresh sync can recover after exhaustion')
  assert.equal(reconnected.state, undefined)
  reconnected.recovery.dispose()

  const slow = fixture(1)
  const first = slow.context.data.location.sync()
  assert.equal(slow.context.data.location.sync({ ...slow.ref }), first, 'Concurrent callers must share retries')
  await flush()
  let release
  slow.hold(new Promise(resolve => { release = resolve }))
  await tick(15_000)
  assert.equal(slow.state.checking, true)
  await tick(90_000)
  assert.equal(slow.requests.length, 2, 'Never overlap slow requests')
  release()
  assert.equal(await first, 'ready')
  assert.deepEqual(slow.requests, [undefined, undefined], 'Preserve native default-location semantics')
  slow.recovery.dispose()

  const stale = fixture(1)
  const oldSync = stale.start()
  await flush()
  let finishOld
  stale.hold(new Promise(resolve => { finishOld = resolve }))
  await tick(15_000)
  stale.navigate({ type: 'session', sessionID: 's2' })
  stale.hold(undefined)
  assert.equal(await stale.start(), 'ready')
  finishOld()
  await oldSync
  await tick(90_000)
  assert.equal(stale.requests.length, 3, 'Completion from a previous session cannot schedule more work')
  assert.equal(stale.state, undefined)
  stale.recovery.dispose()

  for (const destination of [{ type: 'home' }, { type: 'session', sessionID: 's2' }]) {
    const switched = fixture(Infinity)
    const cancelled = switched.start()
    await flush()
    switched.navigate(destination)
    await cancelled
    await tick(90_000)
    assert.equal(switched.requests.length, 1, 'Leaving a session cancels its waiting retry, even in the same directory')
    assert.equal(switched.state, undefined)
    switched.recovery.dispose()
  }

  const moved = fixture(Infinity)
  const previous = moved.start()
  await flush()
  moved.ref.workspaceID = 'w2'
  moved.recovery.cancelStale()
  await previous
  await tick(90_000)
  assert.equal(moved.requests.length, 1, 'Moving to a different workspace cancels old retries')
  moved.recovery.dispose()

  const disposed = fixture(Infinity)
  const abandoned = disposed.start()
  await flush()
  disposed.recovery.dispose()
  await abandoned
  await tick(90_000)
  assert.equal(disposed.requests.length, 1)
  assert.equal(disposed.context.data.location.sync, disposed.original, 'Hot reload restores the original sync')

  const unrelated = fixture(Infinity)
  const other = { directory: '/other', workspaceID: 'remote' }
  await assert.rejects(unrelated.context.data.location.sync(other), unrelated.error)
  await tick(90_000)
  assert.equal(unrelated.requests.length, 1, 'Do not retry background syncs for other locations')
  assert.equal(unrelated.state, undefined)
  unrelated.recovery.dispose()
} finally {
  mock.timers.reset()
}
console.log('Location recovery: 15s × 5, manual move, cancellation, stale dialogs, server errors, success, exhaustion, coalescing, slow requests, navigation, workspace change and cleanup passed')
