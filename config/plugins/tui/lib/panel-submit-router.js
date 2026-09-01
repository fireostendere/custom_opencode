export function isPlainSubmit(event) {
  if (!event || event.eventType === "release") return false
  if (event.name !== "return" && event.name !== "enter" && event.name !== "kpenter") return false
  return !event.ctrl && !event.meta && !event.alt && !event.option && !event.super && !event.hyper && !event.shift
}

function stopEvent(event) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
}

/**
 * Install a pre-submit key listener without assuming one exact OpenCode beta API.
 * Returns { dispose, transport } and never throws when a transport is missing.
 */
export function installPanelSubmitRouter(context, handle) {
  const renderer = context?.renderer
  const keyInput = renderer?.keyInput

  // Stable OpenTUI transport. OpenCode's own keymap host uses the same
  // prependListener("keypress") hook, so consuming here prevents both the
  // keymap submit and TextareaRenderable.onSubmit paths.
  if (typeof keyInput?.prependListener === "function" && typeof keyInput?.off === "function") {
    const listener = (event) => {
      if (!isPlainSubmit(event)) return
      if (handle(event) !== true) return
      stopEvent(event)
    }
    keyInput.prependListener("keypress", listener)
    return {
      transport: "renderer-keyinput",
      dispose: () => keyInput.off("keypress", listener),
    }
  }

  // Newer OpenCode/OpenTUI plugin API.
  if (typeof context?.keymap?.intercept === "function") {
    const dispose = context.keymap.intercept(
      "key",
      ({ event, consume }) => {
        if (!isPlainSubmit(event)) return
        if (handle(event) !== true) return
        consume()
      },
      { priority: 10_000 },
    )
    return {
      transport: "keymap-intercept",
      dispose: typeof dispose === "function" ? dispose : () => {},
    }
  }

  // Fail open: the plugin must still load even if this OpenCode build exposes
  // neither transport. Native slash autocomplete commands remain available.
  return { transport: "none", dispose: () => {} }
}
