import {
  HARDWARE_MODEL, KERNEL, ROLES, PACKET_SCHEMA, BoundedMap, JevRouter,
  digest, isHardwareLane, resolveModel, routeBody, userTurn, validatePacket,
  workerBody, readProvider,
} from "./tui/lib/hardware-core.js"

const MARKER = "Custom Hardware Edition policy:"
const CORE_TOOLS = new Set(["skill", "mcp_discover", "read", "glob", "grep", "list", "code", "codemode", "mcp", "kb", "knowledge", "diptrace", "fabric"])
const SUPPORT = new Set(["title", "summary", "compaction"])

function toolName(tool) {
  return typeof tool === "string" ? tool : tool?.function?.name || tool?.name || tool?.id || tool?.tool || ""
}

export function filterHardwareTools(tools, active) {
  const allowed = name => active ? name.startsWith("hardware_") || CORE_TOOLS.has(name) ||
    /^(?:kb|knowledge|diptrace|fabric)_/.test(name) : !name.startsWith("hardware_")
  if (Array.isArray(tools)) return tools.filter(tool => allowed(toolName(tool)))
  if (tools && typeof tools === "object") return Object.fromEntries(Object.entries(tools).filter(([name, tool]) => allowed(name || toolName(tool))))
  return tools
}

function selectedImages(input, record) {
  const indices = input.imageIndices || []
  if (!Array.isArray(indices) || indices.length > 4 || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isInteger(index) || index < 0 || index >= record.images.length))
    throw new Error("imageIndices must select at most four distinct current-turn image indices")
  if (input.role === "vision" && !indices.length) throw new Error("vision requires an original image; no text-only pretend inspection")
  return indices.map(index => record.images[index])
}

/** Native V2 manifest. Discovery/installation already copies top-level *.js.
 * Workers use the SAME native provider endpoint/authentication as their parent,
 * with a fresh bounded input and NO tools/history. No secret is persisted and
 * neither user-supplied URLs nor a new proxy/API key are accepted.
 */
