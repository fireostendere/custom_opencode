const ADD_TYPES = Object.freeze({
  provider: "addprovider",
  model: "addmodel",
  mcp: "addmcp",
  skill: "addskill",
  orchestration: "addorchestration",
})

const ALIASES = new Map(Object.entries(ADD_TYPES).flatMap(([kind, command]) => [
  [kind, kind],
  [command, kind],
]))

export const ADD_KINDS = Object.freeze(Object.keys(ADD_TYPES))

export function nativeAddCommand(kind) {
  return ADD_TYPES[kind] ?? null
}

function parsed(kind, argumentsText = "") {
  const command = nativeAddCommand(kind)
  return {
    type: argumentsText.trim() ? "native" : "wizard",
    kind,
    command,
    arguments: argumentsText.trim(),
  }
}

export function parseAddCommand(value) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(value ?? "").trim())
  if (!match) return null

  const token = match[1].toLowerCase()
  const argumentsText = match[2] ?? ""
  if (token === "add") {
    const addArguments = argumentsText.trim()
    if (!addArguments) return { type: "error", message: "Use /add provider|model|mcp|skill|orchestration" }
    const typeMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(addArguments)
    const kind = ALIASES.get(typeMatch?.[1]?.toLowerCase())
    if (!kind) return { type: "error", message: "Unknown add type: provider, model, mcp, skill or orchestration" }
    return parsed(kind, typeMatch[2] ?? "")
  }

  const kind = ALIASES.get(token)
  return kind ? parsed(kind, argumentsText) : null
}
