import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TARGET_PROVIDER = "bailian-cli"
const TARGET_MODEL = "qwen3.8-orchestrated"
const MARKER = "Custom orchestrated Qwen policy"
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const PROMPT_PATH = process.env.OPENCODE_ORCHESTRATOR_PROMPT || join(CONFIG_DIR, "prompts", "orchestrator.md")
const SOL_PROMPT_PATH = process.env.OPENCODE_SOL_ORCHESTRATOR_PROMPT || join(CONFIG_DIR, "prompts", "orchestrator-sol.md")
const TARGETS = {
  [`${TARGET_PROVIDER}/${TARGET_MODEL}`]: { marker: MARKER, promptPath: PROMPT_PATH },
  "openai/gpt-5.6-sol-orchestrated": { marker: "Custom orchestrated SOL policy", promptPath: SOL_PROMPT_PATH },
}

export function isOrchestratedQwen(event) {
  return event?.model?.providerID === TARGET_PROVIDER && event?.model?.id === TARGET_MODEL
}
export function isOrchestratedSol(event) {
  return event?.model?.providerID === "openai" && event?.model?.id === "gpt-5.6-sol-orchestrated"
}

function targetOf(event) {
  const provider = event?.model?.providerID || ""
  const model = event?.model?.id || ""
  return TARGETS[`${provider}/${model}`]
}

function textOf(item) {
  if (typeof item === "string") return item
  if (item && typeof item === "object" && typeof item.text === "string") return item.text
  return ""
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "orchestrated-qwen",
  async setup(ctx) {
    const policies = new Map(Object.entries(TARGETS).map(([target, config]) => {
      const policy = readFileSync(config.promptPath, "utf8").trim()
      if (!policy) throw new Error(`Orchestrator prompt is empty: ${config.promptPath}`)
      return [target, { ...config, policy }]
    }))

    await ctx.session.hook("context", async (event) => {
      const target = targetOf(event)
      if (!target) return
      const config = policies.get(`${event.model.providerID}/${event.model.id}`)
      if (!config || !Array.isArray(event.system)) return
      if (event.system.some((item) => textOf(item).includes(config.marker))) return
      event.system.push({ type: "text", text: `${config.marker}:\n${config.policy}` })
    })
  },
}

if (process.env.OPENCODE_ORCHESTRATED_QWEN_SELF_CHECK) {
  if (!isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: TARGET_MODEL } })) throw new Error("target selector failed")
  if (!isOrchestratedSol({ model: { providerID: "openai", id: "gpt-5.6-sol-orchestrated" } })) throw new Error("SOL target selector failed")
  if (isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: "qwen3.8-max" } })) throw new Error("ordinary Max must stay native")
  if (isOrchestratedSol({ model: { providerID: "openai", id: "gpt-5.6-sol" } })) throw new Error("ordinary SOL must stay native")
  console.log("orchestrated-qwen self-check OK")
}
