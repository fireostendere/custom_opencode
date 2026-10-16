const shell = document.getElementById('limitsShell')

if (shell) {
  const storageKey = 'custom-opencode:limits-collapsed'
  // On a phone the expanded limits take half the drawer; start collapsed there
  // unless the user opened them before. The automatic collapse is not a choice
  // and must not be saved as one.
  let automatic = false
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored === '1' || (stored === null && window.matchMedia('(max-width: 760px)').matches)) {
      automatic = stored === null
      shell.open = false
    }
  } catch {}

  shell.addEventListener('toggle', () => {
    if (automatic) { automatic = false; return }
    try { localStorage.setItem(storageKey, shell.open ? '0' : '1') } catch {}
  })
}

// Universal Panel is a projection over the server state/actions/events contract.
// Keep it loaded from one already-stable compatibility entrypoint instead of
// growing another script tag chain in index.html.
if (!document.querySelector('link[data-unified-workspace]')) {
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = '/unified-workspace.css'
  style.dataset.unifiedWorkspace = '1'
  document.head.append(style)
}

Promise.all([
  import('./unified-workspace.js'),
  import('./unified-workspace-ext.js'),
]).catch((error) => {
  console.error('unified workspace failed to load', error)
})
