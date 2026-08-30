/**
 * Self-contained limits helper for the OpenCode TUI.
 *
 * Queries `codex` (ChatGPT) and `bl` (Alibaba Cloud) CLI tools directly
 * — no Python dependency.  Results are cached for 60 seconds.
 */
import { spawn, execSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QWEN_FIVE_HOUR_LIMIT = 12_000
const QWEN_SEVEN_DAY_LIMIT = 40_000
const CACHE_TTL = 60_000 // 1 minute
const REFRESH_INTERVAL = 120_000 // 2 minutes

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a binary path.  Checks the environment variable, then `which`.
 * @param {string} envName - e.g. "CODEX_BIN"
 * @param {string} exeName - e.g. "codex"
 * @returns {string | null}
 */
function resolveBinary(envName, exeName) {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  try {
    return execSync(`which ${exeName}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT) rate limits via JSON-RPC over stdin/stdout
// ---------------------------------------------------------------------------

/**
 * Read JSON-RPC responses from the child process, filtering by id.
 * Returns the `result` field of the matching response.
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} expectedId
 * @param {number} timeout
 * @returns {Promise<object>}
 */
function readJsonRpc(child, expectedId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout"))
    }, timeout)

    /** @type {string} */
    let buffer = ""

    /** Process any complete lines currently in the buffer. */
    function processBuffer() {
      let idx = buffer.indexOf("\n")
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        try {
          const parsed = JSON.parse(line)
          if (parsed.id === expectedId) {
            clearTimeout(timer)
            if (parsed.error) {
              reject(new Error(parsed.error.message || "Codex RPC error"))
            } else {
              resolve(parsed.result !== undefined ? parsed.result : parsed)
            }
            return
          }
        } catch {
          // Skip non-JSON or garbage lines.
        }
        idx = buffer.indexOf("\n")
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk
      processBuffer()
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      reject(new Error(`Codex exited ${code}`))
    })
  })
}

/**
 * Query codex app-server for rate limits.
 * @param {string} binary - path to the codex binary
 * @returns {Promise<object>}
 */
async function queryCodex(binary) {
  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  })

  try {
    // --- initialize ---------------------------------------------------------
    child.stdin.write(
      JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "custom_opencode_tui",
            title: "custom_opencode TUI limits",
            version: "1",
          },
        },
      }) + "\n",
    )
    await readJsonRpc(child, 1, 5000)

    // --- initialized notification ------------------------------------------
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    )

    // --- account/rateLimits/read -------------------------------------------
    child.stdin.write(
      JSON.stringify({
        method: "account/rateLimits/read",
        id: 2,
        params: {},
      }) + "\n",
    )
    const result = await readJsonRpc(child, 2, 10000)
    return normalizeCodexResult(result)
  } catch {
    return { available: false, reason: "codex-rate-limits-unavailable" }
  } finally {
    try {
      child.kill()
    } catch {
      // Already dead.
    }
  }
}

/**
 * Normalize the raw codex rate-limits response.
 * @param {object} result
 * @returns {object}
 */
function normalizeCodexResult(result) {
  if (!result || typeof result !== "object")
    return { available: false, reason: "invalid-response" }

  const byId = result.rateLimitsByLimitId || {}
  let snapshot = byId.codex
  if (!snapshot && Object.keys(byId).length > 0)
    snapshot = Object.values(byId)[0]
  if (!snapshot) snapshot = result.rateLimits
  if (!snapshot || typeof snapshot !== "object")
    return { available: false, reason: "no-rate-limit-snapshot" }

  return {
    available: true,
    planType: snapshot.planType || undefined,
    limitId: snapshot.limitId || "codex",
    limitName: snapshot.limitName || "Codex",
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    credits: snapshot.credits ? snapshot.credits : undefined,
    rateLimitReachedType: snapshot.rateLimitReachedType || undefined,
    spendControlReached: snapshot.spendControlReached || undefined,
  }
}

/**
 * Normalize a rate-limit window object.
 * @param {object | undefined} window
 * @returns {object | null}
 */
function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null
  const used = window.usedPercent
  if (typeof used !== "number") return null
  const usedPercent = Math.min(100, Math.max(0, Math.round(used)))
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins:
      typeof window.windowDurationMins === "number"
        ? window.windowDurationMins
        : null,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  }
}

// ---------------------------------------------------------------------------
// Bailian (Alibaba Cloud) usage via `bl` CLI
// ---------------------------------------------------------------------------

/**
 * Query bailian CLI for token-plan usage.
 * @param {string} binary - path to the bl binary
 * @returns {Promise<object>}
 */
async function queryBailian(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ["usage", "token-plan", "--output", "json"], {
      stdio: ["ignore", "pipe", "ignore"],
    })

    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))

    child.on("error", () => {
      resolve({ available: false, reason: "bailian-cli-unavailable" })
    })

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ available: false, reason: "bailian-cli-error" })
        return
      }
      try {
        const payload = JSON.parse(stdout.trim())
        if (!payload || typeof payload !== "object") {
          resolve({ available: false, reason: "invalid-response" })
          return
        }
        resolve(normalizeBailianResult(payload))
      } catch {
        resolve({ available: false, reason: "invalid-json" })
      }
    })
  })
}

/**
 * Normalize the bailian token-plan usage response.
 * @param {object} payload
 * @returns {object}
 */
function normalizeBailianResult(payload) {
  const fiveHour = bailianWindow(
    payload.per5HourPercentage,
    payload.per5HourResetTime,
    QWEN_FIVE_HOUR_LIMIT,
    300,
  )
  const sevenDay = bailianWindow(
    payload.per1WeekPercentage,
    payload.per1WeekResetTime,
    QWEN_SEVEN_DAY_LIMIT,
    10_080,
  )
  if (!fiveHour && !sevenDay) return { available: true, state: "unknown" }
  return {
    available: true,
    source: "bailian-cli",
    state: "ok",
    fiveHour:
      fiveHour || { limit: QWEN_FIVE_HOUR_LIMIT, windowDurationMins: 300 },
    sevenDay:
      sevenDay || { limit: QWEN_SEVEN_DAY_LIMIT, windowDurationMins: 10_080 },
  }
}

/**
 * Build a bailian window object.
 * @param {number | undefined} ratio
 * @param {number | undefined} resetTimeMs - epoch milliseconds
 * @param {number} limit
 * @param {number} minutes
 * @returns {object | null}
 */
function bailianWindow(ratio, resetTimeMs, limit, minutes) {
  if (typeof ratio !== "number") return null
  const usedRatio = Math.min(1, Math.max(0, ratio))
  const usedPercent = Math.round(usedRatio * 1000) / 10 // 1 decimal
  const remainingPercent = Math.round((1 - usedRatio) * 1000) / 10
  let resetsAt = null
  if (typeof resetTimeMs === "number") resetsAt = Math.round(resetTimeMs / 1000)
  return {
    limit,
    usedCredits: Math.round(limit * usedRatio),
    remainingCredits: Math.round(limit * (1 - usedRatio)),
    usedPercent,
    remainingPercent,
    windowDurationMins: minutes,
    resetsAt,
  }
}

// ---------------------------------------------------------------------------
// Cache and public API
// ---------------------------------------------------------------------------

/** @type {{ codex: object, qwen: object }} */
const EMPTY = { codex: { available: false }, qwen: { available: false } }

let cache = { at: 0, data: EMPTY }
let refreshTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null)
/** @type {Array<() => void>} */
let listeners = []
let refreshPending = /** @type {Promise<object> | null} */ (null)

/**
 * Spawn the CLI tools, parse their output, and update the cache.
 * @returns {Promise<object>}
 */
async function refresh() {
  const codexBin = resolveBinary("CODEX_BIN", "codex")
  const blBin = resolveBinary("BAILIAN_CLI_BIN", "bl")

  const [codex, qwen] = await Promise.all([
    codexBin
      ? queryCodex(codexBin)
      : { available: false, reason: "codex-not-found" },
    blBin
      ? queryBailian(blBin)
      : { available: false, reason: "bailian-cli-not-found" },
  ])

  const data = { codex, qwen }
  cache = { at: Date.now(), data }
  listeners.forEach((fn) => fn())
  return data
}

/**
 * Return the latest cached limits, refreshing if the TTL has expired.
 * @returns {Promise<object>}
 */
export async function getLimits() {
  if (Date.now() - cache.at < CACHE_TTL) return cache.data
  if (refreshPending) return refreshPending
  refreshPending = refresh().finally(() => {
    refreshPending = null
  })
  return refreshPending
}

/**
 * Synchronous snapshot of the cache (for initial render).
 * @returns {object}
 */
export function getLimitsSync() {
  return cache.data
}

/**
 * Register a callback that fires when the limits cache changes.
 * Returns an unsubscribe function.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onLimitsChange(fn) {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((f) => f !== fn)
  }
}

/**
 * Start periodic background refresh.  Safe to call multiple times.
 */
export function startAutoRefresh() {
  if (refreshTimer) return
  refreshTimer = setInterval(() => {
    refresh().catch(() => {})
  }, REFRESH_INTERVAL)
  refreshTimer.unref?.()
}

/**
 * Stop the background refresh timer.
 */
export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}