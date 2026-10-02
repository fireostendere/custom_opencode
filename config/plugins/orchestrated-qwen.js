const TARGET_PROVIDER = "bailian-cli"
const TARGET_MODEL = "qwen3.8-orchestrated"
const DND_TOOLS = new Set(["odm_narrator", "odm_narrator_odm_narrator", "dnd_watch", "mcp_discover", "skill"])
for (const action of ["search", "get", "sources", "status"]) DND_TOOLS.add(`dnd_knowledge_${action}`)

export function isOrchestratedQwen(event) {
  return event?.model?.providerID === TARGET_PROVIDER && event?.model?.id === TARGET_MODEL
}
export function isOrchestratedSol(event) {
  return event?.model?.providerID === "openai" && event?.model?.id === "gpt-6-sol-orchestrated"
}
export function isDndEdition(event) {
  const modelID = event?.model?.id || event?.model?.modelID
  return event?.model?.providerID === "openai" && modelID === "gpt-6-dnd-edition"
}

export function isDndContext(event) {
  const agent = String(event?.agent || "")
  return isDndEdition(event) || agent.startsWith("dnd-") || agent.startsWith("narrator-")
}

export function dndToolName(tool) {
  return typeof tool === "string" ? tool : tool?.name || tool?.id || tool?.tool || ""
}

function describeDndKnowledge(name, tool) {
  if (name !== "dnd_knowledge_search" || !tool || typeof tool !== "object") return tool
  return {
    ...tool,
    description: "Search the connected D&D reference corpus. For rules, use English original rule names and filters.source='srd_5_1_ru' when that source is present: despite the folder name, its SRD 5.1 text is English and covers 2014 rules. For Russian Forgotten Realms lore, use filters.source='forgotten_realms_wiki_ru'; lore is not rules evidence. Check campaign edition and allowed sources first; SRD 5.1 cannot establish 2024 changes. Use compact=true, top_k=3; cite source and section, and get details when needed. Confidence is calibrated for engineering: if an exact relevant SRD section is present despite knowledge_gap=true, verify its text with dnd_knowledge_get before treating it as missing. Missing or irrelevant hits are a knowledge gap, never a rule ruling.",
  }
}

export function filterDndTools(tools) {
  if (Array.isArray(tools)) return tools.filter((tool) => DND_TOOLS.has(dndToolName(tool))).map(tool => describeDndKnowledge(dndToolName(tool), tool))
  if (tools && typeof tools === "object") {
    return Object.fromEntries(Object.entries(tools).filter(([name, tool]) => DND_TOOLS.has(name) || DND_TOOLS.has(dndToolName(tool)))
      .map(([name, tool]) => [name, describeDndKnowledge(DND_TOOLS.has(name) ? name : dndToolName(tool), tool)]))
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
  if (!isOrchestratedSol({ model: { providerID: "openai", id: "gpt-6-sol-orchestrated" } })) throw new Error("SOL target selector failed")
  if (isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: "qwen3.8-max" } })) throw new Error("ordinary Max must stay native")
  if (isOrchestratedSol({ model: { providerID: "openai", id: "gpt-6-sol-direct" } })) throw new Error("ordinary SOL must stay native")
  if (!isDndEdition({ model: { providerID: "openai", id: "gpt-6-dnd-edition" } })) throw new Error("DnD selector failed")
  if (isDndEdition({ model: { providerID: "openai", id: "gpt-6-sol-orchestrated" } })) throw new Error("SOL alias must stay SOL")
  if (!isDndContext({ agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-6-sol-direct" } })) throw new Error("DnD agent context selector failed")
  if (!isDndContext({ agent: "narrator-social", model: { providerID: "openai", id: "gpt-6-luna-direct" } })) throw new Error("ODM narrator context selector failed")
  if (isDndContext({ agent: "build", model: { providerID: "openai", id: "gpt-6-luna-direct" } })) throw new Error("ordinary direct model must stay native")
  const filtered = filterDndTools(["odm_narrator", "odm_narrator_odm_narrator", "odm_narrator_odm_campaigns", "mcp_discover", "shell", "kb_knowledge_search", "dnd_knowledge_search", "edit"])
  if (filtered.join(",") !== "odm_narrator,odm_narrator_odm_narrator,mcp_discover,dnd_knowledge_search") throw new Error("DnD tool filter failed")
  console.log("orchestrated-qwen self-check OK")
}
