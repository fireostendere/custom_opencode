export const ORCHESTRATED_MODEL = {
  id: 'qwen3.8-orchestrated',
  providerID: 'bailian-cli',
  label: 'Qwen3.8 Max · Orchestrated',
}
export const SOL_ORCHESTRATED_MODEL = {
  id: 'gpt-6.2-sol-orchestrated',
  providerID: 'openai',
  label: 'GPT-6.2 Sol · Orchestrated',
}
export const ASTRA_ORCHESTRATED_MODEL = {
  id: 'gpt-6.2-astra-orchestrated',
  providerID: 'openai',
  label: 'GPT-6.2 Astra · Orchestrated',
}
export const DND_EDITION_MODEL = {
  id: 'gpt-6-dnd-edition',
  providerID: 'openai',
  label: 'GPT-6 · DnD Edition',
}
export const ORCHESTRATED_MODELS = [ORCHESTRATED_MODEL, SOL_ORCHESTRATED_MODEL, ASTRA_ORCHESTRATED_MODEL, DND_EDITION_MODEL]

// Web and TUI share sessions, so both use the visible native agents. The TUI
// ignores a session's model while its agent is hidden (legacy build-direct /
// plan-direct) and falls back to the config default model.
export const LEGACY_AGENT_ALIASES = { 'build-direct': 'build', 'plan-direct': 'plan' }

export function modeFromAgent(agentID = '') {
  return String(agentID).startsWith('plan') ? 'plan' : 'build'
}

export function profileFromAgent(agentID = '') {
  if (agentID === 'dnd-narrator') return 'dnd-edition'
  return 'direct'
}

export function agentFor(mode = 'build', profile = 'direct') {
  if (profile === 'dnd-edition') return 'dnd-narrator'
  return mode === 'plan' ? 'plan' : 'build'
}

// Agent after the user explicitly picks a model; null keeps the current one.
// Only the D&D narrator is tied to its model, and hidden legacy agents migrate
// to visible ones (the TUI drops a session's model under a hidden agent).
export function agentAfterModelPick(currentAgent = '', profile = 'direct') {
  if (profile === 'dnd-edition') return currentAgent === 'dnd-narrator' ? null : 'dnd-narrator'
  if (currentAgent === 'dnd-narrator') return 'build'
  return LEGACY_AGENT_ALIASES[currentAgent] || null
}

export function composerActionState({ running = false, hasPayload = false } = {}) {
  if (!running) {
    return { kind: 'send', symbol: '→', title: 'Отправить', delivery: 'normal' }
  }
  if (hasPayload) {
    return { kind: 'queue', symbol: '→', title: 'Отправить в очередь', delivery: 'queue' }
  }
  return { kind: 'stop', symbol: '×', title: 'Отменить текущую работу', delivery: null }
}
