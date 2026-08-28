import { Plugin } from "@opencode-ai/plugin"

const LOCAL_PROVIDER = process.env.OPENCODE_LOCAL_PROVIDER || "llama-router"
const ROUTER_URL = process.env.OPENCODE_LOCAL_ROUTER_URL
const START_SCRIPT = process.env.OPENCODE_LOCAL_ROUTER_START
const LOG_PATH = process.env.OPENCODE_LOCAL_ROUTER_LOG
let currentStart = null

async function ensureRouter() {
  if (currentStart) return currentStart

  currentStart = (async () => {
    if (!ROUTER_URL) throw new Error("OPENCODE_LOCAL_ROUTER_URL is not configured")

    try {
      if ((await fetch(`${ROUTER_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return
    } catch {}

    if (!START_SCRIPT) throw new Error("Local model router is offline and OPENCODE_LOCAL_ROUTER_START is not configured")
    const child = Bun.spawn(["bash", START_SCRIPT], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    if (await child.exited !== 0) {
      throw new Error(`Failed to start local model router${LOG_PATH ? `. See ${LOG_PATH}` : ""}`)
    }
  })()

  try {
    await currentStart
  } finally {
    currentStart = null
  }
}

export default Plugin.define({
  id: "lazy-local-router",
  async setup(ctx) {
    return ctx.session.hook("model.request", async ({ model }) => {
      if (model.providerID === LOCAL_PROVIDER) await ensureRouter()
    })
  },
})
