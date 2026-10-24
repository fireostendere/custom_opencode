/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { installLocationRecovery } from "./lib/location-recovery.js"

export default Plugin.define({
  id: "custom.location-recovery",
  setup(context) {
    const [state, setState] = createSignal()
    const recovery = installLocationRecovery(context, setState)
    const unwatch = context.ui.slot({
      append: "app",
      render: () => {
        createEffect(recovery.cancelStale)
        return null
      },
    })
    const unslot = context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => (
        <Show when={state()?.sessionID === sessionID ? state() : undefined}>
          {value => (
            <box id="custom.location-recovery" border={["left"]} borderColor={context.theme.text.feedback.warning.base}
              paddingLeft={2} paddingY={1} gap={1} flexShrink={0}>
              <text fg={context.theme.text.base}>△ Session location unavailable</text>
              <text fg={context.theme.text.muted} wrapMode="word">{value().directory}</text>
              <text fg={context.theme.text.base}>
                {value().checking ? "Проверяю доступность…" : "Повторная проверка через 15 секунд"}
                {` (${value().attempt}/5)`}
              </text>
              <text fg={context.theme.text.action.secondary.base}
                onMouseUp={() => context.keymap.dispatch("session.move")}>
                Choose directory (/move)
              </text>
            </box>
          )}
        </Show>
      ),
    })
    return () => { unwatch(); unslot(); recovery.dispose() }
  },
})
