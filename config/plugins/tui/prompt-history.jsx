/** @jsxImportSource @opentui/solid */
/**
 * Keep prompt history scoped to the active TUI session and intercept local
 * /panel commands before they can be submitted to the model.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { parsePanelCommand, panelCommandID } from "./lib/panel-command.js"

function currentRoute(context) {
  const current = context.ui.router.current
  return typeof current === "function" ? current() : current
}

function currentSessionID(context, promptSessionID = "") {
  const route = currentRoute(context)
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

    function activePanelPrompt() {
      const route = currentRoute(context)
      const type = route?.type ?? route?.name
      if (type === "session") {
        const ref = promptRef
        if (!ref?.focused || ref.current?.mode === "shell") return null
        return {
          text: () => ref.current?.input ?? "",
          clear: () => ref.reset(),
        }
      }

      // Home uses a separate native prompt slot. Do not replace it just to
      // capture a ref: use the currently focused TextareaRenderable instead,
      // preserving native placeholders and home_prompt_right content.
      if (type === "home") {
        const editor = context.renderer?.currentFocusedEditor
        if (!editor || typeof editor.getText !== "function" || typeof editor.setText !== "function") return null
        return {
          text: () => editor.getText(),
          clear: () => {
            editor.setText("")
            if (typeof editor.gotoBufferEnd === "function") editor.gotoBufferEnd()
          },
        }
      }
      return null
    }

    function runPanelSlash() {
      const prompt = activePanelPrompt()
      if (!prompt) return false
      const parsed = parsePanelCommand(prompt.text())
      if (!parsed) return false
      if (parsed.type === "error") {
        context.ui.toast.show({
          message: `Panel: ${parsed.message}`,
          variant: "warning",
        })
        return true
      }
      const command = panelCommandID(parsed)
      if (!command) return false
      prompt.clear()
      context.keymap.dispatchCommand?.(command)
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
          priority: 1100,
          commands: [
            {
              id: "custom.panels.inline-submit",
              title: "Локальная команда /panel",
              group: "Панели",
              bind: "enter",
              palette: false,
              run: runPanelSlash,
            },
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
