import './local-model-boundary.js'
import {
  ORCHESTRATED_MODEL,
  agentFor,
  composerActionState,
  modeFromAgent,
  permissionSummary,
  profileFromAgent,
} from './ux-state.js'

const $ = (id) => document.getElementById(id)
const PROFILE_KEY = 'opencode:web:model-profiles-v1'
let allowingAgentClick = false
let suppressDirectSwitch = false
let lastPermissionRaw = ''
let desiredProfile = null

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
  return agentButtons().find((button) => button.classList.contains('active'))?.dataset.agent || 'build-direct'
}
function currentMode() {
  return modeFromAgent(rawActiveAgent())
}
function currentProfile() {
  return desiredProfile || profileFromAgent(rawActiveAgent())
}
function nativeAgentButton(agentID) {
  return agentButtons().find((button) => button.dataset.agent === agentID) || null
}
function clickNativeAgent(agentID) {
  const button = nativeAgentButton(agentID)
  if (!button) return false
  allowingAgentClick = true
  try { button.click() } finally {
    queueMicrotask(() => {
      allowingAgentClick = false
      syncAgentSurface()
      syncModelSurface()
    })
  }
  return true
}

function syncAgentSurface() {
  const mode = currentMode()
  const rawProfile = profileFromAgent(rawActiveAgent())
  if (desiredProfile && desiredProfile === rawProfile) desiredProfile = null
  const profile = currentProfile()
  document.documentElement.dataset.modelProfile = profile
  document.documentElement.dataset.executionMode = mode
  for (const button of agentButtons()) {
    const id = button.dataset.agent || ''
    button.classList.toggle('ux-hidden-agent', id !== 'build' && id !== 'plan')
    const visibleMode = id === 'plan' ? 'plan' : id === 'build' ? 'build' : ''
    button.classList.toggle('ux-mode-active', Boolean(visibleMode) && visibleMode === mode)
    if (id === 'build' && button.textContent !== 'Build') button.textContent = 'Build'
    if (id === 'plan' && button.textContent !== 'Plan') button.textContent = 'Plan'
  }
}

function qwenMaxSelected() {
  const text = $('modelButton')?.textContent || ''
  return /qwen\s*3[.\s]?8.*max|qwen3\.8-max/i.test(text)
}
function nativeModelLoaded() {
  const text = $('modelButton')?.textContent?.trim() || ''
  return Boolean(text && text !== 'Модель' && !/^Model\b/i.test(text))
}
function normalizeLegacyProfile() {
  if (desiredProfile || !nativeModelLoaded()) return
  if (profileFromAgent(rawActiveAgent()) === 'orchestrated' && !qwenMaxSelected()) {
    desiredProfile = 'direct'
    persistProfile('direct')
    clickNativeAgent(agentFor(currentMode(), 'direct'))
  }
}
function syncOrchestratedChoiceLabel() {
  const title = document.querySelector('#modelChoices [data-orchestrated-model] .choice-title')
  if (!title) return
  const selected = document.documentElement.dataset.modelProfile === 'orchestrated'
  const next = `${ORCHESTRATED_MODEL.label}${selected ? ' · ✓' : ''}`
  if (title.textContent !== next) title.textContent = next
}
function syncModelSurface() {
  const button = $('modelButton')
  if (!button) return
  normalizeLegacyProfile()
  const profile = currentProfile()
  document.documentElement.dataset.modelProfile = profile
  if (profile === 'orchestrated' && qwenMaxSelected()) {
    if (button.textContent !== ORCHESTRATED_MODEL.label) button.textContent = ORCHESTRATED_MODEL.label
    button.title = 'Qwen 3.8 Max с автоматической делегацией дешёвому read-only worker и optional RAG'
  } else {
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

function nativeQwenMaxChoice() {
  return document.querySelector('#modelChoices [data-model="qwen3.8-max"][data-provider="bailian-cli"]')
}
function chooseOrchestrated() {
  const mode = currentMode()
  const nativeModel = nativeQwenMaxChoice()
  if (!nativeModel) return
  desiredProfile = 'orchestrated'
  persistProfile('orchestrated')
  clickNativeAgent(agentFor(mode, 'orchestrated'))
  suppressDirectSwitch = true
  try { nativeModel.click() } finally {
    queueMicrotask(() => {
      suppressDirectSwitch = false
      desiredProfile = 'orchestrated'
      document.documentElement.dataset.modelProfile = 'orchestrated'
      syncAgentSurface()
      syncModelSurface()
    })
  }
}
function chooseDirect() {
  desiredProfile = 'direct'
  persistProfile('direct')
  clickNativeAgent(agentFor(currentMode(), 'direct'))
  document.documentElement.dataset.modelProfile = 'direct'
  syncModelSurface()
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
    const target = agentFor(requestedMode, currentProfile())
    if (target === requested) return
    event.preventDefault()
    event.stopImmediatePropagation()
    clickNativeAgent(target)
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
      chooseOrchestrated()
      return
    }
    const native = event.target.closest('[data-model][data-provider]')
    if (!native || suppressDirectSwitch || event.target.closest('[data-fav]')) return
    chooseDirect()
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
  window.addEventListener('hashchange', () => {
    restoreDesiredProfile()
    queueMicrotask(() => {
      syncAgentSurface()
      syncModelSurface()
    })
  })
}

function init() {
  restoreDesiredProfile()
  installAgentModeProxy()
  installModelProfileProxy()
  installComposerAction()
  installPermissionSummary()
  installSessionProfileRestore()
  syncAgentSurface()
  syncModelSurface()
  window.CustomOpenCodeUX = {
    currentProfile,
    currentMode,
    chooseOrchestrated,
    setProfile(profile) {
      if (profile === 'orchestrated') return chooseOrchestrated()
      return chooseDirect()
    },
  }
}

if (typeof document !== 'undefined') init()
