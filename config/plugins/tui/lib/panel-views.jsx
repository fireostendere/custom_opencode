/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { acquireLimits, getLimitsSync, getNightPromoStatus } from "./limits-helper.js"
import { normalizeFamilyIDs, resolvePlanSources, resolveRootID, selectV2PlanCandidates, selectV2PlanEntries, syncFamilyMessages } from "./panel-data.js"
import {
  activityRows,
  formatTokens,
  historyRows,
  PANEL_EVENTS,
  planProgress,
  relativeTime,
  SESSION_TREE_EVENTS,
  sessionCard,
  truncate,
} from "./panel-model.js"

export const PANEL_DEFS = [
  { id: "session", title: "Сессия", short: "Сесс" },
  { id: "activity", title: "Активность", short: "Акт" },
  { id: "plan", title: "План", short: "План" },
  { id: "orchestration", title: "Оркестрация", short: "Орк" },
  { id: "history", title: "История", short: "Ист" },
  { id: "limits", title: "Лимиты", short: "Лим" },
]
export const PANEL_IDS = PANEL_DEFS.map((item) => item.id)

const V2_PLAN_DIRECTORY = process.env.OPENCODE_PLAN_DIRECTORY ? resolve(process.env.OPENCODE_PLAN_DIRECTORY.replace(/^~(?=\/)/, homedir())) : join(homedir(), ".opencode", "plan")
const V2_PLAN_MAX_BYTES = 1_000_000
const MONTHS_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value ?? 0)))
}
function fmtClock(ts) {
  const d = new Date(Number(ts))
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
function fmtWhen(ts) {
  if (!ts) return ""
  const d = new Date(Number(ts))
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return fmtClock(ts)
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${fmtClock(ts)}`
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(2)}`
}
function fmtReset(ts, nowMs = Date.now()) {
  if (!ts) return ""
  const diff = Number(ts) * 1000 - nowMs
  if (diff <= 0) return "сейчас"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}м`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}ч ${mins % 60}м`
  return `${Math.floor(hours / 24)}д ${hours % 24}ч`
}
function fmtWindow(mins) {
  if (!mins) return ""
  if (mins < 60) return `${mins} мин`
  if (mins < 1440) return `${Math.round(mins / 60)} ч`
  return `${Math.round(mins / 1440)} д`
}
function fmtDur(mins) {
  if (mins < 60) return `${mins}м`
  return `${Math.floor(mins / 60)}ч ${mins % 60}м`
}
function fmtK(value) {
  if (value == null) return "?"
  return formatTokens(value)
}
function fmtMoney(value) {
  return `$${Number(value ?? 0).toFixed(2)}`
}

function parsePlanDocument(text, fallbackTitle) {
  const checkedTodos = []
  const bulletTodos = []
  let title = ""
  let inFence = false
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = line.match(/^\s*#\s+(.+?)\s*$/)
    if (!title && heading) title = heading[1]
    const checked = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX>~-])\]\s+(.+?)\s*$/)
    if (checked) {
      const marker = checked[1].toLowerCase()
      checkedTodos.push({
        content: checked[2],
        status: marker === "x" ? "completed" : [">", "~", "-"].includes(marker) ? "in_progress" : "pending",
      })
      continue
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)
    if (bullet && !/^\[[ xX>~-]\]/.test(bullet[1])) bulletTodos.push({ content: bullet[1], status: "pending" })
  }
  return { todos: checkedTodos.length ? checkedTodos : bulletTodos, title: title || fallbackTitle }
}

async function readV2Plan(sessionID) {
  let entries
  try { entries = await readdir(V2_PLAN_DIRECTORY, { withFileTypes: true }) } catch { return null }
  const candidates = []
  for (const entry of selectV2PlanEntries(entries, sessionID)) {
    const path = join(V2_PLAN_DIRECTORY, entry.name)
    try {
      const details = await stat(path)
      if (details.size > V2_PLAN_MAX_BYTES) continue
      candidates.push({ path, name: entry.name, updated: details.mtimeMs })
    } catch {}
  }
  for (const candidate of selectV2PlanCandidates(candidates, sessionID)) {
    try {
      const parsed = parsePlanDocument(await readFile(candidate.path, "utf8"), candidate.name.replace(/\.md$/, ""))
      if (parsed.todos.length) return { ...parsed, updated: candidate.updated, source: "native-v2" }
    } catch {}
  }
  return null
}

