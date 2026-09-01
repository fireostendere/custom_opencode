const SIDEBAR_STATE_KEY = '__customOpenCodeSidebar'
const mobileQuery = window.matchMedia('(max-width: 760px)')
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
  menu?.setAttribute('aria-expanded', String(open))
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
  // Do not keep an orphaned overlay entry after a hard reload.
  if (history.state?.[SIDEBAR_STATE_KEY]) {
    history.replaceState(cleanSidebarState(), '', location.href)
  }

  const scrim = document.createElement('div')
  scrim.id = 'sidebarScrim'
  scrim.className = 'sidebar-scrim'
  scrim.hidden = true
  document.body.append(scrim)
  scrim.addEventListener('click', () => closeSidebar())

  // Capture navigation before the legacy sidebar handler. Besides the visual
  // scrim, explicitly treat every tap/click outside the drawer as dismissal so
  // mobile browsers cannot leave a dead area that fails to close the sidebar.
  document.addEventListener('click', (event) => {
    const target = event.target
    const menuButton = target?.closest?.('#menu')
    if (menuButton && mobileQuery.matches) {
      event.preventDefault()
      event.stopImmediatePropagation()
      sidebarOpen() ? closeSidebar() : openSidebar()
      return
    }

    if (
      mobileQuery.matches &&
      sidebarOpen() &&
      target instanceof Node &&
      !sidebar.contains(target) &&
      !menu.contains(target)
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeSidebar()
      return
    }

    // Selecting a chat while the drawer owns a synthetic history entry should
    // consume that entry first, otherwise Back would need an extra press later.
    const sessionButton = target?.closest?.('[data-session]')
    if (sessionButton && mobileQuery.matches && sidebarOpen() && history.state?.[SIDEBAR_STATE_KEY]) {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeSidebar(() => sessionButton.click())
    }
  }, true)

  window.addEventListener('popstate', () => {
    const modalOpen = history.state?.__customOpenCodeModal
    const sidebarEntry = history.state?.[SIDEBAR_STATE_KEY]
    if (waitingForSidebarPop || (sidebarOpen() && !modalOpen && !sidebarEntry)) {
      finishSidebarClose()
      return
    }
    sidebarHistoryActive = false
  })

  // Native-feeling right-to-left dismissal. Vertical scrolling remains intact.
  sidebar.addEventListener('pointerdown', (event) => {
    if (!mobileQuery.matches || !sidebarOpen() || event.pointerType === 'mouse') return
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
