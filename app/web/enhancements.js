import { LIMIT_DEFS, selectedLimitIDs, trackedLimitSources } from './client-limit-selection.js'
import { isNightPromoActive } from './night-promo.js'
import { createRefreshCoalescer } from './refresh-coalescer.js'

const $ = (id) => document.getElementById(id)
const COMMAND_CACHE_MS = 60_000
const OPENAI_LIMITS_CACHE_KEY = 'opencode:web:openai-limits-last-good-v1'
const OPENAI_LIMITS_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000
const LIMIT_PREFERENCES_KEY = 'custom-opencode:limits-hidden-v1'
const RETIRED_COMMANDS = new Set(['doctor'])
const commandCache = new Map()
let paletteItems = []
let paletteIndex = 0
let limitsTimer = null
let hiddenLimitIDs = readLimitPreferences()
let limitModels = []
let limitOptions = { alibabaEnabled: true }
let lastLimits = {}
const coalesceLimits = createRefreshCoalescer()

export function readLimitPreferences(storage = globalThis.localStorage) {
  try {
    const hidden = JSON.parse(storage?.getItem(LIMIT_PREFERENCES_KEY) || '[]')
    return Array.isArray(hidden) ? hidden.filter((id) => LIMIT_DEFS.some((limit) => limit.id === id)) : []
  } catch { return [] }
}

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
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.hidden = true }, ms)
}

function sessionIdFromHash() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

