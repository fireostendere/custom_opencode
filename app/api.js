const jsonHeaders = { 'Content-Type': 'application/json' }

export async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...jsonHeaders, ...(options.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) return response.json()
  return response.text()
}

export const dataOf = (value) => value && typeof value === 'object' && 'data' in value ? value.data : value
const locationParams = (directory) => new URLSearchParams({ 'location[directory]': directory })

export async function listProjects() {
  const value = dataOf(await request('/api/project'))
  return Array.isArray(value) ? value : []
}

export async function listSessions() {
  const first = await request('/api/session?limit=100&order=desc')
  if (Array.isArray(first)) return first
  const sessions = [...(first?.data || [])]
  let cursor = first?.cursor?.next
  let pages = 0
  while (cursor && pages++ < 200) {
    const page = await request(`/api/session?limit=100&cursor=${encodeURIComponent(cursor)}`)
    sessions.push(...(page?.data || []))
    cursor = page?.cursor?.next
  }
  return sessions
}

export async function sessionStatuses() {
  try { return dataOf(await request('/api/session/active')) || {} }
  catch {
    try { return dataOf(await request('/api/session/status')) || {} } catch { return {} }
  }
}

export async function createSession({ directory, title, agent, model }) {
  const body = { location: { directory } }
  if (title) body.title = title
  if (agent) body.agent = agent
  if (model) body.model = model
  return dataOf(await request('/api/session', { method: 'POST', body: JSON.stringify(body) }))
}

function normalizeModernMessage(item) {
  if (!item || typeof item !== 'object' || !item.info) return item
  const info = item.info || {}
  const parts = item.parts || []
  const text = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n')
  const files = parts.filter((part) => part.type === 'file').map((part) => ({ name: part.filename || part.name, uri: part.url || part.uri, mime: part.mime }))
  return {
    ...info,
    type: info.role === 'user' ? 'user' : 'assistant',
    text,
    files,
    content: parts,
  }
}

export async function getContext(sessionID) {
  try {
    const value = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/context`))
    return Array.isArray(value) ? value : []
  } catch (error) {
    if (error.status !== 404) throw error
    const value = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/message?limit=1000`))
    return Array.isArray(value) ? value.map(normalizeModernMessage) : []
  }
}

export async function getControls(directory) {
  const q = locationParams(directory)
  const [agentsRaw, modelsRaw, providersRaw, fallbackRaw] = await Promise.all([
    request(`/api/agent?${q}`),
    request(`/api/model?${q}`),
    request(`/api/provider?${q}`),
    request(`/api/model/default?${q}`).catch(() => null),
  ])
  const agents = dataOf(agentsRaw) || []
  const models = dataOf(modelsRaw) || []
  const providerValue = dataOf(providersRaw)
  const providers = Array.isArray(providerValue) ? providerValue : providerValue?.all || []
  let fallback = dataOf(fallbackRaw)
  if (!fallback && providerValue?.default) {
    const [providerID, id] = Object.entries(providerValue.default)[0] || []
    if (providerID && id) fallback = { providerID, id }
  }
  return {
    agents: agents.filter((agent) => !agent.hidden && (agent.mode === 'primary' || agent.mode === 'all' || !agent.mode)),
    models: models.filter((model) => model.enabled !== false),
    providers,
    fallback,
  }
}

export async function switchAgent(sessionID, agent) {
  return request(`/api/session/${encodeURIComponent(sessionID)}/agent`, { method: 'POST', body: JSON.stringify({ agent }) })
}

export async function switchModel(sessionID, model) {
  return request(`/api/session/${encodeURIComponent(sessionID)}/model`, { method: 'POST', body: JSON.stringify({ model }) })
}

export async function sendPrompt(session, { text, files = [], delivery = 'normal' }) {
  const id = encodeURIComponent(session.id)
  try {
    return await request(`/api/session/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, files, delivery: 'steer' }),
    })
  } catch (error) {
    if (error.status !== 404 || files.length) throw error
    const parts = text ? [{ type: 'text', text }] : []
    return request(`/api/session/${id}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({
        agent: session.agent,
        model: session.model,
        parts,
      }),
    })
  }
}

export async function abortSession(sessionID) {
  const id = encodeURIComponent(sessionID)
  try { return await request(`/api/session/${id}/interrupt`, { method: 'POST', body: '{}' }) }
  catch (error) {
    if (error.status !== 404) throw error
    return request(`/api/session/${id}/abort`, { method: 'POST', body: '{}' })
  }
}

export async function renameSession(sessionID, title) {
  const id = encodeURIComponent(sessionID)
  try {
    return dataOf(await request(`/api/session/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }))
  } catch (error) {
    if (error.status !== 404 && error.status !== 405) throw error
    return dataOf(await request(`/api/session/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }))
  }
}

export async function forkSession(sessionID, messageID) {
  const body = messageID ? { messageID } : {}
  return dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/fork`, {
    method: 'POST', body: JSON.stringify(body),
  }))
}

export async function deleteSession(sessionID) {
  return request(`/api/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' })
}

export async function getPermissions(directory) {
  const q = locationParams(directory)
  try { return dataOf(await request(`/api/permission/request?${q}`)) || [] }
  catch { return [] }
}

export async function replyPermission(sessionID, permissionID, reply) {
  const sid = encodeURIComponent(sessionID)
  const pid = encodeURIComponent(permissionID)
  try {
    return await request(`/api/session/${sid}/permission/${pid}/reply`, {
      method: 'POST', body: JSON.stringify({ reply }),
    })
  } catch (error) {
    if (error.status !== 404) throw error
    return request(`/api/session/${sid}/permissions/${pid}`, {
      method: 'POST',
      body: JSON.stringify({ response: reply === 'reject' ? 'reject' : 'once', remember: reply === 'always' }),
    })
  }
}

export async function getVcs(directory) {
  const q = locationParams(directory)
  try { return dataOf(await request(`/api/vcs?${q}`)) || null }
  catch { return null }
}

export async function getFileStatus(directory) {
  const q = locationParams(directory)
  for (const endpoint of ['/api/vcs/status', '/api/file/status']) {
    try {
      const value = dataOf(await request(`${endpoint}?${q}`))
      if (Array.isArray(value)) return value
    } catch {}
  }
  return []
}

export async function getVcsDiff(directory) {
  const q = locationParams(directory)
  try {
    const value = dataOf(await request(`/api/vcs/diff?${q}`))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export async function getSessionDiff(sessionID) {
  try {
    const value = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/diff`))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export async function getFileContent(directory, path) {
  const q = locationParams(directory)
  q.set('path', path)
  return dataOf(await request(`/api/file/content?${q}`))
}

export async function getClientConfig() {
  return request('/client-config.json')
}

export function connectEvents(onEvent, onError) {
  const source = new EventSource('/api/event')
  source.onmessage = (event) => {
    try { onEvent(JSON.parse(event.data)) }
    catch (error) { console.warn('Invalid OpenCode event', error) }
  }
  source.onerror = () => onError?.()
  return source
}
