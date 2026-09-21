import { createRequire } from "node:module"
import { lstatSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  managedOrchestration,
  isDndLane,
  resolveContextPolicy,
  setSessionContextClass,
} from "./tui/lib/context-policy.js"

const require = createRequire(import.meta.url)
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const DATA_DIR = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const ENGINEERING = readFileSync(join(CONFIG_DIR, "prompts", "engineering.md"), "utf8").trim()
const ENGINEERING_LITE = readFileSync(join(CONFIG_DIR, "prompts", "engineering-lite.md"), "utf8").trim()
const PLAN_POLICY =
  "Use plan_update only for complex or risky multi-step work. Keep 1-7 outcome-oriented items, update meaningful milestones, and never expose private reasoning."
const PLAN_AGENTS = new Set(["build", "build-direct", "plan", "plan-direct"])
const OWN_MARKERS = [
  "Custom engineering policy",
  "Custom lite execution kernel",
  "Ponytail V2 engineering policy",
  "Custom visible plan policy",
  "Custom orchestrated Qwen policy",
  "Custom orchestrated SOL policy",
  "Custom DnD Edition policy",
  "Managed orchestration ",
]

const STATIC_ORCHESTRATIONS = {
  "bailian-cli/qwen3.8-orchestrated": {
    marker: "Custom orchestrated Qwen policy",
    path: process.env.OPENCODE_ORCHESTRATOR_PROMPT || join(CONFIG_DIR, "prompts", "orchestrator.md"),
  },
  "openai/gpt-5.6-sol-orchestrated": {
    marker: "Custom orchestrated SOL policy",
    path:
      process.env.OPENCODE_SOL_ORCHESTRATOR_PROMPT ||
      join(CONFIG_DIR, "prompts", "orchestrator-sol.md"),
  },
  "openai/gpt-5.6-dnd-edition": {
    marker: "Custom DnD Edition policy",
    path: process.env.OPENCODE_DND_EDITION_PROMPT || join(CONFIG_DIR, "prompts", "dnd-edition.md"),
  },
}
const staticPromptCache = new Map()

function textOf(item) {
  if (typeof item === "string") return item
  if (item && typeof item === "object" && typeof item.text === "string") return item.text
  return ""
}

function orchestrationFor(event) {
  if (isDndLane(event)) {
    const path = process.env.OPENCODE_DND_EDITION_PROMPT || join(CONFIG_DIR, "prompts", "dnd-edition.md")
    let prompt = staticPromptCache.get("dnd-lane")
    if (!prompt) {
      prompt = readFileSync(path, "utf8").trim()
      if (!prompt) throw new Error(`Orchestrator prompt is empty: ${path}`)
      staticPromptCache.set("dnd-lane", prompt)
    }
    return { marker: "Custom DnD Edition policy", prompt }
  }
  const managed = managedOrchestration(event)
  if (managed)
    return {
      marker: `Managed orchestration ${managed.providerID}/${managed.id}`,
      prompt: managed.prompt,
    }
  const key = `${String(event?.model?.providerID || "")}/${String(event?.model?.id || "")}`
  const staticItem = STATIC_ORCHESTRATIONS[key]
  if (!staticItem) return null
  let prompt = staticPromptCache.get(key)
  if (!prompt) {
    prompt = readFileSync(staticItem.path, "utf8").trim()
    if (!prompt) throw new Error(`Orchestrator prompt is empty: ${staticItem.path}`)
    staticPromptCache.set(key, prompt)
  }
  return { marker: staticItem.marker, prompt }
}

function ponytailPolicy() {
  if (process.env.PONYTAIL_ENABLED === "0") return ""
  const root = process.env.PONYTAIL_CHECKOUT_DIR || join(DATA_DIR, "opencode", "ponytail")
  const { getPonytailInstructions } = require(join(root, "hooks", "ponytail-instructions.js"))
  const { getDefaultMode, normalizePersistedMode } = require(join(root, "hooks", "ponytail-config.js"))
  const stateDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const target = join(stateDir, ".ponytail-active")
  let mode
  try {
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Ponytail state path")
    mode = normalizePersistedMode(readFileSync(target, "utf8").trim())
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    mode = getDefaultMode()
  }
  if (mode === "off") return ""
  if (!["lite", "full", "ultra"].includes(mode)) throw new Error("Invalid Ponytail mode in state file")
  return `Ponytail V2 engineering policy (${mode}):\n${getPonytailInstructions(mode)}`
}

function removeOwned(parts) {
  return parts.filter((part) => {
    const text = textOf(part)
    return !OWN_MARKERS.some((marker) => text.startsWith(marker))
  })
}

export default {
  id: "custom.context-lanes",
  async setup(ctx) {
    const registrations = []
    registrations.push(
      await ctx.session.hook("context", (event) => {
        if (!Array.isArray(event.system)) return
        const policy = resolveContextPolicy(event)
        const orchestration = orchestrationFor(event)

        if (policy.clearNative) event.system.length = 0
        else event.system = removeOwned(event.system)

        if (policy.engineering === "lite")
          event.system.push({
            type: "text",
            text: `Custom lite execution kernel:\n${ENGINEERING_LITE}`,
          })
        else if (policy.engineering === "full")
          event.system.push({
            type: "text",
            text: `Custom engineering policy:\n${ENGINEERING}`,
          })

        if (policy.ponytail) {
          const ponytail = ponytailPolicy()
          if (ponytail) event.system.push({ type: "text", text: ponytail })
        }

        if (policy.planPrompt && PLAN_AGENTS.has(String(event?.agent || "")))
          event.system.push({
            type: "text",
            text: `Custom visible plan policy:\n${PLAN_POLICY}`,
          })

        if (orchestration)
          event.system.push({
            type: "text",
            text: `${orchestration.marker}:\n${orchestration.prompt}`,
          })
      }),
    )

    registrations.push(
      await ctx.command.transform((commands) =>
        commands.add({
          name: "contextclass",
          description: "Show or override this session context class: bare/lite/normal/full/auto",
          execute: async ({ sessionID, prompt }) => {
            const requested = String(prompt?.text || "").trim()
            const value = setSessionContextClass(sessionID, requested || "auto")
            await ctx.session.synthetic({
              sessionID,
              text: `Context class: ${value}`,
              resume: false,
            })
          },
        }),
      ),
    )

    return async () =>
      Promise.allSettled(registrations.map((registration) => registration?.dispose?.()))
  },
}
