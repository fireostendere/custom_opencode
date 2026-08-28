const $ = (id) => document.getElementById(id)
const COMMAND_CACHE_MS = 60_000
const commandCache = new Map()
let paletteItems = []
let paletteIndex = 0
let limitsTimer = null

function dataOf(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  return type.includes('application/json') ? response.json() : response.text()
}

function toast(text, ms = 2800) {
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(el._enhancementTimer)
  el._enhancementTimer = setTimeout(() => { el.hidden = true }, ms)
}

function sessionIdFromHash() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

async function selectedDirectory() {
  const id = sessionIdFromHash()
  if (id) {
    try {
      const session = dataOf(await request(`/api/session/${encodeURIComponent(id)}`))
      if (session?.location?.directory) return session.location.directory
    } catch {}
  }
  const config = await request('/client-config.json')
  return config?.scratchDirectory || ''
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char])
}

export function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'лимит'
  if (minutes >= 285 && minutes <= 315) return 'Сессия · 5ч'
  if (minutes >= 9_576 && minutes <= 10_584) return 'Неделя · 7д'
  if (minutes % 1440 === 0) return `${Math.round(minutes / 1440)}д`
  if (minutes % 60 === 0) return `${Math.round(minutes / 60)}ч`
  return `${minutes}м`
}

