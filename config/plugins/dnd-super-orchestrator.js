import { createHash } from "node:crypto"
import { appendFile } from "node:fs/promises"
import { isDndEdition } from "./orchestrated-qwen.js"
import { ensureRouter } from "./lazy-local-router.js"
import { isIsolatedNarratorRole } from "./tui/lib/context-policy.js"

// Off by default: per-request rerouting overrode the pinned D&D effort and
// service tier. Set DND_ORCHESTRATOR=auto to opt back in.
const MODE = String(process.env.DND_ORCHESTRATOR || "off").toLowerCase()
const RUNTIME_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
// The private Runtime V3 listener is separate from the web listener. Falling
// back to OPENCODE_WEB_PORT sends the route request to the public web server,
// which correctly returns 404 for /internal/runtime/*.
const RUNTIME_PORT = process.env.OPENCODE_POLICY_PORT || "4100"
const TOKEN = process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const ROUTE_URL = `http://${RUNTIME_HOST}:${RUNTIME_PORT}/internal/runtime/dnd/route`
const TELEMETRY = process.env.DND_TELEMETRY_FILE
const VALID_MODE = new Set(["auto", "on", "off"])
const VALID_ROUTES = new Set(["LUNA_LOW", "LUNA_XHIGH", "LUNA_MAX", "SOL_XHIGH", "TOOL", "NO_LLM"])

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
    return body.messages.findLast((item) => item?.role === "user")?.content
  }
  if (typeof body?.input === "string") return body.input
  if (Array.isArray(body?.input)) {
    return body.input.findLast((item) => item?.role === "user")?.content || ""
  }
  return ""
}

function turnItems(body) {
  return Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
}

/** Identity of the user turn a request belongs to: tool-continuation steps share it. */
export function turnKey(body) {
  const users = turnItems(body).filter((item) => item?.role === "user")
  const text = typeof body?.input === "string" ? body.input : textOf(users.at(-1)?.content)
  return createHash("sha256").update(JSON.stringify([users.length, text])).digest("hex")
}

function contextOf(text) {
  return {
    playMode: /\byolo\b/i.test(text) ? "YOLO" : "FULL",
    hasCombat: /\b(attack|combat|fight|damage|initiative|smash)\b/i.test(text),
    hasPrivate: /\b(whisper|private|secret|dm only)\b/i.test(text),
  }
}

async function route(event, body) {
  if (!TOKEN) throw new Error("D&D orchestrator runtime token is not configured")
  const message = textOf(lastUser(body)).slice(0, 12000)
  const response = await fetch(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenCode-Runtime": TOKEN },
    body: JSON.stringify({
      sessionID: event.sessionID,
      message,
      context: contextOf(message),
    }),
    signal: AbortSignal.timeout(Number(process.env.DND_ROUTER_TIMEOUT_MS || 9000)),
  })
  if (!response.ok) throw new Error(`D&D orchestrator runtime ${response.status}`)
  const result = await response.json()
  // A 200 with a malformed/unknown decision is an unavailable router too.
  // Validate inside decide's try block so auto mode can use its safe fallback;
  // strict mode still reports the contract failure rather than hiding it.
  if (!result || typeof result !== "object" || !VALID_ROUTES.has(result.decision?.route)) {
    throw new Error("Invalid D&D orchestrator routing decision")
  }
  return result
}

function applyRoute(body, decision) {
  const selected = decision?.route
  if (!["LUNA_LOW", "LUNA_XHIGH", "LUNA_MAX", "SOL_XHIGH"].includes(selected)) {
    // Native OpenCode cannot execute ODM's authoritative MCP operation without
    // a narrator turn. Refuse a destructive shortcut instead of paying for a
    // narrator call that pretends to be NO_LLM.
    throw new Error(`D&D ${selected || "unknown"} route requires managed ODM tool dispatch`)
  }
  const target = selected === "SOL_XHIGH" ? "gpt-6.1-sol" : "gpt-6-luna"
  const effort = selected === "LUNA_LOW" ? "low" : selected === "LUNA_MAX" ? "max" : "xhigh"
  const result = { ...body }
  result.model = target
  // ChatGPT OAuth rejects fast/priority and the native Fast alias silently
  // retries at default; keep the live D&D route available until API-key auth.
  delete result.service_tier
  result.reasoning = { ...(result.reasoning && typeof result.reasoning === "object" ? result.reasoning : {}), effort }
  delete result.reasoning_effort
  return result
}

async function record(event, decision, telemetry, fallback) {
  if (!TELEMETRY) return
  const observed = telemetry ? { ...telemetry } : null
  const row = {
    at: new Date().toISOString(),
    sessionID: String(event.sessionID || "").slice(0, 256),
    route: decision?.route || null,
    confidence: decision?.confidence ?? null,
    telemetry: observed,
    fallback: fallback || null,
  }
  // Optional diagnostics must not abort a paid narrator request when the
  // directory is missing, permissions change, or the disk is full.
  try { await appendFile(TELEMETRY, `${JSON.stringify(row)}\n`, { mode: 0o600 }) } catch {}
}

export function isDndOrchestratorRequest(event) {
  // Only the OpenAI Edition alias is routed. Any other model a D&D agent runs
  // on (Bailian, Ollama, Google, a pinned OpenAI worker) is authoritative, and
  // isolated narrator roles keep their own pinned model and JSON contract.
  return isDndEdition(event) && !isIsolatedNarratorRole(event)
}

export function routeBody(body, decision) {
  return applyRoute(body, decision)
}

