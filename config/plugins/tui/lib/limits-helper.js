/**
 * Self-contained limits helper for the OpenCode TUI.
 *
 * Queries `codex` (ChatGPT) and `bl` (Alibaba Cloud) directly and keeps one
 * single-flight refresh for every TUI consumer. Every timer, file read and
 * CLI spawn is owned by reference counting (`acquireLimits`): importing this
 * module or reading its cached snapshot costs nothing, and the last released
 * owner stops everything. All file access is asynchronous.
 */
import { constants as fsConstants } from "node:fs"
import { access, readFile, readdir, realpath, stat } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const QWEN_FIVE_HOUR_LIMIT = 12_000
const QWEN_SEVEN_DAY_LIMIT = 40_000
const GEMINI_TPM_LIMIT = 2_000_000
const GEMINI_RPM_LIMIT = 1_000
const GEMINI_RPD_LIMIT = 4_000_000
const CACHE_TTL = 60_000
const REFRESH_INTERVAL = 120_000
const TICK_IDLE_MS = 5_000
const TICK_ACTIVE_MS = 1_000
const BINARY_CACHE_MS = 600_000
// A missing CLI, a missing ChatGPT login or an expired/unpaid Alibaba console
// session does not fix itself within minutes: like the web limits bridge,
// re-check such providers every 30 minutes instead of on each 120 s refresh.
// Other `bl` failures back off exponentially up to the same ceiling.
const LIMITS_SETUP_RETRY_MS = 30 * 60_000
const BAILIAN_ERROR_BACKOFF_MS = 5 * 60_000
const SETUP_REASONS = new Set(["codex-not-found", "codex-auth-required", "bailian-cli-not-found", "session-expired", "disabled"])
const VERSION_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = Math.max(
  500,
  Math.min(30_000, Number(process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS || 10_000) || 10_000),
)
const MAX_STDOUT_BYTES = 1_000_000
const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/
// Provider CLIs need their own login state, never the API keys and service
// passwords that the custom-opencode launcher exports into the TUI (mirrors
// the web server's child environment allowlist).
const CHILD_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CODEX_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "WSL_DISTRO_NAME", "WSL_INTEROP",
])

/** Environment for a provider CLI: allowlisted, with its own bin dir first so
 * an npm `#!/usr/bin/env node` launcher runs with the node installed beside it. */
export function childEnv(binary, env = process.env) {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue
    if (CHILD_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("BAILIAN_") || key.startsWith("BL_")) {
      result[key] = String(value)
    }
  }
  if (binary) result.PATH = [dirname(binary), result.PATH].filter(Boolean).join(delimiter)
  return result
}

async function isExecutableFile(path) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Every installed copy of a CLI: each PATH entry, then the usual per-user
 * install locations (newest nvm first), deduplicated by real path. */
export async function binaryCandidates(exeName, { env = process.env, home = homedir() } = {}) {
  const directories = String(env.PATH || "").split(delimiter).filter(Boolean)
  for (const directory of [".local/bin", ".npm-global/bin", ".bun/bin", "bin"]) directories.push(join(home, directory))
  try {
    const versions = (await readdir(join(home, ".nvm", "versions", "node")))
      .sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)))
    for (const version of versions) directories.push(join(home, ".nvm", "versions", "node", version, "bin"))
  } catch {}
  const checked = await Promise.all(
    [...new Set(directories)].map(async (directory) => {
      const candidate = join(directory, exeName)
      if (!(await isExecutableFile(candidate))) return null
      let real = candidate
      try { real = await realpath(candidate) } catch {}
      return { candidate, real }
    }),
  )
  const seen = new Set()
  const candidates = []
  for (const item of checked) {
    if (!item || seen.has(item.real)) continue
    seen.add(item.real)
    candidates.push(item.candidate)
  }
  return candidates
}

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text ?? ""))
  return match ? match.slice(1).map(Number) : []
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1)
    if (difference) return difference
  }
  return 0
}

/** SIGTERM the child's whole process group (npm launchers spawn a native
 * binary), escalating to SIGKILL when the leader does not exit. */
