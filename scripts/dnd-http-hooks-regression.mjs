import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// Exercise production hooks without cloud/model calls or a real router. Each
// import gets a fresh module-level configuration, like a separate plugin host.
const root = await mkdtemp(join(tmpdir(), "dnd-http-hooks-"))
const variables = ["DND_ORCHESTRATOR", "DND_FAST_TIER", "DND_TELEMETRY_FILE", "DND_QWEN_AUTOSTART", "OPENCODE_LOCAL_AUTO_START", "OPENCODE_RUNTIME_PLUGIN_TOKEN"]
const saved = Object.fromEntries(variables.map(name => [name, process.env[name]]))
const originalFetch = globalThis.fetch
const edition = { providerID: "openai", id: "gpt-6-dnd-edition" }
let imports = 0
process.env.DND_QWEN_AUTOSTART = "0"
process.env.OPENCODE_LOCAL_AUTO_START = "0"
process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN = "fixture-not-real"

async function hooksFor(name, { mode = "auto", telemetry = root } = {}) {
  process.env.DND_ORCHESTRATOR = mode
  process.env.DND_FAST_TIER = "priority"
  // A directory fails appendFile reliably (even when tests run as root).
  process.env.DND_TELEMETRY_FILE = telemetry
  const hooks = {}
  const { default: plugin } = await import(`../config/plugins/${name}.js?http-audit=${++imports}`)
  await plugin.setup({ session: { hook: async (name, fn) => { hooks[name] = fn } } })
  return hooks
}

function requestEvent(extra = {}, body = {}) {
  return {
    sessionID: "ses_http_audit", agent: "dnd-narrator", kind: "primary", model: edition, ...extra,
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-not-real" },
      body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "I search the room" }], ...body }),
    }),
  }
}

function routeReply(route) {
  return new Response(JSON.stringify({ decision: { route, confidence: 0.9 }, telemetry: {} }))
}

