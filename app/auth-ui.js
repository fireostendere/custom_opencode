const nativeFetch = window.fetch.bind(window)
let redirectingToLogin = false

function loginTarget() {
  const next = `${location.pathname}${location.search}${location.hash}` || '/'
  return `/login.html?next=${encodeURIComponent(next)}`
}

function redirectToLogin() {
  if (redirectingToLogin || location.pathname === '/login.html') return
  redirectingToLogin = true
  location.replace(loginTarget())
}

window.fetch = async (...args) => {
  const response = await nativeFetch(...args)
  try {
    const input = args[0]
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    const url = new URL(raw || location.href, location.href)
    if (response.status === 401 && url.origin === location.origin && !url.pathname.startsWith('/auth/')) {
      redirectToLogin()
    }
  } catch {}
  return response
}

const logoutButton = document.getElementById('logoutButton')
const accountUser = document.getElementById('accountUser')

async function refreshAuthState({ redirect = true } = {}) {
  try {
    const response = await nativeFetch('/auth/session', { credentials:'same-origin', cache:'no-store' })
    if (!response.ok) {
      if (redirect) redirectToLogin()
      return null
    }
    const data = await response.json()
    if (accountUser) accountUser.textContent = data.localBypass ? `${data.user} · локально` : data.user
    if (logoutButton) {
      logoutButton.hidden = !!data.localBypass
      logoutButton.title = data.localBypass ? 'Локальный доступ разрешён без авторизации' : 'Выйти из OpenCode'
    }
    return data
  } catch {
    return null
  }
}

logoutButton?.addEventListener('click', async () => {
  if (logoutButton.disabled) return
  logoutButton.disabled = true
  const previous = logoutButton.textContent
  logoutButton.textContent = 'Выход…'
  try {
    await nativeFetch('/auth/logout', { method:'POST', credentials:'same-origin', cache:'no-store' })
  } finally {
    location.replace('/login.html')
    setTimeout(() => {
      logoutButton.disabled = false
      logoutButton.textContent = previous
    }, 1200)
  }
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAuthState()
})

refreshAuthState()
