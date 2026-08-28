export function startEvents(ctx, onEvent) {
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!controller.signal.aborted) await onEvent(event)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(`[opencode-v2] event subscription stopped: ${error?.message ?? error}`)
      }
    }
  })()

  return () => controller.abort()
}