try {
  await test("Fast tier leaves title, compaction and other metadata requests untouched", async () => {
    const hooks = await hooksFor("dnd-fast-tier")
    for (const extra of [
      { kind: "title" }, { kind: "compaction" }, { kind: "generate" }, { agent: "compaction" },
      { model: { providerID: "google", id: "unrelated" } },
    ]) {
      const event = requestEvent(extra)
      const before = event.request
      await hooks["http.request"](event)
      assert.equal(event.request, before, JSON.stringify(extra))
    }
    const event = requestEvent()
    await hooks["http.request"](event)
    assert.equal((await event.request.clone().json()).service_tier, "priority")
  })

  await test("Unrelated responses cannot consume or replay a narrator's retry body", async () => {
    const hooks = await hooksFor("dnd-fast-tier")
    const narrator = requestEvent()
    await hooks["http.request"](narrator)
    const retries = []
    globalThis.fetch = async request => {
      retries.push({ body: await request.clone().json(), authorization: request.headers.get("authorization") })
      return new Response("narrator recovered")
    }
    for (const extra of [
      { kind: "title" }, { kind: "compaction" }, { kind: "generate" }, { agent: "compaction" },
      { model: { providerID: "google", id: "unrelated" } },
    ]) {
      const event = requestEvent(extra, { input: "not the narrator body" })
      const response = new Response("unsupported service_tier", { status: 400 })
      event.response = response
      await hooks["http.response"](event)
      assert.equal(event.response, response)
      assert.equal(retries.length, 0)
    }
    narrator.response = new Response("unsupported service_tier", { status: 400 })
    await hooks["http.response"](narrator)
    assert.equal(retries.length, 1)
    assert.equal(retries[0].body.input[0].content, "I search the room")
    assert.equal(retries[0].body.service_tier, undefined)
    assert.equal(retries[0].authorization, "Bearer fixture-not-real")
    assert.equal(await narrator.response.text(), "narrator recovered")
    const cooldown = requestEvent()
    await hooks["http.request"](cooldown)
    assert.equal((await cooldown.request.json()).service_tier, undefined)
  })

  await test("Fast-tier fallback retains legacy response events and does not retry unrelated errors", async () => {
    let retries = 0
    globalThis.fetch = async () => { retries++; return new Response("ok") }
    for (const [status, detail, expected] of [
      [400, "unsupported service_tier", 1], [400, "bad input", 0], [403, "service_tier forbidden", 0],
    ]) {
      const hooks = await hooksFor("dnd-fast-tier")
      const event = requestEvent()
      await hooks["http.request"](event)
      const before = retries
      // Older hosts expose only sessionID/request/response on this hook.
      await hooks["http.response"]({ sessionID: event.sessionID, request: event.request, response: new Response(detail, { status }) })
      assert.equal(retries - before, expected)
    }
    const hooks = await hooksFor("dnd-fast-tier")
    const explicit = requestEvent({}, { service_tier: "flex" })
    const before = explicit.request
    await hooks["http.request"](explicit)
    assert.equal(explicit.request, before, "an explicit tier remains authoritative")
  })

  await test("Unwritable optional telemetry does not abort routing or break turn caching", async () => {
    for (const mode of ["auto", "on"]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return routeReply("SOL_XHIGH") }
      const hooks = await hooksFor("dnd-super-orchestrator", { mode })
      const event = requestEvent()
      await hooks["http.request"](event)
      const body = await event.request.json()
      assert.equal(body.model, "gpt-6.1-sol")
      assert.equal(body.reasoning.effort, "xhigh")
      const continuation = requestEvent({}, { input: [
        { role: "user", content: "I search the room" }, { type: "function_call_output", output: "found a key" },
      ] })
      await hooks["http.request"](continuation)
      assert.equal(calls, 1, "a telemetry failure must not evict a valid cached plan")
    }
  })

  await test("Auto mode falls back for invalid router payloads and native tool-only routes", async () => {
    for (const payload of [null, {}, [], { decision: null }, { decision: { route: "UNKNOWN" } }, { decision: { route: 1 } },
      { decision: { route: "TOOL" } }, { decision: { route: "NO_LLM" } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload))
      const hooks = await hooksFor("dnd-super-orchestrator")
      const event = requestEvent()
      await hooks["http.request"](event)
      const body = await event.request.json()
      assert.equal(body.model, "gpt-6-luna")
      assert.equal(body.reasoning.effort, "low")
    }
    for (const response of [() => new Response("invalid JSON"), () => new Response("offline", { status: 503 })]) {
      globalThis.fetch = async () => response()
      const hooks = await hooksFor("dnd-super-orchestrator")
      const event = requestEvent()
      await hooks["http.request"](event)
      assert.equal((await event.request.json()).reasoning.effort, "low")
    }
  })

  await test("Strict mode surfaces invalid routing and allows recovery within the same turn", async () => {
    const hooks = await hooksFor("dnd-super-orchestrator", { mode: "on" })
    globalThis.fetch = async () => new Response("null")
    await assert.rejects(hooks["http.request"](requestEvent()), /Invalid D&D orchestrator routing decision/)
    globalThis.fetch = async () => routeReply("LUNA_XHIGH")
    const recovered = requestEvent()
    await hooks["http.request"](recovered)
    assert.equal((await recovered.request.json()).reasoning.effort, "xhigh")
  })

  await test("Writable telemetry is still recorded and off mode installs no hook", async () => {
    const telemetry = join(root, "telemetry.jsonl")
    globalThis.fetch = async () => routeReply("LUNA_MAX")
    const hooks = await hooksFor("dnd-super-orchestrator", { telemetry })
    const event = requestEvent()
    await hooks["http.request"](event)
    const row = JSON.parse((await readFile(telemetry, "utf8")).trim())
    assert.equal(row.route, "LUNA_MAX")
    assert.equal(row.sessionID, event.sessionID)
    assert.deepEqual(await hooksFor("dnd-super-orchestrator", { mode: "off" }), {})
  })
} finally {
  globalThis.fetch = originalFetch
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(root, { recursive: true, force: true })
}