export default {
  id: "custom.hardware-orchestrator",
  async setup(ctx) {
    if (process.env.HARDWARE_ORCHESTRATOR === "off") return
    const sessions = new BoundedMap(16)
    const router = new JevRouter()
    const registrations = []
    let cachedCatalog = [], catalogAt = 0
    const overrides = { luna: process.env.HARDWARE_LUNA_MODEL, sol: process.env.HARDWARE_SOL_MODEL, astra: process.env.HARDWARE_ASTRA_MODEL }

    const forget = id => {
      const record = sessions.get(id)
      record?.controllers.forEach(controller => controller.abort(new Error("Hardware turn superseded or disposed")))
      sessions.delete(id)
    }
    const prune = () => {
      for (const [id, record] of sessions) if (Date.now() - record.at > 600000) forget(id)
    }
    const cleanupTimer = setInterval(prune, 30000)
    cleanupTimer.unref?.()
    const catalog = async () => {
      if (Date.now() - catalogAt > 30000 || !cachedCatalog.length) {
        const value = await ctx.catalog.model.list({})
        cachedCatalog = Array.isArray(value) ? value : value?.data || []
        catalogAt = Date.now()
      }
      return cachedCatalog
    }
    const targetFor = async (family, effort = "xhigh") => resolveModel(await catalog(), family, effort, overrides[family])
    const live = id => {
      prune()
      const record = sessions.get(id)
      if (!record) throw new Error("Select GPT-6 · Hardware Edition and send a message before consulting a specialist")
      return record
    }
    const summary = record => record ? {
      profile: HARDWARE_MODEL, route: record.route, parentModel: record.target?.model,
      parentEffort: record.target?.effort, router: record.decision || null,
      availableImages: record.images.map((_, index) => index), imagesOmitted: record.imagesOmitted,
      consultationsStarted: record.calls, inFlight: record.active,
      workerUsage: record.usage, revisionPolicy: "exact evidence-packet + image hash; current turn only",
    } : { profile: HARDWARE_MODEL, active: false }

    registrations.push(await ctx.catalog.transform(catalogDraft => {
      const base = catalogDraft.model.get("openai", overrides.luna || "gpt-6-luna-direct") ||
        catalogDraft.model.get("openai", "gpt-6-luna")
      if (!base || base.enabled === false) return // Never fabricate an unavailable provider/model.
      catalogDraft.model.update("openai", HARDWARE_MODEL, draft => {
        Object.assign(draft, structuredClone(base), {
          id: HARDWARE_MODEL, modelID: base.modelID || base.id,
          name: "GPT-6 · Hardware Edition", settings: { ...base.settings, reasoningEffort: "xhigh" },
        })
      })
    }))

    registrations.push(await ctx.session.hook("context", async event => {
      const active = isHardwareLane(event) && !SUPPORT.has(event.agent)
      if (event.tools) event.tools = filterHardwareTools(event.tools, active)
      if (!active || !Array.isArray(event.system)) return
      // Project/user instructions stay intact. context-policy.js disables only
      // the generic automatic coding/RAG/plan/Ponytail stack for this alias.
      event.system = event.system.filter(part => !(typeof part === "string" ? part : part?.text || "").startsWith(MARKER))
      event.system.push({ type: "text", text: `${MARKER}\n${KERNEL}` })
    }))

    registrations.push(await ctx.session.hook("http.request", async event => {
      if (SUPPORT.has(event.agent)) return
      const id = event.sessionID
      if (!isHardwareLane(event)) { if (id) forget(id); return }
      if (!id) throw new Error("Hardware request lacks a session identity")
      prune()
      const original = event.request
      const body = await original.clone().json()
      const turn = userTurn(body)
      let record = sessions.get(id)
      const continuationOnly = !turn.hasUser && turn.continuation
      if (continuationOnly && !record) throw new Error("Hardware continuation lost its turn state; resend the task rather than guessing its model or images")
      if (!record || (!continuationOnly && record.turn !== turn.key)) {
        forget(id)
        if (sessions.size >= 16) forget(sessions.keys().next().value)
        const imagesOmitted = turn.images.length > 8 || Buffer.byteLength(JSON.stringify(turn.images)) > 16000000
        record = { turn: turn.key, at: Date.now(), images: imagesOmitted ? [] : turn.images,
          imagesOmitted, calls: 0, active: 0, controllers: new Set(), results: new BoundedMap(4), usage: [] }
        sessions.set(id, record)
        // Install the promise before awaiting: simultaneous continuations share
        // one router call. Failures never create a restart/health-check loop.
        record.plan = router.route(turn.text, original.signal).then(async decision => {
          const target = await targetFor(decision.family, decision.family === "astra" ? "max" : "xhigh")
          record.decision = decision; record.target = target; record.route = decision.family
          return target
        })
      }
      const target = await record.plan
      if (sessions.get(id) !== record) throw new Error("Hardware request was superseded")
      if (turn.images.length && !target.input.includes("image"))
        throw new Error(`${target.id} does not advertise image input; refusing to route away from vision`)
      record.at = Date.now()
      // Only a provider transport skeleton is retained, never the transcript.
      const headers = new Headers(original.headers); headers.delete("content-length")
      record.transport = new Request(original, { headers, body: "{}" })
      record.parent = Object.fromEntries(Object.entries(body).filter(([key]) =>
        ["service_tier", "max_output_tokens", "max_completion_tokens", "max_tokens"].includes(key)))
      if (Object.hasOwn(body, "input")) record.parent.input = []
      const routed = routeBody(body, target, original.url)
      // Context filtering is the normal path; filter here too without dropping
      // existing tool results or message/image payloads.
      if (routed.tools) routed.tools = filterHardwareTools(routed.tools, true)
      event.request = new Request(original, { headers, body: JSON.stringify(routed) })
    }))

    registrations.push(await ctx.tool.transform(tools => {
      tools.add({
        name: "hardware_status", description: "Hardware route, available image indices and worker usage. No LLM call.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { pinned: true, codemode: false },
        execute: async (_input, context) => ({ content: JSON.stringify(summary(live(context.sessionID))) }),
      })
      tools.add({
        name: "hardware_consult",
        description: "Read-only specialist with a fresh evidence-only context: design/vision=Luna XHIGH, independent pcb_review=Sol XHIGH, critical_design/critical_review=highest supported Astra. No CAD writes or recursive agents. Exact current-turn requests are deduplicated. Max 4 consultations/turn, 2 concurrently.",
        input: { type: "object", additionalProperties: false, required: ["role", "packet"], properties: {
          role: { enum: Object.keys(ROLES) }, packet: PACKET_SCHEMA,
          imageIndices: { type: "array", maxItems: 4, items: { type: "integer", minimum: 0 } },
        } },
        options: { pinned: true, codemode: false },
        execute: async (input, context) => {
          if (!input || !Object.hasOwn(ROLES, input.role) || Object.keys(input).some(key => !["role", "packet", "imageIndices"].includes(key)))
            throw new Error("Invalid hardware consultation")
          const record = live(context.sessionID)
          const packet = validatePacket(input.packet)
          const images = selectedImages(input, record)
          const spec = ROLES[input.role]
          const target = await targetFor(spec.family, spec.effort)
          if (sessions.get(context.sessionID) !== record) throw new Error("Hardware turn was superseded before dispatch")
          const key = digest({ role: input.role, packet, images, target })
          if (record.results.has(key)) return record.results.get(key)
          if (record.calls >= 4) throw new Error("Hardware consultation budget exhausted (4 per user turn)")
          if (record.active >= 2) throw new Error("Two hardware specialists already running; collect them before delegating more")
          if (!record.transport) throw new Error("Hardware native provider transport is unavailable")
          const body = workerBody(record.parent, input.role, packet, images, target, record.transport.url)
          const controller = new AbortController()
          const nativeSignal = context.signal || context.abortSignal
          const signals = [controller.signal, record.transport.signal, AbortSignal.timeout(spec.family === "astra" ? 240000 : 120000)]
          if (nativeSignal instanceof AbortSignal) signals.push(nativeSignal)
          const headers = new Headers(record.transport.headers)
          headers.delete("content-length")
          headers.set("content-type", "application/json")
          // Do not send parent turn/trace identifiers to a separate provider call.
          headers.delete("x-client-request-id")
          headers.delete("idempotency-key")
          if (signals.some(signal => signal.aborted)) throw new Error("Hardware consultation cancelled before dispatch")
          record.controllers.add(controller); record.calls++; record.active++
          const started = Date.now()
          const run = (async () => {
            try {
              const response = await fetch(new Request(record.transport.url, {
                method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any(signals),
              }))
              const result = await readProvider(response, 14000, started)
              if (sessions.get(context.sessionID) !== record) throw new Error("Discarded stale hardware worker result")
              const receipt = {
                receipt: key, role: input.role, model: target.model, effort: target.effort,
                project: packet.project, boardRevision: packet.boardRevision, corpusRevision: packet.corpusRevision,
                evidenceDigest: digest(packet), imageCount: images.length,
                elapsedMs: Date.now() - started, ttftMs: result.ttftMs, packetBytes: Buffer.byteLength(JSON.stringify(packet)),
                usage: result.usage, actualServiceTier: result.actualServiceTier,
                advisoryOnly: true, output: result.text,
              }
              record.usage.push({ role: input.role, model: target.model, elapsedMs: receipt.elapsedMs, ttftMs: receipt.ttftMs, usage: result.usage })
              return { content: JSON.stringify(receipt) }
            } finally { record.active--; record.controllers.delete(controller) }
          })()
          // Cache errors as well: an automatic retry must not spend another
          // large-model call on the identical input under the same turn.
          record.results.set(key, run)
          return run
        },
      })
    }))

    registrations.push(await ctx.command.transform(commands => commands.add({
      name: "hardware-status", description: "Hardware Edition routing and specialist usage (no model call)",
      execute: async ({ sessionID }) => {
        prune()
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(summary(sessions.get(sessionID)), null, 2), resume: false })
      },
    })))
    return async () => {
      clearInterval(cleanupTimer)
      for (const id of [...sessions.keys()]) forget(id)
      await Promise.allSettled(registrations.map(registration => registration?.dispose?.()))
    }
  },
}
