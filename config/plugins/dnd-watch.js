import { startEvents } from "../events.js"

const TOOL = "dnd_watch"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENTS = new Set(["pending_roll", "roll_requested", "roll_result", "pending_roll_updated", "global_turn_ready", "global_turn_narrator_trigger", "lead_response_requested", "spotlight_ready"])
const ARRAYS = new Set(["messages", "events", "asks", "playerWhispers"])
const sequence = value => Number.isSafeInteger(value) && value >= 0

function reasonFor(state, afterSeq) {
  if (state.asks?.some(ask => ask.status === "pending")) return "ask"
  if (state.playerWhispers?.length) return "whisper"
  const event = state.events?.find(event => sequence(event.seq) && event.seq > afterSeq && EVENTS.has(event.type))
  if (event) return event.type
  if (state.messages?.some(message => sequence(message.seq) && message.seq > afterSeq && message.authorType === "player" && message.kind !== "ooc" && !/^\s*\(ooc\)/i.test(message.content || ""))) return "player"
}

// Inspect only wake signals. No player prose or private state enters the notification.
async function readSignals(read, query, context) {
  let cursor, hash, offset = 0
  const state = { messages: [], events: [], asks: [], playerWhispers: [] }
  for (let page = 0; page < 64; page++) {
    context.signal.throwIfAborted()
    const value = await read({ ...query, ...(cursor ? { pageCursor: cursor } : {}) }, context)
    context.signal.throwIfAborted()
    if (value?.format !== "odm.read.page.v1") {
      if (cursor || !value || !sequence(value.currentSeq) || !sequence(value.nextCursor)) throw new Error("Invalid ODM read")
      return value
    }
    if (!Array.isArray(value.entries) || value.offset !== offset || (hash && hash !== value.hash) || !value.hash || value.complete !== (value.nextPage === null)) throw new Error("Invalid ODM page")
    hash = value.hash
    for (const entry of value.entries) {
      if (ARRAYS.has(entry.key)) state[entry.key].push(entry.value)
      if (entry.key === "timelineEpoch") state.timelineEpoch = entry.value
    }
    offset += value.entries.length
    Object.assign(state, { currentSeq: value.currentSeq, nextCursor: value.nextCursor, hasMore: value.hasMore })
    if (value.complete) return state
    if (!value.entries.length || typeof value.nextPage !== "string" || cursor === value.nextPage) throw new Error("Non-advancing ODM page")
    cursor = value.nextPage
  }
  throw new Error("ODM page limit exceeded")
}

export function createDndWatcher({ read, wake, now = Date.now }) {
  const entries = new Map()
  const view = entry => entry ? {
    status: entry.status, campaignId: entry.campaignId, afterSeq: entry.afterSeq,
    expiresAt: entry.expiresAt, ...(entry.reason ? { reason: entry.reason } : {}),
  } : { status: "stopped" }
  const active = entry => entries.get(entry.context.sessionID) === entry && entry.status === "waiting"
  const stop = sessionID => {
    const entry = entries.get(sessionID)
    if (entry) { entry.status = "stopped"; entry.controller.abort(); entries.delete(sessionID) }
    return { status: "stopped" }
  }
  async function finish(entry, status, reason) {
    if (!active(entry)) return
    entry.status = status
    entry.reason = reason
    try { await wake(entry.context.sessionID, view(entry), entry.controller.signal) }
    catch { if (entries.get(entry.context.sessionID) === entry) entry.status = "notification_failed" }
  }
  return {
    start(input, context) {
      if (!UUID.test(input.campaignId || "")) throw new Error("campaignId must be a UUID")
      if (!sequence(input.afterSeq)) throw new Error("afterSeq must be a non-negative safe integer")
      const timeout = input.timeoutSeconds ?? 3600
      if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86400) throw new Error("timeoutSeconds must be 60..86400")
      if (!context.sessionID) throw new Error("Missing session identity")
      const previous = entries.get(context.sessionID)
      if (previous?.status === "waiting") {
        if (previous.campaignId === input.campaignId && previous.afterSeq === input.afterSeq) return view(previous)
        throw new Error("Stop the active watcher before changing campaign or cursor")
      }
      stop(context.sessionID)
      const controller = new AbortController()
      const entry = {
        status: "waiting", campaignId: input.campaignId, afterSeq: input.afterSeq, scanSeq: input.afterSeq,
        expiresAt: now() + timeout * 1000, controller,
        context: { ...context, signal: controller.signal }, busy: false,
      }
      entries.set(context.sessionID, entry)
      return view(entry)
    },
    stop,
    status: sessionID => view(entries.get(sessionID)),
    close: () => { for (const id of entries.keys()) stop(id) },
    async tick() {
      await Promise.all([...entries.values()].map(async entry => {
        if (!active(entry)) return
        if (now() >= entry.expiresAt) { await finish(entry, "timed_out", "deadline"); entry.controller.abort(); return }
        if (entry.busy) return
        entry.busy = true
        try {
          const state = await readSignals(read, {
            operation: "read", campaignId: entry.campaignId, afterSeq: entry.scanSeq,
            projection: "live", delta: true, includeAsks: true, paged: true, maxBytes: 131072,
          }, entry.context)
          if (!active(entry)) return
          if (!sequence(state.currentSeq) || !sequence(state.nextCursor) || state.nextCursor < entry.scanSeq || state.nextCursor > state.currentSeq || (state.hasMore && state.nextCursor === entry.scanSeq)) throw new Error("Invalid ODM cursor")
          const reason = entry.epoch && state.timelineEpoch !== entry.epoch ? "resync" : reasonFor(state, entry.scanSeq)
          if (reason) { await finish(entry, "triggered", reason); return }
          entry.epoch = state.timelineEpoch
          // This is a private scan watermark, never the narrator's processed cursor.
          entry.scanSeq = state.nextCursor
        } catch {
          if (active(entry)) await finish(entry, "error", "odm_read_failed")
        } finally { entry.busy = false }
      }))
    },
  }
}

