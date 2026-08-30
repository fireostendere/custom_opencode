/**
 * Limits header plugin for OpenCode TUI.
 *
 * Prepends a full-width status bar to the `app` slot showing ChatGPT and
 * Alibaba Cloud rate-limit snapshots.  Data is refreshed periodically
 * through the local limits-helper module.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, onMount } from "solid-js"
import {
  getLimits,
  getLimitsSync,
  onLimitsChange,
  startAutoRefresh,
  stopAutoRefresh,
} from "./limits-helper.js"

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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "custom.limits-header",
  setup(context) {
    // Start the background refresh.
    startAutoRefresh()

    // Reactive limits snapshot.
    const [limits, setLimits] = createSignal(getLimitsSync())

    // Subscribe to cache updates.
    let unsub
    onMount(() => {
      unsub = onLimitsChange(() => setLimits(getLimitsSync()))
      // Trigger an immediate async refresh.
      getLimits().then((data) => setLimits(data))
    })
    onCleanup(() => {
      unsub?.()
      stopAutoRefresh()
    })

    const unclaim = context.ui.slot({
      prepend: "app",
      render: () => {
        const data = limits()
        const codex = data?.codex ?? { available: false }
        const qwen = data?.qwen ?? { available: false }

        return (
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
          </box>
        )
      },
    })

    return () => {
      unclaim()
      stopAutoRefresh()
    }
  },
})