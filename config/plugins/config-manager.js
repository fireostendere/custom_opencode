import { homedir } from "node:os"
import { join } from "node:path"
import { appendFile } from "node:fs/promises"
import { Plugin } from "@opencode-ai/plugin"
import { filterMcpTools, resolveMcpProfile, mcpNamespace } from "./tui/lib/mcp-profiles.js"

const STORAGE_KEY = "registry-v2"
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/
const SENSITIVE_NAME_RE = /(?:^|[-_])(?:api[-_]?key|key|token|access[-_]?token|secret|password|passphrase|authorization|auth|credential)(?:$|[-_])/i

function emptyRegistry() {
  return { version: 2, providers: {}, models: {}, mcp: {}, skills: {}, orchestrations: {}, mcpProfiles: {}, mcpSettings: { mode: "auto", sessions: {} } }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function normalizeRegistry(value) {
  const raw = asObject(value)
  return {
    ...raw,
    version: 2,
    providers: asObject(raw.providers),
    models: asObject(raw.models),
    mcp: asObject(raw.mcp),
    skills: asObject(raw.skills),
    orchestrations: asObject(raw.orchestrations),
    mcpProfiles: asObject(raw.mcpProfiles),
    mcpSettings: { mode: "auto", ...asObject(raw.mcpSettings), sessions: asObject(raw.mcpSettings?.sessions) },
  }
}

function assertID(value, label = "id") {
  const id = String(value || "").trim()
  if (!ID_RE.test(id)) throw new Error(`${label} must match ${ID_RE}`)
  return id
}

function assertModelID(value, label = "modelID") {
  const id = String(value || "").trim()
  if (!id || id.length > 200 || id.includes("#")) throw new Error(`${label} is invalid`)
  return id
}

function isSafeSecretReference(value) {
  return typeof value !== "string" || !value || ENV_REF_RE.test(value)
}

function isSensitiveName(value) {
  return SENSITIVE_NAME_RE.test(String(value).replace(/([a-z])([A-Z])/g, "$1_$2"))
}

function assertCredentialReference(name, value) {
  if (isSensitiveName(name) && !ENV_REF_RE.test(String(value || "").trim())) throw new Error(`${name} must use {env:VAR}`)
}

function rejectInlineSecrets(value, path = "definition") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInlineSecrets(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value)) {
    const next = `${path}.${key}`
    if (isSensitiveName(key) && typeof item === "string" && !isSafeSecretReference(item)) {
      throw new Error(`${next} must use {env:VAR}; literal secrets are not stored`)
    }
    rejectInlineSecrets(item, next)
  }
}

