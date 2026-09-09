import { createAdaptivePoller, createRefreshCoalescer } from './refresh-coalescer.js'

const $ = (id) => document.getElementById(id)

const state = {
  sessionID: null,
  session: null,
  directory: '',
  settings: null,
  queue: { count:0, items:[], error:null },
  queueCounts: {},
  question: null,
  questionKey: '',
  questionDataKey: '',
  questionSource: '',
  questionActionPending: false,
  questionDeferred: null,
  questionTransport: 'unknown',
  questionRevision: 0,
  questionRefreshSeq: 0,
  queueRefreshSeq: 0,
  orchestrationRefreshSeq: 0,
  planRefreshSeq: 0,
  questionSelection: [],
  pendingPermission: null,
  children: [],
  childrenTransport: 'unknown',
  childDetails: new Map(),
  orchestrationStatuses: {},
  plan: null,
  activityItems: [],
  currentActivityID: '',
  activityHydrated: false,
  activityHydrating: false,
  orchestrationRevision: 0,
  orchestrationRenderRevision: 0,
  orchestrationRenderFrame: null,
  runStartedAt: null,
  lastDurationMs: 0,
  attachments: [],
  attachmentReads: [],
  submitPending: false,
  reviewDiffs: [],
}

const selectedSessionRefresh = createRefreshCoalescer()
const queueRefresh = createRefreshCoalescer()
const questionRefresh = createRefreshCoalescer()
const permissionRefresh = createRefreshCoalescer()
const orchestrationRefresh = createRefreshCoalescer()
const planRefresh = createRefreshCoalescer()

const DEFAULT_SETTINGS = {
  instructions: '',
  defaultMode: 'inherit',
  defaultModel: 'inherit',
  rag: 'auto',
  permissionRules: [],
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char])
}
function dataOf(value) { return value && typeof value === 'object' && 'data' in value ? value.data : value }
function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return min < 60 ? `${min}m ${rest}s` : `${Math.floor(min / 60)}h ${min % 60}m`
}
function fmtTime(value) {
  if (!value) return ''
  try { return new Date(value).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }) } catch { return '' }
}
function currentProfile() { return document.documentElement.dataset.modelProfile || 'direct' }
function currentMode() { return document.documentElement.dataset.executionMode || 'build' }
function running() { return Boolean($('stop') && !$('stop').hidden) }
function toast(text, ms = 2800) {
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(el._advancedTimer)
  el._advancedTimer = setTimeout(() => { el.hidden = true }, ms)
}
function sessionFromHash() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash || '')
  return match ? decodeURIComponent(match[1]) : null
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  return type.includes('application/json') ? response.json() : response.text()
}
function workspaceQuery(directory = state.directory) {
  const params = new URLSearchParams()
  if (directory) params.set('location[directory]', directory)
  return params.toString()
}

function ensureSurfaces() {
  if (!$('questionHost')) {
    const host = document.createElement('div')
    host.id = 'questionHost'
    host.className = 'question-host'
    host.hidden = true
    $('permissionBanner')?.before(host)
  }
  if (!$('orchestrationTrace')) {
    const trace = document.createElement('div')
    trace.id = 'orchestrationTrace'
    trace.className = 'orchestration-trace'
    trace.hidden = true
    document.querySelector('.messages-frame')?.after(trace)
  }
  if (!$('workflowStatus')) {
    const bar = document.createElement('div')
    bar.id = 'workflowStatus'
    bar.className = 'workflow-status'
    bar.hidden = true
    document.querySelector('.composer-wrap')?.before(bar)
  }
  if (!$('projectSettingsButton')) {
    const button = document.createElement('button')
    button.id = 'projectSettingsButton'
    button.className = 'header-chip project-settings-open'
    button.type = 'button'
    button.title = 'Память и permission policy проекта'
    button.textContent = 'Project'
    button.hidden = true
    $('gitButton')?.after(button)
    button.addEventListener('click', openProjectSettings)
  }
  if (!$('queueDialog')) {
    const dialog = document.createElement('dialog')
    dialog.id = 'queueDialog'
    dialog.innerHTML = '<div class="modal workflow-modal"><div class="modal-head"><div><h3>Очередь</h3><div class="choice-meta">Хранится на сервере и продолжает работать после закрытия PWA</div></div><button class="icon" type="button" data-workflow-close="queueDialog">×</button></div><div id="queueDialogContent" class="queue-list"></div></div>'
    document.body.append(dialog)
  }
  if (!$('projectSettingsDialog')) {
    const dialog = document.createElement('dialog')
    dialog.id = 'projectSettingsDialog'
    dialog.innerHTML = `
      <form class="modal workflow-modal" id="projectSettingsForm">
        <div class="modal-head"><div><h3>Настройки проекта</h3><div id="projectSettingsPath" class="choice-meta"></div></div><button class="icon" type="button" data-workflow-close="projectSettingsDialog">×</button></div>
        <div class="workflow-section"><label class="workflow-label" for="projectInstructions">Постоянные инструкции проекта</label><textarea class="workflow-textarea" id="projectInstructions" placeholder="Например: перед завершением запускай pytest; не меняй public API без необходимости"></textarea><div class="workflow-note">Передаются OpenCode как system context, поэтому не засоряют текст пользовательского сообщения.</div></div>
        <div class="workflow-section"><div class="workflow-grid">
          <label><span class="workflow-label">Модель/profile по умолчанию</span><select class="workflow-select" id="projectDefaultModel"><option value="inherit">Не менять</option></select></label>
          <label><span class="workflow-label">RAG</span><select class="workflow-select" id="projectRag"><option value="auto">Auto</option><option value="on">Всегда подключать</option><option value="off">Не запускать автоматически</option></select></label>
        </div></div>
        <div class="workflow-section"><div class="modal-head"><div><strong>Permission policy</strong><div class="workflow-note">Первое совпавшее правило: allow / deny. Ask оставляет стандартную карточку.</div></div><button type="button" id="addPermissionRule">+ правило</button></div><div id="projectPermissionRules" class="workflow-rules"></div></div>
        <div class="workflow-actions"><button type="button" data-workflow-close="projectSettingsDialog">Отмена</button><button class="primary" type="submit">Сохранить</button></div>
      </form>`
    document.body.append(dialog)
    $('projectSettingsForm').addEventListener('submit', saveProjectSettings)
    $('addPermissionRule').addEventListener('click', () => addRuleRow({ action:'*', resource:'*', effect:'ask' }))
  }
  document.querySelectorAll('[data-workflow-close]').forEach((button) => {
    if (button.dataset.boundWorkflowClose) return
    button.dataset.boundWorkflowClose = '1'
    button.addEventListener('click', () => $(button.dataset.workflowClose)?.close())
  })
}

function refreshSelectedSession(force = false) { return selectedSessionRefresh(() => refreshSelectedSessionNow(), force) }
async function refreshSelectedSessionNow() {
  const id = sessionFromHash()
  if (id === state.sessionID && state.session) return
  state.sessionID = id
  resetSubmitControls()
  state.orchestrationRevision += 1
  state.queueRefreshSeq += 1
  state.orchestrationRefreshSeq += 1
  state.planRefreshSeq += 1
  state.session = null
  state.directory = ''
   state.settings = null
   state.queue = { count:0, items:[], error:null }
  state.question = null
  state.questionKey = ''
  state.questionDataKey = ''
  state.questionSource = ''
  state.questionActionPending = false
  state.questionDeferred = null
  state.questionTransport = 'unknown'
  state.questionRevision += 1
  state.questionRefreshSeq += 1
  state.questionSelection = []
  state.pendingPermission = null
  state.children = []
  state.childrenTransport = 'unknown'
  state.childDetails.clear()
   state.orchestrationStatuses = {}
   state.plan = null
   state.activityItems = []
    state.currentActivityID = ''
    state.activityHydrated = false
    state.activityHydrating = false
  state.attachments = []
  state.attachmentReads = []
  state.runStartedAt = running() ? Date.now() : null
  renderAll()
  if (!id) return
  try {
    const session = dataOf(await request(`/api/session/${encodeURIComponent(id)}`))
    if (state.sessionID !== id) return
    state.session = session
    state.directory = session?.location?.directory || ''
    $('projectSettingsButton').hidden = !state.directory
    await Promise.allSettled([loadProjectSettings(id), refreshQueue(id, true), refreshQuestions(true), refreshOrchestration(true), refreshPlan(true), refreshPermission(id, true)])
    if (state.sessionID !== id) return
    await applyProjectDefaultsOnce(id)
    if (state.sessionID !== id) return
    renderAll()
  } catch (error) {
    console.warn('advanced session load failed', error)
  }
}

async function loadProjectSettings(sessionID = state.sessionID) {
  if (!sessionID) return
  const value = await request(`/client-project-settings.json?sessionID=${encodeURIComponent(sessionID)}`)
  if (state.sessionID !== sessionID) return
  state.settings = { ...DEFAULT_SETTINGS, ...(value?.settings || {}) }
}

