const VALID = new Set(["bare", "lite", "normal", "full"])
const managed = new Map()
const sessions = new Map()
let overrideRaw = null
let overrides = {}

const AGENT_DEFAULTS = new Map([
  ["title", "bare"],
  ["summary", "bare"],
  ["fast-reader", "lite"],
  ["sol-fast-reader", "lite"],
])

const MODEL_DEFAULTS = new Map([
  ["bailian-cli/qwen3.8-orchestrated", "full"],
  ["openai/gpt-5.6-sol-orchestrated", "full"],
  ["bailian-cli/qwen3.8-flash", "lite"],
])

export function normalizeContextClass(value, fallback = "normal") {
  const resolved = String(value || "").trim().toLowerCase()
  return VALID.has(resolved) ? resolved : fallback
}

function modelKey(event) {
  const provider = String(event?.model?.providerID || "")
  const model = String(event?.model?.id || event?.model?.modelID || "")
  return provider && model ? `${provider}/${model}` : ""
}

function configuredOverrides() {
  const raw = String(process.env.OPENCODE_CONTEXT_CLASS_OVERRIDES || "").trim()
  if (raw === overrideRaw) return overrides
  overrideRaw = raw
  overrides = {}
  if (!raw) return overrides
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return overrides
    for (const [key, item] of Object.entries(value)) {
      const resolved = normalizeContextClass(item, "")
      if (resolved) overrides[String(key)] = resolved
    }
  } catch {
    // Invalid optional overrides never break inference; the regression suite
    // verifies explicit registry policy instead.
  }
  return overrides
}

export function syncManagedOrchestrations(orchestrations = {}) {
  managed.clear()
  for (const [key, raw] of Object.entries(orchestrations || {})) {
    if (!raw || typeof raw !== "object") continue
    const providerID = String(raw.providerID || key.split("/", 1)[0] || "")
    const id = String(raw.id || key.slice(key.indexOf("/") + 1) || "")
    const prompt = String(raw.prompt || "").trim()
    if (!providerID || !id || !prompt) continue
    managed.set(`${providerID}/${id}`, {
      ...raw,
      providerID,
      id,
      prompt,
      contextClass: normalizeContextClass(raw.contextClass, "full"),
    })
  }
}

export function managedOrchestration(event) {
  return managed.get(modelKey(event)) || null
}

export function setSessionContextClass(sessionID, value) {
  const id = String(sessionID || "")
  if (!id) throw new Error("sessionID required")
  const requested = String(value || "").trim().toLowerCase()
  if (!requested || requested === "auto") {
    sessions.delete(id)
    return "auto"
  }
  const resolved = normalizeContextClass(requested, "")
  if (!resolved) throw new Error("context class must be bare, lite, normal, full or auto")
  sessions.set(id, resolved)
  if (sessions.size > 1024) sessions.delete(sessions.keys().next().value)
  return resolved
}

export function resolveContextClass(event) {
  const sessionID = String(event?.sessionID || "")
  if (sessionID && sessions.has(sessionID)) return sessions.get(sessionID)

  const key = modelKey(event)
  const item = managed.get(key)
  if (item?.contextClass) return item.contextClass

  const configured = configuredOverrides()
  if (configured[key]) return configured[key]

  const agent = String(event?.agent || "")
  if (AGENT_DEFAULTS.has(agent)) return AGENT_DEFAULTS.get(agent)
  if (MODEL_DEFAULTS.has(key)) return MODEL_DEFAULTS.get(key)

  const provider = String(event?.model?.providerID || "")
  const model = String(event?.model?.id || event?.model?.modelID || "")
  if (provider === "ollama") return "lite"
  if (provider === "bailian-cli" && /(?:^|[-_.])flash(?:$|[-_.])/i.test(model)) return "lite"

  return normalizeContextClass(process.env.OPENCODE_CONTEXT_DEFAULT_CLASS, "normal")
}

export function resolveContextPolicy(event) {
  const contextClass = resolveContextClass(event)
  if (contextClass === "bare")
    return {
      contextClass,
      clearNative: true,
      engineering: false,
      ponytail: false,
      planPrompt: false,
      runtime: false,
      runtimeBudgetChars: 0,
      semanticRepo: false,
      rag: false,
    }
  if (contextClass === "lite")
    return {
      contextClass,
      clearNative: true,
      engineering: "lite",
      ponytail: false,
      planPrompt: false,
      runtime: true,
      runtimeBudgetChars: 4000,
      semanticRepo: false,
      rag: false,
    }
  if (contextClass === "full")
    return {
      contextClass,
      clearNative: false,
      engineering: "full",
      ponytail: true,
      planPrompt: true,
      runtime: true,
      runtimeBudgetChars: 24000,
      semanticRepo: true,
      rag: true,
    }
  return {
    contextClass: "normal",
    clearNative: false,
    engineering: "full",
    ponytail: true,
    planPrompt: true,
    runtime: true,
    runtimeBudgetChars: 12000,
    semanticRepo: true,
    rag: true,
  }
}
