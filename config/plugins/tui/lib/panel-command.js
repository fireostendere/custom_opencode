export const PANEL_SIDES = ["left", "right", "top", "bottom"]
export const PANEL_VIEWS = ["session", "activity", "plan", "orchestration", "history", "limits"]

const SIDE_ALIASES = new Map([
  ["left", "left"], ["l", "left"], ["лево", "left"], ["слева", "left"],
  ["right", "right"], ["r", "right"], ["право", "right"], ["справа", "right"],
  ["top", "top"], ["t", "top"], ["верх", "top"], ["сверху", "top"],
  ["bottom", "bottom"], ["b", "bottom"], ["низ", "bottom"], ["снизу", "bottom"],
])

const VIEW_ALIASES = new Map([
  ["session", "session"], ["сессия", "session"],
  ["activity", "activity"], ["active", "activity"], ["активность", "activity"],
  ["plan", "plan"], ["план", "plan"],
  ["orchestration", "orchestration"], ["orch", "orchestration"], ["оркестрация", "orchestration"], ["орк", "orchestration"],
  ["history", "history"], ["история", "history"],
  ["limits", "limits"], ["лимиты", "limits"],
])

export function parsePanelCommand(value) {
  const text = String(value ?? "").trim()
  if (!/^\/panel(?:\s|$)/i.test(text)) return null
  const tokens = text.split(/\s+/)
  tokens.shift()
  if (tokens.length === 0) return { type: "configure" }
  if (tokens[0]?.toLowerCase() === "reset") return { type: "reset" }

  const side = SIDE_ALIASES.get(tokens[0]?.toLowerCase())
  if (!side) return { type: "error", message: "side must be left, right, top, or bottom" }
  if (tokens.length === 1) return { type: "zone", side, action: "show" }

  const action = tokens[1]?.toLowerCase()
  if (["on", "show", "open", "enable"].includes(action)) return { type: "zone", side, action: "show" }
  if (["off", "hide", "close", "disable"].includes(action)) return { type: "zone", side, action: "disable" }
  if (action === "pin") return { type: "zone", side, action: "pin" }
  if (action === "unpin") return { type: "zone", side, action: "unpin" }
  if (["collapse", "fold"].includes(action)) return { type: "zone", side, action: "collapse" }
  if (["expand", "unfold"].includes(action)) return { type: "zone", side, action: "expand" }
  if (["end", "bottom", "tail"].includes(action)) return { type: "zone", side, action: "end" }

  const viewToken = action === "view" ? tokens[2]?.toLowerCase() : action
  const view = VIEW_ALIASES.get(viewToken)
  if (view) return { type: "zone", side, action: "view", view }
  return { type: "error", message: "unknown panel action or view" }
}

export function panelCommandID(command) {
  if (!command) return null
  if (command.type === "configure") return "custom.panels.configure"
  if (command.type === "reset") return "custom.panels.reset"
  if (command.type !== "zone") return null
  if (command.action === "view") return `custom.panels.${command.side}.view.${command.view}`
  return `custom.panels.${command.side}.${command.action}`
}
