const $ = (id) => document.getElementById(id)

const permissionSuppression = window.__permissionSuppression
const resolvedPermissions = permissionSuppression.resolved
window.__resolvedPermissions = resolvedPermissions
const directoryCache = new Map()
let activePermission = null
let expectedPermissionDetail = ''
let refreshingPermission = false
let refreshAgain = false
let buildRedirectBusy = false
let lastClearBannerAt = 0
let lastClearBannerKey = ''

function currentSessionID() {
  if (typeof location === 'undefined') return null
  const match = /^#\/session\/([^/?]+)/.exec(location.hash || '')
  return match ? decodeURIComponent(match[1]) : null
}

function permissionID(request) {
  return String(request?.requestID || request?.id || '')
}

function permissionKey(request) {
  const sid = String(request?.sessionID || '')
  const pid = permissionID(request)
  return sid && pid ? `${sid}:${pid}` : ''
}

function actionName(request) {
  return String(request?.action || request?.permission || request?.type || '').trim().toLowerCase()
}

function actionLabel(action) {
  return ({
    shell:'Команда', bash:'Команда', edit:'Изменение файла', write:'Запись файла', patch:'Изменение файла',
    read:'Чтение файла', glob:'Поиск файлов', grep:'Поиск по содержимому', list:'Список файлов',
    subagent:'Субагент', task:'Подзадача', webfetch:'Интернет', fetch:'Интернет', http:'Интернет',
    external_directory:'Внешняя директория',
  })[action] || action || 'Разрешение'
}

function compact(value, limit = 170) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…` : text
}

function firstString(...values) {
  for (const value of values.flat(Infinity)) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resourcesOf(request) {
  const raw = request?.resources ?? request?.resource ?? request?.patterns ?? request?.always
  if (typeof raw === 'string') return [raw]
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    return firstString(item.path, item.file, item.filename, item.command, item.cmd, item.url, item.resource, item.pattern, item.value)
  }).filter(Boolean)
}

function recursiveHint(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return ''
  for (const key of ['command','cmd','path','file','filename','url','description','prompt','question','query','label']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (Array.isArray(candidate)) {
      const joined = candidate.filter((item) => typeof item === 'string' && item.trim()).join(' ')
      if (joined) return joined
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const hint = recursiveHint(child, depth + 1)
      if (hint) return hint
    }
  }
  return ''
}

export function permissionSummaryForRequest(request, limit = 170) {
  const action = actionName(request)
  const resources = resourcesOf(request)
  const metadata = request?.metadata && typeof request.metadata === 'object' ? request.metadata : {}
  const command = firstString(metadata.command, metadata.cmd, request?.command, request?.cmd)
  const path = firstString(metadata.path, metadata.file, metadata.filename, request?.path, request?.file, request?.filename, resources[0])
  const url = firstString(metadata.url, request?.url, action === 'webfetch' || action === 'fetch' || action === 'http' ? resources[0] : '')
  const task = firstString(metadata.prompt, metadata.description, request?.prompt, request?.description, recursiveHint(request))

  let text = ''
  if (action === 'shell' || action === 'bash') text = command ? `Запустить команду: ${command}` : `Запустить команду: ${resources[0] || 'команда не указана'}`
  else if (['edit','write','patch'].includes(action)) text = `Изменить файл: ${path || 'путь не указан'}`
  else if (action === 'read') text = `Прочитать файл: ${path || 'путь не указан'}`
  else if (action === 'glob') text = `Найти файлы: ${firstString(resources[0], metadata.pattern, request?.pattern, task) || 'шаблон не указан'}`
  else if (action === 'grep') text = `Найти по содержимому: ${firstString(metadata.query, request?.query, resources[0], task) || 'запрос не указан'}`
  else if (action === 'list') text = `Показать файлы: ${path || 'текущий проект'}`
  else if (['webfetch','fetch','http'].includes(action)) text = `Открыть в интернете: ${url || task || 'адрес не указан'}`
  else if (action === 'external_directory') text = `Доступ к внешней папке: ${path || resources[0] || 'путь не указан'}`
  else if (action === 'subagent' || action === 'task') text = `Запустить подзадачу: ${task || resources[0] || 'детали под катом'}`
  else text = `${actionLabel(action)}: ${firstString(task, resources[0]) || 'требуется подтверждение'}`
  return compact(text, limit)
}

function permissionDetailText(request) {
  try {
    const text = JSON.stringify(request, null, 2)
    return text.length > 12000 ? `${text.slice(0, 12000)}\n…обрезано…` : text
  } catch {
    return String(request || '')
  }
}

function toast(text, ms = 3500) {
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(el._accessFixTimer)
  el._accessFixTimer = setTimeout(() => { el.hidden = true }, ms)
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  return type.includes('application/json') ? response.json() : response.text()
}

function dataOf(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value
}

async function sessionDirectory(sessionID) {
  if (directoryCache.has(sessionID)) return directoryCache.get(sessionID)
  const session = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}`))
  const directory = session?.location?.directory || ''
  if (directory) directoryCache.set(sessionID, directory)
  return directory
}

