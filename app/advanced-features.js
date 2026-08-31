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
  questionSelection: [],
  pendingPermission: null,
  children: [],
  childrenTransport: 'unknown',
  childDetails: new Map(),
  runStartedAt: null,
  lastDurationMs: 0,
  attachments: [],
  attachmentReads: [],
  submitPending: false,
  reviewDiffs: [],
}

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
    $('messages')?.after(trace)
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
          <label><span class="workflow-label">Режим по умолчанию</span><select class="workflow-select" id="projectDefaultMode"><option value="inherit">Не менять</option><option value="build">Build</option><option value="plan">Plan</option></select></label>
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

async function refreshSelectedSession() {
  const id = sessionFromHash()
  if (id === state.sessionID && state.session) return
  state.sessionID = id
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
    await Promise.allSettled([loadProjectSettings(), refreshQueue(), refreshQuestions(), refreshOrchestration(), refreshPermission()])
    await applyProjectDefaultsOnce()
    renderAll()
  } catch (error) {
    console.warn('advanced session load failed', error)
  }
}

async function loadProjectSettings() {
  if (!state.sessionID) return
  const value = await request(`/client-project-settings.json?sessionID=${encodeURIComponent(state.sessionID)}`)
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
    defaultMode: $('projectDefaultMode').value,
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
  const options = new Map([['inherit', 'Не менять'], ['orchestrated', 'Qwen 3.8 Max · Оркестрированная']])
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
  $('projectDefaultMode').value = settings.defaultMode || 'inherit'
  $('projectDefaultModel').value = settings.defaultModel || 'inherit'
  $('projectRag').value = settings.rag || 'auto'
  $('projectPermissionRules').innerHTML = ''
  for (const rule of settings.permissionRules || []) addRuleRow(rule)
  $('projectSettingsDialog').showModal()
}

