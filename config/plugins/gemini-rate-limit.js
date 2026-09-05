import { Plugin } from "@opencode-ai/plugin"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = process.env.CUSTOM_OPENCODE_STATE_DIR || join(homedir(), ".local", "state", "custom-opencode")
const STATE_FILE = join(STATE_DIR, "rate-limit.json")
const WRAPPED_FETCH = Symbol.for("custom-opencode.gemini-rate-limit.fetch")
const handledResponses = new WeakSet()
const DEFAULT_LIMITS = { tpm: 2000000, rpm: 1000, rpd: 4000000 }
const requestHistory = []
let dailyTokens = 0
let dailyRequests = 0
let lastDay = new Date(Date.now()).toISOString().slice(0, 10)
let stateWrite = 0

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  chmodSync(STATE_DIR, 0o700)
}

function cleanOldRequests() {
  const now = Date.now()
  while (requestHistory.length && now - requestHistory[0].time > 60000) requestHistory.shift()
}

export function getUsageSnapshot() {
  cleanOldRequests()
  const today = new Date(Date.now()).toISOString().slice(0, 10)
  if (today !== lastDay) {
    dailyTokens = 0
    dailyRequests = 0
    lastDay = today
  }
  return {
    tokensLastMinute: requestHistory.reduce((sum, request) => sum + request.tokens, 0),
    requestsLastMinute: requestHistory.length,
    tokensToday: dailyTokens,
    requestsToday: dailyRequests,
  }
}

