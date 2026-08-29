import { Plugin } from "@opencode-ai/plugin/v2"

const WEB_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
const WEB_PORT = process.env.OPENCODE_WEB_PORT || "4098"
const TOKEN = process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const BASE = `http://${WEB_HOST}:${WEB_PORT}`
const TIMEOUT = Number(process.env.OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS || 1800)
const SECRET_PREFIXES = (process.env.OPENCODE_SECRET_PREFIXES || "TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_").split(";").filter(Boolean)
const CONTEXT_MARKER = "Server runtime context"

async function call(path, payload) {
  if (!TOKEN) throw new Error("Runtime plugin token is not configured")
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenCode-Runtime": TOKEN },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!response.ok) throw new Error(`runtime control ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.json()
}

function contextOf(event) {
  return {
    sessionID: event?.sessionID || event?.context?.sessionID || event?.metadata?.sessionID || "",
    cwd: event?.cwd || event?.directory || event?.context?.directory || "",
  }
}

function stripSecrets(env) {
  for (const key of Object.keys(env || {})) {
    if (SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key]
  }
}

function hasManagedContext(system) {
  if (Array.isArray(system)) return system.some((item) => String(item || "").includes(CONTEXT_MARKER))
  return String(system || "").includes(CONTEXT_MARKER)
}

export default Plugin.define({
  id: "custom-opencode.server-runtime-guard",
  setup: async (ctx) => {
    await ctx.session.hook("request", async (event) => {
      const sessionID = event?.sessionID || event?.session?.id || ""
      if (!sessionID || hasManagedContext(event.system)) return
      try {
        const managed = await call("/internal/runtime/context", { sessionID })
        const text = managed?.text || ""
        if (text) {
          const block = `${CONTEXT_MARKER} (deduplicated, budgeted, checkpoint/RAG/repo aware):\n${text}`
          if (Array.isArray(event.system)) event.system.push(block)
          else if (typeof event.system === "string") event.system = `${event.system}\n\n${block}`
          else event.system = block
        }
      } catch {
        // Context injection is additive: native OpenCode context remains usable while web runtime restarts.
      }
    })

    await ctx.tool.hook("execute.before", async (event) => {
      const c = contextOf(event)
      const decision = await call("/internal/runtime/tool-before", { ...c, tool: event.tool, input: event.input })
      if (decision?.allow === false) throw new Error(decision.reason || "Tool denied by server runtime")
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const c = contextOf(event)
      try {
        const decision = await call("/internal/runtime/tool-after", {
          ...c,
          tool: event.tool,
          result: event.result,
          output: event.output,
          outputPaths: event.outputPaths,
          status: event.status,
        })
        if (decision?.replace) {
          event.result = decision.result
          if ("output" in event) event.output = decision.result
        }
      } catch {
        // Post-processing failure must not turn an already successful tool into a failed tool.
      }
    })

    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before", async (event) => {
        event.env ||= {}
        stripSecrets(event.env)
        const decision = await call("/internal/runtime/shell", {
          command: event.command,
          cwd: event.cwd,
          shell: event.shell,
          sessionID: event.sessionID || "",
        })
        if (decision?.command) event.command = decision.command
        if (decision?.cwd) event.cwd = decision.cwd
        if (decision?.shell) event.shell = decision.shell
        Object.assign(event.env, decision?.env || {})
      })
    }
  },
})
