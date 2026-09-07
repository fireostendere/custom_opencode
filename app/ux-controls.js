import {
  ORCHESTRATED_MODEL,
  ORCHESTRATED_MODELS,
  agentFor,
  composerActionState,
  permissionSummary,
  profileFromAgent,
} from './ux-state.js'

const $ = (id) => document.getElementById(id)
const PROFILE_KEY = 'opencode:web:model-profiles-v1'
let allowingAgentClick = false
let lastPermissionRaw = ''
let desiredProfile = null
let pendingAgentTarget = ''
let failedAgentTarget = ''
let modelTransition = null

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {} } catch { return {} }
}
function profileSessionKey() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash || '')
  return match ? decodeURIComponent(match[1]) : '__new__'
}
function storedProfile() {
  const value = loadProfiles()[profileSessionKey()]
  return ['direct', 'orchestrated'].includes(value) ? value : null
}
function persistProfile(profile) {
  const values = loadProfiles()
  values[profileSessionKey()] = profile
  localStorage.setItem(PROFILE_KEY, JSON.stringify(values))
}
function restoreDesiredProfile() {
  desiredProfile = storedProfile()
}

function agentButtons() {
  return [...document.querySelectorAll('#agentControls [data-agent]')]
}
function rawActiveAgent() {
  const active = agentButtons().filter((button) => button.classList.contains('active'))
  return active.find((button) => !['build', 'plan'].includes(button.dataset.agent))?.dataset.agent || active[0]?.dataset.agent || 'build'
}
function currentMode() {
  return 'build'
}
function currentProfile() {
  if (desiredProfile) return desiredProfile
  return orchestratedModelSelected() ? 'orchestrated' : profileFromAgent(rawActiveAgent())
}
function nativeAgentButton(agentID) {
  return agentButtons().find((button) => button.dataset.agent === agentID) || null
}
function targetAgent(mode, profile) {
  const preferred = agentFor(mode, profile)
  return nativeAgentButton(preferred) ? preferred : mode
}
function clickNativeAgent(agentID, allowVirtual = false) {
  const button = nativeAgentButton(agentID)
  if (!button) {
    if (!allowVirtual || pendingAgentTarget === agentID) return false
    const changeAgent = window.CustomOpenCodeControls?.changeAgent
    if (typeof changeAgent !== 'function') return false
    pendingAgentTarget = agentID
    failedAgentTarget = ''
    Promise.resolve(changeAgent(agentID)).then((ok) => {
      if (pendingAgentTarget !== agentID) return
      pendingAgentTarget = ''
      if (!ok) failedAgentTarget = agentID
      syncAgentSurface()
    }).catch(() => {
      if (pendingAgentTarget !== agentID) return
      pendingAgentTarget = ''
      failedAgentTarget = agentID
      syncAgentSurface()
    })
    return true
  }
  if (rawActiveAgent() === agentID) {
    pendingAgentTarget = ''
    failedAgentTarget = ''
    return true
  }
  if (pendingAgentTarget === agentID) return false
  failedAgentTarget = ''
  pendingAgentTarget = agentID
  allowingAgentClick = true
  try { button.click() } finally {
    queueMicrotask(() => {
      allowingAgentClick = false
      if (rawActiveAgent() === agentID) pendingAgentTarget = ''
      if (pendingAgentTarget === agentID && rawActiveAgent() !== agentID) return
      syncAgentSurface()
      syncModelSurface()
    })
  }
  setTimeout(() => {
    if (pendingAgentTarget !== agentID || rawActiveAgent() === agentID) return
    pendingAgentTarget = ''
    failedAgentTarget = agentID
    syncAgentSurface()
  }, 10000)
  return true
}

