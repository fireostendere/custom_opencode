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