async function saveProjectSettings(event) {
  event.preventDefault()
  if (!state.sessionID) return
  const rules = [...$('projectPermissionRules').querySelectorAll('.workflow-rule')].map((row) => ({
    action: row.querySelector('[data-rule-action]').value.trim() || '*',
    resource: row.querySelector('[data-rule-resource]').value.trim() || '*',
    effect: row.querySelector('[data-rule-effect]').value,
  }))
  const settings = {
    instructions: $('projectInstructions').value,
    defaultMode: state.settings?.defaultMode || 'inherit',
    defaultModel: $('projectDefaultModel').value,
    rag: $('projectRag').value,
    permissionRules: rules,
  }
  try {
    const value = await request('/client-project-settings.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, settings }) })
    state.settings = { ...DEFAULT_SETTINGS, ...(value?.settings || settings) }
    $('projectSettingsDialog').close()
    toast('Настройки проекта сохранены')
  } catch (error) { toast(`Настройки проекта: ${error.message}`, 5000) }
}

function addRuleRow(rule) {
  const row = document.createElement('div')
  row.className = 'workflow-rule'
  row.innerHTML = `<input class="workflow-input" data-rule-action placeholder="action" value="${escapeHtml(rule?.action || '*')}"><input class="workflow-input" data-rule-resource placeholder="resource glob" value="${escapeHtml(rule?.resource || '*')}"><select class="workflow-select" data-rule-effect><option value="ask">ask</option><option value="allow">allow</option><option value="deny">deny</option></select><button type="button" class="workflow-button-danger" data-remove-rule>×</button>`
  row.querySelector('[data-rule-effect]').value = ['allow','deny','ask'].includes(rule?.effect) ? rule.effect : 'ask'
  row.querySelector('[data-remove-rule]').addEventListener('click', () => row.remove())
  $('projectPermissionRules').append(row)
}

function syncProjectModelOptions() {
  const select = $('projectDefaultModel')
  if (!select) return
  const current = select.value
  const options = new Map([
    ['inherit', 'Не менять'],
    ['orchestrated', 'Qwen 3.8 Max · Оркестрированная'],
    ['sol-orchestrated', 'GPT-5.6 Sol · Оркестрированная'],
  ])
  for (const model of state.models || []) {
    const provider = String(model?.providerID || '')
    const id = String(model?.id || '')
    if (!provider || !id || provider === 'ollama') continue
    options.set(`${provider}/${id}`, `${model?.name || id} · ${provider}`)
  }
  select.innerHTML = [...options].map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')
  select.value = options.has(current) ? current : 'inherit'
}

function openProjectSettings() {
  if (!state.sessionID || !state.directory) return
  syncProjectModelOptions()
  const settings = state.settings || DEFAULT_SETTINGS
  $('projectSettingsPath').textContent = state.directory
  $('projectInstructions').value = settings.instructions || ''
  $('projectDefaultModel').value = settings.defaultModel || 'inherit'
  $('projectRag').value = settings.rag || 'auto'
  $('projectPermissionRules').innerHTML = ''
  for (const rule of settings.permissionRules || []) addRuleRow(rule)
  $('projectSettingsDialog').showModal()
}

async function applyProjectDefaultsOnce(sessionID = state.sessionID) {
  if (!sessionID || state.sessionID !== sessionID || !state.settings) return
  const key = `opencode:web:project-defaults:${sessionID}`
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  try {
    const rows = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/message?limit=1`))
    if (state.sessionID !== sessionID) return
    if (Array.isArray(rows) && rows.length) return
  } catch {}
  if (state.sessionID !== sessionID) return
  const settings = state.settings
  if (settings.defaultModel === 'orchestrated' || settings.defaultModel === 'sol-orchestrated') window.CustomOpenCodeUX?.setProfile?.(settings.defaultModel)
  else if (typeof settings.defaultModel === 'string' && settings.defaultModel.includes('/')) {
    await chooseConcreteModel(settings.defaultModel)
  }
  if (settings.rag === 'on') {
    request('/client-rag-start.json', { method:'POST', body:JSON.stringify({ mode:'quick', sessionID }) }).catch(() => {})
  }
}

async function chooseConcreteModel(ref) {
  const [provider, ...rest] = ref.split('/')
  const model = rest.join('/')
  if (!provider || !model || provider === 'ollama') return
  $('modelButton')?.click()
  await new Promise((resolve) => setTimeout(resolve, 40))
  document.querySelector(`#modelChoices [data-model="${CSS.escape(model)}"][data-provider="${CSS.escape(provider)}"]`)?.click()
}

function readAttachment(file, slot, sessionID = state.sessionID, revision = state.orchestrationRevision, attachments = state.attachments) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = { uri:reader.result, name:file.name || `file-${Date.now()}`, mime:file.type || 'application/octet-stream' }
      if (state.sessionID === sessionID && state.orchestrationRevision === revision && state.attachments === attachments) attachments[slot] = value
      resolve(value)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
function captureFiles(files) {
  const sessionID = state.sessionID, revision = state.orchestrationRevision, attachments = state.attachments
  for (const file of [...(files || [])]) {
    if (!file) continue
    const slot = state.attachments.length
    state.attachments.push(null)
    state.attachmentReads.push(readAttachment(file, slot, sessionID, revision, attachments).catch((error) => {
      if (state.sessionID === sessionID && state.orchestrationRevision === revision && state.attachments === attachments) attachments[slot] = null
      console.warn('attachment mirror failed', error)
    }))
  }
}
async function awaitAttachments(attachments = state.attachments, reads = state.attachmentReads) {
  const pending = [...reads]
  if (state.attachments === attachments && state.attachmentReads === reads) state.attachmentReads = []
  if (pending.length) await Promise.allSettled(pending)
  return attachments.filter(Boolean)
}
function clearComposer() {
  const input = $('input')
  if (input) {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles:true }))
  }
  const removes = [...document.querySelectorAll('[data-remove-attachment]')]
  state.attachments = []
  state.attachmentReads = []
  for (const button of removes) button.click()
}
function resetSubmitControls() {
  state.submitPending = false
  const input = $('input'), action = $('composerAction'), attach = $('attachButton')
  if (input) { input.disabled = false; input.dispatchEvent(new Event('input', { bubbles:true })) }
  if (action) action.disabled = false
  if (attach) attach.disabled = false
}

async function interceptSubmit(event) {
  if (!state.sessionID) return
  if (document.documentElement.dataset.modelTransition === '1') { event.preventDefault(); return }
  const text = $('input')?.value.trim() || ''
  if (text.startsWith('/') && !text.startsWith('//')) return
  const hasAttachmentSurface = Boolean($('attachments') && !$('attachments').hidden && $('attachments').children.length)
  if (!text && !hasAttachmentSurface && !state.attachments.length && !state.attachmentReads.length) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (state.submitPending) return
  state.submitPending = true
  const sessionID = state.sessionID, revision = state.orchestrationRevision, attachments = state.attachments, reads = state.attachmentReads
  const input = $('input'),action = $('composerAction'),attach = $('attachButton')
  if (input) { input.value = ''; input.disabled = true; input.dispatchEvent(new Event('input', { bubbles:true })) }
  if (action) action.disabled = true
  if (attach) attach.disabled = true
  try {
    const files = await awaitAttachments(attachments, reads)
    if (state.sessionID !== sessionID || state.orchestrationRevision !== revision) return
    const profile = currentProfile() === 'orchestrated' ? 'orchestrated' : 'direct'
    if (running()) {
      await request('/client-queue.json', { method:'POST', body:JSON.stringify({ sessionID, text, files, profile }) })
      if (state.sessionID !== sessionID || state.orchestrationRevision !== revision) return
      clearComposer()
      await refreshQueue(undefined, true)
      toast('Добавлено в серверную очередь')
      return
    }
    const accepted = await request('/client-send.json', { method:'POST', body:JSON.stringify({ sessionID, text, files, profile }) })
    if (state.sessionID !== sessionID || state.orchestrationRevision !== revision) return
    clearComposer()
    window.CustomOpenCodeControls?.startRun?.(sessionID, 'managed-send')
    if ($('stop')) $('stop').hidden = false
    if (!state.runStartedAt) state.runStartedAt = Date.now()
    renderStatus()
    if (accepted?.queued) {
      await refreshQueue(undefined, true)
      if (state.sessionID !== sessionID || state.orchestrationRevision !== revision) return
      toast('Добавлено в серверную очередь')
    } else toast('Отправлено', 1300)
    setTimeout(() => refreshOrchestration(true), 300)
  } catch (error) {
    if (state.sessionID === sessionID && state.orchestrationRevision === revision && input) input.value = text
    if (state.sessionID === sessionID && state.orchestrationRevision === revision) toast(`Отправка: ${error.message}`, 6000)
  } finally {
    if (state.sessionID === sessionID && state.orchestrationRevision === revision) resetSubmitControls()
  }
}

