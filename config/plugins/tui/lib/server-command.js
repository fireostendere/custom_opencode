export const SERVER_COMMAND = "server"

export function parseServerCommand(value) {
  const match = /^\/server(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim())
  if (!match) return null
  const argument = String(match[1] ?? "").trim().toLowerCase()
  if (!argument) return { type: "wizard" }
  if (argument === "status") return { type: "status" }
  return { type: "error", message: "Use /server or /server status" }
}
