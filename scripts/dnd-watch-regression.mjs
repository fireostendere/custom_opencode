import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createDndWatcher, createPushLinks, isDoorbell, narratorEndpoint, parseSse, stateFileFor } from "../config/plugins/dnd-watch.js"
import { filterDndTools } from "../config/plugins/orchestrated-qwen.js"
import { describeWatch, isTableSession, readWatchStates } from "../config/plugins/tui/lib/dnd-watch-view.js"

// Flags are read at plugin setup: keep tests off the real PC power state,
// the real ODM server and the real status directory.
const stateRoot = mkdtempSync(join(tmpdir(), "dnd-watch-state-"))
process.env.CUSTOM_OPENCODE_STATE_DIR = stateRoot
process.env.DND_KEEP_AWAKE = "0"
process.env.DND_WATCH_PUSH = "0"
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "dnd-watch-config-"))
delete process.env.DND_WATCH_EVENTS_URL

const campaignId = "343ed859-02a4-41f0-85cc-a1b228c503c4"
const input = { campaignId, afterSeq: 10, timeoutSeconds: 60 }
const context = { sessionID: "ses_watch", agent: "dnd-narrator" }
const state = (extra = {}) => ({ campaignId, currentSeq: 10, nextCursor: 10, hasMore: false, messages: [], events: [], asks: [], ...extra })
let now = 0
let reply = state()
let reads = []
let wakes = []
const watcher = createDndWatcher({
  now: () => now,
  read: async (query, ctx) => { reads.push({ query, ctx }); return typeof reply === "function" ? reply(query) : reply },
  wake: async (sessionID, result) => wakes.push({ sessionID, result }),
})

assert.deepEqual(filterDndTools(["dnd_watch", "shell"]), ["dnd_watch"])
assert.throws(() => watcher.start({ ...input, afterSeq: -1 }, context), /afterSeq/)
assert.throws(() => watcher.start({ ...input, campaignId: "bad" }, context), /campaignId/)
assert.throws(() => watcher.start({ ...input, timeoutSeconds: Infinity }, context), /timeoutSeconds/)
assert.equal(watcher.start(input, context).status, "waiting")
assert.equal(watcher.start(input, context).status, "waiting", "duplicate start is idempotent")
await watcher.tick()
await watcher.tick()
assert.equal(wakes.length, 0, "idle polling never calls the model")
assert.equal(reads[0].query.operation, "read")
assert.equal(reads[0].query.includeAsks, true)
assert.equal(reads[0].query.afterSeq, 10)

reply = state({ currentSeq: 11, nextCursor: 11, messages: [{ seq: 11, authorType: "dm", content: "own narration" }] })
await watcher.tick()
assert.equal(wakes.length, 0)
reply = state({ currentSeq: 12, nextCursor: 12, messages: [{ seq: 12, authorType: "player", kind: "ooc", content: "out of game" }] })
await watcher.tick()
assert.equal(wakes.length, 0)
reply = state({ currentSeq: 13, nextCursor: 13, messages: [{ seq: 13, authorType: "player", kind: "do", content: "PRIVATE PLAYER TEXT" }] })
await watcher.tick()
await watcher.tick()
assert.equal(wakes.length, 1, "one event resumes once and disarms")
assert.equal(wakes[0].result.reason, "player")
assert.equal(wakes[0].result.afterSeq, 10, "scan cursor is never an acknowledgement")
assert.ok(!JSON.stringify(wakes).includes("PRIVATE PLAYER TEXT"))
assert.equal(watcher.status(context.sessionID).status, "triggered")

watcher.start(input, context)
reply = state({ asks: [{ id: "ask", status: "pending", question: "PRIVATE ASK" }] })
await watcher.tick()
assert.equal(wakes.at(-1).result.reason, "ask", "asks wake without a story-seq change")
assert.ok(!JSON.stringify(wakes).includes("PRIVATE ASK"))

watcher.start(input, context)
reply = state({ pendingRolls: [{ id: "roll" }] })
await watcher.tick()
assert.equal(watcher.status(context.sessionID).status, "waiting", "an unresolved physical roll must not busy-loop")
reply = state({ currentSeq: 11, nextCursor: 11, events: [{ seq: 11, type: "roll_result" }] })
await watcher.tick()
assert.equal(wakes.at(-1).result.reason, "roll_result")