function refreshQueue(sessionID = state.sessionID, force = false) { return queueRefresh(() => refreshQueueNow(state.sessionID || sessionID), force) }
async function refreshQueueNow(sessionID = state.sessionID) {
  if (!sessionID) return
  const revision = state.orchestrationRevision
  const refreshSeq = ++state.queueRefreshSeq
  const current = () => state.sessionID === sessionID && state.orchestrationRevision === revision && state.queueRefreshSeq === refreshSeq
  try {
    const [selected, global] = await Promise.all([
      request(`/client-queue.json?sessionID=${encodeURIComponent(sessionID)}`),
      request('/client-queue.json'),
    ])
    if (!current()) return
    state.queue = selected || { count:0, items:[] }
    state.queueCounts = global?.counts || {}
    syncQueueBadges()
    renderQueueDialog()
    renderStatus()
    if (state.queue?.error) notifyAdvanced('OpenCode: очередь остановлена', state.queue.error, `queue-error-${state.sessionID}`)
  } catch {}
}
function syncQueueBadges() {
  // ВАЖНО: этот же колбэк повешен на MutationObserver(#sessions, childList+subtree).
  // Безусловное «удалить все бейджи и вставить заново» даёт мутацию на каждый
  // вызов и зацикливает observer намертво, как только очередь не пуста.
  // Поэтому сводим DOM к целевому состоянию минимальными правками.
  const counts = state.queueCounts || {}
  document.querySelectorAll('[data-persistent-queue]').forEach((el) => {
    const sessionID = el.closest('[data-session]')?.dataset.session
    const count = counts[sessionID]
    if (!count) { el.remove(); return }
    const text = `очередь ${count}`
    if (el.textContent !== text) el.textContent = text
  })
  for (const [sessionID, count] of Object.entries(counts)) {
    if (!count) continue
    const button = document.querySelector(`[data-session="${CSS.escape(sessionID)}"]`)
    const meta = button?.querySelector('.session-meta')
    if (!meta || meta.querySelector('[data-persistent-queue]')) continue
    const badge = document.createElement('span')
    badge.dataset.persistentQueue = '1'
    badge.className = 'queued'
    badge.textContent = `очередь ${count}`
    meta.append(badge)
  }
}
function renderQueueDialog() {
  const host = $('queueDialogContent')
  if (!host) return
  const items = state.queue?.items || []
  host.innerHTML = `${state.queue?.error ? `<div class="queue-error">${escapeHtml(state.queue.error)}</div>` : ''}${items.map((item, index) => `<div class="queue-item"><div class="queue-item-main"><div class="queue-item-text">${escapeHtml(item.text || (item.files?.length ? `[${item.files.length} attachment]` : ''))}</div><div class="queue-item-meta">${escapeHtml(item.profile || 'direct')} · ${fmtTime(item.createdAt)}${item.files?.length ? ` · файлов ${item.files.length}` : ''}</div></div><div class="queue-item-actions"><button type="button" data-queue-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-queue-down="${index}" ${index === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="workflow-button-danger" data-queue-delete="${escapeHtml(item.id)}">×</button></div></div>`).join('') || '<div class="empty">Очередь пуста.</div>'}`
  host.querySelectorAll('[data-queue-delete]').forEach((button) => button.addEventListener('click', () => deleteQueue(button.dataset.queueDelete)))
  host.querySelectorAll('[data-queue-up]').forEach((button) => button.addEventListener('click', () => moveQueue(Number(button.dataset.queueUp), -1)))
  host.querySelectorAll('[data-queue-down]').forEach((button) => button.addEventListener('click', () => moveQueue(Number(button.dataset.queueDown), 1)))
}
async function deleteQueue(id) {
  if (!state.sessionID) return
  try {
    await request(`/client-queue.json?sessionID=${encodeURIComponent(state.sessionID)}&id=${encodeURIComponent(id)}`, { method:'DELETE' })
    await refreshQueue(undefined, true)
  } catch (error) { toast(error.message) }
}
async function moveQueue(index, delta) {
  const items = [...(state.queue?.items || [])]
  const next = index + delta
  if (next < 0 || next >= items.length) return
  ;[items[index], items[next]] = [items[next], items[index]]
  try {
    await request('/client-queue.json', { method:'PATCH', body:JSON.stringify({ sessionID:state.sessionID, ids:items.map((item) => item.id) }) })
    await refreshQueue(undefined, true)
  } catch (error) { toast(error.message) }
}
function openQueueDialog() { renderQueueDialog(); $('queueDialog')?.showModal() }

function normalizeQuestionOptions(options) {
  return (Array.isArray(options) ? options : []).map((option) => {
    if (typeof option === 'string') return { label:option, value:option, description:'' }
    const label = String(option?.label || option?.value || '')
    return { label, value:String(option?.value ?? label), description:String(option?.description || '') }
  }).filter((option) => option.label)
}
function questionRequestSignature(requestRow) {
  try {
    return JSON.stringify({
      id: requestRow?.id,
      formID: requestRow?.formID,
      requestID: requestRow?.requestID,
      sessionID: requestRow?.sessionID,
      title: requestRow?.title,
      questions: requestRow?.questions,
    })
  } catch {
    return String(requestRow?.id || '')
  }
}
function setQuestionRequest(requestRow, source = 'poll') {
  const key = requestRow ? `${requestRow.sessionID}:${requestRow.id}` : ''
  const dataKey = requestRow ? questionRequestSignature(requestRow) : ''
  const identityChanged = key !== state.questionKey
  const dataChanged = dataKey !== state.questionDataKey
  if (!identityChanged && !dataChanged) {
    state.question = requestRow
    state.questionSource = requestRow ? source : ''
    return
  }
  state.questionKey = key
  state.questionDataKey = dataKey
  state.questionSource = requestRow ? source : ''
  state.question = requestRow
  state.questionSelection = requestRow ? questionSelectionFor(requestRow) : []
  renderQuestion()
  if (requestRow && identityChanged) {
    notifyAdvanced('OpenCode ждёт выбора', requestRow.questions[0]?.question || 'Нужно выбрать вариант', `question-${requestRow.id}`)
  }
}
function flushDeferredQuestion() {
  const requestRow = state.questionDeferred
  state.questionDeferred = null
  if (requestRow && !state.question) setQuestionRequest(requestRow, 'event')
}
export function normalizeQuestionRequest(raw, fallbackSessionID = state.sessionID) {
  if (!raw || typeof raw !== 'object') return null
  const embedded = raw.form || raw.request
  const candidate = embedded && typeof embedded === 'object' && !Array.isArray(embedded) ? embedded : raw
  const fields = Array.isArray(candidate.fields) ? candidate.fields : Array.isArray(candidate.form) ? candidate.form : Array.isArray(raw.form) ? raw.form : Array.isArray(raw.fields) ? raw.fields : []
  if (fields.length) {
    const formID = String(candidate.id || candidate.formID || raw.formID || '')
    const requestID = String(candidate.requestID || raw.requestID || '')
    return {
      id: formID || requestID || String(raw.id || ''),
      formID,
      requestID,
      sessionID: String(candidate.sessionID || raw.sessionID || fallbackSessionID || ''),
      transport: 'form',
      title: String(candidate.title || 'Нужен ввод'),
      raw,
      questions: fields.map((field, index) => {
        const type = String(field?.type || 'string').toLowerCase()
        return {
          key: String(field?.key || `field_${index + 1}`),
          header: String(field?.title || field?.key || `Поле ${index + 1}`),
          question: String(field?.description || field?.title || field?.key || ''),
          type,
          required: Boolean(field?.required),
          custom: ['string', 'text', 'number', 'integer', 'multiselect'].includes(type) && field?.custom !== false,
          multiple: type === 'multiselect',
          default: field?.default,
          minimum: field?.minimum,
          maximum: field?.maximum,
          placeholder: String(field?.placeholder || ''),
          options: normalizeQuestionOptions(field?.options),
        }
      }),
    }
  }
  const questions = Array.isArray(candidate.questions) ? [...candidate.questions] : Array.isArray(candidate.question) ? [...candidate.question] : []
  if (!questions.length && candidate.question && typeof candidate.question === 'string') {
    questions.push({ question:candidate.question, header:candidate.header, options:candidate.options, multiple:candidate.multiple, custom:candidate.custom })
  }
  if (!questions.length) return null
  const requestID = String(candidate.requestID || raw.requestID || candidate.id || raw.id || '')
  return {
    id: requestID,
    requestID,
    sessionID: String(candidate.sessionID || raw.sessionID || fallbackSessionID || ''),
    transport: 'question',
    title: String(candidate.title || ''),
    raw,
    questions: questions.map((question, index) => ({
      key: String(question?.key || `question_${index + 1}`),
      header: String(question?.header || `Вопрос ${index + 1}`),
      question: String(question?.question || question?.text || ''),
      type: 'string',
      required: true,
      custom: question?.custom !== false,
      multiple: Boolean(question?.multiple),
      options: normalizeQuestionOptions(question?.options),
    })),
  }
}
export function questionSelectionFor(request) {
  return (request?.questions || []).map((question) => {
    const selected = new Set()
    let custom = ''
    const value = question?.default
    if (question?.multiple && Array.isArray(value)) {
      value.forEach((item) => selected.add(String(item)))
    } else if (value !== undefined && value !== null) {
      const text = String(value)
      if (question?.options?.some((option) => option.value === text)) selected.add(text)
      else custom = text
    }
    return { selected, custom }
  })
}
async function questionRequests() {
  if (!state.sessionID) return []
  const q = workspaceQuery()
  if (state.questionTransport !== 'question' && state.questionTransport !== 'unsupported') {
    try {
      const value = dataOf(await request(`/api/form/request${q ? `?${q}` : ''}`))
      state.questionTransport = 'form'
      return Array.isArray(value) ? value.map((item) => normalizeQuestionRequest(item)).filter((item) => item && item.sessionID === state.sessionID) : []
    } catch (error) {
      if (![404,405].includes(error.status)) {
        console.debug('form endpoint', error)
        return []
      }
      state.questionTransport = 'question'
    }
  }
  if (state.questionTransport !== 'unsupported') {
    try {
      const value = dataOf(await request(`/api/question${q ? `?${q}` : ''}`))
      state.questionTransport = 'question'
      return Array.isArray(value) ? value.map((item) => normalizeQuestionRequest(item)).filter((item) => item && item.sessionID === state.sessionID) : []
    } catch (error) {
      if (![404,405].includes(error.status)) console.debug('question endpoint', error)
      else state.questionTransport = 'unsupported'
    }
  }
  return []
}
function refreshQuestions(force = false) { return questionRefresh(() => refreshQuestionsNow(), force) }
async function refreshQuestionsNow() {
  if (!state.sessionID) {
    if (state.questionKey) { state.question = null; state.questionKey = ''; renderQuestion() }
    return
  }
  const sessionID = state.sessionID
  const revision = state.questionRevision
  const refreshSeq = ++state.questionRefreshSeq
  try {
    const requests = await questionRequests()
    if (state.sessionID !== sessionID || state.questionRevision !== revision || state.questionRefreshSeq !== refreshSeq) return
    const requestRow = requests.find((item) => item?.id) || null
    if (!requestRow && state.questionSource === 'event') return
    setQuestionRequest(requestRow, 'poll')
  } catch {}
}
function renderQuestion() {
  const host = $('questionHost')
  if (!host) return
  const requestRow = state.question
  host.hidden = !requestRow
  if (!requestRow) { host.innerHTML = ''; return }
  host.innerHTML = `<div class="question-card"><div class="question-head"><div><div class="question-kicker">Нужен твой выбор</div><div class="question-title">${escapeHtml(requestRow.title || (requestRow.questions.length > 1 ? `Вопросов: ${requestRow.questions.length}` : requestRow.questions[0].header))}</div></div><button class="question-close" type="button" data-question-reject title="Отклонить вопрос">×</button></div><div class="question-sections">${requestRow.questions.map((question, qIndex) => `<div class="question-section ${question.multiple ? 'multiple' : ''}" data-question-index="${qIndex}"><div><div class="question-kicker">${escapeHtml(question.header)}</div><div class="question-section-title">${escapeHtml(question.question)}</div></div><div class="question-options">${question.options.map((option, oIndex) => `<button type="button" class="question-option" data-question-option="${qIndex}:${oIndex}"><span class="question-option-mark"></span><span class="question-option-text"><span class="question-option-label">${escapeHtml(option.label)}</span>${option.description ? `<span class="question-option-description">${escapeHtml(option.description)}</span>` : ''}</span></button>`).join('')}</div>${question.type === 'boolean' ? `<div class="question-custom question-boolean"><label for="question-boolean-${qIndex}">Значение</label><select id="question-boolean-${qIndex}" data-question-boolean="${qIndex}"><option value="">Выбрать…</option><option value="true" ${state.questionSelection[qIndex]?.custom === 'true' ? 'selected' : ''}>Да</option><option value="false" ${state.questionSelection[qIndex]?.custom === 'false' ? 'selected' : ''}>Нет</option></select></div>` : question.custom !== false ? `<div class="question-custom"><input data-question-custom="${qIndex}" type="${['number','integer'].includes(question.type) ? 'number' : 'text'}" ${question.type === 'integer' ? 'step="1"' : question.type === 'number' ? 'step="any"' : ''} ${question.minimum !== undefined ? `min="${escapeHtml(question.minimum)}"` : ''} ${question.maximum !== undefined ? `max="${escapeHtml(question.maximum)}"` : ''} value="${escapeHtml(state.questionSelection[qIndex]?.custom || '')}" placeholder="${escapeHtml(question.placeholder || 'Свой вариант…')}"><button type="button" data-question-custom-use="${qIndex}">Использовать</button></div>` : ''}</div>`).join('')}</div><div class="question-actions"><button type="button" data-question-reject>Отмена</button><button type="button" class="primary" data-question-submit>Продолжить</button></div></div>`
  for (let qIndex = 0; qIndex < requestRow.questions.length; qIndex++) syncQuestionSection(qIndex)
  host.querySelectorAll('[data-question-option]').forEach((button) => button.addEventListener('click', () => {
    const [qIndexText, optionIndexText] = button.dataset.questionOption.split(':')
    const qIndex = Number(qIndexText), optionIndex = Number(optionIndexText)
    const question = requestRow.questions[qIndex], selection = state.questionSelection[qIndex]
    const option = question.options[optionIndex]
    const value = option?.value || option?.label
    if (!value) return
    if (!question.multiple) selection.selected.clear()
    selection.selected.has(value) ? selection.selected.delete(value) : selection.selected.add(value)
    if (!question.multiple && selection.selected.size) {
      selection.custom = ''
      const input = host.querySelector(`[data-question-custom="${qIndex}"]`)
      if (input) input.value = ''
    }
    syncQuestionSection(qIndex)
  }))
  host.querySelectorAll('[data-question-custom]').forEach((input) => input.addEventListener('input', () => {
    const qIndex = Number(input.dataset.questionCustom)
    state.questionSelection[qIndex].custom = input.value
    if (input.value.trim() && !requestRow.questions[qIndex].multiple) state.questionSelection[qIndex].selected.clear()
    syncQuestionSection(qIndex)
  }))
  host.querySelectorAll('[data-question-boolean]').forEach((input) => input.addEventListener('change', () => {
    const qIndex = Number(input.dataset.questionBoolean)
    state.questionSelection[qIndex].custom = input.value
  }))
  host.querySelector('[data-question-submit]')?.addEventListener('click', submitQuestion)
  host.querySelectorAll('[data-question-reject]').forEach((button) => button.addEventListener('click', rejectQuestion))
}
function syncQuestionSection(qIndex) {
  const host = $('questionHost')
  const question = state.question?.questions?.[qIndex]
  const selection = state.questionSelection?.[qIndex]
  if (!host || !question || !selection) return
  host.querySelectorAll(`[data-question-option^="${qIndex}:"]`).forEach((button) => {
    const optionIndex = Number(button.dataset.questionOption.split(':')[1])
    const selected = selection.selected.has(question.options[optionIndex]?.value || question.options[optionIndex]?.label)
    button.classList.toggle('selected', selected)
    button.querySelector('.question-option-mark').textContent = selected ? '✓' : ''
  })
}
export function formQuestionValue(question, selection) {
  const values = [...(selection?.selected || [])]
  const custom = String(selection?.custom || '').trim()
  if (question.multiple) {
    if (custom && !values.includes(custom)) values.push(custom)
    return values.length ? values : undefined
  }
  let value = custom || values[0]
  if (value === undefined || value === '') return undefined
  if (question.type === 'number' || question.type === 'integer') {
    const number = Number(value)
    if (!Number.isFinite(number) || (question.type === 'integer' && !Number.isInteger(number))) return undefined
    if (question.minimum !== undefined && number < Number(question.minimum)) return undefined
    if (question.maximum !== undefined && number > Number(question.maximum)) return undefined
    return number
  }
  if (question.type === 'boolean') {
    if (/^(true|yes|1)$/i.test(String(value))) return true
    if (/^(false|no|0)$/i.test(String(value))) return false
    return undefined
  }
  return value
}
export function questionAnswers(request = state.question, selections = state.questionSelection) {
  if (request?.transport === 'form') {
    const answer = {}
    request.questions.forEach((question, index) => {
      const value = formQuestionValue(question, selections[index])
      if (value !== undefined) answer[question.key] = value
    })
    return answer
  }
  return (request?.questions || []).map((question, index) => {
    const selection = selections[index] || { selected:new Set(), custom:'' }
    const values = [...(selection.selected || [])]
    const custom = String(selection.custom || '').trim()
    if (custom) {
      if (!question.multiple) return [custom]
      if (!values.includes(custom)) values.push(custom)
    }
    return values
  })
}
export function questionAnswersMissing(answers, request = state.question) {
  if (request?.transport === 'form') {
    return request.questions.some((question) => question.required && !Object.prototype.hasOwnProperty.call(answers, question.key))
  }
  return answers.some((row) => !row.length)
}
async function submitQuestion() {
  if (!state.question) return
  const requestRow = state.question
  const requestKey = state.questionKey
  const answers = questionAnswers(requestRow, state.questionSelection)
  if (questionAnswersMissing(answers, requestRow)) { toast('Нужно ответить на каждый вопрос'); return }
  const qid = requestRow.formID || requestRow.requestID || requestRow.id
  const q = workspaceQuery()
  state.questionActionPending = true
  try {
    const sid = encodeURIComponent(requestRow.sessionID || state.sessionID)
    const target = requestRow.transport === 'form'
      ? `/api/session/${sid}/form/${encodeURIComponent(qid)}/reply`
      : `/api/question/${encodeURIComponent(qid)}/reply${q ? `?${q}` : ''}`
    const body = requestRow.transport === 'form' ? { answer:answers } : { answers }
    await request(target, { method:'POST', body:JSON.stringify(body) })
    if (state.questionKey !== requestKey) {
      state.questionActionPending = false
      flushDeferredQuestion()
      toast('Ответ отправлен')
      return
    }
    state.questionActionPending = false
    state.questionRevision += 1
    setQuestionRequest(null)
    flushDeferredQuestion()
    toast('Ответ отправлен')
  } catch (error) {
    state.questionActionPending = false
    state.questionDeferred = null
    toast(`Ответ: ${error.message || 'не удалось отправить'}`, 6000)
  }
}
async function rejectQuestion() {
  if (!state.question) return
  const requestRow = state.question
  const requestKey = state.questionKey
  const qid = requestRow.formID || requestRow.requestID || requestRow.id
  const q = workspaceQuery()
  state.questionActionPending = true
  try {
    const sid = encodeURIComponent(requestRow.sessionID || state.sessionID)
    const target = requestRow.transport === 'form'
      ? `/api/session/${sid}/form/${encodeURIComponent(qid)}/cancel`
      : `/api/question/${encodeURIComponent(qid)}/reject${q ? `?${q}` : ''}`
    await request(target, { method:'POST', body:'{}' })
    if (state.questionKey !== requestKey) {
      state.questionActionPending = false
      flushDeferredQuestion()
      toast('Вопрос отклонён')
      return
    }
    state.questionActionPending = false
    state.questionRevision += 1
    setQuestionRequest(null)
    flushDeferredQuestion()
    toast('Вопрос отклонён')
  } catch (error) {
    state.questionActionPending = false
    state.questionDeferred = null
    toast(`Вопрос: ${error.message || 'не удалось отклонить'}`, 6000)
  }
}

function handleQuestionEvent(payload) {
  const type = String(payload?.type || '')
  const asked = ['question.asked', 'question.v2.asked', 'form.asked', 'form.created', 'form.requested'].includes(type)
  const settled = ['question.replied', 'question.rejected', 'question.v2.replied', 'question.v2.rejected', 'form.replied', 'form.rejected', 'form.cancelled'].includes(type)
  if (!asked && !settled) return
  const data = payload.properties || payload.data || {}
  const candidate = data.form || data.request || data
  const sessionID = candidate.sessionID || data.sessionID
  if (String(sessionID || '') !== String(state.sessionID || '')) return
  state.questionRevision += 1
  if (asked) {
    const requestRow = normalizeQuestionRequest(data, sessionID)
    if (!requestRow?.id) { refreshQuestions(true); return }
    const nextKey = `${requestRow.sessionID}:${requestRow.id}`
    if (state.question && state.questionKey && nextKey !== state.questionKey) {
      if (state.questionActionPending) state.questionDeferred = requestRow
      return
    }
    setQuestionRequest(requestRow, 'event')
    return
  }
   const requestIDs = [data.requestID, data.formID, candidate.requestID, candidate.formID, candidate.id].map((value) => String(value || '')).filter(Boolean)
   const activeIDs = [state.question?.id, state.question?.formID, state.question?.requestID].map((value) => String(value || '')).filter(Boolean)
   if (!requestIDs.length || requestIDs.some((id) => activeIDs.includes(id))) {
    state.question = null
    state.questionKey = ''
    state.questionDataKey = ''
    state.questionSource = ''
    state.questionSelection = []
    renderQuestion()
  }
  refreshQuestions(true)
}

function refreshPermission(sessionID = state.sessionID, force = false) { return permissionRefresh(() => refreshPermissionNow(state.sessionID || sessionID), force) }
async function refreshPermissionNow(sessionID = state.sessionID) {
  if (!sessionID || !state.directory) { if (state.sessionID === sessionID) { state.pendingPermission = null; syncPermissionProjectButton() }; return }
  const q = workspaceQuery()
  try {
    const value = dataOf(await request(`/api/permission/request${q ? `?${q}` : ''}`))
    if (state.sessionID !== sessionID) return
    state.pendingPermission = Array.isArray(value) ? value.find((item) => item?.sessionID === sessionID) || null : null
  } catch { if (state.sessionID === sessionID) state.pendingPermission = null }
  if (state.sessionID !== sessionID) return
  syncPermissionProjectButton()
}
function syncPermissionProjectButton() {
  const actions = document.querySelector('#permissionBanner .permission-actions')
  if (!actions) return
  let button = actions.querySelector('.permission-project-button')
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'permission-project-button'
    button.textContent = 'Разрешать в проекте'
    button.addEventListener('click', allowPermissionInProject)
    actions.append(button)
  }
  button.hidden = !$('permissionBanner') || $('permissionBanner').hidden || !state.pendingPermission
}
async function allowPermissionInProject() {
  const p = state.pendingPermission
  if (!p || !state.sessionID) return
  const resources = p.resources || p.patterns || p.always || []
  const resource = Array.isArray(resources) ? String(resources[0] || '*') : String(resources || '*')
  const action = String(p.action || p.permission || '*')
  try {
    const value = await request('/client-project-settings.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, addPermission:{ action, resource, effect:'allow' } }) })
    state.settings = { ...DEFAULT_SETTINGS, ...(value?.settings || state.settings || {}) }
    document.querySelector('[data-permission="once"]')?.click()
    toast('Правило сохранено для проекта')
  } catch (error) { toast(`Permission policy: ${error.message}`, 5000) }
}

function childStatus(value) {
  const raw = typeof value === 'string' ? value : value?.type || value?.status || value?.state || ''
  return /busy|running|retry|working|pending/i.test(String(raw)) ? 'running' : /error|failed/i.test(String(raw)) ? 'error' : 'done'
}
function orchestrationPurpose(agent) {
  const value = String(agent || '').toLowerCase()
  if (/review|critic/.test(value)) return 'Независимая проверка результата · только чтение'
  if (/explore|reader|research/.test(value)) return 'Поиск по проекту и сбор фактов · только чтение'
  if (/build|builder|implement/.test(value)) return 'Внесение изменений в проект'
  if (/plan|architect/.test(value)) return 'Планирование и декомпозиция задачи'
  if (/aggregate|synth/.test(value)) return 'Сведение результатов дочерних вызовов'
  return 'Вспомогательный дочерний вызов'
}
function activityValue(value, limit = 12000) {
  if (value === undefined || value === null || value === '') return ''
  let text
  if (Array.isArray(value)) text = value.map((item) => item?.type === 'text' ? item.text || '' : item?.text || item?.name || JSON.stringify(item)).filter(Boolean).join('\n')
  else if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…обрезано…` : text
}
function activityModelLabel(data = {}) {
  const raw = data.model || data.modelID || data.modelRef
  if (raw && typeof raw === 'object') {
    const provider = raw.providerID || raw.provider || ''
    const id = raw.id || raw.modelID || raw.name || ''
    const variant = raw.variant ? `#${raw.variant}` : ''
    return `${provider ? `${provider}/` : ''}${id}${variant}` || 'модель'
  }
  return String(raw || $('modelButton')?.textContent || 'модель')
}
function activityKind(name, type = '') {
  const value = `${name || ''} ${type || ''}`.toLowerCase()
  if (/mcp|knowledge|rag|kb_/.test(value)) return 'mcp'
  if (/skill/.test(value)) return 'skill'
  if (/task|subagent|agent|model|reasoning|text/.test(value)) return 'model'
  return 'tool'
}
function activityKindLabel(kind) {
  return kind === 'mcp' ? 'MCP / RAG' : kind === 'skill' ? 'Skill' : kind === 'model' ? 'Модель' : 'Инструмент'
}
function activityStatusLabel(status) {
  return status === 'running' || status === 'streaming' ? 'выполняется' : status === 'error' ? 'ошибка' : status === 'completed' ? 'готово' : 'ожидание'
}
function activitySessionID(payload) {
  const data = payload?.data || payload?.properties || {}
  return String(data.sessionID || data.session?.id || '')
}
function activityBelongsToSession(payload) {
  const data = payload?.data || payload?.properties || {}
  const sid = activitySessionID(payload)
  if (sid === String(state.sessionID || '')) return true
  const parentID = data.parentID || data.parentSessionID || data.session?.parentID
  return String(parentID || '') === String(state.sessionID || '') || state.children.some((child) => String(child?.id || '') === sid)
}
function activityKey(data, type) {
  return String(data.id || data.callID || data.toolCallID || data.assistantMessageID || `${type}:${data.name || data.tool || 'primary'}`)
}
function activityEventData(payload) {
  const data = payload?.data || payload?.properties || {}
  return data?.part?.type === 'tool' ? { ...data, ...data.part, state:data.part.state || data.state } : data
}
function activityDescriptor(payload) {
  const type = String(payload?.type || '')
  const data = activityEventData(payload)
  const toolEvent = type.startsWith('session.tool.') || data.type === 'tool'
  if (toolEvent) {
    const name = String(data.name || data.tool || data.toolName || 'Инструмент')
    return { id:`tool:${activityKey(data, type)}`, kind:activityKind(name, type), title:name, detail:data.agent || data.model ? `${data.agent || ''}${data.agent && data.model ? ' · ' : ''}${data.model ? activityModelLabel(data) : ''}` : 'текущая операция' }
  }
  if (type === 'session.created' && data.parentID) {
    const agent = String(data.agent || data.title || 'Подзадача')
    return { id:`agent:${activitySessionID(payload)}`, kind:'model', title:agent, detail:activityModelLabel(data) }
  }
  if (type.includes('reasoning')) return { id:`model:${data.assistantMessageID || 'primary'}`, kind:'model', title:'Рассуждение', detail:activityModelLabel(data) }
  if (type.includes('text')) return { id:`model:${data.assistantMessageID || 'primary'}`, kind:'model', title:'Формирование ответа', detail:activityModelLabel(data) }
  if (type.includes('step')) return { id:`model:${data.assistantMessageID || 'primary'}`, kind:'model', title:'Шаг модели', detail:activityModelLabel(data) }
  if (type.includes('execution') || type === 'session.busy' || type === 'session.status') return { id:'model:primary', kind:'model', title:'Основная модель', detail:activityModelLabel(data) }
  return null
}
function updateActivityFromEvent(payload) {
  if (!state.sessionID || !activityBelongsToSession(payload)) return
  const type = String(payload?.type || '')
  const data = activityEventData(payload)
  const descriptor = activityDescriptor(payload)
  if (!descriptor) return
  const toolEvent = type.startsWith('session.tool.') || data.type === 'tool'
  const existing = state.activityItems.find((item) => item.id === descriptor.id)
  const sourceStatus = data.state?.status || data.status
  const status = type.includes('failed') || sourceStatus === 'error' ? 'error' : type.includes('success') || type.includes('succeeded') || type.includes('ended') || type === 'session.idle' || ['completed', 'done', 'idle', 'success'].includes(sourceStatus) ? 'completed' : toolEvent && type.includes('progress') ? existing?.status || 'running' : sourceStatus || 'running'
  const inputValue = data.input !== undefined ? data.input : data.state?.input
  const outputValue = data.content !== undefined ? data.content : data.state?.content
  const errorValue = data.error !== undefined ? data.error : data.state?.error
  const deltaInput = toolEvent && data.delta !== undefined ? `${activityValue(existing?.input)}${activityValue(data.delta)}` : existing?.input
  const deltaOutput = !toolEvent && data.delta !== undefined ? `${existing?.output || ''}${activityValue(data.delta)}` : existing?.output
  const next = {
    ...(existing || {}),
    ...descriptor,
    status,
    input: inputValue !== undefined ? inputValue : deltaInput,
    output: outputValue !== undefined ? activityValue(outputValue) : data.text !== undefined ? activityValue(data.text) : data.output !== undefined ? activityValue(data.output) : deltaOutput,
    error: errorValue ? activityValue(errorValue) : existing?.error,
    updatedAt: Date.now(),
  }
  const index = state.activityItems.findIndex((item) => item.id === descriptor.id)
  if (index >= 0) state.activityItems.splice(index, 1, next)
  else state.activityItems.push(next)
  state.activityItems = state.activityItems.slice(-32)
  state.currentActivityID = descriptor.id
  scheduleOrchestrationRender()
}
function scheduleOrchestrationRender() {
  if (state.orchestrationRenderFrame !== null) return
  const render = () => {
    state.orchestrationRenderFrame = null
    renderOrchestration()
  }
  state.orchestrationRenderFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(render) : setTimeout(render, 0)
}
function latestActivityFromMessages(messages, child) {
  const rows = Array.isArray(messages) ? messages : []
  let latest = null
  for (const message of rows) {
    const parts = message?.parts || message?.content || []
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part?.type !== 'tool') continue
      const name = String(part.name || part.tool || 'Инструмент')
      const rawState = part.state || part
      latest = {
        id:`child-tool:${child?.id || ''}:${part.id || name}`,
        kind:activityKind(name),
        title:name,
        detail:child?.agent || child?.title || activityModelLabel(child?.model ? { model:child.model } : {}),
        status:/error|failed/i.test(String(rawState.status || part.status || '')) ? 'error' : /running|streaming|busy/i.test(String(rawState.status || part.status || '')) ? 'running' : 'completed',
        input:rawState.input,
        output:activityValue(rawState.content || part.output || part.result),
        error:activityValue(rawState.error || part.error),
        updatedAt:message?.time?.updated || message?.time?.created || Date.now(),
      }
    }
  }
  return latest
}
function renderActivityItem(item, current = false) {
  if (!item) return ''
  const status = item.status || 'completed'
  const input = activityValue(item.input, 5000)
  const output = item.error || item.output || ''
  return `<article class="activity-item ${current ? 'current' : ''} ${escapeHtml(status)}"><div class="activity-item-head"><span class="activity-kind">${escapeHtml(activityKindLabel(item.kind))}</span><span class="activity-status ${escapeHtml(status)}">${escapeHtml(activityStatusLabel(status))}</span></div><strong>${escapeHtml(item.title || 'Операция')}</strong><span class="activity-detail">${escapeHtml(item.detail || '')}</span>${input && current ? `<pre class="activity-code">${escapeHtml(input)}</pre>` : ''}${output ? `<pre class="activity-output ${item.error ? 'error' : ''}">${escapeHtml(output)}</pre>` : ''}</article>`
}
function renderActivityFromEvent(payload) {
  updateActivityFromEvent(payload)
}
function refreshOrchestration(force = false) { return orchestrationRefresh(() => refreshOrchestrationNow(), force) }
async function refreshOrchestrationNow() {
  if (!state.sessionID) return
  const sessionID = state.sessionID
  const revision = state.orchestrationRevision
  const refreshSeq = ++state.orchestrationRefreshSeq
  const sameSession = () => state.sessionID === sessionID && state.orchestrationRevision === revision
  const current = () => sameSession() && state.orchestrationRefreshSeq === refreshSeq
  let children = []
  if (state.childrenTransport !== 'unsupported') {
    try {
      const value = dataOf(await request(`/api/session/${encodeURIComponent(sessionID)}/children`))
      if (!current()) return
      state.childrenTransport = 'supported'
      if (Array.isArray(value)) children = value
    } catch (error) {
      if (current() && [404,405].includes(error.status)) state.childrenTransport = 'unsupported'
    }
  }
  if (!children.length) {
    try {
      const value = dataOf(await request('/api/session?limit=200&order=desc'))
      if (!current()) return
      if (Array.isArray(value)) children = value.filter((item) => item?.parentID === sessionID)
    } catch {}
  }
  if (!current()) return
  state.children = children
  let statuses = {}
  try { statuses = dataOf(await request('/api/session/active')) || {}; if (!current()) return } catch {}
  if (!current()) return
  if (!state.activityHydrated && !state.activityHydrating) {
    state.activityHydrating = true
    request(`/api/session/${encodeURIComponent(sessionID)}/message?limit=100`).then((value) => {
      if (!sameSession()) return
      if (!state.activityItems.length) {
        const latest = latestActivityFromMessages(dataOf(value) || [], state.session)
        if (latest) {
          state.activityItems = [latest]
          state.currentActivityID = latest.id
          renderOrchestration()
        }
      }
      state.activityHydrated = true
    }).catch(() => {}).finally(() => { if (sameSession()) state.activityHydrating = false })
  }
  for (const child of children.slice(0, 12)) {
    const id = child?.id
    if (!id || state.childDetails.has(id)) continue
    state.childDetails.set(id, { loading:true })
    request(`/api/session/${encodeURIComponent(id)}/message?limit=100`).then((value) => {
      if (!sameSession()) return
      const messages = dataOf(value) || []
      const blob = JSON.stringify(messages)
      state.childDetails.set(id, { rag:/kb_knowledge_|knowledge_search|knowledge_get/i.test(blob), error:/"error"/i.test(blob), latest: latestActivityFromMessages(messages, child) })
      renderOrchestration()
    }).catch(() => { if (sameSession()) state.childDetails.set(id, {}) })
  }
  state.orchestrationStatuses = statuses
  renderOrchestration(statuses)
}
function refreshPlan(force = false) { return planRefresh(() => refreshPlanNow(), force) }
async function refreshPlanNow() {
  if (!state.sessionID) return
  const sessionID = state.sessionID
  const revision = state.orchestrationRevision
  const refreshSeq = ++state.planRefreshSeq
  const current = () => state.sessionID === sessionID && state.orchestrationRevision === revision && state.planRefreshSeq === refreshSeq
  try {
    const value = await request(`/client-plan.json?sessionID=${encodeURIComponent(sessionID)}`)
    if (!current()) return
    state.plan = value?.plan || null
    renderOrchestration()
  } catch (error) { console.debug('native V2 plan refresh', error) }
}
const compactOrchestration = globalThis.matchMedia?.('(max-width: 700px)')
function syncOrchestrationPanels(panel, open) {
  if (!panel) return
  const panels = [...panel.parentElement.querySelectorAll(':scope > details')]
  for (const row of panels) {
    const next = row === panel ? open : compactOrchestration.matches ? (open ? false : row.open) : open
    row._lastOpen = next
    row.open = next
  }
  $('orchestrationTrace')?.classList.toggle('is-expanded', panels.some((row) => row.open))
}
compactOrchestration?.addEventListener('change', () => {
  const panel = $('orchestrationTrace')?.querySelector('.orchestration-panel[open]')
  syncOrchestrationPanels(panel, true)
})
function renderOrchestration(statuses = state.orchestrationStatuses || {}) {
  const host = $('orchestrationTrace')
  if (!host) return
  const renderRevision = ++state.orchestrationRenderRevision
  const conversation = captureScrollState($('messages'))
  const planOpen = host.querySelector('.plan-panel')?.open === true
  const liveOpen = host.querySelector('.live-panel')?.open === true
  const planScroll = captureScrollState(host.querySelector('.plan-panel-body'))
  const nodesScroll = captureScrollState(host.querySelector('.orchestration-nodes'))
  const children = state.children || []
  host.hidden = !state.sessionID
  if (host.hidden) { host.innerHTML = ''; host._orchestrationMarkup = ''; return }
  const rootModel = $('modelButton')?.textContent || state.session?.model?.id || 'Primary'
  const rootStatus = running() ? 'running' : 'done'
  const childStates = children.map((child) => childStatus(statuses?.[child?.id]))
  const runningChildren = childStates.filter((status) => status === 'running').length
  const errorChildren = childStates.filter((status) => status === 'error').length
  const plan = state.plan
  const todos = Array.isArray(plan?.todos) ? plan.todos : []
  const planTotal = Number.isFinite(Number(plan?.total)) && Number(plan.total) > 0 ? Number(plan.total) : todos.length
  const planDone = Number.isFinite(Number(plan?.completed)) ? Number(plan.completed) : todos.filter((todo) => todo?.status === 'completed').length
  const planRunning = Number(plan?.inProgress) > 0 || todos.some((todo) => todo?.status === 'in_progress')
  const planIncomplete = planTotal > 0 && planDone < planTotal
  const planPercent = planTotal ? Math.round((planDone / planTotal) * 100) : 0
  const panelStatus = running() || runningChildren || planRunning ? 'running' : errorChildren ? 'error' : planIncomplete ? 'pending' : 'done'
  const panelStatusLabel = panelStatus === 'running' ? 'В работе' : panelStatus === 'error' ? 'Есть ошибки' : panelStatus === 'pending' ? 'План не завершён' : 'Готово'
  const currentTodo = todos.find((todo) => todo?.status === 'in_progress') || todos.find((todo) => todo?.status !== 'completed')
  const currentStage = currentTodo?.content || (planTotal && planDone >= planTotal ? 'Все этапы завершены' : 'Ожидание этапов плана')
  const panelMetaParts = []
  if (planTotal) panelMetaParts.push(`План ${planDone}/${planTotal}`)
  if (children.length) panelMetaParts.push(`${children.length} подзадач`)
  if (!panelMetaParts.length) panelMetaParts.push('primary')
  if (children.some((child) => state.childDetails.get(child.id)?.rag)) panelMetaParts.push('RAG ✓')
  const panelMeta = panelMetaParts.join(' · ')
  const planMarkup = planTotal ? `<section class="orchestration-plan" aria-label="План"><div class="orchestration-plan-head"><div class="orchestration-plan-copy"><strong>${escapeHtml(plan.title || 'План')}</strong><span>Текущий этап: ${escapeHtml(currentStage)}</span></div><span class="orchestration-plan-count">${planDone}/${planTotal}</span></div><div class="orchestration-plan-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${planTotal}" aria-valuenow="${planDone}"><span style="width:${planPercent}%"></span></div><ul class="orchestration-plan-list">${todos.map((todo) => { const status = ['completed', 'in_progress'].includes(todo?.status) ? todo.status : 'pending'; const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '•' : ''; return `<li class="${status}"><span class="orchestration-plan-mark" aria-hidden="true">${mark}</span><span>${escapeHtml(todo?.content || '')}</span></li>` }).join('')}${plan.truncated ? `<li class="truncated"><span class="orchestration-plan-mark" aria-hidden="true">…</span><span>Показаны первые ${todos.length} из ${planTotal} пунктов</span></li>` : ''}</ul></section>` : '<div class="activity-empty">План появится после начала оркестрации.</div>'
  const primaryTime = state.runStartedAt ? fmtDuration(Date.now() - state.runStartedAt) : state.lastDurationMs ? fmtDuration(state.lastDurationMs) : ''
  const nodes = [`<div class="orchestration-node primary-node ${rootStatus}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(rootModel)}</div><div class="node-meta">${escapeHtml(currentMode())} · primary</div><div class="node-purpose">Основная модель: ведёт диалог и собирает итог</div></div><span class="node-time">${primaryTime}</span></div>`]
  const childActivities = []
  for (const child of children) {
    const id = child?.id || ''
    const status = childStatus(statuses?.[id])
    const rawModel = child?.model
    const model = rawModel?.id || rawModel?.modelID || child?.modelID || rawModel || 'subagent'
    const provider = rawModel?.providerID || child?.providerID || ''
    const role = child?.agent || child?.title || 'subagent'
    const label = child?.title || role
    const detail = state.childDetails.get(id) || {}
    const created = child?.time?.created || child?.createdAt || 0
    const updated = child?.time?.updated || child?.updatedAt || Date.now()
    const modelLabel = `${provider ? `${provider}/` : ''}${typeof model === 'string' ? model : JSON.stringify(model)}`
    nodes.push(`<div class="orchestration-node child-node ${detail.error ? 'error' : status}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(label)}</div><div class="node-meta">${role !== label ? `${escapeHtml(role)} · ` : ''}${escapeHtml(modelLabel)}${detail.rag ? ' · RAG ✓' : ''}</div><div class="node-purpose">${escapeHtml(orchestrationPurpose(role))}</div></div><span class="node-time">${created ? fmtDuration(Math.max(0, updated - created)) : ''}</span></div>`)
    if (detail.latest || status === 'running') childActivities.push({ ...(detail.latest || {}), id:detail.latest?.id || `agent:${id}`, kind:detail.latest?.kind || 'model', title:detail.latest?.title || role, detail:detail.latest?.detail || modelLabel, status:status === 'running' ? 'running' : detail.latest?.status || 'completed' })
  }
  const liveActivities = [...state.activityItems, ...childActivities]
  const currentActivity = liveActivities.find((item) => item.id === state.currentActivityID) || liveActivities.find((item) => item.status === 'running' || item.status === 'streaming') || liveActivities[liveActivities.length - 1]
  const liveStatus = currentActivity?.status === 'error' ? 'error' : currentActivity?.status === 'running' || currentActivity?.status === 'streaming' ? 'running' : currentActivity ? 'done' : panelStatus
  const liveStatusLabel = liveStatus === 'running' ? 'Выполняется' : liveStatus === 'error' ? 'Ошибка' : currentActivity ? 'Последний вывод' : panelStatusLabel
  const liveSummary = currentActivity ? `${activityKindLabel(currentActivity.kind)} · ${currentActivity.title}` : children.length ? `${children.length} подзадач · ожидание активности` : 'Инструменты и модели появятся здесь'
  const history = state.activityItems.filter((item) => item.id !== currentActivity?.id).slice(-6).reverse().map((item) => renderActivityItem(item)).join('')
  const planPanelMarkup = plan ? `<details class="orchestration-panel plan-panel"><summary class="orchestration-summary activity-summary"><span class="orchestration-summary-mark ${panelStatus}" aria-hidden="true"></span><span class="orchestration-summary-copy"><strong>План</strong><span>${escapeHtml(currentStage)} · ${escapeHtml(panelMeta)}</span></span><span class="orchestration-summary-status ${panelStatus}">${panelStatusLabel}</span></summary><div class="activity-panel-body plan-panel-body">${planMarkup}</div></details>` : ''
  const livePanelMarkup = `<details class="orchestration-panel live-panel"><summary class="orchestration-summary activity-summary"><span class="orchestration-summary-mark ${liveStatus}" aria-hidden="true"></span><span class="orchestration-summary-copy"><strong>Инструменты и агенты</strong><span>${escapeHtml(liveSummary)}</span></span><span class="orchestration-summary-status ${liveStatus}">${liveStatusLabel}</span></summary><div class="orchestration-nodes activity-panel-body">${currentActivity ? `<div class="activity-current-label">Сейчас</div>${renderActivityItem(currentActivity, true)}` : '<div class="activity-empty">Сейчас инструмент не выполняется.</div>'}<div class="activity-agents-label">Участники оркестрации</div>${nodes.join('')}${history ? `<div class="activity-history-label">Последние события</div>${history}` : ''}</div></details>`
  const markup = `<div class="orchestration-panels">${planPanelMarkup}${livePanelMarkup}</div>`
  const structureMarkup = primaryTime ? markup.replace(primaryTime, '__TIME__') : markup
  if (host._orchestrationMarkup === markup) return
  if (host._structureMarkup === structureMarkup) {
    const timeEl = host.querySelector('.primary-node .node-time')
    if (timeEl && timeEl.textContent !== primaryTime) timeEl.textContent = primaryTime
    return
  }
  host._structureMarkup = structureMarkup
  host._orchestrationMarkup = markup
  host.innerHTML = markup
  const details = [...host.querySelectorAll('details')]
  const planPanel=host.querySelector('.plan-panel'),livePanel=host.querySelector('.live-panel')
  if (planPanel) planPanel.open = planOpen
  if (livePanel) livePanel.open = liveOpen
  syncOrchestrationPanels(details.find((row) => row.open), true)
  details.forEach((detail) => { detail._lastOpen = detail.open })
  details.forEach((detail) => {
    const rememberConversation = () => { detail._conversationScroll = captureScrollState($('messages')) }
    const summary = detail.querySelector('summary')
    summary?.addEventListener('pointerdown', rememberConversation)
    summary?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') rememberConversation() })
    detail.addEventListener('toggle', () => {
      if (!detail.isConnected || detail._lastOpen === detail.open) return
      syncOrchestrationPanels(detail, detail.open)
      restoreScrollState($('messages'), detail._conversationScroll || captureScrollState($('messages')))
      detail._conversationScroll = null
    })
  })
  host.classList.toggle('is-expanded', planOpen || liveOpen)
  restoreScrollState($('messages'), conversation)
  const sessionID = state.sessionID
  const revision = state.orchestrationRevision
  requestAnimationFrame(() => {
    if (state.sessionID !== sessionID || state.orchestrationRevision !== revision || state.orchestrationRenderRevision !== renderRevision || host.hidden) return
    restoreScrollState(host.querySelector('.plan-panel-body'), planScroll)
    restoreScrollState(host.querySelector('.orchestration-nodes'), nodesScroll)
  })
}

