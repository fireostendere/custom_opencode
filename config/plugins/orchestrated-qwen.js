const TARGET_PROVIDER = "bailian-cli"
const TARGET_MODEL = "qwen3.8-orchestrated"
const DND_TOOLS = new Set(["odm_narrator", "skill", "kb_knowledge_search", "kb_knowledge_get", "kb_knowledge_sources", "kb_knowledge_status"])

export function isOrchestratedQwen(event) {
  return event?.model?.providerID === TARGET_PROVIDER && event?.model?.id === TARGET_MODEL
}
export function isOrchestratedSol(event) {
  return event?.model?.providerID === "openai" && event?.model?.id === "gpt-5.6-sol-orchestrated"
}
export function isDndEdition(event) {
  return event?.model?.providerID === "openai" && event?.model?.id === "gpt-5.6-dnd-edition"
}

export function isDndContext(event) {
  return isDndEdition(event) || String(event?.agent || "").startsWith("dnd-")
}

export function dndToolName(tool) {
  return typeof tool === "string" ? tool : tool?.name || tool?.id || tool?.tool || ""
}

export function filterDndTools(tools) {
  if (Array.isArray(tools)) return tools.filter((tool) => DND_TOOLS.has(dndToolName(tool)))
  if (tools && typeof tools === "object") {
    return Object.fromEntries(Object.entries(tools).filter(([name, tool]) => DND_TOOLS.has(name) || DND_TOOLS.has(dndToolName(tool))))
  }
  return tools
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "orchestrated-qwen",
  async setup(ctx) {
    // Context policy injection is centralized in context-lanes.js. Keep only
    // the DnD tool allowlist here so the Edition remains game-only even in bare mode.
    await ctx.session.hook("context", async (event) => {
      if (isDndContext(event) && event.tools) event.tools = filterDndTools(event.tools)
    })
  },
}

if (process.env.OPENCODE_ORCHESTRATED_QWEN_SELF_CHECK) {
  if (!isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: TARGET_MODEL } })) throw new Error("target selector failed")
  if (!isOrchestratedSol({ model: { providerID: "openai", id: "gpt-5.6-sol-orchestrated" } })) throw new Error("SOL target selector failed")
  if (isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: "qwen3.8-max" } })) throw new Error("ordinary Max must stay native")
  if (isOrchestratedSol({ model: { providerID: "openai", id: "gpt-5.6-sol" } })) throw new Error("ordinary SOL must stay native")
  if (!isDndEdition({ model: { providerID: "openai", id: "gpt-5.6-dnd-edition" } })) throw new Error("DnD selector failed")
  if (isDndEdition({ model: { providerID: "openai", id: "gpt-5.6-sol-orchestrated" } })) throw new Error("SOL alias must stay SOL")
  if (!isDndContext({ agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-5.6-sol" } })) throw new Error("DnD agent context selector failed")
  const filtered = filterDndTools(["odm_narrator", "shell", "kb_knowledge_search", "edit"])
  if (filtered.join(",") !== "odm_narrator,kb_knowledge_search") throw new Error("DnD tool filter failed")
  console.log("orchestrated-qwen self-check OK")
}