function syncAgentSurface() {
  const activeAgent = rawActiveAgent()
  if (pendingAgentTarget && activeAgent === pendingAgentTarget) {
    pendingAgentTarget = ''
    failedAgentTarget = ''
  }
  const mode = currentMode()
  const profile = currentProfile()
  const expectedAgent = targetAgent(mode, profile)
  if (expectedAgent !== activeAgent && expectedAgent !== failedAgentTarget) clickNativeAgent(expectedAgent)
  document.documentElement.dataset.modelProfile = profile
  document.documentElement.dataset.executionMode = mode
  for (const button of agentButtons()) {
    const id = button.dataset.agent || ''
    button.classList.toggle('ux-hidden-agent', !['build', 'plan'].includes(id))
    button.classList.toggle('active', id === mode || id === activeAgent && ['build', 'plan'].includes(id))
  }
}

function selectedOrchestratedModel() {
  const selectedID = document.documentElement.dataset.orchestratedModel || ''
  const byID = ORCHESTRATED_MODELS.find((model) => model.id === selectedID)
  if (byID) return byID
  const text = $('modelButton')?.textContent || ''
  return ORCHESTRATED_MODELS.find((model) => text.includes(model.id) || text.includes(model.label)) || null
}
function orchestratedModelSelected() {
  return Boolean(selectedOrchestratedModel())
}
function syncOrchestratedChoiceLabel() {
  const selectedID = selectedOrchestratedModel()?.id || ''
  for (const choice of document.querySelectorAll('#modelChoices [data-orchestrated-model]')) {
    const model = ORCHESTRATED_MODELS.find((item) => item.id === choice.dataset.model)
    const title = choice.querySelector('.choice-title')
    if (!model || !title) continue
    const selected = document.documentElement.dataset.modelProfile === 'orchestrated' && selectedID === model.id
    const next = `${model.label}${selected ? ' · ✓' : ''}`
    if (title.textContent !== next) title.textContent = next
  }
}
function syncModelSurface() {
  const button = $('modelButton')
  if (!button) return
  const profile = currentProfile()
  document.documentElement.dataset.modelProfile = profile
  const selectedOrchestrated = selectedOrchestratedModel()
  if (profile === 'orchestrated' && selectedOrchestrated) {
    if (button.textContent !== selectedOrchestrated.label) button.textContent = selectedOrchestrated.label
    document.documentElement.dataset.orchestratedModel = selectedOrchestrated.id
    button.title = `${selectedOrchestrated.label} с автоматической делегацией read-only worker и optional RAG`
  } else {
    delete document.documentElement.dataset.orchestratedModel
    button.title = 'Выбрать модель'
  }
  syncOrchestratedChoiceLabel()
}

function hasPayload() {
  const text = $('input')?.value.trim() || ''
  const attachments = $('attachments')
  return Boolean(text) || Boolean(attachments && !attachments.hidden && attachments.children.length)
}
function isRunning() {
  return Boolean($('stop') && !$('stop').hidden)
}
function setNativeDelivery(mode) {
  const button = document.querySelector(`[data-delivery="${mode}"]`)
  if (button && !button.classList.contains('active')) button.click()
}
function syncComposerAction() {
  const button = $('composerAction')
  if (!button) return
  const action = composerActionState({ running: isRunning(), hasPayload: hasPayload() })
  if (button.textContent !== action.symbol) button.textContent = action.symbol
  button.title = action.title
  button.setAttribute('aria-label', action.title)
  button.dataset.action = action.kind
  button.className = `composer-action ${action.kind}`
  if (action.kind === 'queue') setNativeDelivery('queue')
  const input = $('input')
  if (input) input.placeholder = action.kind === 'queue' ? 'Сообщение в очередь…' : 'Сообщение…'
}

function syncPermission() {
  const detail = $('permissionDetail')
  const summary = $('permissionSummary')
  const details = $('permissionDetails')
  if (!detail || !summary) return
  const raw = detail.textContent || ''
  const title = $('permissionTitle')?.textContent?.trim() || 'Разрешение'
  const compact = permissionSummary(title, raw)
  if (summary.textContent !== compact) summary.textContent = compact
  if (raw !== lastPermissionRaw) {
    lastPermissionRaw = raw
    if (details) details.open = false
  }
}

