/** @jsxImportSource @opentui/solid */
/**
 * Limits panel and todo-plan strip for the OpenCode TUI.
 *
 * Adds two independently hideable edge panels:
 *   - Лимиты: ChatGPT + Alibaba rate-limit windows on the right edge of every
 *     route
 *   - План: a collapsible strip on the LEFT edge, present on every screen
 *     and bound to the current dialog.  In a session it shows that
 *     session's latest legacy todowrite plan or the native V2 plan document;
 *     on the start screen it shows the latest available plan.  Progress bar
 *     (completed/total, percent) + task list + session/document footer.
 *
 * Each custom edge strip is a thin bar with a chevron (the panel opens away
 * from the edge); both start collapsed on every launch.  The pin icon switches
 * an expanded panel between an overlay and a normal flex-layout dock.  Toggle
 * visibility with an edge handle or the "Панели" commands in the palette
 * (ctrl+alt+l toggles the limits panel, ctrl+alt+t the plan strip).  The
 * native session sidebar remains separate and uses the built-in
 * `session.sidebar.toggle` command (<leader>b).
 *
 * NOTE: TUI plugins that contain JSX must use the `.jsx`/`.tsx` extension,
 * and `context.keymap.layer()` may only be called inside a rendered
 * component (a slot/dialog render), never directly in `setup()`.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onMount, Show } from "solid-js"
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

const V2_PLAN_DIRECTORY = join(homedir(), ".opencode", "plan")

/**
 * Parse the common checklist form used by Markdown plan documents. Plain
 * bullet lines are accepted as pending tasks when a document has no checks.
 * @param {string} text
 * @param {string} fallbackTitle
 * @returns {{ todos: { content: string, status?: string }[], title: string }}
 */
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
        status: marker === "x" ? "completed" : marker === ">" || marker === "~" || marker === "-" ? "in_progress" : "pending",
      })
      continue
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)
    if (bullet && !/^\[[ xX>~-]\]/.test(bullet[1])) {
      bulletTodos.push({ content: bullet[1], status: "pending" })
    }
  }
  return { todos: checkedTodos.length ? checkedTodos : bulletTodos, title: title || fallbackTitle }
}

/**
 * Read the newest native V2 plan document. V2 does not emit a todowrite tool
 * part, and its plan files are global rather than tied to a session ID.
 * @returns {Promise<{ todos: { content: string, status?: string }[], title?: string, updated?: number } | null>}
 */
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
      if (parsed.todos.length) return { ...parsed, updated: candidate.updated }
    } catch {}
  }
  return null
}

