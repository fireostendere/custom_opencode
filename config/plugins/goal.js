import { randomUUID, createHash } from "node:crypto"
import { startEvents } from "../events.js"
import { isDndLane } from "./tui/lib/context-policy.js"

const TOOL = "goal_update"
const MARKER = "Custom active goal:"
const SUPPORT = new Set(["title", "summary", "compaction"])
const STATUSES = new Set(["active", "paused", "completed", "blocked"])
const MAX_FAILURES = 5
const HISTORY_ENTRIES = 32
function restored(value) {
  if (!value || typeof value.id !== "string" || !value.id || value.id.length > 128 || !STATUSES.has(value.status)
    || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 16000
    || !Number.isSafeInteger(value.turns) || value.turns < 0 || !Number.isSafeInteger(value.failures) || value.failures < 0
    || (value.summary !== undefined && typeof value.summary !== "string")) return
  return { id: value.id, objective: value.objective, status: value.status, turns: value.turns, failures: value.failures, summary: (value.summary || "").slice(0, 2000) }
}
const text = (value, limit, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label} must contain 1-${limit} characters`)
  return value.trim()
}

export default {
  id: "custom.goal",
  async setup(ctx) {
    const directory = ctx.location.directory
    const prefix = `goals:${createHash("sha256").update(directory).digest("hex")}:`
    // Active work stays resident. Historical objectives live in storage and are
    // read on demand; opening a project must not load every completed goal.
    const goals = new Map(), history = new Map(), loads = new Map(), operations = new Map()
    const timers = new Map(), running = new Set(), waking = new Set()
    const registrations = []
    let disposed = false, writes = Promise.resolve()
    const key = sessionID => prefix + sessionID
    const cancel = sessionID => {
      clearTimeout(timers.get(sessionID))
      timers.delete(sessionID)
    }
    const current = sessionID => goals.get(sessionID) || history.get(sessionID)
    const remember = (sessionID, goal) => {
      history.delete(sessionID)
      if (goal.status === "active") goals.set(sessionID, goal)
      else {
        goals.delete(sessionID)
        history.set(sessionID, goal)
        while (history.size > HISTORY_ENTRIES) history.delete(history.keys().next().value)
      }
    }
    const invalidate = sessionID => {
      const load = loads.get(sessionID)
      if (load) { load.cancelled = true; loads.delete(sessionID) }
      for (const operation of operations.get(sessionID) || []) operation.cancelled = true
    }
    const queue = action => (writes = writes.catch(() => {}).then(action))
    async function loadGoal(sessionID) {
      const cached = current(sessionID)
      if (cached) { remember(sessionID, cached); return cached }
      if (loads.has(sessionID)) return loads.get(sessionID).promise
      const load = { cancelled: false }
      load.promise = (async () => {
        await writes.catch(() => {})
        if (disposed || load.cancelled) return
        const value = await ctx.storage.get(key(sessionID))
        if (disposed || load.cancelled) return
        const goal = current(sessionID) || restored(value)
        if (goal) remember(sessionID, goal)
        return goal
      })().finally(() => { if (loads.get(sessionID) === load) loads.delete(sessionID) })
      loads.set(sessionID, load)
      return load.promise
    }
    // Serialize snapshots AND removal: an older async write must never restore
    // a deleted/stopped goal. In-flight reads cannot overwrite a newer snapshot.
    const save = (sessionID, goal) => {
      const load = loads.get(sessionID)
      if (load) { load.cancelled = true; loads.delete(sessionID) }
      remember(sessionID, goal)
      return queue(() => ctx.storage.set(key(sessionID), goal))
    }
    const receipt = (sessionID, goal) => ctx.session.synthetic({
      sessionID, resume: false,
      text: goal ? `Goal: ${goal.status}\n${goal.objective}\nХодов: ${goal.turns}${goal.summary ? `\n${goal.summary}` : ""}` : "Goal: нет цели. /goal <задача> | status | stop | resume",
    })
    async function primary(sessionID) {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID || SUPPORT.has(session.agent) || isDndLane(session) || session.location?.directory !== directory)
        throw new Error("/goal доступен в основной рабочей сессии; для D&D используйте /dnd-watch")
      return session
    }
    async function block(sessionID, summary) {
      const goal = goals.get(sessionID)
      if (goal?.status !== "active") return
      cancel(sessionID)
      const blocked = { ...goal, status: "blocked", summary: summary.slice(0, 2000) }
      await save(sessionID, blocked)
      await receipt(sessionID, current(sessionID) || blocked)
    }
    async function failed(sessionID, error) {
      const goal = goals.get(sessionID)
      if (goal?.status !== "active") return
      const summary = String(error?.message || error || "Ход завершился ошибкой").slice(0, 2000)
      const failures = goal.failures + 1
      if (failures >= MAX_FAILURES || /BudgetExceeded|бюджет.*исчерпан|permission.*denied|unauthorized|authentication|\b40[13]\b/i.test(summary))
        return block(sessionID, `Продолжение остановлено: ${summary}. /goal resume — повторить.`)
      await save(sessionID, { ...goal, failures, summary })
      schedule(sessionID, Math.min(30_000 * 2 ** (failures - 1), 300_000))
    }
    async function wake(sessionID, goalID) {
      if (disposed || goals.get(sessionID)?.id !== goalID || goals.get(sessionID)?.status !== "active") return
      if (waking.has(sessionID)) { schedule(sessionID); return }
      waking.add(sessionID)
      try {
        await primary(sessionID)
        const goal = goals.get(sessionID)
        if (disposed || goal?.id !== goalID || goal.status !== "active" || running.has(sessionID)) return
        await save(sessionID, { ...goal, turns: goal.turns + 1 })
        if (disposed || goals.get(sessionID)?.id !== goalID || goals.get(sessionID)?.status !== "active") return
        await ctx.session.synthetic({
          sessionID, delivery: "queue", resume: true,
          text: `Продолжай активную цель ${goalID}: ${goal.objective}\nДоведи оставшуюся работу до проверенного результата. Ответ сам по себе не завершает цель: используй goal_update с текущим goalID для completed или конкретного blocked.`,
          metadata: { goalID },
        })
      } catch (error) {
        if (goals.get(sessionID)?.id === goalID) await failed(sessionID, error)
      } finally { waking.delete(sessionID) }
    }
    function schedule(sessionID, delay = 750) {
      const goal = goals.get(sessionID)
      if (disposed || goal?.status !== "active" || timers.has(sessionID)) return
      const timer = setTimeout(() => {
        timers.delete(sessionID)
        void wake(sessionID, goal.id).catch(error => console.warn(`[goal] ${error?.message ?? error}`))
      }, delay)
      timer.unref?.()
      timers.set(sessionID, timer)
    }

    let after
    do {
      const page = await ctx.storage.scan({ prefix, after, limit: 100 })
      for (const { key: savedKey, value } of page.entries) {
        const goal = restored(value)
        if (goal?.status === "active") goals.set(savedKey.slice(prefix.length), goal)
      }
      after = page.next
    } while (after)

    registrations.push(await ctx.command.transform(commands => commands.add({
      name: "goal", description: "Работать до результата: /goal <задача> | status | stop | resume",
      execute: async ({ sessionID, prompt }) => {
        const requested = String(prompt?.text || "").trim()
        if (requested && requested !== "status") invalidate(sessionID)
        const operation = { cancelled: false }, pending = operations.get(sessionID) || new Set()
        pending.add(operation)
        operations.set(sessionID, pending)
        const valid = () => !disposed && !operation.cancelled
        try {
          let goal = await loadGoal(sessionID)
          if (!valid()) return
          goal = current(sessionID) || goal
          if (!requested || requested === "status") return receipt(sessionID, goal)
          if (requested === "stop") {
            cancel(sessionID)
            if (goal && goal.status !== "completed") {
              goal = { ...goal, status: "paused", summary: "Остановлено пользователем" }
              await save(sessionID, goal)
            }
            if (!valid()) return
            await ctx.session.interrupt({ sessionID, resume: false })
            if (valid()) return receipt(sessionID, current(sessionID) || goal)
            return
          }
          await primary(sessionID)
          if (!valid()) return
          goal = current(sessionID) || goal
          if (requested === "resume") {
            if (!goal || goal.status === "completed") throw new Error("Нет незавершённой цели. /goal <задача>")
            goal = { ...goal, status: "active", failures: 0, summary: "" }
          } else goal = { id: randomUUID(), objective: text(requested, 16000, "Goal"), status: "active", turns: 0, failures: 0, summary: "" }
          cancel(sessionID)
          await save(sessionID, goal)
          if (valid()) schedule(sessionID, 0)
        } finally {
          pending.delete(operation)
          if (!pending.size && operations.get(sessionID) === pending) operations.delete(sessionID)
        }
      },
    })))
    registrations.push(await ctx.tool.transform(tools => tools.add({
      name: TOOL, description: "Update the active user goal at a milestone. completed requires the full verified result; blocked requires a concrete missing user input or external blocker. A final answer alone never closes the goal. Use the goalID from the active goal policy.",
      input: {
        type: "object", additionalProperties: false, required: ["goalID", "status", "summary"],
        properties: {
          goalID: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["active", "completed", "blocked"] },
          summary: { type: "string", minLength: 1, maxLength: 2000, description: "Progress, completion evidence, or exact blocker" },
        },
      },
      options: { pinned: true, codemode: false },
      execute: async (input, context) => {
        const goal = goals.get(context.sessionID)
        if (goal?.status !== "active" || input.goalID !== goal.id || SUPPORT.has(context.agent)) throw new Error("No matching active goal in this session")
        if (!["active", "completed", "blocked"].includes(input.status)) throw new Error("Invalid goal status")
        const summary = text(input.summary, 2000, "Summary")
        cancel(context.sessionID)
        await save(context.sessionID, { ...goal, status: input.status, summary, failures: 0 })
        return { content: `Goal: ${input.status}\n${summary}`, metadata: { goalID: goal.id, status: input.status } }
      },
    })))
    registrations.push(await ctx.session.hook("context", event => {
      const goal = goals.get(event.sessionID)
      const active = goal?.status === "active" && !SUPPORT.has(event.agent) && !isDndLane(event)
      if (!active && event.tools && Object.hasOwn(event.tools, TOOL)) {
        const { [TOOL]: _hidden, ...tools } = event.tools
        event.tools = tools
      }
      if (!Array.isArray(event.system)) return
      event.system = event.system.filter(part => !(typeof part === "string" ? part : part?.text || "").startsWith(MARKER))
      if (active) event.system.push({ type: "text", text: `${MARKER}\nGoal ID: ${goal.id}\nUser objective: ${JSON.stringify(goal.objective)}\nContinue working until the entire objective is achieved and verified. A completed response only ends this turn; the host will resume this goal. Do not stop at a plan, partial result, or offer to continue. New user messages steer the same goal. Use goal_update(active) for meaningful progress, completed only when no required work remains, or blocked with the precise user input or external change needed after doing independent work. Never bypass permissions, pending questions or execution budgets. Do not invent extra scope.\nLast progress: ${goal.summary}` })
    }))
    const stopEvents = startEvents(ctx, async event => {
      const sessionID = event.data?.sessionID
      if (["session.deleted", "session.moved", "session.agent.selected"].includes(event.type)) invalidate(sessionID)
      if (event.type === "session.deleted" && sessionID) {
        cancel(sessionID)
        goals.delete(sessionID)
        history.delete(sessionID)
        running.delete(sessionID)
        return queue(() => ctx.storage.remove(key(sessionID)))
      }
      const ended = ["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)
        && running.delete(sessionID)
      const goal = goals.get(sessionID)
      if (!goal) return
      if (event.type === "session.execution.started") running.add(sessionID)
      const finished = ["session.idle", "session.execution.succeeded"].includes(event.type) && ended
      if (goal.status !== "active") return
      if (event.type === "session.execution.started") cancel(sessionID)
      else if (finished) {
        await save(sessionID, { ...goal, failures: 0 })
        schedule(sessionID)
      } else if (event.type === "session.execution.failed") {
        cancel(sessionID)
        await failed(sessionID, event.data.error)
      } else if (event.type === "session.execution.interrupted") {
        cancel(sessionID)
        if (event.data.reason === "user") {
          const paused = { ...goal, status: "paused", summary: "Прервано пользователем. /goal resume — продолжить." }
          await save(sessionID, paused)
          await receipt(sessionID, current(sessionID) || paused)
        } else if (event.data.reason === "inactivity") await failed(sessionID, "Ход остановлен по неактивности")
      } else if (event.type === "session.moved" || event.type === "session.agent.selected") {
        cancel(sessionID)
        await block(sessionID, "Изменён проект или агент. /goal resume — продолжить в подходящей сессии.")
      } else if (event.type === "session.inbox.enqueued" && event.data.item?.type === "user") cancel(sessionID)
    })
    for (const [sessionID, goal] of goals) if (goal.status === "active") schedule(sessionID, 1000)
    return async () => {
      disposed = true
      for (const sessionID of new Set([...loads.keys(), ...operations.keys()])) invalidate(sessionID)
      stopEvents()
      for (const sessionID of timers.keys()) cancel(sessionID)
      await writes.catch(() => {})
      goals.clear(); history.clear(); loads.clear(); operations.clear(); running.clear()
      await Promise.allSettled(registrations.map(registration => registration.dispose()))
    }
  },
}
