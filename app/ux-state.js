export const ORCHESTRATED_MODEL = {
  id: 'qwen3.8-max',
  providerID: 'bailian-cli',
  label: 'Qwen 3.8 Max · Оркестратор',
}

// User-facing execution modes are Build and Plan. The underlying OpenCode
// primary agent IDs stay build/plan for the orchestrated profile and
// build-direct/plan-direct for the ordinary model profile.
export function modeFromAgent(agentID = '') {
  return String(agentID).startsWith('plan') ? 'plan' : 'build'
}

export function profileFromAgent(agentID = '') {
  if (agentID === 'build-direct' || agentID === 'plan-direct') return 'direct'
  if (agentID === 'build' || agentID === 'plan') return 'orchestrated'
  return 'direct'
}

export function agentFor(mode = 'build', profile = 'direct') {
  const baseAgent = mode === 'plan' ? 'plan' : 'build'
  return profile === 'orchestrated' ? baseAgent : `${baseAgent}-direct`
}

export function composerActionState({ running = false, hasPayload = false } = {}) {
  if (!running) {
    return { kind: 'send', symbol: '↑', title: 'Отправить', delivery: 'normal' }
  }
  if (hasPayload) {
    return { kind: 'queue', symbol: '↑', title: 'Отправить в очередь', delivery: 'queue' }
  }
  return { kind: 'stop', symbol: '×', title: 'Отменить текущую работу', delivery: null }
}

function objectHint(value) {
  if (!value || typeof value !== 'object') return ''
  const keys = ['command', 'cmd', 'path', 'file', 'filename', 'url', 'label', 'description', 'prompt', 'question', 'query']
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (Array.isArray(candidate) && candidate.length) return candidate.map(String).join(' ')
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const nested = objectHint(child)
      if (nested) return nested
    }
  }
  return ''
}

function friendlyPermissionTitle(title) {
  const value = String(title || '').trim()
  if (/^(question|ask)$/i.test(value)) return 'Нужен выбор'
  if (/^(permission|разрешение)$/i.test(value)) return 'Требуется разрешение'
  return value || 'Требуется разрешение'
}

export function permissionSummary(title = 'Разрешение', raw = '', limit = 84) {
  const friendlyTitle = friendlyPermissionTitle(title)
  const compact = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!compact) return `${friendlyTitle}: детали под катом`

  let hint = compact
  if ((compact.startsWith('{') && compact.endsWith('}')) || (compact.startsWith('[') && compact.endsWith(']'))) {
    try { hint = objectHint(JSON.parse(compact)) || compact } catch {}
  }
  hint = hint.replace(/\s+/g, ' ').trim()
  if (hint.length > limit) hint = `${hint.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
  return `${friendlyTitle}: ${hint}`
}
