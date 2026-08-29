const $ = (id) => document.getElementById(id)
const form = $('loginForm')
const username = $('username')
const password = $('password')
const remember = $('remember')
const submit = $('loginSubmit')
const errorBox = $('loginError')
const togglePassword = $('togglePassword')

const PREFS_KEY = 'opencode:web:login-prefs-v2'
const LEGACY_USER_KEY = 'opencode:web:last-login-user'
const RESUME_KEY = 'opencode:web:auth-resume-v1'

function validTarget(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')
}

function safeNext() {
  const params = new URLSearchParams(location.search)
  const explicit = params.get('next')
  let value = validTarget(explicit) ? explicit : '/'

  // A server redirect never receives the URL fragment. Browsers commonly carry
  // it over to /login.html, so fold it back into the post-login destination.
  if (!value.includes('#') && location.hash.startsWith('#/')) value += location.hash

  // Client-side 401 handling records the full route as an additional fallback.
  if (!explicit && value === '/') {
    try {
      const resume = sessionStorage.getItem(RESUME_KEY)
      if (validTarget(resume)) value = resume
    } catch {}
  }

  return validTarget(value) ? value : '/'
}

function loadPrefs() {
  let prefs = { username:'opencode', remember:true }
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.username === 'string' && parsed.username.trim()) prefs.username = parsed.username.trim()
      if (typeof parsed.remember === 'boolean') prefs.remember = parsed.remember
    } else {
      const legacy = localStorage.getItem(LEGACY_USER_KEY)
      if (legacy?.trim()) prefs.username = legacy.trim()
    }
  } catch {}
  return prefs
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      username:username.value.trim() || 'opencode',
      remember:remember.checked,
    }))
    localStorage.removeItem(LEGACY_USER_KEY)
  } catch {}
}

function clearResume() {
  try { sessionStorage.removeItem(RESUME_KEY) } catch {}
}

function showError(message) {
  errorBox.textContent = message
  errorBox.hidden = !message
}

function setBusy(busy) {
  submit.disabled = busy
  submit.classList.toggle('busy', busy)
  username.disabled = busy
  password.disabled = busy
  remember.disabled = busy
}

const prefs = loadPrefs()
username.value = prefs.username
remember.checked = prefs.remember
remember.addEventListener('change', savePrefs)
username.addEventListener('change', savePrefs)

fetch('/auth/session', { credentials:'same-origin', cache:'no-store' }).then((response) => {
  if (!response.ok) return
  const target = safeNext()
  clearResume()
  location.replace(target)
}).catch(() => {})

togglePassword.addEventListener('click', () => {
  const visible = password.type === 'text'
  password.type = visible ? 'password' : 'text'
  togglePassword.textContent = visible ? 'Показать' : 'Скрыть'
  togglePassword.setAttribute('aria-label', visible ? 'Показать пароль' : 'Скрыть пароль')
  password.focus({ preventScroll:true })
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  if (!username.value.trim() || !password.value) {
    showError('Введите логин и пароль')
    ;(!username.value.trim() ? username : password).focus()
    return
  }

  setBusy(true)
  try {
    const response = await fetch('/auth/login', {
      method:'POST',
      credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        username:username.value.trim(),
        password:password.value,
        remember:remember.checked,
      }),
    })
    if (!response.ok) {
      let message = 'Не удалось войти'
      try { message = (await response.json())?.error || message } catch {}
      throw new Error(message)
    }
    savePrefs()
    const target = safeNext()
    clearResume()
    location.replace(target)
  } catch (error) {
    showError(error?.message || 'Не удалось войти')
    password.select()
  } finally {
    setBusy(false)
  }
})

queueMicrotask(() => {
  ;(username.value ? password : username).focus({ preventScroll:true })
})
