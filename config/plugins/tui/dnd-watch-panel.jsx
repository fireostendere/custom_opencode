/** @jsxImportSource @opentui/solid */
/**
 * D&D table watcher block in the native session sidebar, next to context and
 * MCP status. It appears only for narrator sessions of the table project and
 * reads the status file of the dnd-watch server plugin: what the watcher is
 * doing now, the push link to ODM, and its last few actions.
 *
 * The sidebar re-renders whenever a signal it reads changes, so the status
 * signal is equality-checked and the clock only ticks while a countdown or a
 * turn timer is on screen.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { describeWatch, isTableSession, sameWatchStates, watchWatchStates } from "./lib/dnd-watch-view.js"

export default Plugin.define({
  id: "custom.dnd-watch-panel",
  setup(context) {
    const theme = context.theme
    const [states, setStates] = createSignal(new Map(), { equals: sameWatchStates })
    const [now, setNow] = createSignal(Date.now())
    let ticking = false
    const stopWatching = watchWatchStates((next) => setStates(next))
    const clock = setInterval(() => {
      if (ticking) setNow(Date.now())
    }, 1000)
    clock.unref?.()
    const toneColor = (tone) =>
      tone === "ok"
        ? theme.text.feedback.success.default
        : tone === "busy"
          ? theme.text.status.running
          : tone === "warn"
            ? theme.text.feedback.warning.default
            : theme.text.subdued

    const unslot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID } = {}) => {
        if (!sessionID) return null
        const snapshot = states().get(sessionID)
        let session
        try {
          session = context.data.session.get(sessionID)
        } catch {}
        if (!isTableSession(session, snapshot)) return null
        const view = describeWatch(snapshot, now())
        ticking = view.ticking
        return (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.text.default}><b>🎲 Вотчер стола</b></text>
            <text fg={toneColor(view.tone)} wrapMode="word"><span>{view.headline}</span></text>
            <For each={view.rows}>
              {([label, value]) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={theme.text.subdued}><span>{label}</span></text>
                  <text fg={theme.text.default} wrapMode="word"><span>{value}</span></text>
                </box>
              )}
            </For>
            <Show when={view.hint}>
              <text fg={theme.text.subdued} wrapMode="word"><span>{view.hint}</span></text>
            </Show>
            <Show when={view.log.length > 0}>
              <text fg={theme.text.subdued}><span>Последнее</span></text>
              <For each={view.log}>
                {(line) => <text fg={theme.text.subdued} wrapMode="word"><span>{line}</span></text>}
              </For>
            </Show>
          </box>
        )
      },
    })

    return () => {
      stopWatching()
      clearInterval(clock)
      unslot()
    }
  },
})
