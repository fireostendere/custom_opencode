const STORAGE_KEY = 'opencode:web:appearance-v1'
const DEFAULTS = { theme:'system', accent:'#10a37f' }
const THEMES = new Set(['system', 'light', 'dark'])
const ACCENT_RE = /^#[0-9a-f]{6}$/i
const systemTheme = window.matchMedia('(prefers-color-scheme: light)')

function loadAppearance() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return {
      theme: THEMES.has(parsed?.theme) ? parsed.theme : DEFAULTS.theme,
      accent: ACCENT_RE.test(parsed?.accent || '') ? parsed.accent.toLowerCase() : DEFAULTS.accent,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveAppearance(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch {}
}

function accentContrast(hex) {
  const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
  const linear = rgb.map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
  return luminance > .46 ? '#111111' : '#ffffff'
}

function resolvedTheme(mode) {
  return mode === 'system' ? (systemTheme.matches ? 'light' : 'dark') : mode
}

let appearance = loadAppearance()

function applyAppearance({ persist = false } = {}) {
  const root = document.documentElement
  const resolved = resolvedTheme(appearance.theme)
  root.dataset.theme = resolved
  root.dataset.themeMode = appearance.theme
  root.style.setProperty('--accent', appearance.accent)
  root.style.setProperty('--accent-contrast', accentContrast(appearance.accent))
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f7f7f7' : '#171717')
  if (persist) saveAppearance(appearance)
  renderAppearanceControls()
}

function renderAppearanceControls() {
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    const active = button.dataset.themeMode === appearance.theme
    button.classList.toggle('active', active)
    button.setAttribute('aria-checked', String(active))
  })
  document.querySelectorAll('[data-accent]').forEach((button) => {
    const active = button.dataset.accent.toLowerCase() === appearance.accent
    button.classList.toggle('active', active)
    button.setAttribute('aria-checked', String(active))
  })
  const custom = document.getElementById('accentCustom')
  if (custom && custom.value.toLowerCase() !== appearance.accent) custom.value = appearance.accent
}

function openAppearanceDialog() {
  const dialog = document.getElementById('appearanceDialog')
  if (!dialog) return
  renderAppearanceControls()
  dialog.showModal()
}

function bindAppearanceUI() {
  document.getElementById('appearanceButton')?.addEventListener('click', openAppearanceDialog)
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      appearance = { ...appearance, theme: button.dataset.themeMode }
      applyAppearance({ persist:true })
    })
  })
  document.querySelectorAll('[data-accent]').forEach((button) => {
    button.addEventListener('click', () => {
      appearance = { ...appearance, accent: button.dataset.accent.toLowerCase() }
      applyAppearance({ persist:true })
    })
  })
  document.getElementById('accentCustom')?.addEventListener('input', (event) => {
    const value = String(event.target.value || '').toLowerCase()
    if (!ACCENT_RE.test(value)) return
    appearance = { ...appearance, accent:value }
    applyAppearance({ persist:true })
  })
  document.getElementById('appearanceReset')?.addEventListener('click', () => {
    appearance = { ...DEFAULTS }
    applyAppearance({ persist:true })
  })
  document.querySelectorAll('[data-appearance-close]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById(button.dataset.appearanceClose)?.close())
  })
  const dialog = document.getElementById('appearanceDialog')
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
}

systemTheme.addEventListener?.('change', () => {
  if (appearance.theme === 'system') applyAppearance()
})

applyAppearance()
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAppearanceUI, { once:true })
else bindAppearanceUI()
