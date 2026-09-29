/**
 * D&D table watcher view model, shared by the TUI sidebar panel and the web
 * status bar. It turns one session's status snapshot (written by the
 * dnd-watch server plugin) into display text.
 *
 * Keep this module pure and import-free: the web server serves this very file
 * to the browser as /client-dnd-watch-describe.js, without a build step, so
 * both surfaces always tell the same story.
 */

// The server plugin rewrites its file at least every 15 s while it runs.
export const STALE_MS = 45_000
const LOG_ROWS = 4

const pad = (value) => String(value).padStart(2, "0")
const clockTime = (at) => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const secondsLeft = (at, now) => Math.max(0, Math.ceil((at - now) / 1000))
const elapsed = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}

function linkText(link, watch, now) {
  switch (link?.state) {
    case "live": return { text: "● push, онлайн" }
    case "connecting": return { text: "◌ подключение…" }
    case "reconnecting": return link.retryAt ? { text: `⚠ переподключение ${secondsLeft(link.retryAt, now)}с`, ticking: true } : { text: "⚠ переподключение…" }
    case "unsupported": return { text: "○ опрос 3с (сервер без push)" }
    case "denied": return { text: "⚠ push отклонён, опрос 3с" }
    case "disabled": return { text: "○ опрос 3с (push выключен)" }
    default: return { text: watch?.status === "waiting" ? "○ опрос 3с" : "—" }
  }
}

/**
 * Display model for one session: `tone` (ok|busy|warn|off), `headline`, a
 * short `label` for compact surfaces (the web status bar pill), label/value
 * `rows`, recent `log` lines, an optional `hint`, and `ticking` when a
 * countdown or timer needs a once-per-second refresh.
 */
export function describeWatch(snapshot, now = Date.now()) {
  if (!snapshot) {
    return { tone: "off", headline: "○ не подключён", label: "Не подключён", rows: [], log: [], hint: "Включится, когда нарратор прочитает кампанию", ticking: false }
  }
  const watch = snapshot.watch ?? { status: "stopped" }
  const turn = snapshot.turn
  let tone = "off"
  let headline
  let label
  let hint
  let ticking = false
  if (snapshot.stoppedAt) {
    tone = "warn"
    headline = "⚠ opencode остановлен"
    label = "opencode остановлен"
    hint = "Вотчер восстановится после запуска"
  } else if (now - (snapshot.updatedAt ?? 0) > STALE_MS) {
    tone = "warn"
    headline = "⚠ сервис opencode не отвечает"
    label = "opencode не отвечает"
  } else if (turn?.state === "running") {
    tone = "busy"
    headline = `◐ мастер разбирает ход · ${elapsed(now - turn.startedAt)}`
    label = `Мастер думает ${elapsed(now - turn.startedAt)}`
    ticking = true
  } else if (turn?.state === "retry") {
    tone = "warn"
    headline = `⚠ ход упал, повтор через ${secondsLeft(turn.retryAt, now)}с`
    label = `Повтор через ${secondsLeft(turn.retryAt, now)}с`
    ticking = true
  } else if (watch.status === "waiting" && watch.errors > 0) {
    tone = "warn"
    headline = watch.retryAt ? `⚠ ODM недоступен, повтор ${secondsLeft(watch.retryAt, now)}с` : "⚠ ODM недоступен"
    label = "ODM недоступен"
    ticking = Boolean(watch.retryAt)
  } else if (watch.status === "waiting") {
    tone = "ok"
    headline = "● ждёт игроков"
    label = "Ждёт игроков"
  } else if (watch.status === "triggered") {
    tone = "busy"
    headline = "◐ будит мастера…"
    label = "Будит мастера"
  } else if (snapshot.autoWatch === false) {
    headline = "○ выключен"
    label = "Выключен"
    hint = "/dnd-watch auto — включить"
  } else if (watch.status === "error") {
    tone = "warn"
    headline = "⚠ ожидание остановлено: ODM недоступен"
    label = "ODM недоступен"
  } else if (watch.status === "timed_out") {
    headline = "○ ручное ожидание истекло"
    label = "Ожидание истекло"
  } else {
    headline = "○ не ждёт — включится после хода"
    label = "Не ждёт"
  }
  const link = linkText(snapshot.link, watch, now)
  ticking ||= Boolean(link.ticking)
  const cursor = snapshot.cursor ?? watch.afterSeq
  const mode = watch.status === "waiting" ? (watch.auto ? "авто" : "ручной") : snapshot.autoWatch === false ? "выкл" : "авто"
  const rows = [
    ["Кампания", snapshot.campaignId ? `${String(snapshot.campaignId).slice(0, 8)}…` : "—"],
    ["Курсор", `${cursor === undefined ? "—" : `#${cursor}`} · ${mode}`],
    ["Связь", link.text],
  ]
  if (snapshot.awake) rows.push(["Сон ПК", "не даёт уснуть"])
  const log = (Array.isArray(snapshot.log) ? snapshot.log : [])
    .filter((item) => typeof item?.text === "string" && Number.isFinite(item.at))
    .slice(-LOG_ROWS)
    .map((item) => `${clockTime(item.at)} ${item.text}`)
  return { tone, headline, label, rows, log, ...(hint ? { hint } : {}), ticking }
}
