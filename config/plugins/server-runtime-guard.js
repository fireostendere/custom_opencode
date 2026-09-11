
const WEB_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
const WEB_PORT = process.env.OPENCODE_WEB_PORT || "4098"
const TOKEN = process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const BASE = `http://${WEB_HOST}:${WEB_PORT}`
const TIMEOUT = Number(process.env.OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS || 1800)
const SECRET_PREFIXES = (process.env.OPENCODE_SECRET_PREFIXES || "TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_;GEMINI_;GOOGLE_").split(";").filter(Boolean)
// These credentials must never enter an agent shell, even when a configured
// broker scope explicitly grants other provider secrets to that shell.
const RESERVED_SECRETS = new Set([
  "OPENCODE_SERVER_PASSWORD", "OPENCODE_BACKEND_PASSWORD", "OPENCODE_RUNTIME_PLUGIN_TOKEN",
  "OPENCODE_OPENAI_ACCESS", "OPENCODE_OPENAI_REFRESH", "OPENCODE_ZEN_KEY", "OPENCODE_GO_KEY",
])
const CONTEXT_MARKER = "Server runtime context"

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
  for (const key of Object.keys(env || {})) if (RESERVED_SECRETS.has(key) || SECRET_PREFIXES.some((prefix)=>key.startsWith(prefix))) delete env[key]
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

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "custom-opencode.server-runtime-guard",
  setup: async (ctx)=>{
    await ctx.session.hook("context",async(event)=>{
      const sessionID=event?.sessionID || ""
      if (!sessionID || hasManagedContext(event.system)) return
      try {
        const managed=await call("/internal/runtime/context",{sessionID})
        const text=managed?.text || ""
        if (text) event.system.push({type:"text",text:`${CONTEXT_MARKER} (deduplicated, budgeted, checkpoint/RAG/repo aware):\n${text}`})
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

    // Adaptive context budget: the model can inspect and request expansion of its
    // session working budget, bounded by the real model limit and user policy.
    await ctx.tool.transform((tools)=>tools.add({
      name:"context_budget",
      description:"Inspect or expand this session's working context budget. action=status returns used/working/base/ceiling/model-limit/policy-max tokens; action=request asks the runtime to grant a larger working budget (bounded by the real model limit and user policy; never switches model or tariff).",
      input:{
        type:"object",
        required:["action"],
        properties:{
          action:{type:"string",enum:["status","request"],description:"status = inspect the budget, request = ask for more working context"},
          tokens:{type:"number",description:"Desired total working context in tokens (action=request)"},
          reason:{type:"string",description:"Why more working context is needed (action=request)"},
        },
      },
      options:{pinned:true,codemode:false},
      execute:async(input,context)=>{
        const result=await call("/internal/runtime/context-budget",{sessionID:String(context?.sessionID||""),action:String(input?.action||"status"),tokens:input?.tokens,reason:input?.reason})
        if(!result||result.ok===false) throw new Error(String(result?.error||"context budget unavailable"))
        return {content:JSON.stringify(result,null,1),metadata:result}
      },
    }))

    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before",async(event)=>{
        event.env ||= {}
        stripSecrets(event.env)
        const decision=await call("/internal/runtime/shell",{...contextOf(event),command:event.command,shell:event.shell})
        if (decision?.command) event.command=decision.command
        if (decision?.cwd) event.cwd=decision.cwd
        if (decision?.shell) event.shell=decision.shell
        Object.assign(event.env,decision?.env || {})
        for (const name of RESERVED_SECRETS) delete event.env[name]
      })
    }
  },
}
