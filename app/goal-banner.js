import { request, getSession } from './api.js'
import { describeGoal, watchGoal } from '/client-goal-view.js'

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char])

export function goalMarkup(goal) {
  const view = describeGoal(goal)
  if (!view) return ''
  const action = goal.unavailable || goal.status === 'completed' ? '' : goal.status === 'active'
    ? '<button type="button" data-goal-action="stop">Остановить</button>'
    : '<button type="button" data-goal-action="resume">Продолжить</button>'
  return `<div class="goal-heading"><strong class="goal-tone-${view.tone}">${escape(view.headline)}</strong><span>Продолжений: ${escape(view.turns)}</span>${action}</div><div class="goal-objective">${escape(view.objective)}</div>${view.summary ? `<div class="goal-progress">${escape(view.summary)}</div>` : ''}<div class="goal-hint">${escape(goal.unavailable ? 'Нет связи с сервером · показаны последние данные' : view.hint)}</div>`
}

export function mountGoalBanner() {
  const host = document.createElement('section')
  host.id = 'goalBanner'
  host.className = 'goal-banner'
  host.setAttribute('aria-label', 'Цель сессии')
  host.setAttribute('aria-live', 'polite')
  host.hidden = true
  document.querySelector('.messages-frame')?.before(host)
  let sessionID = null, directory = '', generation = 0, goal = null
  const render = () => {
    const markup = goalMarkup(goal)
    if (host._markup !== markup) { host.innerHTML = markup; host._markup = markup }
    host.hidden = !markup
  }
  const watcher = watchGoal({
    read: async (id, location) => {
      const query = new URLSearchParams({ 'location[directory]': location })
      const result = await request(`/api/rpc/custom.goal/get?${query}`, { method:'POST', body:JSON.stringify({ input:{ sessionID:id } }) })
      return result?.output
    },
    isVisible: () => !document.hidden,
    onChange: value => { goal = value; render() },
  })
  async function select() {
    const match = /^#\/session\/([^/?]+)/.exec(location.hash)
    const id = match ? decodeURIComponent(match[1]) : null
    if (sessionID === id && (directory || !id)) return
    sessionID = id; directory = ''; generation++
    watcher.setSession(null)
    const mine = generation
    if (!id) return
    try {
      const session = await getSession(id)
      if (mine !== generation) return
      directory = session.location.directory
      watcher.setSession(id, directory)
    } catch {}
  }
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-goal-action]')
    if (!button || button.disabled) return
    const id = sessionID, mine = generation
    button.disabled = true
    try {
      await request(`/api/session/${encodeURIComponent(id)}/command`, {
        method:'POST', body:JSON.stringify({ name:'goal', text:button.dataset.goalAction }),
      })
      if (mine === generation) await watcher.refresh()
    } catch {
      if (mine === generation) {
        const hint = host.querySelector('.goal-hint')
        if (hint) hint.textContent = 'Команда не выполнена. Проверьте связь и повторите.'
      }
    } finally { button.disabled = false }
  })
  const onEvent = event => {
    const payload = event.detail
    if (payload?.type === 'rpc.custom.goal.updated' && payload.data?.sessionID === sessionID) void watcher.refresh()
  }
  const onVisible = () => { if (!document.hidden) void watcher.refresh() }
  window.addEventListener('hashchange', select)
  window.addEventListener('custom-opencode:session-selected', select)
  window.addEventListener('custom-opencode:event', onEvent)
  document.addEventListener('visibilitychange', onVisible)
  void select()
  return () => {
    generation++; watcher.stop(); host.remove()
    window.removeEventListener('hashchange', select)
    window.removeEventListener('custom-opencode:session-selected', select)
    window.removeEventListener('custom-opencode:event', onEvent)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

if (typeof document !== 'undefined') mountGoalBanner()