function terminateChild(child) {
  if (!child?.pid) return
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch {}
    }
  }
  signalGroup("SIGTERM")
  const killer = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) signalGroup("SIGKILL")
  }, 500)
  killer.unref?.()
}

function spawnCli(binary, args, stdio) {
  return spawn(binary, args, { stdio, env: childEnv(binary), detached: true })
}

async function binaryVersion(path) {
  return await new Promise((resolve) => {
    let child
    try {
      child = spawnCli(path, ["--version"], ["ignore", "pipe", "ignore"])
    } catch {
      resolve([])
      return
    }
    let output = ""
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      terminateChild(child)
      finish([])
    }, VERSION_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.length > 4096) {
        terminateChild(child)
        finish(parseVersion(output))
      }
    })
    child.once("error", () => finish([]))
    child.once("close", () => finish(parseVersion(output)))
  })
}

const resolvedBinaries = new Map()

/**
 * Resolve a provider CLI without a shell. An explicit `<envName>` pins it.
 * With `newest`, every installed copy is version-probed and the highest
 * version wins (ties keep PATH order): an ancient /usr/local/bin/codex found
 * first on PATH cannot decode newer ChatGPT plan types. Cached per candidate
 * set for ten minutes.
 */
export async function resolveBinary(envName, exeName, { newest = false } = {}) {
  const pinned = process.env[envName]
  if (pinned) return (await isExecutableFile(pinned)) ? pinned : null
  const candidates = await binaryCandidates(exeName)
  if (!newest || candidates.length < 2) return candidates[0] ?? null
  const key = candidates.join("\0")
  const cached = resolvedBinaries.get(exeName)
  if (cached?.key === key && Date.now() - cached.at < BINARY_CACHE_MS) return cached.path
  const versions = await Promise.all(candidates.map((candidate) => binaryVersion(candidate)))
  let best = 0
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareVersions(versions[index], versions[best]) > 0) best = index
  }
  const path = candidates[best]
  resolvedBinaries.set(exeName, { key, at: Date.now(), path })
  return path
}

export function resolveCodexBinary() {
  return resolveBinary("CODEX_BIN", "codex", { newest: true })
}

function readJsonRpc(child, expectedId, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ""
    const onData = (chunk) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > MAX_STDOUT_BYTES) {
        finish(reject, new Error("Codex response too large"))
        return
      }
      processBuffer()
    }
    const onError = (error) => finish(reject, error)
    const onClose = (code) => finish(reject, new Error(`Codex exited ${code}`))
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("error", onError)
      child.off("close", onClose)
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

    child.stdout.on("data", onData)
    child.once("error", onError)
    child.once("close", onClose)
  })
}

const CODEX_UNAVAILABLE = Object.freeze({ available: false, reason: "codex-rate-limits-unavailable" })

async function readCodexRateLimits(child, id) {
  child.stdin.write(JSON.stringify({ method: "account/rateLimits/read", id, params: {} }) + "\n")
  return normalizeCodexResult(await readJsonRpc(child, id, COMMAND_TIMEOUT_MS))
}

