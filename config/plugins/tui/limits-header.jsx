/** @jsxImportSource @opentui/solid */
/**
 * Limits header plugin for OpenCode TUI.
 *
 * Prepends a full-width status bar to the `app` slot showing ChatGPT and
 * Alibaba Cloud rate-limit snapshots.  Data is refreshed periodically
 * through the local limits-helper module.
 *
 * NOTE: TUI plugins that contain JSX must use the `.jsx`/`.tsx` extension;
 * the loader does not parse JSX inside plain `.js` files.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { Portal } from "@opentui/solid"
import { createSignal } from "solid-js"
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

/**
 * Format a percentage value for display.
 * @param {number | undefined} pct
 * @returns {string}
 */
function pct(pct) {
  if (pct == null) return "—"
  return `${Math.round(pct)}%`
}

/**
 * Format a timestamp as a short human-readable string.
 * @param {number | undefined} ts  Unix seconds
 * @returns {string}
 */
function resetAt(ts) {
  if (!ts) return ""
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = d.getTime() - now
  if (diff < 0) return "now"
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/**
 * Build a short label for the codex tier.
 * @param {object} codex
 * @returns {string}
 */
function codexLabel(codex) {
  if (!codex.available) return "ChatGPT: —"
  const primary = codex.primary
  const secondary = codex.secondary
  const parts = [`ChatGPT: ${pct(primary?.remainingPercent)}`]
  if (secondary?.remainingPercent != null) {
    parts.push(`/ ${pct(secondary.remainingPercent)}`)
  }
  if (primary?.resetsAt) {
    parts.push(` (reset ${resetAt(primary.resetsAt)})`)
  }
  return parts.join("")
}

/**
 * Build a short label for the Qwen / Alibaba tier.
 * @param {object} qwen
 * @returns {string}
 */
function qwenLabel(qwen) {
  if (!qwen.available) return "Alibaba: —"
  const parts = []
  if (qwen.fiveHour) {
    parts.push(
      `Alibaba: ${pct(qwen.fiveHour.remainingPercent)}`,
    )
    if (qwen.fiveHour.resetsAt) {
      parts.push(` (reset ${resetAt(qwen.fiveHour.resetsAt)})`)
    }
  }
  if (qwen.sevenDay) {
    parts.push(` · 7d: ${pct(qwen.sevenDay.remainingPercent)}`)
    if (qwen.sevenDay.resetsAt) {
      parts.push(` (reset ${resetAt(qwen.sevenDay.resetsAt)})`)
    }
  }
  return parts.join("")
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
 * Short badge for the Alibaba "Night Plan" promo (−50% 22:00–08:00 Beijing).
 * @param {{ active: boolean, minutesToToggle: number }} promo
 * @returns {string}
 */
function nightBadge(promo) {
  return promo.active
    ? `🌙 −50% ещё ${fmtDur(promo.minutesToToggle)}`
    : `☀ −50% через ${fmtDur(promo.minutesToToggle)}`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "custom.limits-header",
  setup(context) {
    // Start the background refresh (idempotent inside the helper).
    startAutoRefresh()

    // Reactive limits snapshot.  `setup()` is not a Solid component owner,
    // so subscribe directly and tear down via the returned cleanup instead
    // of onMount/onCleanup.
    const [limits, setLimits] = createSignal(getLimitsSync())
    const unsub = onLimitsChange(() => setLimits(getLimitsSync()))
    getLimits()
      .then((data) => setLimits(data))
      .catch(() => {})

    // Minute tick keeps the promo countdown fresh between limit refreshes.
    const [tick, setTick] = createSignal(0)
    const ticker = setInterval(() => setTick((t) => t + 1), 60_000)
    ticker.unref?.()

    const unclaim = context.ui.slot({
      prepend: "app",
      render: () => {
        tick() // re-render every minute for the promo countdown
        const data = limits()
        const codex = data?.codex ?? { available: false }
        const qwen = data?.qwen ?? { available: false }
        const promo = getNightPromoStatus()

        return (
          <Portal
            mount={context.renderer.root}
            ref={(container) => {
              // Portal appends by default; move its wrapper above the app.
              context.renderer.root.remove(container)
              context.renderer.root.add(container, 0)
            }}
          >
            <box
              width="100%"
              height={1}
              backgroundColor={context.theme.background.surface.offset}
              flexDirection="row"
              paddingX={1}
              gap={2}
            >
              <text fg={context.theme.text.subdued}>
                <span>{codexLabel(codex)}</span>
              </text>
              <text fg={context.theme.text.subdued}>
                <span>{qwenLabel(qwen)}</span>
              </text>
              <text
                fg={
                  promo.active
                    ? context.theme.text.feedback.success.default
                    : context.theme.text.subdued
                }
              >
                <span>{nightBadge(promo)}</span>
              </text>
            </box>
          </Portal>
        )
      },
    })

    return () => {
      unsub?.()
      unclaim()
      clearInterval(ticker)
      stopAutoRefresh()
    }
  },
})
