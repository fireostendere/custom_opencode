// Runs at most one refresh at a time. A forced update that arrives while it is
// running is replayed once after it completes, so lifecycle updates are not lost.
export function createRefreshCoalescer() {
  let inFlight = null
  let queuedRefresh = null
  const run = (refresh, force = false) => {
    if (inFlight) {
      if (force) queuedRefresh = refresh
      return inFlight
    }
    inFlight = (async () => {
      let current = { refresh, force }
      let result
      let failure
      try {
        while (current) {
          try { result = await current.refresh(current.force); failure = null }
          catch (error) { failure = error }
          const replay = queuedRefresh
          queuedRefresh = null
          current = replay ? { refresh:replay, force:true } : null
        }
        if (failure) throw failure
        return result
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }
  return run
}

// Schedules the next poll only after the previous one settles. Callers keep
// lifecycle refreshes immediate by invoking their coalesced refresh directly.
export function createAdaptivePoller({ run, isActive, activeDelay, idleDelay, isVisible = () => true, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let timer = null
  let stopped = true
  let polling = false
  let wakeRequested = false
  const schedule = (delay) => {
    if (stopped) return
    timer = setTimeoutFn(tick, delay)
  }
  const tick = async () => {
    timer = null
    if (stopped || polling) return
    polling = true
    try {
      if (isVisible()) await run()
    } catch {} finally {
      polling = false
    }
    if (wakeRequested) {
      wakeRequested = false
      schedule(0)
    } else {
      schedule(isVisible() && isActive() ? activeDelay : idleDelay)
    }
  }
  return {
    start() { if (stopped) { stopped = false; if (polling) wakeRequested = true; else schedule(0) } },
    stop() { stopped = true; wakeRequested = false; if (timer !== null) clearTimeoutFn(timer); timer = null },
    reschedule() {
      if (stopped || polling) return
      if (timer !== null) clearTimeoutFn(timer)
      schedule(isActive() ? activeDelay : idleDelay)
    },
    wake() {
      if (stopped) return
      if (polling) { wakeRequested = true; return }
      if (timer !== null) clearTimeoutFn(timer)
      schedule(0)
    },
  }
}
