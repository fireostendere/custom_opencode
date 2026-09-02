/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { PANEL_SIDES, PANEL_VIEWS, parsePanelCommand, panelCommandID } from "./lib/panel-command.js"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"

const SIDE_TITLE = { left: "Left", right: "Right", top: "Top", bottom: "Bottom" }
// Concrete generated slash examples: panel left, panel right, panel top, panel bottom.

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

function warn(context, message) {
  context.ui.toast?.({ variant: "warning", message })
}

// `slashName` powers autocomplete. Manually typed `/panel ...` is routed locally
// by a version-compatible pre-submit adapter so it never reaches the model.
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
        run: () => context.keymap.dispatch(target),
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

    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor = context.renderer?.currentFocusedEditor
      const parsed = parsePanelCommand(promptText(editor))
      if (!parsed) return false

      if (parsed.type === "error") {
        warn(context, `Panel: ${parsed.message}`)
        return true
      }

      const target = panelCommandID(parsed)
      if (!target) {
        warn(context, "Panel: command is not available")
        return true
      }

      clearPromptEditor(editor)
      context.keymap.dispatch(target)
      return true
    })

    if (submitRouter.transport === "none") {
      warn(context, "Panel: this OpenCode build has no local submit interception API")
    }

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
      submitRouter.dispose?.()
      unApp?.()
    }
  },
})
