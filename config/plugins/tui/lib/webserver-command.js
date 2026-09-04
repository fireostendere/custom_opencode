export const WEB_SERVER_COMMAND = "webserver"

export function parseWebserverCommand(value) {
  const match = new RegExp(`^/${WEB_SERVER_COMMAND}(?:\\s+([\\s\\S]*))?$`, "i").exec(String(value ?? "").trim())
  if (!match) return null
  const argument = String(match[1] ?? "").trim().toLowerCase()
  if (!argument) return { type: "wizard" }
  if (argument === "status") return { type: "status" }
  return { type: "error", message: "Use /webserver or /webserver status" }
}
