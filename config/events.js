export function startEvents(ctx, onEvent) {
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) continue
        // One failing handler (a storage write, a synthetic message) must not
        // end the subscription: every later event would be lost until restart.
        try {
          await onEvent(event)
        } catch (error) {
          console.warn(`[opencode-v2] event handler failed for ${event?.type ?? "event"}: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(`[opencode-v2] event subscription stopped: ${error?.message ?? error}`)
      }
    }
  })()

  return () => controller.abort()
}
