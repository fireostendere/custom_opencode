import { randomUUID, createHash } from "node:crypto"
import { startEvents } from "../events.js"
import { isDndLane } from "./tui/lib/context-policy.js"

const TOOL = "goal_update"
const MARKER = "Custom active goal:"
const SUPPORT = new Set(["title", "summary", "compaction"])
const STATUSES = new Set(["active", "paused", "completed", "blocked"])
const MAX_FAILURES = 5
const text = (value, limit, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label} must contain 1-${limit} characters`)
  return value.trim()
}

export default {
  id: "custom.goal",
  async setup(ctx) {
    const directory = ctx.location.directory
    const prefix = `goals:${createHash("sha256").update(directory).digest("hex")}:`
    const goals = new Map(), timers = new Map(), running = new Set(), waking = new Set()
    const registrations = []
    let disposed = false, writes = Promise.resolve()
    const key = sessionID => prefix + sessionID
    const cancel = sessionID => {
      clearTimeout(timers.get(sessionID))
      timers.delete(sessionID)
    }
    // Serialize snapshots: an older async write must never restore a stopped goal.
    const save = (sessionID, goal) => {
      goals.set(sessionID, goal)
      writes = writes.catch(() => {}).then(() => ctx.storage.set(key(sessionID), goal))
      return writes
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
      await save(sessionID, { ...goal, status: "blocked", summary })
      await receipt(sessionID, goals.get(sessionID))
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
        if (!value || typeof value.id !== "string" || !STATUSES.has(value.status) || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 16000 || !Number.isSafeInteger(value.turns) || value.turns < 0 || !Number.isSafeInteger(value.failures) || value.failures < 0) continue
        goals.set(savedKey.slice(prefix.length), value)
      }
      after = page.next
    } while (after)

    registrations.push(await ctx.command.transform(commands => commands.add({
      name: "goal", description: "Работать до результата: /goal <задача> | status | stop | resume",
      execute: async ({ sessionID, prompt }) => {
        const requested = String(prompt?.text || "").trim()
        let goal = goals.get(sessionID)
        if (!requested || requested === "status") return receipt(sessionID, goal)
        if (requested === "stop") {
          cancel(sessionID)
          if (goal && goal.status !== "completed") await save(sessionID, { ...goal, status: "paused", summary: "Остановлено пользователем" })
          await ctx.session.interrupt({ sessionID, continue: false })
          return receipt(sessionID, goals.get(sessionID))
        }
        await primary(sessionID)
        if (requested === "resume") {
          if (!goal || goal.status === "completed") throw new Error("Нет незавершённой цели. /goal <задача>")
          goal = { ...goal, status: "active", failures: 0, summary: "" }
        } else goal = { id: randomUUID(), objective: text(requested, 16000, "Goal"), status: "active", turns: 0, failures: 0, summary: "" }
        cancel(sessionID)
        await save(sessionID, goal)
        schedule(sessionID, 0)
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
      const goal = goals.get(sessionID)
      if (!goal) return
      if (event.type === "session.execution.started") running.add(sessionID)
      const finished = ["session.idle", "session.execution.succeeded"].includes(event.type) && running.delete(sessionID)
      if (["session.execution.failed", "session.execution.interrupted"].includes(event.type)) running.delete(sessionID)
      if (event.type === "session.deleted") {
        cancel(sessionID)
        goals.delete(sessionID)
        running.delete(sessionID)
        await writes.catch(() => {})
        return ctx.storage.remove(key(sessionID))
      }
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
          await save(sessionID, { ...goal, status: "paused", summary: "Прервано пользователем. /goal resume — продолжить." })
          await receipt(sessionID, goals.get(sessionID))
        } else if (event.data.reason === "inactivity") await failed(sessionID, "Ход остановлен по неактивности")
      } else if (event.type === "session.moved" || event.type === "session.agent.selected") {
        cancel(sessionID)
        await block(sessionID, "Изменён проект или агент. /goal resume — продолжить в подходящей сессии.")
      } else if (event.type === "session.inbox.enqueued" && event.data.item?.type === "user") cancel(sessionID)
    })
    for (const [sessionID, goal] of goals) if (goal.status === "active") schedule(sessionID, 1000)
    return async () => {
      disposed = true
      stopEvents()
      for (const sessionID of timers.keys()) cancel(sessionID)
      await writes.catch(() => {})
      await Promise.allSettled(registrations.map(registration => registration.dispose()))
    }
  },
}