// Pages and event batches must drain before advancing the private scan cursor.
watcher.start(input, context)
reply = query => query.pageCursor ? {
  format: "odm.read.page.v1", hash: "page-hash", offset: 1, entries: [{ key: "asks", index: 0, value: { status: "pending" } }],
  currentSeq: 12, nextCursor: 11, hasMore: true, nextPage: null, complete: true,
} : {
  format: "odm.read.page.v1", hash: "page-hash", offset: 0, entries: [{ key: "messages", index: 0, value: { seq: 11, authorType: "dm" } }],
  currentSeq: 12, nextCursor: 11, hasMore: true, nextPage: "page-2", complete: false,
}
await watcher.tick()
assert.equal(wakes.at(-1).result.reason, "ask")
assert.equal(reads.at(-1).query.pageCursor, "page-2")
watcher.start(input, context)
reply = query => query.afterSeq === 10
  ? state({ currentSeq: 12, nextCursor: 11, hasMore: true })
  : state({ currentSeq: 12, nextCursor: 12, messages: [{ seq: 12, authorType: "player" }] })
await watcher.tick()
await watcher.tick()
assert.equal(wakes.at(-1).result.reason, "player")

// Stop/replacement and per-session isolation even when a read completes late.
watcher.start(input, context)
let finish
reply = () => new Promise(resolve => { finish = resolve })
const flight = watcher.tick()
await Promise.resolve()
const before = wakes.length
watcher.stop(context.sessionID)
watcher.start(input, context)
finish(state({ asks: [{ status: "pending" }] }))
await flight
assert.equal(wakes.length, before)
watcher.start(input, { ...context, sessionID: "ses_other" })
watcher.stop(context.sessionID)
reply = state({ playerWhispers: [{ id: "whisper", content: "PRIVATE" }] })
await watcher.tick()
assert.equal(wakes.at(-1).sessionID, "ses_other")
assert.equal(wakes.at(-1).result.reason, "whisper")

watcher.start(input, context)
reply = state()
now = 60_001
await watcher.tick()
assert.equal(wakes.at(-1).result.status, "timed_out")
watcher.start(input, context)
reply = () => { throw new Error("private transport detail") }
await watcher.tick()
assert.equal(wakes.at(-1).result.status, "error", "failure is visible instead of endless silent waiting")
assert.ok(!JSON.stringify(wakes).includes("private transport detail"))
// Finished entries stay readable for a while, then are dropped (bounded map).
assert.equal(watcher.status(context.sessionID).status, "error")
now += 10 * 60_000 + 1
await watcher.tick()
assert.equal(watcher.status(context.sessionID).status, "stopped", "finished entries must not accumulate forever")
watcher.close()