async function permissionRequests(directory) {
  const params = new URLSearchParams({ 'location[directory]':directory })
  for (const endpoint of ['/api/permission/request', '/api/permission']) {
    try {
      const value = dataOf(await request(`${endpoint}?${params}`))
      if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object')
    } catch (error) {
      if (![404,405].includes(error.status)) throw error
    }
  }
  return []
}

function clearBanner() {
  activePermission = null
  expectedPermissionDetail = ''
  const banner = $('permissionBanner')
  if (!banner) return
  const key = `${banner.dataset.permissionSession||''}:${banner.dataset.permissionId||''}`
  banner.hidden = true
  delete banner.dataset.permissionSession
  delete banner.dataset.permissionId
  if (key !== ':') {
    lastClearBannerAt = Date.now()
    lastClearBannerKey = key
  }
}

function restorePermissionCopy() {
  if (!activePermission) return
  const sid = currentSessionID()
  if (!sid || activePermission.sessionID !== sid) {
    clearBanner()
    return
  }
  const title = $('permissionTitle')
  const summary = $('permissionSummary')
  const detail = $('permissionDetail')
  if (title) title.textContent = actionLabel(actionName(activePermission))
  if (summary) summary.textContent = permissionSummaryForRequest(activePermission)
  if (detail && detail.textContent !== expectedPermissionDetail) detail.textContent = expectedPermissionDetail
}

function showPermission(requestRow) {
  const sid = currentSessionID()
  const pid = permissionID(requestRow)
  if (!sid || !pid || requestRow?.sessionID !== sid || permissionSuppression.isResolved(permissionKey(requestRow))) {
    clearBanner()
    return
  }
  const key = `${sid}:${pid}`
  if (key === lastClearBannerKey && Date.now() - lastClearBannerAt < 3000) return
  activePermission = requestRow
  expectedPermissionDetail = permissionDetailText(requestRow)
  const banner = $('permissionBanner')
  if (!banner) return
  banner.dataset.permissionSession = sid
  banner.dataset.permissionId = pid
  restorePermissionCopy()
  const details = $('permissionDetails')
  if (details && details.open && details.dataset.permissionId !== pid) details.open = false
  if (details) details.dataset.permissionId = pid
  banner.hidden = false
}

async function refreshPermission() {
  if (refreshingPermission) {
    refreshAgain = true
    return
  }
  refreshingPermission = true
  try {
    const sid = currentSessionID()
    if (!sid) {
      clearBanner()
      return
    }
    const directory = await sessionDirectory(sid)
    if (!directory || currentSessionID() !== sid) return
    const rows = (await permissionRequests(directory)).filter((item) => item?.sessionID === sid)
    if (currentSessionID() !== sid) return

    permissionSuppression.prune()
    const pending = rows.find((item) => {
      const key = permissionKey(item)
      return key && !permissionSuppression.isResolved(key)
    }) || null
    if (pending) showPermission(pending)
    else clearBanner()
  } catch (error) {
    console.debug('access-fix permission refresh failed', error)
  } finally {
    refreshingPermission = false
    if (refreshAgain) {
      refreshAgain = false
      queueMicrotask(refreshPermission)
    }
  }
}

async function sendPermissionReply(requestRow, reply) {
  const sid = String(requestRow?.sessionID || '')
  const pid = permissionID(requestRow)
  if (!sid || !pid) throw new Error('permission id is missing')
  const sidQ = encodeURIComponent(sid)
  const pidQ = encodeURIComponent(pid)
  try {
    return await request(`/api/session/${sidQ}/permission/${pidQ}/reply`, {
      method:'POST',
      body:JSON.stringify({ reply }),
    })
  } catch (error) {
    if (![400,404,405,422].includes(error.status)) throw error
  }
  return request(`/api/session/${sidQ}/permissions/${pidQ}`, {
    method:'POST',
    body:JSON.stringify({
      response: reply === 'reject' ? 'reject' : 'once',
      remember: reply === 'always',
    }),
  })
}

