import { Plugin } from "@opencode-ai/plugin"

const MIN = Number(process.env.SLOW_CMD_MIN || 5)

export function elapsedMinutes(startedAt, endedAt) {
  return (endedAt - startedAt) / 60_000
}

export default Plugin.define({
  id: "slow-cmd-watchdog",
  async setup(ctx) {
    const started = new Map()
    const before = await ctx.tool.hook("execute.before", (input) => {
      started.set(input.id, Date.now())
    })
    const after = await ctx.tool.hook("execute.after", (input) => {
      const startedAt = started.get(input.id)
      started.delete(input.id)
      if (!startedAt) return
      const minutes = elapsedMinutes(startedAt, Date.now())
      if (minutes >= MIN) console.warn(`[slow-cmd] ${input.tool} took ${minutes.toFixed(1)}m (${input.status})`)
    })
    return async () => {
      await before.dispose()
      await after.dispose()
    }
  },
})

if (process.env.SLOW_CMD_SELF_CHECK) {
  if (elapsedMinutes(1000, 31_000) >= MIN) throw new Error("fast call crossed threshold")
  if (elapsedMinutes(1000, 361_000) < MIN) throw new Error("slow call missed threshold")
  console.log("slow-cmd-watchdog self-check OK")
}
