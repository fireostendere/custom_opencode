const PROFILE_KEY = 'opencode:web:model-profiles-v1'

function migrateStaleAutoProfiles() {
  try {
    const values = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}
    let changed = false
    for (const [key, value] of Object.entries(values)) {
      if (value === 'auto') {
        values[key] = 'direct'
        changed = true
      }
    }
    if (changed) localStorage.setItem(PROFILE_KEY, JSON.stringify(values))
  } catch {}
}

function scrubProjectSettingsUi() {
  const select = document.getElementById('projectDefaultModel')
  if (select) {
    for (const option of [...select.options]) {
      if (option.value === 'auto' || option.value.startsWith('ollama/')) option.remove()
    }
    if (!select.value) select.value = 'inherit'
  }
  for (const id of ['projectGpuThreshold', 'projectLocalModel', 'projectCloudModel']) {
    const input = document.getElementById(id)
    const label = input?.closest('label')
    if (label) label.hidden = true
  }
  const button = document.getElementById('projectSettingsButton')
  if (button) button.title = 'Память и permission policy проекта'
}

// New workflow automation must never select a local model on the user's behalf.
// Programmatic clicks are blocked, while a real user click in the ordinary model
// picker remains untouched and continues to use the pre-existing manual Ollama path.
document.addEventListener('click', (event) => {
  const choice = event.target?.closest?.('[data-model][data-provider="ollama"]')
  if (choice && !event.isTrusted) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)

migrateStaleAutoProfiles()
scrubProjectSettingsUi()
new MutationObserver(scrubProjectSettingsUi).observe(document.body, { childList:true, subtree:true })
