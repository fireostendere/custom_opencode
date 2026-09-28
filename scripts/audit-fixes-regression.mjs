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
      messages: [{ id: "msg_1", role: "user", content: "XML <server>unchanged</server>" }],
    }
    const system = JSON.stringify(event.system)
    for (let n = 0; n < 50; n++) await gh.context(event)
    // The per-turn block rides on the current user message; the cached system
    // prefix stays byte-identical and the user's own bytes are preserved.
    assert.equal(JSON.stringify(event.system), system)
    assert.equal(event.messages.length, 1)
    assert.equal(JSON.stringify(event.messages).split("POLICY_ONCE").length - 1, 1)
    assert.deepEqual(event.messages[0].content.at(-1), { type: "text", text: "XML <server>unchanged</server>" })
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

// notify-win: model-controlled text never enters the PowerShell source, and
// only a real permission prompt (effect "ask") spawns a toast.
{
  const { toastScript, psQuote, default: notify } = await import("../config/plugins/notify-win.js")
  const hostile = "a’); Start-Process calc; (’' $(whoami) `n"
  const script = toastScript(hostile, hostile.repeat(20))
  for (const needle of ["Start-Process", "whoami", "’"]) assert.ok(!script.includes(needle), `script source leaked ${needle}`)
  const encoded = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) => Buffer.from(match[1], "base64").toString("utf8"))
  assert.equal(encoded[0], hostile, "title round-trips through base64")
  assert.equal([...encoded[1]].length, 200, "message is truncated before encoding")
  assert.equal(psQuote("x‘y‛z'"), "x‘‘y‛‛z''")
  const spawned = []
  globalThis.Bun = { spawn: (argv) => { spawned.push(argv) } }
  let evaluate
  const dispose = await notify.setup({
    permission: { hook: async (_name, fn) => { evaluate = fn; return { dispose: async () => {} } } },
    event: { subscribe: () => new ReadableStream().values() },
    session: { get: async () => ({ title: "" }) },
  })
  evaluate({ sessionID: "s", action: "read", resources: ["README.md"], effect: "allow" })
  assert.equal(spawned.length, 0, "auto-allowed tool calls must not spawn powershell")
  evaluate({ sessionID: "s", action: "shell", resources: [hostile], effect: "ask" })
  assert.equal(spawned.length, 1)
  assert.ok(!spawned[0].at(-1).includes("Start-Process"))
  await dispose()
  delete globalThis.Bun
  console.log("PASS notify-win: base64 text transport, typographic quotes, ask-only toasts")
}

// keep-awake: one shared keeper stays alive while any session is busy.
{
  const spawned = []
  const killed = []
  globalThis.Bun = { spawn: () => { const child = { exitCode: null, signalCode: null, kill: () => { killed.push(child); child.exitCode = 0 } }; spawned.push(child); return child } }
  const { default: keepAwake } = await import("../config/plugins/keep-awake.js")
  let emit
  const stream = new ReadableStream({ start(controller) { emit = (event) => controller.enqueue(event) } })
  const stop = keepAwake.setup({ event: { subscribe: () => stream.values() } })
  const send = async (type, sessionID) => { emit({ type, data: { sessionID } }); await new Promise((resolve) => setImmediate(resolve)) }
  await send("session.execution.started", "a")
  await send("session.execution.started", "b")
  assert.equal(spawned.length, 1, "one shared keeper")
  await send("session.idle", "a")
  assert.equal(killed.length, 0, "another busy session keeps the machine awake")
  await send("session.execution.succeeded", "b")
  assert.equal(killed.length, 1, "released when the last busy session goes idle")
  await send("session.execution.started", "c")
  assert.equal(spawned.length, 2)
  stop()
  assert.equal(killed.length, 2, "dispose releases the keeper")
  delete globalThis.Bun
  console.log("PASS keep-awake: busy-session set")
}

// config-backup: own timestamped copies only, private modes, no duplicate writes.
{
  const { mkdirSync: mkdir, writeFileSync: write, readdirSync: list, statSync: stat, chmodSync: chmod, rmSync: remove } = await import("node:fs")
  const base = await mkdtemp(join(tmpdir(), "config-backup-"))
  const backups = join(base, "backups")
  try {
    mkdir(backups, { mode: 0o755 })
    write(join(base, "opencode.json"), '{"a":1}', { mode: 0o600 })
    write(join(backups, "opencode.json.manual-before-upgrade"), "manual")
    write(join(backups, "opencode.json.2020-01-01-00-00-00"), '{"old":true}')
    chmod(join(backups, "opencode.json.2020-01-01-00-00-00"), 0o644)
    process.env.OPENCODE_CONFIG_DIR = base
    process.env.OPENCODE_CONFIG_BACKUP_KEEP = "2"
    const { backup } = await import(`../config/plugins/config-backup.js?t=${Date.now()}`)
    backup()
    backup()
    backup()
    const own = () => list(backups).filter((name) => /^opencode\.json\.\d{4}-/.test(name)).sort()
    assert.equal(own().length, 2, "identical content is not copied again on every plugin load")
    assert.ok(list(backups).includes("opencode.json.manual-before-upgrade"), "manual files are never pruned")
    assert.equal(stat(backups).mode & 0o777, 0o700)
    for (const name of own()) assert.equal(stat(join(backups, name)).mode & 0o777, 0o600, name)
    write(join(base, "opencode.json"), '{"a":2}')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    backup()
    assert.equal(own().length, 2, "pruning keeps KEEP own copies")
    assert.ok(!own().includes("opencode.json.2020-01-01-00-00-00"), "oldest own copy is pruned first")
  } finally {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_BACKUP_KEEP
    remove(base, { recursive: true, force: true })
  }
  console.log("PASS config-backup: own pattern, private modes, dedupe, pruning")
}
