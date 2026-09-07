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
  if (dialog?.open) dialog.close()
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

function isActionSelection(target, dialog) {
  if (!target?.closest || !dialog?.open) return false
  if (target.closest('[data-fav]')) return false
  if (dialog.id === 'modelDialog') return Boolean(target.closest('button[data-model][data-provider]'))
  if (dialog.id === 'projectDialog') {
    return Boolean(target.closest('button[data-project], button[data-open-directory]'))
  }
  return false
}

async function replayAfterHistoryRestore(target, dialog) {
  await closeAndRestore(dialog)
  if (!target?.isConnected) return
  target.click()
}

function installProjectBridgeWrapper() {
  const bridge = window.CustomOpenCodeProjects
  const original = bridge?.selectDirectory
  if (typeof original !== 'function' || original.__modalHistorySafe) return
  const wrapped = async (...args) => {
    const dialog = document.getElementById('projectDialog')
    if (dialog?.open) await closeAndRestore(dialog)
    return original.apply(bridge, args)
  }
  wrapped.__modalHistorySafe = true
  bridge.selectDirectory = wrapped
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
  const actionDialog = target?.closest?.('dialog')
  if (isActionSelection(target, actionDialog)) {
    const action = target.closest('button[data-model][data-provider], button[data-project], button[data-open-directory]')
    if (action) {
      event.preventDefault()
      event.stopImmediatePropagation()
      replayAfterHistoryRestore(action, actionDialog).catch((error) => console.error('modal action restore failed', error))
      return
    }
  }

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

document.addEventListener('DOMContentLoaded', installProjectBridgeWrapper, { once:true })

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

window.CustomOpenCodeModal = {
  close: closeDialog,
  closeAndRestore,
  current: currentDialog,
  stateKey: MODAL_STATE_KEY,
}