// Native plugin lifecycle and zero-inference operator controls.
let events, tool, command, contextHook
let child = false
const notices = []
const stream = new ReadableStream({ start(controller) { events = controller } })
const registration = () => ({ dispose: async () => {} })
const cleanup = await plugin.setup({
  location: { directory: "/game" },
  mcp: { list: async () => ({ data: [{ name: "odm_narrator", status: { status: "connected" } }] }) },
  tool: { transform: async apply => {
    apply({ add: value => { tool = value }, get: () => ({ execute: async () => ({ output: state() }) }) })
    return registration()
  } },
  command: { transform: async apply => { apply({ add: value => { command = value } }); return registration() } },
  session: {
    hook: async (name, fn) => { if (name === "context") contextHook = fn; return registration() },
    get: async () => ({ agent: context.agent, parentID: child ? "ses_parent" : null, location: { directory: "/game" } }),
    synthetic: async value => notices.push(value),
  },
  event: { subscribe: ({ signal }) => {
    signal.addEventListener("abort", () => events.close(), { once: true })
    return stream.values()
  } },
})
try {
  // dnd_watch exists only in the D&D lane; other lanes never pay for its schema.
  const coding = { agent: "build", model: { providerID: "openai", id: "gpt-6-sol-direct" }, tools: { dnd_watch: {}, read: {} } }
  await contextHook(coding)
  assert.deepEqual(Object.keys(coding.tools), ["read"])
  for (const lane of [{ agent: "dnd-narrator", model: { providerID: "openai", id: "gpt-6-dnd-edition" } }, { agent: "build", model: { providerID: "openai", id: "gpt-6-dnd-edition" } }]) {
    const dnd = { ...lane, tools: { dnd_watch: {}, odm_narrator: {} } }
    await contextHook(dnd)
    assert.ok("dnd_watch" in dnd.tools, `${lane.agent}/${lane.model.id} keeps dnd_watch`)
  }
  const start = () => tool.execute({ action: "start", ...input }, context)
  const status = async () => JSON.parse((await tool.execute({ action: "status" }, context)).content).status
  for (const type of ["session.execution.interrupted", "session.execution.failed", "session.deleted", "session.moved", "session.agent.selected", "session.model.selected", "session.inbox.enqueued"]) {
    await start()
    events.enqueue({ type, data: { sessionID: context.sessionID, item: { type: "user" } } })
    await new Promise(setImmediate)
    assert.equal(await status(), "stopped", type)
  }
  await start()
  events.enqueue({ type: "session.execution.interrupted", data: { sessionID: "ses_other" } })
  events.enqueue({ type: "session.inbox.enqueued", data: { sessionID: context.sessionID, item: { type: "synthetic" } } })
  await new Promise(setImmediate)
  assert.equal(await status(), "waiting", "other sessions and synthetic receipts must not cancel the wait")
  await command.execute({ sessionID: context.sessionID, prompt: { text: "status" } })
  assert.equal(notices.at(-1).resume, false)
  await command.execute({ sessionID: context.sessionID, prompt: { text: "stop" } })
  assert.equal(await status(), "stopped")
  child = true
  await assert.rejects(start, /primary session/)
} finally { await cleanup() }
// Auto-watch core: silent renewal and backoff, one wake per distinct input, explicit wait wins.
{
  let clock = 0
  let answer = state()
  const woke = []
  const auto = createDndWatcher({
    now: () => clock,
    read: async () => { if (answer instanceof Error) throw answer; return answer },
    wake: async (_sessionID, result) => woke.push(result),
  })
  const autoContext = { sessionID: "ses_auto", agent: "dnd-narrator" }
  assert.equal(auto.start(input, autoContext, { auto: true }).auto, true)
  clock = 61_000
  await auto.tick()
  assert.equal(woke.length, 0, "an automatic deadline renews silently")
  assert.equal(auto.status("ses_auto").status, "waiting")
  answer = new Error("transient transport failure")
  await auto.tick()
  assert.equal(woke.length, 0, "an automatic read failure backs off without waking the model")
  answer = state({ currentSeq: 11, nextCursor: 11, messages: [{ seq: 11, authorType: "player", kind: "do" }] })
  await auto.tick()
  assert.equal(woke.length, 0, "backoff delays the next read")
  clock += 6_001
  await auto.tick()
  assert.equal(woke.length, 1)
  assert.equal(woke[0].reason, "player")
  assert.equal(woke[0].auto, true)
  // The narrator never read the message: a re-arm from the stale cursor must not wake it again.
  auto.start(input, autoContext, { auto: true })
  await auto.tick()
  assert.equal(woke.length, 1, "the same input never wakes the model twice")
  assert.equal(auto.status("ses_auto").status, "waiting")
  answer = state({ currentSeq: 12, nextCursor: 12, messages: [{ seq: 12, authorType: "player", kind: "say" }] })
  await auto.tick()
  assert.equal(woke.length, 2, "a new message wakes again")
  auto.start(input, autoContext, { auto: true })
  answer = state({ asks: [{ id: "ask-1", status: "pending" }] })
  await auto.tick()
  assert.equal(woke.length, 3)
  auto.start(input, autoContext, { auto: true })
  await auto.tick()
  assert.equal(woke.length, 3, "an unanswered ask must not busy-loop the model")
  auto.stop("ses_auto")
  auto.start({ ...input, afterSeq: 5 }, autoContext)
  assert.equal(auto.start(input, autoContext, { auto: true }).afterSeq, 5, "auto never replaces an explicit wait")
  auto.stop("ses_auto")
  auto.start(input, autoContext, { auto: true })
  assert.equal(auto.start({ ...input, afterSeq: 7 }, autoContext).auto, undefined, "an explicit start replaces the automatic one")
  auto.close()
}