/**
 * Return the latest valid legacy todo list written by the model in this session.
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
    // Persistent visibility/pin state.  Edge strips start collapsed on every
    // launch, while pin choices remain stable between TUI restarts.
    const [state, updateState] = context.storage.store("limits-panels.state", {
      initial: {
        plan: false,
        home: false,
        planPinned: false,
        homePinned: false,
      },
    })

    // The edge strips must greet every launch collapsed, so drop any
    // "expanded" value persisted by the previous run.
    if (state.home === true || state.plan === true) {
      updateState((draft) => {
        draft.home = false
        draft.plan = false
      })
    }

    /** @param {"plan" | "home"} which */
    function toggle(which) {
      updateState((draft) => {
        draft[which] = !state[which]
      })
    }

    /** @param {"plan" | "home" | "sidebar"} which */
    function togglePin(which) {
      const key = `${which}Pinned`
      updateState((draft) => {
        draft[key] = !state[key]
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
    const HANDLE_COLS = 2
    const PLAN_PANEL_COLS = 34
    const HOME_PANEL_COLS = 32
    const PLAN_STRIP_COLS = HANDLE_COLS + PLAN_PANEL_COLS
    const HOME_STRIP_COLS = HANDLE_COLS + HOME_PANEL_COLS
    const renderer = context.renderer
    let planNode = null
    let dockTarget = null
    let dockRetry = null
    let appliedDock = { left: null, right: null }

    // The native `app` slot is rendered after the route, so a relative panel
    // would occupy a row below the interface.  Instead, keep the panel in the
    // overlay layer and inset the route's large layout container when pinned.
    function findDockTarget() {
      let parent = planNode?.parent
      while (parent) {
        const height = Number(renderer.height ?? 0)
        const candidates = (parent.getChildren?.() ?? [])
          .filter((child) => child !== planNode && child.getChildrenCount?.() > 0)
          .filter((child) => !height || Number(child.height ?? 0) >= height / 2)
          .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0))
        if (candidates.length) return candidates[0]
        parent = parent.parent
      }
      return null
    }

    function syncDockLayout() {
      const target = findDockTarget()
      if (!target) {
        if (!dockRetry) {
          dockRetry = setTimeout(() => {
            dockRetry = null
            syncDockLayout()
          }, 50)
        }
        return
      }
      if (dockTarget && dockTarget !== target) {
        dockTarget.paddingLeft = 0
        dockTarget.paddingRight = 0
      }
      if (dockTarget !== target) appliedDock = { left: null, right: null }
      dockTarget = target
      const left = state.planPinned === true
        ? (state.plan === true ? PLAN_STRIP_COLS : HANDLE_COLS)
        : 0
      const right = state.homePinned === true
        ? (state.home === true ? HOME_STRIP_COLS : HANDLE_COLS)
        : 0
      if (appliedDock.left !== left) {
        target.paddingLeft = left
        appliedDock.left = left
      }
      if (appliedDock.right !== right) {
        target.paddingRight = right
        appliedDock.right = right
      }
    }

    function scheduleDockLayout() {
      queueMicrotask(syncDockLayout)
    }
    /** @param {number} x 1-based cursor column */
    function cursorUnderStrip(x) {
      if (state.plan === true && state.planPinned !== true && x <= PLAN_STRIP_COLS) return true
      if (
        state.home === true &&
        state.homePinned !== true &&
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
    // Start-screen plan data (latest legacy todo plan or native V2 document)
    // -----------------------------------------------------------------

    /**
     * Latest plan found in the most recently updated sessions, plus the
     * session it belongs to.  `null` means "no plan anywhere yet".
     * @type {import("solid-js").Signal<
     *   { todos: { content: string, status?: string }[], sessionID: string | null,
     *     title?: string, updated?: number } | null>}
     */
    const [homePlan, setHomePlan] = createSignal(null)
    const [documentPlan, setDocumentPlan] = createSignal(null)
    let documentPlanPromise = null

    async function refreshDocumentPlan() {
      if (documentPlanPromise) return documentPlanPromise
      documentPlanPromise = readLatestV2Plan()
        .then((found) => {
          setDocumentPlan(found)
          setPlanVersion((version) => version + 1)
          return found
        })
        .finally(() => {
          documentPlanPromise = null
        })
      return documentPlanPromise
    }

    refreshDocumentPlan().catch(() => {})
    const unmessage = context.data.on("session.message.content.updated", () => {
      setPlanVersion((version) => version + 1)
      refreshDocumentPlan().catch(() => {})
    })
    let homePlanBusy = false
    let homePlanCheckedAt = 0

    /**
     * Walk a session's message pages (newest first) until the most recent
     * legacy todowrite plan is found.
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
        const nativePlan = await refreshDocumentPlan()
        if (nativePlan?.todos?.length) {
          setHomePlan({ ...nativePlan, sessionID: null })
          return
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
     * Shared panel/section header.  Limits deliberately use a static label;
     * the edge handle remains the only visibility control for that panel.
     * @param {string} title
     * @param {boolean} expanded
     * @param {() => void} onToggle
     * @param {{ collapsible?: boolean, pinned?: boolean, onPin?: () => void }} options
     */
    function sectionHeader(title, expanded, onToggle, options = {}) {
      const collapsible = options.collapsible !== false
      return (
        <box
          flexDirection="row"
          justifyContent="space-between"
          width="100%"
        >
          <box
            flexDirection="row"
            gap={1}
            paddingX={1}
            onMouseDown={collapsible ? onToggle : undefined}
          >
            <Show when={collapsible}>
              <text fg={theme.hue?.orange?.[400] ?? theme.text.default}>
                <span>{expanded ? "▾" : "▸"}</span>
              </text>
            </Show>
            <text fg={theme.text.default}>
              <span>{title}</span>
            </text>
          </box>
          <Show when={Boolean(options.onPin)}>
            <box
              width={3}
              paddingRight={1}
              onMouseDown={(event) => {
                event?.stopPropagation?.()
                options.onPin?.()
              }}
            >
              <text fg={options.pinned ? theme.hue?.orange?.[400] ?? theme.text.default : theme.text.subdued}>
                <span>📌</span>
              </text>
            </box>
          </Show>
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
        <box flexDirection="column" width="100%" paddingX={1} gap={1}>
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
                  flexShrink={0}
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
     * Shared edge-panel shell.  Home limits and the plan use the same handle,
     * pin control and overlay/dock behavior; only their body and direction
     * differ.
     * @param {{
     *   side: "left" | "right",
     *   visible?: () => boolean,
     *   expanded: () => boolean,
     *   pinned: () => boolean,
     *   layoutKey?: () => unknown,
     *   panelWidth: number,
     *   title: string,
     *   collapsible?: boolean,
     *   onToggle: () => void,
     *   onPin: () => void,
     *   onNode?: (node: object) => void,
     *   before?: () => unknown,
     *   body: () => unknown,
     * }} props
     */
    function EdgePanel(props) {
      const [hover, setHover] = createSignal(false)
      const isLeft = () => props.side === "left"
      const expanded = () => props.expanded() === true
      const pinned = () => props.pinned() === true
      createEffect(() => {
        props.visible?.()
        expanded()
        pinned()
        props.layoutKey?.()
        scheduleDockLayout()
      })
      return (
        <Show when={props.visible ? props.visible() : true}>
          <box
            ref={(node) => {
              props.onNode?.(node)
              scheduleDockLayout()
            }}
            position="absolute"
            top={0}
            left={isLeft() ? 0 : undefined}
            right={isLeft() ? undefined : 0}
            width={expanded() ? HANDLE_COLS + props.panelWidth : HANDLE_COLS}
            height="100%"
            flexShrink={0}
            zIndex={pinned() ? 0 : 1500}
            flexDirection="row"
          >
            {props.before?.()}
            <Show when={expanded()}>
              <box
                width={props.panelWidth}
                height="100%"
                border={[isLeft() ? "right" : "left"]}
                borderColor={theme.text.subdued}
                backgroundColor={theme.background.default}
                flexDirection="column"
                paddingTop={1}
              >
                {sectionHeader(props.title, expanded(), props.onToggle, {
                  collapsible: props.collapsible,
                  pinned: pinned(),
                  onPin: props.onPin,
                })}
                {props.body()}
              </box>
            </Show>
            <box
              width={HANDLE_COLS}
              height="100%"
              border={[isLeft() ? "right" : "left"]}
              borderColor={hover() ? theme.text.default : theme.text.subdued}
              backgroundColor={theme.background.default}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseDown={props.onToggle}
            >
              <text fg={hover() ? theme.text.default : theme.text.subdued}>
                <span>
                  {isLeft()
                    ? expanded()
                      ? "◂"
                      : "▸"
                    : expanded()
                      ? "▸"
                      : "◂"}
                </span>
              </text>
            </box>
          </box>
        </Show>
      )
    }

    /** "Лимиты" strip shared by the home and session routes. */
    function LimitsStrip() {
      return (
        <EdgePanel
          side="right"
          expanded={() => state.home === true}
          pinned={() => state.homePinned === true}
          panelWidth={HOME_PANEL_COLS}
          title="Лимиты"
          collapsible={false}
          onToggle={() => toggle("home")}
          onPin={() => togglePin("home")}
          body={() => limitsBody(limits())}
        />
      )
    }

    /**
     * Progress header + task list + session/document footer, shared by every route
     * of the plan strip.  Standardized on the same `bar()` look as the
     * limits rows: green when everything is done, orange (the "in
     * progress" accent) otherwise.
     * @param {{ todos: { content: string, status?: string }[], title?: string, updated?: number } | null} plan
     */
    function planPanelBody(plan) {
      return (
        <box flexDirection="column" width="100%" paddingX={1} gap={1}>
          <Show
            when={plan && plan.todos.length > 0}
            fallback={
              <text fg={theme.text.subdued} wrapMode="word" flexShrink={1} minWidth={0}>
                <span>
                  Плана пока нет — он появится, когда модель запишет
                  todo-список или V2 plan document.
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
                  <box flexDirection="row" gap={1} width="100%" flexShrink={0}>
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
                <text fg={theme.text.subdued} wrapMode="word" flexShrink={1}>
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

        refreshDocumentPlan().catch(() => {})
      })

      const plan = () => {
        planVersion() // re-read the reactive cache on message updates
        const cachedTodos = latestTodos(context.data.session.message.list(props.sessionID))
        const historical = historicalTodos()
        const todos = cachedTodos?.length
          ? cachedTodos
          : historical.length
            ? historical
            : documentPlan()?.todos
        let info
        try {
          info = context.data.session.get(props.sessionID)
        } catch {
          info = null
        }
        return {
          todos: todos ?? [],
          title: info?.title || documentPlan()?.title,
          updated: info?.time?.updated || documentPlan()?.updated,
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

    /** "План" strip bound to the current dialog or latest home plan. */
    function PlanStrip() {
      const sessionID = () => {
        const route = context.ui.router.current()
        return route?.type === "session" ? route.sessionID : null
      }
      return (
        <EdgePanel
          side="left"
          expanded={() => state.plan === true}
          pinned={() => state.planPinned === true}
          layoutKey={() => `${sessionID()}-${state.home}-${state.homePinned}`}
          panelWidth={PLAN_PANEL_COLS}
          title="План"
          onToggle={() => {
            if (!sessionID()) refreshHomePlan()
            toggle("plan")
          }}
          onPin={() => togglePin("plan")}
          onNode={(node) => {
            planNode = node
          }}
          before={() => (
            <Show when={!sessionID()}>
              <HomePlanRefresh />
            </Show>
          )}
          body={() => (
            <scrollbox
              flexGrow={1}
              minHeight={0}
              width="100%"
              scrollY={true}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.background.default,
                  foregroundColor: theme.hue?.orange?.[400] ?? theme.text.subdued,
                },
              }}
            >
              <Show when={sessionID()} keyed fallback={<HomePlanBody />}>
                {(id) => <SessionPlan sessionID={id} />}
              </Show>
            </scrollbox>
          )}
        />
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
          <box flexDirection="row" gap={1} width="100%" flexShrink={0}>
            <text
              width={1}
              flexShrink={0}
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
            <text
              fg={done ? theme.text.subdued : theme.text.default}
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              wrapMode="word"
            >
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
              run: () => toggle("home"),
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
        return [<LimitsStrip />, <PlanStrip />]
      },
    })

    return () => {
      unkeys()
      unsub?.()
      unmessage?.()
      renderer.removePostProcessFn?.(hideCursorUnderStrip)
      if (dockRetry) clearTimeout(dockRetry)
      if (dockTarget) {
        dockTarget.paddingLeft = 0
        dockTarget.paddingRight = 0
      }
      clearInterval(ticker)
      stopAutoRefresh()
    }
  },
})
