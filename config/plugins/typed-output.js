import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Typed (JEV-style) agent traffic: machine-to-machine replies are JSON, prose
// stays only where a person reads it. OpenCode V2 sends Responses tools with
// strict:false and `text` with verbosity only, so the format is set on the
// outgoing body for registered agents and request kinds.
//
// Registry: prompts/typed-output.json plus optional prompts/typed-output.*.json
// (for example from the private user config); later files win per agent.
//   kinds  request kinds to shape (default primary + generate; never title/compaction)
//   format {type:"json_schema", name, schema} (strict) or {type:"json_object"}
//   task   JSON Schema that a native `subagent` delegation prompt must satisfy
// A provider 400 naming the format is retried once without it and remembered
// per model for a day; the caller's own validator stays the second line of
// defence. TYPED_OUTPUT=off disables the plugin.
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const STATE_FILE = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "custom-opencode", "typed-output.json")
const DEFAULT_KINDS = ["primary", "generate"]
const REJECTION_TTL_MS = 24 * 3600 * 1000
const FORMAT_ERROR = /text\.format|json_schema|json_object|response_format|strict|schema/i

export function loadRegistry(dir = join(CONFIG_DIR, "prompts")) {
  const files = readdirSync(dir).filter((name) => /^typed-output(\..+)?\.json$/.test(name)).sort()
  const agents = {}
  for (const name of files) Object.assign(agents, JSON.parse(readFileSync(join(dir, name), "utf8")).agents || {})
  return { agents }
}

// Minimal validator for the strict-mode JSON Schema subset used in registries.
export function validate(schema, value, path = "$") {
  const types = [].concat(schema.type || [])
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v)
  if (types.length && !types.some((t) => t === typeOf(value) || (t === "number" && typeOf(value) === "integer")))
    return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`]
  const errors = []
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: bad format`)
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)))
  }
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key}: required`)
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value)) if (!(key in schema.properties)) errors.push(`${path}.${key}: not allowed`)
    for (const [key, sub] of Object.entries(schema.properties)) if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`))
  }
  return errors
}

/** Strict mode needs every property required and no additional properties, at every level. */
export function strictProblems(schema, path = "$") {
  const problems = []
  if (schema.type === "object" || schema.properties) {
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`)
    const required = new Set(schema.required || [])
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (!required.has(key)) problems.push(`${path}.${key}: must be required (use a nullable type instead)`)
      problems.push(...strictProblems(sub, `${path}.${key}`))
    }
  }
  if (schema.items) problems.push(...strictProblems(schema.items, `${path}[]`))
  for (const branch of schema.anyOf || []) problems.push(...strictProblems(branch, path))
  return problems
}

function wireFormat(format, responses) {
  if (format.type === "json_object") return { type: "json_object" }
  const spec = { name: String(format.name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64), schema: format.schema, strict: true }
  return responses ? { type: "json_schema", ...spec } : { type: "json_schema", json_schema: spec }
}

/** Pure body shaping; returns the same object when nothing applies. */
export function shapeBody(body, { agent, kind }, registry, rejectedModels = new Set()) {
  const entry = registry.agents?.[agent]
  if (!entry?.format || !body || typeof body !== "object") return body
  if (!(entry.kinds || DEFAULT_KINDS).includes(kind)) return body
  if (typeof body.model === "string" && rejectedModels.has(body.model)) return body
  const out = structuredClone(body)
  if (Object.hasOwn(out, "input")) out.text = { ...(out.text || {}), format: wireFormat(entry.format, true) }
  else out.response_format = wireFormat(entry.format, false)
  return out
}

/** Errors for a native `subagent` delegation whose target declares a task schema. */
export function checkDelegation(input, registry) {
  const task = registry.agents?.[String(input?.agent || "")]?.task
  if (!task) return []
  let packet
  try {
    packet = JSON.parse(String(input?.prompt ?? ""))
  } catch {
    return [`the prompt for ${input.agent} must be a JSON task packet, not prose`]
  }
  return validate(task, packet)
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"))
  } catch {
    return { rejected: {} }
  }
}

function rejectedModels() {
  const now = Date.now()
  return new Set(Object.entries(readState().rejected || {}).filter(([, at]) => now - Date.parse(at) < REJECTION_TTL_MS).map(([model]) => model))
}

function rememberRejection(model) {
  const state = readState()
  state.rejected = { ...(state.rejected || {}), [model]: new Date().toISOString() }
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1))
}

export default {
  id: "typed-output",
  async setup(ctx) {
    if (String(process.env.TYPED_OUTPUT || "on").toLowerCase() === "off") return
    let registry
    try {
      registry = loadRegistry()
    } catch {
      return // no registry installed: nothing to type
    }
    const pending = new Map() // sessionID -> { model, original }
    const registrations = []

    registrations.push(await ctx.session.hook("http.request", async (event) => {
      if (!registry.agents?.[event.agent]) return
      let body
      try {
        body = await event.request.clone().json()
      } catch {
        return
      }
      const shaped = shapeBody(body, event, registry, rejectedModels())
      if (shaped === body) return
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      pending.set(event.sessionID, { model: body.model, original: JSON.stringify(body) })
      if (pending.size > 256) pending.delete(pending.keys().next().value)
      event.request = new Request(event.request, { headers, body: JSON.stringify(shaped) })
    }))

    registrations.push(await ctx.session.hook("http.response", async (event) => {
      const sent = pending.get(event.sessionID)
      if (!sent) return
      pending.delete(event.sessionID)
      if (event.response.status !== 400) return
      const detail = await event.response.clone().text().catch(() => "")
      if (!FORMAT_ERROR.test(detail)) return
      if (typeof sent.model === "string") rememberRejection(sent.model)
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.response = await fetch(new Request(event.request, { headers, body: sent.original }))
    }))

    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const errors = checkDelegation(event.input, registry)
      if (errors.length) throw new Error(`Typed delegation rejected: ${errors.slice(0, 6).join("; ")}`)
    }))

    return async () => Promise.allSettled(registrations.map((registration) => registration?.dispose?.()))
  },
}
