import { Plugin } from "@opencode-ai/plugin"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".local", "state", "custom-opencode")
const STATE_FILE = join(STATE_DIR, "rate-limit.json")

function ensureStateDir() {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true })
    }
  } catch {}
}

const requestHistory = []
let dailyTokens = 0
let dailyRequests = 0
let lastDay = new Date().getUTCDate()

function cleanOldRequests() {
  const now = Date.now()
  while (requestHistory.length && now - requestHistory[0].time > 60000) {
    requestHistory.shift()
  }
}

export function getUsageSnapshot() {
  cleanOldRequests()
  const today = new Date().getUTCDate()
  if (today !== lastDay) {
    dailyTokens = 0
    dailyRequests = 0
    lastDay = today
  }
  const tokensLastMinute = requestHistory.reduce((sum, r) => sum + r.tokens, 0)
  const requestsLastMinute = requestHistory.length
  return {
    tokensLastMinute,
    requestsLastMinute,
    tokensToday: dailyTokens,
    requestsToday: dailyRequests,
  }
}

export function writeRateLimitState(data) {
  try {
    ensureStateDir()
    const usage = getUsageSnapshot()
    const merged = {
      active: false,
      seconds: 0,
      provider: "google",
      planType: "Pay-as-you-go (Standard)",
      limits: {
        tpm: 2000000,
        rpm: 1000,
        rpd: 4000000,
      },
      usage,
      ...data,
    }
    writeFileSync(STATE_FILE, JSON.stringify(merged), "utf8")
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseRetrySeconds(text, headers) {
  let seconds = 0
  if (text) {
    // e.g. "Please retry in 51.86177085s."
    const match = /retry in ([0-9]+(?:\.[0-9]+)?)s/i.exec(text)
    if (match) {
      seconds = Math.ceil(parseFloat(match[1]))
    } else {
      // e.g. "retryDelay": "51s"
      const delayMatch = /"retryDelay"\s*:\s*"([0-9]+)s"/i.exec(text)
      if (delayMatch) {
        seconds = parseInt(delayMatch[1], 10)
      }
    }
  }
  if (!seconds && headers?.get) {
    const retryAfter = headers.get("retry-after")
    if (retryAfter) seconds = parseInt(retryAfter, 10)
  }
  if (!seconds || isNaN(seconds) || seconds <= 0) {
    seconds = 60
  }
  return seconds
}

export function createRetryFetch(origFetch) {
  return async function wrappedFetch(input, init, attempt = 0) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || ""
    const isGoogle = url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com")

    const response = await origFetch(input, init)

    if (!isGoogle || response.status !== 429) {
      if (isGoogle && response.status === 200) {
        const bodyStr = typeof init?.body === "string" ? init.body : ""
        const estimatedTokens = Math.max(50, Math.ceil((bodyStr.length || 200) / 4))
        requestHistory.push({ time: Date.now(), tokens: estimatedTokens })
        dailyRequests += 1
        dailyTokens += estimatedTokens
        writeRateLimitState({ active: false, seconds: 0 })
      }
      return response
    }

    let retrySeconds = 60
    let metric = "generate_content_paid_tier_input_token_count"
    let limit = 2000000
    try {
      const cloned = response.clone()
      const text = await cloned.text()
      retrySeconds = parseRetrySeconds(text, response.headers)
      const metricMatch = /metric:\s*([^\s,]+)/i.exec(text)
      if (metricMatch) metric = metricMatch[1]
      const limitMatch = /limit:\s*([0-9]+)/i.exec(text)
      if (limitMatch) limit = parseInt(limitMatch[1], 10)
    } catch {
      retrySeconds = parseRetrySeconds("", response.headers)
    }

    // Add 1s margin to ensure rate-limit window has genuinely cleared
    retrySeconds += 1

    console.warn(`[gemini-rate-limit] 429 Quota Exceeded. Retrying in ${retrySeconds}s (attempt ${attempt + 1})...`)

    const until = Date.now() + retrySeconds * 1000

    for (let rem = retrySeconds; rem > 0; rem--) {
      if (init?.signal?.aborted) {
        writeRateLimitState({ active: false, seconds: 0 })
        return response
      }

      writeRateLimitState({
        active: true,
        provider: "google",
        seconds: rem,
        total: retrySeconds,
        until,
        metric,
        limit,
        message: `Лимит Gemini (429): повтор через ${rem}с…`,
      })

      await sleep(1000)
    }

    writeRateLimitState({ active: false, seconds: 0 })

    if (init?.signal?.aborted) {
      return response
    }

    if (attempt < 5) {
      return wrappedFetch(input, init, attempt + 1)
    }

    return response
  }
}

export default Plugin.define({
  id: "gemini-rate-limit",
  setup(ctx) {
    writeRateLimitState({ active: false, seconds: 0 })

    if (typeof globalThis.fetch === "function") {
      const original = globalThis.fetch
      globalThis.fetch = createRetryFetch(original)
    }

    if (ctx.aisdk?.hook) {
      ctx.aisdk.hook("sdk", async (hook) => {
        if (hook?.options) {
          const orig = hook.options.fetch || globalThis.fetch
          hook.options.fetch = createRetryFetch(orig)
        }
      })
    }

    return () => {
      writeRateLimitState({ active: false, seconds: 0 })
    }
  },
})

if (process.env.GEMINI_RATE_LIMIT_SELF_CHECK) {
  const sample = "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count, limit: 2000000, model: gemini-3.8-flash\\nPlease retry in 51.86177085s."
  const s = parseRetrySeconds(sample, null)
  if (s !== 52) throw new Error(`Expected 52 seconds, got ${s}`)
  console.log("gemini-rate-limit self-check OK")
}