async function queryCodex(binary) {
  let child
  try {
    child = spawnCli(binary, ["app-server"], ["pipe", "pipe", "ignore"])
  } catch {
    return CODEX_UNAVAILABLE
  }
  child.stdin.on("error", () => {})
  const watchdog = setTimeout(() => terminateChild(child), 3 * COMMAND_TIMEOUT_MS + 1000)
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
    let result
    try {
      result = await readCodexRateLimits(child, 2)
    } catch (error) {
      if (error?.message === "Timeout") throw error
      result = CODEX_UNAVAILABLE
    }
    if (result.available) return result
    // Refresh the ChatGPT token only after a failed read (like the web):
    // forcing a refresh on every poll races the user's own Codex sessions.
    let account = null
    try {
      child.stdin.write(JSON.stringify({ method: "account/read", id: 3, params: { refreshToken: true } }) + "\n")
      account = await readJsonRpc(child, 3, COMMAND_TIMEOUT_MS)
    } catch {}
    if (account?.requiresOpenaiAuth === true && !account.account) {
      return { available: false, reason: "codex-auth-required" }
    }
    try {
      return await readCodexRateLimits(child, 4)
    } catch {
      return CODEX_UNAVAILABLE
    }
  } catch (error) {
    return {
      available: false,
      reason: error?.message === "Timeout" ? "codex-rate-limits-timeout" : "codex-rate-limits-unavailable",
    }
  } finally {
    clearTimeout(watchdog)
    try { child.stdin.end() } catch {}
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
    let child
    try {
      child = spawnCli(binary, ["usage", "token-plan", "--output", "json"], ["ignore", "pipe", "ignore"])
    } catch {
      resolve({ available: false, reason: "bailian-cli-unavailable" })
      return
    }
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

// --- Gemini rate-limit state (written by the gemini-rate-limit server plugin)

export function rateLimitStatePath() {
  const directory = process.env.CUSTOM_OPENCODE_STATE_DIR || join(homedir(), ".local", "state", "custom-opencode")
  return join(directory, "rate-limit.json")
}

// JSON files re-read only when their mtime/size changes.
const jsonFiles = new Map()
async function readJsonIfChanged(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    jsonFiles.delete(path)
    return null
  }
  const key = `${info.mtimeMs}:${info.size}`
  const cached = jsonFiles.get(path)
  if (cached?.key === key) return cached.value
  let value = null
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch {}
  jsonFiles.set(path, { key, value })
  return value
}

export function readRateLimitState(path = rateLimitStatePath()) {
  return readJsonIfChanged(path)
}

export const INACTIVE_RATE_LIMIT = Object.freeze({ active: false, seconds: 0, until: 0 })

/** Countdown state from the server file. The remaining seconds are derived
 * from `until`, so a stale `active` file (server gone) expires by itself. */
export function normalizeRateLimit(data, nowMs = Date.now()) {
  if (!data || data.active !== true) return INACTIVE_RATE_LIMIT
  const until = Number(data.until) > 0 ? Number(data.until) : 0
  const seconds = until
    ? Math.ceil((until - nowMs) / 1000)
    : Math.ceil(Number(data.seconds) || 0)
  if (!(seconds > 0)) return INACTIVE_RATE_LIMIT
  return { active: true, seconds, until }
}

export function sameRateLimit(a, b) {
  return a === b || (Boolean(a?.active) === Boolean(b?.active) && a?.seconds === b?.seconds && a?.until === b?.until)
}

/**
 * Watch the Gemini 429 countdown with one cheap stat per poll: every
 * `idleMs` (≥ 2 s) while no limit is active and every `activeMs` during a
 * countdown. `onChange` runs only when the normalized state changes.
 */
export function watchRateLimit(onChange, options = {}) {
  const idleMs = Math.max(2_000, Number(options.idleMs ?? 3_000))
  const activeMs = Math.max(250, Number(options.activeMs ?? 1_000))
  const read = options.read ?? readRateLimitState
  const now = options.now ?? Date.now
  let current = INACTIVE_RATE_LIMIT
  let timer = null
  let stopped = false
  async function poll() {
    timer = null
    let next = INACTIVE_RATE_LIMIT
    try {
      next = normalizeRateLimit(await read(), now())
    } catch {}
    if (stopped) return
    if (!sameRateLimit(current, next)) {
      current = next
      try { onChange(next) } catch {}
    }
    timer = setTimeout(poll, next.active ? activeMs : idleMs)
    timer.unref?.()
  }
  void poll()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

async function hasGoogleCredential() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true
  const auth = await readJsonIfChanged(join(homedir(), ".local", "share", "opencode", "auth.json"))
  return Boolean(auth?.google)
}

