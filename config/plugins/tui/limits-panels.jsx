/** @jsxImportSource @opentui/solid */
/**
 * Limits sidebar section and model todo-plan column for the OpenCode TUI.
 *
 * Adds two independently hideable areas:
 *   - Лимиты: ChatGPT + Alibaba rate-limit windows in the session sidebar
 *   - План:   the latest todowrite plan in a separate column to its right
 *
 * Each section collapses toward the sidebar edge; the collapsed/expanded
 * state persists across restarts.  Toggle with a header click (mouse) or
 * the "Панели" commands in the palette (ctrl+alt+l / ctrl+alt+t).
 * The whole sidebar can additionally be hidden with the built-in
 * `session.sidebar.toggle` command (<leader>b).
 *
 * NOTE: TUI plugins that contain JSX must use the `.jsx`/`.tsx` extension,
 * and `context.keymap.layer()` may only be called inside a rendered
 * component (a slot/dialog render), never directly in `setup()`.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { Portal } from "@opentui/solid"
import { createSignal, onMount, Show } from "solid-js"
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
    const [planMount, setPlanMount] = createSignal(null)
    const unmessage = context.data.on("session.message.content.updated", () => {
      setPlanVersion((version) => version + 1)
    })

    // Persistent collapse state.
    const [state, updateState] = context.storage.store("limits-panels.state", {
      initial: { limits: true, plan: true },
    })

    /** @param {"limits" | "plan"} which */
    function toggle(which) {
      updateState((draft) => {
        draft[which] = !state[which]
      })
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

    /** @param {{ content: string, status?: string, priority?: string }[]} todos */
    function planBody(todos) {
      const completed = todos.filter((todo) => todo.status === "completed").length
      return (
        <box flexDirection="column" paddingX={1} gap={1}>
          <Show
            when={todos.length > 0}
            fallback={
              <text fg={theme.text.subdued}>
                <span>Модель пока не создала todo-план.</span>
              </text>
            }
          >
            <text fg={theme.text.subdued}>
              <span>{completed} из {todos.length} выполнено</span>
            </text>
            {todos.map((todo) => {
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
            })}
          </Show>
        </box>
      )
    }

    // The public sidebar slot is inside a scroll box. Capture its nearest
    // full-width row once; the persistent app-slot owner can keep using that
    // row after the stock sidebar is hidden.
    function LayoutProbe() {
      let anchor

      onMount(() => {
        let node = anchor?.parent
        while (node) {
          if (
            node.primaryAxis === "row" &&
            typeof node.width === "number" &&
            node.width >= context.renderer.width * 0.75
          ) {
            setPlanMount(node)
            break
          }
          node = node.parent
        }
      })

      return <box ref={anchor} width={0} height={0} />
    }

    function PlanColumn(props) {
      const [historicalTodos, setHistoricalTodos] = createSignal([])

      onMount(() => {
        context.data.session.message
          .sync(props.sessionID)
          .then(() => setPlanVersion((version) => version + 1))
          .catch(() => {})

        // The reactive cache is page-sized. Walk older pages until the most
        // recent todowrite is found so long sessions keep their last plan.
        const loadHistoricalTodos = async () => {
          let cursor
          do {
            const response = await context.client.message.list({
              sessionID: props.sessionID,
              limit: 200,
              ...(cursor ? { cursor } : { order: "desc" }),
            })
            const found = latestTodos(response.data ?? [])
            if (found) {
              setHistoricalTodos(found)
              return
            }
            cursor = response.cursor?.next ?? undefined
          } while (cursor)
        }
        loadHistoricalTodos().catch(() => {})
      })

      const todos = () => {
        planVersion()
        return (
          latestTodos(context.data.session.message.list(props.sessionID)) ??
          historicalTodos()
        )
      }

      return (
        <Show when={state.plan && props.mount}>
          {(target) => (
            <Portal mount={target()}>
              <box
                width={42}
                height="100%"
                border={["left"]}
                borderColor={theme.text.subdued}
                backgroundColor={theme.background.default}
                flexDirection="column"
                paddingTop={1}
              >
                {sectionHeader("План", true, () => toggle("plan"))}
                {planBody(todos())}
              </box>
            </Portal>
          )}
        </Show>
      )
    }

    function PersistentPlan() {
      const sessionID = () => {
        const route = context.ui.router.current()
        return route.type === "session" ? route.sessionID : null
      }

      return (
        <Show when={sessionID()} keyed>
          {(id) => <PlanColumn sessionID={id} mount={planMount()} />}
        </Show>
      )
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
              run: () => toggle("limits"),
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
        return <PersistentPlan />
      },
    })

    // Limits stay in the stock sidebar; the plan portals into a sibling column.
    const unclaim = context.ui.slot({
      prepend: "sidebar.content",
      render: () => {
        const data = limits()
        return (
          <box flexDirection="column" gap={1} paddingTop={1}>
            <box flexDirection="column" gap={1}>
              {sectionHeader("Лимиты", state.limits, () => toggle("limits"))}
              <Show when={state.limits}>{limitsBody(data)}</Show>
            </box>
            <LayoutProbe />
          </box>
        )
      },
    })

    return () => {
      unkeys()
      unclaim()
      unsub?.()
      unmessage?.()
      clearInterval(ticker)
      stopAutoRefresh()
    }
  },
})
