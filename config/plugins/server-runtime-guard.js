import { define } from "@opencode-ai/plugin/v2/promise"

const WEB_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
const WEB_PORT = process.env.OPENCODE_WEB_PORT || "4098"
const TOKEN = process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const BASE = `http://${WEB_HOST}:${WEB_PORT}`
const TIMEOUT = Number(process.env.OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS || 1800)
const SECRET_PREFIXES = (process.env.OPENCODE_SECRET_PREFIXES || "TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_").split(";").filter(Boolean)
const CONTEXT_MARKER = "Server runtime context"
const CACHEABLE_TOOLS = ["read", "glob", "grep", "list", "lsp", "shell", "bash"]

async function call(path, payload) {
  if (!TOKEN) throw new Error("Runtime plugin token is not configured")
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "X-OpenCode-Runtime":TOKEN },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!response.ok) throw new Error(`runtime control ${response.status}: ${(await response.text()).slice(0,300)}`)
  return response.json()
}

function contextOf(event) {
  return {
    sessionID: event?.sessionID || event?.context?.sessionID || event?.metadata?.sessionID || "",
    cwd: event?.cwd || event?.directory || event?.context?.directory || "",
  }
}

function stripSecrets(env) {
  for (const key of Object.keys(env || {})) if (SECRET_PREFIXES.some((prefix)=>key.startsWith(prefix))) delete env[key]
}

function systemText(item) {
  if (typeof item === "string") return item
  if (item && typeof item === "object" && typeof item.text === "string") return item.text
  return ""
}

function hasManagedContext(system) {
  if (Array.isArray(system)) return system.some((item)=>systemText(item).includes(CONTEXT_MARKER))
  return systemText(system).includes(CONTEXT_MARKER)
}

function safeCacheTool(name,input) {
  if (["read","glob","grep","list","lsp"].includes(name)) return true
  if (!["shell","bash"].includes(name)) return name.endsWith("_knowledge_search") || name.endsWith("_knowledge_get") || name.endsWith("_knowledge_sources") || name.endsWith("_knowledge_status")
  const command=String(input?.command || "").trim().toLowerCase()
  if (!command || /[;&|><`]|\$\(/.test(command)) return false
  return ["git status","git diff","git log","git show","git rev-parse","git ls-files","tree","ls","pwd"].some((prefix)=>command===prefix || command.startsWith(`${prefix} `))
}

async function wrapCachedTools(ctx) {
  if (!ctx.tool?.transform) return
  await ctx.tool.transform((draft)=>{
    const names=new Set(CACHEABLE_TOOLS)
    try {
      for (const item of draft.list?.() || []) {
        const name=String(item?.id || item?.name || "")
        if (name.endsWith("_knowledge_search") || name.endsWith("_knowledge_get") || name.endsWith("_knowledge_sources") || name.endsWith("_knowledge_status")) names.add(name)
      }
    } catch {}
    for (const name of names) {
      let existing
      try { existing=draft.get?.(name) } catch { existing=null }
      if (!existing || typeof existing.execute !== "function") continue
      const original=existing.execute
      draft.update(name,(tool)=>{
        tool.execute=async(input,toolContext)=>{
          if (!safeCacheTool(name,input)) return original(input,toolContext)
          const sessionID=toolContext?.sessionID || ""
          const cwd=toolContext?.cwd || ctx.location?.directory || ""
          try {
            const hit=await call("/internal/runtime/tool-cache",{op:"get",sessionID,cwd,tool:name,input})
            if (hit?.hit) return hit.result
          } catch {}
          const result=await original(input,toolContext)
          try { await call("/internal/runtime/tool-cache",{op:"put",sessionID,cwd,tool:name,input,result}) } catch {}
          return result
        }
      })
    }
  })
}

export default define({
  id: "custom-opencode.server-runtime-guard",
  setup: async (ctx)=>{
    await wrapCachedTools(ctx)

    await ctx.session.hook("context",async(event)=>{
      const sessionID=event?.sessionID || ""
      if (!sessionID || hasManagedContext(event.system)) return
      try {
        const managed=await call("/internal/runtime/context",{sessionID})
        const text=managed?.text || ""
        if (text) event.system.push({text:`${CONTEXT_MARKER} (deduplicated, budgeted, checkpoint/RAG/repo aware):\n${text}`})
      } catch {
        // Additive only: native OpenCode context remains usable while the runtime restarts.
      }
    })

    await ctx.tool.hook("execute.before",async(event)=>{
      const c=contextOf(event)
      const decision=await call("/internal/runtime/tool-before",{...c,tool:event.tool,input:event.input})
      if (decision?.allow === false) throw new Error(decision.reason || "Tool denied by server runtime")
    })

    await ctx.tool.hook("execute.after",async(event)=>{
      const c=contextOf(event)
      try {
        const decision=await call("/internal/runtime/tool-after",{...c,tool:event.tool,result:event.result,output:event.output,outputPaths:event.outputPaths,status:event.status})
        if (decision?.replace) {
          event.result=decision.result
          if ("output" in event) event.output=decision.result
        }
      } catch {
        // Post-processing cannot turn an already successful tool into a failed tool.
      }
    })

    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before",async(event)=>{
        event.env ||= {}
        stripSecrets(event.env)
        const decision=await call("/internal/runtime/shell",{command:event.command,cwd:event.cwd,shell:event.shell,sessionID:""})
        if (decision?.command) event.command=decision.command
        if (decision?.cwd) event.cwd=decision.cwd
        if (decision?.shell) event.shell=decision.shell
        Object.assign(event.env,decision?.env || {})
      })
    }
  },
})
