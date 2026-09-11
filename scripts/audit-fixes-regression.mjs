import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkill } from "../config/plugins/tui/lib/skill-frontmatter.js"
import { filterMcpTools, assertMcpNamespaces } from "../config/plugins/tui/lib/mcp-profiles.js"
const rows = []
const check = async (name, fn) => {
  await fn()
  rows.push(name)
  console.log(`PASS ${name}`)
}
for (const [style, value] of [
  ["folded", ">\n  A folded\n  description"],
  ["literal", "|\n  A literal\n  description"],
  ["quoted", '"A description: with colon"'],
]) {
  await check(`YAML ${style}`, () =>
    assert.ok(
      parseSkill(`---\nname: fixture\ndescription: ${value}\n---\n# Body`).description.includes(
        "description",
      ),
    ),
  )
}
await check("YAML BOM/CRLF", () =>
  assert.equal(
    parseSkill("\uFEFF---\r\nname: fixture\r\ndescription: text\r\n---\r\nbody").name,
    "fixture",
  ),
)
for (const text of [
  "name: fixture\nname: other\ndescription: text",
  "name: fixture\ndescription: !!js/function function(){}",
  "name: fixture\ndescription: [x]",
]) {
  await check("invalid YAML rejected", () =>
    assert.throws(() => parseSkill(`---\n${text}\n---\nbody`)),
  )
}
await check("namespace collision fails closed", () =>
  assert.throws(() => assertMcpNamespaces({ "docs.ops": {}, docs_ops: {} }), /collision/),
)
const plugin = (await import("../config/plugins/config-manager.js")).default
const registry = {
  version: 2,
  providers: {},
  models: {},
  mcp: {
    docs: { type: "remote", url: "https://fixture.invalid/mcp", codemode: true },
    browser: { type: "remote", url: "https://fixture.invalid/mcp" },
  },
  skills: {},
  orchestrations: {},
  mcpProfiles: { core: { id: "core", name: "Core", mcp: ["docs"] } },
  mcpSettings: { mode: "auto", sessions: {} },
}
const hooks = new Map()
let transform
const noop = async () => {}
const ctx = {
  storage: {
    get: async (k) => (k === "registry-v2" ? structuredClone(registry) : undefined),
    set: noop,
  },
  catalog: { transform: noop, reload: noop },
  skill: { transform: noop, reload: noop },
  mcp: {
    transform: async (f) => {
      transform = f
    },
    reload: noop,
    list: noop,
  },
  command: { transform: async (f) => f({ add: () => {} }) },
  session: { hook: async (n, f) => hooks.set(n, f), synthetic: noop, get: async () => ({}) },
}
await plugin.setup(ctx)
const installed = new Map()
transform({ set: (n, c) => installed.set(n, c), list: () => [...installed] })
await check("MCP filter preserves all message bytes", async () => {
  const event = {
    sessionID: "s",
    agent: "build",
    system: [{ type: "text", text: 'Explain <server name="payments">DATA</server>' }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'custom.config.receipt:legitimate\n<server name="payments">IMPORTANT_DATA</server>',
          },
        ],
      },
      { role: "tool", content: '<server name="browser">tool output</server>' },
    ],
    tools: { docs_find: {}, browser_visit: {}, read: {} },
  }
  const before = JSON.stringify({ system: event.system, messages: event.messages })
  await hooks.get("context")(event)
  assert.equal(JSON.stringify({ system: event.system, messages: event.messages }), before)
  assert.ok(!("browser_visit" in event.tools))
  assert.ok("docs_find" in event.tools)
})
process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN = "fixture-not-real"
const guard = (await import("../config/plugins/server-runtime-guard.js")).default
const gh = {}
const guardTools = []
const fetch = globalThis.fetch
try {
  globalThis.fetch = async (url, init) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/context") ? { text: "POLICY_ONCE" } : { content: "artifact" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  await guard.setup({
    session: { hook: async (n, f) => (gh[n] = f) },
    tool: {
      transform: async (f) =>
        f({
          add: (t) => {
            guardTools.push(t)
          },
        }),
      hook: async (n, f) => (gh[n] = f),
    },
  })
  await check("50 context assemblies do not grow snapshots", async () => {
    const event = {
      sessionID: "s",
      system: [{ type: "text", text: "native policy" }],
      messages: [{ role: "user", content: "XML <server>unchanged</server>" }],
    }
    const user = JSON.stringify(event.messages)
    for (let n = 0; n < 50; n++) await gh.context(event)
    assert.equal(event.system.length, 2)
    assert.equal(JSON.stringify(event.messages), user)
    assert.equal(JSON.stringify(event.system).split("POLICY_ONCE").length - 1, 1)
  })
  await check("artifact reader uses native session not supplied argument", async () => {
    let sent
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body)
      return new Response('{"content":"OK"}')
    }
    // The merged guard plugin registers several tools (runtime_artifact_read,
    // context_budget); registration order is not part of the contract.
    const read = guardTools.find((t) => t.name === "runtime_artifact_read")
    assert.ok(read, "runtime_artifact_read is registered")
    await read.execute({ artifactID: "a", sessionID: "forged" }, { sessionID: "owner" })
    assert.equal(sent.sessionID, "owner")
  })
} finally {
  globalThis.fetch = fetch
}
const home = await mkdtemp(join(tmpdir(), "audit-plan-"))
process.env.OPENCODE_PLAN_DIRECTORY = home
delete process.env.OPENCODE_VISIBLE_PLAN
try {
  const plan = (await import("../config/plugins/visible-plan.js")).default
  const ph = {}
  let planTool
  await plan.setup({
    tool: {
      transform: async (f) =>
        f({
          add: (t) => {
            planTool = t
          },
        }),
      hook: async (n, f) => (ph[n] = f),
    },
    session: { hook: async (n, f) => (ph[n] = f) },
  })
  await check("bounded task needs no ceremonial plan", async () => {
    await ph.context({
      sessionID: "s",
      agent: "build",
      system: [],
      messages: [{ role: "user", content: "Fix this spelling." }],
    })
    assert.doesNotThrow(() => ph["execute.before"]({ sessionID: "s", tool: "edit" }))
  })
  await check("plan still stores real milestone state", async () => {
    await planTool.execute(
      { title: "Risky migration", todos: [{ content: "Verify rollback", status: "in_progress" }] },
      { sessionID: "s" },
    )
    assert.match(await readFile(join(home, "s-plan.md"), "utf8"), /Verify rollback/)
  })
} finally {
  await rm(home, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, checks: rows.length }))