// A session's directory never changes: resolve it once instead of one
// GET /api/session/:id per slash-palette keystroke.
const directoryBySession = new Map()
let scratchDirectory = null
async function selectedDirectory() {
  const id = sessionIdFromHash()
  if (id) {
    // Cache the in-flight lookup too: fast typing fires several keystrokes
    // before the first answer arrives.
    if (!directoryBySession.has(id)) {
      if (directoryBySession.size > 200) directoryBySession.clear()
      directoryBySession.set(id, request(`/api/session/${encodeURIComponent(id)}`)
        .then((value) => dataOf(value)?.location?.directory || null)
        .catch(() => null))
    }
    const directory = await directoryBySession.get(id)
    if (directory) return directory
    directoryBySession.delete(id)
  }
  scratchDirectory ??= request('/client-config.json').then((config) => config?.scratchDirectory || '').catch(() => { scratchDirectory = null; return '' })
  return scratchDirectory
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

function cachedOpenAILimits() {
  try {
    const cached = JSON.parse(localStorage.getItem(OPENAI_LIMITS_CACHE_KEY) || 'null')
    if (!cached?.value?.available || !Number.isFinite(cached.at) || Date.now() - cached.at > OPENAI_LIMITS_CACHE_MAX_AGE_MS) return null
    return { ...cached.value, stale:true, staleSource:'browser' }
  } catch {
    return null
  }
}

function stableOpenAILimits(value) {
  if (value?.available) {
    if (!value.stale) {
      try { localStorage.setItem(OPENAI_LIMITS_CACHE_KEY, JSON.stringify({ at:Date.now(), value })) } catch {}
    }
    return value
  }
  const cached = cachedOpenAILimits()
  return cached ? { ...cached, liveReason:value?.reason || 'snapshot-unavailable' } : value
}

const PLAN_LABELS = { free:'Free', go:'Go', plus:'Plus', pro:'Pro', prolite:'Pro Lite', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu', education:'Edu' }
export function planLabel(plan) {
  const id = String(plan || '').toLowerCase()
  if (!id || id === 'unknown') return 'OK'
  return PLAN_LABELS[id] || String(plan)
}

function renderOpenAIQuota(value, selected) {
  if (!value?.available) {
    const reasons = {
      'codex-not-found':'Codex CLI не найден',
      'codex-auth-required':'Требуется обновить вход ChatGPT в Codex CLI',
      'no-rate-limit-snapshot':'ChatGPT usage snapshot не вернулся',
      'codex-rate-limits-unavailable':'Не удалось прочитать ChatGPT usage',
    }
    return `<section class="quota-provider"><div class="quota-provider-head"><strong>ChatGPT / OpenAI</strong><span class="quota-muted">недоступно</span></div><div class="quota-note">${escapeHtml(reasons[value?.reason] || 'Нет rate-limit snapshot')}</div></section>`
  }
  const windows = ['primary', 'secondary'].filter((key) => selected.includes(`codex.${key}`)).map((key) => value[key]).filter(Boolean).sort((a, b) => (a.windowDurationMins || 0) - (b.windowDurationMins || 0))
  const state = value.stale ? 'последние данные' : planLabel(value.planType)
  return `<section class="quota-provider">
    <div class="quota-provider-head"><strong>ChatGPT / OpenAI</strong><span class="${value.stale ? 'quota-muted' : 'quota-good'}">${escapeHtml(state)}</span></div>
    ${windows.map((window) => {
      const remaining = Number(window.remainingPercent)
      return `<div class="quota-row"><div class="quota-label"><span>${escapeHtml(windowLabel(window.windowDurationMins))}</span><strong>${Number.isFinite(remaining) ? `${remaining}%` : '—'}</strong></div>${progress(remaining, quotaTone(remaining))}<div class="quota-reset">${Number.isFinite(remaining) ? `${remaining}% осталось` : ''}${window.resetsAt ? ` · ${escapeHtml(resetText(window.resetsAt))}` : ''}</div></div>`
    }).join('') || '<div class="quota-note">Rate-limit окна не возвращены.</div>'}
    ${value.stale ? '<div class="quota-note">Live-опрос временно недоступен; показан последний успешный snapshot.</div>' : ''}
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

function renderQwenQuota(value, selected) {
  if (value?.state === 'disabled') return '' // not configured: nothing to watch, no card
  const isExpired = value?.state === 'expired' || value?.reason === 'session-expired'
  const state = value?.state === 'ok' ? 'OK' : value?.state === 'exhausted' ? 'исчерпан' : (isExpired ? 'сессия истекла' : 'нет probe')
  const stateClass = value?.state === 'exhausted' || isExpired ? 'quota-bad' : value?.state === 'ok' ? 'quota-good' : 'quota-muted'
  const live = value?.source === 'bailian-cli' && !isExpired
  const note = live
    ? 'Реальное использование Token Plan через Bailian CLI.'
    : (isExpired
      ? 'Сессия Bailian истекла. Выполните: bl auth login --console'
      : (value?.reason === 'bailian-cli-not-found' ? 'Bailian CLI не найден; показаны caps + probe.' : 'Token Plan usage недоступен; показаны caps + probe.'))
  return `<section class="quota-provider">
    <div class="quota-provider-head"><strong>Alibaba</strong><span class="${stateClass}">${escapeHtml(state)}</span></div>
    ${selected.includes('qwen.fiveHour') ? renderQwenWindow(value?.fiveHour, 12000, 300) : ''}
    ${selected.includes('qwen.sevenDay') ? renderQwenWindow(value?.sevenDay, 40000, 10080) : ''}
    <div class="quota-note">${isNightPromoActive() ? 'ночная скидка −50% действует' : 'ночная скидка −50%: 22:00–08:00 Пекин'} · для участвующих моделей</div>
    ${!live && value?.resetAt ? `<div class="quota-reset">probe reset ${escapeHtml(value.resetAt)}</div>` : ''}
    <div class="quota-note">${escapeHtml(note)}</div>
  </section>`
}

function renderGeminiWindow(window, fallbackLabel, fallbackLimit) {
  const label = window?.label || fallbackLabel
  const limit = Number(window?.limit || fallbackLimit)
  const remaining = Number(window?.remainingPercent)
  const used = Number(window?.usedCredits)
  if (Number.isFinite(remaining)) {
    const credits = Number.isFinite(used) ? `${used.toLocaleString('ru-RU')} / ${limit.toLocaleString('ru-RU')}` : `${remaining}%`
    return `<div class="quota-row"><div class="quota-label"><span>${escapeHtml(label)}</span><strong>${escapeHtml(credits)}</strong></div>${progress(remaining, quotaTone(remaining))}<div class="quota-reset">${remaining}% свободно${window?.resetsAt ? ` · ${escapeHtml(resetText(window.resetsAt))}` : ''}</div></div>`
  }
  return `<div class="quota-cap"><span>${escapeHtml(label)}</span><strong>${limit.toLocaleString('ru-RU')}</strong></div>`
}

function renderGeminiQuota(value, selected) {
  if (!value?.available) {
    if (value?.reason === 'key-not-found') return '' // not configured: nothing to watch, no card
    return `<section class="quota-provider"><div class="quota-provider-head"><strong>Google Gemini</strong><span class="quota-muted">не настроен</span></div><div class="quota-note">${escapeHtml(value?.reason === 'key-not-found' ? 'GEMINI_API_KEY не задан в .env' : 'Лимиты Gemini недоступны')}</div></section>`
  }
  const isRateLimited = Boolean(value?.rateLimited || value?.state === 'exhausted')
  const stateLabel = isRateLimited
    ? (value.seconds ? `429 (${value.seconds}с)` : 'исчерпан')
    : (value.state === 'ok' ? 'OK' : 'активен')
  const stateClass = isRateLimited ? 'quota-bad' : 'quota-good'
  return `<section class="quota-provider">
    <div class="quota-provider-head"><strong>Google Gemini</strong><span class="${stateClass}">${escapeHtml(stateLabel)}</span></div>
    ${selected.includes('gemini.minuteTokens') ? renderGeminiWindow(value?.minuteTokens, 'токены/мин (TPM)', 2000000) : ''}
    ${selected.includes('gemini.minuteRequests') ? renderGeminiWindow(value?.minuteRequests, 'запросы/мин (RPM)', 1000) : ''}
    ${selected.includes('gemini.dailyRequests') ? renderGeminiWindow(value?.dailyRequests, 'запросы/сутки (RPD)', 4000000) : ''}
    ${isRateLimited && value?.resetAt ? `<div class="quota-reset">сброс через ${escapeHtml(String(value?.seconds || 0))}с · ${escapeHtml(resetText(value?.resetAt))}</div>` : ''}
    <div class="quota-note">${escapeHtml(value?.note || 'Google AI Studio · Pay-as-you-go (2M TPM / 1K RPM)')}</div>
  </section>`
}

export function renderLimits(value, selected) {
  const sources = trackedLimitSources(selected)
  return `${sources.includes('codex') ? renderOpenAIQuota(value?.openai, selected) : ''}${sources.includes('qwen') ? renderQwenQuota(value?.qwen, selected) : ''}${sources.includes('gemini') ? renderGeminiQuota(value?.gemini, selected) : ''}` || '<div class="quota-note">Нет выбранных лимитов. Откройте «Настроить лимиты».</div>'
}

function renderLimitSettings() {
  const choices = $('limitChoices')
  if (!choices) return
  const available = selectedLimitIDs(limitModels, [], limitOptions)
  const markup = LIMIT_DEFS.filter((limit) => available.includes(limit.id)).map((limit) => `<label><input type="checkbox" data-limit-id="${escapeHtml(limit.id)}"${hiddenLimitIDs.includes(limit.id) ? '' : ' checked'}> ${escapeHtml(limit.label)}</label>`).join('') || '<div class="quota-note">Нет подключённых моделей с поддержкой лимитов.</div>'
  if (choices._lastMarkup !== markup) {
    const focused = document.activeElement?.dataset?.limitId
    choices.innerHTML = markup
    choices._lastMarkup = markup
    if (focused) choices.querySelector(`[data-limit-id="${focused}"]`)?.focus()
  }
}

function paintLimits() {
  const panel = $('providerLimits')
  if (!panel) return
  const markup = renderLimits(lastLimits, selectedLimitIDs(limitModels, hiddenLimitIDs, limitOptions))
  if (panel._lastMarkup !== markup) { panel._lastMarkup = markup; panel.innerHTML = markup }
  renderLimitSettings()
}

function saveLimitPreferences(hidden) {
  hiddenLimitIDs = hidden
  try { localStorage.setItem(LIMIT_PREFERENCES_KEY, JSON.stringify(hidden)) }
  catch { toast('Выбор лимитов изменён, но браузер не разрешил сохранить настройки', 5000) }
  paintLimits()
  void refreshLimits(true)
}

export function refreshLimits(force = false) { return coalesceLimits(refreshLimitsOnce, force) }

async function refreshLimitsOnce() {
  const panel = $('providerLimits')
  if (!panel) return
  if (!panel._lastMarkup) panel.classList.add('loading-limits')
  try {
    const sessionID = sessionIdFromHash()
    const directory = await selectedDirectory()
    const params = new URLSearchParams()
    if (directory) params.set('location[directory]', directory)
    const [catalog, config] = await Promise.all([request(`/api/model?${params}`), request('/client-config.json')])
    const models = dataOf(catalog)
    if (!Array.isArray(models)) throw new Error('Список подключённых моделей недоступен')
    if (sessionIdFromHash() !== sessionID) return
    limitModels = models
    limitOptions = { alibabaEnabled: config?.alibabaLimitsEnabled !== false }
    paintLimits()
    const selection = selectedLimitIDs(limitModels, hiddenLimitIDs, limitOptions)
    if (!selection.length) return
    const value = await request(`/client-limits.json?sources=${trackedLimitSources(selection).join(',')}`)
    if (sessionIdFromHash() !== sessionID || selection.join() !== selectedLimitIDs(limitModels, hiddenLimitIDs, limitOptions).join()) return
    lastLimits = { ...value, ...(selection.some((id) => id.startsWith('codex.')) ? {openai:stableOpenAILimits(value?.openai)} : {}) }
    paintLimits()
  } catch (error) {
    if (!panel._lastMarkup) panel.innerHTML = `<div class="quota-note">Не удалось обновить: ${escapeHtml(error.message)}</div>`
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
  if (!force && cached && (cached.pending || Date.now() - cached.at < COMMAND_CACHE_MS)) return cached.pending || cached.items
  const params = new URLSearchParams()
  if (directory) params.set('location[directory]', directory)
  const pending = request(`/api/command${params.size ? `?${params}` : ''}`).then((value) => {
    const raw = dataOf(value)
    const items = (Array.isArray(raw) ? raw : []).map((item) => typeof item === 'string' ? { name:item } : item).filter((item) => commandName(item) && !RETIRED_COMMANDS.has(commandName(item).toLowerCase()))
    commandCache.set(directory, { at:Date.now(), items })
    return items
  }, (error) => { commandCache.delete(directory); throw error })
  commandCache.set(directory, { at:0, items:[], pending })
  return pending
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

let paletteSeq = 0
async function updatePalette() {
  const query = slashQuery()
  const seq = ++paletteSeq
  if (query === null) { closePalette(); return }
  try {
    const commands = await loadCommands()
    // Out-of-order answers must not overwrite the palette for newer input.
    if (seq !== paletteSeq || slashQuery() !== query) return
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
  // Commands without an open chat run in a quick scratch session; clicking
  // "new session" only opened the project picker and timed out.
  const quick = window.CustomOpenCodeControls?.ensureQuickSession
  if (quick) { const session = await quick(); if (session?.id) return session.id }
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
  const input = $('input')
  if (RETIRED_COMMANDS.has(parsed.command.toLowerCase())) {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles:true }))
    closePalette()
    toast('Команда /doctor удалена', 4000)
    return
  }
  if (slashPending) return
  slashPending = true
  // Clear before the POST so a double Enter cannot run the command twice;
  // restore the text if it fails.
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles:true }))
  closePalette()
  try {
    const sessionID = await ensureSessionID()
    const body = { name:parsed.command, text:parsed.arguments }
    await request(`/api/session/${encodeURIComponent(sessionID)}/command`, { method:'POST', body:JSON.stringify(body) })
    toast(`/${parsed.command} выполнена`)
    setTimeout(() => $('refresh')?.click(), 250)
  } catch (error) {
    if (!input.value) { input.value = value; input.dispatchEvent(new Event('input', { bubbles:true })) }
    throw error
  } finally {
    slashPending = false
  }
}
let slashPending = false

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
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !window.matchMedia('(max-width: 760px)').matches && paletteItems.length && !input.value.trim().includes(' ')) {
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

export async function initializeEnhancements() {
  bindSlashCommands()
  $('limitChoices')?.addEventListener('change', (event) => {
    const id = event.target.dataset.limitId
    if (!LIMIT_DEFS.some((limit) => limit.id === id)) return
    saveLimitPreferences(event.target.checked ? hiddenLimitIDs.filter((hidden) => hidden !== id) : [...new Set([...hiddenLimitIDs, id])])
  })
  $('limitsHideAll')?.addEventListener('click', () => saveLimitPreferences(LIMIT_DEFS.map((limit) => limit.id)))
  $('limitsReset')?.addEventListener('click', () => saveLimitPreferences([]))
  void refreshLimits()
  limitsTimer = setInterval(() => { if (!document.hidden) refreshLimits() }, 60_000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLimits() })
  window.addEventListener('custom-rate-limit', () => { void refreshLimits() })
  window.addEventListener('custom-opencode:session-selected', () => { void refreshLimits(true) })
  window.addEventListener('hashchange', () => { void refreshLimits(true) })
  window.addEventListener('custom-opencode:event', (event) => {
    if (['model.updated', 'provider.updated'].includes(event.detail?.type)) void refreshLimits(true)
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== LIMIT_PREFERENCES_KEY && event.key !== null) return
    hiddenLimitIDs = readLimitPreferences()
    paintLimits()
    void refreshLimits(true)
  })
}

if (typeof document !== 'undefined') initializeEnhancements().catch((error) => console.warn('enhancements init failed', error))