function decodeResult(result) {
  const value = result.output ?? (typeof result.content === "string" ? result.content : result.content?.filter(part => part.type === "text").map(part => part.text).join("\n"))
  return typeof value === "string" ? JSON.parse(value) : value
}

export default {
  id: "custom.dnd-watch",
  async setup(ctx) {
    const registrations = []
    let narrator, readerRegistration
    async function getNarrator() {
      // Register the reader at first use, after native MCP discovery has settled.
      // Older V2 releases expose tool reads through the transform editor only.
      readerRegistration ??= ctx.tool.transform(editor => {
        narrator = editor.get("odm_narrator_odm_narrator")
      })
      const registration = await readerRegistration
      if (!narrator) {
        await registration.dispose()
        readerRegistration = undefined
        throw new Error("Connect the ODM narrator MCP before starting a watcher")
      }
      return narrator
    }
    const watcher = createDndWatcher({
      read: async (query, context) => {
        const session = await ctx.session.get({ sessionID: context.sessionID })
        if (session.parentID || session.agent !== context.agent || session.location?.directory !== ctx.location.directory) throw new Error("Watcher session changed")
        const narrator = await getNarrator()
        // The native MCP executor still checks this session/agent's permissions.
        return decodeResult(await narrator.execute(query, { ...context, progress: async () => {} }))
      },
      wake: async (sessionID, result, signal) => {
        signal.throwIfAborted()
        await ctx.session.synthetic({
          sessionID, delivery: "queue", resume: true,
          text: `DnD watcher: ${JSON.stringify(result)}\nThis is a wake signal, not a player action or an authoritative game receipt. Read ODM from afterSeq, drain pages/events, check asks and pending rolls, and obey initiative/global-turn barriers. Do not act for a player. After processing, re-arm dnd_watch only while the operator's waiting request remains active. On timeout or error, report the stopped wait; do not claim it is still running.`,
          metadata: { dndWatch: result },
        })
      },
    })
    registrations.push(await ctx.tool.transform(editor => editor.add({
      name: TOOL,
      description: "Explicit one-shot background ODM watcher. start waits without model calls and resumes this session on player input, Ask, whisper, roll result or round-ready. After starting, finish your response; do not poll. status/stop control only this session. Does not play for characters. Stops on timeout, read failure, session changes or service restart.",
      input: {
        type: "object", additionalProperties: false, required: ["action"],
        properties: {
          action: { type: "string", enum: ["start", "status", "stop"] },
          campaignId: { type: "string", pattern: UUID.source, description: "start: connected campaign UUID" },
          afterSeq: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "start: last actually processed player/event cursor, never blindly the latest DM message" },
          timeoutSeconds: { type: "integer", minimum: 60, maximum: 86400, description: "start: bounded wait; default 3600 seconds" },
        },
      },
      options: { pinned: true, codemode: false },
      execute: async (input, context) => {
        let result
        if (input.action === "stop") result = watcher.stop(context.sessionID)
        else if (input.action === "status") result = watcher.status(context.sessionID)
        else if (input.action === "start") {
          const session = await ctx.session.get({ sessionID: context.sessionID })
          if (session.parentID) throw new Error("Only a primary session may watch a campaign")
          const servers = await ctx.mcp.list()
          if (!servers.data.some(server => server.name === "odm_narrator" && server.status?.status === "connected")) throw new Error("Connect the ODM narrator MCP before starting a watcher")
          result = watcher.start(input, context)
        } else throw new Error("Unknown watcher action")
        return { content: JSON.stringify(result), metadata: { dndWatch: result } }
      },
    })))
    registrations.push(await ctx.command.transform(editor => editor.add({
      name: "dnd-watch", description: "Show or stop this session's background ODM wait: /dnd-watch status|stop",
      execute: async ({ sessionID, prompt }) => {
        const action = (prompt.text || "status").trim()
        if (!["status", "stop"].includes(action)) throw new Error("Usage: /dnd-watch status|stop")
        const result = action === "stop" ? watcher.stop(sessionID) : watcher.status(sessionID)
        await ctx.session.synthetic({ sessionID, text: `DnD watcher: ${JSON.stringify(result)}`, resume: false })
      },
    })))
    const stopEvents = startEvents(ctx, event => {
      if (["session.execution.interrupted", "session.execution.failed", "session.deleted", "session.moved", "session.agent.selected", "session.model.selected"].includes(event.type)
        || (event.type === "session.inbox.enqueued" && event.data?.item?.type === "user")) watcher.stop(event.data?.sessionID)
    })
    // ponytail: process-local waits; durable restart recovery needs a host job store.
    const timer = setInterval(() => { void watcher.tick().catch(() => {}) }, 3000)
    timer.unref?.()
    return async () => {
      clearInterval(timer); stopEvents(); watcher.close()
      if (readerRegistration) await (await readerRegistration).dispose()
      await Promise.allSettled(registrations.map(registration => registration.dispose()))
    }
  },
}
