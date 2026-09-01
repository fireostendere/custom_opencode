const MODAL_STATE_KEY = '__customOpenCodeModal'

const openDialogs = []
const replacedDialogs = new WeakSet()
let pendingClose = null
let closingFromHistory = false

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

function handleDialogClose(event) {
  const dialog = event.target
  if (!(dialog instanceof HTMLDialogElement)) return
  const token = modalToken(dialog)
  const fromHistory = closingFromHistory
  const wasReplaced = replacedDialogs.has(dialog)
  forgetDialog(dialog)
  if (wasReplaced) {
    replacedDialogs.delete(dialog)
    return
  }
  if (fromHistory || !token || history.state?.[MODAL_STATE_KEY] !== token) return

  // Wait one microtask so a synchronous dialog replacement can reuse this
  // history entry instead of briefly navigating through the old dialog.
  pendingClose = { dialog, token }
  queueMicrotask(() => {
    if (!pendingClose || pendingClose.dialog !== dialog) return
    pendingClose = null
    history.back()
  })
}

function closeFromHistory(dialog) {
  if (!dialog?.open) return
  closingFromHistory = true
  try { dialog.close() } finally { closingFromHistory = false }
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close()
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

window.CustomOpenCodeModal = {
  close: closeDialog,
  current: currentDialog,
  stateKey: MODAL_STATE_KEY,
}
