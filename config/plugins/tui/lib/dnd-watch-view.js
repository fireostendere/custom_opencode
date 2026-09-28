/**
 * D&D table watcher status for the sidebar panel.
 *
 * The dnd-watch server plugin writes one JSON file per location into
 * `<state>/dnd-watch/`. This module reads those files asynchronously (re-read
 * only when mtime/size change) and turns one session's snapshot into rows.
 * The files hold statuses, cursors and a short journal — never game text.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// The server plugin rewrites its file at least every 15 s while it runs.
const STALE_MS = 45_000
const LOG_ROWS = 4

export function watchStateDirectory(env = process.env) {
  return join(env.CUSTOM_OPENCODE_STATE_DIR || join(homedir(), ".local", "state", "custom-opencode"), "dnd-watch")
}

const files = new Map()
/** sessionID → snapshot, the freshest file winning when two processes wrote one. */
export async function readWatchStates(directory = watchStateDirectory()) {
  let names
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"))
  } catch {
    files.clear()
    return new Map()
  }
  const paths = new Set(names.map((name) => join(directory, name)))
  for (const path of files.keys()) if (!paths.has(path)) files.delete(path)
  const sessions = new Map()
  for (const path of paths) {
    let info
    try {
      info = await stat(path)
    } catch {
      files.delete(path)
      continue
    }
    const key = `${info.mtimeMs}:${info.size}`
    let value = files.get(path)?.key === key ? files.get(path).value : undefined
    if (value === undefined) {
      try {
        value = JSON.parse(await readFile(path, "utf8"))
      } catch {
        value = null
      }
      files.set(path, { key, value })
    }
    for (const [sessionID, session] of Object.entries(value?.sessions ?? {})) {
      const previous = sessions.get(sessionID)
      if (previous && previous.updatedAt >= value.updatedAt) continue
      sessions.set(sessionID, { ...session, updatedAt: value.updatedAt, ...(value.stoppedAt ? { stoppedAt: value.stoppedAt } : {}) })
    }
  }
  return sessions
}

export function sameWatchStates(a, b) {
  if (a === b) return true
  if (a?.size !== b?.size) return false
  for (const [id, value] of a) if (JSON.stringify(value) !== JSON.stringify(b.get(id))) return false
  return true
}

/** Poll the status files every `intervalMs`; `onChange` runs only on a real change. */
export function watchWatchStates(onChange, options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000))
  const read = options.read ?? readWatchStates
  let current = new Map()
  let timer = null
  let stopped = false
  async function poll() {
    timer = null
    let next = current
    try {
      next = await read()
    } catch {}
    if (stopped) return
    if (!sameWatchStates(current, next)) {
      current = next
      try { onChange(next) } catch {}
    }
    timer = setTimeout(poll, intervalMs)
    timer.unref?.()
  }
  void poll()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** The block appears only for narrator sessions of the table project. */
export function isTableSession(session, snapshot) {
  if (snapshot) return true
  if (String(session?.agent ?? "").startsWith("dnd-")) return true
  return /(^|[\\/])dungeon_master([\\/]|$)/i.test(String(session?.location?.directory ?? ""))
}

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
 * Display model for one session: `tone` (ok|busy|warn|off), `headline`,
 * label/value `rows`, recent `log` lines, an optional `hint`, and `ticking`
 * when a countdown or timer needs a once-per-second refresh.
 */
export function describeWatch(snapshot, now = Date.now()) {
  if (!snapshot) {
    return { tone: "off", headline: "○ не подключён", rows: [], log: [], hint: "Включится, когда нарратор прочитает кампанию", ticking: false }
  }
  const watch = snapshot.watch ?? { status: "stopped" }
  const turn = snapshot.turn
  let tone = "off"
  let headline
  let hint
  let ticking = false
  if (snapshot.stoppedAt) {
    tone = "warn"
    headline = "⚠ opencode остановлен"
    hint = "Вотчер восстановится после запуска"
  } else if (now - (snapshot.updatedAt ?? 0) > STALE_MS) {
    tone = "warn"
    headline = "⚠ сервис opencode не отвечает"
  } else if (turn?.state === "running") {
    tone = "busy"
    headline = `◐ мастер разбирает ход · ${elapsed(now - turn.startedAt)}`
    ticking = true
  } else if (turn?.state === "retry") {
    tone = "warn"
    headline = `⚠ ход упал, повтор через ${secondsLeft(turn.retryAt, now)}с`
    ticking = true
  } else if (turn?.state === "gave_up") {
    tone = "warn"
    headline = "⚠ ход не разобран — нужен оператор"
    hint = "Напиши в сессию или /dnd-watch auto"
  } else if (watch.status === "waiting" && watch.errors > 0) {
    tone = "warn"
    headline = watch.retryAt ? `⚠ ODM недоступен, повтор ${secondsLeft(watch.retryAt, now)}с` : "⚠ ODM недоступен"
    ticking = Boolean(watch.retryAt)
  } else if (watch.status === "waiting") {
    tone = "ok"
    headline = "● ждёт игроков"
  } else if (watch.status === "triggered") {
    tone = "busy"
    headline = "◐ будит мастера…"
  } else if (snapshot.autoWatch === false) {
    headline = "○ выключен"
    hint = "/dnd-watch auto — включить"
  } else if (watch.status === "error") {
    tone = "warn"
    headline = "⚠ ожидание остановлено: ODM недоступен"
  } else if (watch.status === "timed_out") {
    headline = "○ ручное ожидание истекло"
  } else {
    headline = "○ не ждёт — включится после хода"
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
  return { tone, headline, rows, log, ...(hint ? { hint } : {}), ticking }
}
