// Browser-safe catalog shared by the web and terminal preferences.
export const LIMIT_DEFS = [
  { id: "codex.primary", source: "codex", label: "ChatGPT · основное окно" },
  { id: "codex.secondary", source: "codex", label: "ChatGPT · дополнительное окно" },
  { id: "qwen.fiveHour", source: "qwen", label: "Alibaba · 5 ч" },
  { id: "qwen.sevenDay", source: "qwen", label: "Alibaba · 7 д" },
  { id: "gemini.minuteTokens", source: "gemini", label: "Gemini · токены/мин" },
  { id: "gemini.minuteRequests", source: "gemini", label: "Gemini · запросы/мин" },
  { id: "gemini.dailyRequests", source: "gemini", label: "Gemini · запросы/сутки" },
]

export function connectedLimitSources(models, { alibabaEnabled = true } = {}) {
  const sources = new Set()
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || model.enabled !== true || model.status === "deprecated" || typeof model.id !== "string" || !model.id.trim()) continue
    if (["openai", "chatgpt"].includes(model.providerID)) sources.add("codex")
    if (model.providerID === "bailian-cli" && alibabaEnabled) sources.add("qwen")
    if (model.providerID === "google" && /^gemini-/i.test(model.id)
      && !/image|embedding|tts|audio|live|robotics/i.test(model.id)) sources.add("gemini")
  }
  return ["codex", "qwen", "gemini"].filter((source) => sources.has(source))
}

export function selectedLimitIDs(models, hidden = [], options = {}) {
  const sources = connectedLimitSources(models, options)
  const excluded = new Set(Array.isArray(hidden) ? hidden : [])
  return LIMIT_DEFS.filter(({ id, source }) => sources.includes(source) && !excluded.has(id)).map(({ id }) => id)
}

export function trackedLimitSources(ids) {
  const selected = new Set(Array.isArray(ids) ? ids : [])
  return [...new Set(LIMIT_DEFS.filter(({ id }) => selected.has(id)).map(({ source }) => source))]
}
