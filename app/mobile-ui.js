const LIMITS_STORAGE_KEY = 'opencode:web:limits-collapsed-v1'
const SIDEBAR_STATE_KEY = '__customOpenCodeSidebar'
const mobileQuery = window.matchMedia('(max-width: 760px)')

let limitsCollapsed = false
try { limitsCollapsed = localStorage.getItem(LIMITS_STORAGE_KEY) === '1' } catch {}

function persistLimitsState() {
  try { localStorage.setItem(LIMITS_STORAGE_KEY, limitsCollapsed ? '1' : '0') } catch {}
}

function decorateLimits() {
  const panel = document.getElementById('providerLimits')
  if (!panel) return
  panel.dataset.collapsed = limitsCollapsed ? 'true' : 'false'

  const title = panel.querySelector('.quota-title')
  if (!title) return
  title.setAttribute('role', 'button')
  title.setAttribute('tabindex', '0')
  title.setAttribute('aria-expanded', String(!limitsCollapsed))
  title.title = limitsCollapsed ? 'Развернуть лимиты' : 'Свернуть лимиты'

  let toggle = title.querySelector('.quota-collapse')
  if (!toggle) {
    toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'quota-collapse'
    const refresh = title.querySelector('#quotaRefresh')
    if (refresh) title.insertBefore(toggle, refresh)
    else title.append(toggle)
  }

  const glyph = limitsCollapsed ? '⌄' : '⌃'
  if (toggle.textContent !== glyph) toggle.textContent = glyph
  const label = limitsCollapsed ? 'Развернуть лимиты' : 'Свернуть лимиты'
  toggle.setAttribute('aria-label', label)
  toggle.title = label

  if (!title.dataset.collapseBound) {
    title.dataset.collapseBound = '1'
    const activate = (event) => {
      if (event.target.closest('#quotaRefresh')) return
      limitsCollapsed = !limitsCollapsed
      persistLimitsState()
      decorateLimits()
    }
    title.addEventListener('click', activate)
    title.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (event.target.closest('#quotaRefresh')) return
      event.preventDefault()
      activate(event)
    })
  }
}

const limitsPanel = document.getElementById('providerLimits')
if (limitsPanel) {
  new MutationObserver(() => queueMicrotask(decorateLimits)).observe(limitsPanel, { childList:true })
  decorateLimits()
}

const sidebar = document.getElementById('sidebar')
const menu = document.getElementById('menu')
let sidebarHistoryActive = false
let waitingForSidebarPop = false
let afterSidebarClose = null
let swipeStart = null

function sidebarOpen() {
  return !!sidebar?.classList.contains('open')
}

function setSidebarVisual(open) {
  if (!sidebar) return
  sidebar.classList.toggle('open', open)
  sidebar.setAttribute('aria-hidden', open ? 'false' : 'true')
  document.body.classList.toggle('mobile-sidebar-open', open)
  const scrim = document.getElementById('sidebarScrim')
  if (scrim) scrim.hidden = !open
  if (menu) menu.setAttribute('aria-expanded', String(open))
}

function cleanSidebarState(state = history.state) {
  if (!state || typeof state !== 'object' || !(SIDEBAR_STATE_KEY in state)) return state
  const next = { ...state }
  delete next[SIDEBAR_STATE_KEY]
  return Object.keys(next).length ? next : null
}

function openSidebar() {
  if (!mobileQuery.matches || !sidebar || sidebarOpen()) return
  setSidebarVisual(true)
  history.pushState({ ...(history.state || {}), [SIDEBAR_STATE_KEY]:true }, '', location.href)
  sidebarHistoryActive = true
}

function finishSidebarClose() {
  setSidebarVisual(false)
  sidebarHistoryActive = false
  waitingForSidebarPop = false
  const callback = afterSidebarClose
  afterSidebarClose = null
  if (callback) queueMicrotask(callback)
}

function closeSidebar(after = null) {
  if (!sidebarOpen()) {
    if (after) queueMicrotask(after)
    return
  }
  afterSidebarClose = after
  setSidebarVisual(false)

  const ownsCurrentEntry = sidebarHistoryActive && history.state?.[SIDEBAR_STATE_KEY] === true
  if (ownsCurrentEntry) {
    waitingForSidebarPop = true
    history.back()
  } else {
    finishSidebarClose()
  }
}

if (sidebar && menu) {
  // A stale overlay history entry can survive a hard reload; never let it trap Back.
  if (history.state?.[SIDEBAR_STATE_KEY]) {
    history.replaceState(cleanSidebarState(), '', location.href)
  }

  const scrim = document.createElement('div')
  scrim.id = 'sidebarScrim'
  scrim.className = 'sidebar-scrim'
  scrim.hidden = true
  document.body.append(scrim)
  scrim.addEventListener('click', () => closeSidebar())

  document.addEventListener('click', (event) => {
    const menuButton = event.target.closest?.('#menu')
    if (menuButton && mobileQuery.matches) {
      event.preventDefault()
      event.stopImmediatePropagation()
      sidebarOpen() ? closeSidebar() : openSidebar()
      return
    }

    const sessionButton = event.target.closest?.('[data-session]')
    if (sessionButton && mobileQuery.matches && sidebarOpen() && history.state?.[SIDEBAR_STATE_KEY]) {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeSidebar(() => sessionButton.click())
    }
  }, true)

  window.addEventListener('popstate', () => {
    if (waitingForSidebarPop || sidebarOpen()) {
      finishSidebarClose()
      return
    }
    sidebarHistoryActive = false
  })

  sidebar.addEventListener('pointerdown', (event) => {
    if (!mobileQuery.matches || !sidebarOpen()) return
    if (event.pointerType === 'mouse') return
    swipeStart = { id:event.pointerId, x:event.clientX, y:event.clientY, at:performance.now() }
  })

  sidebar.addEventListener('pointerup', (event) => {
    if (!swipeStart || swipeStart.id !== event.pointerId) return
    const dx = event.clientX - swipeStart.x
    const dy = event.clientY - swipeStart.y
    const elapsed = performance.now() - swipeStart.at
    swipeStart = null
    if (dx < -56 && Math.abs(dx) > Math.abs(dy) * 1.15 && elapsed < 900) closeSidebar()
  })

  sidebar.addEventListener('pointercancel', () => { swipeStart = null })
  mobileQuery.addEventListener?.('change', (event) => {
    if (!event.matches && sidebarOpen()) closeSidebar()
  })
}