function captureScrollState(element) {
  if (!element) return null
  const max = Math.max(0, element.scrollHeight - element.clientHeight)
  return { top:element.scrollTop, atBottom:max - element.scrollTop <= 4 }
}
function restoreScrollState(element, saved) {
  if (!element || !saved) return
  const max = Math.max(0, element.scrollHeight - element.clientHeight)
  element.scrollTop = saved.atBottom ? max : Math.min(saved.top, max)
}

function usageCost() {
  const text = $('usageDetails')?.textContent || ''
  const match = /Стоимость\s*\$([0-9.]+)/i.exec(text)
  return match ? `$${match[1]}` : ''
}
function renderStatus() {
  const host = $('workflowStatus')
  if (!host) return
  host.hidden = !state.sessionID
  if (host.hidden) {
    if (host.innerHTML !== '') host.innerHTML = ''
    host._lastMarkup = ''
    return
  }
  const model = $('modelButton')?.textContent?.trim() || 'Модель'
  const context = $('usageButton')?.textContent?.trim() || ''
  const cost = usageCost()
  const elapsed = running() && state.runStartedAt ? fmtDuration(Date.now() - state.runStartedAt) : state.lastDurationMs ? fmtDuration(state.lastDurationMs) : ''
  const queue = Number(state.queue?.count || 0)
  const rag = state.children.some((child) => state.childDetails.get(child.id)?.rag) || state.settings?.rag === 'on'
  const markup = `<span class="wf-pill strong">${escapeHtml(model)}</span>${context ? `<span class="wf-pill">${escapeHtml(context)}</span>` : ''}${cost ? `<span class="wf-pill">${escapeHtml(cost)}</span>` : ''}${elapsed ? `<span class="wf-pill"><span class="wf-dot ${running() ? 'busy' : ''}"></span>${escapeHtml(elapsed)}</span>` : ''}${rag ? '<span class="wf-pill">RAG ✓</span>' : ''}<button type="button" class="wf-pill clickable" id="queueStatusButton">Очередь ${queue}</button>`
  if (host._lastMarkup === markup) return
  host._lastMarkup = markup
  host.innerHTML = markup
  $('queueStatusButton')?.addEventListener('click', openQueueDialog)
}
function renderAll() {
  if ($('projectSettingsButton')) $('projectSettingsButton').hidden = !state.sessionID || !state.directory
  renderQuestion()
  renderOrchestration()
  renderStatus()
  renderQueueDialog()
  syncPermissionProjectButton()
}