function setTransitionControls(disabled) {
  for (const id of ['input', 'composerAction', 'modelButton', 'variantSelect', 'attachButton']) {
    const control = $(id)
    if (control) control.disabled = disabled
  }
}
function nativeOrchestratedChoice(model = ORCHESTRATED_MODEL) {
  return document.querySelector(`#modelChoices [data-model="${model.id}"][data-provider="${model.providerID}"]`)
}
function beginModelTransition(profile, model) {
  const sessionID = profileSessionKey()
  const token = Symbol('model-transition')
  modelTransition = { token, sessionID, profile, model, previousProfile:currentProfile(), previousModel:null }
  document.documentElement.dataset.modelTransition = '1'
  setTransitionControls(true)
  return modelTransition
}
function endModelTransition(pending, profile) {
  if (modelTransition !== pending) return
  modelTransition = null
  delete document.documentElement.dataset.modelTransition
  desiredProfile = profile
  persistProfile(profile)
  setTransitionControls(false)
  syncAgentSurface(); syncModelSurface()
}
async function chooseModel(profile, model) {
  if (modelTransition || !window.CustomOpenCodeControls) return
  const pending = beginModelTransition(profile, model)
  const valid = () => modelTransition === pending && pending.sessionID === profileSessionKey()
  const changed = await window.CustomOpenCodeControls.changeModel(model)
  if (!valid()) { setTransitionControls(false); return }
  if (!changed) { endModelTransition(pending, pending.previousProfile); return }
  pending.agent = targetAgent(currentMode(), profile)
  const agentChanged = await window.CustomOpenCodeControls.changeAgent(pending.agent)
  if (!valid()) { setTransitionControls(false); return }
  if (agentChanged) {
    if (profile === 'orchestrated') document.documentElement.dataset.orchestratedModel = model.id
    else delete document.documentElement.dataset.orchestratedModel
    endModelTransition(pending, profile)
    return
  }
  if (pending.previousModel) await window.CustomOpenCodeControls.changeModel(pending.previousModel)
  if (valid()) endModelTransition(pending, pending.previousProfile)
}
function finishModelTransition(detail) {
  const pending = modelTransition, model = detail?.model || {}
  if (!pending || pending.sessionID !== profileSessionKey()) return
  if (detail?.sessionID !== (pending.sessionID === '__new__' ? null : pending.sessionID) || model.id !== pending.model.id || model.providerID !== pending.model.providerID) return
  pending.previousModel ||= detail.previousModel || null
}
function finishAgentTransition(detail) {
  const pending = modelTransition
  if (!pending || pending.sessionID !== profileSessionKey() || detail?.agent !== pending.agent) return
  if (detail?.sessionID !== (pending.sessionID === '__new__' ? null : pending.sessionID)) return
}
function chooseOrchestrated(model = ORCHESTRATED_MODEL) { chooseModel('orchestrated', model) }
function chooseDirect() {
  const model = window.CustomOpenCodeControls?.directModel?.()
  if (model) return chooseModel('direct', model)
  desiredProfile = 'direct'
  persistProfile('direct')
  syncAgentSurface()
  syncModelSurface()
  return Promise.resolve(false)
}

function installAgentModeProxy() {
  const root = $('agentControls')
  if (!root) return
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent]')
    if (!button || allowingAgentClick) return
    const requested = button.dataset.agent
    if (requested !== 'build' && requested !== 'plan') return
    const requestedMode = requested === 'plan' ? 'plan' : 'build'
    failedAgentTarget = ''
    const target = targetAgent(requestedMode, currentProfile())
    if (target === requested) return
    event.preventDefault()
    event.stopImmediatePropagation()
    clickNativeAgent(target, true)
  }, true)

  const observer = new MutationObserver(() => {
    queueMicrotask(() => {
      syncAgentSurface()
      syncModelSurface()
    })
  })
  observer.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] })
}