// Auto-watch plugin: a drained narrator read arms the wait after the turn; the operator controls it.
{
  let events, command
  const notices = []
  const stream = new ReadableStream({ start(controller) { events = controller } })
  const registration = () => ({ dispose: async () => {} })
  let page = state({ currentSeq: 20, nextCursor: 20 })
  const narratorTool = { execute: async () => ({ output: JSON.stringify(page) }) }
  const cleanup = await plugin.setup({
    location: { directory: "/game" },
    mcp: { list: async () => ({ data: [{ name: "odm_narrator", status: { status: "connected" } }] }) },
    tool: { transform: async apply => {
      apply({ add: () => {}, get: name => name === "odm_narrator_odm_narrator" ? narratorTool : undefined, update: (_name, fn) => fn(narratorTool) })
      return registration()
    } },
    command: { transform: async apply => { apply({ add: value => { command = value } }); return registration() } },
    session: {
      hook: async () => registration(),
      get: async () => ({ agent: "dnd-narrator", parentID: null, location: { directory: "/game" } }),
      synthetic: async value => notices.push(value),
    },
    event: { subscribe: ({ signal }) => {
      signal.addEventListener("abort", () => events.close(), { once: true })
      return stream.values()
    } },
  })
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
  const idle = async sessionID => { events.enqueue({ type: "session.idle", data: { sessionID } }); await settle() }
  const status = async sessionID => {
    await command.execute({ sessionID, prompt: { text: "status" } })
    return JSON.parse(notices.at(-1).text.replace(/^DnD watcher: /, ""))
  }
  try {
    const narrator = { sessionID: "ses_table", agent: "dnd-narrator" }
    await idle(narrator.sessionID)
    assert.equal((await status(narrator.sessionID)).status, "stopped", "nothing to watch before the narrator reads a campaign")
    page = { format: "odm.read.page.v1", complete: false, nextPage: "p2", currentSeq: 20, nextCursor: 20, hasMore: false, entries: [] }
    await narratorTool.execute({ operation: "read", campaignId, afterSeq: 0, paged: true }, narrator)
    await idle(narrator.sessionID)
    assert.equal((await status(narrator.sessionID)).status, "stopped", "an undrained page is not a processed cursor")
    page = state({ currentSeq: 20, nextCursor: 20 })
    await narratorTool.execute({ operation: "read", campaignId, afterSeq: 0 }, { ...narrator, odmBackgroundRead: true })
    await idle(narrator.sessionID)
    assert.equal((await status(narrator.sessionID)).status, "stopped", "the watcher's own reads never count as the narrator's")
    await narratorTool.execute({ operation: "read", campaignId, afterSeq: 0 }, narrator)
    await idle(narrator.sessionID)
    let current = await status(narrator.sessionID)
    assert.equal(current.status, "waiting", "the turn ends and the host starts waiting on its own")
    assert.equal(current.auto, true)
    assert.equal(current.afterSeq, 20, "armed from the cursor the narrator drained")
    assert.equal(current.autoWatch, true)
    await command.execute({ sessionID: narrator.sessionID, prompt: { text: "stop" } })
    await idle(narrator.sessionID)
    current = await status(narrator.sessionID)
    assert.equal(current.status, "stopped", "operator stop turns auto-watch off")
    assert.equal(current.autoWatch, false)
    await command.execute({ sessionID: narrator.sessionID, prompt: { text: "auto" } })
    assert.equal((await status(narrator.sessionID)).status, "waiting", "operator auto turns it back on")
    const coder = { sessionID: "ses_code", agent: "build" }
    await narratorTool.execute({ operation: "read", campaignId, afterSeq: 0 }, coder)
    await idle(coder.sessionID)
    assert.equal((await status(coder.sessionID)).status, "stopped", "non-D&D agents are never auto-watched")
  } finally { await cleanup() }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Push doorbell wire format: signals only, partial frames wait for more bytes.
{
  const { events, rest } = parseSse(': ping\n\nid: 7\nevent: message_added\ndata: {"type":"message_added","seq":7,"authorType":"player","kind":"do"}\n\nevent: ask_activity\ndata: {"type":"ask_activity"}\n\nevent: roll')
  assert.deepEqual(events.map(event => event.type), ["ping", "message_added", "ask_activity"])
  assert.equal(events[1].seq, 7)
  assert.equal(events[1].data.authorType, "player")
  assert.equal(events[2].seq, undefined)
  assert.equal(rest, "event: roll")
  assert.ok(isDoorbell(events[1]))
  assert.ok(isDoorbell(events[2]))
  assert.ok(!isDoorbell({ type: "message_added", data: { authorType: "dm" } }), "the DM's own narration never rings")
  assert.ok(!isDoorbell({ type: "message_added", data: { authorType: "player", kind: "ooc" } }))
  assert.ok(!isDoorbell({ type: "mcp_control", data: {} }), "the watcher's own reads never ring the doorbell")
  assert.ok(isDoorbell({ type: "roll_result", data: {} }))
  assert.ok(isDoorbell({ type: "message_added", data: {} }), "a server without author metadata still rings")
}

// The doorbell URL and credentials come from the configured odm_narrator server.
{
  const directory = mkdtempSync(join(tmpdir(), "dnd-watch-endpoint-"))
  const empty = { OPENCODE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "dnd-watch-empty-")) }
  const tokenFile = join(directory, "token")
  writeFileSync(tokenFile, "tok\n")
  process.env.DND_WATCH_TEST_HEADER = "v"
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ mcp: { servers: { odm_narrator: { type: "remote", url: "https://odm.test/mcp", headers: { Authorization: `Bearer {file:${tokenFile}}`, "X-Test": "{env:DND_WATCH_TEST_HEADER}" } } } } }))
  assert.deepEqual(narratorEndpoint(directory, empty), { url: "https://odm.test/mcp/events", headers: { Authorization: "Bearer tok", "X-Test": "v" } })
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ mcp: { servers: { odm_narrator: { type: "remote", url: "https://odm.test/other" } } } }))
  assert.equal(narratorEndpoint(directory, empty), undefined, "only an …/mcp endpoint has a sibling doorbell")
  assert.equal(narratorEndpoint(mkdtempSync(join(tmpdir(), "dnd-watch-none-")), empty), undefined, "no narrator server, no push")
  delete process.env.DND_WATCH_TEST_HEADER
}

