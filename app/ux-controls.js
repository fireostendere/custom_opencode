import {
  ORCHESTRATED_MODEL,
  ORCHESTRATED_MODELS,
  agentAfterModelPick,
  agentFor,
  composerActionState,
  modeFromAgent,
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
  if (!match) return '__new__'
  try { return decodeURIComponent(match[1]) } catch { return '__new__' }
}
function storedProfile() {
  const value = loadProfiles()[profileSessionKey()]
  return ['direct', 'orchestrated', 'dnd-edition'].includes(value) ? value : null
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
  return modeFromAgent(rawActiveAgent())
}
function currentProfile() {
  if (!modelTransition && window.CustomOpenCodeControls?.activeModel?.()) return profileForModel(selectedOrchestratedModel())
  if (desiredProfile) return desiredProfile
  return selectedOrchestratedModel() ? profileForModel(selectedOrchestratedModel()) : profileFromAgent(rawActiveAgent())
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

// Read-only: opening or re-rendering a chat never changes its agent. Web and
// TUI share sessions, so a silent switch here used to flip Plan chats to Build
// and fight the TUI. Agents change only on an explicit model pick (D&D in/out,
// legacy migration), agent picker or Plan chip.
function syncAgentSurface() {
  const activeAgent = rawActiveAgent()
  if (pendingAgentTarget && activeAgent === pendingAgentTarget) {
    pendingAgentTarget = ''
    failedAgentTarget = ''
  }
  const mode = currentMode()
  document.documentElement.dataset.modelProfile = currentProfile()
  document.documentElement.dataset.executionMode = mode
  for (const button of agentButtons()) {
    button.classList.toggle('ux-hidden-agent', !['build', 'plan'].includes(button.dataset.agent || ''))
  }
  syncPlanChip(mode)
}

function syncPlanChip(mode) {
  let chip = $('planModeChip')
  if (!chip) {
    const anchor = $('variantSelect')?.closest('.control-select') || $('modelButton')
    if (!anchor) return
    chip = document.createElement('button')
    chip.type = 'button'
    chip.id = 'planModeChip'
    chip.className = 'control plan-mode-chip'
    chip.textContent = 'План · только чтение — вернуть Build'
    chip.title = 'Этот чат в режиме Plan: агент не меняет файлы. Нажмите, чтобы вернуть Build.'
    chip.addEventListener('click', async () => {
      chip.disabled = true
      try { await window.CustomOpenCodeControls?.changeAgent?.('build') } finally {
        chip.disabled = false
        syncAgentSurface()
      }
    })
    anchor.after(chip)
  }
  chip.hidden = !(mode === 'plan' && profileSessionKey() !== '__new__')
}

function selectedOrchestratedModel() {
  const activeModel = window.CustomOpenCodeControls?.activeModel
  if (activeModel) {
    const ref = activeModel()
    return ORCHESTRATED_MODELS.find((model) => model.id === ref?.id && model.providerID === ref?.providerID) || null
  }
  const text = $('modelButton')?.textContent || ''
  return ORCHESTRATED_MODELS.find((model) => text.includes(model.id) || text.includes(model.label)) || null
}
function profileForModel(model) { return model?.id === 'gpt-6-dnd-edition' ? 'dnd-edition' : model ? 'orchestrated' : 'direct' }
function orchestratedModelSelected() {
  return Boolean(selectedOrchestratedModel())
}
function syncOrchestratedChoiceLabel() {
  const selectedID = selectedOrchestratedModel()?.id || ''
  for (const choice of document.querySelectorAll('#modelChoices [data-orchestrated-model]')) {
    const model = ORCHESTRATED_MODELS.find((item) => item.id === choice.dataset.model)
    const title = choice.querySelector('.choice-title')
    if (!model || !title) continue
    const selected = document.documentElement.dataset.modelProfile !== 'direct' && selectedID === model.id
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
  if (profile !== 'direct' && selectedOrchestrated) {
    document.documentElement.dataset.orchestratedModel = selectedOrchestrated.id
    button.title = profile === 'dnd-edition' ? `${selectedOrchestrated.label}: ODM-only D&D tools` : `${selectedOrchestrated.label} с автоматической делегацией read-only worker и optional RAG`
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
  if (summary.dataset.serverPreview !== '1' && summary.textContent !== compact) summary.textContent = compact
  if (raw !== lastPermissionRaw) {
    lastPermissionRaw = raw
    if (details) details.open = false
  }
}

function setTransitionControls(disabled) {
  for (const id of ['input', 'composerAction', 'modelButton', 'agentSelect', 'variantSelect', 'attachButton']) {
    const control = $(id)
    if (!control) continue
    if (disabled) {
      control.dataset.transitionEnabled = control.disabled ? '0' : '1'
      control.disabled = true
    } else if ('transitionEnabled' in control.dataset) {
      control.disabled = control.dataset.transitionEnabled !== '1'
      delete control.dataset.transitionEnabled
    }
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
function cancelModelTransition(pending) {
  if (modelTransition !== pending) return
  modelTransition = null
  delete document.documentElement.dataset.modelTransition
  setTransitionControls(false)
  syncAgentSurface(); syncModelSurface()
}
async function chooseModel(profile, model) {
  if (modelTransition || !window.CustomOpenCodeControls) return false
  const pending = beginModelTransition(profile, model)
  const valid = () => modelTransition === pending && pending.sessionID === profileSessionKey()
  try {
    const changed = await window.CustomOpenCodeControls.changeModel(model)
    if (!valid()) { cancelModelTransition(pending); return false }
    if (!changed) { endModelTransition(pending, pending.previousProfile); return false }
    const nextAgent = agentAfterModelPick(rawActiveAgent(), profile)
    pending.agent = nextAgent && nativeAgentButton(nextAgent) ? nextAgent : rawActiveAgent()
    const agentChanged = pending.agent === rawActiveAgent() || await window.CustomOpenCodeControls.changeAgent(pending.agent)
    if (!valid()) { cancelModelTransition(pending); return false }
    if (agentChanged) {
      if (profile !== 'direct') document.documentElement.dataset.orchestratedModel = model.id
      else delete document.documentElement.dataset.orchestratedModel
      endModelTransition(pending, profile)
      return true
    }
    if (pending.previousModel) await window.CustomOpenCodeControls.changeModel(pending.previousModel)
    if (valid()) endModelTransition(pending, pending.previousProfile)
    return false
  } catch (error) {
    console.warn('model transition failed', error)
    if (valid()) endModelTransition(pending, pending.previousProfile)
    else cancelModelTransition(pending)
    return false
  } finally {
    if (modelTransition === pending && pending.sessionID !== profileSessionKey()) cancelModelTransition(pending)
  }
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
function chooseOrchestrated(model = ORCHESTRATED_MODEL) { return chooseModel(profileForModel(model), model) }
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
    // Scoped to the list: <html> carries data-orchestrated-model for the active
    // profile, and closest() used to reach it and swallow every pick in a D&D or
    // orchestrated chat.
    const orchestrated = event.target.closest('[data-orchestrated-model]')
    if (orchestrated && root.contains(orchestrated)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const model = ORCHESTRATED_MODELS.find((item) => item.id === orchestrated.dataset.model)
      if (model) void chooseOrchestrated(model).then((changed) => { if (changed) $('modelDialog')?.close() })
      return
    }
    const native = event.target.closest('[data-model][data-provider]')
    if (!native || event.target.closest('[data-fav],[data-model-remove]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const model = { id:native.dataset.model, providerID:native.dataset.provider }
    const profile = profileForModel(ORCHESTRATED_MODELS.find((item) => item.providerID === model.providerID && item.id === model.id))
    void chooseModel(profile, model).then((changed) => { if (changed) $('modelDialog')?.close() })
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

// Desktop chip menus. The native <select> popup ignores the app theme (a white
// list over the dark composer), so hover-capable devices open a themed popover
// instead; phones keep the OS picker. The select stays the state holder: a pick
// sets its value and fires the same change event app.js already listens to.
// popover="manual": an auto popover light-dismisses on the pointerup that ends
// the opening click, so the menu only lived while the mouse button was held.
function installChipMenus() {
  if (!matchMedia('(hover:hover) and (pointer:fine)').matches || !('showPopover' in HTMLElement.prototype)) return
  const menu = document.createElement('div')
  menu.id = 'chipMenu'
  menu.className = 'chip-menu'
  menu.popover = 'manual'
  menu.setAttribute('role', 'listbox')
  document.body.append(menu)
  let owner = null
  const isOpen = () => menu.matches(':popover-open')
  const close = ({ refocus = false } = {}) => {
    if (!isOpen()) return
    const select = owner
    menu.hidePopover()
    select?.closest('.control-select')?.classList.remove('is-open')
    owner = null
    if (refocus) select?.focus()
  }
  const open = (select) => {
    close()
    owner = select
    menu.replaceChildren(...[...select.options].map((option) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.role = 'option'
      item.dataset.value = option.value
      item.textContent = option.textContent
      item.setAttribute('aria-selected', String(option.selected))
      return item
    }))
    const chip = select.closest('.control-select'), box = chip.getBoundingClientRect()
    menu.style.minWidth = `${Math.round(box.width)}px`
    menu.style.bottom = `${Math.round(innerHeight - box.top + 6)}px`
    menu.style.left = '0px'
    menu.showPopover()
    menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8)))}px`
    chip.classList.add('is-open')
    menu.querySelector('[aria-selected="true"]')?.focus()
  }
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-value]')
    if (!item || !owner) return
    const select = owner, value = item.dataset.value
    close({ refocus:true })
    if (select.value === value) return
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles:true }))
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') return close()
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...menu.children], index = items.indexOf(document.activeElement)
    items.at((index + (event.key === 'ArrowDown' ? 1 : -1)) % items.length)?.focus()
  })
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && !menu.contains(event.target) && !owner?.closest('.control-select')?.contains(event.target)) close()
  }, true)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && isOpen()) { event.stopPropagation(); close({ refocus:true }) } }, true)
  for (const select of document.querySelectorAll('.control-select > select')) {
    select.addEventListener('mousedown', (event) => {
      if (select.disabled || event.button !== 0) return
      event.preventDefault()
      if (owner === select) close(); else open(select)
    })
    select.addEventListener('keydown', (event) => {
      const opens = event.key === 'Enter' || event.key === ' ' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
      if (select.disabled || !opens) return
      event.preventDefault()
      open(select)
    })
  }
  addEventListener('resize', () => close())
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
  installChipMenus()
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
