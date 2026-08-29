(() => {
  try {
    const prefs = JSON.parse(localStorage.getItem('opencode:web:appearance-v1') || 'null') || {}
    const mode = ['system', 'light', 'dark'].includes(prefs.theme) ? prefs.theme : 'system'
    const theme = mode === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.themeMode = mode
    if (/^#[0-9a-f]{6}$/i.test(prefs.accent || '')) {
      const accent = prefs.accent.toLowerCase()
      root.style.setProperty('--accent', accent)
      const rgb = [1, 3, 5].map((index) => parseInt(accent.slice(index, index + 2), 16) / 255)
      const linear = rgb.map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
      root.style.setProperty('--accent-contrast', (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#111111' : '#ffffff')
    }
  } catch {}
})()
