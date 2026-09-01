const shell = document.getElementById('limitsShell')

if (shell) {
  const storageKey = 'custom-opencode:limits-collapsed'
  try {
    if (localStorage.getItem(storageKey) === '1') shell.open = false
  } catch {}

  shell.addEventListener('toggle', () => {
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

import('./unified-workspace.js').catch((error) => {
  console.error('unified workspace failed to load', error)
})
