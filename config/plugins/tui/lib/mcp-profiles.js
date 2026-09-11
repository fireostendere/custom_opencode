// Pure profile policy. Durable state and native registrations belong to config-manager.
export const profileTemplates = {
  core: { name: "Core", keywords: [], agents: ["orchestrator", "main"] },
  frontend: {
    name: "Frontend",
    keywords: ["frontend", "react", "css", "browser", "ui", "интерфейс", "верстк"],
    agents: ["frontend-builder"],
  },
  backend: {
    name: "Backend",
    keywords: ["backend", "database", "sql", "api", "бэкенд"],
    agents: ["backend-builder"],
  },
  security: {
    name: "Security",
    keywords: ["security", "vulnerability", "audit", "уязвим", "безопасност"],
    agents: ["reviewer"],
  },
  embedded: {
    name: "Embedded",
    keywords: ["firmware", "embedded", "esp32", "прошивк"],
    agents: ["embedded-builder"],
  },
  "embedded-debug": {
    name: "Embedded Debug",
    keywords: ["jtag", "swd", "bringup", "отладк"],
    agents: ["hardware-debug-worker"],
    risk: "elevated",
  },
  lab: {
    name: "Lab",
    keywords: ["oscilloscope", "sigrok", "scpi", "осциллограф"],
    agents: [],
    risk: "elevated",
  },
  pcb: {
    name: "PCB",
    keywords: ["pcb", "schematic", "diptrace", "разводк", "схемотехник"],
    agents: [],
  },
}

export const mcpNamespace = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

export function resolveMcpProfile(registry, { mode = "auto", agent = "", text = "" } = {}) {
  const profiles = registry.mcpProfiles || {}
  if (mode !== "auto") return { id: mode, reason: "manual" }
  const entries = Object.values(profiles)
  const assigned = entries.filter((p) => p.agents?.includes(agent))
  if (assigned.length === 1) return { id: assigned[0].id, reason: `agent: ${agent}` }
  const words = String(text)
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
  const scored = entries
    .filter((p) => p.risk !== "elevated")
    .map((p) => ({
      id: p.id,
      score: (p.keywords || []).filter((key) =>
        words.some((word) => word.startsWith(key.toLocaleLowerCase())),
      ).length,
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score || 0))
    return { id: scored[0].id, reason: "task keywords" }
  // ponytail: ambiguous tasks use the configured fallback; add model routing only with a native shared router.
  return {
    id: registry.mcpSettings?.fallback || (entries.length ? "core" : "all"),
    reason: "fallback",
  }
}

export function assertMcpNamespaces(installed) {
  const origins = new Map()
  for (const id of Object.keys(installed)) {
    const namespace = mcpNamespace(id)
    const previous = origins.get(namespace)
    if (previous && previous !== id)
      throw new Error(
        `MCP namespace collision: '${previous}' and '${id}' both normalize to '${namespace}'. Rename one server.`,
      )
    origins.set(namespace, id)
  }
}

export function filterMcpTools(tools, installed, profiles, selection) {
  assertMcpNamespaces(installed)
  const profile = profiles[selection.id]
  const requested = selection.id === "all" ? Object.keys(installed) : profile?.mcp || []
  const active = requested.filter((name) => installed[name] && !installed[name].disabled)
  const allowed = new Set(active)
  const servers = Object.keys(installed).sort((a, b) => b.length - a.length)
  const exposed = [],
    excluded = []
  for (const name of Object.keys(tools)) {
    const server = servers.find((id) => name.startsWith(`${mcpNamespace(id)}_`))
    if (!server) continue
    if (allowed.has(server)) exposed.push(name)
    else {
      excluded.push(name)
      delete tools[name]
    }
  }
  return {
    ...selection,
    installed: servers.length,
    active,
    exposed,
    excluded,
    warnings: [
      ...(selection.id !== "all" && !profile
        ? [`Profile '${selection.id}' is missing; no MCP tools exposed.`]
        : []),
      ...requested.filter((name) => !installed[name]).map((name) => `MCP '${name}' is missing.`),
      ...requested
        .filter((name) => installed[name]?.disabled)
        .map((name) => `MCP '${name}' is disabled.`),
    ],
  }
}
