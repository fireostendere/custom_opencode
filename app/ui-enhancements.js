const $ = (id) => document.getElementById(id)
const FAV_KEY = 'opencode:web:favorites'
const COLLAPSE_KEY = 'opencode:web:model-provider-collapse-v1'

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
  const entities = { '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }
  return String(value ?? '').replace(/[&<>'"]/g, (char) => entities[char])
}

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set() }
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
  const costs = Array.isArray(model?.cost) ? model.cost : (model?.cost && typeof model.cost === 'object' ? [model.cost] : [])
  if (costs.length) {
    return costs.every((cost) => Number(cost?.input || 0) === 0
      && Number(cost?.output || 0) === 0
      && Number(cost?.cache?.read || 0) === 0
      && Number(cost?.cache?.write || 0) === 0)
  }
  const id = String(model?.id || '').toLowerCase()
  return /(^|[-_])free($|[-_])/.test(id) || id === 'big-pickle' || id === 'x-preview-f-free'
}

export function compareModelEntries(a, b) {
  return Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))
    || Number(Boolean(b.selected)) - Number(Boolean(a.selected))
    || String(a.name || '').localeCompare(String(b.name || ''), 'ru', { sensitivity:'base', numeric:true })
}

export function compareProviderGroups(a, b) {
  return Number(b.favoriteCount || 0) - Number(a.favoriteCount || 0)
    || String(a.label || a.id || '').localeCompare(String(b.label || b.id || ''), 'ru', { sensitivity:'base', numeric:true })
}

function providerLabelsFromFlatList(root) {
  const labels = new Map()
  let heading = ''
  for (const node of [...root.children]) {
    if (node.classList.contains('project')) {
      heading = node.textContent.trim()
      continue
    }
    if (node.matches?.('button[data-provider][data-model]') && heading) {
      labels.set(node.dataset.provider, heading)
    }
  }
  return labels
}

function normalizeChoice(button, favorites, orchestrated) {
  const key = `${button.dataset.provider}/${button.dataset.model}`
  const title = button.querySelector('.choice-title')
  const selected = /\s·\s✓\s*$/.test(title?.textContent || '')
  if (title) {
    title.textContent = title.textContent.replace(/^★\s*/, '').replace(/\s·\s✓\s*$/, '')
    if (selected && !(orchestrated && key === 'bailian-cli/qwen3.8-max')) title.textContent += ' · ✓'
  }

  const favorite = button.querySelector('[data-fav]')
  if (favorite) {
    favorite.textContent = favorites.has(key) ? '★' : '☆'
    favorite.classList.add('model-favorite-toggle')
    favorite.setAttribute('role', 'button')
    favorite.setAttribute('aria-label', favorites.has(key) ? 'Убрать модель из избранного' : 'Добавить модель в избранное')
    favorite.title = favorites.has(key) ? 'Убрать из избранного' : 'В избранное'
  }
  button.dataset.favorite = favorites.has(key) ? '1' : '0'
  button.dataset.selected = selected ? '1' : '0'
  return {
    key,
    button,
    selected,
    favorite: favorites.has(key),
    name: title?.textContent?.replace(/\s·\s✓\s*$/, '') || button.dataset.model || key,
  }
}

function sortChoices(entries) {
  return [...entries].sort(compareModelEntries)
}

