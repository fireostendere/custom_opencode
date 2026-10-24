// Keep the native location sync pending while recovering. The native provider
// clears its error on entry and only shows its final recovery card on rejection.
export function installLocationRecovery(context, onChange) {
  const location = context.data.location
  const original = location.sync
  let active
  let disposed = false

  function current() {
    const route = context.ui.router?.current?.()
    if (route?.type !== "session") return
    let session
    try { session = context.data.session.get(route.sessionID) } catch { return }
    const ref = session?.location
    if (ref) return { sessionID: route.sessionID, ...ref }
  }
  function matches(a, b) {
    return a && b && a.sessionID === b.sessionID &&
      a.directory === b.directory && a.workspaceID === b.workspaceID
  }
  function cancel() {
    if (!active) return
    const run = active
    active = undefined
    clearTimeout(run.timer)
    run.wake?.()
    onChange(undefined)
  }
  function cancelStale() {
    const target = current() // Read reactively even before the first failure.
    if (active && !matches(active.target, target)) cancel()
  }
  async function chooseDirectory() {
    const target = current()
    if (disposed || !target) return
    const directory = await context.ui.dialog.prompt({
      title: "Choose directory",
      description: "Введите путь к существующей папке, чтобы продолжить эту сессию.",
      placeholder: "Directory path",
      value: target.directory,
    })
    if (!directory?.trim() || disposed || !matches(target, current())) return
    try {
      // The native worktree picker queries the unavailable source directory.
      await context.client.session.move({ sessionID: target.sessionID, directory: directory.trim() })
    } catch (error) {
      context.ui.toast.show({ title: "Failed to move session", message: error.message ?? String(error), variant: "error" })
    }
  }
  function sync(ref) {
    const target = current()
    const resolved = ref ?? location.default()
    if (disposed || !target || !matches(target, { ...resolved, sessionID: target.sessionID })) {
      return original.call(location, ref)
    }
    if (active && !active.exhausted && matches(active.target, target)) return active.promise
    cancel()
    const run = { target }
    active = run
    const live = () => !disposed && active === run && matches(target, current())
    run.promise = (async () => {
      try {
        let cause
        try { return await original.call(location, ref) }
        catch (error) { cause = error }
        for (let attempt = 1; attempt <= 5 && live(); attempt++) {
          onChange({ ...target, attempt, checking: false })
          await new Promise(resolve => {
            run.wake = resolve
            run.timer = setTimeout(resolve, 15_000)
          })
          run.wake = undefined
          run.timer = undefined
          if (!live()) break
          onChange({ ...target, attempt, checking: true })
          try {
            location.invalidate?.(ref)
            return await original.call(location, ref)
          } catch (error) { cause = error }
        }
        if (live()) {
          run.exhausted = true
          onChange({ ...target, attempt: 5, checking: false, exhausted: true })
        }
        throw cause
      } finally {
        if (active === run && !run.exhausted) {
          active = undefined
          onChange(undefined)
        }
      }
    })()
    return run.promise
  }
  location.sync = sync
  return {
    cancelStale,
    chooseDirectory,
    dispose() {
      disposed = true
      cancel()
      if (location.sync === sync) location.sync = original
    },
  }
}
