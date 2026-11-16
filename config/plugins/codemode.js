// Native OpenCode V2 plugin for Code Mode execution.
// Provides /codemode command to toggle batch-scripted tool execution and clean-context policy.

export const CODEMODE_POLICY = `Custom Code Mode execution policy (active):
- Batch-first execution: Avoid multi-turn roundtrips for atomic read/grep/search operations. Whenever inspecting multiple files, searching for patterns, or gathering diagnostics, write a compact script (bash, node, or python) or pipeline to perform the work in a single tool turn.
- In-process filtering: Process and filter large data (JSON logs, file trees, build outputs) within the script (using grep, jq, awk, or code) before returning output. Never dump hundreds of raw lines into the model context.
- Scripted verification: Chain modification and verification in bounded steps; run focused test commands rather than full verbose suites when checking regressions.
- Concise results: Deliver direct, high-signal summaries and diffs without conversational filler.`

const SESSIONS_LIMIT = 512
const KEY_PREFIX = "codemode:session:"

export function parseCodemodeAction(raw) {
  const text = String(raw || "").trim()
  if (!text) return { action: "toggle" }
  const lower = text.toLowerCase()
  if (lower === "status") return { action: "status" }
  if (["on", "enable", "1", "true"].includes(lower)) return { action: "on" }
  if (["off", "disable", "0", "false"].includes(lower)) return { action: "off" }
  if (lower === "toggle") return { action: "toggle" }
  if (lower.startsWith("on ")) return { action: "on", prompt: text.slice(3).trim() }
  if (lower.startsWith("enable ")) return { action: "on", prompt: text.slice(7).trim() }
  return { action: "task", prompt: text }
}

export default {
  id: "custom.codemode",
  async setup(ctx) {
    if (process.env.CODEMODE_ENABLED === "0") return

    // In-memory session tracking with bounded capacity
    const sessions = new Map()
    const memoryDefault = process.env.CODEMODE_DEFAULT === "1"

    function setSessionMode(sessionID, active) {
      if (sessions.has(sessionID)) sessions.delete(sessionID)
      sessions.set(sessionID, active)
      while (sessions.size > SESSIONS_LIMIT) {
        sessions.delete(sessions.keys().next().value)
      }
    }

    async function isSessionActive(sessionID) {
      if (!sessionID) return false
      if (sessions.has(sessionID)) return sessions.get(sessionID)
      if (ctx.storage?.get) {
        try {
          const stored = await ctx.storage.get(`${KEY_PREFIX}${sessionID}`)
          if (typeof stored === "boolean") {
            setSessionMode(sessionID, stored)
            return stored
          }
        } catch {
          // Storage read failure falls back to default
        }
      }
      return memoryDefault
    }

    async function saveSessionMode(sessionID, active) {
      setSessionMode(sessionID, active)
      if (ctx.storage?.set && ctx.storage?.remove) {
        try {
          if (active) {
            await ctx.storage.set(`${KEY_PREFIX}${sessionID}`, true)
          } else {
            await ctx.storage.remove(`${KEY_PREFIX}${sessionID}`)
          }
        } catch {
          // Ignore persistent storage write errors
        }
      }
    }

    const registrations = []

    // 1. Slash command /codemode
    if (ctx.command?.transform) {
      registrations.push(
        await ctx.command.transform((commands) =>
          commands.add({
            name: "codemode",
            description:
              "Toggle Code Mode execution for this session: /codemode [on|off|status] or /codemode <task>",
            execute: async ({ sessionID, prompt }) => {
              const { action, prompt: taskPrompt } = parseCodemodeAction(prompt?.text)
              const current = await isSessionActive(sessionID)

              if (action === "status") {
                const text = `Code Mode: ${current ? "ВКЛЮЧЁН (active)" : "ВЫКЛЮЧЕН (inactive)"}\n\nРежим пакетного выполнения скриптов и защиты контекста.\nУправление: /codemode on | off | toggle | <задача>`
                await ctx.session?.synthetic?.({ sessionID, text, resume: false })
                return
              }

              if (action === "on") {
                await saveSessionMode(sessionID, true)
                if (taskPrompt) {
                  await ctx.session?.synthetic?.({
                    sessionID,
                    text: `[Code Mode активирован] ${taskPrompt}`,
                    resume: true,
                  })
                } else {
                  await ctx.session?.synthetic?.({
                    sessionID,
                    text: "Code Mode: ВКЛЮЧЁН. Агент использует пакетное исполнение скриптов и фильтрацию контекста.",
                    resume: false,
                  })
                }
                return
              }

              if (action === "off") {
                await saveSessionMode(sessionID, false)
                await ctx.session?.synthetic?.({
                  sessionID,
                  text: "Code Mode: ВЫКЛЮЧЕН. Возврат к стандартному пошаговому выполнению.",
                  resume: false,
                })
                return
              }

              if (action === "toggle") {
                const next = !current
                await saveSessionMode(sessionID, next)
                await ctx.session?.synthetic?.({
                  sessionID,
                  text: `Code Mode: ${next ? "ВКЛЮЧЁН" : "ВЫКЛЮЧЕН"}.`,
                  resume: false,
                })
                return
              }

              if (action === "task") {
                await saveSessionMode(sessionID, true)
                await ctx.session?.synthetic?.({
                  sessionID,
                  text: `[Code Mode] ${taskPrompt}`,
                  resume: true,
                })
              }
            },
          }),
        ),
      )
    }

    // 2. Context hook to inject Code Mode policy when active
    if (ctx.session?.hook) {
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          if (!event || !Array.isArray(event.system)) return
          const sessionID = String(event.sessionID || "")
          const active = await isSessionActive(sessionID)
          if (!active) return

          // Avoid duplicate injection
          const alreadyInjected = event.system.some(
            (item) => typeof item?.text === "string" && item.text.startsWith("Custom Code Mode execution policy"),
          )
          if (!alreadyInjected) {
            event.system.push({
              type: "text",
              text: CODEMODE_POLICY,
            })
          }
        }),
      )
    }

    return async () => {
      sessions.clear()
      await Promise.allSettled(registrations.map((item) => item?.dispose?.()))
    }
  },
}
