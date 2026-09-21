import { appendFile } from "node:fs/promises"
import { isDndContext } from "./orchestrated-qwen.js"
import { ensureRouter } from "./lazy-local-router.js"

const MODE = String(process.env.DND_ORCHESTRATOR || "auto").toLowerCase()
const RUNTIME_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
const RUNTIME_PORT = process.env.OPENCODE_POLICY_PORT || process.env.OPENCODE_WEB_PORT || "4099"
const TOKEN = process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const ROUTE_URL = `http://${RUNTIME_HOST}:${RUNTIME_PORT}/internal/runtime/dnd/route`
const TELEMETRY = process.env.DND_TELEMETRY_FILE
const VALID_MODE = new Set(["auto", "on", "off"])

function mode() {
  return VALID_MODE.has(MODE) ? MODE : "auto"
}

function textOf(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => textOf(item?.text || item?.content)).join("\n")
  if (value && typeof value === "object") return textOf(value.text || value.content)
  return ""
}

function lastUser(body) {
  if (Array.isArray(body?.messages)) {
    return [...body.messages].reverse().find((item) => item?.role === "user")?.content
  }
  if (typeof body?.input === "string") return body.input
  if (Array.isArray(body?.input)) return body.input.at(-1)?.content || body.input.at(-1)
  return ""
}

function contextOf(body) {
  const text = textOf(lastUser(body)).slice(0, 12000)
  return {
    playMode: /\byolo\b/i.test(text) ? "YOLO" : "FULL",
    hasCombat: /\b(attack|combat|fight|damage|initiative|smash)\b/i.test(text),
    hasPrivate: /\b(whisper|private|secret|dm only)\b/i.test(text),
  }
}

async function route(event, body) {
  if (!TOKEN) throw new Error("D&D orchestrator runtime token is not configured")
  const response = await fetch(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenCode-Runtime": TOKEN },
    body: JSON.stringify({
      sessionID: event.sessionID,
      message: textOf(lastUser(body)).slice(0, 12000),
      context: contextOf(body),
    }),
    signal: AbortSignal.timeout(Number(process.env.DND_ROUTER_TIMEOUT_MS || 2200)),
  })
  if (!response.ok) throw new Error(`D&D orchestrator runtime ${response.status}`)
  return response.json()
}

function applyRoute(body, decision) {
  const selected = decision?.route
  if (!["LUNA_LOW", "LUNA_XHIGH", "SOL_XHIGH"].includes(selected)) {
    // Native OpenCode cannot execute ODM's authoritative MCP operation without
    // a narrator turn. Refuse a destructive shortcut instead of paying for a
    // narrator call that pretends to be NO_LLM.
    throw new Error(`D&D ${selected || "unknown"} route requires managed ODM tool dispatch`)
  }
  const target = selected === "SOL_XHIGH" ? "gpt-5.6-sol" : "gpt-5.6-luna"
  const effort = selected === "LUNA_LOW" ? "low" : "xhigh"
  const tier = selected === "SOL_XHIGH" ? "default" : "fast"
  const result = structuredClone(body)
  result.model = target
  result.service_tier = tier
  if (result.reasoning && typeof result.reasoning === "object") result.reasoning = { ...result.reasoning, effort }
  else result.reasoning_effort = effort
  return result
}

async function record(event, decision, telemetry, fallback) {
  if (!TELEMETRY) return
  const row = {
    at: new Date().toISOString(),
    sessionID: String(event.sessionID || "").slice(0, 256),
    route: decision?.route || null,
    confidence: decision?.confidence ?? null,
    telemetry: telemetry || null,
    fallback: fallback || null,
  }
  await appendFile(TELEMETRY, `${JSON.stringify(row)}\n`, { mode: 0o600 })
}

export function isDndOrchestratorRequest(event) {
  return isDndContext(event)
}

export function routeBody(body, decision) {
  return applyRoute(body, decision)
}

export default {
  id: "dnd-super-orchestrator",
  async setup(ctx) {
    if (mode() === "off") return
    await ctx.session.hook("http.request", async (event) => {
      if (!isDndOrchestratorRequest(event) || event.agent === "compaction") return
      const original = event.request
      let body = {}
      try {
        body = await original.clone().json()
      } catch {
        return
      }
      let plan
      try {
        await ensureRouter({ dnd: true })
        plan = await route(event, body)
      } catch (error) {
        if (mode() === "on") throw error
        plan = {
          decision: { route: "LUNA_LOW", confidence: 0, fallback: "router-offline" },
          telemetry: { router_backend: "unavailable", router_mode: "safe-fallback" },
        }
      }
      await record(event, plan.decision, plan.telemetry, plan.decision?.fallback)
      let routed
      try {
        routed = applyRoute(body, plan.decision)
      } catch (error) {
        if (mode() === "on" || !["TOOL", "NO_LLM"].includes(plan.decision?.route)) throw error
        // A native provider request has no safe ODM tool executor. auto mode
        // stays available by taking the documented Luna LOW fallback; managed
        // Runtime V3 can execute the same decision with zero narrator calls.
        const fallback = { ...plan.decision, route: "LUNA_LOW", fallback: "native-tool-dispatch-unavailable" }
        await record(event, fallback, plan.telemetry, fallback.fallback)
        routed = applyRoute(body, fallback)
      }
      const headers = new Headers(original.headers)
      headers.delete("content-length")
      event.request = new Request(original, { headers, body: JSON.stringify(routed) })
    })
  },
}

if (process.env.DND_SUPER_ORCHESTRATOR_SELF_CHECK) {
  const event = { agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-5.6-dnd-edition" } }
  if (!isDndOrchestratorRequest(event)) throw new Error("D&D request selector failed")
  if (routeBody({ model: "gpt-5.6-sol", messages: [] }, { route: "LUNA_LOW" }).model !== "gpt-5.6-luna") throw new Error("Luna low route failed")
  if (routeBody({ model: "gpt-5.6-sol", messages: [] }, { route: "SOL_XHIGH" }).service_tier !== "default") throw new Error("Sol tier failed")
  let refused = false
  try { routeBody({}, { route: "TOOL" }) } catch { refused = true }
  if (!refused) throw new Error("tool route must not become an invented narrator call")
  console.log("dnd-super-orchestrator self-check OK")
}
