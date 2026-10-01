import { isDndEdition } from "./orchestrated-qwen.js"

// GPT-6 Luna "Fast" is service_tier=priority. The bundled AI SDK drops
// providerOptions.serviceTier for model IDs it does not list as
// priority-capable (gpt-6-* included), so a variant setting never reaches the
// wire. Set it on the outgoing D&D Edition request instead.
// DND_FAST_TIER=default (or off) disables it.
const TIER = String(process.env.DND_FAST_TIER || "priority").toLowerCase()
// After a 400 that names the tier, the model runs on the default tier this long.
const REJECTED_MS = 60 * 60_000
const TIER_ERROR = /service[_ ]?tier|priority/i

function isPrimaryEditionRequest(event) {
  return isDndEdition(event) && event.agent !== "compaction" && (!event.kind || event.kind === "primary")
}

export function withServiceTier(body, tier = TIER) {
  if (!body || typeof body !== "object" || tier === "off" || tier === "default") return body
  if (body.service_tier) return body
  return { ...body, service_tier: tier }
}

export default {
  id: "dnd-fast-tier",
  async setup(ctx) {
    if (TIER === "off" || TIER === "default") return
    const rejected = new Map() // model -> until
    const sent = new Map() // sessionID -> { model, body }
    await ctx.session.hook("http.request", async (event) => {
      if (!isPrimaryEditionRequest(event)) return
      const original = event.request
      let body
      try {
        body = await original.clone().json()
      } catch {
        return
      }
      const model = typeof body?.model === "string" ? body.model : ""
      if ((rejected.get(model) ?? 0) > Date.now()) return
      const tiered = withServiceTier(body)
      if (tiered === body) return
      const headers = new Headers(original.headers)
      headers.delete("content-length")
      event.request = new Request(original, { headers, body: JSON.stringify(tiered) })
      if (event.sessionID) {
        sent.set(event.sessionID, { model, body })
        if (sent.size > 256) sent.delete(sent.keys().next().value)
      }
    })
    if (!ctx.session.hook) return
    await ctx.session.hook("http.response", async (event) => {
      // Title/compaction requests can share a session with a live narrator
      // request. They must neither consume its retry state nor replay its body.
      if ((event.kind && event.kind !== "primary") || event.agent === "compaction") return
      if (event.model && !isDndEdition(event)) return
      const entry = sent.get(event.sessionID)
      if (!entry) return
      sent.delete(event.sessionID)
      if (event.response?.status !== 400) return
      const detail = await event.response.clone().text().catch(() => "")
      if (!TIER_ERROR.test(detail)) return
      rejected.set(entry.model, Date.now() + REJECTED_MS)
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.response = await fetch(new Request(event.request, { headers, body: JSON.stringify(entry.body) }))
    })
  },
}

if (process.env.DND_FAST_TIER_SELF_CHECK) {
  if (withServiceTier({ model: "gpt-6-luna" }).service_tier !== "priority") throw new Error("priority tier not applied")
  if (withServiceTier({ model: "gpt-6-luna", service_tier: "flex" }).service_tier !== "flex") throw new Error("explicit tier must win")
  if ("service_tier" in withServiceTier({ model: "gpt-6-luna" }, "default")) throw new Error("default must not add a tier")
  const original = { model: "gpt-6-luna" }
  withServiceTier(original)
  if ("service_tier" in original) throw new Error("request body must not be mutated")
  console.log("dnd-fast-tier self-check OK")
}