export default {
  id: "dnd-super-orchestrator",
  async setup(ctx) {
    if (mode() === "off") return
    // One routing decision per (session, user turn): tool-continuation steps
    // reuse it instead of waiting on local classification again.
    const decisions = new Map()
    const decide = (event, body) => {
      const key = turnKey(body)
      const cached = decisions.get(event.sessionID)
      if (cached?.key === key) return cached.plan
      const plan = (async () => {
        let result
        try {
          // Auto mode can narrate while the optional local model starts. Waiting
          // for its cold start on every tool continuation stalls the whole game.
          if (mode() === "on") await ensureRouter({ dnd: true })
          else void ensureRouter({ dnd: true }).catch(() => {})
          result = await route(event, body)
        } catch (error) {
          if (mode() === "on") throw error
          result = {
            decision: { route: "LUNA_LOW", confidence: 0, fallback: "router-offline" },
            telemetry: { router_backend: "unavailable", router_mode: "safe-fallback" },
          }
        }
        await record(event, result.decision, result.telemetry, result.decision?.fallback)
        return result
      })()
      decisions.delete(event.sessionID)
      decisions.set(event.sessionID, { key, plan })
      if (decisions.size > 256) decisions.delete(decisions.keys().next().value)
      // A strict-mode failure must not stick to the turn.
      plan.catch(() => {
        if (decisions.get(event.sessionID)?.plan === plan) decisions.delete(event.sessionID)
      })
      return plan
    }
    await ctx.session.hook("http.request", async (event) => {
      if (!isDndOrchestratorRequest(event) || event.agent === "compaction") return
      if (event.kind && event.kind !== "primary") return
      const original = event.request
      let body = {}
      try {
        body = await original.clone().json()
      } catch {
        return
      }
      const plan = await decide(event, body)
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
  const event = { agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-6-dnd-edition" } }
  if (!isDndOrchestratorRequest(event)) throw new Error("D&D request selector failed")
  if (isDndOrchestratorRequest({ agent: "dnd-narrator-high", model: { providerID: "openai", id: "gpt-6-luna-direct" } })) throw new Error("pinned D&D worker must not be rerouted")
  if (isDndOrchestratorRequest({ agent: "dnd-narrator-max", model: { providerID: "openai", id: "gpt-6-sol-orchestrated" } })) throw new Error("pinned Sol worker must not be rerouted")
  for (const providerID of ["bailian-cli", "ollama", "google"])
    if (isDndOrchestratorRequest({ agent: "dnd-narrator", model: { providerID, id: "qwen3.8-max" } })) throw new Error(`${providerID} narrator must not be rewritten to an OpenAI model`)
  if (isDndOrchestratorRequest({ agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-6-sol-direct" } })) throw new Error("an explicit OpenAI pick must not be downgraded")
  if (isDndOrchestratorRequest({ agent: "narrator-referee", model: { providerID: "openai", id: "gpt-6-dnd-edition" } })) throw new Error("isolated narrator roles keep their pinned route")
  if (!isDndOrchestratorRequest({ agent: "build", model: { providerID: "openai", id: "gpt-6-dnd-edition" } })) throw new Error("Edition model selector failed")
  const continuation = { input: [{ role: "user", content: "attack" }, { type: "function_call", name: "odm" }, { type: "function_call_output", output: "hit" }] }
  if (turnKey(continuation) !== turnKey({ input: [{ role: "user", content: "attack" }] })) throw new Error("tool continuation must keep its turn")
  if (turnKey(continuation) === turnKey({ input: [...continuation.input, { role: "user", content: "attack" }] })) throw new Error("a new user turn must route again")
  if (routeBody({ model: "gpt-6-sol", messages: [] }, { route: "LUNA_LOW" }).model !== "gpt-6-luna") throw new Error("Luna low route failed")
  const lunaLow = routeBody({ model: "gpt-6-sol", messages: [] }, { route: "LUNA_LOW" })
  const lunaXhigh = routeBody({ model: "gpt-6-sol", messages: [] }, { route: "LUNA_XHIGH" })
  const lunaMax = routeBody({ model: "gpt-6-sol", messages: [] }, { route: "LUNA_MAX" })
  if ("service_tier" in lunaLow || "service_tier" in lunaXhigh || "service_tier" in lunaMax) throw new Error("Luna OAuth tier contract failed")
  if (lunaLow.reasoning?.effort !== "low" || lunaXhigh.reasoning?.effort !== "xhigh" || lunaMax.reasoning?.effort !== "max" || "reasoning_effort" in lunaLow) throw new Error("Luna reasoning contract failed")
  const solXhigh = routeBody({ model: "gpt-6-luna", messages: [] }, { route: "SOL_XHIGH" })
  if ("service_tier" in solXhigh) throw new Error("Sol default tier failed")
  if (solXhigh.model !== "gpt-6.1-sol" || solXhigh.reasoning?.effort !== "xhigh") throw new Error("Sol route must target GPT-6.1 Sol at xhigh")
  let refused = false
  const original = { messages: [{ role: "user", content: "attack" }], reasoning: { summary: "auto" }, reasoning_effort: "high", service_tier: "priority" }
  const routed = routeBody(original, { route: "LUNA_LOW" })
  if (routed.messages !== original.messages || original.reasoning.effort || !original.service_tier || !original.reasoning_effort) throw new Error("Routing must reuse history without mutating the request")
  try { routeBody({}, { route: "TOOL" }) } catch { refused = true }
  if (!refused) throw new Error("tool route must not become an invented narrator call")
  const followup = { input: [{ role: "user", content: "keep routing" }, { type: "function_call_output", output: "tool result" }] }
  if (textOf(lastUser(followup)) !== "keep routing") throw new Error("Responses input user extraction failed")
  console.log("dnd-super-orchestrator self-check OK")
}
