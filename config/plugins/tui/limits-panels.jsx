/** @jsxImportSource @opentui/solid */
/**
 * Limits sidebar section, home-screen limits panel and the todo-plan strip
 * for the OpenCode TUI.
 *
 * Adds three independently hideable areas:
 *   - Лимиты: ChatGPT + Alibaba rate-limit windows in the session sidebar;
 *     the whole sidebar can be collapsed with the right-edge chevron
 *   - Лимиты (начальный экран): the same data as a collapsible strip on the
 *     right edge of the home screen.  The session view uses the native
 *     sidebar so it composes with Context, MCP and the other built-in panels.
 *   - План: a collapsible strip on the LEFT edge, present on every screen
 *     and bound to the current dialog.  In a session it shows that
 *     session's latest todowrite plan; on the start screen it shows the
 *     plan of the most recently updated session.  Progress bar
 *     (completed/total, percent) + todo list + session footer.
 *
 * Each custom edge strip is a thin bar with a chevron (the panel opens away
 * from the edge); both start collapsed on every launch.  Toggle with a
 * chevron/header click (mouse) or the "Панели" commands in the palette
 * (ctrl+alt+l toggles the limits panels, ctrl+alt+t the plan strip).  The
 * native session sidebar has its own right-edge chevron and uses the built-in
 * `session.sidebar.toggle` command (<leader>b).
 *
 * NOTE: TUI plugins that contain JSX must use the `.jsx`/`.tsx` extension,
 * and `context.keymap.layer()` may only be called inside a rendered
 * component (a slot/dialog render), never directly in `setup()`.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import {
  getLimits,
  getLimitsSync,
  onLimitsChange,
  startAutoRefresh,
  stopAutoRefresh,
  getNightPromoStatus,
} from "./lib/limits-helper.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BAR_WIDTH = 8

/**
 * @param {number | undefined} usedPercent
 * @returns {string}
 */
function bar(usedPercent) {
  const used = Math.max(0, Math.min(100, usedPercent ?? 0))
  const filled = Math.round((used / 100) * BAR_WIDTH)
  return "▰".repeat(filled) + "▱".repeat(BAR_WIDTH - filled)
}

const MONTHS_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]

/**
 * Format a unix-ms timestamp as a compact "when" label: HH:MM for today,
 * "30 авг" for this year, "30.08.24" for older.
 * @param {number | null | undefined} ts
 * @returns {string}
 */
function fmtWhen(ts) {
  if (!ts) return ""
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getDate()} ${MONTHS_RU[d.getMonth()]}`
  }
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(2)}`
}

/**
 * Format a unix-seconds reset timestamp as a short Russian duration.
 * @param {number | null | undefined} ts
 * @returns {string}
 */
function fmtReset(ts) {
  if (!ts) return ""
  const diff = ts * 1000 - Date.now()
  if (diff <= 0) return "сейчас"
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}м`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}ч ${m % 60}м`
  const d = Math.floor(h / 24)
  return `${d}д ${h % 24}ч`
}

/**
 * Format a window duration given in minutes.
 * @param {number | null | undefined} mins
 * @returns {string}
 */
function fmtWindow(mins) {
  if (!mins) return ""
  if (mins < 60) return `${mins}м`
  if (mins < 1440) return `${Math.round(mins / 60)}ч`
  return `${Math.round(mins / 1440)}д`
}

/**
 * Format a minute count as a short Russian duration.
 * @param {number} mins
 * @returns {string}
 */
function fmtDur(mins) {
  if (mins < 60) return `${mins}м`
  return `${Math.floor(mins / 60)}ч ${mins % 60}м`
}

/**
 * Format a token/credit count compactly.
 * @param {number | undefined} n
 * @returns {string}
 */
function fmtK(n) {
  if (n == null) return "?"
  if (n >= 1000) return `${Math.round((n / 1000) * 10) / 10}K`
  return String(n)
}

/**
 * Pick a feedback color for a usage percentage.
 * @param {object} theme
 * @param {number | undefined} usedPercent
 */
function usageColor(theme, usedPercent) {
  const used = usedPercent ?? 0
  if (used >= 90) return theme.text.feedback.error.default
  if (used >= 70) return theme.text.feedback.warning.default
  return theme.text.feedback.success.default
}

