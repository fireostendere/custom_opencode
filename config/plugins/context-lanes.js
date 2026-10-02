import { createRequire } from "node:module"
import { lstatSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { startEvents } from "../events.js"
import {
  managedOrchestration,
  isDndLane,
  isIsolatedNarratorRole,
  resolveContextPolicy,
  setSessionContextClass,
} from "./tui/lib/context-policy.js"

const require = createRequire(import.meta.url)
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const DATA_DIR = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const ENGINEERING = readFileSync(join(CONFIG_DIR, "prompts", "engineering.md"), "utf8").trim()
const ENGINEERING_LITE = readFileSync(join(CONFIG_DIR, "prompts", "engineering-lite.md"), "utf8").trim()
const PLAN_POLICY =
  "Use plan_update only for complex or risky multi-step work. Keep 1-7 outcome-oriented items, update only at meaningful milestones in the same step as other tool calls (never a plan-only step), and never expose private reasoning."
// dnd-edition.md owns the table style; yolo-dm stays a discoverable skill.
const GAME_SKILLS = ["odm-dm-policy", "odm-narrator", "dnd-session"]
const GAME_SKILL_TTL_MS = 5 * 60_000
const GAME_SKILL_RETRY_MS = 30_000
const GAME_SKILL_COLD_RETRIES = 6
const GAME_SKILL_COLD_DELAY_MS = 500
const PLAN_AGENTS = new Set(["build", "build-direct", "plan", "plan-direct"])
const OWN_MARKERS = [
  "Custom engineering policy",
  "Custom lite execution kernel",
  "Ponytail V2 engineering policy",
  "Custom visible plan policy",
  "Custom orchestrated Qwen policy",
  "Custom orchestrated SOL policy",
  "Custom DnD Edition policy",
  "Required game skill already loaded:",
  "Managed orchestration ",
]

const STATIC_ORCHESTRATIONS = {
  "bailian-cli/qwen3.8-orchestrated": {
    marker: "Custom orchestrated Qwen policy",
    path: process.env.OPENCODE_ORCHESTRATOR_PROMPT || join(CONFIG_DIR, "prompts", "orchestrator.md"),
  },
  "openai/gpt-6-sol-orchestrated": {
    marker: "Custom orchestrated SOL policy",
    path:
      process.env.OPENCODE_SOL_ORCHESTRATOR_PROMPT ||
      join(CONFIG_DIR, "prompts", "orchestrator-sol.md"),
  },
  "openai/gpt-6-dnd-edition": {
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
  // The isolated host installs a role-specific JSON/prose system contract.
  // Do not append the interactive DM prompt, even for a D&D Edition model ID.
  if (isIsolatedNarratorRole(event)) return null
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

let ponytailCache = null

function statKey(path) {
  try {
    const info = lstatSync(path)
    return `${info.isFile() && !info.isSymbolicLink() ? "file" : "other"}:${info.mtimeMs}:${info.size}`
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : `error:${error.code}`
  }
}

function buildPonytailPolicy(root, target) {
  let upstream
  try {
    upstream = {
      ...require(join(root, "hooks", "ponytail-instructions.js")),
      ...require(join(root, "hooks", "ponytail-config.js")),
    }
  } catch (error) {
    console.warn(`[context-lanes] Ponytail checkout unavailable; policy skipped: ${error?.message ?? error}`)
    return ""
  }
  let mode
  try {
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Ponytail state path")
    mode = upstream.normalizePersistedMode(readFileSync(target, "utf8").trim())
    if (!["off", "lite", "full", "ultra"].includes(mode)) throw new Error("Invalid Ponytail mode in state file")
  } catch (error) {
    // A bad state file must never fail every model request.
    if (error.code !== "ENOENT") console.warn(`[context-lanes] ${error.message}; using the default Ponytail mode`)
    mode = upstream.getDefaultMode()
  }
  if (mode === "off") return ""
  if (!["lite", "full", "ultra"].includes(mode)) return ""
  return `Ponytail V2 engineering policy (${mode}):\n${upstream.getPonytailInstructions(mode)}`
}

/** Rebuilt only when the mode file or the upstream skill changes (mtime/size). */
function ponytailPolicy() {
  if (process.env.PONYTAIL_ENABLED === "0") return ""
  const root = process.env.PONYTAIL_CHECKOUT_DIR || join(DATA_DIR, "opencode", "ponytail")
  const stateDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const target = join(stateDir, ".ponytail-active")
  const key = JSON.stringify([root, target, statKey(target), statKey(join(root, "skills", "ponytail", "SKILL.md"))])
  if (ponytailCache?.key !== key) ponytailCache = { key, text: buildPonytailPolicy(root, target) }
  return ponytailCache.text
}

function removeOwned(parts) {
  return parts.filter((part) => {
    const text = textOf(part)
    return !OWN_MARKERS.some((marker) => text.startsWith(marker))
  })
}

// D&D lane: the operator and the game share one chat. The dnd-watch host
// announces its wake signals by prefix; anything else the operator typed is
// labeled out-of-game for this request only (history is never rewritten), so
// a debug question gets an answer here instead of becoming a scene at the
// table.
export const OPERATOR_MARKER =
  "[Оператор, вне игры. Команду вести игру выполни инструментами, в кампанию — только мир. Вопрос, отладку или жалобу обсуди только здесь: в кампанию ничего не пиши и не цитируй.]"
const HOST_SIGNALS = ["DnD auto-watch:", "DnD watcher:", "Context class:"]

export function labelOperatorTurn(messages) {
  let index = -1
  for (let i = messages.length - 1; i >= 0; i -= 1)
    if (messages[i]?.role === "user") {
      index = i
      break
    }
  const turn = index >= 0 ? messages[index] : undefined
  // Compaction and session.generate prompts carry no id: not the operator.
  if (!turn?.id) return messages
  const content = Array.isArray(turn.content)
    ? turn.content
    : typeof turn.content === "string"
      ? [{ type: "text", text: turn.content }]
      : []
  const first = String(content.find((part) => part?.type === "text")?.text ?? "").trimStart()
  if (!first || first.startsWith(OPERATOR_MARKER) || HOST_SIGNALS.some((signal) => first.startsWith(signal)))
    return messages
  const next = messages.slice()
  next[index] = { ...turn, content: [{ type: "text", text: OPERATOR_MARKER }, ...content] }
  return next
}

export default {
  id: "custom.context-lanes",
  async setup(ctx) {
    const registrations = []
    // The skill catalog is 0.5-0.8 MB: fetch the game skills once and
    // refresh them only on skill reload (or a bounded TTL as a safety net).
    let gameSkills = null
    const requiredGameSkills = async () => {
      if (gameSkills && Date.now() < gameSkills.until) return gameSkills.items
      // A fresh project instance lists skills before its configured skill paths are
      // scanned. Without a short retry the first turn goes out without the policy and the
      // model loads ~14 KB of skills into its history; a partial list never replaces a
      // complete one (that would also change the cached system prompt mid-session).
      for (let attempt = 0; ; attempt++) {
        const catalog = await ctx.skill.list()
        const skills = Array.isArray(catalog) ? catalog : catalog?.data || []
        const items = GAME_SKILLS.flatMap((id) => {
          const content = skills.find((item) => item.id === id)?.content
          return content ? [[id, content]] : []
        })
        if (items.length === GAME_SKILLS.length) {
          gameSkills = { items, complete: true, until: Date.now() + GAME_SKILL_TTL_MS }
          return items
        }
        if (gameSkills?.complete) return gameSkills.items
        if (attempt >= GAME_SKILL_COLD_RETRIES) {
          gameSkills = { items, until: Date.now() + GAME_SKILL_RETRY_MS }
          return items
        }
        await new Promise((resolve) => setTimeout(resolve, GAME_SKILL_COLD_DELAY_MS))
      }
    }
    const stopEvents = ctx.event?.subscribe
      ? startEvents(ctx, (event) => {
          if (event?.type === "skill.updated") gameSkills = null
        })
      : () => {}
    registrations.push(
      await ctx.session.hook("context", async (event) => {
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
        if (policy.dndMinimalContext && ctx.skill?.list) {
          for (const [id, content] of await requiredGameSkills())
            event.system.push({ type: "text", text: `Required game skill already loaded: ${id}\n${content}` })
        }
        if (policy.dndMinimalContext && Array.isArray(event.messages)) event.messages = labelOperatorTurn(event.messages)
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

    return async () => {
      stopEvents()
      return Promise.allSettled(registrations.map((registration) => registration?.dispose?.()))
    }
  },
}
