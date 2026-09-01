/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { PANEL_SIDES, PANEL_VIEWS } from "./lib/panel-command.js"

const SIDE_TITLE = { left: "Left", right: "Right", top: "Top", bottom: "Bottom" }

// Examples: panel left, panel right, panel top, panel bottom.
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

    return () => unApp?.()
  },
})