function patchPath(diff, patch) {
  const direct = diff?.file || diff?.path || diff?.name
  if (direct) return String(direct).replace(/^b\//, '')
  const match = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(patch || '') || /^---\s+(?:a\/)?([^\t\n]+)/m.exec(patch || '')
  return match ? match[1].trim() : 'diff'
}
function splitHunks(patch, path) {
  const lines = String(patch || '').replace(/\r\n/g, '\n').split('\n')
  const header = lines.filter((line) => line.startsWith('--- ') || line.startsWith('+++ ')).slice(-2)
  const hunks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current)
      current = [line]
    } else if (current) current.push(line)
  }
  if (current) hunks.push(current)
  const safeHeader = header.length === 2 ? header.join('\n') : `--- a/${path}\n+++ b/${path}`
  return hunks.map((lineset) => ({ raw:`${safeHeader}\n${lineset.join('\n')}\n`, lines:lineset }))
}
function diffStats(text) {
  let add = 0, del = 0
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++
    if (line.startsWith('-') && !line.startsWith('---')) del++
  }
  return { add, del }
}
async function loadReview() {
  if (!state.sessionID || !state.directory || !$('gitDialog')?.open) return
  try {
    let value = dataOf(await request(`/api/session/${encodeURIComponent(state.sessionID)}/diff`))
    let diffs = Array.isArray(value) ? value : []
    if (!diffs.length) {
      const q = workspaceQuery()
      value = dataOf(await request(`/api/vcs/diff${q ? `?${q}` : ''}`))
      diffs = Array.isArray(value) ? value : []
    }
    state.reviewDiffs = diffs.map((diff) => {
      let patch = diff?.patch || diff?.diff || ''
      if (!patch && (Object.prototype.hasOwnProperty.call(diff || {}, 'before') || Object.prototype.hasOwnProperty.call(diff || {}, 'after'))) patch = `--- before\n${diff.before || ''}\n+++ after\n${diff.after || ''}`
      const path = patchPath(diff, patch)
      return { diff, patch:String(patch || ''), path, hunks:splitHunks(patch, path), ...diffStats(patch) }
    })
    renderReview()
  } catch (error) { console.warn('advanced review failed', error) }
}
function renderReview() {
  const host = $('gitDiff')
  if (!host || !$('gitDialog')?.open) return
  const diffs = state.reviewDiffs || []
  const total = diffs.reduce((acc, item) => ({ add:acc.add + item.add, del:acc.del + item.del }), { add:0, del:0 })
  const summary = $('gitSummary')
  summary?.querySelector('.review-summary')?.remove()
  if (summary) summary.insertAdjacentHTML('beforeend', `<div class="review-summary"><span class="review-stat">${diffs.length} files</span><span class="review-stat">+${total.add}</span><span class="review-stat">−${total.del}</span></div>`)
  host.innerHTML = diffs.map((item, index) => `<details class="review-file" open><summary><span class="review-file-path">${escapeHtml(item.path)}</span><span class="review-file-stat">+${item.add} −${item.del}</span><span class="review-file-actions"><button type="button" class="workflow-button-danger" data-revert-file="${index}">Отменить файл</button></span></summary>${item.hunks.map((hunk, hIndex) => `<div class="review-hunk"><div class="review-hunk-head"><span>${escapeHtml(hunk.lines[0] || 'hunk')}</span><button type="button" data-revert-hunk="${index}:${hIndex}">Отменить hunk</button></div><pre>${hunk.lines.map((line) => `<span class="${line.startsWith('+') && !line.startsWith('+++') ? 'line-add' : line.startsWith('-') && !line.startsWith('---') ? 'line-del' : ''}">${escapeHtml(line)}</span>`).join('\n')}</pre></div>`).join('') || `<pre>${escapeHtml(item.patch)}</pre>`}</details>`).join('') || '<div class="empty">Изменений нет.</div>'
  host.querySelectorAll('[data-revert-file]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    revertReviewFile(Number(button.dataset.revertFile))
  }))
  host.querySelectorAll('[data-revert-hunk]').forEach((button) => button.addEventListener('click', () => {
    const [fileIndex, hunkIndex] = button.dataset.revertHunk.split(':').map(Number)
    revertReviewHunk(fileIndex, hunkIndex)
  }))
}
async function revertReviewFile(index) {
  const item = state.reviewDiffs[index]
  if (!item || !confirm(`Отменить все незакоммиченные изменения в ${item.path}?`)) return
  try {
    await request('/client-git-revert.json', { method:'POST', body:JSON.stringify({ directory:state.directory, path:item.path, mode:'file' }) })
    toast('Изменения файла отменены')
    await loadReview()
  } catch (error) { toast(`Revert: ${error.message}`, 6000) }
}
async function revertReviewHunk(fileIndex, hunkIndex) {
  const item = state.reviewDiffs[fileIndex], hunk = item?.hunks?.[hunkIndex]
  if (!item || !hunk || !confirm(`Отменить этот hunk в ${item.path}?`)) return
  try {
    await request('/client-git-revert.json', { method:'POST', body:JSON.stringify({ directory:state.directory, path:item.path, mode:'hunk', patch:hunk.raw }) })
    toast('Hunk отменён')
    await loadReview()
  } catch (error) { toast(`Revert hunk: ${error.message}`, 6000) }
}

