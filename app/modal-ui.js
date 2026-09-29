const MODAL_STATE_KEY = '__customOpenCodeModal'

const openDialogs = []
const replacedDialogs = new WeakSet()
let pendingClose = null
let closingFromHistory = false
let historyRestoreWaiter = null

function modalToken(dialog) {
  return dialog.dataset.modalHistoryToken || ''
}

function currentDialog() {
  for (let index = openDialogs.length - 1; index >= 0; index -= 1) {
    if (openDialogs[index].open) return openDialogs[index]
  }
  return null
}

function prepareDialog(dialog) {
  dialog.setAttribute('aria-modal', 'true')
  const title = dialog.querySelector('.modal-head h3')
  if (title && !dialog.hasAttribute('aria-labelledby')) {
    if (!title.id) title.id = `modal-title-${openDialogs.length + 1}`
    dialog.setAttribute('aria-labelledby', title.id)
  }
  dialog.querySelectorAll('[data-close], [data-appearance-close], [data-workflow-close], [data-runtime-close]').forEach((button) => {
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Закрыть')
  })
}

function registerDialog(dialog) {
  if (!dialog.open || openDialogs.includes(dialog)) return
  prepareDialog(dialog)
  installSheetGesture(dialog)

  // Closing one dialog and opening another in the same event is a replacement,
  // not a second navigation step (for example Session -> Rename).
  if (pendingClose && history.state?.[MODAL_STATE_KEY] === pendingClose.token) {
    replacedDialogs.add(pendingClose.dialog)
    dialog.dataset.modalHistoryToken = pendingClose.token
    pendingClose = null
    openDialogs.push(dialog)
    history.replaceState({ ...(history.state || {}), [MODAL_STATE_KEY]: modalToken(dialog) }, '', location.href)
    return
  }

  const token = `${dialog.id || 'dialog'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  dialog.dataset.modalHistoryToken = token
  openDialogs.push(dialog)
  history.pushState({ ...(history.state || {}), [MODAL_STATE_KEY]: token }, '', location.href)
  document.body.classList.add('modal-open')
}

function forgetDialog(dialog) {
  const index = openDialogs.indexOf(dialog)
  if (index >= 0) openDialogs.splice(index, 1)
  delete dialog.dataset.modalHistoryToken
  if (!currentDialog()) document.body.classList.remove('modal-open')
}

function markDialogClose(dialog) {
  const token = modalToken(dialog)
  if (!dialog.open || closingFromHistory || !token || history.state?.[MODAL_STATE_KEY] !== token) return
  pendingClose = { dialog, token }
}

function settleHistoryRestore() {
  if (!historyRestoreWaiter) return
  const waiter = historyRestoreWaiter
  historyRestoreWaiter = null
  clearTimeout(waiter.timer)
  waiter.resolve()
}

function handleDialogClose(event) {
  const dialog = event.target
  if (!(dialog instanceof HTMLDialogElement)) return
  const token = modalToken(dialog)
  const fromHistory = closingFromHistory
  const wasReplaced = replacedDialogs.has(dialog)
  forgetDialog(dialog)
  resetSheet(dialog)
  if (wasReplaced) {
    replacedDialogs.delete(dialog)
    settleHistoryRestore()
    return
  }
  if (fromHistory || !token || history.state?.[MODAL_STATE_KEY] !== token) {
    if (fromHistory) settleHistoryRestore()
    return
  }

  // Wait one microtask so a synchronous dialog replacement can reuse this
  // history entry instead of briefly navigating through the old dialog.
  pendingClose = { dialog, token }
  queueMicrotask(() => {
    if (!pendingClose || pendingClose.dialog !== dialog) return
    history.back()
  })
}

function closeFromHistory(dialog) {
  if (!dialog?.open) return
  closingFromHistory = true
  try { dialog.close() } finally { closingFromHistory = false }
}

function closeDialog(dialog) {
  if (dialog?.open && dialog.getAttribute('aria-busy') !== 'true') dialog.close()
}

function closeAndRestore(dialog) {
  if (!dialog?.open) return Promise.resolve()
  const token = modalToken(dialog)
  if (!token || history.state?.[MODAL_STATE_KEY] !== token) {
    closeDialog(dialog)
    return Promise.resolve()
  }
  if (historyRestoreWaiter) return historyRestoreWaiter.promise

  let resolveWaiter
  const promise = new Promise((resolve) => { resolveWaiter = resolve })
  const waiter = {
    dialog,
    promise,
    resolve: resolveWaiter,
    timer: setTimeout(() => {
      if (historyRestoreWaiter !== waiter) return
      historyRestoreWaiter = null
      pendingClose = null
      if (history.state?.[MODAL_STATE_KEY]) {
        const next = { ...(history.state || {}) }
        delete next[MODAL_STATE_KEY]
        history.replaceState(Object.keys(next).length ? next : null, '', location.href)
      }
      resolveWaiter()
    }, 1500),
  }
  historyRestoreWaiter = waiter
  closeDialog(dialog)
  return promise
}

// A successful action owns navigation. Consume the chooser's history entry
// instead of dismissing it and replaying its click before the POST finishes.
function navigate(url) {
  const dialog = currentDialog()
  const token = dialog && modalToken(dialog)
  if (!token || history.state?.[MODAL_STATE_KEY] !== token) return false
  const next = { ...(history.state || {}) }
  delete next[MODAL_STATE_KEY]
  history.replaceState(Object.keys(next).length ? next : null, '', url)
  pendingClose = null
  return true
}

if (window.HTMLDialogElement) {
  const nativeShowModal = HTMLDialogElement.prototype.showModal
  const nativeClose = HTMLDialogElement.prototype.close
  HTMLDialogElement.prototype.showModal = function showModalWithHistory(...args) {
    nativeShowModal.apply(this, args)
    registerDialog(this)
  }
  HTMLDialogElement.prototype.close = function closeWithHistory(...args) {
    markDialogClose(this)
    nativeClose.apply(this, args)
  }
}

document.addEventListener('close', handleDialogClose, true)
document.addEventListener('click', (event) => {
  const target = event.target
  const closeButton = target?.closest?.('[data-close], [data-appearance-close], [data-workflow-close], [data-runtime-close]')
  if (closeButton) {
    const id = closeButton.dataset.close || closeButton.dataset.appearanceClose || closeButton.dataset.workflowClose
    const dialog = id ? document.getElementById(id) : closeButton.closest('dialog')
    if (dialog) {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeDialog(dialog)
    }
    return
  }

  // A click whose target is the dialog itself landed on its native backdrop.
  const dialog = target?.tagName === 'DIALOG' ? target : null
  if (dialog?.open) {
    event.preventDefault()
    event.stopImmediatePropagation()
    closeDialog(dialog)
  }
}, true)

document.querySelectorAll('dialog').forEach((dialog) => prepareDialog(dialog))


window.addEventListener('popstate', () => {
  if (pendingClose) {
    pendingClose = null
    settleHistoryRestore()
    return
  }

  const dialog = currentDialog()
  if (dialog && history.state?.[MODAL_STATE_KEY] !== modalToken(dialog)) {
    closeFromHistory(dialog)
    return
  }

  // Do not leave a stale modal marker if the user navigated after a dialog was
  // closed by another script.
  if (!dialog && history.state?.[MODAL_STATE_KEY]) {
    const next = { ...(history.state || {}) }
    delete next[MODAL_STATE_KEY]
    history.replaceState(Object.keys(next).length ? next : null, '', location.href)
  }
})

// On phones every dialog is a bottom sheet (design-system.css) and closes with
// a downward swipe, like a native sheet. The drag can start anywhere in the
// sheet while every scroll container under the finger sits at its top;
// otherwise the content scrolls as usual and the sheet stays. Listeners live on
// the dialog itself so page scrolling never waits on them, and touchmove is
// non-passive only there: Chrome keeps a touch sequence cancelable only while
// the very first moves are prevented, so an undecided downward move is held
// until the direction is clear.
const SHEET_QUERY = window.matchMedia('(max-width: 760px)')
const SHEET_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)')
const SHEET_SLOP = 6
const SHEET_CLOSE_MIN = 72
const SHEET_CLOSE_RATIO = 0.25
const SHEET_FLICK_VELOCITY = 0.55
const SHEET_SETTLE_MS = 240
// Release velocity is read over the last ~100 ms, not the last two events: a
// finger lifting off jitters, and one slow sample must not cancel a flick.
const SHEET_VELOCITY_WINDOW_MS = 100
const sheetDialogs = new WeakSet()
let sheetGesture = null

function sheetTouch(list, id) {
  for (const touch of list || []) if (touch.identifier === id) return touch
  return null
}

// A scroll container between the finger and the sheet that is scrolled down
// owns the gesture: the user is scrolling back up, not dismissing.
function scrolledInside(target, dialog) {
  let node = target instanceof Element ? target : target?.parentElement
  while (node && node !== dialog) {
    if (node.scrollTop > 1 && node.scrollHeight > node.clientHeight + 1) return true
    node = node.parentElement
  }
  return false
}

function setSheetOffset(dialog, offset) {
  dialog.style.transform = offset > 0 ? `translateY(${Math.round(offset)}px)` : ''
  const height = dialog.offsetHeight || 1
  dialog.style.setProperty('--sheet-drag', String(Math.min(1, Math.max(0, offset / height))))
}

function resetSheet(dialog) {
  if (sheetGesture?.dialog === dialog) sheetGesture = null
  dialog.classList.remove('sheet-dragging', 'sheet-settling')
  dialog.style.transform = ''
  dialog.style.removeProperty('--sheet-drag')
}

function afterSheetTransition(dialog, done) {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    dialog.removeEventListener('transitionend', onEnd)
    done()
  }
  const onEnd = (event) => { if (event.target === dialog) finish() }
  dialog.addEventListener('transitionend', onEnd)
  setTimeout(finish, SHEET_SETTLE_MS)
}

function settleSheet(dialog) {
  dialog.classList.remove('sheet-dragging')
  if (SHEET_MOTION.matches) { resetSheet(dialog); return }
  dialog.classList.add('sheet-settling')
  dialog.style.transform = ''
  dialog.style.setProperty('--sheet-drag', '0')
  afterSheetTransition(dialog, () => resetSheet(dialog))
}

function dismissSheet(dialog) {
  dialog.classList.remove('sheet-dragging')
  const finish = () => { closeDialog(dialog); resetSheet(dialog) }
  if (SHEET_MOTION.matches) { finish(); return }
  dialog.classList.add('sheet-settling')
  dialog.style.transform = 'translateY(100%)'
  dialog.style.setProperty('--sheet-drag', '1')
  afterSheetTransition(dialog, finish)
}

function onSheetTouchStart(event) {
  const dialog = event.currentTarget
  if (!SHEET_QUERY.matches || sheetGesture || event.touches.length !== 1) return
  if (!dialog.open || dialog.getAttribute('aria-busy') === 'true' || dialog.classList.contains('sheet-settling')) return
  const touch = event.touches[0]
  const now = performance.now()
  sheetGesture = { dialog, id: touch.identifier, target: event.target, x: touch.clientX, y: touch.clientY, mode: 'undecided', offset: 0, samples: [{ at: now, y: touch.clientY }] }
}

function onSheetTouchMove(event) {
  const gesture = sheetGesture
  if (!gesture || gesture.dialog !== event.currentTarget) return
  const touch = sheetTouch(event.touches, gesture.id)
  if (!touch || event.touches.length !== 1) { sheetGesture = null; settleSheet(gesture.dialog); return }
  const dx = touch.clientX - gesture.x
  const dy = touch.clientY - gesture.y
  if (gesture.mode === 'undecided') {
    // The browser already scrolls this sequence, or the content itself is
    // scrolled: the gesture is not ours.
    if (!event.cancelable || dy < 0 || scrolledInside(gesture.target, gesture.dialog)) { gesture.mode = 'scroll'; return }
    if (Math.abs(dx) < SHEET_SLOP && dy < SHEET_SLOP) { event.preventDefault(); return }
    if (Math.abs(dx) > dy) { gesture.mode = 'scroll'; return }
    gesture.mode = 'drag'
    gesture.dialog.classList.add('sheet-dragging')
  }
  if (gesture.mode !== 'drag') return
  if (event.cancelable) event.preventDefault()
  const now = performance.now()
  gesture.samples.push({ at: now, y: touch.clientY })
  while (gesture.samples.length > 2 && now - gesture.samples[1].at > SHEET_VELOCITY_WINDOW_MS) gesture.samples.shift()
  gesture.offset = Math.max(0, dy)
  setSheetOffset(gesture.dialog, gesture.offset)
}

function sheetVelocity(samples, now) {
  const last = samples[samples.length - 1]
  if (!last || now - last.at > SHEET_VELOCITY_WINDOW_MS) return 0
  const first = samples.find((sample) => last.at - sample.at <= SHEET_VELOCITY_WINDOW_MS) || samples[0]
  return last.at > first.at ? (last.y - first.y) / (last.at - first.at) : 0
}

function onSheetTouchEnd(event) {
  const gesture = sheetGesture
  if (!gesture || gesture.dialog !== event.currentTarget) return
  if (event.type === 'touchend' && !sheetTouch(event.changedTouches, gesture.id)) return
  sheetGesture = null
  const dialog = gesture.dialog
  if (gesture.mode !== 'drag') return
  if (event.type === 'touchcancel') { settleSheet(dialog); return }
  const velocity = sheetVelocity(gesture.samples, performance.now())
  const threshold = Math.max(SHEET_CLOSE_MIN, (dialog.offsetHeight || 0) * SHEET_CLOSE_RATIO)
  const flick = velocity > SHEET_FLICK_VELOCITY && gesture.offset > 24
  if ((gesture.offset >= threshold && velocity >= -0.2) || flick) dismissSheet(dialog)
  else settleSheet(dialog)
}

function installSheetGesture(dialog) {
  if (sheetDialogs.has(dialog)) return
  sheetDialogs.add(dialog)
  dialog.addEventListener('touchstart', onSheetTouchStart, { passive: true })
  dialog.addEventListener('touchmove', onSheetTouchMove, { passive: false })
  dialog.addEventListener('touchend', onSheetTouchEnd)
  dialog.addEventListener('touchcancel', onSheetTouchEnd)
}

SHEET_QUERY.addEventListener?.('change', (event) => {
  if (!event.matches && sheetGesture) { const { dialog } = sheetGesture; sheetGesture = null; resetSheet(dialog) }
})
document.querySelectorAll('dialog').forEach((dialog) => installSheetGesture(dialog))

window.CustomOpenCodeModal = {
  navigate,
  close: closeDialog,
  closeAndRestore,
  current: currentDialog,
  stateKey: MODAL_STATE_KEY,
}
