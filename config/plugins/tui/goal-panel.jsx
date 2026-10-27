/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { GoalRpc, describeGoal, watchGoal } from "./lib/goal-view.js"

const excerpt = value => value.length > 240 ? value.slice(0, 240) + "…" : value

export default Plugin.define({
  id: "custom.goal-panel",
  setup(context) {
    const [goal, setGoal] = createSignal(null)
    const rpc = context.client.rpc(GoalRpc)
    const watcher = watchGoal({
      read: (sessionID, directory) => rpc.get({ sessionID }, { location: { directory } }),
      onChange: value => setGoal(value),
    })
    const current = () => {
      const route = context.ui.router.current()
      if (route?.type !== "session") return null
      let session
      try { session = context.data.session.get(route.sessionID) } catch { return null }
      return { sessionID: route.sessionID, directory: session?.location?.directory }
    }
    createEffect(() => {
      const target = current()
      watcher.setSession(target?.sessionID, target?.directory)
    })
    const unsubscribe = rpc.events.on("updated", event => {
      const target = current()
      if (event.data.sessionID === target?.sessionID && event.location?.directory === target.directory) void watcher.refresh()
    })
    const showDetails = () => {
      const view = describeGoal(goal())
      if (view) return context.ui.dialog.alert({ title: view.headline, message: `${view.objective}\n\n${view.summary}\n\nПродолжений: ${view.turns}\n${view.hint}` })
    }
    context.keymap.layer(() => ({ commands: [{
      id: "custom.goal.details", title: "Цель: показать состояние", palette: true,
      enabled: () => Boolean(goal()), run: showDetails,
    }] }))
    const unslot = context.ui.slot({
      append: "session.composer.top",
      render: () => {
        const view = describeGoal(goal())
        if (!view) return null
        const theme = context.theme
        const color = view.tone === "busy" ? theme.text.formfield.selected : view.tone === "ok" ? theme.text.feedback.success.base : theme.text.feedback.warning.base
        return (
          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} onMouseDown={showDetails}>
            <text fg={color}><b>{view.headline}</b> · продолжений: {view.turns}</text>
            <text fg={theme.text.base} wrapMode="word">{excerpt(view.objective)}</text>
            <Show when={view.summary}><text fg={theme.text.muted} wrapMode="word">{excerpt(view.summary)}</text></Show>
            <text fg={theme.text.muted} wrapMode="word">{view.hint} · клик — подробнее</text>
          </box>
        )
      },
    })
    return () => { unsubscribe(); watcher.stop(); unslot() }
  },
})