export function geminiLimitsFromState(rateLimitState, nowMs = Date.now()) {
  const isRateLimited = Boolean(rateLimitState?.active)
  const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
  const seconds = nonnegative(rateLimitState?.seconds)
  const until = nonnegative(rateLimitState?.until)
  const resetsAt = isRateLimited
    ? (until ? Math.round(until / 1000) : Math.round(nowMs / 1000) + seconds)
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

const GEMINI_UNCONFIGURED = Object.freeze({ available: false, reason: "key-not-found" })
const NO_RATE_LIMIT_FILE = Object.freeze({})
let geminiSource = null
let geminiState = GEMINI_UNCONFIGURED

/** Re-read the Gemini state (async, stat-guarded). Returns true on change. */
async function refreshGemini() {
  let source = null
  try {
    source = (await hasGoogleCredential()) ? ((await readRateLimitState()) ?? NO_RATE_LIMIT_FILE) : null
  } catch {}
  if (source === geminiSource) return false
  geminiSource = source
  geminiState = source ? geminiLimitsFromState(source) : GEMINI_UNCONFIGURED
  return true
}

/** Cached Gemini snapshot; never touches the filesystem. */
export function queryGemini() {
  return geminiState
}

// --- Shared snapshot, single-flight refresh and reference-counted feed

const EMPTY = { codex: { available: false }, qwen: { available: false } }
let cache = { at: 0, data: EMPTY }
let snapshot = null
let refreshTimer = null
let tickTimer = null
let owners = 0
let refreshPending = null
const listeners = new Set()
const tickListeners = new Set()

function currentSnapshot() {
  if (!snapshot || snapshot.codex !== cache.data.codex || snapshot.qwen !== cache.data.qwen || snapshot.gemini !== geminiState) {
    snapshot = { codex: cache.data.codex, qwen: cache.data.qwen, gemini: geminiState }
  }
  return snapshot
}

function notify(set) {
  for (const listener of [...set]) {
    try { listener() } catch {}
  }
}

/** `OPENCODE_LIMITS_QWEN=0|off|false|no` (e.g. no Token Plan subscription)
 * disables the Alibaba limits: `bl` is never spawned. */
export function qwenLimitsEnabled(env = process.env) {
  const off = (value) => ["0", "off", "false", "no"].includes(String(value ?? "1").trim().toLowerCase())
  return !off(env.OPENCODE_ALIBABA_ENABLED) && !off(env.OPENCODE_LIMITS_QWEN)
}

function providerUsable(provider, result) {
  return provider === "qwen" ? result?.state === "ok" : result?.available === true
}

/** Delay before an unusable provider is queried again (0 = next refresh). */
export function limitsRetryMs(provider, result, failures = 1) {
  if (!result || providerUsable(provider, result)) return 0
  if (SETUP_REASONS.has(result.reason) || result.state === "expired") return LIMITS_SETUP_RETRY_MS
  if (provider !== "qwen") return 0
  return Math.min(LIMITS_SETUP_RETRY_MS, BAILIAN_ERROR_BACKOFF_MS * 2 ** Math.max(0, failures - 1))
}

// Survives plugin hot reloads, which re-import this module.
const providerStates = (globalThis[Symbol.for("custom-opencode.tui.limits.backoff")] ??= new Map())

async function loadWithBackoff(provider, key, load) {
  const state = providerStates.get(provider)
  if (state?.key === key && state.result && Date.now() < state.retryAt) return state.result
  const result = await load()
  const failures = providerUsable(provider, result) ? 0 : (state?.key === key ? state.failures : 0) + 1
  providerStates.set(provider, { key, result, failures, retryAt: Date.now() + limitsRetryMs(provider, result, failures) })
  return result
}

export function getLimitsBackoff(provider) {
  const state = providerStates.get(provider)
  return state ? { retryAt: state.retryAt, failures: state.failures, reason: state.result?.reason } : null
}

function loadCodex() {
  const key = `${process.env.CODEX_BIN ?? ""}\0${process.env.PATH ?? ""}\0${homedir()}`
  return loadWithBackoff("codex", key, async () => {
    const binary = await resolveCodexBinary().catch(() => null)
    return binary ? queryCodex(binary) : { available: false, reason: "codex-not-found" }
  })
}

function loadQwen() {
  if (!qwenLimitsEnabled()) return Promise.resolve({ available: false, state: "disabled", reason: "disabled" })
  const key = `${process.env.BAILIAN_CLI_BIN ?? ""}\0${process.env.PATH ?? ""}\0${homedir()}`
  return loadWithBackoff("qwen", key, async () => {
    const binary = await resolveBinary("BAILIAN_CLI_BIN", "bl").catch(() => null)
    return binary ? queryBailian(binary) : { available: false, reason: "bailian-cli-not-found" }
  })
}

async function refresh() {
  const [codex, qwen] = await Promise.all([
    loadCodex().catch(() => CODEX_UNAVAILABLE),
    loadQwen().catch(() => ({ available: false, reason: "bailian-cli-unavailable" })),
    refreshGemini().catch(() => false),
  ])
  cache = { at: Date.now(), data: { codex, qwen } }
  notify(listeners)
  return currentSnapshot()
}

function refreshGeminiAndNotify() {
  return refreshGemini().then((changed) => {
    if (changed) notify(listeners)
    return currentSnapshot()
  }, () => currentSnapshot())
}

function requestRefresh(force = false) {
  if (!force && Date.now() - cache.at < CACHE_TTL) return refreshGeminiAndNotify()
  if (refreshPending) return refreshPending
  refreshPending = refresh().finally(() => { refreshPending = null })
  return refreshPending
}

export async function getLimits() {
  return requestRefresh(false)
}

/** Query the providers now (backoff windows still apply). */
export async function refreshLimits() {
  return requestRefresh(true)
}

/** Last known limits; synchronous and free of I/O. */
export function getLimitsSync() {
  return currentSnapshot()
}

export function onLimitsChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function scheduleTick() {
  if (!owners || tickTimer) return
  const delay = geminiState.rateLimited ? TICK_ACTIVE_MS : TICK_IDLE_MS
  tickTimer = setTimeout(async () => {
    tickTimer = null
    if (!owners) return
    let changed = false
    try { changed = await refreshGemini() } catch {}
    if (!owners) return
    if (changed) notify(listeners)
    notify(tickListeners)
    scheduleTick()
  }, delay)
  tickTimer.unref?.()
}

function startFeed() {
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      requestRefresh(true).catch(() => {})
    }, REFRESH_INTERVAL)
    refreshTimer.unref?.()
  }
  scheduleTick()
  // The local Gemini state is ready long before the provider CLIs answer.
  void refreshGeminiAndNotify()
  requestRefresh(false).catch(() => {})
}

