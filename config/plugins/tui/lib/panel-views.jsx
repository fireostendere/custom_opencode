/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  getLimits,
  getLimitsSync,
  onLimitsChange,
  startAutoRefresh,
  stopAutoRefresh,
  getNightPromoStatus,
} from "./limits-helper.js"
import { normalizeFamilyIDs, resolvePlanSources, resolveRootID, selectV2PlanCandidates, selectV2PlanEntries, syncFamilyMessages } from "./panel-data.js"

export const PANEL_DEFS = [
  { id: "session", title: "Сессия", short: "Сесс" },
  { id: "activity", title: "Activity", short: "Act" },
  { id: "plan", title: "План", short: "План" },
  { id: "orchestration", title: "Оркестрация", short: "Орк" },
  { id: "history", title: "История", short: "Ист" },
  { id: "limits", title: "Лимиты", short: "Лим" },
]
export const PANEL_IDS = PANEL_DEFS.map((item) => item.id)

const BAR_WIDTH = 8
const V2_PLAN_DIRECTORY = process.env.OPENCODE_PLAN_DIRECTORY ? resolve(process.env.OPENCODE_PLAN_DIRECTORY.replace(/^~(?=\/)/, homedir())) : join(homedir(), ".opencode", "plan")
const V2_PLAN_MAX_BYTES = 1_000_000
const MONTHS_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value ?? 0)))
}
function bar(value) {
  const used = clampPercent(value)
  const filled = Math.round((used / 100) * BAR_WIDTH)
  return "▰".repeat(filled) + "▱".repeat(BAR_WIDTH - filled)
}
function fmtWhen(ts) {
  if (!ts) return ""
  const d = new Date(Number(ts))
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS_RU[d.getMonth()]}`
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(2)}`
}
function fmtReset(ts) {
  if (!ts) return ""
  const diff = Number(ts) * 1000 - Date.now()
  if (diff <= 0) return "сейчас"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}м`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}ч ${mins % 60}м`
  return `${Math.floor(hours / 24)}д ${hours % 24}ч`
}
function fmtWindow(mins) {
  if (!mins) return ""
  if (mins < 60) return `${mins}м`
  if (mins < 1440) return `${Math.round(mins / 60)}ч`
  return `${Math.round(mins / 1440)}д`
}
function fmtDur(mins) {
  if (mins < 60) return `${mins}м`
  return `${Math.floor(mins / 60)}ч ${mins % 60}м`
}
function fmtK(value) {
  if (value == null) return "?"
  if (value >= 1000) return `${Math.round((value / 1000) * 10) / 10}K`
  return String(value)
}
function truncate(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
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
function messageText(context, message) {
  const parts = messageParts(context, message)
  if (!Array.isArray(parts)) return String(message?.text ?? "").trim()
  return parts.filter((part) => part?.type === "text" && !part.synthetic).map((part) => part.text ?? "").join("\n").trim()
}
function sessionMessages(context, sessionID) {
  if (!sessionID) return []
  try { return context.data.session.message.list(sessionID) ?? [] } catch {}
  try { return context.state.session.messages(sessionID) ?? [] } catch {}
  return []
}
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
function toolSummary(part) {
  let input = part?.state?.input
  if (typeof input === "string") {
    try { input = JSON.parse(input) } catch { return truncate(input, 140) }
  }
  if (!input || typeof input !== "object") return ""
  for (const key of ["description", "prompt", "task", "command", "path", "url", "query"]) {
    if (typeof input[key] === "string" && input[key].trim()) return truncate(input[key], 140)
  }
  return ""
}
function activityRows(context, messages) {
  const rows = []
  for (const message of messages ?? []) {
    const role = String(message?.role ?? message?.info?.role ?? "message")
    const created = message?.time?.created ?? message?.info?.time?.created ?? 0
    const parts = messageParts(context, message)
    const tools = Array.isArray(parts)
      ? parts.filter((part) => part?.type === "tool").map((part) => String(part.name ?? part.tool ?? "tool"))
      : []
    const summary = tools.length ? tools.slice(0, 4).join(", ") : truncate(messageText(context, message), 120)
    if (!summary && role === "assistant") continue
    rows.push({ role, summary: summary || role, created })
  }
  return rows.slice(-80)
}

export function createPanelViews(context) {
  const theme = context.theme

  startAutoRefresh()
  const [limits, setLimits] = createSignal(getLimitsSync())
  const unsubscribeLimits = onLimitsChange(() => setLimits(getLimitsSync()))
  getLimits().then(setLimits).catch(() => {})
  const [tick, setTick] = createSignal(0)
  const ticker = setInterval(() => {
    setTick((value) => value + 1)
    const current = getLimitsSync()
    if (current.gemini?.rateLimited || limits()?.gemini?.rateLimited) {
      setLimits(current)
    }
  }, 1000)
  ticker.unref?.()

  const [version, setVersion] = createSignal(0)
  const [sessionTreeVersion, setSessionTreeVersion] = createSignal(0)
  const subscriptions = []
  function subscribe(event, callback) {
    try {
      const unsubscribe = context.data.on?.(event, callback)
      if (typeof unsubscribe === "function") subscriptions.push(unsubscribe)
    } catch {}
  }
  for (const event of ["message.updated", "message.part.updated", "session.message.content.updated"]) {
    subscribe(event, () => setVersion((current) => current + 1))
  }
  for (const event of ["session.created", "session.updated", "session.deleted"]) {
    subscribe(event, () => {
      setVersion((current) => current + 1)
      setSessionTreeVersion((current) => current + 1)
    })
  }

  function usageColor(used) {
    if (Number(used ?? 0) >= 90) return theme.text.feedback.error.default
    if (Number(used ?? 0) >= 70) return theme.text.feedback.warning.default
    return theme.text.feedback.success.default
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
  function WindowRows(props) {
    const win = () => props.win
    return (
      <Show when={win() && typeof win().usedPercent === "number"}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.text.subdued}><span>{props.label}</span></text>
          <box flexDirection="row" gap={1}>
            <text fg={usageColor(win().usedPercent)}><span>{bar(win().usedPercent)}</span></text>
            <text fg={theme.text.default}><span>{Math.round(win().usedPercent)}%</span></text>
          </box>
          <Show when={win().resetsAt}><text fg={theme.text.subdued}><span>сброс {fmtReset(win().resetsAt)}</span></text></Show>
          <Show when={win().limit != null && win().usedCredits != null}><text fg={theme.text.subdued}><span>{fmtK(win().usedCredits)} / {fmtK(win().limit)} исп.</span></text></Show>
        </box>
      </Show>
    )
  }
  function LimitsView() {
    tick()
    const data = () => limits() ?? {}
    const codex = () => data().codex ?? { available: false }
    const qwen = () => data().qwen ?? { available: false }
    const gemini = () => {
      const g = data().gemini
      if (g?.rateLimited) {
        return getLimitsSync().gemini ?? g
      }
      return g ?? { available: false }
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={codex().available} fallback={<text fg={theme.text.subdued}><span>ChatGPT: нет данных</span></text>}>
          <WindowRows label={codex().primary?.windowDurationMins ? `ChatGPT · ${fmtWindow(codex().primary.windowDurationMins)}` : "ChatGPT"} win={codex().primary} />
          <WindowRows label={codex().secondary?.windowDurationMins ? `ChatGPT · ${fmtWindow(codex().secondary.windowDurationMins)}` : "ChatGPT · доп."} win={codex().secondary} />
        </Show>
        <Show when={qwen().available && qwen().state === "ok"} fallback={<text fg={theme.text.subdued}><span>Alibaba: нет данных</span></text>}>
          <WindowRows label="Alibaba · 5ч" win={qwen().fiveHour} />
          <WindowRows label="Alibaba · 7д" win={qwen().sevenDay} />
        </Show>
        <Show when={gemini().available} fallback={<text fg={theme.text.subdued}><span>Gemini: не настроен</span></text>}>
          <Show when={gemini().rateLimited}>
            <text fg={theme.text.feedback.warning.default}><span>Лимит Gemini (429): повтор через {gemini().seconds}с…</span></text>
          </Show>
          <WindowRows label="Gemini · 1м (TPM)" win={gemini().minuteTokens} />
          <WindowRows label="Gemini · 1м (RPM)" win={gemini().minuteRequests} />
          <WindowRows label="Gemini · сутки (RPD)" win={gemini().dailyRequests} />
        </Show>
        {(() => {
          const promo = getNightPromoStatus()
          return <text fg={promo.active ? theme.text.feedback.success.default : theme.text.subdued}><span>{promo.active ? `🌙 −50% · ещё ${fmtDur(promo.minutesToToggle)}` : `☀ −50% · через ${fmtDur(promo.minutesToToggle)}`}</span></text>
        })()}
      </box>
    )
  }
  function TodoRows(props) {
    return <For each={props.todos ?? []}>{(todo) => {
      const done = todo.status === "completed"
      const active = todo.status === "in_progress"
      return (
        <box flexDirection="row" gap={1} width="100%" flexShrink={0}>
          <text width={1} flexShrink={0} fg={active ? theme.text.status.running : done ? theme.text.feedback.success.default : theme.text.subdued}><span>{done ? "✓" : active ? "●" : "○"}</span></text>
          <text fg={done ? theme.text.subdued : theme.text.default} flexGrow={1} minWidth={0} wrapMode="word"><span>{todo.content}</span></text>
        </box>
      )
    }}</For>
  }
  function PlanView(props) {
    const [historicalTodos, setHistoricalTodos] = createSignal(null)
    const [nativePlan, setNativePlan] = createSignal({ sessionID: null, document: null })
    useSessionMessageSync(props)
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
        do {
          const response = await context.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) })
          const found = latestTodos(context, response.data ?? [])
          if (found !== null) {
            if (current && props.sessionID === sessionID) setHistoricalTodos(found)
            return
          }
          cursor = response.cursor?.next ?? undefined
        } while (cursor)
      })().catch(() => {})
      onCleanup(() => { current = false })
    })
    const plan = () => {
      version()
      const sessionID = props.sessionID
      const cached = latestTodos(context, sessionMessages(context, sessionID))
      const document = nativePlan().sessionID === (sessionID ?? null) ? nativePlan().document : null
      const sources = resolvePlanSources(cached, historicalTodos(), document)
      const doc = sources.document
      let info
      try { info = sessionID ? context.data.session.get(sessionID) : null } catch { info = null }
      return {
        todos: sources.todos,
        title: info?.title || doc?.title,
        updated: info?.time?.updated || doc?.updated,
        source: sources.source,
      }
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={plan().todos.length > 0} fallback={<text fg={theme.text.subdued}><span>Плана пока нет.</span></text>}>
          {(() => {
            const current = plan()
            const completed = current.todos.filter((todo) => todo.status === "completed").length
            const running = current.todos.some((todo) => todo.status === "in_progress")
            const percent = current.todos.length ? Math.round((completed / current.todos.length) * 100) : 0
            return <>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={completed === current.todos.length ? theme.text.feedback.success.default : running ? theme.text.status.running : theme.text.default}><span>{bar(percent)}</span></text>
                <text fg={theme.text.default}><span>{completed}/{current.todos.length}</span></text>
                <text fg={theme.text.subdued}><span>· {percent}%</span></text>
              </box>
              <TodoRows todos={current.todos} />
              <Show when={current.title || current.source || current.updated}>
                <text fg={theme.text.subdued} wrapMode="word"><span>{current.title || current.source || "Plan"}{current.updated ? ` · ${fmtWhen(current.updated)}` : ""}</span></text>
              </Show>
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
      return activityRows(context, sessionMessages(context, props.sessionID))
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 0} fallback={<text fg={theme.text.subdued}><span>Событий сессии пока нет.</span></text>}>
          <For each={rows()}>{(row) => (
            <box flexDirection="column" width="100%" flexShrink={0}>
              <box flexDirection="row" gap={1}>
                <text fg={row.role === "assistant" ? theme.text.default : theme.text.subdued}><span>{row.role}</span></text>
                <Show when={row.created}><text fg={theme.text.subdued}><span>{fmtWhen(row.created)}</span></text></Show>
              </box>
              <text fg={theme.text.default} wrapMode="word"><span>{row.summary}</span></text>
            </box>
          )}</For>
        </Show>
      </box>
    )
  }
  function HistoryView(props) {
    useSessionMessageSync(props)
    const rows = () => {
      version()
      return sessionMessages(context, props.sessionID)
        .filter((message) => (message?.role ?? message?.info?.role) === "user" && message?.synthetic !== true && message?.summary !== true)
        .map((message) => ({ text: messageText(context, message), created: message.time?.created ?? message.info?.time?.created }))
        .filter((row) => row.text)
        .reverse()
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 0} fallback={<text fg={theme.text.subdued}><span>История пока пустая.</span></text>}>
          <For each={rows()}>{(row, index) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.text.subdued}><span>{index() + 1}. {fmtWhen(row.created)}</span></text>
              <text fg={theme.text.default} wrapMode="word"><span>{truncate(row.text)}</span></text>
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
      const result = []
      const rootID = rootSessionID()
      for (const sessionID of sessionIDs()) {
        let info
        try { info = context.data.session.get(sessionID) } catch { info = null }
        for (const message of sessionMessages(context, sessionID)) {
          for (const part of messageParts(context, message)) {
            if (part?.type !== "tool") continue
            const name = String(part.name ?? part.tool ?? "tool")
            result.push({
              name,
              status: String(part.state?.status ?? ""),
              detail: toolSummary(part),
              created: message.time?.created ?? message.info?.time?.created,
              session: sessionID === rootID ? "root" : truncate(info?.title || sessionID, 36),
            })
          }
        }
      }
      return result.slice(-80).reverse()
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={props.sessionID && rows().length > 0} fallback={<text fg={theme.text.subdued}><span>Оркестрация пока пустая.</span></text>}>
          <For each={rows()}>{(row) => (
            <box flexDirection="column" flexShrink={0}>
              <box flexDirection="row" gap={1}>
                <text fg={row.status === "running" || row.status === "in_progress" ? theme.text.status.running : theme.text.default}><span>{row.name}</span></text>
                <Show when={row.session !== "root"}><text fg={theme.text.subdued}><span>{row.session}</span></text></Show>
                <Show when={row.status}><text fg={row.status === "completed" ? theme.text.feedback.success.default : row.status === "error" ? theme.text.feedback.error.default : theme.text.subdued}><span>{row.status}</span></text></Show>
                <Show when={row.created}><text fg={theme.text.subdued}><span>{fmtWhen(row.created)}</span></text></Show>
              </box>
              <Show when={row.detail}><text fg={theme.text.subdued} wrapMode="word"><span>{row.detail}</span></text></Show>
            </box>
          )}</For>
        </Show>
      </box>
    )
  }
  function SessionView(props) {
    useSessionMessageSync(props)
    const snapshot = () => {
      version()
      let info
      try { info = props.sessionID ? context.data.session.get(props.sessionID) : null } catch { info = null }
      const messages = sessionMessages(context, props.sessionID)
      return {
        info,
        messages: messages.length,
        users: messages.filter((m) => (m?.role ?? m?.info?.role) === "user").length,
        assistants: messages.filter((m) => (m?.role ?? m?.info?.role) === "assistant").length,
      }
    }
    return (
      <box flexDirection="column" gap={1} flexShrink={0}>
        <Show when={props.sessionID} fallback={<text fg={theme.text.subdued}><span>Нет активной сессии.</span></text>}>
          <text fg={theme.text.default} wrapMode="word"><b>{snapshot().info?.title || "Сессия"}</b></text>
          <text fg={theme.text.subdued} wrapMode="word"><span>{props.sessionID}</span></text>
          <Show when={snapshot().info?.time?.updated}><text fg={theme.text.subdued}><span>Обновлено: {fmtWhen(snapshot().info.time.updated)}</span></text></Show>
          <text fg={theme.text.default}><span>Сообщений: {snapshot().messages}</span></text>
          <text fg={theme.text.subdued}><span>Пользователь: {snapshot().users} · Ассистент: {snapshot().assistants}</span></text>
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
      unsubscribeLimits?.()
      for (const unsubscribe of subscriptions) unsubscribe()
      clearInterval(ticker)
      stopAutoRefresh()
    },
  }
}