async function applyProjectDefaultsOnce() {
  if (!state.sessionID || !state.settings) return
  const key = `opencode:web:project-defaults:${state.sessionID}`
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  try {
    const rows = dataOf(await request(`/api/session/${encodeURIComponent(state.sessionID)}/message?limit=1`))
    if (Array.isArray(rows) && rows.length) return
  } catch {}
  const settings = state.settings
  if (settings.defaultMode === 'build' || settings.defaultMode === 'plan') {
    document.querySelector(`#agentControls [data-agent="${settings.defaultMode}"]`)?.click()
  }
  if (settings.defaultModel === 'orchestrated') window.CustomOpenCodeUX?.setProfile?.('orchestrated')
  else if (typeof settings.defaultModel === 'string' && settings.defaultModel.includes('/')) {
    await chooseConcreteModel(settings.defaultModel)
  }
  if (settings.rag === 'on') {
    request('/client-rag-start.json', { method:'POST', body:JSON.stringify({ mode:'quick', sessionID:state.sessionID }) }).catch(() => {})
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

function readAttachment(file, slot) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = { uri:reader.result, name:file.name || `file-${Date.now()}`, mime:file.type || 'application/octet-stream' }
      state.attachments[slot] = value
      resolve(value)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
function captureFiles(files) {
  for (const file of [...(files || [])]) {
    if (!file) continue
    const slot = state.attachments.length
    state.attachments.push(null)
    state.attachmentReads.push(readAttachment(file, slot).catch((error) => {
      state.attachments[slot] = null
      console.warn('attachment mirror failed', error)
    }))
  }
}
async function awaitAttachments() {
  const pending = [...state.attachmentReads]
  state.attachmentReads = []
  if (pending.length) await Promise.allSettled(pending)
  return state.attachments.filter(Boolean)
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

async function interceptSubmit(event) {
  if (!state.sessionID) return
  const text = $('input')?.value.trim() || ''
  if (text.startsWith('/') && !text.startsWith('//')) return
  const hasAttachmentSurface = Boolean($('attachments') && !$('attachments').hidden && $('attachments').children.length)
  if (!text && !hasAttachmentSurface && !state.attachments.length && !state.attachmentReads.length) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (state.submitPending) return
  state.submitPending = true
  const input = $('input'),action = $('composerAction'),attach = $('attachButton')
  if (input) { input.value = ''; input.disabled = true; input.dispatchEvent(new Event('input', { bubbles:true })) }
  if (action) action.disabled = true
  if (attach) attach.disabled = true
  try {
    const files = await awaitAttachments()
    const profile = currentProfile() === 'orchestrated' ? 'orchestrated' : 'direct'
    if (running()) {
      await request('/client-queue.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, text, files, profile }) })
      clearComposer()
      await refreshQueue()
      toast('Добавлено в серверную очередь')
      return
    }
    await request('/client-send.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, text, files, profile }) })
    clearComposer()
    if ($('stop')) $('stop').hidden = false
    if (!state.runStartedAt) state.runStartedAt = Date.now()
    renderStatus()
    toast('Отправлено', 1300)
    setTimeout(refreshOrchestration, 300)
  } catch (error) {
    if (input) input.value = text
    toast(`Отправка: ${error.message}`, 6000)
  } finally {
    state.submitPending = false
    if (input) { input.disabled = false; input.dispatchEvent(new Event('input', { bubbles:true })) }
    if (action) action.disabled = false
    if (attach) attach.disabled = false
  }
}

async function refreshQueue() {
  if (!state.sessionID) return
  try {
    const [selected, global] = await Promise.all([
      request(`/client-queue.json?sessionID=${encodeURIComponent(state.sessionID)}`),
      request('/client-queue.json'),
    ])
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
    await refreshQueue()
  } catch (error) { toast(error.message) }
}
async function moveQueue(index, delta) {
  const items = [...(state.queue?.items || [])]
  const next = index + delta
  if (next < 0 || next >= items.length) return
  ;[items[index], items[next]] = [items[next], items[index]]
  try {
    await request('/client-queue.json', { method:'PATCH', body:JSON.stringify({ sessionID:state.sessionID, ids:items.map((item) => item.id) }) })
    await refreshQueue()
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
async function refreshQuestions() {
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
    if (!requestRow?.id) { refreshQuestions(); return }
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
  refreshQuestions()
}

async function refreshPermission() {
  if (!state.sessionID || !state.directory) { state.pendingPermission = null; syncPermissionProjectButton(); return }
  const q = workspaceQuery()
  try {
    const value = dataOf(await request(`/api/permission/request${q ? `?${q}` : ''}`))
    state.pendingPermission = Array.isArray(value) ? value.find((item) => item?.sessionID === state.sessionID) || null : null
  } catch { state.pendingPermission = null }
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
async function refreshOrchestration() {
  if (!state.sessionID) return
  let children = []
  if (state.childrenTransport !== 'unsupported') {
    try {
      const value = dataOf(await request(`/api/session/${encodeURIComponent(state.sessionID)}/children`))
      state.childrenTransport = 'supported'
      if (Array.isArray(value)) children = value
    } catch (error) {
      if ([404,405].includes(error.status)) state.childrenTransport = 'unsupported'
    }
  }
  if (!children.length) {
    try {
      const value = dataOf(await request('/api/session?limit=200&order=desc'))
      if (Array.isArray(value)) children = value.filter((item) => item?.parentID === state.sessionID)
    } catch {}
  }
  state.children = children
  let statuses = {}
  try { statuses = dataOf(await request('/api/session/active')) || {} } catch {}
  for (const child of children.slice(0, 12)) {
    const id = child?.id
    if (!id || state.childDetails.has(id)) continue
    request(`/api/session/${encodeURIComponent(id)}/message?limit=100`).then((value) => {
      const blob = JSON.stringify(dataOf(value) || [])
      state.childDetails.set(id, { rag:/kb_knowledge_|knowledge_search|knowledge_get/i.test(blob), error:/"error"/i.test(blob) })
      renderOrchestration(statuses)
    }).catch(() => state.childDetails.set(id, {}))
  }
  renderOrchestration(statuses)
}
function renderOrchestration(statuses = {}) {
  const host = $('orchestrationTrace')
  if (!host) return
  const wasOpen = host.querySelector('details')?.open === true
  const children = state.children || []
  const visible = currentProfile() === 'orchestrated' || children.length > 0
  host.hidden = !state.sessionID || !visible
  if (host.hidden) { host.innerHTML = ''; return }
  const rootModel = $('modelButton')?.textContent || state.session?.model?.id || 'Primary'
  const rootStatus = running() ? 'running' : 'done'
  const childStates = children.map((child) => childStatus(statuses?.[child?.id]))
  const runningChildren = childStates.filter((status) => status === 'running').length
  const errorChildren = childStates.filter((status) => status === 'error').length
  const panelStatus = running() || runningChildren ? 'running' : errorChildren ? 'error' : 'done'
  const panelStatusLabel = panelStatus === 'running' ? 'В работе' : panelStatus === 'error' ? 'Есть ошибки' : 'Готово'
  const panelMeta = `${children.length ? `${children.length} подзадач` : 'primary'}${children.some((child) => state.childDetails.get(child.id)?.rag) ? ' · RAG ✓' : ''}`
  const nodes = [`<div class="orchestration-node primary-node ${rootStatus}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(rootModel)}</div><div class="node-meta">${escapeHtml(currentMode())} · primary</div></div><span class="node-time">${state.runStartedAt ? fmtDuration(Date.now() - state.runStartedAt) : state.lastDurationMs ? fmtDuration(state.lastDurationMs) : ''}</span></div>`]
  for (const child of children) {
    const id = child?.id || ''
    const status = childStatus(statuses?.[id])
    const model = child?.model?.id || child?.modelID || child?.model || 'subagent'
    const agent = child?.agent || child?.title || 'subagent'
    const detail = state.childDetails.get(id) || {}
    const created = child?.time?.created || child?.createdAt || 0
    const updated = child?.time?.updated || child?.updatedAt || Date.now()
    nodes.push(`<div class="orchestration-node child-node ${detail.error ? 'error' : status}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(agent)}</div><div class="node-meta">${escapeHtml(typeof model === 'string' ? model : JSON.stringify(model))}${detail.rag ? ' · RAG ✓' : ''}</div></div><span class="node-time">${created ? fmtDuration(Math.max(0, updated - created)) : ''}</span></div>`)
  }
  host.innerHTML = `<details><summary class="orchestration-summary"><span class="orchestration-summary-mark ${panelStatus}" aria-hidden="true"></span><span class="orchestration-summary-copy"><strong>Оркестрация</strong><span>${panelMeta}</span></span><span class="orchestration-summary-status ${panelStatus}">${panelStatusLabel}</span></summary><div class="orchestration-nodes">${nodes.join('')}</div></details>`
  if (wasOpen) host.querySelector('details').open = true
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
  if (host.hidden) { host.innerHTML = ''; return }
  const model = $('modelButton')?.textContent?.trim() || 'Модель'
  const context = $('usageButton')?.textContent?.trim() || ''
  const cost = usageCost()
  const elapsed = running() && state.runStartedAt ? fmtDuration(Date.now() - state.runStartedAt) : state.lastDurationMs ? fmtDuration(state.lastDurationMs) : ''
  const queue = Number(state.queue?.count || 0)
  const rag = state.children.some((child) => state.childDetails.get(child.id)?.rag) || state.settings?.rag === 'on'
  host.innerHTML = `<span class="wf-pill strong">${escapeHtml(model)}</span>${context ? `<span class="wf-pill">${escapeHtml(context)}</span>` : ''}${cost ? `<span class="wf-pill">${escapeHtml(cost)}</span>` : ''}${elapsed ? `<span class="wf-pill"><span class="wf-dot ${running() ? 'busy' : ''}"></span>${escapeHtml(elapsed)}</span>` : ''}${rag ? '<span class="wf-pill">RAG ✓</span>' : ''}<button type="button" class="wf-pill clickable" id="queueStatusButton">Очередь ${queue}</button>`
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
    } else if (state.runStartedAt) {
      state.lastDurationMs = Date.now() - state.runStartedAt
      state.runStartedAt = null
      setTimeout(() => { refreshQueue(); refreshOrchestration(); loadReview() }, 120)
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
  window.addEventListener('hashchange', refreshSelectedSession)
  window.addEventListener('custom-opencode:session-selected', () => refreshSelectedSession())
  window.addEventListener('custom-opencode:event', (event) => handleQuestionEvent(event.detail))
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
    if (host && !host.contains(event.target)) host.querySelector('details')?.removeAttribute('open')
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshSelectedSession()
      refreshQueue()
      refreshQuestions()
      refreshOrchestration()
      refreshPermission()
    }
  })
}

async function tickFast() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQuestions(), refreshPermission()])
}
async function tickMedium() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQueue(), refreshOrchestration()])
}

function init() {
  ensureSurfaces()
  bindEvents()
  observeRuntime()
  refreshSelectedSession()
  setInterval(tickFast, 1100)
  setInterval(tickMedium, 3200)
  setInterval(() => { if (state.sessionID) { renderStatus(); renderOrchestration() } }, 1000)
}

if (typeof document !== 'undefined') init()
