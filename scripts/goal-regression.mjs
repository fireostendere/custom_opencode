import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as immediate } from "node:timers/promises"
import { createHash } from "node:crypto"
import plugin from "../config/plugins/goal.js"
import { filterHardwareTools } from "../config/plugins/hardware-orchestrator.js"

mock.timers.enable({ apis: ["setTimeout"] })
const flush = async () => { for (let i = 0; i < 5; i++) await immediate() }
const advance = async ms => { mock.timers.tick(ms); await flush() }
const directory = "/fixture/project"
const sessionID = "ses_goal"
const db = new Map()
let disposed = 0
async function harness() {
  let command, tool, hook, events
  const notices = [], interruptions = []
  const stream = new ReadableStream({ start: controller => { events = controller } })
  const registration = () => ({ dispose: () => { disposed++ } })
  const ctx = {
    location: { directory },
    storage: {
      get: async key => structuredClone(db.get(key)),
      scan: async ({ prefix, after, limit }) => {
        const entries = [...db].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
        return { entries }
      },
      set: async (key, value) => { db.set(key, structuredClone(value)) },
      remove: async key => db.delete(key),
    },
    command: { transform: async fn => { fn({ add: value => { command = value } }); return registration() } },
    tool: { transform: async fn => { fn({ add: value => { tool = value } }); return registration() } },
    session: {
      get: async ({ sessionID: id }) => ({ agent: id === "dnd" ? "dnd-narrator" : "build", ...(id === "child" ? { parentID: sessionID } : {}), location: { directory } }),
      synthetic: async value => { notices.push(value) },
      interrupt: async value => { interruptions.push(value) },
      hook: async (name, fn) => { assert.equal(name, "context"); hook = fn; return registration() },
    },
    event: { subscribe: ({ signal }) => { signal.addEventListener("abort", () => events.close(), { once: true }); return stream } },
  }
  const cleanup = await plugin.setup(ctx)
  const emit = async (type, data = {}) => { events.enqueue({ type, data: { sessionID, ...data } }); await flush() }
  const run = text => command.execute({ sessionID, prompt: { text } })
  const goal = () => [...db.values()].find(value => value.objective)
  const wakes = () => notices.filter(value => value.resume)
  const context = (agent = "build", id = sessionID) => ({ sessionID: id, agent, system: [], tools: { goal_update: {}, read: {} } })
  return { ctx, command, tool, hook, notices, interruptions, cleanup, emit, run, goal, wakes, context }
}

