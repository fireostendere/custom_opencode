const $ = (id) => document.getElementById(id)
const STORAGE_KEY = 'custom-opencode.doctor.last.v1'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char])
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`)
  }
  return response.json()
}

function statusMark(status) {
  if (status === 'pass') return '✓'
  if (status === 'warn') return '△'
  return '×'
}

function savedResults() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {} } catch { return {} }
}

function saveResult(kind, result) {
  const all = savedResults()
  all[kind] = { ...result, at:Date.now() }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

function lastText(value) {
  if (!value?.at) return ''
  const date = new Date(value.at)
  const state = value.ok ? 'PASS' : 'FAIL'
  return `${state} · ${date.toLocaleString('ru-RU')}${value.elapsedMs ? ` · ${value.elapsedMs} ms` : ''}`
}

function renderSnapshot(snapshot) {
  const root = $('doctorContent')
  if (!root) return
  const groups = new Map()
  for (const check of snapshot.checks || []) {
    if (!groups.has(check.group)) groups.set(check.group, [])
    groups.get(check.group).push(check)
  }
  const last = savedResults()
  root.innerHTML = [...groups.entries()].map(([group, checks]) => `
    <section class="doctor-group">
      <h4>${escapeHtml(group)}</h4>
      ${checks.map((check) => `<div class="doctor-check ${escapeHtml(check.status)}">
        <span class="doctor-mark">${statusMark(check.status)}</span>
        <span class="doctor-check-main"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span>
      </div>`).join('')}
    </section>`).join('') + `
    <section class="doctor-group doctor-smokes">
      <h4>Smoke tests</h4>
      <div class="doctor-note">Открытие этой панели не расходует LLM-токены. Платные проверки запускаются только вручную.</div>
      ${(snapshot.smokes || []).map((smoke) => `<div class="doctor-smoke" data-smoke-row="${escapeHtml(smoke.id)}">
        <div><strong>${escapeHtml(smoke.label)}</strong><small>${escapeHtml(smoke.note)}</small><small class="doctor-last">${escapeHtml(lastText(last[smoke.id]))}</small></div>
        <button type="button" data-doctor-smoke="${escapeHtml(smoke.id)}" data-paid="${smoke.paid ? '1' : '0'}">${smoke.paid ? 'Проверить · платно' : 'Проверить · 0 токенов'}</button>
      </div>`).join('')}
    </section>`
  root.querySelectorAll('[data-doctor-smoke]').forEach((button) => button.addEventListener('click', () => runSmoke(button)))
  const generated = $('doctorGenerated')
  if (generated) generated.textContent = snapshot.generatedAt ? `Проверено ${new Date(snapshot.generatedAt * 1000).toLocaleTimeString('ru-RU')}` : ''
}

async function refreshDoctor() {
  const root = $('doctorContent')
  if (root) root.innerHTML = '<div class="loading">Проверяю без LLM-токенов…</div>'
  try {
    renderSnapshot(await request('/client-doctor.json'))
  } catch (error) {
    if (root) root.innerHTML = `<div class="doctor-error">Doctor недоступен: ${escapeHtml(error.message)}</div>`
  }
}

async function runSmoke(button) {
  const kind = button.dataset.doctorSmoke
  const paid = button.dataset.paid === '1'
  if (paid && !window.confirm('Эта проверка сделает реальный запрос к модели и потратит немного Token Plan credits. Запустить?')) return
  const original = button.textContent
  button.disabled = true
  button.textContent = 'Проверка…'
  try {
    const result = await request('/client-doctor-smoke.json', {
      method:'POST',
      body:JSON.stringify({ kind }),
    })
    saveResult(kind, result)
    const row = button.closest('[data-smoke-row]')
    const last = row?.querySelector('.doctor-last')
    if (last) last.textContent = `${lastText(savedResults()[kind])}${result.detail ? ` · ${result.detail}` : result.error ? ` · ${result.error}` : ''}`
    button.classList.toggle('doctor-pass', !!result.ok)
    button.classList.toggle('doctor-fail', !result.ok)
    if (kind === 'rag') await refreshDoctor()
  } catch (error) {
    saveResult(kind, { ok:false, error:error.message })
    const row = button.closest('[data-smoke-row]')
    const last = row?.querySelector('.doctor-last')
    if (last) last.textContent = `FAIL · ${error.message}`
    button.classList.add('doctor-fail')
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

export async function openDoctor() {
  const dialog = $('doctorDialog')
  if (!dialog) return
  if (!dialog.open) dialog.showModal()
  await refreshDoctor()
}

function init() {
  $('doctorButton')?.addEventListener('click', openDoctor)
  $('doctorRefresh')?.addEventListener('click', refreshDoctor)
  window.addEventListener('custom-opencode:doctor', openDoctor)
}

if (typeof document !== 'undefined') init()
