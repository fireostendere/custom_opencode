// Portable RPC definition (JSON Schema, no runtime dependencies in either client).
export const GoalRpc = {
  id: "custom.goal",
  methods: {
    get: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID"],
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 128 } },
      },
      output: {
        type: "object", additionalProperties: false, required: ["goal"],
        properties: { goal: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false,
          required: ["id", "objective", "status", "turns", "failures", "summary"],
          properties: {
            id: { type: "string" }, objective: { type: "string" },
            status: { type: "string", enum: ["active", "paused", "blocked", "completed"] },
            turns: { type: "integer", minimum: 0 }, failures: { type: "integer", minimum: 0 }, summary: { type: "string" },
          },
        }] } },
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object", additionalProperties: false, required: ["sessionID"],
        properties: { sessionID: { type: "string" } },
      },
    },
  },
}

export function describeGoal(goal) {
  const labels = { active: "Достижение цели", paused: "Цель на паузе", blocked: "Цель заблокирована", completed: "Цель достигнута" }
  if (!goal || !labels[goal.status] || typeof goal.objective !== "string") return null
  return {
    headline: goal.unavailable ? "Статус цели недоступен" : labels[goal.status], objective: goal.objective, summary: goal.summary || "",
    turns: goal.turns, tone: goal.unavailable ? "warn" : goal.status === "active" ? "busy" : goal.status === "completed" ? "ok" : "warn",
    hint: goal.unavailable ? "Нет связи с сервером · показаны последние данные"
      : goal.status === "active" ? "Автопродолжение включено · /goal stop — остановить"
      : goal.status === "completed" ? "Выполнение завершено · автопродолжение выключено"
        : "/goal resume — продолжить",
  }
}

// Poll only the open session. Recover missed events/reconnects; never retain
// another session's objective or allow a delayed reply to paint the wrong chat.
export function watchGoal({ read, onChange, intervalMs = 3000, isVisible = () => true }) {
  let sessionID = null, directory = null, generation = 0, timer = null, stopped = false
  let snapshot = null, inFlight = false, again = false
  function publish(value) {
    if (JSON.stringify(snapshot) === JSON.stringify(value)) return
    snapshot = value
    onChange(value)
  }
  async function refresh() {
    if (stopped) return
    clearTimeout(timer)
    if (inFlight) { again = true; return }
    const mine = generation, id = sessionID, location = directory
    if (!id) return
    inFlight = true
    try {
      if (isVisible()) {
        const value = await read(id, location)
        if (!stopped && mine === generation) publish(value?.goal ?? null)
      }
    } catch {
      // Keep the last objective, but don't claim it is still running offline.
      if (!stopped && mine === generation && snapshot) publish({ ...snapshot, unavailable: true })
    } finally {
      inFlight = false
      if (!stopped && sessionID) {
        timer = setTimeout(refresh, again || mine !== generation ? 0 : intervalMs)
        timer.unref?.()
      }
      again = false
    }
  }
  return {
    setSession(id, location) {
      if (id === sessionID && location === directory) return
      sessionID = id || null; directory = location; generation++
      publish(null)
      void refresh()
    },
    refresh,
    stop() { stopped = true; generation++; clearTimeout(timer); snapshot = null },
  }
}