// A large catalog must not be serialized on each turn, and changing the profile
// must remove previously selected capabilities rather than growing access.
const { McpDiscovery } = await import("../config/plugins/tui/lib/mcp-discovery.js")
for (const count of [100, 500]) {
  const discovery = new McpDiscovery()
  const catalog = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `cad_${i}`,
      {
        description: `Read schematic component ${i}`,
        input: {
          type: "object",
          properties: { component: { type: "string", description: "x".repeat(150) } },
        },
      },
    ]),
  )
  const report = { id: "cad", exposed: Object.keys(catalog) }
  let tools = structuredClone(catalog)
  let exposure = discovery.update("a", tools, report)
  assert.equal(exposure.exposed.length, 0)
  assert.equal(exposure.deferred.length, count)
  assert.ok(exposure.schemaCharactersAfter < exposure.schemaCharactersBefore / 10)
  assert.equal(discovery.discover("a", { query: "cad_12" }).tools[0].name, "cad_12")
  tools = structuredClone(catalog)
  exposure = discovery.update("a", tools, report)
  assert.ok(exposure.exposed.length <= 8)
  assert.ok(tools.cad_12)
  discovery.update("b", {}, { id: "none", exposed: [] })
  assert.deepEqual(discovery.discover("b", { query: "cad_12" }).tools, [])
  discovery.update("a", {}, { id: "none", exposed: [] })
  assert.deepEqual(discovery.discover("a", { query: "cad_12" }).tools, [])
  discovery.clear()
  assert.throws(() => discovery.discover("a", {}), /No current/)
}
console.log(
  "PASS: bounded 100/500-tool discovery, session/profile isolation and reload invalidation",
)
