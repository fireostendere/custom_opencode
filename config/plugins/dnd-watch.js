import { startEvents } from "../events.js"
import { isDndContext } from "./orchestrated-qwen.js"

const TOOL = "dnd_watch"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENTS = new Set(["pending_roll", "roll_requested", "roll_result", "pending_roll_updated", "global_turn_ready", "global_turn_narrator_trigger", "lead_response_requested", "spotlight_ready"])
const ARRAYS = new Set(["messages", "events", "asks", "playerWhispers"])
const sequence = value => Number.isSafeInteger(value) && value >= 0
// Finished waits stay readable through status for a while, then are dropped.
const FINISHED_RETENTION_MS = 10 * 60_000
const MAX_ENTRIES = 256
// Auto-watch: after every narrator turn the host re-arms itself from the
// cursor the narrator actually drained, so a player's chat message starts the
// DM reply without an operator prompt. DND_AUTO_WATCH=0 restores explicit-only.
const AUTO_WATCH = !/^(0|false|off|no)$/i.test(process.env.DND_AUTO_WATCH || "1")
const AUTO_TIMEOUT_SECONDS = 3600
const AUTO_MAX_BACKOFF_MS = 60_000
const SESSION_CHANGED = "Watcher session changed"

// reason is shown to the model; key identifies the exact input so an
// automatic wait never wakes the model twice for the same ask/message/event.
function triggerFor(state, afterSeq) {
  const asks = state.asks?.filter(ask => ask.status === "pending") ?? []
  if (asks.length) return { reason: "ask", key: `ask:${asks.map((ask, index) => ask.id ?? ask.askId ?? index).sort().join(",")}` }
  if (state.playerWhispers?.length) return { reason: "whisper", key: `whisper:${state.playerWhispers.map((whisper, index) => whisper.id ?? index).sort().join(",")}` }
  const event = state.events?.find(event => sequence(event.seq) && event.seq > afterSeq && EVENTS.has(event.type))
  if (event) return { reason: event.type, key: `${event.type}:${event.seq}` }
  const players = state.messages?.filter(message => sequence(message.seq) && message.seq > afterSeq && message.authorType === "player" && message.kind !== "ooc" && !/^\s*\(ooc\)/i.test(message.content || "")) ?? []
  if (players.length) return { reason: "player", key: `player:${Math.max(...players.map(message => message.seq))}` }
}