function resetText(timestamp) {
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp * 1000)
  return `до ${date.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
}

function progress(value, tone = '') {
  if (!Number.isFinite(value)) return '<div class="quota-progress unknown"><i></i></div>'
  const remaining = Math.max(0, Math.min(100, value))
  return `<div class="quota-progress ${tone}"><i style="width:${remaining}%"></i></div>`
}

function quotaTone(remaining) {
  return remaining <= 10 ? 'danger' : remaining <= 25 ? 'warn' : ''
}

function renderOpenAIQuota(value) {
  if (!value?.available) {
    return `<section class="quota-provider"><div class="quota-provider-head"><strong>OpenAI</strong><span class="quota-muted">недоступно</span></div><div class="quota-note">${escapeHtml(value?.reason === 'codex-not-found' ? 'Codex CLI не найден' : 'Нет rate-limit snapshot')}</div></section>`
  }
  const windows = [value.primary, value.secondary].filter(Boolean).sort((a, b) => (a.windowDurationMins || 0) - (b.windowDurationMins || 0))
  return `<section class="quota-provider">
    <div class="quota-provider-head"><strong>OpenAI</strong><span class="quota-muted">${escapeHtml(value.planType || '')}</span></div>
    ${windows.map((window) => {
      const remaining = Number(window.remainingPercent)
      return `<div class="quota-row"><div class="quota-label"><span>${escapeHtml(windowLabel(window.windowDurationMins))}</span><strong>${Number.isFinite(remaining) ? `${remaining}%` : '—'}</strong></div>${progress(remaining, quotaTone(remaining))}<div class="quota-reset">${escapeHtml(resetText(window.resetsAt))}</div></div>`
    }).join('') || '<div class="quota-note">Rate-limit окна не возвращены.</div>'}
  </section>`
}

function renderQwenWindow(window, fallbackLimit, fallbackMinutes) {
  const limit = Number(window?.limit || fallbackLimit)
  const remaining = Number(window?.remainingPercent)
  const remainingCredits = Number(window?.remainingCredits)
  if (Number.isFinite(remaining)) {
    const credits = Number.isFinite(remainingCredits) ? `${remainingCredits.toLocaleString('ru-RU')} / ${limit.toLocaleString('ru-RU')}` : `${remaining}%`
    return `<div class="quota-row"><div class="quota-label"><span>${escapeHtml(windowLabel(window?.windowDurationMins || fallbackMinutes))}</span><strong>${escapeHtml(credits)}</strong></div>${progress(remaining, quotaTone(remaining))}<div class="quota-reset">${remaining}% осталось${window?.resetsAt ? ` · ${escapeHtml(resetText(window.resetsAt))}` : ''}</div></div>`
  }
  return `<div class="quota-cap"><span>${escapeHtml(windowLabel(window?.windowDurationMins || fallbackMinutes))}</span><strong>${limit.toLocaleString('ru-RU')}</strong></div>`
}

function renderQwenQuota(value) {
  const state = value?.state === 'ok' ? 'OK' : value?.state === 'exhausted' ? 'исчерпан' : 'нет probe'
  const stateClass = value?.state === 'exhausted' ? 'quota-bad' : value?.state === 'ok' ? 'quota-good' : 'quota-muted'
  const live = value?.source === 'bailian-cli'
  return `<section class="quota-provider">
    <div class="quota-provider-head"><strong>Qwen</strong><span class="${stateClass}">${escapeHtml(state)}</span></div>
    ${renderQwenWindow(value?.fiveHour, 12000, 300)}
    ${renderQwenWindow(value?.sevenDay, 40000, 10080)}
    ${!live && value?.resetAt ? `<div class="quota-reset">probe reset ${escapeHtml(value.resetAt)}</div>` : ''}
    <div class="quota-note">${live ? 'Реальное использование Token Plan через Bailian CLI.' : (value?.reason === 'bailian-cli-not-found' ? 'Bailian CLI не найден; показаны caps + probe.' : 'Token Plan usage недоступен; показаны caps + probe.')}</div>
  </section>`
}

async function refreshLimits() {
  const panel = $('providerLimits')
  if (!panel) return
  panel.classList.add('loading-limits')
  try {
    const value = await request('/client-limits.json')
    panel.innerHTML = `<div class="quota-title"><span>Лимиты</span><button type="button" id="quotaRefresh" title="Обновить лимиты">↻</button></div>${renderQwenQuota(value?.qwen)}${renderOpenAIQuota(value?.openai)}`
    $('quotaRefresh')?.addEventListener('click', refreshLimits)
  } catch (error) {
    panel.innerHTML = `<div class="quota-title"><span>Лимиты</span><button type="button" id="quotaRefresh" title="Обновить лимиты">↻</button></div><div class="quota-note">Не удалось обновить: ${escapeHtml(error.message)}</div>`
    $('quotaRefresh')?.addEventListener('click', refreshLimits)
  } finally {
    panel.classList.remove('loading-limits')
  }
}

export function commandName(command) {
  return String(command?.name || command?.command || command?.id || '').replace(/^\//, '')
}

function commandDescription(command) {
  const description = command?.description || command?.summary || ''
  const hints = Array.isArray(command?.hints) ? command.hints.filter(Boolean).join(' ') : ''
  return [description, hints].filter(Boolean).join(' · ')
}

async function loadCommands(force = false) {
  const directory = await selectedDirectory()
  const cached = commandCache.get(directory)
  if (!force && cached && Date.now() - cached.at < COMMAND_CACHE_MS) return cached.items
  const params = new URLSearchParams()
  if (directory) params.set('location[directory]', directory)
  const raw = dataOf(await request(`/api/command${params.size ? `?${params}` : ''}`))
  const items = (Array.isArray(raw) ? raw : []).map((item) => typeof item === 'string' ? { name:item } : item).filter((item) => commandName(item))
  commandCache.set(directory, { at:Date.now(), items })
  return items
}

function slashQuery() {
  const input = $('input')
  const value = input?.value || ''
  if (!(value === '/' || /^\/[^/]/.test(value))) return null
  if (value.startsWith('//')) return null
  const token = value.slice(1).split(/\s/, 1)[0]
  return token.toLowerCase()
}

function closePalette() {
  const palette = $('slashPalette')
  if (palette) palette.hidden = true
  paletteItems = []
  paletteIndex = 0
}

function renderPalette() {
  const palette = $('slashPalette')
  if (!palette) return
  if (!paletteItems.length) {
    palette.innerHTML = '<div class="slash-empty">Команды не найдены</div>'
    palette.hidden = false
    return
  }
  palette.innerHTML = paletteItems.map((command, index) => `<button type="button" class="slash-item ${index === paletteIndex ? 'active' : ''}" data-slash-index="${index}"><span class="slash-name">/${escapeHtml(commandName(command))}</span><span class="slash-desc">${escapeHtml(commandDescription(command))}</span></button>`).join('')
  palette.hidden = false
  palette.querySelectorAll('[data-slash-index]').forEach((button) => button.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    insertCommand(Number(button.dataset.slashIndex))
  }))
  palette.querySelector('.slash-item.active')?.scrollIntoView({ block:'nearest' })
}

async function updatePalette() {
  const query = slashQuery()
  if (query === null) { closePalette(); return }
  try {
    const commands = await loadCommands()
    paletteItems = commands.filter((command) => commandName(command).toLowerCase().startsWith(query)).slice(0, 30)
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))
    renderPalette()
  } catch (error) {
    const palette = $('slashPalette')
    if (palette) {
      palette.innerHTML = `<div class="slash-empty">Команды недоступны: ${escapeHtml(error.message)}</div>`
      palette.hidden = false
    }
  }
}

function insertCommand(index = paletteIndex) {
  const command = paletteItems[index]
  if (!command) return
  const input = $('input')
  input.value = `/${commandName(command)} `
  input.dispatchEvent(new Event('input', { bubbles:true }))
  input.focus()
  closePalette()
}

function waitForSessionID(timeout = 8000) {
  const existing = sessionIdFromHash()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    const timer = setInterval(() => {
      const id = sessionIdFromHash()
      if (id) { clearInterval(timer); resolve(id); return }
      if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('Не удалось создать сессию для команды')) }
    }, 80)
  })
}

async function ensureSessionID() {
  const id = sessionIdFromHash()
  if (id) return id
  $('newSession')?.click()
  return waitForSessionID()
}

export function parseSlash(value) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(value.trim())
  return match ? { command:match[1], arguments:match[2] || '' } : null
}

async function executeSlash(value) {
  const parsed = parseSlash(value)
  if (!parsed) return
  const sessionID = await ensureSessionID()
  const body = { command:parsed.command, arguments:parsed.arguments }
  await request(`/api/session/${encodeURIComponent(sessionID)}/command`, { method:'POST', body:JSON.stringify(body) })
  const input = $('input')
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles:true }))
  closePalette()
  toast(`/${parsed.command} выполнена`)
  setTimeout(() => $('refresh')?.click(), 250)
}

function bindSlashCommands() {
  const input = $('input')
  const form = $('form')
  if (!input || !form) return

  input.addEventListener('input', updatePalette)
  input.addEventListener('keydown', (event) => {
    const palette = $('slashPalette')
    if (!palette || palette.hidden) return
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopImmediatePropagation()
      paletteIndex = paletteItems.length ? (paletteIndex + 1) % paletteItems.length : 0
      renderPalette()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation()
      paletteIndex = paletteItems.length ? (paletteIndex - 1 + paletteItems.length) % paletteItems.length : 0
      renderPalette()
    } else if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation(); insertCommand()
    } else if (event.key === 'Enter' && !event.shiftKey && paletteItems.length && !input.value.trim().includes(' ')) {
      const selected = paletteItems[paletteIndex]
      const exact = commandName(selected).toLowerCase() === input.value.trim().slice(1).toLowerCase()
      event.preventDefault(); event.stopImmediatePropagation()
      if (exact) { closePalette(); form.requestSubmit() } else insertCommand()
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closePalette()
    }
  }, true)

  form.addEventListener('submit', (event) => {
    const value = input.value.trim()
    if (value.startsWith('//')) {
      input.value = input.value.replace(/^\//, '')
      closePalette()
      return
    }
    if (!value.startsWith('/')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    executeSlash(value).catch((error) => {
      if ([404, 405].includes(error.status)) toast('Эта сборка OpenCode не поддерживает выполнение slash-команд', 5000)
      else toast(`Команда: ${error.message}`, 5000)
    })
  }, true)

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#slashPalette') && event.target !== input) closePalette()
  })
  window.addEventListener('hashchange', () => { commandCache.clear(); closePalette() })
}

async function initializeEnhancements() {
  bindSlashCommands()
  void refreshLimits()
  limitsTimer = setInterval(() => { if (!document.hidden) refreshLimits() }, 60_000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLimits() })
}

if (typeof document !== 'undefined') initializeEnhancements().catch((error) => console.warn('enhancements init failed', error))
