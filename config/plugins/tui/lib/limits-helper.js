/**
 * Self-contained limits helper for the OpenCode TUI.
 *
 * Queries `codex` (ChatGPT) and `bl` (Alibaba Cloud) directly, keeps one
 * single-flight refresh for every TUI consumer, and owns the periodic timer
 * through reference counting so unloading one panel cannot stop another.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const QWEN_FIVE_HOUR_LIMIT = 12_000
const QWEN_SEVEN_DAY_LIMIT = 40_000
const GEMINI_TPM_LIMIT = 2_000_000
const GEMINI_RPM_LIMIT = 1_000
const GEMINI_RPD_LIMIT = 4_000_000
const CACHE_TTL = 60_000
const REFRESH_INTERVAL = 120_000
const COMMAND_TIMEOUT_MS = Math.max(
  500,
  Math.min(30_000, Number(process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS || 10_000) || 10_000),
)
const MAX_STDOUT_BYTES = 1_000_000

function executable(path) {
  if (!path) return false
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a binary without invoking a shell. */
function resolveBinary(envName, exeName) {
  const fromEnv = process.env[envName]
  if (fromEnv) return executable(fromEnv) ? fromEnv : null
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exeName)
    if (executable(candidate)) return candidate
  }
  return null
}

function terminateChild(child) {
  if (!child || child.exitCode != null || child.killed) return
  try { child.kill("SIGTERM") } catch {}
  const killer = setTimeout(() => {
    if (child.exitCode == null) {
      try { child.kill("SIGKILL") } catch {}
    }
  }, 500)
  killer.unref?.()
}

function readJsonRpc(child, expectedId, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ""
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new Error("Timeout")),
      Math.min(timeout, COMMAND_TIMEOUT_MS),
    )
    timer.unref?.()

    const processBuffer = () => {
      let idx = buffer.indexOf("\n")
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        try {
          const parsed = JSON.parse(line)
          if (parsed.id === expectedId) {
            if (parsed.error) finish(reject, new Error(parsed.error.message || "Codex RPC error"))
            else finish(resolve, parsed.result !== undefined ? parsed.result : parsed)
            return
          }
        } catch {}
        idx = buffer.indexOf("\n")
      }
    }

    child.stdout.on("data", (chunk) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > MAX_STDOUT_BYTES) {
        finish(reject, new Error("Codex response too large"))
        return
      }
      processBuffer()
    })
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (!settled) finish(reject, new Error(`Codex exited ${code}`))
    })
  })
}

async function queryCodex(binary) {
  const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] })
  const watchdog = setTimeout(() => terminateChild(child), COMMAND_TIMEOUT_MS + 1000)
  watchdog.unref?.()
  try {
    child.stdin.write(JSON.stringify({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "custom_opencode_tui",
          title: "custom_opencode TUI limits",
          version: "1",
        },
      },
    }) + "\n")
    await readJsonRpc(child, 1, 5000)
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n")
    child.stdin.write(JSON.stringify({
      method: "account/rateLimits/read",
      id: 2,
      params: {},
    }) + "\n")
    const result = await readJsonRpc(child, 2, COMMAND_TIMEOUT_MS)
    return normalizeCodexResult(result)
  } catch (error) {
    return {
      available: false,
      reason: error?.message === "Timeout" ? "codex-rate-limits-timeout" : "codex-rate-limits-unavailable",
    }
  } finally {
    clearTimeout(watchdog)
    terminateChild(child)
  }
}

function normalizeCodexResult(result) {
  if (!result || typeof result !== "object") return { available: false, reason: "invalid-response" }
  const byId = result.rateLimitsByLimitId || {}
  let snapshot = byId.codex
  if (!snapshot && Object.keys(byId).length > 0) snapshot = Object.values(byId)[0]
  if (!snapshot) snapshot = result.rateLimits
  if (!snapshot || typeof snapshot !== "object") return { available: false, reason: "no-rate-limit-snapshot" }
  return {
    available: true,
    planType: snapshot.planType || undefined,
    limitId: snapshot.limitId || "codex",
    limitName: snapshot.limitName || "Codex",
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    credits: snapshot.credits || undefined,
    rateLimitReachedType: snapshot.rateLimitReachedType || undefined,
    spendControlReached: snapshot.spendControlReached || undefined,
  }
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object" || typeof window.usedPercent !== "number") return null
  const usedPercent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  }
}