function providerSection({ id, label, entries, collapsed, providerLabels, orchestrated = false }) {
  const section = document.createElement('section')
  section.className = 'model-provider-section'
  section.dataset.providerSection = id

  const favoriteCount = entries.filter((entry) => entry.favorite).length
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'model-provider-toggle'
  toggle.dataset.providerToggle = id
  toggle.setAttribute('aria-expanded', String(!collapsed.has(id)))
  toggle.innerHTML = `<span class="model-provider-chevron">${collapsed.has(id) ? '›' : '⌄'}</span><strong>${escapeHtml(label)}</strong>${favoriteCount ? `<span class="model-provider-favorites">★ ${favoriteCount}</span>` : ''}<span class="model-provider-count">${entries.length + (orchestrated ? 1 : 0)}</span>`

  const body = document.createElement('div')
  body.className = 'model-provider-body'
  body.hidden = collapsed.has(id)

  if (orchestrated) {
    const special = document.createElement('button')
    special.type = 'button'
    special.className = 'choice orchestrated-model-choice'
    special.dataset.orchestratedModel = '1'
    special.innerHTML = `<div class="choice-title">Qwen 3.8 Max · Оркестратор${document.documentElement.dataset.modelProfile === 'orchestrated' ? ' · ✓' : ''}</div><div class="choice-meta">Max → Flash worker · optional RAG</div>`
    body.append(special)
  }

  for (const entry of sortChoices(entries)) {
    const meta = entry.button.querySelector('.choice-meta')
    if (id === '__free__' && meta && !meta.querySelector('.model-provider-label')) {
      const provider = document.createElement('span')
      provider.className = 'model-provider-label'
      provider.textContent = providerLabels.get(entry.button.dataset.provider) || entry.button.dataset.provider
      meta.prepend(provider)
    }
    body.append(entry.button)
  }

  toggle.addEventListener('click', () => {
    const next = !body.hidden
    body.hidden = next
    toggle.setAttribute('aria-expanded', String(!next))
    toggle.querySelector('.model-provider-chevron').textContent = next ? '›' : '⌄'
    const current = loadSet(COLLAPSE_KEY)
    if (next) current.add(id); else current.delete(id)
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...current]))
  })

  section.append(toggle, body)
  return section
}

let decoratingModels = false
let modelObserver = null
async function decorateModelChoices() {
  const root = $('modelChoices')
  if (!root || decoratingModels || !root.querySelector('[data-model]')) return
  decoratingModels = true
  modelObserver?.disconnect()
  try {
    const providerLabels = providerLabelsFromFlatList(root)
    const directory = await selectedDirectory()
    const params = new URLSearchParams()
    if (directory) params.set('location[directory]', directory)
    const models = dataOf(await request(`/api/model${params.size ? `?${params}` : ''}`)) || []
    const free = new Set((Array.isArray(models) ? models : [])
      .filter(isFreeModel)
      .map((model) => `${model.providerID}/${model.id}`))
    const favorites = loadSet(FAV_KEY)
    const collapsed = loadSet(COLLAPSE_KEY)
    const orchestrated = document.documentElement.dataset.modelProfile === 'orchestrated'
    const entries = [...root.querySelectorAll('button[data-provider][data-model]')]
      .map((button) => normalizeChoice(button, favorites, orchestrated))

    const freeEntries = []
    const byProvider = new Map()
    for (const entry of entries) {
      if (free.has(entry.key)) {
        freeEntries.push(entry)
        continue
      }
      const providerID = entry.button.dataset.provider
      if (!byProvider.has(providerID)) byProvider.set(providerID, [])
      byProvider.get(providerID).push(entry)
    }

    root.replaceChildren()
    if (freeEntries.length) {
      root.append(providerSection({
        id: '__free__',
        label: 'Бесплатные модели',
        entries: freeEntries,
        collapsed,
        providerLabels,
      }))
    }

    const providerGroups = [...byProvider.entries()].map(([id, providerEntries]) => ({
      id,
      entries: providerEntries,
      label: providerLabels.get(id) || id,
      favoriteCount: providerEntries.filter((entry) => entry.favorite).length,
    })).sort(compareProviderGroups)

    for (const group of providerGroups) {
      root.append(providerSection({
        id: group.id,
        label: group.label,
        entries: group.entries,
        collapsed,
        providerLabels,
        orchestrated: group.id === 'bailian-cli' && group.entries.some((entry) => entry.key === 'bailian-cli/qwen3.8-max'),
      }))
    }
  } catch (error) {
    console.warn('model catalog enhancement failed', error)
  } finally {
    decoratingModels = false
    if (modelObserver && root.isConnected) modelObserver.observe(root, { childList:true })
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
    modelObserver = new MutationObserver(() => {
      if (!decoratingModels) queueMicrotask(decorateModelChoices)
    })
    modelObserver.observe(root, { childList: true })
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