function messageParts(context, message) {
  try {
    const parts = context.state.part?.(message?.id ?? message?.messageID)
    if (Array.isArray(parts) && parts.length) return parts
  } catch {}
  return message?.parts ?? message?.content ?? []
}
function sessionMessages(context, sessionID) {
  if (!sessionID) return []
  try { return context.data.session.message.list(sessionID) ?? [] } catch {}
  try { return context.state.session.messages(sessionID) ?? [] } catch {}
  return []
}
// The native V2 todo tool; a session that uses it shows that list instead of the plan document.
function latestTodos(context, messages) {
  let latest = null
  let latestTime = -1
  for (const message of messages ?? []) {
    for (const part of messageParts(context, message)) {
      if (part?.type !== "tool" || (part.name ?? part.tool) !== "todowrite") continue
      let input = part.state?.input
      if (typeof input === "string") {
        try { input = JSON.parse(input) } catch { continue }
      }
      if (!Array.isArray(input?.todos)) continue
      const created = Number(message.time?.created ?? message.info?.time?.created ?? 0)
      if (created < latestTime) continue
      latestTime = created
      latest = input.todos.filter((todo) => todo && typeof todo.content === "string" && todo.content.trim())
    }
  }
  return latest
}

export function createPanelViews(context) {
  const theme = context.theme

  // Panels are off by default: creating the views must not start timers,
  // file reads or provider CLIs. LimitsView owns that machinery while mounted.
  const [limits, setLimits] = createSignal(getLimitsSync())
  const [now, setNow] = createSignal(Date.now())
  const limitReleases = new Set()

  // The plugin bundle has its own Solid copy, so the host's data store does not
  // track reads here: every view re-reads when one of these V2 events arrives.
  const [version, setVersion] = createSignal(0)
  const [sessionTreeVersion, setSessionTreeVersion] = createSignal(0)
  const subscriptions = []
  function subscribe(event, callback) {
    try {
      const unsubscribe = context.data.on?.(event, callback)
      if (typeof unsubscribe === "function") subscriptions.push(unsubscribe)
    } catch {}
  }
  for (const event of PANEL_EVENTS) subscribe(event, () => setVersion((current) => current + 1))
  for (const event of SESSION_TREE_EVENTS) {
    subscribe(event, () => {
      setVersion((current) => current + 1)
      setSessionTreeVersion((current) => current + 1)
    })
  }

  const tone = (name) =>
    ({
      active: theme.text.formfield.selected,
      accent: theme.text.action.primary.base,
      error: theme.text.feedback.error.base,
      success: theme.text.feedback.success.base,
      warning: theme.text.feedback.warning.base,
      muted: theme.text.muted,
    })[name] ?? theme.text.base

  function usageColor(used) {
    if (Number(used ?? 0) >= 90) return theme.text.feedback.error.base
    if (Number(used ?? 0) >= 70) return theme.text.feedback.warning.base
    return theme.text.feedback.success.base
  }
  function useSessionMessageSync(props) {
    createEffect(() => {
      const sessionID = props.sessionID
      let current = true
      if (sessionID) {
        Promise.resolve().then(() => context.data.session.message.sync(sessionID)).then(() => {
          if (current && props.sessionID === sessionID) setVersion((value) => value + 1)
        }).catch(() => {})
      }
      onCleanup(() => { current = false })
    })
  }
  function sessionStatus(sessionID) {
    try { return context.data.session.status(sessionID) } catch { return "idle" }
  }
  function sessionInfo(sessionID) {
    try { return sessionID ? context.data.session.get(sessionID) : null } catch { return null }
  }

  /** A full-width rule: heavy for the share, light for the rest. */
  function Meter(props) {
    const [width, setWidth] = createSignal(0)
    const filled = () => Math.round((clampPercent(props.percent) / 100) * width())
    return (
      <box height={1} width="100%" minWidth={0} flexShrink={0} onSizeChange={function () { setWidth(this.width) }}>
        <text wrapMode="none">
          <span style={{ fg: props.color }}>{"━".repeat(filled())}</span>
          <span style={{ fg: theme.border.base }}>{"─".repeat(Math.max(0, width() - filled()))}</span>
        </text>
      </box>
    )
  }
  /** label ··· value on one line. */
  function Field(props) {
    return (
      <box flexDirection="row" justifyContent="space-between" width="100%" minWidth={0} flexShrink={0}>
        <text fg={theme.text.muted} flexShrink={0}><span>{props.label}</span></text>
        <text fg={props.color ?? theme.text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}><span>{props.value}</span></text>
      </box>
    )
  }
  function Empty(props) {
    return <text fg={theme.text.muted} wrapMode="word"><span>{props.children}</span></text>
  }

  function WindowRows(props) {
    const win = () => props.win
    return (
      <Show when={win() && typeof win().usedPercent === "number"}>
        <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
          <box flexDirection="row" justifyContent="space-between" width="100%" minWidth={0}>
            <text fg={theme.text.base} wrapMode="none" truncate minWidth={0}><b>{props.label}</b></text>
            <text fg={usageColor(win().usedPercent)} flexShrink={0}><span>{Math.round(win().usedPercent)}%</span></text>
          </box>
          <Meter percent={win().usedPercent} color={usageColor(win().usedPercent)} />
          <Show when={win().resetsAt || (win().limit != null && win().usedCredits != null)}>
            <text fg={theme.text.muted} wrapMode="none" truncate>
              <span>
                {[
                  win().limit != null && win().usedCredits != null ? `${fmtK(win().usedCredits)} из ${fmtK(win().limit)}` : "",
                  win().resetsAt ? `сброс через ${fmtReset(win().resetsAt, now())}` : "",
                ].filter(Boolean).join(" · ")}
              </span>
            </text>
          </Show>
        </box>
      </Show>
    )
  }
  function LimitsView() {
    // Reference-counted: the 120 s provider refresh and the Gemini ticker run
    // only while at least one Limits view is mounted (visible).
    const release = acquireLimits({
      onChange: () => setLimits(getLimitsSync()),
      onTick: () => setNow(Date.now()),
    })
    limitReleases.add(release)
    onCleanup(() => {
      limitReleases.delete(release)
      release()
    })
    setLimits(getLimitsSync())
    const data = () => limits() ?? {}
    const codex = () => data().codex ?? { available: false }
    const qwen = () => data().qwen ?? { available: false }
    const gemini = () => data().gemini ?? { available: false }
    const geminiSeconds = () => {
      const nowSeconds = Math.floor(now() / 1000)
      const g = gemini()
      return g.resetsAt ? Math.max(0, g.resetsAt - nowSeconds) : g.seconds
    }
    return (
      <box flexDirection="column" width="100%" minWidth={0} gap={1} flexShrink={0}>
        <Show when={codex().available} fallback={<Field label="ChatGPT" value="нет данных" color={theme.text.muted} />}>
          <WindowRows label={`ChatGPT · ${fmtWindow(codex().primary?.windowDurationMins) || "окно"}`} win={codex().primary} />
          <WindowRows label={`ChatGPT · ${fmtWindow(codex().secondary?.windowDurationMins) || "доп."}`} win={codex().secondary} />
        </Show>
        <Show
          when={qwen().available && qwen().state === "ok"}
          fallback={
            qwen().reason === "disabled" ? (
              <Field label="Alibaba" value="не используется" color={theme.text.muted} />
            ) : qwen().state === "expired" || qwen().reason === "session-expired" ? (
              <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
                <Field label="Alibaba" value="сессия истекла" color={theme.text.feedback.warning.base} />
                <text fg={theme.text.muted} wrapMode="word"><span>bl auth login --console</span></text>
              </box>
            ) : (
              <Field label="Alibaba" value="нет данных" color={theme.text.muted} />
            )
          }
        >
          <WindowRows label="Alibaba · 5 ч" win={qwen().fiveHour} />
          <WindowRows label="Alibaba · 7 д" win={qwen().sevenDay} />
        </Show>
        <Show when={gemini().available} fallback={<Field label="Gemini" value="не настроен" color={theme.text.muted} />}>
          <Show when={gemini().rateLimited}>
            <text fg={theme.text.feedback.warning.base} wrapMode="word"><span>Лимит Gemini (429): повтор через {geminiSeconds()}с…</span></text>
          </Show>
          <WindowRows label="Gemini · токены/мин" win={gemini().minuteTokens} />
          <WindowRows label="Gemini · запросы/мин" win={gemini().minuteRequests} />
          <WindowRows label="Gemini · запросы/сутки" win={gemini().dailyRequests} />
        </Show>
        {(() => {
          const promo = getNightPromoStatus(now())
          return (
            <text fg={promo.active ? theme.text.feedback.success.base : theme.text.muted} wrapMode="word">
              <span>{promo.active ? `☾ ночная скидка −50% · ещё ${fmtDur(promo.minutesToToggle)}` : `☼ ночная скидка −50% через ${fmtDur(promo.minutesToToggle)}`}</span>
            </text>
          )
        })()}
      </box>
    )
  }
  function TodoRows(props) {
    return <For each={props.todos ?? []}>{(todo) => {
      const done = todo.status === "completed"
      const active = todo.status === "in_progress"
      return (
        <box flexDirection="row" gap={1} width="100%" minWidth={0} flexShrink={0}>
          <text width={1} flexShrink={0} fg={active ? theme.text.formfield.selected : done ? theme.text.feedback.success.base : theme.text.muted}><span>{done ? "✓" : active ? "●" : "○"}</span></text>
          <text fg={done ? theme.text.muted : theme.text.base} flexGrow={1} minWidth={0} wrapMode="word">{active ? <b>{todo.content}</b> : <span>{todo.content}</span>}</text>
        </box>
      )
    }}</For>
  }
  function PlanView(props) {
    const [historicalTodos, setHistoricalTodos] = createSignal(null)
    const [nativePlan, setNativePlan] = createSignal({ sessionID: null, document: null })
    useSessionMessageSync(props)
    // Re-read the plan document on every panel event: plan_update rewrites it in place.
    createEffect(() => {
      const sessionID = props.sessionID ?? null
      version()
      let current = true
      setNativePlan((previous) => previous.sessionID === sessionID ? previous : { sessionID, document: null })
      readV2Plan(sessionID).then((document) => {
        if (current && (props.sessionID ?? null) === sessionID) setNativePlan({ sessionID, document })
      }).catch(() => {})
      onCleanup(() => { current = false })
    })
    createEffect(() => {
      const sessionID = props.sessionID
      let current = true
      setHistoricalTodos(null)
      if (!sessionID) return onCleanup(() => { current = false })
      ;(async () => {
        let cursor
        // Newest first; a todo list older than 2000 messages is not worth a
        // full-history download on every session switch.
        for (let page = 0; page < 10 && current; page++) {
          const response = await context.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) })
          const found = latestTodos(context, response.data ?? [])
          if (found !== null) {
            if (current && props.sessionID === sessionID) setHistoricalTodos(found)
            return
          }
          cursor = response.cursor?.next ?? undefined
          if (!cursor || !(response.data ?? []).length) return
        }
      })().catch(() => {})
      onCleanup(() => { current = false })
    })
    const plan = () => {
      version()
      const sessionID = props.sessionID
      const cached = latestTodos(context, sessionMessages(context, sessionID))
      const document = nativePlan().sessionID === (sessionID ?? null) ? nativePlan().document : null
      const sources = resolvePlanSources(cached, historicalTodos(), document)
      return { todos: sources.todos, title: sources.document?.title, updated: sources.document?.updated }
    }
    return (
      <box flexDirection="column" gap={1} width="100%" minWidth={0} flexShrink={0}>
        <Show when={plan().todos.length > 0} fallback={<Empty>Плана пока нет. Агент публикует его через plan_update, когда у задачи есть несколько этапов.</Empty>}>
          {(() => {
            const current = plan()
            const progress = planProgress(current.todos)
            const complete = progress.done === progress.total
            const running = current.todos.some((todo) => todo.status === "in_progress")
            const color = complete ? theme.text.feedback.success.base : running ? theme.text.formfield.selected : theme.text.base
            return <>
              <Show when={current.title}><text fg={theme.text.base} wrapMode="word"><b>{current.title}</b></text></Show>
              <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
                <Meter percent={progress.percent} color={color} />
                <box flexDirection="row" justifyContent="space-between" width="100%" minWidth={0}>
                  <text fg={color} flexShrink={0}><span>{progress.done} из {progress.total}{complete ? " · готово" : ""}</span></text>
                  <Show when={current.updated}><text fg={theme.text.muted} wrapMode="none" truncate minWidth={0}><span>{relativeTime(current.updated)}</span></text></Show>
                </box>
              </box>
              <TodoRows todos={current.todos} />
            </>
          })()}
        </Show>
      </box>
    )
  }
  function ActivityView(props) {
    useSessionMessageSync(props)
    const rows = () => {
      version()
      return activityRows(sessionMessages(context, props.sessionID))
    }
    return (
      <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 0} fallback={<Empty>Событий сессии пока нет.</Empty>}>
          <For each={rows()}>{(row, index) => {
            // A time only where the minute changes keeps the column quiet.
            const clock = () => (row.time ? fmtClock(row.time) : "")
            const first = () => index() === 0 || clock() !== (rows()[index() - 1]?.time ? fmtClock(rows()[index() - 1].time) : "")
            return (
              <box flexDirection="row" gap={1} width="100%" minWidth={0} flexShrink={0}>
                <text fg={theme.text.muted} width={5} flexShrink={0}><span>{first() ? clock() : ""}</span></text>
                <text fg={tone(row.tone)} width={1} flexShrink={0}><span>{row.icon}</span></text>
                <Show when={row.title}><text fg={row.tone === "base" ? theme.text.base : tone(row.tone)} flexShrink={0}><span>{row.title}</span></text></Show>
                <text fg={row.title ? theme.text.muted : row.tone === "base" ? theme.text.base : tone(row.tone)} wrapMode="none" truncate flexGrow={1} minWidth={0}><span>{row.detail}</span></text>
              </box>
            )
          }}</For>
        </Show>
      </box>
    )
  }
  function HistoryView(props) {
    useSessionMessageSync(props)
    const rows = () => {
      version()
      return historyRows(sessionMessages(context, props.sessionID))
    }
    return (
      <box flexDirection="column" gap={1} width="100%" minWidth={0} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 0} fallback={<Empty>В загруженной части сессии нет ваших сообщений.</Empty>}>
          <For each={rows()}>{(row) => (
            <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
              <text fg={theme.text.muted}><span>{fmtWhen(row.time)}</span></text>
              <text fg={theme.text.base} wrapMode="word"><span>{truncate(row.text, 280)}</span></text>
            </box>
          )}</For>
        </Show>
      </box>
    )
  }
  function OrchestrationView(props) {
    const [sessionIDs, setSessionIDs] = createSignal([])
    const [rootSessionID, setRootSessionID] = createSignal(null)
    createEffect(() => {
      const sessionID = props.sessionID
      sessionTreeVersion()
      let current = true
      setSessionIDs(sessionID ? [sessionID] : [])
      setRootSessionID(sessionID ?? null)
      if (!sessionID) return onCleanup(() => { current = false })
      ;(async () => {
        let rootID = sessionID
        let ids = [rootID]
        try {
          const root = await context.data.session.root(sessionID)
          rootID = resolveRootID(sessionID, root)
          await context.data.session.sync(rootID)
          const family = await context.data.session.family(rootID)
          ids = normalizeFamilyIDs(rootID, family)
        } catch {
          ids = normalizeFamilyIDs(rootID, [])
        }
        await syncFamilyMessages(ids, (id) => context.data.session.message.sync(id))
        if (current && props.sessionID === sessionID) {
          setSessionIDs(ids)
          setRootSessionID(rootID)
          setVersion((value) => value + 1)
        }
      })().catch(() => {})
      onCleanup(() => { current = false })
    })
    const rows = () => {
      version()
      const rootID = rootSessionID()
      return sessionIDs().map((sessionID) => {
        const info = sessionInfo(sessionID)
        const status = sessionStatus(sessionID)
        const last = activityRows(sessionMessages(context, sessionID), 1)[0]
        return {
          sessionID,
          root: sessionID === rootID,
          title: truncate(info?.title || sessionID, 60),
          agent: info?.agent ?? "",
          status: status === "running" ? "running" : info?.outcome ?? "idle",
          updated: info?.time?.updated,
          last,
        }
      })
    }
    const dot = (status) => (status === "running" ? "●" : status === "failed" ? "✗" : status === "interrupted" ? "‖" : "○")
    return (
      <box flexDirection="column" gap={1} width="100%" minWidth={0} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 1} fallback={<Empty>Подагентов в этой сессии не было.</Empty>}>
          <For each={rows()}>{(row) => (
            <box flexDirection="column" width="100%" minWidth={0} flexShrink={0} paddingLeft={row.root ? 0 : 2}>
              <box flexDirection="row" gap={1} width="100%" minWidth={0}>
                <text width={1} flexShrink={0} fg={row.status === "running" ? theme.text.formfield.selected : row.status === "failed" ? theme.text.feedback.error.base : theme.text.muted}><span>{dot(row.status)}</span></text>
                <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} minWidth={0}>{row.root ? <b>{row.title}</b> : <span>{row.title}</span>}</text>
              </box>
              <box flexDirection="row" gap={1} width="100%" minWidth={0} paddingLeft={2}>
                <text fg={theme.text.muted} wrapMode="none" truncate minWidth={0}>
                  <span>{[row.agent, row.status === "running" ? "работает" : relativeTime(row.updated)].filter(Boolean).join(" · ")}</span>
                </text>
              </box>
              <Show when={row.last}>
                <box flexDirection="row" gap={1} width="100%" minWidth={0} paddingLeft={2}>
                  <text fg={tone(row.last.tone)} width={1} flexShrink={0}><span>{row.last.icon}</span></text>
                  <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} minWidth={0}><span>{[row.last.title, row.last.detail].filter(Boolean).join(" ")}</span></text>
                </box>
              </Show>
            </box>
          )}</For>
        </Show>
      </box>
    )
  }
  function SessionView(props) {
    useSessionMessageSync(props)
    const card = () => {
      version()
      return sessionCard(sessionInfo(props.sessionID), sessionStatus(props.sessionID))
    }
    const state = () => {
      const value = card()
      if (value.running) return ["● работает", theme.text.formfield.selected]
      if (value.outcome === "failed") return ["✗ завершилась с ошибкой", theme.text.feedback.error.base]
      if (value.outcome === "interrupted") return ["‖ прервана", theme.text.muted]
      return ["○ ожидает", theme.text.muted]
    }
    return (
      <box flexDirection="column" gap={1} width="100%" minWidth={0} flexShrink={0}>
        <Show when={props.sessionID && card()} fallback={<Empty>Нет активной сессии.</Empty>}>
          <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
            <text fg={theme.text.base} wrapMode="word"><b>{card().title}</b></text>
            <text fg={state()[1]}><span>{state()[0]}{card().agent ? ` · ${card().agent}` : ""}</span></text>
            <Show when={card().model}><text fg={theme.text.muted} wrapMode="none" truncate><span>{card().model}</span></text></Show>
          </box>
          <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
            <Field label="Ввод" value={formatTokens(card().input)} />
            <Field label="Вывод" value={formatTokens(card().output)} />
            <Field label="Из кэша" value={formatTokens(card().cached)} />
            <Field label="Стоимость" value={fmtMoney(card().cost)} />
          </box>
          <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
            <Field label="Создана" value={fmtWhen(card().created)} />
            <Field label="Активность" value={relativeTime(card().updated)} />
            <text fg={theme.text.muted} wrapMode="none" truncate><span>{card().id}</span></text>
          </box>
        </Show>
      </box>
    )
  }
  function PanelContent(props) {
    return (
      <Switch>
        <Match when={props.view === "session"}><SessionView sessionID={props.sessionID} /></Match>
        <Match when={props.view === "activity"}><ActivityView sessionID={props.sessionID} /></Match>
        <Match when={props.view === "plan"}><PlanView sessionID={props.sessionID} /></Match>
        <Match when={props.view === "orchestration"}><OrchestrationView sessionID={props.sessionID} /></Match>
        <Match when={props.view === "history"}><HistoryView sessionID={props.sessionID} /></Match>
        <Match when={props.view === "limits"}><LimitsView /></Match>
      </Switch>
    )
  }

  return {
    PanelContent,
    dispose() {
      for (const unsubscribe of subscriptions) unsubscribe()
      for (const release of limitReleases) release()
      limitReleases.clear()
    },
  }
}
