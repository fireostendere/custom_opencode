import assert from "node:assert/strict"
import plugin, { createDndWatcher } from "../config/plugins/dnd-watch.js"
import { filterDndTools } from "../config/plugins/orchestrated-qwen.js"

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
console.log("DnD watcher: idle, one-shot wake, privacy, paging, stop races, session lifecycle, permissions surface, timeout and errors, D&D-only exposure, bounded entries, auto-watch renewal/backoff/dedupe/priority/arming/operator control passed")