// The last cursor a narrator read fully drained; undefined for partial pages,
// artifacts or anything that is not a complete story read.
export function drainedCursor(value) {
  if (!value || typeof value !== "object") return undefined
  if (value.format === "odm.read.page.v1" && value.complete !== true) return undefined
  return value.hasMore === false && sequence(value.nextCursor) ? value.nextCursor : undefined
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
  // Per-session key of the input that last woke the model; survives re-arms.
  const lastWake = new Map()
  const view = entry => entry ? {
    status: entry.status, campaignId: entry.campaignId, afterSeq: entry.afterSeq,
    expiresAt: entry.expiresAt, ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.auto ? { auto: true } : {}),
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
    entry.finishedAt = now()
    try { await wake(entry.context.sessionID, view(entry), entry.controller.signal) }
    catch { if (entries.get(entry.context.sessionID) === entry) entry.status = "notification_failed" }
  }
  return {
    start(input, context, { auto = false } = {}) {
      if (!UUID.test(input.campaignId || "")) throw new Error("campaignId must be a UUID")
      if (!sequence(input.afterSeq)) throw new Error("afterSeq must be a non-negative safe integer")
      const timeout = input.timeoutSeconds ?? 3600
      if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86400) throw new Error("timeoutSeconds must be 60..86400")
      if (!context.sessionID) throw new Error("Missing session identity")
      const previous = entries.get(context.sessionID)
      if (previous?.status === "waiting") {
        if (previous.campaignId === input.campaignId && previous.afterSeq === input.afterSeq && Boolean(previous.auto) === auto) return view(previous)
        // An explicit wait replaces an automatic one; an automatic re-arm never replaces an explicit wait.
        if (!previous.auto && auto) return view(previous)
        if (!previous.auto && !auto) throw new Error("Stop the active watcher before changing campaign or cursor")
      }
      stop(context.sessionID)
      // Bound the map: evict the oldest finished entries first.
      for (const [id, old] of entries) {
        if (entries.size < MAX_ENTRIES) break
        if (old.status !== "waiting") entries.delete(id)
      }
      if (entries.size >= MAX_ENTRIES) throw new Error("Too many active DnD watchers")
      const controller = new AbortController()
      const entry = {
        status: "waiting", campaignId: input.campaignId, afterSeq: input.afterSeq, scanSeq: input.afterSeq,
        expiresAt: now() + timeout * 1000, timeoutMs: timeout * 1000, controller,
        context: { ...context, signal: controller.signal }, busy: false,
        auto, errors: 0, retryAt: 0,
      }
      entries.set(context.sessionID, entry)
      return view(entry)
    },
    stop,
    status: sessionID => view(entries.get(sessionID)),
    close: () => { for (const id of entries.keys()) stop(id) },
    async tick() {
      for (const [id, entry] of entries)
        if (entry.status !== "waiting" && now() - (entry.finishedAt ?? now()) > FINISHED_RETENTION_MS) entries.delete(id)
      await Promise.all([...entries.values()].map(async entry => {
        if (!active(entry)) return
        if (now() >= entry.expiresAt) {
          // An automatic wait is renewed silently; only an explicit wait reports its deadline.
          if (entry.auto) entry.expiresAt = now() + entry.timeoutMs
          else { await finish(entry, "timed_out", "deadline"); entry.controller.abort(); return }
        }
        if (entry.busy || now() < entry.retryAt) return
        entry.busy = true
        try {
          const state = await readSignals(read, {
            operation: "read", campaignId: entry.campaignId, afterSeq: entry.scanSeq,
            projection: "live", delta: true, includeAsks: true, paged: true, maxBytes: 131072,
          }, entry.context)
          if (!active(entry)) return
          if (!sequence(state.currentSeq) || !sequence(state.nextCursor) || state.nextCursor < entry.scanSeq || state.nextCursor > state.currentSeq || (state.hasMore && state.nextCursor === entry.scanSeq)) throw new Error("Invalid ODM cursor")
          entry.errors = 0
          const trigger = entry.epoch && state.timelineEpoch !== entry.epoch
            ? { reason: "resync", key: `resync:${state.timelineEpoch}` }
            : triggerFor(state, entry.scanSeq)
          const sessionID = entry.context.sessionID
          if (trigger && !(entry.auto && lastWake.get(sessionID) === trigger.key)) {
            lastWake.set(sessionID, trigger.key)
            await finish(entry, "triggered", trigger.reason)
            return
          }
          // Nothing new, or an automatic wait already woke the model for exactly this input.
          entry.epoch = state.timelineEpoch
          // This is a private scan watermark, never the narrator's processed cursor.
          entry.scanSeq = state.nextCursor
        } catch (error) {
          if (!active(entry)) return
          if (!entry.auto) { await finish(entry, "error", "odm_read_failed"); return }
          if (error?.message === SESSION_CHANGED) { stop(entry.context.sessionID); return }
          // Transient ODM/MCP failures back off quietly instead of waking the model.
          entry.errors += 1
          entry.retryAt = now() + Math.min(AUTO_MAX_BACKOFF_MS, 3000 * 2 ** Math.min(entry.errors, 5))
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
    // The watcher is a game-only tool: hide its schema from every other lane.
    if (ctx.session.hook)
      registrations.push(await ctx.session.hook("context", event => {
        if (!event?.tools || typeof event.tools !== "object" || isDndContext(event) || !Object.hasOwn(event.tools, TOOL)) return
        const { [TOOL]: _hidden, ...tools } = event.tools
        event.tools = tools
      }))
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
        if (session.parentID || session.agent !== context.agent || session.location?.directory !== ctx.location.directory) throw new Error(SESSION_CHANGED)
        const narrator = await getNarrator()
        // The native MCP executor still checks this session/agent's permissions.
        return decodeResult(await narrator.execute(query, { ...context, odmBackgroundRead: true, progress: async () => {} }))
      },
      wake: async (sessionID, result, signal) => {
        signal.throwIfAborted()
        const text = result.auto
          ? `DnD auto-watch: ${JSON.stringify(result)}\nNew activity in the connected campaign. This is a wake signal, not a player action or an authoritative game receipt. Read ODM from afterSeq, drain pages/events, check asks and pending rolls, obey initiative/global-turn barriers, then resolve the new input as the DM and publish the result to the campaign. Do not act for a player. Do not call dnd_watch: the host re-arms automatically after this turn. Reply to the operator with at most one short status line.`
          : `DnD watcher: ${JSON.stringify(result)}\nThis is a wake signal, not a player action or an authoritative game receipt. Read ODM from afterSeq, drain pages/events, check asks and pending rolls, and obey initiative/global-turn barriers. Do not act for a player. After processing, re-arm dnd_watch only while the operator's waiting request remains active. On timeout or error, report the stopped wait; do not claim it is still running.`
        await ctx.session.synthetic({ sessionID, delivery: "queue", resume: true, text, metadata: { dndWatch: result } })
      },
    })

    // Auto-watch bookkeeping: which campaign each narrator session plays and the
    // last story cursor it fully drained. Only revisions/cursors, never game text.
    const tables = new Map()
    const table = sessionID => {
      if (!tables.has(sessionID)) {
        if (tables.size >= MAX_ENTRIES) tables.delete(tables.keys().next().value)
        tables.set(sessionID, { auto: AUTO_WATCH })
      }
      return tables.get(sessionID)
    }
    const remember = (input, context, result) => {
      if (!context?.sessionID || context.odmBackgroundRead || !UUID.test(input?.campaignId || "")) return
      if (!String(context.agent || "").startsWith("dnd-")) return
      const entry = table(context.sessionID)
      if (entry.campaignId !== input.campaignId) Object.assign(entry, { campaignId: input.campaignId, cursor: undefined })
      entry.context = context
      if (input.operation !== "read") return
      let cursor
      try { cursor = drainedCursor(decodeResult(result)) } catch { return }
      if (cursor !== undefined) entry.cursor = cursor
    }
    async function arm(sessionID) {
      const entry = tables.get(sessionID)
      if (!sessionID || !entry?.auto || !entry.context || !entry.campaignId || !sequence(entry.cursor)) return false
      if (watcher.status(sessionID).status === "waiting") return true
      const session = await ctx.session.get({ sessionID })
      if (session.parentID || session.agent !== entry.context.agent) return false
      watcher.start({ campaignId: entry.campaignId, afterSeq: entry.cursor, timeoutSeconds: AUTO_TIMEOUT_SECONDS }, entry.context, { auto: true })
      return true
    }
    registrations.push(await ctx.tool.transform(editor => {
      if (typeof editor.update !== "function") return
      for (const name of ["odm_narrator_odm_narrator", "odm_narrator"]) if (editor.get?.(name)) editor.update(name, tool => {
        const execute = tool.execute
        tool.execute = async (input, context) => {
          const result = await execute(input, context)
          // Bookkeeping must never turn a committed ODM call into an error.
          try { remember(input, context, result) } catch {}
          return result
        }
      })
    }))
    registrations.push(await ctx.tool.transform(editor => editor.add({
      name: TOOL,
      description: "Background ODM watcher. Auto-watch is on by default: after each narrator turn the host itself waits for player input, Ask, whisper, roll result or round-ready in the campaign you read and resumes this session, so you normally never call this tool. start is only for an explicit one-shot wait the operator asks for (another cursor or campaign); after starting, finish your response and do not poll. status/stop control only this session. Does not play for characters.",
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
      name: "dnd-watch", description: "Background ODM wait for this session: /dnd-watch status|stop|auto (stop also turns auto-watch off)",
      execute: async ({ sessionID, prompt }) => {
        const action = (prompt.text || "status").trim()
        if (!["status", "stop", "auto"].includes(action)) throw new Error("Usage: /dnd-watch status|stop|auto")
        if (action === "stop") { table(sessionID).auto = false; watcher.stop(sessionID) }
        if (action === "auto") { table(sessionID).auto = true; await arm(sessionID) }
        const result = { ...watcher.status(sessionID), autoWatch: tables.get(sessionID)?.auto ?? AUTO_WATCH }
        await ctx.session.synthetic({ sessionID, text: `DnD watcher: ${JSON.stringify(result)}`, resume: false })
      },
    })))
    const stopEvents = startEvents(ctx, event => {
      const sessionID = event.data?.sessionID
      if (["session.execution.interrupted", "session.execution.failed", "session.deleted", "session.moved", "session.agent.selected", "session.model.selected"].includes(event.type)
        || (event.type === "session.inbox.enqueued" && event.data?.item?.type === "user")) watcher.stop(sessionID)
      // A changed agent invalidates the remembered tool context until the next ODM call.
      if (["session.agent.selected", "session.moved"].includes(event.type) && tables.has(sessionID)) tables.get(sessionID).context = undefined
      if (event.type === "session.deleted") tables.delete(sessionID)
      if (event.type === "session.idle") return arm(sessionID).catch(() => {})
    })
    // ponytail: process-local waits; durable restart recovery needs a host job store.
    const timer = setInterval(() => { void watcher.tick().catch(() => {}) }, 3000)
    timer.unref?.()
    return async () => {
      clearInterval(timer); stopEvents(); watcher.close()
      if (readerRegistration) await (await readerRegistration).dispose()
      await Promise.allSettled(registrations.map(registration => registration?.dispose?.()))
    }
  },
}
