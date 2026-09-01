/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { PANEL_SIDES, PANEL_VIEWS, parsePanelCommand, panelCommandID } from "./lib/panel-command.js"

const SIDE_TITLE = { left: "Left", right: "Right", top: "Top", bottom: "Bottom" }

function isOpenCodePrompt(editor) {
  if (!editor || editor.isDestroyed) return false
  const traits = editor.traits ?? {}
  return traits.owner === "opencode" && traits.role === "prompt" && traits.status !== "SHELL"
}

function promptText(editor) {
  if (!isOpenCodePrompt(editor)) return ""
  if (typeof editor.plainText === "string") return editor.plainText
  if (typeof editor.getText === "function") return String(editor.getText() ?? "")
  return ""
}

function clearPromptEditor(editor) {
  if (!editor || editor.isDestroyed) return
  if (typeof editor.clear === "function") editor.clear()
  else if (typeof editor.setText === "function") editor.setText("")
  editor.extmarks?.clear?.()
  editor.gotoBufferEnd?.()
}

function isPlainSubmit(event) {
  if (!event || event.eventType === "release") return false
  if (event.name !== "return" && event.name !== "enter" && event.name !== "kpenter") return false
  return !event.ctrl && !event.meta && !event.alt && !event.option && !event.super && !event.hyper && !event.shift
}

function warn(context, message) {
  context.ui.toast({ variant: "warning", message })
}

// `slashName` is useful for autocomplete, but manually typed TUI-plugin slashes
// are not executed by OpenCode's Prompt.submit(). Therefore `/panel ...` also
// has a pre-dispatch key intercept below. It consumes only a /panel command from
// an OpenCode prompt before the event reaches either prompt.submit or
// TextareaRenderable.onSubmit. Shell mode and every ordinary prompt fall through.
export default Plugin.define({
  id: "custom.panel-slash",
  setup(context) {
    function row(id, slashName, title, target) {
      return {
        id,
        title,
        group: "Панели",
        palette: true,
        slash: { name: slashName },
        run: () => context.keymap.dispatchCommand?.(target),
      }
    }

    const commands = [
      row("custom.panel-slash.configure", "panel", "Panels: configure", "custom.panels.configure"),
      row("custom.panel-slash.reset", "panel reset", "Panels: reset layout", "custom.panels.reset"),
    ]

    for (const side of PANEL_SIDES) {
      const sideTitle = SIDE_TITLE[side]
      commands.push(
        row(`custom.panel-slash.${side}.show`, `panel ${side}`, `${sideTitle} panel`, `custom.panels.${side}.show`),
        row(`custom.panel-slash.${side}.off`, `panel ${side} off`, `${sideTitle} panel: off`, `custom.panels.${side}.disable`),
        row(`custom.panel-slash.${side}.pin`, `panel ${side} pin`, `${sideTitle} panel: pin`, `custom.panels.${side}.pin`),
        row(`custom.panel-slash.${side}.unpin`, `panel ${side} unpin`, `${sideTitle} panel: overlay`, `custom.panels.${side}.unpin`),
        row(`custom.panel-slash.${side}.collapse`, `panel ${side} collapse`, `${sideTitle} panel: collapse`, `custom.panels.${side}.collapse`),
        row(`custom.panel-slash.${side}.expand`, `panel ${side} expand`, `${sideTitle} panel: expand`, `custom.panels.${side}.expand`),
        row(`custom.panel-slash.${side}.end`, `panel ${side} end`, `${sideTitle} panel: jump to end`, `custom.panels.${side}.end`),
      )
      for (const view of PANEL_VIEWS) {
        commands.push(
          row(
            `custom.panel-slash.${side}.${view}`,
            `panel ${side} ${view}`,
            `${sideTitle} panel: ${view}`,
            `custom.panels.${side}.view.${view}`,
          ),
        )
      }
    }

    // OpenTUI's keymap host prepends its keypress listener to the renderer.
    // consume() prevents default and stops propagation, so the Textarea's own
    // submit listener cannot race this local command into the model pipeline.
    const unIntercept = context.keymap.intercept(
      "key",
      ({ event, consume }) => {
        if (!isPlainSubmit(event)) return

        const editor = context.renderer?.currentFocusedEditor
        const parsed = parsePanelCommand(promptText(editor))
        if (!parsed) return

        consume()
        if (parsed.type === "error") {
          warn(context, `Panel: ${parsed.message}`)
          return
        }

        const target = panelCommandID(parsed)
        if (!target) {
          warn(context, "Panel: command is not available")
          return
        }

        clearPromptEditor(editor)
        const result = context.keymap.dispatchCommand?.(target)
        if (result && result.ok === false) {
          warn(context, `Panel: ${result.reason ?? "command is inactive"}`)
        }
      },
      { priority: 10_000 },
    )

    const unApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 130,
          commands,
        }))
        return null
      },
    })

    return () => {
      unIntercept?.()
      unApp?.()
    }
  },
})