function stopFeed() {
  if (refreshTimer) clearInterval(refreshTimer)
  if (tickTimer) clearTimeout(tickTimer)
  refreshTimer = null
  tickTimer = null
}

/**
 * Own the limits machinery while a Limits view is mounted: the first owner
 * starts the 120 s CLI refresh and a light Gemini ticker (1 s during a 429
 * countdown, 5 s otherwise); the last release stops both. Returns an
 * idempotent release function.
 */
export function acquireLimits({ onChange, onTick } = {}) {
  if (onChange) listeners.add(onChange)
  if (onTick) tickListeners.add(onTick)
  owners += 1
  if (owners === 1) startFeed()
  let released = false
  return () => {
    if (released) return
    released = true
    if (onChange) listeners.delete(onChange)
    if (onTick) tickListeners.delete(onTick)
    owners = Math.max(0, owners - 1)
    if (!owners) stopFeed()
  }
}

// Backward-compatible owner API.
const legacyReleases = []
export function startAutoRefresh() {
  legacyReleases.push(acquireLimits())
}

export function stopAutoRefresh() {
  legacyReleases.pop()?.()
}

/** Small status surface used by regression tests. */
export function getAutoRefreshState() {
  return {
    owners,
    active: Boolean(refreshTimer),
    ticking: Boolean(tickTimer),
    pending: Boolean(refreshPending),
    timeoutMs: COMMAND_TIMEOUT_MS,
  }
}
