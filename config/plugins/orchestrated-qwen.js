import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode-ai/plugin"

const TARGET_PROVIDER = "bailian-cli"
const TARGET_MODEL = "qwen3.8-orchestrated"
const MARKER = "Custom orchestrated Qwen policy"
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const PROMPT_PATH = process.env.OPENCODE_ORCHESTRATOR_PROMPT || join(CONFIG_DIR, "prompts", "orchestrator.md")

export function isOrchestratedQwen(event) {
  return event?.model?.providerID === TARGET_PROVIDER && event?.model?.id === TARGET_MODEL
}

function textOf(item) {
  if (typeof item === "string") return item
  if (item && typeof item === "object" && typeof item.text === "string") return item.text
  return ""
}

export default Plugin.define({
  id: "orchestrated-qwen",
  async setup(ctx) {
    const policy = readFileSync(PROMPT_PATH, "utf8").trim()
    if (!policy) throw new Error(`Orchestrator prompt is empty: ${PROMPT_PATH}`)

    await ctx.session.hook("context", async (event) => {
      if (!isOrchestratedQwen(event)) return
      if (Array.isArray(event.system) && event.system.some((item) => textOf(item).includes(MARKER))) return
      event.system.push({ text: `${MARKER}:\n${policy}` })
    })
  },
})

if (process.env.OPENCODE_ORCHESTRATED_QWEN_SELF_CHECK) {
  if (!isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: TARGET_MODEL } })) throw new Error("target selector failed")
  if (isOrchestratedQwen({ model: { providerID: TARGET_PROVIDER, id: "qwen3.8-max" } })) throw new Error("ordinary Max must stay native")
  console.log("orchestrated-qwen self-check OK")
}
