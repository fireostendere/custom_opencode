// D&D narrator watcher pill for the session status bar. It appears only for
// D&D tables: sessions the dnd-watch server plugin keeps a status file for.
// All wording (tone, headline, rows, log, hint) comes from the TUI's pure view
// model, served as-is by /client-dnd-watch-describe.js, so the web and the
// sidebar panel never disagree. This module only polls, keeps the server clock
// offset (countdowns ignore browser clock skew) and builds markup.

const PRESENT_DELAY = 2000
const ABSENT_DELAY = 20000
const TICK_MS = 1000
const TONE_DOT = { ok:'ok', busy:'busy pulse', warn:'warn', off:'off' }
const FALLBACK_VIEW = { tone:'off', headline:'Вотчер стола', label:'Вотчер стола', rows:[], log:[], ticking:false }

const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char])

export function createDndWatchChip({
  request,
  loadView = () => import('/client-dnd-watch-describe.js'),
  onChange = () => {},
  isVisible = () => true,
  clock = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let sessionID = null
  let snapshot = null
  let offset = 0
  let generation = 0
  let timer = null
  let ticker = null
  let describe = null

  const serverNow = () => clock() + offset
  const schedule = (delay) => {
    if (timer !== null) clearTimeoutFn(timer)
    timer = sessionID ? setTimeoutFn(poll, delay) : null
  }
  const syncTicker = (ticking) => {
    if (ticking && ticker === null) ticker = setIntervalFn(() => { if (isVisible()) onChange() }, TICK_MS)
    else if (!ticking && ticker !== null) { clearIntervalFn(ticker); ticker = null }
  }
  async function viewModel() {
    if (describe) return describe
    try {
      const module = await loadView()
      if (typeof module?.describeWatch === 'function') describe = module.describeWatch
    } catch {}
    return describe
  }
  async function poll() {
    timer = null
    const id = sessionID, mine = generation
    if (!id) return
    if (!isVisible()) { schedule(ABSENT_DELAY); return }
    let next = null
    try {
      const sentAt = clock()
      const value = await request(`/client-dnd-watch.json?sessionID=${encodeURIComponent(id)}`)
      const receivedAt = clock()
      if (value?.present && value.snapshot && typeof value.snapshot === 'object') {
        next = value.snapshot
        if (Number.isFinite(value.serverNow)) offset = value.serverNow - (sentAt + receivedAt) / 2
        await viewModel()
      }
    } catch {}
    if (mine !== generation) return
    const changed = JSON.stringify(next) !== JSON.stringify(snapshot)
    snapshot = next
    schedule(snapshot ? PRESENT_DELAY : ABSENT_DELAY)
    current()
    if (changed) onChange()
  }

  function current() {
    if (!snapshot) { syncTicker(false); return null }
    let view = FALLBACK_VIEW
    try { view = describe ? describe(snapshot, serverNow()) : FALLBACK_VIEW } catch {}
    syncTicker(Boolean(view.ticking))
    return view
  }

  return {
    setSession(id) {
      if ((id || null) === sessionID) return
      sessionID = id || null
      generation += 1
      const had = snapshot !== null
      snapshot = null
      syncTicker(false)
      schedule(0)
      if (had) onChange()
    },
    /** Poll now (tab became visible again). */
    refresh() { if (sessionID) schedule(0) },
    view: current,
    /** The status-bar pill, or '' when this session is not a D&D table. */
    markup() {
      const view = current()
      if (!view) return ''
      return `<button type="button" class="wf-pill clickable dnd-watch-pill" id="dndWatchButton" title="${escapeText(view.headline)}" aria-label="Вотчер стола: ${escapeText(view.headline)}"><span class="wf-dot ${TONE_DOT[view.tone] || 'off'}"></span><span class="dnd-watch-label">🎲 ${escapeText(view.label || view.headline)}</span></button>`
    },
    /** Body of the details dialog. */
    detailsMarkup() {
      const view = current()
      if (!view) return '<div class="empty">Эта сессия не ведёт стол D&amp;D.</div>'
      const rows = view.rows.map(([label, value]) => `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`).join('')
      const log = view.log.map((line) => `<li>${escapeText(line)}</li>`).join('')
      return `<div class="dnd-watch-headline tone-${escapeText(view.tone)}">${escapeText(view.headline)}</div>${rows ? `<dl class="dnd-watch-rows">${rows}</dl>` : ''}${view.hint ? `<div class="workflow-note">${escapeText(view.hint)}</div>` : ''}${log ? `<div class="workflow-label">Последнее</div><ul class="dnd-watch-log">${log}</ul>` : ''}`
    },
    stop() {
      sessionID = null
      generation += 1
      snapshot = null
      syncTicker(false)
      schedule(0)
    },
  }
}
