/** @jsxImportSource @opentui/solid */
/**
 * Universal right-side panel host for the OpenCode TUI.
 *
 * This replaces the former independent Plan (left) + Limits (right) strips.
 * One host owns geometry, pin/dock state, visibility and scroll surfaces.
 * Views are tabs inside the host: Activity, Plan and Limits.
 *
 * Important scroll rule: data updates never imperatively reset scroll position.
 * The user may explicitly jump to the end with the footer action/command.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  getLimits,
  getLimitsSync,
  onLimitsChange,
  startAutoRefresh,
  stopAutoRefresh,
  getNightPromoStatus,
} from "./lib/limits-helper.js"

const HANDLE_COLS = 2
const PANEL_COLS = 42
const STRIP_COLS = HANDLE_COLS + PANEL_COLS
const BAR_WIDTH = 8
const V2_PLAN_DIRECTORY = join(homedir(), ".opencode", "plan")

function bar(usedPercent) {
  const used = Math.max(0, Math.min(100, usedPercent ?? 0))
  const filled = Math.round((used / 100) * BAR_WIDTH)
  return "▰".repeat(filled) + "▱".repeat(BAR_WIDTH - filled)
}

function fmtReset(ts) {
  if (!ts) return ""
  const diff = ts * 1000 - Date.now()
  if (diff <= 0) return "сейчас"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}м`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}ч ${mins % 60}м`
  const days = Math.floor(hours / 24)
  return `${days}д ${hours % 24}ч`
}

function fmtDur(mins) {
  if (mins < 60) return `${mins}м`
  return `${Math.floor(mins / 60)}ч ${mins % 60}м`
}

function fmtTime(value) {
  if (!value) return ""
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function usageColor(theme, usedPercent) {
  const used = usedPercent ?? 0
  if (used >= 90) return theme.text.feedback.error.default
  if (used >= 70) return theme.text.feedback.warning.default
  return theme.text.feedback.success.default
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

async function readLatestV2Plan() {
  let entries
  try {
    entries = await readdir(V2_PLAN_DIRECTORY, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const path = join(V2_PLAN_DIRECTORY, entry.name)
    try {
      const details = await stat(path)
      candidates.push({ path, name: entry.name, updated: details.mtimeMs })
    } catch {}
  }
  candidates.sort((a, b) => b.updated - a.updated)
  for (const candidate of candidates) {
    try {
      const parsed = parsePlanDocument(await readFile(candidate.path, "utf8"), candidate.name.replace(/\.md$/, ""))
      if (parsed.todos.length) return { ...parsed, updated: candidate.updated, source: "native-v2" }
    } catch {}
  }
  return null
}

function latestTodos(messages) {
  let latest = null
  let latestTime = -1
  for (const message of messages ?? []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== "tool" || (part.name ?? part.tool) !== "todowrite") continue
      let input = part.state?.input
      if (typeof input === "string") {
        try { input = JSON.parse(input) } catch { continue }
      }
      if (!Array.isArray(input?.todos)) continue
      const created = message.time?.created ?? 0
      if (created < latestTime) continue
      latestTime = created
      latest = input.todos.filter((todo) => todo && typeof todo.content === "string" && todo.content.trim())
    }
  }
  return latest
}

function activityRows(messages) {
  const rows = []
  for (const message of messages ?? []) {
    const role = String(message?.role ?? message?.info?.role ?? "message")
    const created = message?.time?.created ?? message?.info?.time?.created ?? 0
    const content = Array.isArray(message?.content) ? message.content : []
    const tools = content
      .filter((part) => part?.type === "tool")
      .map((part) => String(part.name ?? part.tool ?? "tool"))
    const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string")
    const summary = tools.length
      ? tools.slice(0, 4).join(", ")
      : String(textPart?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 96)
    if (!summary && role === "assistant") continue
    rows.push({ role, summary: summary || role, created })
  }
  return rows.slice(-40)
}

export default Plugin.define({
  id: "custom.universal-panel",
  setup(context) {
    const theme = context.theme
    const renderer = context.renderer
    const [version, setVersion] = createSignal(0)
    const [documentPlan, setDocumentPlan] = createSignal(null)
    const [limits, setLimits] = createSignal(getLimitsSync())
    const [tick, setTick] = createSignal(0)
    const [state, updateState] = context.storage.store("universal-panel.state", {
      initial: { open: false, pinned: false, tab: "plan" },
    })

    if (state.open === true) updateState((draft) => { draft.open = false })

    startAutoRefresh()
    const unlimits = onLimitsChange(() => setLimits(getLimitsSync()))
    getLimits().then(setLimits).catch(() => {})
    const ticker = setInterval(() => setTick((value) => value + 1), 60_000)
    ticker.unref?.()

    let planPromise = null
    async function refreshPlan() {
      if (planPromise) return planPromise
      planPromise = readLatestV2Plan()
        .then((value) => { setDocumentPlan(value); setVersion((v) => v + 1); return value })
        .finally(() => { planPromise = null })
      return planPromise
    }
    refreshPlan().catch(() => {})

    const unmessage = context.data.on("session.message.content.updated", () => {
      setVersion((value) => value + 1)
      refreshPlan().catch(() => {})
    })

    function currentSessionID() {
      const route = context.ui.router.current()
      return route?.type === "session" ? route.sessionID : null
    }

    function currentMessages() {
      version()
      const sessionID = currentSessionID()
      if (!sessionID) return []
      try { return context.data.session.message.list(sessionID) ?? [] } catch { return [] }
    }

    function currentPlan() {
      const sessionID = currentSessionID()
      if (sessionID) {
        const todos = latestTodos(currentMessages())
        let info = null
        try { info = context.data.session.get(sessionID) } catch {}
        if (todos?.length) return { todos, title: info?.title, updated: info?.time?.updated, source: "session-todo" }
      }
      return documentPlan()
    }

    function setTab(tab) {
      updateState((draft) => { draft.tab = tab; draft.open = true })
    }
    function toggle() { updateState((draft) => { draft.open = !state.open }) }
    function togglePin() { updateState((draft) => { draft.pinned = !state.pinned }) }

    let panelNode = null
    let dockTarget = null
    let dockRetry = null
    let appliedPadding = null
    let activeScroll = null

    function findDockTarget() {
      let parent = panelNode?.parent
      while (parent) {
        const height = Number(renderer.height ?? 0)
        const candidates = (parent.getChildren?.() ?? [])
          .filter((child) => child !== panelNode && child.getChildrenCount?.() > 0)
          .filter((child) => !height || Number(child.height ?? 0) >= height / 2)
          .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0))
        if (candidates.length) return candidates[0]
        parent = parent.parent
      }
      return null
    }

    function syncDock() {
      const target = findDockTarget()
      if (!target) {
        if (!dockRetry) dockRetry = setTimeout(() => { dockRetry = null; syncDock() }, 50)
        return
      }
      if (dockTarget && dockTarget !== target) dockTarget.paddingRight = 0
      dockTarget = target
      const padding = state.pinned === true ? (state.open === true ? STRIP_COLS : HANDLE_COLS) : 0
      if (padding !== appliedPadding) {
        target.paddingRight = padding
        appliedPadding = padding
      }
    }

    function jumpToEnd() {
      const node = activeScroll
      try {
        if (typeof node?.scrollToBottom === "function") node.scrollToBottom()
        else if (typeof node?.scrollToEnd === "function") node.scrollToEnd()
        else if (typeof node?.scrollTo === "function") node.scrollTo(0, Number.MAX_SAFE_INTEGER)
      } catch {}
    }

    const hideCursorUnderPanel = () => {
      try {
        const cursor = renderer.getCursorState()
        if (cursor?.visible && state.open === true && state.pinned !== true && cursor.x > renderer.width - STRIP_COLS) {
          renderer.setCursorPosition(0, 0, false)
        }
      } catch {}
    }
    renderer.addPostProcessFn?.(hideCursorUnderPanel)

    function tabButton(id, title) {
      const active = state.tab === id
      return (
        <box paddingX={1} onMouseDown={() => setTab(id)}>
          <text fg={active ? theme.hue?.orange?.[400] ?? theme.text.default : theme.text.subdued}>
            <span>{active ? `● ${title}` : title}</span>
          </text>
        </box>
      )
    }

    function Header() {
      return (
        <box flexDirection="column" width="100%" flexShrink={0}>
          <box flexDirection="row" justifyContent="space-between" paddingX={1}>
            <text fg={theme.text.default}><span>Workspace</span></text>
            <box flexDirection="row" gap={1}>
              <box onMouseDown={togglePin}><text fg={state.pinned ? theme.hue?.orange?.[400] ?? theme.text.default : theme.text.subdued}><span>📌</span></text></box>
              <box onMouseDown={toggle}><text fg={theme.text.subdued}><span>×</span></text></box>
            </box>
          </box>
          <box flexDirection="row" paddingX={1} gap={1}>
            {tabButton("activity", "Activity")}
            {tabButton("plan", "Plan")}
            {tabButton("limits", "Limits")}
          </box>
        </box>
      )
    }

    function PlanBody() {
      const plan = currentPlan()
      if (!plan?.todos?.length) return <text fg={theme.text.subdued} wrapMode="word"><span>Плана пока нет.</span></text>
      const completed = plan.todos.filter((todo) => todo.status === "completed").length
      const percent = Math.round((completed / plan.todos.length) * 100)
      return (
        <box flexDirection="column" gap={1} width="100%">
          <box flexDirection="row" gap={1}>
            <text fg={completed === plan.todos.length ? theme.text.feedback.success.default : theme.hue?.orange?.[400] ?? theme.text.default}><span>{bar(percent)}</span></text>
            <text fg={theme.text.default}><span>{completed}/{plan.todos.length}</span></text>
            <text fg={theme.text.subdued}><span>· {percent}%</span></text>
          </box>
          {plan.todos.map((todo) => {
            const done = todo.status === "completed"
            const active = todo.status === "in_progress"
            return (
              <box flexDirection="row" gap={1} width="100%" flexShrink={0}>
                <text width={1} flexShrink={0} fg={active ? theme.hue?.orange?.[400] ?? theme.text.default : done ? theme.text.feedback.success.default : theme.text.subdued}><span>{done ? "✓" : active ? "●" : "○"}</span></text>
                <text fg={done ? theme.text.subdued : theme.text.default} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word"><span>{todo.content}</span></text>
              </box>
            )
          })}
          <text fg={theme.text.subdued} wrapMode="word"><span>{plan.title || plan.source || "Plan"}{plan.updated ? ` · ${fmtTime(plan.updated)}` : ""}</span></text>
        </box>
      )
    }

    function ActivityBody() {
      const rows = activityRows(currentMessages())
      if (!rows.length) return <text fg={theme.text.subdued}><span>Событий сессии пока нет.</span></text>
      return (
        <box flexDirection="column" gap={1} width="100%">
          {rows.map((row) => (
            <box flexDirection="column" width="100%" flexShrink={0}>
              <box flexDirection="row" gap={1}>
                <text fg={row.role === "assistant" ? theme.hue?.orange?.[400] ?? theme.text.default : theme.text.subdued}><span>{row.role}</span></text>
                <Show when={row.created}><text fg={theme.text.subdued}><span>{fmtTime(row.created)}</span></text></Show>
              </box>
              <text fg={theme.text.default} wrapMode="word"><span>{row.summary}</span></text>
            </box>
          ))}
        </box>
      )
    }

    function limitWindow(label, value) {
      if (!value || typeof value.usedPercent !== "number") return null
      return (
        <box flexDirection="column" gap={0}>
          <text fg={theme.text.subdued}><span>{label}</span></text>
          <box flexDirection="row" gap={1}>
            <text fg={usageColor(theme, value.usedPercent)}><span>{bar(value.usedPercent)}</span></text>
            <text fg={theme.text.default}><span>{Math.round(value.usedPercent)}%</span></text>
            <Show when={value.resetsAt}><text fg={theme.text.subdued}><span>· {fmtReset(value.resetsAt)}</span></text></Show>
          </box>
        </box>
      )
    }

    function LimitsBody() {
      tick()
      const data = limits() ?? {}
      const codex = data.codex ?? {}
      const qwen = data.qwen ?? {}
      const promo = getNightPromoStatus()
      return (
        <box flexDirection="column" gap={1} width="100%">
          <Show when={codex.available} fallback={<text fg={theme.text.subdued}><span>ChatGPT: нет данных</span></text>}>
            {limitWindow("ChatGPT", codex.primary)}
            {limitWindow("ChatGPT · secondary", codex.secondary)}
          </Show>
          <Show when={qwen.available && qwen.state === "ok"} fallback={<text fg={theme.text.subdued}><span>Alibaba: нет данных</span></text>}>
            {limitWindow("Alibaba · 5ч", qwen.fiveHour)}
            {limitWindow("Alibaba · 7д", qwen.sevenDay)}
          </Show>
          <text fg={promo.active ? theme.text.feedback.success.default : theme.text.subdued}><span>{promo.active ? `🌙 −50% · ещё ${fmtDur(promo.minutesToToggle)}` : `☀ −50% · через ${fmtDur(promo.minutesToToggle)}`}</span></text>
        </box>
      )
    }

    function PanelBody() {
      return (
        <scrollbox
          ref={(node) => { activeScroll = node }}
          flexGrow={1}
          minHeight={0}
          width="100%"
          scrollY={true}
          verticalScrollbarOptions={{ trackOptions: { backgroundColor: theme.background.default, foregroundColor: theme.hue?.orange?.[400] ?? theme.text.subdued } }}
        >
          <box flexDirection="column" paddingX={1} paddingTop={1} gap={1} width="100%">
            <Show when={state.tab === "activity"}><ActivityBody /></Show>
            <Show when={state.tab === "plan"}><PlanBody /></Show>
            <Show when={state.tab === "limits"}><LimitsBody /></Show>
          </box>
        </scrollbox>
      )
    }

    function UniversalPanel() {
      createEffect(() => { state.open; state.pinned; state.tab; currentSessionID(); queueMicrotask(syncDock) })
      return (
        <box
          ref={(node) => { panelNode = node; queueMicrotask(syncDock) }}
          position="absolute"
          top={0}
          right={0}
          width={state.open ? STRIP_COLS : HANDLE_COLS}
          height="100%"
          zIndex={state.pinned ? 0 : 1500}
          flexDirection="row"
        >
          <Show when={state.open}>
            <box width={PANEL_COLS} height="100%" border={["left"]} borderColor={theme.text.subdued} backgroundColor={theme.background.default} flexDirection="column" paddingTop={1}>
              <Header />
              <PanelBody />
              <box flexDirection="row" justifyContent="space-between" paddingX={1} flexShrink={0}>
                <text fg={theme.text.subdued}><span>обновления не сбрасывают scroll</span></text>
                <box onMouseDown={jumpToEnd}><text fg={theme.hue?.orange?.[400] ?? theme.text.default}><span>↓ конец</span></text></box>
              </box>
            </box>
          </Show>
          <box width={HANDLE_COLS} height="100%" border={["left"]} borderColor={theme.text.subdued} backgroundColor={theme.background.default} flexDirection="column" justifyContent="center" alignItems="center" onMouseDown={toggle}>
            <text fg={theme.text.subdued}><span>{state.open ? "▸" : "◂"}</span></text>
          </box>
        </box>
      )
    }

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 50,
          commands: [
            { id: "custom.panel.toggle", title: "Workspace panel: показать/скрыть", group: "Панели", bind: "ctrl+alt+u", palette: true, run: toggle },
            { id: "custom.panel.activity", title: "Workspace: Activity", group: "Панели", bind: "ctrl+alt+a", palette: true, run: () => setTab("activity") },
            { id: "custom.panel.plan", title: "Workspace: Plan", group: "Панели", bind: "ctrl+alt+t", palette: true, run: () => setTab("plan") },
            { id: "custom.panel.limits", title: "Workspace: Limits", group: "Панели", bind: "ctrl+alt+l", palette: true, run: () => setTab("limits") },
            { id: "custom.panel.end", title: "Workspace: перейти в конец", group: "Панели", bind: "ctrl+alt+end", palette: true, run: jumpToEnd },
          ],
        }))
        return <UniversalPanel />
      },
    })

    return () => {
      unslot()
      unlimits?.()
      unmessage?.()
      renderer.removePostProcessFn?.(hideCursorUnderPanel)
      if (dockRetry) clearTimeout(dockRetry)
      if (dockTarget) dockTarget.paddingRight = 0
      clearInterval(ticker)
      stopAutoRefresh()
    }
  },
})
