import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { startEvents } from "../events.js"

const CONFIG_PATH = process.env.BAILIAN_CONFIG_PATH || join(homedir(), ".bailian", "config.json")
const BASE = (process.env.TOKEN_PLAN_OPENAI_BASE_URL || "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "")
const MODEL = process.env.TOKEN_PLAN_PROBE_MODEL || "qwen3.8-max"
const PROBE_ENABLED = /^(1|true|yes)$/i.test(process.env.QWEN_QUOTA_PROBE_ENABLED || "0")
const OK_MS = 30 * 60_000
const EXHAUSTED_MS = 10 * 60_000
const SUFFIX_RE = / · Qwen[^·]*$/

function loadKey() {
  const fromEnv = process.env.TOKEN_PLAN_API_KEY
  if (fromEnv && fromEnv !== "CHANGE_ME") return fromEnv
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"))["token-plan"]?.api_key ?? null
  } catch {
    return null
  }
}

export async function probe(apiKey) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = body.error ?? {}
    if (error.code === "insufficient_quota") {
      const match = /will reset at ([^.]+)\./.exec(error.message ?? "")
      return { state: "exhausted", resetAt: match ? match[1] : null }
    }
    return { state: "unknown" }
  }
  return { state: "ok" }
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "qwen-quota",
  async setup(ctx) {
    // A completion-based quota probe consumes model quota. Keep installation,
    // service restarts and the default runtime strictly zero-LLM-token; users
    // who explicitly want title decoration can opt in through the private env.
    if (!PROBE_ENABLED) return
    const apiKey = loadKey()
    if (!apiKey) return

    let state = "unknown"
    let resetAt = null
    let lastProbe = 0

    async function refresh() {
      try {
        const result = await probe(apiKey)
        state = result.state
        resetAt = result.state === "exhausted" ? result.resetAt : null
      } catch {
        state = "unknown"
        resetAt = null
      }
      lastProbe = Date.now()
    }

    async function decorate(sessionID) {
      try {
        const session = await ctx.session.get({ sessionID })
        const base = (session.title ?? "").replace(SUFFIX_RE, "").trimEnd()
        const suffix = state === "exhausted"
          ? ` · Qwen exhausted→${resetAt ?? "?"}`
          : state === "ok" ? " · Qwen OK" : ""
        const title = base + suffix
        if (title !== session.title) await ctx.session.rename({ sessionID, title })
      } catch {}
    }

    void refresh()
    return startEvents(ctx, async (event) => {
      if (event.type !== "session.idle" || !event.data?.sessionID) return
      if (Date.now() - lastProbe > (state === "exhausted" ? EXHAUSTED_MS : OK_MS)) await refresh()
      await decorate(event.data.sessionID)
    })
  },
}

if (process.env.QWEN_QUOTA_SELF_CHECK) {
  const cases = [
    ["Что мы сделали? · Qwen exhausted→08-21 17:17:00 UTC", "Что мы сделали?"],
    ["Что мы сделали?", "Что мы сделали?"],
    ["a · Qwen OK · note", "a · Qwen OK · note"],
    ["", ""],
  ]
  for (const [input, want] of cases) {
    const got = input.replace(SUFFIX_RE, "").trimEnd()
    if (got !== want) throw new Error(`strip: ${JSON.stringify(input)} -> ${JSON.stringify(got)}`)
  }
  console.log("qwen-quota self-check OK")
}
