import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as immediate } from "node:timers/promises"
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
  assert.deepEqual(h.interruptions.at(-1), { sessionID, continue: false })
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
} finally {
  await h.cleanup()
  mock.timers.reset()
}
assert.equal(disposed, 9)
console.log("Goal regression passed: continued finals, completion, stop/resume, steering, bounded retries, budgets, restart, isolation, deletion and cancellation race")