/**
 * @param {object} codex
 * @returns {string}
 */
function codexHint(codex) {
  switch (codex.reason) {
    case "codex-not-found":
      return "codex CLI не найден"
    default:
      return "нет данных (вход/лимиты недоступны)"
  }
}

/**
 * @param {object} qwen
 * @returns {string}
 */
function qwenHint(qwen) {
  switch (qwen.reason) {
    case "bailian-cli-not-found":
      return "bl CLI не найден"
    case "bailian-cli-unavailable":
      return "bl CLI не запускается"
    case "bailian-cli-error":
      return "нет входа: bl auth login --console"
    case "invalid-json":
    case "invalid-response":
      return "неожиданный ответ bl"
    default:
      return "нет данных"
  }
}

/**
 * Return the latest valid todo list written by the model in this session.
 * @param {import("@opencode-ai/client").SessionMessageInfo[]} messages
 */
function latestTodos(messages) {
  let latest = null
  let latestTime = -1
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== "tool" || (part.name ?? part.tool) !== "todowrite") continue
      let input = part.state?.input
      if (typeof input === "string") {
        try {
          input = JSON.parse(input)
        } catch {
          continue
        }
      }
      if (!Array.isArray(input?.todos)) continue
      const created = message.time?.created ?? 0
      if (created < latestTime) continue
      latestTime = created
      latest = input.todos.filter(
        (todo) => todo && typeof todo.content === "string" && todo.content.trim(),
      )
    }
  }
  return latest
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "custom.limits-panels",
  setup(context) {
    const theme = context.theme

    // Shared limits data (cache + background refresh).  `setup()` is not a
    // Solid component owner, so subscribe directly and tear down through the
    // returned cleanup instead of onMount/onCleanup.
    startAutoRefresh()
    const [limits, setLimits] = createSignal(getLimitsSync())
    const unsub = onLimitsChange(() => setLimits(getLimitsSync()))
    getLimits()
      .then((data) => setLimits(data))
      .catch(() => {})

    // Minute tick keeps the promo countdown fresh between limit refreshes.
    const [tick, setTick] = createSignal(0)
    const ticker = setInterval(() => setTick((t) => t + 1), 60_000)
    ticker.unref?.()

    // Message updates trigger a fresh read from the reactive session cache.
    const [planVersion, setPlanVersion] = createSignal(0)
    const unmessage = context.data.on("session.message.content.updated", () => {
      setPlanVersion((version) => version + 1)
    })

    // Persistent collapse state.  `home` is the start-screen limits strip;
    // `limits` controls the session-sidebar section; `plan` is the left-edge
    // plan strip.  All panels start collapsed.
    const [state, updateState] = context.storage.store("limits-panels.state", {
      initial: { limits: true, plan: false, home: false },
    })

    // The native sidebar owns its visibility state.  Keep only the local
    // chevron direction here; the built-in command remains the source of
    // truth for the actual layout.
    const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)
    function toggleSidebar() {
      context.keymap.dispatch("session.sidebar.toggle")
      setSidebarCollapsed((collapsed) => !collapsed)
    }

    // The edge strips must greet every launch collapsed, so drop any
    // "expanded" value persisted by the previous run.
    if (state.limits === true || state.home === true || state.plan === true) {
      updateState((draft) => {
        draft.limits = false
        draft.home = false
        draft.plan = false
      })
    }

    /** @param {"limits" | "plan" | "home"} which */
    function toggle(which) {
      updateState((draft) => {
        draft[which] = !state[which]
      })
    }

    // -----------------------------------------------------------------
    // Hardware-cursor guard
    // -----------------------------------------------------------------
    // The focused input caret is the real terminal cursor, drawn by the
    // terminal above every layer, so it shines right through an expanded
    // edge strip that happens to cover the caret cell.  Hide it while it
    // sits under an expanded strip (post-process hooks run after the
    // frame's renderables have positioned the cursor, so we get the last
    // word); the caret reappears as soon as it moves back into view.
    const PLAN_STRIP_COLS = 36 // 2-col edge bar + 34-col panel, left edge
    const HOME_STRIP_COLS = 34 // 2-col edge bar + 32-col panel, right edge
    const renderer = context.renderer
    /** @param {number} x 1-based cursor column */
    function cursorUnderStrip(x) {
      if (state.plan === true && x <= PLAN_STRIP_COLS) return true
      if (
        sidebarCollapsed() &&
        context.ui.router.current()?.type === "session" &&
        x > renderer.width - 2
      ) {
        return true
      }
      if (
        state.home === true &&
        context.ui.router.current()?.type === "home" &&
        x > renderer.width - HOME_STRIP_COLS
      ) {
        return true
      }
      return false
    }
    const hideCursorUnderStrip = () => {
      try {
        const cursor = renderer.getCursorState()
        if (cursor?.visible && cursorUnderStrip(cursor.x)) {
          renderer.setCursorPosition(0, 0, false)
        }
      } catch {}
    }
    renderer.addPostProcessFn?.(hideCursorUnderStrip)

    // -----------------------------------------------------------------
    // Start-screen plan data (latest todowrite of the freshest session)
    // -----------------------------------------------------------------

    /**
     * Latest plan found in the most recently updated sessions, plus the
     * session it belongs to.  `null` means "no plan anywhere yet".
     * @type {import("solid-js").Signal<
     *   { todos: { content: string, status?: string }[], sessionID: string,
     *     title?: string, updated?: number } | null>}
     */
    const [homePlan, setHomePlan] = createSignal(null)
    let homePlanBusy = false
    let homePlanCheckedAt = 0

    /**
     * Walk a session's message pages (newest first) until the most recent
     * todowrite plan is found.
     * @param {string} sessionID
     */
    async function findLatestTodos(sessionID) {
      let cursor
      do {
        const response = await context.client.message.list({
          sessionID,
          limit: 200,
          ...(cursor ? { cursor } : { order: "desc" }),
        })
        const found = latestTodos(response.data ?? [])
        if (found) return found
        cursor = response.cursor?.next ?? undefined
      } while (cursor)
      return null
    }

    /**
     * Refresh `homePlan()` from the server.  Throttled to one check per
     * 15 s unless forced, and never concurrent.
     * @param {boolean} [force]
     */
    async function refreshHomePlan(force = false) {
      if (homePlanBusy) return
      const now = Date.now()
      if (!force && now - homePlanCheckedAt < 15_000) return
      homePlanBusy = true
      homePlanCheckedAt = now
      try {
        const response = await context.client.session.list({
          limit: 8,
          order: "desc",
        })
        for (const session of response.data ?? []) {
          const todos = await findLatestTodos(session.id)
          if (todos?.length) {
            setHomePlan({
              todos,
              sessionID: session.id,
              title: session.title,
              updated: session.time?.updated,
            })
            return
          }
        }
        setHomePlan(null)
      } catch {
        // Server not ready yet; the next message event or route change
        // retries.
      } finally {
        homePlanBusy = false
      }
    }

    // -----------------------------------------------------------------
    // Row builders
    // -----------------------------------------------------------------

    /**
     * One rate-limit window: label line + bar line.
     * @param {string} label
     * @param {{ usedPercent?: number, resetsAt?: number | null, limit?: number, usedCredits?: number } | null | undefined} win
     */
    function windowRows(label, win) {
      if (!win || typeof win.usedPercent !== "number") return null
      const used = win.usedPercent
      return (
        <box flexDirection="column">
          <text fg={theme.text.subdued}>
            <span>{label}</span>
          </text>
          <box flexDirection="row" gap={1}>
            <text fg={usageColor(theme, used)}>
              <span>{bar(used)}</span>
            </text>
            <text fg={theme.text.default}>
              <span>{Math.round(used)}%</span>
            </text>
            <Show when={win.resetsAt}>
              <text fg={theme.text.subdued}>
                <span>· сброс {fmtReset(win.resetsAt)}</span>
              </text>
            </Show>
          </box>
          <Show when={win.limit != null && win.usedCredits != null}>
            <text fg={theme.text.subdued}>
              <span>
                {fmtK(win.usedCredits)} / {fmtK(win.limit)} исп.
              </span>
            </text>
          </Show>
        </box>
      )
    }

    /**
     * Collapsible section header (click to toggle).
     * @param {string} title
     * @param {boolean} expanded
     * @param {() => void} onToggle
     */
    function sectionHeader(title, expanded, onToggle) {
      return (
        <box
          flexDirection="row"
          gap={1}
          paddingX={1}
          onMouseDown={onToggle}
        >
          <text fg={theme.hue?.orange?.[400] ?? theme.text.default}>
            <span>{expanded ? "▾" : "▸"}</span>
          </text>
          <text fg={theme.text.default}>
            <span>{title}</span>
          </text>
        </box>
      )
    }

    /**
     * The "Лимиты" section body.
     * @param {object} data
     */
    function limitsBody(data) {
      const codex = data?.codex ?? { available: false }
      const qwen = data?.qwen ?? { available: false }
      const primaryLabel = codex.primary?.windowDurationMins
        ? `ChatGPT · окно ${fmtWindow(codex.primary.windowDurationMins)}`
        : "ChatGPT"
      return (
        <box flexDirection="column" paddingX={1} gap={1}>
          <Show
            when={codex.available}
            fallback={
              <text fg={theme.text.subdued}>
                <span>ChatGPT: {codexHint(codex)}</span>
              </text>
            }
          >
            {windowRows(primaryLabel, codex.primary)}
            <Show when={codex.secondary?.usedPercent != null}>
              {windowRows(
                codex.secondary?.windowDurationMins
                  ? `ChatGPT · окно ${fmtWindow(codex.secondary.windowDurationMins)}`
                  : "ChatGPT · доп. окно",
                codex.secondary,
              )}
            </Show>
          </Show>
          <Show
            when={qwen.available && qwen.state === "ok"}
            fallback={
              <text fg={theme.text.subdued}>
                <span>Alibaba: {qwenHint(qwen)}</span>
              </text>
            }
          >
            {windowRows("Alibaba · окно 5ч", qwen.fiveHour)}
            {windowRows("Alibaba · окно 7д", qwen.sevenDay)}
          </Show>
          {(() => {
            tick() // re-render every minute for the countdown
            const promo = getNightPromoStatus()
            return (
              <box flexDirection="column">
                <text
                  fg={
                    promo.active
                      ? theme.text.feedback.success.default
                      : theme.text.subdued
                  }
                >
                  <span>
                    {promo.active
                      ? `🌙 Ночная −50% активна · ещё ${fmtDur(promo.minutesToToggle)}`
                      : `☀ Ночная −50% · через ${fmtDur(promo.minutesToToggle)}`}
                  </span>
                </text>
                <text fg={theme.text.subdued}>
                  <span>22:00–08:00 Пекин · qwen3.8-max · ds-v4-pro</span>
                </text>
              </box>
            )
          })()}
        </box>
      )
    }

    /**
     * Collapsible "Лимиты" strip for the home screen.  Sessions render the
     * limits section inside the native sidebar below, preventing it from
     * covering the built-in Context/MCP panel.
     */
    function HomeLimitsStrip() {
      const [hover, setHover] = createSignal(false)
      const isHome = () => context.ui.router.current()?.type === "home"
      const expanded = () => state.home === true
      return (
        <Show when={isHome()}>
          <box
            position="absolute"
            top={0}
            right={0}
            height="100%"
            zIndex={1500}
            flexDirection="row"
          >
            <Show when={expanded()}>
              <box
                width={32}
                height="100%"
                border={["left"]}
                borderColor={theme.text.subdued}
                backgroundColor={theme.background.default}
                flexDirection="column"
                paddingTop={1}
              >
                {sectionHeader("Лимиты", true, () => toggle("home"))}
                {limitsBody(limits())}
              </box>
            </Show>
            <box
              width={2}
              height="100%"
              border={["left"]}
              borderColor={hover() ? theme.text.default : theme.text.subdued}
              backgroundColor={theme.background.default}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseDown={() => toggle("home")}
            >
              <text fg={hover() ? theme.text.default : theme.text.subdued}>
                <span>{expanded() ? "▸" : "◂"}</span>
              </text>
            </box>
          </box>
        </Show>
      )
    }

    /**
     * A handle for the native session sidebar.  It stays on the right edge
     * after the sidebar is hidden, so the same mouse target can restore it.
     */
    function SidebarToggleHandle() {
      const [hover, setHover] = createSignal(false)
      const isSession = () => context.ui.router.current()?.type === "session"
      return (
        <Show when={isSession()}>
          <box
            position="absolute"
            top={0}
            right={0}
            width={2}
            height="100%"
            zIndex={1500}
            border={["left"]}
            borderColor={hover() ? theme.text.default : theme.text.subdued}
            backgroundColor={theme.background.default}
            flexDirection="column"
            justifyContent="center"
            alignItems="center"
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseDown={toggleSidebar}
          >
            <text fg={hover() ? theme.text.default : theme.text.subdued}>
              <span>{sidebarCollapsed() ? "◂" : "▸"}</span>
            </text>
          </box>
        </Show>
      )
    }

    /**
     * Progress header + todo list + session footer, shared by every route
     * of the plan strip.  Standardized on the same `bar()` look as the
     * limits rows: green when everything is done, orange (the "in
     * progress" accent) otherwise.
     * @param {{ todos: { content: string, status?: string }[], title?: string, updated?: number } | null} plan
     */
    function planPanelBody(plan) {
      return (
        <box flexDirection="column" paddingX={1} gap={1}>
          <Show
            when={plan && plan.todos.length > 0}
            fallback={
              <text fg={theme.text.subdued}>
                <span>
                  Плана пока нет — он появится, когда модель запишет
                  todo-список.
                </span>
              </text>
            }
          >
            <box flexDirection="column" gap={1}>
              {(() => {
                const todos = plan.todos
                const completed = todos.filter(
                  (todo) => todo.status === "completed",
                ).length
                const percent = Math.round((completed / todos.length) * 100)
                const allDone = completed === todos.length
                return (
                  <box flexDirection="row" gap={1}>
                    <text
                      fg={
                        allDone
                          ? theme.text.feedback.success.default
                          : theme.hue?.orange?.[400] ?? theme.text.default
                      }
                    >
                      <span>{bar(percent)}</span>
                    </text>
                    <text fg={theme.text.default}>
                      <span>
                        {completed}/{todos.length}
                      </span>
                    </text>
                    <text fg={theme.text.subdued}>
                      <span>· {percent}%</span>
                    </text>
                  </box>
                )
              })()}
              {todoRows(plan.todos)}
              <Show when={plan.title || plan.updated}>
                <text fg={theme.text.subdued}>
                  <span>
                    {plan.title || "Сессия без названия"}
                    {plan.updated ? ` · ${fmtWhen(plan.updated)}` : ""}
                  </span>
                </text>
              </Show>
            </box>
          </Show>
        </box>
      )
    }

    /**
     * Plan body bound to one session: the reactive message cache first,
     * older pages as a fallback so long sessions keep their last plan.
     * Re-reads whenever message content changes.
     */
    function SessionPlan(props) {
      const [historicalTodos, setHistoricalTodos] = createSignal([])

      onMount(() => {
        context.data.session.message
          .sync(props.sessionID)
          .then(() => setPlanVersion((version) => version + 1))
          .catch(() => {})

        findLatestTodos(props.sessionID)
          .then((found) => {
            if (found) setHistoricalTodos(found)
          })
          .catch(() => {})
      })

      const plan = () => {
        planVersion() // re-read the reactive cache on message updates
        const todos =
          latestTodos(context.data.session.message.list(props.sessionID)) ??
          historicalTodos()
        let info
        try {
          info = context.data.session.get(props.sessionID)
        } catch {
          info = null
        }
        return {
          todos: todos ?? [],
          title: info?.title,
          updated: info?.time?.updated,
        }
      }

      return planPanelBody(plan())
    }

    /** Reactive wrapper over the latest-plan-across-sessions data (home). */
    function HomePlanBody() {
      return planPanelBody(homePlan())
    }

    /**
     * Re-check the latest plan across sessions while the start screen is
     * visible: once on mount, then on every message-content event
     * (throttled inside refreshHomePlan).
     */
    function HomePlanRefresh() {
      let first = true
      createEffect(() => {
        planVersion() // re-run whenever message content changes
        refreshHomePlan(first)
        first = false
      })
      return null
    }

    /**
     * Collapsible "План" strip pinned to the LEFT edge of every screen —
     * the mirror of HomeLimitsStrip, and bound to the current dialog:
     * in a session it shows that session's latest plan, on the start
     * screen the plan of the most recently updated session.  ▸ while
     * collapsed, ◂ while expanded.  Starts collapsed on launch, like its
     * right-edge sibling.
     */
    function PlanStrip() {
      const [hover, setHover] = createSignal(false)
      const sessionID = () => {
        const route = context.ui.router.current()
        return route?.type === "session" ? route.sessionID : null
      }
      const expanded = () => state.plan === true
      return (
        <box
          position="absolute"
          top={0}
          left={0}
          height="100%"
          zIndex={1500}
          flexDirection="row"
        >
          <Show when={!sessionID()}>
            <HomePlanRefresh />
          </Show>
          <box
            width={2}
            height="100%"
            border={["right"]}
            borderColor={hover() ? theme.text.default : theme.text.subdued}
            backgroundColor={theme.background.default}
            flexDirection="column"
            justifyContent="center"
            alignItems="center"
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseDown={() => {
              if (!sessionID()) refreshHomePlan()
              toggle("plan")
            }}
          >
            <text fg={hover() ? theme.text.default : theme.text.subdued}>
              <span>{expanded() ? "◂" : "▸"}</span>
            </text>
          </box>
          <Show when={expanded()}>
            <box
              width={34}
              height="100%"
              border={["right"]}
              borderColor={theme.text.subdued}
              backgroundColor={theme.background.default}
              flexDirection="column"
              paddingTop={1}
            >
              {sectionHeader("План", true, () => toggle("plan"))}
              <Show when={sessionID()} keyed fallback={<HomePlanBody />}>
                {(id) => <SessionPlan sessionID={id} />}
              </Show>
            </box>
          </Show>
        </box>
      )
    }

    /**
     * One row per todo item, shared by every plan view.
     * @param {{ content: string, status?: string, priority?: string }[]} todos
     */
    function todoRows(todos) {
      return todos.map((todo) => {
        const done = todo.status === "completed"
        const active = todo.status === "in_progress"
        return (
          <box flexDirection="row" gap={1}>
            <text
              fg={
                active
                  ? theme.hue?.orange?.[400] ?? theme.text.default
                  : done
                    ? theme.text.feedback.success.default
                    : theme.text.subdued
              }
            >
              <span>{done ? "✓" : active ? "●" : "○"}</span>
            </text>
            <text fg={done ? theme.text.subdued : theme.text.default}>
              <span>{todo.content}</span>
            </text>
          </box>
        )
      })
    }

    // -----------------------------------------------------------------
    // Slots
    // -----------------------------------------------------------------

    // `keymap.layer()` may only be created inside a rendered component, so
    // the toggle commands live in an always-mounted headless `app` slot.
    const unkeys = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 50,
          commands: [
            {
              id: "custom.panels.limits-toggle",
              title: "Панель лимитов: показать/скрыть",
              group: "Панели",
              bind: "ctrl+alt+l",
              palette: true,
              // Keep the home and session edge-panel state independent.
              run: () => {
                const route = context.ui.router.current()
                toggle(route?.type === "home" ? "home" : "limits")
              },
            },
            {
              id: "custom.panels.plan-toggle",
              title: "Панель плана: показать/скрыть",
              group: "Панели",
              bind: "ctrl+alt+t",
              palette: true,
              run: () => toggle("plan"),
            },
          ],
        }))
        return [<SidebarToggleHandle />, <HomeLimitsStrip />, <PlanStrip />]
      },
    })

    // Session routes already own the right sidebar.  Add limits to that
    // layout-managed slot instead of placing a second panel over it.
    const unclaim = context.ui.slot({
      prepend: "sidebar.content",
      render: () => (
        <box flexDirection="column" gap={1} paddingTop={1}>
          {sectionHeader("Лимиты", state.limits, () => toggle("limits"))}
          <Show when={state.limits}>{limitsBody(limits())}</Show>
        </box>
      ),
    })

    return () => {
      unkeys()
      unclaim()
      unsub?.()
      unmessage?.()
      renderer.removePostProcessFn?.(hideCursorUnderStrip)
      clearInterval(ticker)
      stopAutoRefresh()
    }
  },
})
