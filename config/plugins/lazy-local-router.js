
const AUTO_START = /^(1|true|yes)$/i.test(process.env.OPENCODE_LOCAL_AUTO_START || "0")
const LOCAL_PROVIDER = process.env.OPENCODE_LOCAL_PROVIDER || "ollama"
const ROUTER_URL = process.env.OPENCODE_LOCAL_ROUTER_URL
const START_SCRIPT = process.env.OPENCODE_LOCAL_ROUTER_START
const LOG_PATH = process.env.OPENCODE_LOCAL_ROUTER_LOG
let currentStart = null

async function healthy() {
  if (!ROUTER_URL) return false
  try {
    return (await fetch(`${ROUTER_URL.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    })).ok
  } catch {
    return false
  }
}

async function ensureRouter() {
  if (!AUTO_START) return
  if (currentStart) return currentStart

  currentStart = (async () => {
    if (!ROUTER_URL) throw new Error("OPENCODE_LOCAL_ROUTER_URL is not configured")
    if (await healthy()) return

    if (!START_SCRIPT) throw new Error("Local model router is offline and OPENCODE_LOCAL_ROUTER_START is not configured")
    const child = Bun.spawn(["bash", START_SCRIPT], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    if (await child.exited !== 0) {
      throw new Error(`Failed to start local model router${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      if (await healthy()) return
      await Bun.sleep(500)
    }
    throw new Error(`Local model router did not become healthy${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)
  })()

  try {
    await currentStart
  } finally {
    currentStart = null
  }
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
