// Agent/model coherence for the native TUI.
//
// The native TUI remembers models per (session, agent). It shows and later
// commits a session's stored model only while the session's agent equals the
// TUI's current agent, and that agent must be a visible primary agent. In every
// other case it falls back to the agent's own model or the config default, so
// both a hidden legacy agent (build-direct/plan-direct) and a plain Build/Plan
// switch used to "reset" the model. These helpers keep agent switches explicit
// and persisted, which keeps the session's model authoritative.

export const LEGACY_AGENT_ALIASES = Object.freeze({
  "build-direct": "build",
  "plan-direct": "plan",
})

export const DND_AGENT = "dnd-narrator"

export function modelRef(value) {
  if (!value || typeof value !== "object") return null
  const providerID = value.providerID
  const id = value.id ?? value.modelID
  if (typeof providerID !== "string" || !providerID || typeof id !== "string" || !id) return null
  return { providerID, id, ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}) }
}

export function sameModel(a, b) {
  const left = modelRef(a)
  const right = modelRef(b)
  return Boolean(left && right && left.providerID === right.providerID && left.id === right.id)
}

export function isDndModel(model) {
  const ref = modelRef(model)
  return Boolean(ref && ref.providerID === "openai" && ref.id === "gpt-6-dnd-edition")
}

/** Visible primary agents in native cycle order. */
export function primaryAgents(list) {
  return (Array.isArray(list) ? list : []).filter(
    (agent) => agent && typeof agent.id === "string" && agent.mode !== "subagent" && !agent.hidden,
  )
}

/** The visible agent the TUI effectively uses for a stored session agent. */
export function visibleAgent(list, agentID) {
  const agents = primaryAgents(list)
  const id = LEGACY_AGENT_ALIASES[agentID] ?? agentID
  return agents.find((agent) => agent.id === id) ?? agents[0] ?? null
}

/** Mirrors native agent.move(): unknown/hidden agents count as the first one. */
export function nextAgent(list, agentID, direction) {
  const agents = primaryAgents(list)
  if (!agents.length) return null
  const current = visibleAgent(agents, agentID)
  const index = Math.max(0, agents.findIndex((agent) => agent.id === current?.id))
  return agents[(index + (direction < 0 ? -1 : 1) + agents.length) % agents.length]
}

/**
 * Agent a session must switch to when the user picks `model`; null keeps the
 * current agent. D&D models run only under the narrator, other models leave it,
 * and hidden legacy agents migrate to their visible counterparts.
 */
export function agentForModelChoice(model, currentAgent) {
  if (isDndModel(model)) return currentAgent === DND_AGENT ? null : DND_AGENT
  if (currentAgent === DND_AGENT) return "build"
  return LEGACY_AGENT_ALIASES[currentAgent] ?? null
}

/**
 * Model to commit together with an agent switch, or null to keep the session's.
 * An agent that owns a model (for example the D&D narrator) brings it; leaving
 * such an agent restores the model used before it, else the newest recent
 * model that no agent owns.
 */
export function modelForAgentSwitch({ from, to, sessionModel, remembered, recent, agents }) {
  const target = modelRef(to?.model)
  if (target) return sameModel(target, sessionModel) ? null : target
  if (!from?.model || !sameModel(from.model, sessionModel)) return null
  const owned = (candidate) =>
    primaryAgents(agents).some((agent) => agent.model && sameModel(agent.model, candidate))
  const restore = modelRef(remembered)
  if (restore && !owned(restore)) return restore
  for (const entry of Array.isArray(recent) ? recent : []) {
    const candidate = modelRef(entry)
    if (candidate && !owned(candidate)) return candidate
  }
  return null
}
