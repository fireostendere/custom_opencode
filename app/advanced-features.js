const $ = (id) => document.getElementById(id)

const state = {
  sessionID: null,
  session: null,
  directory: '',
  settings: null,
  queue: { count: 0, items: [], error: null },
  queueCounts: {},
  question: null,
  questionKey: '',
  questionSelection: [],
  pendingPermission: null,
  children: [],
  childDetails: new Map(),
  autoRoute: null,
  runStartedAt: null,
  lastDurationMs: 0,
  attachments: [],
  attachmentReads: [],
  reviewDiffs: [],
}

const DEFAULT_SETTINGS = {
  instructions: '',
  defaultMode: 'inherit',
  defaultModel: 'inherit',
  rag: 'auto',
  autoRouting: {
    localModel: 'ollama/qwen3.8:27b',
    cloudModel: 'bailian-cli/qwen3.8-flash',
    gpuBusyPercent: 35,
  },
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
    button.title = 'Память, routing и permission policy проекта'
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
          <label><span class="workflow-label">Модель/profile по умолчанию</span><select class="workflow-select" id="projectDefaultModel"><option value="inherit">Не менять</option><option value="auto">Auto · local/cloud</option><option value="orchestrated">Qwen 3.8 Max · Оркестрированная</option><option value="bailian-cli/qwen3.8-max">Qwen 3.8 Max</option><option value="bailian-cli/qwen3.8-flash">Qwen 3.8 Flash</option><option value="ollama/qwen3.8:27b">Local Qwen 3.8 27B</option></select></label>
          <label><span class="workflow-label">RAG</span><select class="workflow-select" id="projectRag"><option value="auto">Auto</option><option value="on">Всегда подключать</option><option value="off">Не запускать автоматически</option></select></label>
          <label><span class="workflow-label">GPU busy threshold, %</span><input class="workflow-input" id="projectGpuThreshold" type="number" min="1" max="100"></label>
          <label><span class="workflow-label">Локальная модель Auto</span><input class="workflow-input" id="projectLocalModel"></label>
          <label><span class="workflow-label">Cloud fallback Auto</span><input class="workflow-input" id="projectCloudModel"></label>
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
  state.questionSelection = []
  state.pendingPermission = null
  state.children = []
  state.childDetails.clear()
  state.autoRoute = null
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
    await Promise.allSettled([loadProjectSettings(), refreshQueue(), refreshQuestions(), refreshOrchestration(), refreshAutoRoute(), refreshPermission()])
    await applyProjectDefaultsOnce()
    renderAll()
  } catch (error) {
    console.warn('advanced session load failed', error)
  }
}