function installModelProfileProxy() {
  const root = $('modelChoices')
  if (!root) return
  root.addEventListener('click', (event) => {
    const orchestrated = event.target.closest('[data-orchestrated-model]')
    if (orchestrated) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const model = ORCHESTRATED_MODELS.find((item) => item.id === orchestrated.dataset.model)
      if (model) chooseOrchestrated(model)
      return
    }
    const native = event.target.closest('[data-model][data-provider]')
    if (!native || event.target.closest('[data-fav]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    $('modelDialog')?.close()
    const model = { id:native.dataset.model, providerID:native.dataset.provider }
    const profile = ORCHESTRATED_MODELS.some((item) => item.providerID === model.providerID && item.id === model.id) ? 'orchestrated' : 'direct'
    chooseModel(profile, model)
  }, true)

  new MutationObserver(() => queueMicrotask(syncOrchestratedChoiceLabel)).observe(root, { childList:true, subtree:true })
  const modelButton = $('modelButton')
  modelButton?.addEventListener('click', () => {
    document.documentElement.dataset.modelProfile = currentProfile()
    queueMicrotask(syncOrchestratedChoiceLabel)
  }, true)
  if (modelButton) new MutationObserver(() => queueMicrotask(syncModelSurface)).observe(modelButton, { childList:true, characterData:true, subtree:true })
}

function installComposerAction() {
  $('composerAction')?.addEventListener('click', () => {
    const action = composerActionState({ running:isRunning(), hasPayload:hasPayload() })
    if (action.kind === 'stop') {
      $('stop')?.click()
      return
    }
    if (action.kind === 'queue') setNativeDelivery('queue')
    $('form')?.requestSubmit()
  })
  $('form')?.addEventListener('submit', () => setTimeout(syncComposerAction, 0))
  $('input')?.addEventListener('input', syncComposerAction)
  const stop = $('stop')
  if (stop) new MutationObserver(syncComposerAction).observe(stop, { attributes:true, attributeFilter:['hidden'] })
  const attachments = $('attachments')
  if (attachments) new MutationObserver(syncComposerAction).observe(attachments, { childList:true, attributes:true, attributeFilter:['hidden'] })
  syncComposerAction()
}

function installPermissionSummary() {
  const detail = $('permissionDetail')
  if (!detail) return
  new MutationObserver(syncPermission).observe(detail, { childList:true, characterData:true, subtree:true })
  syncPermission()
}
function installSessionProfileRestore() {
  const restoreSessionProfile = () => {
    restoreDesiredProfile()
    pendingAgentTarget = ''
    failedAgentTarget = ''
    modelTransition = null
    delete document.documentElement.dataset.modelTransition
    setTransitionControls(false)
    queueMicrotask(() => {
      syncAgentSurface()
      syncModelSurface()
    })
  }
  window.addEventListener('hashchange', restoreSessionProfile)
  window.addEventListener('custom-opencode:session-selected', restoreSessionProfile)
}

function installSelectedChatScrollSettle() {
  window.addEventListener('custom-opencode:session-selected', () => {
    const view = $('messages')
    if (!view || !/^#\/session\//.test(location.hash || '')) return
    const selectedHash = location.hash
    const settle = () => {
      if (location.hash === selectedHash) view.scrollTop = view.scrollHeight
    }
    settle()
    requestAnimationFrame(() => requestAnimationFrame(settle))
    document.fonts?.ready?.then(settle).catch?.(() => {})
  })
}

function init() {
  window.addEventListener('custom-opencode:model-changed', (event) => finishModelTransition(event.detail))
  window.addEventListener('custom-opencode:agent-changed', (event) => finishAgentTransition(event.detail))
  restoreDesiredProfile()
  installAgentModeProxy()
  installModelProfileProxy()
  installComposerAction()
  installPermissionSummary()
  installSessionProfileRestore()
  installSelectedChatScrollSettle()
  syncAgentSurface()
  syncModelSurface()
  window.CustomOpenCodeUX = {
    currentProfile,
    currentMode,
    chooseOrchestrated,
    setProfile(profile) {
      if (profile === 'orchestrated') return chooseOrchestrated()
      const model = ORCHESTRATED_MODELS.find((item) => item.id === profile || item.providerID + '/' + item.id === profile)
      if (model) return chooseOrchestrated(model)
      return chooseDirect()
    },
  }
}

if (typeof document !== 'undefined') init()
