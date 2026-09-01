import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode-ai/plugin"

const STORAGE_KEY = "registry-v1"
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/

function emptyRegistry() {
  return { version: 1, providers: {}, models: {}, mcp: {}, skills: {}, orchestrations: {} }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function normalizeRegistry(value) {
  const raw = asObject(value)
  return {
    version: 1,
    providers: asObject(raw.providers),
    models: asObject(raw.models),
    mcp: asObject(raw.mcp),
    skills: asObject(raw.skills),
    orchestrations: asObject(raw.orchestrations),
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

function rejectInlineSecrets(value, path = "definition") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInlineSecrets(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value)) {
    const next = `${path}.${key}`
    if (/api.?key|token|secret|password|authorization/i.test(key) && typeof item === "string" && !isSafeSecretReference(item)) {
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
  rejectInlineSecrets(definition, "model")
  return { providerID, id, definition }
}

function mcpDefinition(input) {
  const name = assertID(input.name, "MCP name")
  const config = structuredClone(asObject(input.config))
  if (!config.type || !["local", "remote"].includes(String(config.type))) throw new Error("MCP config.type must be local or remote")
  if (config.type === "remote") {
    const url = String(config.url || "")
    if (!/^https?:\/\//.test(url)) throw new Error("remote MCP requires http(s) url")
  } else if (!Array.isArray(config.command) || !config.command.length) {
    throw new Error("local MCP requires command array")
  }
  rejectInlineSecrets(config, "mcp")
  return { name, config }
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
  }
}

async function synthetic(ctx, sessionID, text) {
  await ctx.session.synthetic({ sessionID, text })
}

function usage(name, example) {
  return `/${name} expects one JSON object. Example:\n${example}`
}

export default Plugin.define({
  id: "custom.config-manager",
  async setup(ctx) {
    let registry = normalizeRegistry(await ctx.storage.get(STORAGE_KEY))

    const save = async () => { await ctx.storage.set(STORAGE_KEY, registry) }
    const reloadAll = async () => {
      await Promise.all([ctx.catalog.reload(), ctx.mcp.reload(), ctx.skill.reload()])
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
    })

    await ctx.skill.transform((draft) => {
      for (const definition of Object.values(registry.skills)) draft.add(structuredClone(definition))
    })

    await ctx.session.hook("context", (event) => {
      const providerID = String(event?.model?.providerID || "")
      const id = String(event?.model?.id || "")
      const item = registry.orchestrations[`${providerID}/${id}`]
      if (!item?.prompt || !Array.isArray(event.system)) return
      const marker = `Managed orchestration ${providerID}/${id}`
      if (event.system.some((entry) => String(entry?.text || entry).includes(marker))) return
      event.system.push({ type: "text", text: `${marker}:\n${item.prompt}` })
    })

    await ctx.command.transform((commands) => {
      const add = (name, description, handler, help) => commands.add({
        name,
        description,
        execute: async ({ sessionID, prompt }) => {
          try {
            const input = extractJson(prompt)
            await handler(input)
            await save()
            await synthetic(ctx, sessionID, `${name}: saved\n${JSON.stringify(publicSummary(registry), null, 2)}`)
          } catch (error) {
            await synthetic(ctx, sessionID, `${name}: ${error.message}\n\n${help}`)
          }
        },
      })

      add("addprovider", "Add or update a durable managed provider", async (input) => {
        const { id, definition } = providerDefinition(input)
        registry.providers = { ...registry.providers, [id]: definition }
        await ctx.catalog.reload()
      }, usage("addprovider", '/addprovider {"id":"acme","name":"Acme","package":"@opencode-ai/ai/providers/openai-compatible","env":["ACME_API_KEY"],"settings":{"baseURL":"https://llm.example/v1","apiKey":"{env:ACME_API_KEY}"}}'))

      add("addmodel", "Add or update a durable managed model", async (input) => {
        const { providerID, id, definition } = modelDefinition(input)
        registry.models = { ...registry.models, [`${providerID}/${id}`]: definition }
        await ctx.catalog.reload()
      }, usage("addmodel", '/addmodel {"providerID":"acme","id":"coder","modelID":"qwen3-coder","name":"Coder","capabilities":{"tools":true,"input":["text"],"output":["text"]}}'))

      add("addmcp", "Add or update a durable managed MCP server", async (input) => {
        const { name, config } = mcpDefinition(input)
        registry.mcp = { ...registry.mcp, [name]: config }
        await ctx.mcp.reload()
      }, usage("addmcp", '/addmcp {"name":"docs","config":{"type":"remote","url":"https://mcp.example.com"}}'))

      add("addskill", "Add or update a durable managed skill", async (input) => {
        const { id, definition } = skillDefinition(input)
        registry.skills = { ...registry.skills, [id]: definition }
        await ctx.skill.reload()
      }, usage("addskill", '/addskill {"id":"review","name":"Review","description":"Review current changes","content":"Review the current changes for correctness and regressions."}'))

      add("addorchestration", "Add a model-picker orchestration alias with a managed system policy", async (input) => {
        const { key, definition } = orchestrationDefinition(input)
        registry.orchestrations = { ...registry.orchestrations, [key]: definition }
        await ctx.catalog.reload()
      }, usage("addorchestration", '/addorchestration {"providerID":"acme","id":"coder-orchestrated","baseModelID":"coder","name":"Coder · Orchestrated","prompt":"Plan only when needed, delegate bounded reads, verify before completion."}'))

      commands.add({
        name: "managed",
        description: "List managed providers, models, MCP servers, skills and orchestrations",
        execute: async ({ sessionID }) => synthetic(ctx, sessionID, `Managed configuration:\n${JSON.stringify(publicSummary(registry), null, 2)}`),
      })

      commands.add({
        name: "remove-managed",
        description: "Remove a managed item: /remove-managed {\"type\":\"models\",\"id\":\"provider/model\"}",
        execute: async ({ sessionID, prompt }) => {
          try {
            const input = extractJson(prompt)
            const type = String(input.type || "")
            const id = String(input.id || "")
            if (!Object.prototype.hasOwnProperty.call(registry, type) || type === "version") throw new Error("type must be providers, models, mcp, skills or orchestrations")
            if (!Object.prototype.hasOwnProperty.call(registry[type], id)) throw new Error("managed item not found")
            const next = { ...registry[type] }
            delete next[id]
            registry = { ...registry, [type]: next }
            await save()
            await reloadAll()
            await synthetic(ctx, sessionID, `remove-managed: removed ${type}/${id}`)
          } catch (error) {
            await synthetic(ctx, sessionID, `remove-managed: ${error.message}`)
          }
        },
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
  const orchestration = orchestrationDefinition({ providerID: "acme", id: "coder-orchestrated", baseModelID: "coder", prompt: "Verify." })
  if (orchestration.key !== "acme/coder-orchestrated") throw new Error("orchestration self-check failed")
  console.log("config-manager self-check OK")
}
