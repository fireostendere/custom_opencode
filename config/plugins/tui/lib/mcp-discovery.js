// Request-local schema discovery. Execution stays on the native tool path,
// preserving its validation, permission prompts and execute hooks.
export class McpDiscovery {
  constructor({ maxTools = 8, maxSchemaBytes = 12000 } = {}) {
    this.sessions = new Map()
    this.maxTools = maxTools
    this.maxSchemaBytes = maxSchemaBytes
  }

  update(sessionID, tools, report) {
    const definitions = Object.fromEntries(report.exposed.map((name) => [name, tools[name]]))
    const before = JSON.stringify(definitions).length
    const lazy = report.exposed.length > this.maxTools || before > this.maxSchemaBytes
    const previous = this.sessions.get(sessionID)
    const selected = new Set(
      [...(previous?.selected || [])].filter((name) => Object.hasOwn(definitions, name)),
    )
    this.sessions.set(sessionID, { definitions, selected, profile: report.id })
    if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value)
    if (lazy) for (const name of report.exposed) if (!selected.has(name)) delete tools[name]
    const visible = report.exposed.filter((name) => Object.hasOwn(tools, name))
    return {
      ...report,
      exposed: visible,
      deferred: report.exposed.filter((name) => !Object.hasOwn(tools, name)),
      schemaCharactersBefore: before,
      schemaCharactersAfter: JSON.stringify(
        Object.fromEntries(visible.map((name) => [name, tools[name]])),
      ).length,
    }
  }

  discover(sessionID, { query = "", limit = 6 } = {}) {
    const state = this.sessions.get(sessionID)
    if (!state) throw new Error("No current MCP profile snapshot; retry on the next model step.")
    const terms = String(query)
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter(Boolean)
    const matches = Object.entries(state.definitions)
      .map(([name, definition]) => {
        const hay = `${name} ${definition.description || ""}`.toLocaleLowerCase()
        const score = terms.reduce(
          (sum, term) =>
            sum + (name.toLocaleLowerCase() === term ? 10 : hay.includes(term) ? 1 : 0),
          0,
        )
        return { name, description: String(definition.description || "").slice(0, 240), score }
      })
      .filter((row) => !terms.length || row.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    const selected = matches.slice(0, Math.max(1, Math.min(this.maxTools, Number(limit) || 6)))
    // Replace the working set rather than growing the full catalog over time.
    state.selected = new Set(selected.map((row) => row.name))
    return {
      profile: state.profile,
      tools: selected.map(({ score, ...row }) => row),
      totalMatches: matches.length,
      availableNextStep: true,
      message:
        "Selected native tools and their input schemas are available on the next model step. Permissions are unchanged.",
    }
  }

  clear() {
    this.sessions.clear()
  }
}