// Links reconnect after a drop, resume after the last seen event and fall back on old servers.
{
  const calls = []
  const signals = []
  let stream
  const encoder = new TextEncoder()
  const links = createPushLinks({
    retryMs: 5,
    endpoint: () => ({ url: "https://odm.test/mcp/events", headers: { Authorization: "Bearer tok" } }),
    onSignal: (_campaignId, signal) => signals.push(signal),
    onState: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 3) return new Response("{}", { status: 404 })
      return new Response(new ReadableStream({ start(controller) { stream = controller } }), { status: 200 })
    },
  })
  links.ensure(campaignId, 20)
  await wait(20)
  assert.equal(new URL(calls[0].url).searchParams.get("afterSeq"), "20")
  assert.equal(calls[0].init.headers["last-event-id"], "20")
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok")
  assert.equal(links.state(campaignId).state, "connecting")
  stream.enqueue(encoder.encode('id: 21\nevent: message_added\ndata: {"authorType":"player"}\n\nevent: stream_checkpoint\ndata: {}\n\n'))
  await wait(20)
  assert.deepEqual(signals.map(signal => signal.type), ["message_added", "connected"])
  assert.equal(links.state(campaignId).state, "live")
  stream.close()
  await wait(60)
  assert.ok(calls.length >= 2, "a dropped link reconnects on its own")
  assert.equal(calls[1].init.headers["last-event-id"], "21", "and resumes after the last seen event")
  stream.close()
  await wait(80)
  assert.equal(links.state(campaignId).state, "unsupported", "a server without /mcp/events leaves the watcher polling")
  links.closeAll()
  assert.equal(links.state(campaignId).state, "off")
}

