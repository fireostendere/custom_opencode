const $ = (id) => document.getElementById(id)

function dataOf(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  return type.includes('application/json') ? response.json() : response.text()
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char])
}

async function selectedDirectory() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash)
  if (match) {
    try {
      const session = dataOf(await request(`/api/session/${encodeURIComponent(decodeURIComponent(match[1]))}`))
      if (session?.location?.directory) return session.location.directory
    } catch {}
  }
  const config = await request('/client-config.json')
  return config?.scratchDirectory || ''
}

export function isFreeModel(model) {
  const costs = Array.isArray(model?.cost) ? model.cost : []
  if (costs.length) {
    return costs.every((cost) => Number(cost?.input || 0) === 0
      && Number(cost?.output || 0) === 0
      && Number(cost?.cache?.read || 0) === 0
      && Number(cost?.cache?.write || 0) === 0)
  }
  const id = String(model?.id || '').toLowerCase()
  return /(^|[-_])free($|[-_])/.test(id) || id === 'big-pickle' || id === 'x-preview-f-free'
}

let decoratingModels = false
async function decorateModelChoices() {
  const root = $('modelChoices')
  if (!root || decoratingModels || !root.querySelector('[data-model]')) return
  decoratingModels = true
  try {
    const directory = await selectedDirectory()
    const params = new URLSearchParams()
    if (directory) params.set('location[directory]', directory)
    const models = dataOf(await request(`/api/model${params.size ? `?${params}` : ''}`)) || []
    const free = new Set((Array.isArray(models) ? models : [])
      .filter(isFreeModel)
      .map((model) => `${model.providerID}/${model.id}`))
    const buttons = [...root.querySelectorAll('button[data-provider][data-model]')]
    const freeButtons = buttons.filter((button) => free.has(`${button.dataset.provider}/${button.dataset.model}`))
    root.querySelector('.free-models-heading')?.remove()
    if (!freeButtons.length) return

    const heading = document.createElement('div')
    heading.className = 'project free-models-heading'
    heading.textContent = 'Бесплатные модели'
    root.prepend(heading)
    heading.after(...freeButtons)

    for (const providerHeading of [...root.querySelectorAll('.project:not(.free-models-heading)')]) {
      let node = providerHeading.nextElementSibling
      let hasChoice = false
      while (node && !node.classList.contains('project')) {
        if (node.matches('button[data-model]')) { hasChoice = true; break }
        node = node.nextElementSibling
      }
      if (!hasChoice) providerHeading.remove()
    }
  } catch (error) {
    console.warn('free model grouping failed', error)
  } finally {
    decoratingModels = false
  }
}

function installModelPickerEnhancements() {
  const search = $('modelSearch')
  if (search) {
    search.type = 'hidden'
    search.value = ''
    search.tabIndex = -1
  }
  const root = $('modelChoices')
  if (root) {
    const observer = new MutationObserver(() => queueMicrotask(decorateModelChoices))
    observer.observe(root, { childList: true })
  }
  $('modelButton')?.addEventListener('click', () => setTimeout(decorateModelChoices, 0))
}

function ensureProjectBrowser() {
  const modal = $('projectDialog')?.querySelector('.modal')
  if (!modal || $('projectBrowser')) return
  const choices = $('projectChoices')
  const actions = document.createElement('div')
  actions.className = 'project-browser-actions'
  actions.innerHTML = '<button type="button" class="project-browser-open" id="browseProjects">Папки на ПК</button>'
  choices.before(actions)
  const browser = document.createElement('div')
  browser.id = 'projectBrowser'
  browser.className = 'project-browser'
  browser.hidden = true
  actions.after(browser)
  $('browseProjects').addEventListener('click', openProjectBrowser)
}

function renderDirectorySnapshot(snapshot) {
  const browser = $('projectBrowser')
  if (!browser) return
  if (snapshot?.error) {
    browser.innerHTML = `<div class="project-browser-error">Не удалось открыть папку: ${escapeHtml(snapshot.error)}</div>`
    browser.hidden = false
    return
  }
  if (!snapshot?.current) {
    browser.innerHTML = `<div class="project-browser-title">Корни проектов</div>${(snapshot?.roots || []).map((root) => `<button type="button" class="directory-choice" data-directory="${escapeHtml(root.path)}"><strong>${escapeHtml(root.name)}</strong><span>${escapeHtml(root.path)}</span></button>`).join('') || '<div class="project-browser-error">Не настроены OPENCODE_PROJECT_ROOTS</div>'}`
  } else {
    browser.innerHTML = `<div class="project-browser-nav">
      ${snapshot.parent ? `<button type="button" data-directory="${escapeHtml(snapshot.parent)}">← Выше</button>` : '<span></span>'}
      <button type="button" class="primary" data-open-directory="${escapeHtml(snapshot.current)}">Открыть эту папку</button>
    </div>
    <div class="project-browser-path">${escapeHtml(snapshot.current)}</div>
    ${(snapshot.directories || []).map((item) => `<button type="button" class="directory-choice" data-directory="${escapeHtml(item.path)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.path)}</span></button>`).join('') || '<div class="project-browser-empty">Нет вложенных папок</div>'}`
  }
  browser.hidden = false
  browser.querySelectorAll('[data-directory]').forEach((button) => button.addEventListener('click', () => browseDirectory(button.dataset.directory)))
  browser.querySelector('[data-open-directory]')?.addEventListener('click', () => openDirectoryAsProject(snapshot.current))
}

async function browseDirectory(path) {
  const browser = $('projectBrowser')
  if (browser) browser.innerHTML = '<div class="loading">Загрузка…</div>'
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const snapshot = await request(`/client-directories.json${query}`)
  if (!path && snapshot?.roots?.length === 1) {
    await browseDirectory(snapshot.roots[0].path)
    return
  }
  renderDirectorySnapshot(snapshot)
}

async function openProjectBrowser() {
  ensureProjectBrowser()
  $('projectChoices').hidden = true
  await browseDirectory().catch((error) => renderDirectorySnapshot({ error:error.message }))
}

async function openDirectoryAsProject(directory) {
  const created = dataOf(await request('/api/session', {
    method: 'POST',
    body: JSON.stringify({ location:{ directory }, title:'Новая сессия' }),
  }))
  if (!created?.id) throw new Error('OpenCode не вернул id новой сессии')
  location.hash = `/session/${encodeURIComponent(created.id)}`
  location.reload()
}

function installProjectBrowser() {
  const button = $('chooseProject')
  if (button) {
    button.textContent = 'Проекты'
    button.classList.remove('icon')
    button.classList.add('project-button')
    button.title = 'Открыть проект или папку на ПК'
  }
  ensureProjectBrowser()
  $('chooseProject')?.addEventListener('click', () => {
    const choices = $('projectChoices')
    const browser = $('projectBrowser')
    if (choices) choices.hidden = false
    if (browser) browser.hidden = true
  })
}

function init() {
  installModelPickerEnhancements()
  installProjectBrowser()
}

if (typeof document !== 'undefined') init()
