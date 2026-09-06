import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Plugin } from "@opencode-ai/plugin"

const TOOL = "plan_update"
const MARKER = "Custom visible plan policy"
const PLAN_AGENTS = new Set(["build", "build-direct", "plan", "plan-direct"])
const BUILD_AGENTS = new Set(["build", "build-direct"])
const PLAN_FREE_TOOLS = new Set([
  TOOL, "read", "glob", "grep", "list", "lsp", "question", "skill",
  "webfetch", "websearch", "fetch", "kb_knowledge_search", "kb_knowledge_get",
  "kb_knowledge_sources", "kb_knowledge_status",
])
const STATUS_MARKER = { pending: " ", in_progress: ">", completed: "x" }
const configuredDirectory = String(process.env.OPENCODE_PLAN_DIRECTORY || "").trim()
const PLAN_DIRECTORY = configuredDirectory
  ? resolve(configuredDirectory.replace(/^~(?=\/)/, homedir()))
  : join(homedir(), ".opencode", "plan")

const POLICY = `For every primary-agent request that uses tools, changes state, or requires more than one meaningful step, publish a concise visible plan with ${TOOL}. You may inspect read-only context first, but in Build call ${TOOL} before the first shell, edit, write, patch, subagent, or other potentially state-changing tool; in Plan publish the resulting checklist before the final answer. If you form a plan in hidden reasoning for any reason, publish its outcome checklist instead of keeping it only in hidden reasoning. Keep 1-7 outcome-oriented items, mark the current item in_progress, update statuses as work advances, and mark finished items completed before the final answer. Do not expose chain-of-thought or private reasoning; publish only the short task checklist. A direct conversational answer that uses no tools and has no multi-step work does not need a synthetic plan.`

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "todos"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200, description: "Short plan title" },
    todos: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "status"],
        properties: {
          content: { type: "string", minLength: 1, maxLength: 500, description: "Verifiable outcome, not a low-level command" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        },
      },
    },
  },
}

function oneLine(value, limit, label) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) throw new Error(`${label} is required`)
  return text.slice(0, limit)
}

function planText(input) {
  const title = oneLine(input?.title, 200, "title")
  if (!Array.isArray(input?.todos) || input.todos.length < 1 || input.todos.length > 7) {
    throw new Error("todos must contain 1-7 items")
  }
  const lines = input.todos.map((todo) => {
    const status = String(todo?.status || "")
    if (!Object.hasOwn(STATUS_MARKER, status)) throw new Error(`invalid plan status: ${status}`)
    return `- [${STATUS_MARKER[status]}] ${oneLine(todo?.content, 500, "todo content")}`
  })
  return `# ${title}\n\n${lines.join("\n")}\n`
}

function writePlan(sessionID, input) {
  const id = String(sessionID || "")
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(id)) throw new Error("invalid session id")
  const text = planText(input)
  const filename = `${id}-plan.md`
  const target = join(PLAN_DIRECTORY, filename)
  mkdirSync(PLAN_DIRECTORY, { recursive: true, mode: 0o700 })
  if (existsSync(target) && readFileSync(target, "utf8") === text) {
    chmodSync(target, 0o600)
    return filename
  }
  const temporary = join(PLAN_DIRECTORY, `.${id}-${process.pid}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" })
    renameSync(temporary, target)
    chmodSync(target, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
  return filename
}

function textOf(value) {
  return typeof value === "string" ? value : String(value?.text || "")
}

function turnKey(messages) {
  const users = Array.isArray(messages) ? messages.filter((message) => message?.role === "user") : []
  const latest = users.at(-1)
  return `${users.length}:${JSON.stringify(latest?.content || latest || "").slice(-4000)}`
}

export default Plugin.define({
  id: "custom.visible-plan",
  async setup(ctx) {
    const turns = new Map()
    const registrations = await Promise.all([
      ctx.tool.transform((tools) => tools.add({
        name: TOOL,
        description: "Publish or update the concise task plan shown in the web Plan card and workspace sidebar. This is a checklist, never chain-of-thought.",
        input: inputSchema,
        options: { pinned: true, codemode: false },
        execute: async (input, context) => {
          const filename = writePlan(context.sessionID, input)
          const turn = turns.get(String(context.sessionID)) || {}
          turns.set(String(context.sessionID), { ...turn, planned: true })
          return { content: `Visible plan updated (${input.todos.length} items).`, metadata: { filename } }
        },
      })),
      ctx.session.hook("context", (event) => {
        const agent = String(event?.agent || "")
        if (!PLAN_AGENTS.has(agent) || !Array.isArray(event.system)) return
        const sessionID = String(event.sessionID || "")
        const key = turnKey(event.messages)
        const previous = turns.get(sessionID)
        turns.set(sessionID, { key, planned: previous?.key === key && previous.planned === true, gated: BUILD_AGENTS.has(agent) })
        if (turns.size > 512) turns.delete(turns.keys().next().value)
        if (!event.system.some((item) => textOf(item).includes(MARKER))) {
          event.system.push({ type: "text", text: `${MARKER}:\n${POLICY}` })
        }
      }),
      ctx.tool.hook("execute.before", (event) => {
        const turn = turns.get(String(event.sessionID || ""))
        if (!turn?.gated) return
        if (PLAN_FREE_TOOLS.has(String(event.tool || ""))) return
        if (turn.planned === true) return
        throw new Error(`Publish the visible plan with ${TOOL} before using ${event.tool}.`)
      }),
    ])
    return async () => {
      turns.clear()
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
  },
})