// Core push semantics: a live link replaces polling with doorbell reads plus a rare safety read.
{
  let clock = 0
  let answer = state()
  let count = 0
  const push = createDndWatcher({ now: () => clock, read: async () => { count++; return answer }, wake: async () => {} })
  const pushContext = { sessionID: "ses_push_core", agent: "dnd-narrator" }
  push.start(input, pushContext, { auto: true })
  await push.tick()
  await push.tick()
  assert.equal(count, 2, "without a live link the watcher polls every tick")
  push.setPush(campaignId, true)
  await push.tick()
  assert.equal(count, 3, "going live reads once to catch up")
  await push.tick()
  await push.tick()
  assert.equal(count, 3, "a live link does not poll")
  assert.equal(push.poke(campaignId), 1000)
  await push.tick()
  assert.equal(count, 3, "a doorbell respects the minimum read gap")
  clock = 1000
  await push.tick()
  assert.equal(count, 4, "a doorbell reads")
  clock += 5 * 60_000
  await push.tick()
  assert.equal(count, 5, "a safety read still runs every few minutes")
  push.setPush(campaignId, false)
  await push.tick()
  await push.tick()
  assert.equal(count, 7, "polling resumes as soon as the link drops")
  push.setPush(campaignId, true)
  await push.tick()
  let release
  answer = new Promise(resolve => { release = resolve })
  clock += 5 * 60_000
  const flight = push.tick()
  await Promise.resolve()
  push.poke(campaignId)
  release(state())
  await flight
  clock += 1000
  await push.tick()
  assert.equal(count, 10, "a doorbell during an in-flight read gets its own read")
  assert.equal(push.poke("00000000-0000-4000-8000-000000000000"), undefined, "other campaigns are not woken")
  push.close()
}

// A woken turn that failed may wake again for the same input, after its delay.
{
  let clock = 0
  const woke = []
  const retry = createDndWatcher({
    now: () => clock,
    read: async () => state({ currentSeq: 11, nextCursor: 11, messages: [{ seq: 11, authorType: "player", kind: "do" }] }),
    wake: async (_sessionID, result) => woke.push(result),
  })
  const retryContext = { sessionID: "ses_retry", agent: "dnd-narrator" }
  retry.start(input, retryContext, { auto: true })
  await retry.tick()
  retry.start(input, retryContext, { auto: true })
  await retry.tick()
  assert.equal(woke.length, 1, "the same input is deduplicated")
  retry.forget(retryContext.sessionID)
  retry.stop(retryContext.sessionID)
  retry.start(input, retryContext, { auto: true, delayMs: 30_000 })
  await retry.tick()
  assert.equal(woke.length, 1, "a retry waits for its delay")
  clock = 30_000
  await retry.tick()
  assert.equal(woke.length, 2, "after a failed turn the same input wakes the DM again")
  retry.close()
}

// Keep-awake: a watcher hold keeps the PC awake without any busy session.
{
  const { holdAwake, releaseAwake, observe } = await import("../config/plugins/keep-awake.js")
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(observe(null), false)
    holdAwake("dnd_watch")
    assert.equal(observe(null), true)
    releaseAwake("dnd_watch")
    assert.equal(observe(null), false)
  } finally { console.warn = warn }
}