async function notifyAdvanced(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const data = { url:state.sessionID ? `/#/session/${encodeURIComponent(state.sessionID)}` : '/' }
  // `ready` never settles when the service worker failed to register; race it
  // with a short timeout instead of awaiting forever.
  const registration = 'serviceWorker' in navigator
    ? await Promise.race([
        navigator.serviceWorker.ready.catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]).catch(() => null)
    : null
  if (registration?.showNotification) {
    try {
      await registration.showNotification(title, { body, tag, data, actions:[{ action:'open', title:'Открыть' }, { action:'dismiss', title:'Закрыть' }] })
      return
    } catch {}
  }
  // `actions` is only valid for service-worker notifications.
  try { new Notification(title, { body, tag, data }) } catch {}
}

function observeRuntime() {
  const stop = $('stop')
  if (stop) new MutationObserver(() => {
    if (running()) {
      if (!state.runStartedAt) state.runStartedAt = Date.now()
      fastPolling.wake()
      mediumPolling.wake()
    } else if (state.runStartedAt) {
      state.lastDurationMs = Date.now() - state.runStartedAt
      state.runStartedAt = null
      setTimeout(() => { refreshQueue(undefined, true); refreshOrchestration(true); refreshPlan(true); loadReview() }, 120)
    }
    renderStatus()
    renderOrchestration()
  }).observe(stop, { attributes:true, attributeFilter:['hidden'] })
  const modelButton = $('modelButton')
  if (modelButton) new MutationObserver(renderStatus).observe(modelButton, { childList:true, characterData:true, subtree:true })
  const usageButton = $('usageButton')
  if (usageButton) new MutationObserver(renderStatus).observe(usageButton, { childList:true, characterData:true, subtree:true })
  const gitDialog = $('gitDialog')
  if (gitDialog) new MutationObserver(() => { if (gitDialog.open) setTimeout(loadReview, 120) }).observe(gitDialog, { attributes:true, attributeFilter:['open'] })
  const sessions = $('sessions')
  if (sessions) new MutationObserver(syncQueueBadges).observe(sessions, { childList:true, subtree:true })
  const permission = $('permissionBanner')
  if (permission) new MutationObserver(syncPermissionProjectButton).observe(permission, { attributes:true, attributeFilter:['hidden'] })
}

