const dialog = document.getElementById('providerWizardDialog')
const form = document.getElementById('providerWizardForm')
const modelDialog = document.getElementById('modelDialog')
const keyInput = document.getElementById('providerWizardKey')
const modelInput = document.getElementById('providerWizardModel')
const status = document.getElementById('providerWizardStatus')
const submit = document.getElementById('providerWizardSubmit')

function setStatus(message, error = false) {
  status.textContent = message
  status.className = `wizard-note${error ? ' wizard-error' : ''}`
}

async function openWizard() {
  if (!dialog) return
  modelDialog?.close()
  keyInput.value = ''
  setStatus('Загружаю текущую конфигурацию…')
  dialog.showModal()
  try {
    const response = await fetch('/client-provider-config.json', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось загрузить конфигурацию')
    modelInput.value = data.model || 'qwen3.8-max'
    keyInput.placeholder = data.keySet ? 'Ключ уже задан · введите новый для замены' : 'sk-...'
    setStatus(data.keySet ? 'Ключ уже подключён. Пустое поле оставит его без изменений.' : 'Ключ ещё не задан.')
  } catch (error) {
    setStatus(error.message || 'Не удалось загрузить конфигурацию', true)
  }
  requestAnimationFrame(() => keyInput.focus())
}

document.getElementById('providerWizardButton')?.addEventListener('click', openWizard)
document.getElementById('providerWizardClose')?.addEventListener('click', () => dialog.close())
document.getElementById('providerWizardCancel')?.addEventListener('click', () => dialog.close())
dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close()
})

form?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (submit.disabled) return
  submit.disabled = true
  setStatus('Сохраняю ключ и перезапускаю подключение…')
  try {
    const response = await fetch('/client-provider-config.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'qwen-token-plan',
        apiKey: keyInput.value.trim(),
        model: modelInput.value.trim(),
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось сохранить ключ')
    setStatus('Готово. Обновляю список моделей…')
    setTimeout(() => window.location.reload(), 900)
  } catch (error) {
    setStatus(error.message || 'Не удалось подключить провайдера', true)
    submit.disabled = false
  }
})