function extractJson(prompt) {
  const text = String(prompt?.text || "").trim()
  const start = text.indexOf("{")
  if (start < 0) throw new Error("JSON argument is required")
  let value
  try { value = JSON.parse(text.slice(start)) } catch (error) { throw new Error(`invalid JSON: ${error.message}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object is required")
  return value
}

function providerDefinition(input) {
  const id = assertID(input.id, "provider id")
  const definition = {
    name: String(input.name || id).slice(0, 120),
    package: String(input.package || "@opencode-ai/ai/providers/openai-compatible").slice(0, 240),
  }
  if (Array.isArray(input.env)) definition.env = input.env.map((item) => String(item)).filter((item) => /^[A-Z_][A-Z0-9_]*$/.test(item)).slice(0, 16)
  if (input.settings && typeof input.settings === "object") definition.settings = structuredClone(input.settings)
  if (input.headers && typeof input.headers === "object") definition.headers = structuredClone(input.headers)
  if (input.body && typeof input.body === "object") definition.body = structuredClone(input.body)
  rejectInlineSecrets(definition, "provider")
  return { id, definition }
}

function modelDefinition(input) {
  const providerID = assertID(input.providerID, "providerID")
  const id = assertModelID(input.id, "model id")
  const definition = {
    modelID: assertModelID(input.modelID || id, "upstream modelID"),
    name: String(input.name || id).slice(0, 160),
  }
  for (const key of ["capabilities", "limit", "cost", "settings", "headers", "body", "variants"]) {
    if (input[key] !== undefined) definition[key] = structuredClone(input[key])
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean")
    definition.enabled = input.enabled
  }
  rejectInlineSecrets(definition, "model")
  return { providerID, id, definition }
}

function mcpDefinition(input) {
  const name = assertID(input.name, "MCP name")
  const config = structuredClone(asObject(input.config))
  for (const flag of ["disabled", "codemode"]) {
    if (config[flag] !== undefined && typeof config[flag] !== "boolean") throw new Error(`MCP ${flag} must be a boolean`)
  }
  if (!config.type || !["local", "remote"].includes(String(config.type))) throw new Error("MCP config.type must be local or remote")
  if (config.type === "remote") {
    const url = String(config.url || "")
    let parsed
    try { parsed = new URL(url) } catch { throw new Error("remote MCP requires http(s) url") }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("remote MCP requires http(s) url")
    if (parsed.username || parsed.password) throw new Error("remote MCP URL must not include credentials")
    for (const [key, value] of parsed.searchParams) {
      assertCredentialReference(key, value)
    }
  } else {
    if (!Array.isArray(config.command) || !config.command.length || config.command.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("local MCP requires command array")
    }
    rejectLocalCommandSecrets(config.command)
  }
  rejectInlineSecrets(config, "mcp")
  return { name, config }
}

function rejectLocalCommandSecrets(command) {
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index]
    const flag = /^--([^=]+)(?:=(.*))?$/i.exec(argument)
    if (flag && isSensitiveName(flag[1])) assertCredentialReference(flag[1], flag[2] === undefined ? command[++index] : flag[2])
    else if (flag && /^(?:env|header)$/i.test(flag[1])) rejectLocalCredentialArgument(flag[2] === undefined ? command[++index] : flag[2])
    else if (/^-[eH]$/.test(argument)) rejectLocalCredentialArgument(command[++index])
    else rejectLocalCredentialArgument(argument)
  }
}

function rejectLocalCredentialArgument(argument) {
  const value = String(argument || "")
  const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(value)
  const header = /^([^:]+):\s*(.*)$/.exec(value)
  if (assignment) assertCredentialReference(assignment[1], assignment[2])
  else if (header) assertCredentialReference(header[1], header[2])
}

function skillDefinition(input) {
  const id = assertID(input.id, "skill id")
  const content = String(input.content || "").trim()
  if (!content) throw new Error("skill content is required")
  if (content.length > 120_000) throw new Error("skill content is too large")
  return {
    id,
    definition: {
      id,
      name: String(input.name || id).slice(0, 120),
      description: String(input.description || "Managed skill").slice(0, 1000),
      location: join(CONFIG_DIR, "managed-skills", id, "SKILL.md"),
      content,
      autoinvoke: input.autoinvoke === true,
    },
  }
}

function mcpProfileDefinition(input) {
  const id = assertID(input.id, "profile id")
  if (["auto", "all"].includes(id.toLowerCase())) throw new Error("Auto and All are reserved system modes")
  if (!Array.isArray(input.mcp)) throw new Error("profile mcp must be an array")
  const risk = input.risk || "normal"
  if (!["normal", "elevated"].includes(risk)) throw new Error("profile risk must be normal or elevated")
  const list = (value, label) => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x.trim() || x.length > 120)) throw new Error(`${label} must be an array of non-empty strings`)
    return [...new Set(value.map((x) => x.trim()))]
  }
  return { id, name: String(input.name || id).slice(0, 120), mcp: [...new Set(input.mcp.map((x) => assertID(x, "MCP name")))], risk, keywords: list(input.keywords, "keywords"), agents: list(input.agents, "agents") }
}

function orchestrationDefinition(input) {
  const providerID = assertID(input.providerID, "providerID")
  const id = assertModelID(input.id, "orchestration id")
  const baseModelID = assertModelID(input.baseModelID || input.modelID, "baseModelID")
  const prompt = String(input.prompt || "").trim()
  if (!prompt) throw new Error("orchestration prompt is required")
  if (prompt.length > 50_000) throw new Error("orchestration prompt is too large")
  return {
    key: `${providerID}/${id}`,
    definition: {
      providerID,
      id,
      baseModelID,
      name: String(input.name || `${id} · Orchestrated`).slice(0, 160),
      prompt,
    },
  }
}

function publicSummary(registry) {
  return {
    providers: Object.keys(registry.providers).sort(),
    models: Object.keys(registry.models).sort(),
    mcp: Object.keys(registry.mcp).sort(),
    skills: Object.keys(registry.skills).sort(),
    orchestrations: Object.keys(registry.orchestrations).sort(),
    mcpProfiles: Object.keys(registry.mcpProfiles).sort(),
  }
}

async function synthetic(ctx, sessionID, text) {
  await ctx.session.synthetic({ sessionID, text, resume: false })
}

function usage(name, example) {
  return `/${name} expects one JSON object. Example:\n${example}`
}

export default Plugin.define({
  id: "custom.config-manager",
  async setup(ctx) {
    const saved = await ctx.storage.get(STORAGE_KEY)
    const legacy = saved === undefined ? await ctx.storage.get("registry-v1") : undefined
    if (saved?.version > 2) throw new Error("Managed registry is newer than this plugin; refusing to overwrite it")
    let registry = normalizeRegistry(saved ?? legacy)
    if (legacy !== undefined) await ctx.storage.set(STORAGE_KEY, registry)
    let installed = {}
    const exposure = new Map() // Observations only, per session; never used as activation state.
    const modeFor = async (sessionID, agent) => {
      const settings = registry.mcpSettings
      let current = sessionID
      const visited = new Set()
      while (current && !visited.has(current)) {
        visited.add(current)
        if (agent && settings.sessions[`${current}/${agent}`]) return settings.sessions[`${current}/${agent}`]
        if (settings.sessions[current]) return settings.sessions[current]
        current = (await ctx.session.get?.({ sessionID: current }))?.parentID
      }
      return settings.mode
    }
    const receipt = async (sessionID, input, data) => {
      if (typeof input?.requestID === "string") await synthetic(ctx, sessionID, `custom.config.receipt:${input.requestID}\n${JSON.stringify(data)}`)
    }

    const save = async () => { await ctx.storage.set(STORAGE_KEY, registry) }
    const reloadAll = async () => {
      const settled = await Promise.allSettled([ctx.catalog.reload(), ctx.mcp.reload(), ctx.skill.reload()])
      const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason?.message || String(item.reason))
      if (failures.length) throw new Error(`managed reload failed: ${failures.join("; ")}`)
    }
    let mutationQueue = Promise.resolve()
    const enqueueMutation = (operation) => {
      const result = mutationQueue.then(operation, operation)
      mutationQueue = result.catch(() => {})
      return result
    }
    const rollback = async (previous) => {
      registry = previous
      const failures = []
      try { await save() } catch (error) { failures.push(error) }
      try { await reloadAll() } catch (error) { failures.push(error) }
      return failures
    }
    const mutationError = (error, rollbackFailures) => {
      if (!rollbackFailures.length) return error
      return new Error(`${error.message}; rollback failed: ${rollbackFailures.map((item) => item.message || String(item)).join("; ")}`)
    }

    await ctx.catalog.transform((catalog) => {
      for (const [providerID, definition] of Object.entries(registry.providers)) {
        catalog.provider.update(providerID, (draft) => Object.assign(draft, structuredClone(definition)))
      }
      for (const [key, definition] of Object.entries(registry.models)) {
        const slash = key.indexOf("/")
        if (slash <= 0) continue
        const providerID = key.slice(0, slash)
        const id = key.slice(slash + 1)
        catalog.model.update(providerID, id, (draft) => Object.assign(draft, structuredClone(definition)))
      }
      for (const definition of Object.values(registry.orchestrations)) {
        const item = asObject(definition)
        if (!item.providerID || !item.id || !item.baseModelID) continue
        const base = catalog.model.get(item.providerID, item.baseModelID)
        catalog.model.update(item.providerID, item.id, (draft) => {
          if (base) Object.assign(draft, structuredClone(base))
          draft.id = item.id
          draft.modelID = item.baseModelID
          draft.name = item.name || `${item.id} · Orchestrated`
        })
      }
    })

    await ctx.mcp.transform((draft) => {
      for (const [name, config] of Object.entries(registry.mcp)) draft.set(name, structuredClone(config))
      installed = Object.fromEntries(draft.list?.() || Object.entries(registry.mcp))
      if (Object.keys(registry.mcpProfiles).length) {
        // Native code-mode snapshots are global. Direct definitions allow request-local filtering.
        for (const [name, config] of Object.entries(installed)) draft.set(name, { ...config, codemode: false })
      }
    })

    await ctx.skill.transform((draft) => {
      for (const definition of Object.values(registry.skills)) draft.add(structuredClone(definition))
    })

    await ctx.session.hook("context", async (event) => {
      if (event.tools) {
        await ctx.mcp.list?.()
        const text = (event.messages || []).filter((m) => m.role === "user").at(-1)?.content
        const selection = resolveMcpProfile(registry, {
          mode: await modeFor(event.sessionID, event.agent), agent: event.agent,
          text: typeof text === "string" ? text : (text || []).map((p) => p.text || "").join(" "),
        })
        const report = filterMcpTools(event.tools, installed, registry.mcpProfiles, selection)
        exposure.set(event.sessionID, { ...report, agent: event.agent, observedAt: new Date().toISOString() })
        // Bound diagnostics to recent sessions; deleting observations never changes policy.
        if (exposure.size > 200) exposure.delete(exposure.keys().next().value)
        const active = new Set(report.active)
        const clean = (text) => String(text).replace(/\s*<server name="([^"]+)">[\s\S]*?<\/server>/g, (block, name) => active.has(name) ? block : "")
        for (const part of event.system || []) if (part.text) part.text = clean(part.text)
        for (const message of event.messages || []) {
          if (Array.isArray(message.content)) message.content = message.content.filter((part) => !part.text?.startsWith("custom.config.receipt:")).map((part) => part.text ? { ...part, text: clean(part.text) } : part)
        }
        if (event.messages) event.messages = event.messages.filter((message) => !Array.isArray(message.content) || message.content.length > 0)
      }
      const providerID = String(event?.model?.providerID || "")
      const id = String(event?.model?.id || "")
      const item = registry.orchestrations[`${providerID}/${id}`]
      if (!item?.prompt || !Array.isArray(event.system)) return
      const marker = `Managed orchestration ${providerID}/${id}`
      if (event.system.some((entry) => String(entry?.text || entry).includes(marker))) return
      event.system.push({ type: "text", text: `${marker}:\n${item.prompt}` })
    })

    if (process.env.OPENCODE_MCP_PROFILE_EVIDENCE) await ctx.session.hook("http.request", async (event) => {
      const body = await event.request.clone().json().catch(() => ({}))
      const tools = (body.tools || []).flatMap((tool) => tool.function?.name || tool.name || [])
      await appendFile(process.env.OPENCODE_MCP_PROFILE_EVIDENCE, `${JSON.stringify({ time: new Date().toISOString(), sessionID: event.sessionID, agent: event.agent, profile: exposure.get(event.sessionID)?.id, tools })}\n`, { mode: 0o600 })
    })

    await ctx.command.transform((commands) => {
      const add = (name, description, handler, help) => commands.add({
        name,
        description,
        execute: ({ sessionID, prompt }) => enqueueMutation(async () => {
          const previous = registry
          let input
          try {
            input = extractJson(prompt)
            await handler(input, sessionID)
            await save()
            await reloadAll()
          } catch (error) {
            const failure = mutationError(error, registry === previous ? [] : await rollback(previous))
            await receipt(sessionID, input, { error: failure.message })
            try { await synthetic(ctx, sessionID, `${name}: ${failure.message}\n\n${help}`) } catch {}
            throw failure
          }
          await receipt(sessionID, input, { saved: true })
          try { await synthetic(ctx, sessionID, `${name}: saved\n${JSON.stringify(publicSummary(registry), null, 2)}`) } catch {}
        }),
      })

      add("addprovider", "Add or update a durable managed provider", async (input) => {
        const { id, definition } = providerDefinition(input)
        registry = { ...registry, providers: { ...registry.providers, [id]: definition } }
      }, usage("addprovider", '/addprovider {"id":"acme","name":"Acme","package":"@opencode-ai/ai/providers/openai-compatible","env":["ACME_API_KEY"],"settings":{"baseURL":"https://llm.example/v1","apiKey":"{env:ACME_API_KEY}"}}'))

      add("addmodel", "Add or update a durable managed model", async (input) => {
        const { providerID, id, definition } = modelDefinition(input)
        registry = { ...registry, models: { ...registry.models, [`${providerID}/${id}`]: definition } }
      }, usage("addmodel", '/addmodel {"providerID":"acme","id":"coder","modelID":"qwen3-coder","name":"Coder","capabilities":{"tools":true,"input":["text"],"output":["text"]}}'))

      add("addmcp", "Add or update a durable managed MCP server", async (input) => {
        const { name, config } = mcpDefinition(input)
        const collision = Object.keys(installed).find((id) => id !== name && mcpNamespace(id) === mcpNamespace(name))
        if (collision) throw new Error(`MCP name conflicts with '${collision}' after native normalization`)
        const profiles = { ...registry.mcpProfiles }
        if (input.profiles !== undefined) {
          if (!Array.isArray(input.profiles) || input.profiles.some((id) => !Object.hasOwn(profiles, id))) throw new Error("profiles must contain existing profile IDs")
          for (const [id, profile] of Object.entries(profiles)) profiles[id] = { ...profile, mcp: [...profile.mcp.filter((item) => item !== name), ...(input.profiles.includes(id) ? [name] : [])] }
        }
        registry = { ...registry, mcp: { ...registry.mcp, [name]: config }, mcpProfiles: profiles }
      }, usage("addmcp", '/addmcp {"name":"docs","config":{"type":"remote","url":"https://mcp.example.com"}}'))

      add("addmcpprofile", "Add or update a durable MCP profile", async (input) => {
        const profile = mcpProfileDefinition(input)
        registry = { ...registry, mcpProfiles: { ...registry.mcpProfiles, [profile.id]: profile } }
      }, usage("addmcpprofile", '/addmcpprofile {"id":"core","name":"Core","mcp":["docs"]}'))

      add("mcp-profile", "Select MCP profile: Auto, All or a registered profile", async (input, sessionID) => {
        const mode = String(input.mode || "auto")
        if (!["auto", "all"].includes(mode) && !Object.hasOwn(registry.mcpProfiles, mode)) throw new Error(`Unknown MCP profile: ${mode}`)
        const settings = registry.mcpSettings
        if (input.scope === "fallback") {
          if (mode === "auto" || registry.mcpProfiles[mode]?.risk === "elevated") throw new Error("Auto fallback must be All or a normal profile")
          registry = { ...registry, mcpSettings: { ...settings, fallback: mode } }
        } else if (input.scope === "default") registry = { ...registry, mcpSettings: { ...settings, mode } }
        else registry = { ...registry, mcpSettings: { ...settings, sessions: { ...settings.sessions, [input.agent ? `${sessionID}/${assertID(input.agent, "agent")}` : sessionID]: mode } } }
      }, usage("mcp-profile", '/mcp-profile {"mode":"frontend"}'))

      add("addskill", "Add or update a durable managed skill", async (input) => {
        const { id, definition } = skillDefinition(input)
        registry = { ...registry, skills: { ...registry.skills, [id]: definition } }
      }, usage("addskill", '/addskill {"id":"review","name":"Review","description":"Review current changes","content":"Review the current changes for correctness and regressions."}'))

      add("addorchestration", "Add a model-picker orchestration alias with a managed system policy", async (input) => {
        const { key, definition } = orchestrationDefinition(input)
        registry = { ...registry, orchestrations: { ...registry.orchestrations, [key]: definition } }
      }, usage("addorchestration", '/addorchestration {"providerID":"acme","id":"coder-orchestrated","baseModelID":"coder","name":"Coder · Orchestrated","prompt":"Plan only when needed, delegate bounded reads, verify before completion."}'))

      commands.add({
        name: "refreshmodels",
        description: "Refresh models and managed aliases for this workspace",
        execute: () => enqueueMutation(async () => {
          registry = normalizeRegistry(await ctx.storage.get(STORAGE_KEY))
          await ctx.catalog.reload()
        }),
      })

      commands.add({
        name: "managed",
        description: "List managed providers, models, MCP servers, skills and orchestrations",
        execute: ({ sessionID, prompt }) => enqueueMutation(async () => {
          const input = prompt?.text?.includes("{") ? extractJson(prompt) : {}
          await ctx.mcp.list?.()
          if (input.requestID) return receipt(sessionID, input, { registry, installed, mode: await modeFor(sessionID), exposure: exposure.get(sessionID) || null })
          await synthetic(ctx, sessionID, `Managed configuration:\n${JSON.stringify(publicSummary(registry), null, 2)}\nMCP exposure (last model request):\n${JSON.stringify(exposure.get(sessionID) || "No model request observed", null, 2)}`)
        }),
      })

      commands.add({
        name: "remove-managed",
        description: "Remove a managed item: /remove-managed {\"type\":\"models\",\"id\":\"provider/model\"}",
        execute: ({ sessionID, prompt }) => enqueueMutation(async () => {
          const previous = registry
          try {
            const input = extractJson(prompt)
            const type = String(input.type || "")
            const id = String(input.id || "")
            if (!["providers", "models", "mcp", "skills", "orchestrations", "mcpProfiles"].includes(type)) throw new Error("type must be providers, models, mcp, skills, orchestrations or mcpProfiles")
            if (!Object.prototype.hasOwnProperty.call(registry[type], id)) throw new Error("managed item not found")
            const next = { ...registry[type] }
            delete next[id]
            registry = { ...registry, [type]: next }
            await save()
            await reloadAll()
          } catch (error) {
            const failure = mutationError(error, registry === previous ? [] : await rollback(previous))
            try { await synthetic(ctx, sessionID, `remove-managed: ${failure.message}`) } catch {}
            throw failure
          }
          try { await synthetic(ctx, sessionID, "remove-managed: removed") } catch {}
        }),
      })
    })
  },
})

if (process.env.OPENCODE_CONFIG_MANAGER_SELF_CHECK) {
  const provider = providerDefinition({ id: "acme", settings: { apiKey: "{env:ACME_API_KEY}" } })
  if (provider.id !== "acme") throw new Error("provider self-check failed")
  let rejected = false
  try { providerDefinition({ id: "bad", settings: { apiKey: "literal-secret" } }) } catch { rejected = true }
  if (!rejected) throw new Error("inline secret self-check failed")
  const camelProvider = providerDefinition({ id: "camel-provider", settings: { privateKey: "{env:PRIVATE_KEY}" } })
  const camelModel = modelDefinition({ providerID: "acme", id: "camel-model", settings: { clientSecret: "{env:CLIENT_SECRET}" } })
  if (camelProvider.id !== "camel-provider" || camelModel.id !== "camel-model") throw new Error("camel inline reference self-check failed")
  for (const [definition, input] of [[providerDefinition, { id: "bad-private", settings: { privateKey: "literal" } }], [modelDefinition, { providerID: "acme", id: "bad-client", settings: { clientSecret: "literal" } }]]) {
    rejected = false
    try { definition(input) } catch { rejected = true }
    if (!rejected) throw new Error("camel inline secret self-check failed")
  }
  const remote = mcpDefinition({ name: "docs", config: { type: "remote", url: "https://mcp.example.com?api_key={env:DOCS_TOKEN}&key={env:DOCS_KEY}" } })
  if (remote.config.type !== "remote") throw new Error("remote MCP self-check failed")
  const camelURL = mcpDefinition({ name: "camel-url", config: { type: "remote", url: "https://mcp.example.com?clientSecret={env:CLIENT_SECRET}&bearerToken={env:BEARER_TOKEN}" } })
  if (camelURL.config.type !== "remote") throw new Error("camel URL self-check failed")
  rejected = false
  try { mcpDefinition({ name: "bad-url", config: { type: "remote", url: "https://user:pass@mcp.example.com?clientSecret=literal" } }) } catch { rejected = true }
  if (!rejected) throw new Error("remote MCP secret self-check failed")
  const local = mcpDefinition({ name: "local", config: { type: "local", command: ["tool", "--api_key", "{env:API_KEY}", "--env", "TOKEN={env:TOKEN}", "--header", "X-Api-Key: {env:API_KEY}"] } })
  if (local.config.type !== "local") throw new Error("local MCP self-check failed")
  const camelLocal = mcpDefinition({ name: "camel-local", config: { type: "local", command: ["tool", "--refreshToken", "{env:REFRESH_TOKEN}", "--privateKey={env:PRIVATE_KEY}", "--xApiKey", "{env:X_API_KEY}", "--profile", "literal"] } })
  if (camelLocal.config.type !== "local") throw new Error("camel local self-check failed")
  for (const name of ["clientSecret", "bearerToken", "refreshToken", "privateKey", "xApiKey"]) {
    assertCredentialReference(name, "{env:TEST_SECRET}")
    rejected = false
    try { assertCredentialReference(name, "literal") } catch { rejected = true }
    if (!rejected) throw new Error("camel secret self-check failed")
  }
  assertCredentialReference("profile", "literal")
  for (const command of [["tool", "--key=literal"], ["tool", "PASSWORD=literal"], ["tool", "Authorization: literal"]]) {
    rejected = false
    try { mcpDefinition({ name: "bad-local", config: { type: "local", command } }) } catch { rejected = true }
    if (!rejected) throw new Error("local MCP secret self-check failed")
  }
  const orchestration = orchestrationDefinition({ providerID: "acme", id: "coder-orchestrated", baseModelID: "coder", prompt: "Verify." })
  if (orchestration.key !== "acme/coder-orchestrated") throw new Error("orchestration self-check failed")
  console.log("config-manager self-check OK")
}
