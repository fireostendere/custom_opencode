
const AUTO_START = /^(1|true|yes)$/i.test(process.env.OPENCODE_LOCAL_AUTO_START || "0")
const LOCAL_PROVIDER = process.env.OPENCODE_LOCAL_PROVIDER || "ollama"
const ROUTER_URL = process.env.OPENCODE_LOCAL_ROUTER_URL
const START_SCRIPT = process.env.OPENCODE_LOCAL_ROUTER_START
const LOG_PATH = process.env.OPENCODE_LOCAL_ROUTER_LOG
const DND_MODE = String(process.env.DND_ORCHESTRATOR || "off").toLowerCase()
// A failed start (script error, never healthy) is not retried for 5 minutes:
// each attempt costs a spawned start script and up to 60 s of polling.
const START_BACKOFF_MS = Number(process.env.OPENCODE_LOCAL_ROUTER_BACKOFF_MS || 5 * 60_000)
let currentStart = null
let retryAfter = 0

async function healthy() {
  if (!ROUTER_URL) return false
  try {
    return (await fetch(ROUTER_URL, {
      signal: AbortSignal.timeout(2_000),
    })).ok
  } catch {
    return false
  }
}

export async function ensureRouter({ dnd = false } = {}) {
  const dndStart = dnd && DND_MODE !== "off" && process.env.DND_QWEN_AUTOSTART !== "0"
  if (!AUTO_START && !dndStart) return
  if (currentStart) return currentStart

  currentStart = (async () => {
    if (!ROUTER_URL) throw new Error("OPENCODE_LOCAL_ROUTER_URL is not configured")
    if (await healthy()) {
      retryAfter = 0
      return
    }
    if (Date.now() < retryAfter)
      throw new Error(`Local model router failed to start recently; next start attempt in ${Math.ceil((retryAfter - Date.now()) / 1000)}s${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)

    if (!START_SCRIPT) throw new Error("Local model router is offline and OPENCODE_LOCAL_ROUTER_START is not configured")
    try {
      const child = Bun.spawn(["bash", START_SCRIPT], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      for (let attempt = 0; attempt < 120; attempt++) {
        if (await healthy()) return
        if (child.exitCode !== null && child.exitCode !== 0) {
          throw new Error(`Failed to start local model router${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)
        }
        await Bun.sleep(500)
      }
      throw new Error(`Local model router did not become healthy${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)
    } catch (error) {
      retryAfter = Date.now() + START_BACKOFF_MS
      throw error
    }
  })()

  try {
    await currentStart
  } finally {
    currentStart = null
  }
}

export async function localRouterHealth() {
  return healthy()
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "lazy-local-router",
  async setup(ctx) {
    const registration = await ctx.session.hook("model.request", async ({ model }) => {
      // Automatic orchestration never selects local models. This hook exists only
      // for explicit manual Ollama selection and is disabled by default.
      if (AUTO_START && model.providerID === LOCAL_PROVIDER) await ensureRouter()
    })
    return () => registration.dispose()
  },
}