// Plugin end to end: push link, doorbell wake, failed-turn retry, status file, restart recovery.
{
  const location = mkdtempSync(join(tmpdir(), "dnd-watch-table-"))
  const tokenFile = join(location, "token")
  writeFileSync(tokenFile, "secret-token\n")
  writeFileSync(join(location, "opencode.json"), JSON.stringify({ mcp: { servers: { odm_narrator: { type: "remote", url: "https://odm.test/mcp", headers: { Authorization: `Bearer {file:${tokenFile}}` } } } } }))
  process.env.DND_WATCH_PUSH = "1"
  const requests = []
  let stream
  const encoder = new TextEncoder()
  const send = text => stream.enqueue(encoder.encode(text))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers })
    const body = new ReadableStream({ start(controller) { stream = controller } })
    init.signal?.addEventListener("abort", () => { try { stream.close() } catch {} }, { once: true })
    return new Response(body, { status: 200 })
  }
  let page = state({ currentSeq: 20, nextCursor: 20 })
  let backgroundReads = 0
  const narratorTool = { execute: async (_input, ctx) => { if (ctx.odmBackgroundRead) backgroundReads++; return { output: JSON.stringify(page) } } }
  const start = async () => {
    let events, tool, command
    const notices = []
    const feed = new ReadableStream({ start(controller) { events = controller } })
    const registration = () => ({ dispose: async () => {} })
    const cleanup = await plugin.setup({
      location: { directory: location },
      mcp: { list: async () => ({ data: [{ name: "odm_narrator", status: { status: "connected" } }] }) },
      tool: { transform: async apply => {
        apply({ add: value => { tool = value }, get: name => name === "odm_narrator_odm_narrator" ? narratorTool : undefined, update: (_name, fn) => fn(narratorTool) })
        return registration()
      } },
      command: { transform: async apply => { apply({ add: value => { command = value } }); return registration() } },
      session: {
        hook: async () => registration(),
        get: async () => ({ agent: "dnd-narrator", parentID: null, location: { directory: location } }),
        synthetic: async value => notices.push(value),
      },
      event: { subscribe: ({ signal }) => {
        signal.addEventListener("abort", () => events.close(), { once: true })
        return feed.values()
      } },
    })
    const emit = async (type, data = {}) => { events.enqueue({ type, data }); for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
    const status = async sessionID => {
      await command.execute({ sessionID, prompt: { text: "status" } })
      return JSON.parse(notices.at(-1).text.replace(/^DnD watcher: /, ""))
    }
    return { cleanup, emit, status, notices, tool: () => tool }
  }
  const narrator = { sessionID: "ses_push", agent: "dnd-narrator", messageID: "msg_1", id: "call_1" }
  const table = await start()
  try {
    await narratorTool.execute({ operation: "read", campaignId, afterSeq: 0 }, narrator)
    await table.emit("session.idle", { sessionID: narrator.sessionID })
    assert.equal(requests.length, 1, "arming opens one push link")
    const url = new URL(requests[0].url)
    assert.equal(url.origin + url.pathname, "https://odm.test/mcp/events")
    assert.equal(url.searchParams.get("campaignId"), campaignId)
    assert.equal(url.searchParams.get("afterSeq"), "20", "the link starts at the cursor the narrator drained")
    assert.equal(requests[0].headers.Authorization, "Bearer secret-token")
    await wait(350)
    send(": ping\n\nevent: stream_checkpoint\ndata: {}\n\n")
    await wait(350)
    const live = backgroundReads
    assert.ok(live >= 1)
    assert.equal((await table.status(narrator.sessionID)).push, "live")
    send('id: 21\nevent: message_added\ndata: {"type":"message_added","seq":21,"authorType":"dm"}\n\n')
    await wait(1300)
    assert.equal(backgroundReads, live, "the DM's own narration does not trigger a read")
    page = state({ currentSeq: 22, nextCursor: 22, messages: [{ seq: 22, authorType: "player", kind: "do", content: "SECRET MOVE" }] })
    send('id: 22\nevent: message_added\ndata: {"type":"message_added","seq":22,"authorType":"player","kind":"do"}\n\n')
    await wait(400)
    assert.equal(backgroundReads, live + 1, "a player's message is read right away, without polling")
    const wake = table.notices.find(notice => notice.resume === true)
    assert.ok(wake, "the doorbell woke the narrator session")
    assert.ok(!JSON.stringify(table.notices).includes("SECRET MOVE"))
    await wait(300)
    const saved = readFileSync(stateFileFor(location), "utf8")
    const snapshot = JSON.parse(saved).sessions[narrator.sessionID]
    assert.equal(snapshot.link.state, "live")
    assert.equal(snapshot.watch.status, "triggered")
    assert.ok(snapshot.log.some(item => item.text === "проснулся: ход игрока"))
    assert.deepEqual(snapshot.context, { sessionID: "ses_push", agent: "dnd-narrator", messageID: "msg_1", id: "call_1" })
    assert.ok(!saved.includes("SECRET") && !saved.includes("secret-token"), "no game text or token in the status file")
    const panel = (await readWatchStates(join(stateRoot, "dnd-watch"))).get(narrator.sessionID)
    assert.equal(panel.campaignId, campaignId)
    assert.match(describeWatch(panel, panel.updatedAt).headline, /будит мастера/)
    // The woken turn fails (provider error): the input is retried after a delay.
    await table.emit("session.execution.started", { sessionID: narrator.sessionID })
    await table.emit("session.execution.failed", { sessionID: narrator.sessionID, error: { name: "ProviderError" } })
    const retrying = await table.status(narrator.sessionID)
    assert.equal(retrying.turn, "retry")
    assert.equal(retrying.status, "waiting", "a failed woken turn re-arms itself")
    // The model "arming" a wait itself must not replace the automatic one.
    const own = JSON.parse((await table.tool().execute({ action: "start", campaignId, afterSeq: 5 }, narrator)).content)
    assert.equal(own.status, "auto")
    const kept = await table.status(narrator.sessionID)
    assert.equal(kept.auto, true, "a model-armed wait never replaces the automatic one")
    assert.equal(kept.afterSeq, 20)
  } finally { await table.cleanup() }
  const stopped = JSON.parse(readFileSync(stateFileFor(location), "utf8"))
  assert.ok(stopped.stoppedAt, "a stopped service is visible to the panel")
  assert.match(describeWatch({ ...stopped.sessions[narrator.sessionID], updatedAt: stopped.updatedAt, stoppedAt: stopped.stoppedAt }).headline, /остановлен/)
  // Restart: a new process restores the table and waits again without a narrator turn
  // (with the player's input still unhandled it would wake the DM right away).
  page = state({ currentSeq: 22, nextCursor: 22 })
  const restarted = await start()
  try {
    await wait(1300)
    const current = await restarted.status(narrator.sessionID)
    assert.equal(current.status, "waiting", "the watcher survives an opencode restart")
    assert.equal(current.auto, true)
    const log = JSON.parse(readFileSync(stateFileFor(location), "utf8")).sessions[narrator.sessionID].log
    assert.ok(log.some(item => item.text === "восстановлен после перезапуска opencode"))
  } finally {
    await restarted.cleanup()
    globalThis.fetch = realFetch
    process.env.DND_WATCH_PUSH = "0"
  }
}