async function queryBailian(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ["usage", "token-plan", "--output", "json"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let settled = false
    let stdout = ""
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      terminateChild(child)
      finish({ available: false, reason: "bailian-cli-timeout" })
    }, COMMAND_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.on("data", (chunk) => {
      if (settled) return
      stdout += chunk
      if (stdout.length > MAX_STDOUT_BYTES) {
        terminateChild(child)
        finish({ available: false, reason: "bailian-response-too-large" })
      }
    })
    child.once("error", () => finish({ available: false, reason: "bailian-cli-unavailable" }))
    child.once("close", (code) => {
      if (settled) return
      if (code !== 0) {
        try {
          const payload = JSON.parse(stdout.trim())
          const err = payload?.error
          if (err && (err.code === 3 || /expired|not logged in/i.test(err.message || ""))) {
            finish({
              available: false,
              state: "expired",
              reason: "session-expired",
              hint: err.hint || "bl auth login --console",
            })
            return
          }
        } catch {}
        finish({ available: false, reason: "bailian-cli-error" })
        return
      }
      try {
        const payload = JSON.parse(stdout.trim())
        if (!payload || typeof payload !== "object") {
          finish({ available: false, reason: "invalid-response" })
          return
        }
        finish(normalizeBailianResult(payload))
      } catch {
        finish({ available: false, reason: "invalid-json" })
      }
    })
  })
}

function normalizeBailianResult(payload) {
  const planName = payload.planName || payload.tierName || payload.plan || payload.planType || "Token Plan Personal Pro"
  const fiveHour = bailianWindow(payload.per5HourPercentage, payload.per5HourResetTime, QWEN_FIVE_HOUR_LIMIT, 300)
  const sevenDay = bailianWindow(payload.per1WeekPercentage, payload.per1WeekResetTime, QWEN_SEVEN_DAY_LIMIT, 10_080)
  if (!fiveHour && !sevenDay) return { available: true, state: "unknown", planName }
  return {
    available: true,
    source: "bailian-cli",
    state: "ok",
    planName,
    fiveHour: fiveHour || { limit: QWEN_FIVE_HOUR_LIMIT, windowDurationMins: 300 },
    sevenDay: sevenDay || { limit: QWEN_SEVEN_DAY_LIMIT, windowDurationMins: 10_080 },
  }
}

function bailianWindow(ratio, resetTimeMs, limit, minutes) {
  if (typeof ratio !== "number") return null
  const usedRatio = Math.min(1, Math.max(0, ratio))
  const usedPercent = Math.round(usedRatio * 1000) / 10
  const remainingPercent = Math.round((1 - usedRatio) * 1000) / 10
  return {
    limit,
    usedCredits: Math.round(limit * usedRatio),
    remainingCredits: Math.round(limit * (1 - usedRatio)),
    usedPercent,
    remainingPercent,
    windowDurationMins: minutes,
    resetsAt: typeof resetTimeMs === "number" ? Math.round(resetTimeMs / 1000) : null,
  }
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const NIGHT_START_MIN = 22 * 60
const NIGHT_END_MIN = 8 * 60

export const NIGHT_DISCOUNT_MODELS = [
  "qwen3.8-max",
  "qwen3.8-orchestrated",
  "qwen3.8-max-preview",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731",
]

const NIGHT_DISCOUNT_MODEL_SET = new Set(NIGHT_DISCOUNT_MODELS)

export function isNightDiscountModel(modelID, providerID) {
  if (providerID && providerID !== "bailian-cli") return false
  if (!modelID) return false
  return NIGHT_DISCOUNT_MODEL_SET.has(modelID)
}

export function getNightPromoStatus(nowMs = Date.now()) {
  const bj = new Date(nowMs + BEIJING_OFFSET_MS)
  const minOfDay = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const active = minOfDay >= NIGHT_START_MIN || minOfDay < NIGHT_END_MIN
  const minutesToToggle = active
    ? (minOfDay >= NIGHT_START_MIN ? 24 * 60 - minOfDay + NIGHT_END_MIN : NIGHT_END_MIN - minOfDay)
    : NIGHT_START_MIN - minOfDay
  return {
    active,
    discount: 0.5,
    minutesToToggle,
    togglesAtMs: nowMs + minutesToToggle * 60_000,
    models: NIGHT_DISCOUNT_MODELS,
  }
}

function checkAuthFileForGoogle() {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
    if (existsSync(authPath)) {
      const parsed = JSON.parse(readFileSync(authPath, "utf8"))
      return Boolean(parsed?.google)
    }
  } catch {}
  return false
}