async function loadProjectSettings() {
  if (!state.sessionID) return
  const value = await request(`/client-project-settings.json?sessionID=${encodeURIComponent(state.sessionID)}`)
  if (!state.sessionID) return
  state.settings = { ...DEFAULT_SETTINGS, ...(value?.settings || {}), autoRouting:{ ...DEFAULT_SETTINGS.autoRouting, ...(value?.settings?.autoRouting || {}) } }
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
    autoRouting: {
      localModel: $('projectLocalModel').value.trim() || DEFAULT_SETTINGS.autoRouting.localModel,
      cloudModel: $('projectCloudModel').value.trim() || DEFAULT_SETTINGS.autoRouting.cloudModel,
      gpuBusyPercent: Number($('projectGpuThreshold').value || 35),
    },
    permissionRules: rules,
  }
  try {
    const value = await request('/client-project-settings.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, settings }) })
    state.settings = { ...DEFAULT_SETTINGS, ...(value?.settings || settings), autoRouting:{ ...DEFAULT_SETTINGS.autoRouting, ...(value?.settings?.autoRouting || settings.autoRouting) } }
    $('projectSettingsDialog').close()
    toast('Настройки проекта сохранены')
    refreshAutoRoute()
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

function openProjectSettings() {
  if (!state.sessionID || !state.directory) return
  const settings = state.settings || DEFAULT_SETTINGS
  $('projectSettingsPath').textContent = state.directory
  $('projectInstructions').value = settings.instructions || ''
  $('projectDefaultMode').value = settings.defaultMode || 'inherit'
  $('projectDefaultModel').value = settings.defaultModel || 'inherit'
  $('projectRag').value = settings.rag || 'auto'
  $('projectGpuThreshold').value = settings.autoRouting?.gpuBusyPercent || 35
  $('projectLocalModel').value = settings.autoRouting?.localModel || DEFAULT_SETTINGS.autoRouting.localModel
  $('projectCloudModel').value = settings.autoRouting?.cloudModel || DEFAULT_SETTINGS.autoRouting.cloudModel
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
  if (settings.defaultModel === 'auto') window.CustomOpenCodeUX?.setProfile?.('auto')
  else if (settings.defaultModel === 'orchestrated') window.CustomOpenCodeUX?.setProfile?.('orchestrated')
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
  if (!provider || !model) return
  $('modelButton')?.click()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const choice = document.querySelector(`#modelChoices [data-model="${CSS.escape(model)}"][data-provider="${CSS.escape(provider)}"]`)
  choice?.click()
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
    const promise = readAttachment(file, slot).catch((error) => { state.attachments[slot] = null; console.warn('attachment mirror failed', error) })
    state.attachmentReads.push(promise)
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
  // Native/control slash commands have their own interception layers and must
  // not be converted into ordinary prompt messages by the workflow sender.
  if (text.startsWith('/') && !text.startsWith('//')) return
  const hasAttachmentSurface = Boolean($('attachments') && !$('attachments').hidden && $('attachments').children.length)
  if (!text && !hasAttachmentSurface && !state.attachments.length && !state.attachmentReads.length) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const files = await awaitAttachments()
  const profile = currentProfile()
  try {
    if (running()) {
      await request('/client-queue.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, text, files, profile }) })
      clearComposer()
      await refreshQueue()
      toast('Добавлено в серверную очередь')
      return
    }
    const sent = await request('/client-send.json', { method:'POST', body:JSON.stringify({ sessionID:state.sessionID, text, files, profile }) })
    clearComposer()
    if ($('stop')) $('stop').hidden = false
    if (!state.runStartedAt) state.runStartedAt = Date.now()
    if (sent?.route) state.autoRoute = sent.route
    renderStatus()
    toast(profile === 'auto' ? `Отправлено · ${state.autoRoute?.route === 'local' ? 'local' : 'cloud'}` : 'Отправлено', 1300)
    setTimeout(() => refreshOrchestration(), 300)
  } catch (error) {
    toast(`Отправка: ${error.message}`, 6000)
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
  document.querySelectorAll('[data-persistent-queue]').forEach((el) => el.remove())
  for (const [sessionID, count] of Object.entries(state.queueCounts || {})) {
    if (!count) continue
    const button = document.querySelector(`[data-session="${CSS.escape(sessionID)}"]`)
    const meta = button?.querySelector('.session-meta')
    if (!meta) continue
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
  try { await request(`/client-queue.json?sessionID=${encodeURIComponent(state.sessionID)}&id=${encodeURIComponent(id)}`, { method:'DELETE' }); await refreshQueue() } catch (error) { toast(error.message) }
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

async function questionRequests() {
  if (!state.sessionID || !state.directory) return []
  const q = workspaceQuery()
  const endpoints = [`/api/question/request${q ? `?${q}` : ''}`, `/api/question${q ? `?${q}` : ''}`]
  for (const endpoint of endpoints) {
    try {
      const value = dataOf(await request(endpoint))
      if (!Array.isArray(value)) continue
      return value.filter((item) => !item?.sessionID || item.sessionID === state.sessionID)
    } catch (error) {
      if (![404,405].includes(error.status)) console.debug('question endpoint', error)
    }
  }
  return []
}
function normalizeQuestionRequest(raw) {
  if (!raw || typeof raw !== 'object') return null
  const questions = Array.isArray(raw.questions) ? [...raw.questions] : Array.isArray(raw.question) ? [...raw.question] : []
  if (!questions.length && raw.question && typeof raw.question === 'string') {
    questions.push({ question:raw.question, header:raw.header, options:raw.options, multiple:raw.multiple })
  }
  if (!questions.length) return null
  return {
    id: String(raw.requestID || raw.id || ''),
    sessionID: String(raw.sessionID || state.sessionID || ''),
    questions: questions.map((question, index) => ({
      header: String(question?.header || `Вопрос ${index + 1}`),
      question: String(question?.question || question?.text || ''),
      multiple: Boolean(question?.multiple),
      options: (Array.isArray(question?.options) ? question.options : []).map((option) => typeof option === 'string' ? { label:option, description:'' } : { label:String(option?.label || option?.value || ''), description:String(option?.description || '') }).filter((option) => option.label),
    })),
  }
}
async function refreshQuestions() {
  if (!state.sessionID) {
    if (state.questionKey) { state.question = null; state.questionKey = ''; renderQuestion() }
    return
  }
  try {
    const requests = await questionRequests()
    const requestRow = requests.map(normalizeQuestionRequest).find((item) => item?.id) || null
    const key = requestRow ? `${requestRow.sessionID}:${requestRow.id}` : ''
    if (key !== state.questionKey) {
      state.questionKey = key
      state.question = requestRow
      state.questionSelection = requestRow ? requestRow.questions.map(() => ({ selected:new Set(), custom:'' })) : []
      renderQuestion()
      if (requestRow) notifyAdvanced('OpenCode ждёт выбора', requestRow.questions[0]?.question || 'Нужно выбрать вариант', `question-${requestRow.id}`)
    } else {
      // Keep the existing DOM while the same request is pending. Rebuilding it
      // on every poll would destroy focus and a custom answer being typed.
      state.question = requestRow
    }
  } catch {}
}
function renderQuestion() {
  const host = $('questionHost')
  if (!host) return
  const requestRow = state.question
  host.hidden = !requestRow
  if (!requestRow) { host.innerHTML = ''; return }
  host.innerHTML = `<div class="question-card"><div class="question-head"><div><div class="question-kicker">Нужен твой выбор</div><div class="question-title">${escapeHtml(requestRow.questions.length > 1 ? `Вопросов: ${requestRow.questions.length}` : requestRow.questions[0].header)}</div></div><button class="question-close" type="button" data-question-reject title="Отклонить вопрос">×</button></div><div class="question-sections">${requestRow.questions.map((question, qIndex) => `<div class="question-section ${question.multiple ? 'multiple' : ''}" data-question-index="${qIndex}"><div><div class="question-kicker">${escapeHtml(question.header)}</div><div class="question-section-title">${escapeHtml(question.question)}</div></div><div class="question-options">${question.options.map((option, oIndex) => `<button type="button" class="question-option" data-question-option="${qIndex}:${oIndex}"><span class="question-option-mark"></span><span class="question-option-text"><span class="question-option-label">${escapeHtml(option.label)}</span>${option.description ? `<span class="question-option-description">${escapeHtml(option.description)}</span>` : ''}</span></button>`).join('')}</div><div class="question-custom"><input data-question-custom="${qIndex}" value="${escapeHtml(state.questionSelection[qIndex]?.custom || '')}" placeholder="Свой вариант…"><button type="button" data-question-custom-use="${qIndex}">Использовать</button></div></div>`).join('')}</div><div class="question-actions"><button type="button" data-question-reject>Отмена</button><button type="button" class="primary" data-question-submit>Продолжить</button></div></div>`
  for (let qIndex = 0; qIndex < requestRow.questions.length; qIndex++) syncQuestionSection(qIndex)
  host.querySelectorAll('[data-question-option]').forEach((button) => button.addEventListener('click', () => {
    const [qIndexText, optionIndexText] = button.dataset.questionOption.split(':')
    const qIndex = Number(qIndexText), optionIndex = Number(optionIndexText)
    const question = requestRow.questions[qIndex], selection = state.questionSelection[qIndex]
    const label = question.options[optionIndex]?.label
    if (!label) return
    if (!question.multiple) selection.selected.clear()
    selection.selected.has(label) ? selection.selected.delete(label) : selection.selected.add(label)
    if (!question.multiple && selection.selected.size) { selection.custom = ''; const input = host.querySelector(`[data-question-custom="${qIndex}"]`); if (input) input.value = '' }
    syncQuestionSection(qIndex)
  }))
  host.querySelectorAll('[data-question-custom]').forEach((input) => input.addEventListener('input', () => {
    const qIndex = Number(input.dataset.questionCustom)
    state.questionSelection[qIndex].custom = input.value
    if (input.value.trim() && !requestRow.questions[qIndex].multiple) state.questionSelection[qIndex].selected.clear()
    syncQuestionSection(qIndex)
  }))
  host.querySelectorAll('[data-question-custom-use]').forEach((button) => button.addEventListener('click', () => {
    const qIndex = Number(button.dataset.questionCustomUse)
    const input = host.querySelector(`[data-question-custom="${qIndex}"]`)
    input?.focus()
    if (input?.value.trim()) syncQuestionSection(qIndex)
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
    const label = question.options[optionIndex]?.label
    const selected = selection.selected.has(label)
    button.classList.toggle('selected', selected)
    button.querySelector('.question-option-mark').textContent = selected ? '✓' : ''
  })
}
function questionAnswers() {
  return (state.question?.questions || []).map((question, index) => {
    const selection = state.questionSelection[index]
    const values = [...selection.selected]
    const custom = String(selection.custom || '').trim()
    if (custom) {
      if (!question.multiple) return [custom]
      if (!values.includes(custom)) values.push(custom)
    }
    return values
  })
}
async function submitQuestion() {
  if (!state.question) return
  const answers = questionAnswers()
  if (answers.some((row) => !row.length)) { toast('Нужно ответить на каждый вопрос'); return }
  const sid = state.question.sessionID || state.sessionID
  const qid = state.question.id
  const q = workspaceQuery()
  const attempts = [
    [`/api/session/${encodeURIComponent(sid)}/question/request/${encodeURIComponent(qid)}/reply`, { answers }],
    [`/api/session/${encodeURIComponent(sid)}/question/request/${encodeURIComponent(qid)}/reply`, { response:{ answers } }],
    [`/api/question/${encodeURIComponent(qid)}/reply${q ? `?${q}` : ''}`, { answers }],
  ]
  let lastError
  for (const [path, body] of attempts) {
    try {
      await request(path, { method:'POST', body:JSON.stringify(body) })
      state.question = null; state.questionKey = ''; renderQuestion(); toast('Ответ отправлен'); return
    } catch (error) { lastError = error; if (![400,404,405,422].includes(error.status)) break }
  }
  toast(`Ответ: ${lastError?.message || 'не удалось отправить'}`, 6000)
}
async function rejectQuestion() {
  if (!state.question) return
  const sid = state.question.sessionID || state.sessionID
  const qid = state.question.id
  const q = workspaceQuery()
  const endpoints = [`/api/session/${encodeURIComponent(sid)}/question/request/${encodeURIComponent(qid)}/reject`, `/api/question/${encodeURIComponent(qid)}/reject${q ? `?${q}` : ''}`]
  for (const path of endpoints) {
    try { await request(path, { method:'POST', body:'{}' }); state.question = null; state.questionKey = ''; renderQuestion(); toast('Вопрос отклонён'); return } catch (error) { if (![400,404,405].includes(error.status)) break }
  }
  toast('Не удалось отклонить вопрос')
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

async function refreshAutoRoute() {
  if (!state.sessionID) return
  try { state.autoRoute = await request(`/client-auto-route.json?sessionID=${encodeURIComponent(state.sessionID)}`); renderStatus() } catch { state.autoRoute = null }
}

function childStatus(value) {
  const raw = typeof value === 'string' ? value : value?.type || value?.status || value?.state || ''
  return /busy|running|retry|working|pending/i.test(String(raw)) ? 'running' : /error|failed/i.test(String(raw)) ? 'error' : 'done'
}
async function refreshOrchestration() {
  if (!state.sessionID) return
  let children = []
  try {
    const value = dataOf(await request(`/api/session/${encodeURIComponent(state.sessionID)}/children`))
    if (Array.isArray(value)) children = value
  } catch {}
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
  const children = state.children || []
  const visible = currentProfile() === 'orchestrated' || children.length > 0
  host.hidden = !state.sessionID || !visible
  if (host.hidden) { host.innerHTML = ''; return }
  const rootModel = $('modelButton')?.textContent || state.session?.model?.id || 'Primary'
  const rootStatus = running() ? 'running' : 'done'
  const nodes = [`<div class="orchestration-node ${rootStatus}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(rootModel)}</div><div class="node-meta">${escapeHtml(currentMode())} · primary</div></div><span class="node-time">${state.runStartedAt ? fmtDuration(Date.now() - state.runStartedAt) : state.lastDurationMs ? fmtDuration(state.lastDurationMs) : ''}</span></div>`]
  for (const child of children) {
    const id = child?.id || ''
    const status = childStatus(statuses?.[id])
    const model = child?.model?.id || child?.modelID || child?.model || 'subagent'
    const agent = child?.agent || child?.title || 'subagent'
    const detail = state.childDetails.get(id) || {}
    const created = child?.time?.created || child?.createdAt || 0
    const updated = child?.time?.updated || child?.updatedAt || Date.now()
    nodes.push(`<div class="orchestration-node ${detail.error ? 'error' : status}"><span class="node-icon"></span><div class="node-main"><div class="node-title">${escapeHtml(agent)}</div><div class="node-meta">${escapeHtml(typeof model === 'string' ? model : JSON.stringify(model))}${detail.rag ? ' · RAG ✓' : ''}</div></div><span class="node-time">${created ? fmtDuration(Math.max(0, updated - created)) : ''}</span></div>`)
  }
  host.innerHTML = `<details><summary>Оркестрация · ${children.length ? `${children.length} подзадач` : 'primary'}${children.some((child) => state.childDetails.get(child.id)?.rag) ? ' · RAG ✓' : ''}</summary><div class="orchestration-nodes">${nodes.join('')}</div></details>`
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
  const auto = currentProfile() === 'auto' ? state.autoRoute : null
  const routeText = auto ? `${auto.route === 'local' ? 'Local' : 'Cloud'}${auto.resources?.reason && auto.resources.reason !== 'idle' ? ` · ${auto.resources.reason}` : ''}` : ''
  host.innerHTML = `<span class="wf-pill strong">${escapeHtml(model)}</span>${context ? `<span class="wf-pill">${escapeHtml(context)}</span>` : ''}${cost ? `<span class="wf-pill">${escapeHtml(cost)}</span>` : ''}${elapsed ? `<span class="wf-pill"><span class="wf-dot ${running() ? 'busy' : ''}"></span>${escapeHtml(elapsed)}</span>` : ''}${routeText ? `<span class="wf-pill">Auto: ${escapeHtml(routeText)}</span>` : ''}${rag ? '<span class="wf-pill">RAG ✓</span>' : ''}<button type="button" class="wf-pill clickable" id="queueStatusButton">Очередь ${queue}</button>`
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
  host.querySelectorAll('[data-revert-file]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); revertReviewFile(Number(button.dataset.revertFile)) }))
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
  try {
    const registration = await navigator.serviceWorker?.ready
    const data = { url:state.sessionID ? `/#/session/${encodeURIComponent(state.sessionID)}` : '/' }
    if (registration?.showNotification) {
      await registration.showNotification(title, { body, tag, data, actions:[{ action:'open', title:'Открыть' }, { action:'dismiss', title:'Закрыть' }] })
    }
  } catch {}
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
    renderStatus(); renderOrchestration()
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshSelectedSession(); refreshQueue(); refreshQuestions(); refreshOrchestration(); refreshPermission(); refreshAutoRoute()
    }
  })
}

async function tickFast() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQuestions(), refreshPermission()])
}
async function tickMedium() {
  if (!document.hidden && state.sessionID) await Promise.allSettled([refreshQueue(), refreshOrchestration(), refreshAutoRoute()])
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

init()