function bindEvents() {
  window.addEventListener('hashchange', () => refreshSelectedSession(true))
  window.addEventListener('custom-opencode:session-selected', () => refreshSelectedSession(true))
  window.addEventListener('custom-opencode:agent-changed', () => {
    setTimeout(() => {
      refreshOrchestration(true)
      refreshPlan(true)
    }, 0)
  })
  window.addEventListener('custom-opencode:event', (event) => { handleQuestionEvent(event.detail); renderActivityFromEvent(event.detail) })
  $('form')?.addEventListener('submit', interceptSubmit, true)
  $('fileInput')?.addEventListener('change', (event) => captureFiles(event.target.files), true)
  $('input')?.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean)
    if (files.length) captureFiles(files)
  }, true)
  document.addEventListener('click', (event) => {
    const remove = event.target.closest?.('[data-remove-attachment]')
    if (remove) {
      const index = Number(remove.dataset.removeAttachment)
      if (Number.isInteger(index) && index >= 0) state.attachments.splice(index, 1)
    }
  }, true)
  document.addEventListener('click', (event) => {
    const host = $('orchestrationTrace')
    if (host && !host.contains(event.target)) host.querySelectorAll('details').forEach((detail) => detail.removeAttribute('open'))
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshSelectedSession(true)
      refreshQueue(undefined, true)
      refreshQuestions(true)
      refreshOrchestration(true)
      refreshPlan(true)
      refreshPermission(undefined, true)
      fastPolling.reschedule()
      mediumPolling.reschedule()
    }
  })
}

async function tickFast() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQuestions(), refreshPermission()])
}
async function tickMedium() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQueue(), refreshOrchestration(), refreshPlan()])
}

const fastPolling = createAdaptivePoller({ run:tickFast, isActive:running, activeDelay:2500, idleDelay:15000, isVisible:() => !document.hidden })
const mediumPolling = createAdaptivePoller({ run:tickMedium, isActive:running, activeDelay:5000, idleDelay:30000, isVisible:() => !document.hidden })

function init() {
  ensureSurfaces()
  bindEvents()
  observeRuntime()
  refreshSelectedSession(true)
  fastPolling.start()
  mediumPolling.start()
  setInterval(() => { if (!document.hidden && state.sessionID) renderStatus() }, 2000)
}

if (typeof document !== 'undefined') init()
