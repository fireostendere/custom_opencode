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
watcher.close()

// Native plugin lifecycle and zero-inference operator controls.
let events, tool, command
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
    get: async () => ({ agent: context.agent, parentID: child ? "ses_parent" : null, location: { directory: "/game" } }),
    synthetic: async value => notices.push(value),
  },
  event: { subscribe: ({ signal }) => {
    signal.addEventListener("abort", () => events.close(), { once: true })
    return stream.values()
  } },
})
try {
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
console.log("DnD watcher: idle, one-shot wake, privacy, paging, stop races, session lifecycle, permissions surface, timeout and errors passed")