export function queryGemini() {
  const hasKey = Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    checkAuthFileForGoogle()
  )
  if (!hasKey) {
    return { available: false, reason: "key-not-found" }
  }

  let rateLimitState = null
  try {
    const p = join(homedir(), ".local", "state", "custom-opencode", "rate-limit.json")
    if (existsSync(p)) {
      rateLimitState = JSON.parse(readFileSync(p, "utf8"))
    }
  } catch {}

  const isRateLimited = Boolean(rateLimitState?.active)
  const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
  const seconds = nonnegative(rateLimitState?.seconds)
  const until = nonnegative(rateLimitState?.until)
  const resetsAt = isRateLimited
    ? (until ? Math.round(until / 1000) : Math.round(Date.now() / 1000) + seconds)
    : null

  const positiveLimit = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  const tpmLimit = positiveLimit(rateLimitState?.limits?.tpm, GEMINI_TPM_LIMIT)
  const rpmLimit = positiveLimit(rateLimitState?.limits?.rpm, GEMINI_RPM_LIMIT)
  const rpdLimit = positiveLimit(rateLimitState?.limits?.rpd, GEMINI_RPD_LIMIT)
  const limitedBucket = String(rateLimitState?.limitedBucket || "tpm")
  const usedTokens = isRateLimited && limitedBucket === "tpm" ? tpmLimit : nonnegative(rateLimitState?.usage?.tokensLastMinute)
  const usedRequests = isRateLimited && limitedBucket === "rpm" ? rpmLimit : nonnegative(rateLimitState?.usage?.requestsLastMinute)
  const usedDaily = isRateLimited && limitedBucket === "rpd" ? rpdLimit : nonnegative(rateLimitState?.usage?.requestsToday)

  const usedPercentTokens = Math.min(100, Math.round((usedTokens / tpmLimit) * 1000) / 10)
  const usedPercentRequests = Math.min(100, Math.round((usedRequests / rpmLimit) * 1000) / 10)
  const usedPercentDaily = Math.min(100, Math.round((usedDaily / rpdLimit) * 1000) / 10)

  return {
    available: true,
    planType: "Pay-as-you-go (Standard)",
    state: isRateLimited ? "exhausted" : "ok",
    rateLimited: isRateLimited,
    seconds: isRateLimited ? seconds : 0,
    resetsAt,
    minuteTokens: {
      limit: tpmLimit,
      usedCredits: usedTokens,
      remainingCredits: Math.max(0, tpmLimit - usedTokens),
      usedPercent: usedPercentTokens,
      remainingPercent: Math.max(0, Math.round((100 - usedPercentTokens) * 10) / 10),
      windowDurationMins: 1,
      resetsAt,
    },
    minuteRequests: {
      limit: rpmLimit,
      usedCredits: usedRequests,
      remainingCredits: Math.max(0, rpmLimit - usedRequests),
      usedPercent: usedPercentRequests,
      remainingPercent: Math.max(0, Math.round((100 - usedPercentRequests) * 10) / 10),
      windowDurationMins: 1,
      resetsAt,
    },
    dailyRequests: {
      limit: rpdLimit,
      usedCredits: usedDaily,
      remainingCredits: Math.max(0, rpdLimit - usedDaily),
      usedPercent: usedPercentDaily,
      remainingPercent: Math.max(0, Math.round((100 - usedPercentDaily) * 10) / 10),
      windowDurationMins: 1440,
      resetsAt,
    },
  }
}

const EMPTY = { codex: { available: false }, qwen: { available: false }, gemini: { available: false } }
let cache = { at: 0, data: EMPTY }
let refreshTimer = null
let refreshOwners = 0
let refreshPending = null
const listeners = new Set()

async function refresh() {
  const codexBin = resolveBinary("CODEX_BIN", "codex")
  const blBin = resolveBinary("BAILIAN_CLI_BIN", "bl")
  const [codex, qwen] = await Promise.all([
    codexBin ? queryCodex(codexBin) : { available: false, reason: "codex-not-found" },
    blBin ? queryBailian(blBin) : { available: false, reason: "bailian-cli-not-found" },
  ])
  const gemini = queryGemini()
  const data = { codex, qwen, gemini }
  cache = { at: Date.now(), data }
  for (const listener of [...listeners]) {
    try { listener() } catch {}
  }
  return data
}

function requestRefresh(force = false) {
  if (!force && Date.now() - cache.at < CACHE_TTL) return Promise.resolve({ ...cache.data, gemini: queryGemini() })
  if (refreshPending) return refreshPending
  refreshPending = refresh().finally(() => { refreshPending = null })
  return refreshPending
}

export async function getLimits() {
  return requestRefresh(false)
}

export function getLimitsSync() {
  return { ...cache.data, gemini: queryGemini() }
}

export function onLimitsChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function startAutoRefresh() {
  refreshOwners += 1
  if (refreshTimer) return
  refreshTimer = setInterval(() => {
    requestRefresh(true).catch(() => {})
  }, REFRESH_INTERVAL)
  refreshTimer.unref?.()
}

export function stopAutoRefresh() {
  refreshOwners = Math.max(0, refreshOwners - 1)
  if (refreshOwners > 0 || !refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

/** Small status surface used by regression tests. */
export function getAutoRefreshState() {
  return {
    owners: refreshOwners,
    active: Boolean(refreshTimer),
    pending: Boolean(refreshPending),
    timeoutMs: COMMAND_TIMEOUT_MS,
  }
}