export function writeRateLimitState(data) {
  try {
    ensureStateDir()
    const merged = {
      active: false,
      seconds: 0,
      provider: "google",
      planType: "Pay-as-you-go (Standard)",
      limits: DEFAULT_LIMITS,
      usage: getUsageSnapshot(),
      ...data,
    }
    const temporary = `${STATE_FILE}.tmp-${process.pid}-${++stateWrite}`
    writeFileSync(temporary, JSON.stringify(merged), { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, STATE_FILE)
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestSignal(input, init) {
  if (init?.signal) return init.signal
  return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined
}

function abortError(signal) {
  if (typeof signal?.throwIfAborted === "function") signal.throwIfAborted()
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError")
}

async function discard(response) {
  try { await response.body?.cancel() } catch {}
}

export function parseRetrySeconds(text, headers) {
  let seconds = 0
  if (text) {
    const match = /retry in ([0-9]+(?:\.[0-9]+)?)s/i.exec(text)
    if (match) seconds = Math.ceil(parseFloat(match[1]))
    else {
      const delayMatch = /"retryDelay"\s*:\s*"([0-9]+)s"/i.exec(text)
      if (delayMatch) seconds = parseInt(delayMatch[1], 10)
    }
  }
  if (!seconds && headers?.get) {
    const retryAfter = headers.get("retry-after")
    if (retryAfter) {
      const numeric = Number(retryAfter)
      seconds = Number.isFinite(numeric) ? Math.ceil(numeric) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
    }
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 60
}

export function quotaBucket(metric, text = "") {
  const value = `${metric || ""} ${text}`.toLowerCase()
  if (value.includes("token")) return "tpm"
  if (value.includes("day") || value.includes("daily")) return "rpd"
  return value.includes("request") ? "rpm" : "tpm"
}

export function createRetryFetch(origFetch, { sleepFn = sleep } = {}) {
  if (origFetch?.[WRAPPED_FETCH]) return origFetch
  let cooldownUntil = 0
  let nextRetryAt = 0

  async function wrappedFetch(input, init, attempt = 0, initialResponse) {
    const signal = requestSignal(input, init)
    abortError(signal)
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || ""
    const isGoogle = url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com")
    const retryInput = typeof Request !== "undefined" && input instanceof Request ? input.clone() : input
    const response = initialResponse || await origFetch(input, init)
    handledResponses.add(response)

    if (!isGoogle || response.status !== 429) {
      if (isGoogle && response.ok) {
        getUsageSnapshot()
        const body = typeof init?.body === "string" ? init.body : ""
        const estimatedTokens = Math.max(50, Math.ceil((body.length || 200) / 4))
        requestHistory.push({ time: Date.now(), tokens: estimatedTokens })
        dailyRequests += 1
        dailyTokens += estimatedTokens
        if (Date.now() >= cooldownUntil) writeRateLimitState({ active: false, seconds: 0 })
      }
      return response
    }

    let retrySeconds = 60
    let metric = "generate_content_paid_tier_input_token_count"
    let limit = 2000000
    let details = ""
    try {
      details = await response.clone().text()
      retrySeconds = parseRetrySeconds(details, response.headers)
      const metricMatch = /metric:\s*([^\s,]+)/i.exec(details)
      const limitMatch = /limit:\s*([0-9]+)/i.exec(details)
      if (metricMatch) metric = metricMatch[1]
      if (limitMatch) limit = parseInt(limitMatch[1], 10)
    } catch {
      retrySeconds = parseRetrySeconds("", response.headers)
    }

    const earliest = Date.now() + (retrySeconds + 1) * 1000
    const limitedBucket = quotaBucket(metric, details)
    const limits = { ...DEFAULT_LIMITS, [limitedBucket]: limit }
    if (attempt >= 5) {
      writeRateLimitState({ active: true, seconds: retrySeconds, total: retrySeconds, until: earliest, metric, limit, limits, limitedBucket })
      return response
    }
    await discard(response)
    const retryAt = Math.max(earliest, nextRetryAt)
    nextRetryAt = retryAt + 1000
    cooldownUntil = Math.max(cooldownUntil, retryAt)
    console.warn(`[gemini-rate-limit] 429 Quota Exceeded. Retrying in ${Math.ceil((retryAt - Date.now()) / 1000)}s (attempt ${attempt + 1})...`)

    while (Date.now() < retryAt) {
      abortError(signal)
      const remaining = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000))
      writeRateLimitState({
        active: true,
        provider: "google",
        seconds: remaining,
        total: retrySeconds + 1,
        until: cooldownUntil,
        metric,
        limit,
        limits,
        limitedBucket,
        message: `Лимит Gemini (429): повтор через ${remaining}с…`,
      })
      await sleepFn(Math.min(1000, retryAt - Date.now()))
    }
    abortError(signal)
    return wrappedFetch(retryInput, init, attempt + 1)
  }

  Object.defineProperty(wrappedFetch, WRAPPED_FETCH, { value: true })
  return wrappedFetch
}

export default Plugin.define({
  id: "gemini-rate-limit",
  setup: async (ctx) => {
    writeRateLimitState({ active: false, seconds: 0 })
    const originalGlobalFetch = globalThis.fetch
    const wrappedGlobalFetch = typeof originalGlobalFetch === "function" ? createRetryFetch(originalGlobalFetch) : null
    if (wrappedGlobalFetch) globalThis.fetch = wrappedGlobalFetch

    if (ctx.aisdk?.hook) {
      ctx.aisdk.hook("sdk", async (hook) => {
        if (hook?.options) hook.options.fetch = createRetryFetch(hook.options.fetch || globalThis.fetch)
      })
    }
    const requests = new WeakMap()
    const disposers = []
    if (ctx.session?.hook && wrappedGlobalFetch) {
      disposers.push(await ctx.session.hook("http.request", async (event) => {
        requests.set(event.request, event.request.clone())
      }, { providerID: "google" }))
      disposers.push(await ctx.session.hook("http.response", async (event) => {
        const request = requests.get(event.request)
        requests.delete(event.request)
        if (!request || handledResponses.has(event.response)) return
        event.response = await wrappedGlobalFetch(request, undefined, 0, event.response)
      }, { providerID: "google" }))
    }

    return async () => {
      if (wrappedGlobalFetch && globalThis.fetch === wrappedGlobalFetch) globalThis.fetch = originalGlobalFetch
      writeRateLimitState({ active: false, seconds: 0 })
      await Promise.allSettled(disposers.map((registration) => registration.dispose()))
    }
  },
})

if (process.env.GEMINI_RATE_LIMIT_SELF_CHECK) {
  const sample = "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count, limit: 2000000, model: gemini-3.8-flash\\nPlease retry in 51.86177085s."
  const seconds = parseRetrySeconds(sample, null)
  if (seconds !== 52) throw new Error(`Expected 52 seconds, got ${seconds}`)
  console.log("gemini-rate-limit self-check OK")
}
