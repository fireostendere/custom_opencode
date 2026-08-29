(() => {
  try {
    const prefs = JSON.parse(localStorage.getItem('opencode:web:appearance-v1') || 'null') || {}
    const mode = ['system', 'light', 'dark'].includes(prefs.theme) ? prefs.theme : 'system'
    const theme = mode === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.themeMode = mode
    if (/^#[0-9a-f]{6}$/i.test(prefs.accent || '')) {
      document.documentElement.style.setProperty('--accent', prefs.accent.toLowerCase())
    }
  } catch {}
})()
