/** @jsxImportSource @opentui/solid */
/**
 * Keep prompt history scoped to the active TUI session.
 * The native prompt history is global, so its bindings are disabled in cli.json
 * and replaced with these session-local up/down commands.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

function currentSessionID(context, promptSessionID = "") {
  const current = context.ui.router.current
  const route = typeof current === "function" ? current() : current
  const type = route?.type ?? route?.name
  if (type !== "session") return ""
  return String(route?.sessionID ?? route?.params?.sessionID ?? promptSessionID ?? "")
}

function messageParts(context, message) {
  try {
    const parts = context.state.part?.(message?.id ?? message?.messageID)
    if (Array.isArray(parts) && parts.length) return parts
  } catch {}
  return message?.parts ?? message?.content ?? []
}

function messageText(context, message) {
  const parts = messageParts(context, message)
  const text = Array.isArray(parts)
    ? parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
    : ""
  return String(text || message?.text || "").trim()
}

function sessionPrompts(context, sessionID) {
  let messages = []
  try {
    messages = context.state.session.messages(sessionID) ?? []
  } catch {}
  return messages
    .filter((message) => {
      const role = message?.role ?? message?.info?.role
      return role === "user" && message?.synthetic !== true && message?.summary !== true
    })
    .map((message) => messageText(context, message))
    .filter(Boolean)
}

function setPromptText(ref, text) {
  const current = ref?.current ?? {}
  ref?.set({
    input: text,
    mode: current.mode ?? "normal",
    parts: text ? [{ type: "text", text }] : [],
  })
}

export default Plugin.define({
  id: "custom.prompt-history",
  setup(context) {
    const histories = new Map()
    let promptRef
    let promptSessionID = ""

    function historyFor(sessionID) {
      const entries = sessionPrompts(context, sessionID)
      const existing = histories.get(sessionID)
      if (!existing) {
        const created = { entries, cursor: entries.length, draft: "", value: "" }
        histories.set(sessionID, created)
        return created
      }
      existing.entries = entries
      if (existing.cursor > entries.length) existing.cursor = entries.length
      return existing
    }

    function move(direction) {
      const sessionID = currentSessionID(context, promptSessionID)
      const ref = promptRef
      if (!sessionID || promptSessionID !== sessionID || !ref?.focused || ref.current?.mode === "shell") return false

      const history = historyFor(sessionID)
      if (!history.entries.length) return false

      const current = ref.current?.input ?? ""
      if (history.cursor !== history.entries.length && current !== history.value) {
        history.cursor = history.entries.length
        history.draft = current
      }
      if (history.cursor === history.entries.length && direction < 0) history.draft = current

      const next = Math.max(0, Math.min(history.entries.length, history.cursor + direction))
      if (next === history.cursor) return true
      history.cursor = next
      const value = next === history.entries.length ? history.draft : history.entries[next]
      history.value = value
      setPromptText(ref, value)
      return true
    }

    const unprompt = context.ui.slot({
      append: "session_prompt",
      render: (props = {}) => {
        promptSessionID = String(props.sessionID ?? props.session_id ?? "")
        const Prompt = context.ui.Prompt
        if (!Prompt || !promptSessionID) return null
        return (
          <Prompt
            sessionID={promptSessionID}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit ?? props.onSubmit}
            hint={props.hint}
            right={props.right}
            showPlaceholder={props.showPlaceholder}
            placeholders={props.placeholders}
            ref={(ref) => {
              promptRef = ref
              props.ref?.(ref)
            }}
          />
        )
      },
    })

    const unkeys = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 1000,
          commands: [
            {
              id: "custom.prompt-history.previous",
              title: "Предыдущий prompt текущей сессии",
              group: "История prompt",
              bind: "up",
              palette: false,
              run: () => move(-1),
            },
            {
              id: "custom.prompt-history.next",
              title: "Следующий prompt текущей сессии",
              group: "История prompt",
              bind: "down",
              palette: false,
              run: () => move(1),
            },
          ],
        }))
        return null
      },
    })

    const unmessage = context.data.on("session.message.content.updated", (event) => {
      const sessionID = event?.sessionID
      if (sessionID) histories.delete(sessionID)
    })

    return () => {
      unprompt()
      unkeys()
      unmessage?.()
    }
  },
})
