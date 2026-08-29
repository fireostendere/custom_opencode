const $ = (id) => document.getElementById(id)
const form = $('loginForm')
const username = $('username')
const password = $('password')
const remember = $('remember')
const submit = $('loginSubmit')
const errorBox = $('loginError')
const togglePassword = $('togglePassword')
const USER_KEY = 'opencode:web:last-login-user'

function safeNext() {
  const value = new URLSearchParams(location.search).get('next') || '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/'
  return value
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

try { username.value = localStorage.getItem(USER_KEY) || 'opencode' } catch { username.value = 'opencode' }

fetch('/auth/session', { credentials:'same-origin', cache:'no-store' }).then((response) => {
  if (response.ok) location.replace(safeNext())
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
    try { localStorage.setItem(USER_KEY, username.value.trim()) } catch {}
    location.replace(safeNext())
  } catch (error) {
    showError(error?.message || 'Не удалось войти')
    password.select()
  } finally {
    setBusy(false)
  }
})