let h = await harness()
try {
  assert.equal(h.command.name, "goal")
  assert.equal(h.tool.options.pinned, true)
  await h.run("")
  assert.equal(h.wakes().length, 0)
  assert.match(h.notices.at(-1).text, /нет цели/)
  for (const id of ["child", "dnd"]) await assert.rejects(h.command.execute({ sessionID: id, prompt: { text: "Do work" } }), /основной/)
  await assert.rejects(h.run("x".repeat(16001)), /16000/)

  await h.run("Исправь баг и проверь результат")
  await advance(0)
  assert.equal(h.wakes().length, 1)
  assert.equal(h.wakes()[0].delivery, "queue")
  assert.match(h.wakes()[0].text, /Исправь баг/)
  const firstID = h.goal().id
  const event = h.context()
  h.hook(event); h.hook(event)
  assert.equal(event.system.length, 1, "goal survives fresh/compacted context without duplicates")
  assert.match(event.system[0].text, /Never bypass permissions/)
  for (const [agent, id] of [["title", sessionID], ["compaction", sessionID], ["role-builder", "child"], ["dnd-narrator", sessionID]]) {
    const context = h.context(agent, id)
    h.hook(context)
    assert.deepEqual(Object.keys(context.tools), ["read"])
    assert.equal(context.system.length, 0)
  }
  assert.deepEqual(filterHardwareTools(["goal_update", "shell"], true), ["goal_update"])

  await h.emit("session.execution.started")
  await h.emit("session.execution.succeeded")
  await h.emit("session.idle")
  await h.emit("session.idle")
  await h.run("status")
  await advance(750)
  assert.equal(h.wakes().length, 2, "premature final resumes once; status and duplicate idle do not add turns")
  await h.emit("session.execution.started")
  const update = (status, summary, goalID = h.goal().id) => h.tool.execute({ goalID, status, summary }, { sessionID, agent: "build" })
  await assert.rejects(update("completed", " "), /Summary/)
  await assert.rejects(update("paused", "bad"), /Invalid/)
  await update("active", "Баг исправлен, осталось проверить")
  assert.equal(h.goal().status, "active")
  await update("completed", "Тест пройден; вся цель выполнена")
  await h.emit("session.idle")
  await advance(300000)
  assert.equal(h.wakes().length, 2, "completed goals never wake")
  await h.run("stop")
  assert.equal(h.goal().status, "completed", "stop must not reopen a completed goal")
  await assert.rejects(h.run("resume"), /Нет незавершённой/)

  await h.run("Следующая цель")
  await assert.rejects(update("completed", "stale", firstID), /matching active/)
  await advance(0)
  assert.equal(h.wakes().length, 3, "a new goal after completion starts normally")
  await h.emit("session.execution.started")
  await h.emit("session.idle")
  await h.run("stop")
  await advance(750)
  assert.equal(h.wakes().length, 3)
  assert.equal(h.goal().status, "paused")
  assert.deepEqual(h.interruptions.at(-1), { sessionID, resume: false })
  await h.run("resume")
  await advance(0)
  assert.equal(h.wakes().length, 4)
  await h.emit("session.execution.started")
  await h.emit("session.execution.interrupted", { reason: "user" })
  await h.emit("session.idle")
  await advance(300000)
  assert.equal(h.goal().status, "paused")
  assert.equal(h.wakes().length, 4, "manual interruption cannot be undone by the watcher")

  await h.run("resume"); await advance(0)
  const beforeFailures = h.wakes().length
  for (let attempt = 1; attempt <= 5; attempt++) {
    await h.emit("session.execution.started")
    await h.emit("session.execution.failed", { error: { message: "Provider temporarily unavailable" } })
    await h.emit("session.idle")
    await advance(300000)
    assert.equal(h.wakes().length, beforeFailures + Math.min(attempt, 4))
  }
  assert.equal(h.goal().status, "blocked")
  await h.run("resume"); await advance(0)
  const beforeBudget = h.wakes().length
  await h.emit("session.execution.started")
  await h.emit("session.execution.failed", { error: { message: "BudgetExceeded: model call budget exhausted" } })
  await h.emit("session.idle")
  await advance(300000)
  assert.equal(h.wakes().length, beforeBudget, "runtime budget errors are not retried")
  assert.equal(h.goal().status, "blocked")

  await h.run("resume"); await advance(0)
  await h.emit("session.execution.started")
  await h.emit("session.execution.interrupted", { reason: "shutdown" })
  await h.cleanup()
  h = await harness()
  await advance(1000)
  assert.equal(h.wakes().length, 1, "an active goal resumes after service restart")
  assert.equal(h.goal().status, "active")
  await update("blocked", "Нужен ответ пользователя")
  await h.emit("session.idle")
  await advance(300000)
  assert.equal(h.wakes().length, 1, "a genuine blocker parks the goal")
  await h.cleanup()
  h = await harness()
  await advance(1000)
  assert.equal(h.wakes().length, 0, "restart respects blocked and paused goals")

  await h.run("resume")
  let release
  h.ctx.session.get = () => new Promise(resolve => { release = resolve })
  await advance(0)
  await h.run("stop")
  release({ agent: "build", location: { directory } })
  await flush()
  assert.equal(h.wakes().length, 0, "stop cancels a wake awaiting session lookup")
  h.ctx.session.get = async () => ({ agent: "build", location: { directory } })
  await h.run("resume")
  await h.emit("session.inbox.enqueued", { item: { type: "user" } })
  await advance(0)
  assert.equal(h.wakes().length, 0, "user steering takes precedence over a pending continuation")
  await h.emit("session.execution.started")
  await h.emit("session.idle")
  await advance(750)
  assert.equal(h.wakes().length, 1, "steering keeps the goal active")
  await h.emit("session.moved")
  await advance(300000)
  assert.equal(h.goal().status, "blocked")
  await h.emit("session.deleted")
  assert.equal(db.size, 0)

  await h.cleanup()
  const prefix = `goals:${createHash('sha256').update(directory).digest('hex')}:`
  const historical = (id, status = 'completed') => ({ id: 'goal-' + id, status, objective: 'Historical ' + id, summary: 'Saved result', turns: 2, failures: 0 })
  for (let i = 0; i < 100; i++) db.set(prefix + 'history-' + i, historical(i))
  db.set(prefix + 'untouched-completed', historical('untouched'))
  db.set(prefix + 'paused', historical('paused', 'paused'))
  db.set(prefix + 'legacy-blocked', { ...historical('legacy', 'blocked'), summary: 'Provider error '.repeat(160) })
  h = await harness()
  const commandFor = (id, text) => h.command.execute({ sessionID: id, prompt: { text } })
  await commandFor('legacy-blocked', 'status')
  assert.match(h.notices.at(-1).text, /Goal: blocked\nHistorical legacy/, 'older blocked summaries may exceed the tool summary limit')
  await commandFor('legacy-blocked', 'resume')
  await advance(0)
  assert.equal(h.wakes().at(-1).sessionID, 'legacy-blocked')
  await commandFor('legacy-blocked', 'stop')
  for (let i = 0; i < 100; i++) {
    await commandFor('history-' + i, 'status')
    assert.match(h.notices.at(-1).text, new RegExp('Historical ' + i))
  }
  await commandFor('history-0', 'status')
  assert.match(h.notices.at(-1).text, /Historical 0/, 'eviction must not discard durable goal history')
  await assert.rejects(commandFor('history-0', 'resume'), /Нет незавершённой/)
  await commandFor('paused', 'resume')
  await advance(0)
  assert.equal(h.wakes().at(-1).sessionID, 'paused', 'paused goals restore and resume on demand')
  await commandFor('paused', 'stop')
  await h.emit('session.deleted', { sessionID: 'untouched-completed' })
  assert.equal(db.has(prefix + 'untouched-completed'), false, 'deletion must remove a goal that was never loaded into RAM')

  const storageGet = h.ctx.storage.get
  const deletedValue = historical('deleted', 'paused')
  db.set(prefix + 'race-delete', deletedValue)
  let releaseRead
  h.ctx.storage.get = key => key === prefix + 'race-delete' ? new Promise(resolve => { releaseRead = resolve }) : storageGet(key)
  const restoringDeleted = commandFor('race-delete', 'resume')
  await flush()
  assert.equal(typeof releaseRead, 'function')
  await h.emit('session.deleted', { sessionID: 'race-delete' })
  releaseRead(deletedValue)
  await restoringDeleted
  await advance(0)
  assert.equal(db.has(prefix + 'race-delete'), false, 'a delayed read cannot resurrect a deleted goal')
  assert.equal(h.wakes().some(value => value.sessionID === 'race-delete'), false)
  h.ctx.storage.get = storageGet

  db.set(prefix + 'race-move', historical('moved', 'paused'))
  const sessionGet = h.ctx.session.get
  let releasePrimary
  h.ctx.session.get = input => input.sessionID === 'race-move' ? new Promise(resolve => { releasePrimary = resolve }) : sessionGet(input)
  const restoringMoved = commandFor('race-move', 'resume')
  await flush()
  assert.equal(typeof releasePrimary, 'function')
  await h.emit('session.moved', { sessionID: 'race-move' })
  releasePrimary({ agent: 'build', location: { directory } })
  await restoringMoved
  await advance(0)
  assert.equal(db.get(prefix + 'race-move').status, 'paused')
  assert.equal(h.wakes().some(value => value.sessionID === 'race-move'), false, 'moving during validation cancels the stale resume')
  h.ctx.session.get = sessionGet

  const storageSet = h.ctx.storage.set
  let releaseWrite
  h.ctx.storage.set = async (key, value) => {
    if (key === prefix + 'race-write') await new Promise(resolve => { releaseWrite = resolve })
    return storageSet(key, value)
  }
  const writingDeleted = commandFor('race-write', 'Start a new goal')
  await flush()
  assert.equal(typeof releaseWrite, 'function')
  await h.emit('session.deleted', { sessionID: 'race-write' })
  releaseWrite()
  await writingDeleted
  await advance(0)
  assert.equal(db.has(prefix + 'race-write'), false, 'serialized removal follows a slow snapshot write')
  assert.equal(h.wakes().some(value => value.sessionID === 'race-write'), false)
  h.ctx.storage.set = storageSet

  const previousValue = historical('replaced', 'paused')
  db.set(prefix + 'race-replace', previousValue)
  let releaseOld, firstRead = true
  h.ctx.storage.get = key => {
    if (key === prefix + 'race-replace' && firstRead) {
      firstRead = false
      return new Promise(resolve => { releaseOld = resolve })
    }
    return storageGet(key)
  }
  const staleStatus = commandFor('race-replace', 'status')
  await flush()
  await commandFor('race-replace', 'Newer objective')
  releaseOld(previousValue)
  await staleStatus
  await commandFor('race-replace', 'status')
  assert.match(h.notices.at(-1).text, /Newer objective/, 'an obsolete history read cannot replace a newly saved active goal')
  assert.equal(db.get(prefix + 'race-replace').objective, 'Newer objective')
  await commandFor('race-replace', 'stop')
} finally {
  await h.cleanup()
  mock.timers.reset()
}
assert.equal(disposed, 12)
console.log("Goal regression passed: continued finals, completion, stop/resume, steering, bounded retries, budgets, restart, on-demand history, isolation, deletion/move/write races and cancellation")