// Sidebar panel view model.
{
  const at = Date.UTC(2026, 8, 29, 0, 0, 0)
  const log = Array.from({ length: 6 }, (_, index) => ({ at: at - index * 60_000, text: `event ${index}` }))
  const base = { campaignId, cursor: 2173, autoWatch: true, updatedAt: at, watch: { status: "waiting", auto: true, errors: 0 }, link: { state: "live" }, log }
  const waitingView = describeWatch(base, at + 1000)
  assert.equal(waitingView.headline, "● ждёт игроков")
  assert.equal(waitingView.tone, "ok")
  assert.deepEqual(waitingView.rows.find(row => row[0] === "Связь"), ["Связь", "● push, онлайн"])
  assert.equal(waitingView.rows.find(row => row[0] === "Курсор")[1], "#2173 · авто")
  assert.equal(waitingView.log.length, 4)
  assert.equal(waitingView.ticking, false, "an idle wait does not re-render every second")
  assert.match(describeWatch({ ...base, turn: { state: "running", startedAt: at - 42_000 } }, at).headline, /разбирает ход · 0:42/)
  assert.match(describeWatch({ ...base, turn: { state: "retry", retryAt: at + 30_000 } }, at).headline, /повтор через 30с/)
  assert.match(describeWatch({ ...base, watch: { status: "waiting", errors: 2, retryAt: at + 12_000 } }, at).headline, /ODM недоступен, повтор 12с/)
  assert.match(describeWatch({ ...base, link: { state: "reconnecting", retryAt: at + 8000 } }, at).rows.find(row => row[0] === "Связь")[1], /переподключение 8с/)
  assert.match(describeWatch(base, at + 60_000).headline, /не отвечает/, "a silent server plugin is flagged")
  assert.equal(describeWatch({ ...base, autoWatch: false, watch: { status: "stopped" } }, at).hint, "/dnd-watch auto — включить")
  assert.equal(describeWatch(undefined).headline, "○ не подключён")
  assert.ok(isTableSession({ agent: "dnd-narrator" }))
  assert.ok(isTableSession({ agent: "build", location: { directory: "/srv/tables/dungeon_master" } }))
  assert.ok(!isTableSession({ agent: "build", location: { directory: "/srv/code/custom_opencode" } }), "the panel stays out of other projects")
}
assert.ok(existsSync(join(stateRoot, "dnd-watch")))
console.log("DnD watcher: idle, one-shot wake, privacy, paging, stop races, session lifecycle, permissions surface, timeout and errors, D&D-only exposure, bounded entries, auto-watch renewal/backoff/dedupe/priority/arming/operator control, push doorbell/reconnect/fallback, failed-turn retry, keep-awake hold, status file, restart recovery and sidebar view passed")
