import { isDndEdition } from "./orchestrated-qwen.js"

// GPT-6 Luna "Fast" is service_tier=priority. The bundled AI SDK drops
// providerOptions.serviceTier for model IDs it does not list as
// priority-capable (gpt-6-* included), so a variant setting never reaches the
// wire. Set it on the outgoing D&D Edition request instead.
// DND_FAST_TIER=default (or off) disables it.
const TIER = String(process.env.DND_FAST_TIER || "priority").toLowerCase()

export function withServiceTier(body, tier = TIER) {
  if (!body || typeof body !== "object" || tier === "off" || tier === "default") return body
  if (body.service_tier) return body
  return { ...body, service_tier: tier }
}

export default {
  id: "dnd-fast-tier",
  async setup(ctx) {
    if (TIER === "off" || TIER === "default") return
    await ctx.session.hook("http.request", async (event) => {
      if (!isDndEdition(event) || event.agent === "compaction") return
      const original = event.request
      let body
      try {
        body = await original.clone().json()
      } catch {
        return
      }
      const tiered = withServiceTier(body)
      if (tiered === body) return
      const headers = new Headers(original.headers)
      headers.delete("content-length")
      event.request = new Request(original, { headers, body: JSON.stringify(tiered) })
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