async function handlePermissionAction(button, event) {
  const requestRow = activePermission
  const sid = currentSessionID()
  if (!requestRow || requestRow.sessionID !== sid) {
    clearBanner()
    refreshPermission()
    return
  }
  const key = permissionKey(requestRow)
  if (!key) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const reply = button.dataset.permission
  permissionSuppression.markResolved(key)
  clearBanner()
  try {
    await sendPermissionReply(requestRow, reply)
    toast(reply === 'reject' ? 'Отклонено' : 'Разрешено', 1800)
    setTimeout(refreshPermission, 120)
    setTimeout(refreshPermission, 500)
    setTimeout(refreshPermission, 1300)
  } catch (error) {
    permissionSuppression.forget(key)
    toast(`Permission: ${error.message}`, 5000)
    refreshPermission()
  }
}

export function buildAgentForProfile(profile = 'direct') {
  return profile === 'orchestrated' ? 'build' : 'build-direct'
}

function enforceBuildOnly() {
  const root = $('agentControls')
  if (root) {
    root.style.display = 'none'
    root.setAttribute('aria-hidden', 'true')
    const active = root.querySelector('[data-agent].active')?.dataset.agent || ''
    if (!buildRedirectBusy && (active === 'plan' || active === 'plan-direct')) {
      const profile = document.documentElement.dataset.modelProfile === 'orchestrated' ? 'orchestrated' : 'direct'
      const target = root.querySelector(`[data-agent="${buildAgentForProfile(profile)}"]`)
      if (target) {
        buildRedirectBusy = true
        try { target.click() } finally { queueMicrotask(() => { buildRedirectBusy = false }) }
      }
    }
  }
  const modeSelect = $('projectDefaultMode')
  if (modeSelect) {
    modeSelect.value = 'build'
    const label = modeSelect.closest('label')
    if (label) label.hidden = true
  }
}

function installBuildOnly() {
  const root = $('agentControls')
  if (root) new MutationObserver(() => queueMicrotask(enforceBuildOnly)).observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] })
  document.addEventListener('click', (event) => {
    const plan = event.target.closest?.('#agentControls [data-agent="plan"], #agentControls [data-agent="plan-direct"]')
    if (!plan) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const profile = plan.dataset.agent === 'plan' ? 'orchestrated' : 'direct'
    const target = $('agentControls')?.querySelector(`[data-agent="${buildAgentForProfile(profile)}"]`)
    if (target && target !== plan) target.click()
  }, true)
  const settings = $('projectSettingsDialog')
  if (settings) new MutationObserver(enforceBuildOnly).observe(settings, { attributes:true, attributeFilter:['open'], subtree:false })
  enforceBuildOnly()
}

function installPermissionScope() {
  const banner = $('permissionBanner')
  if (!banner) return
  new MutationObserver(() => {
    if (banner.hidden) return
    const sid = currentSessionID()
    const bannerSid = banner.dataset.permissionSession || ''
    const bannerPid = banner.dataset.permissionId || ''
    if (bannerSid && bannerPid && bannerSid === sid) return
    const pid = permissionID(activePermission)
    if (!sid || !activePermission || activePermission.sessionID !== sid || banner.dataset.permissionSession !== sid || banner.dataset.permissionId !== pid) {
      clearBanner()
      queueMicrotask(refreshPermission)
    }
  }).observe(banner, { attributes:true, attributeFilter:['hidden'] })

  const detail = $('permissionDetail')
  if (detail) new MutationObserver(() => {
    if (activePermission && detail.textContent !== expectedPermissionDetail) queueMicrotask(restorePermissionCopy)
  }).observe(detail, { childList:true, characterData:true, subtree:true })

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-permission]')
    if (button) handlePermissionAction(button, event)
  }, true)

  window.addEventListener('hashchange', () => {
    clearBanner()
    enforceBuildOnly()
    refreshPermission()
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      enforceBuildOnly()
      refreshPermission()
    }
  })
  setInterval(() => {
    if (!document.hidden) {
      enforceBuildOnly()
      refreshPermission()
    }
  }, 700)
  refreshPermission()
}

function init() {
  installBuildOnly()
  installPermissionScope()
}

if (typeof document !== 'undefined') init()
