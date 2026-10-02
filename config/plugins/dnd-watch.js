import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, uptime } from "node:os"
import { dirname, join } from "node:path"
import { startEvents } from "../events.js"
import { isDndContext } from "./orchestrated-qwen.js"

const TOOL = "dnd_watch"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENTS = new Set(["pending_roll", "roll_requested", "roll_result", "pending_roll_updated", "global_turn_ready", "global_turn_narrator_trigger", "lead_response_requested", "spotlight_ready", "autopilot_action_requested"])
const ARRAYS = new Set(["messages", "events", "asks", "playerWhispers"])
const sequence = value => Number.isSafeInteger(value) && value >= 0
const enabled = (name, fallback = "1") => !/^(0|false|off|no)$/i.test(process.env[name] || fallback)
// Finished waits stay readable through status for a while, then are dropped.
const FINISHED_RETENTION_MS = 10 * 60_000
const MAX_ENTRIES = 256
// Auto-watch: after every narrator turn the host re-arms itself from the
// cursor the narrator actually drained, so a player's chat message starts the
// DM reply without an operator prompt. DND_AUTO_WATCH=0 restores explicit-only.
const AUTO_WATCH = enabled("DND_AUTO_WATCH")
const AUTO_TIMEOUT_SECONDS = 3600
const READ_MAX_BACKOFF_MS = 60_000
// Push (DND_WATCH_PUSH=0 disables): one SSE doorbell per campaign replaces 3 s
// polling. A read then runs only on a signal, on (re)connect and as a rare
// safety net; without a live link the watcher polls as before.
const SAFETY_READ_MS = 5 * 60_000
const MIN_READ_GAP_MS = 1000
const PUSH_IDLE_MS = 60_000
const PUSH_MAX_BACKOFF_MS = 60_000
const PUSH_UNSUPPORTED_RETRY_MS = 10 * 60_000
// A link outlives the gap between waits (the DM's own turn) to avoid churn.
const PUSH_LINGER_MS = 10 * 60_000
const ENDPOINT_CACHE_MS = 60_000
// A DM turn the watcher started that then failed (provider error, 429) is
// woken again with backoff instead of leaving the player's input stranded.
const TURN_RETRY_MS = 30_000
const TURN_RETRY_MAX_MS = 10 * 60_000
const TURN_MAX_ATTEMPTS = 6
const LOG_LIMIT = 8
const STATE_HEARTBEAT_MS = 15_000
// DM status reports ("Мастер думает…" for players; DND_WATCH_STATUS=0
// disables) give up after this long instead of piling up behind a slow ODM.
const STATUS_TIMEOUT_MS = 15_000
const SESSION_CHANGED = "Watcher session changed"
const REASONS = {
  ask: "Ask", whisper: "шёпот", player: "ход игрока", resync: "пересинхронизация",
  pending_roll: "запрос броска", roll_requested: "запрос броска", roll_result: "результат броска",
  pending_roll_updated: "бросок обновлён", global_turn_ready: "раунд готов",
  global_turn_narrator_trigger: "раунд ждёт мастера", lead_response_requested: "запрос ответа",
  spotlight_ready: "прожектор готов", autopilot_action_requested: "ход автопилота",
}
// Signals that can never wake the DM: its own writes and table bookkeeping.
const QUIET = new Set([
  "ping", "stream_checkpoint", "mcp_control", "mcp_notice", "dm_status", "narrator_command_completed",
  "utility_calls", "sheet_updated", "sheet_audit", "sheet_deleted", "image_ready", "location_map_ready",
  "scene_tracker", "beat_recorded", "facts_updated", "relationships_updated", "chapter_updated",
  "note_updated", "note_suggested", "note_deleted", "pins_updated", "presence", "voice_roster",
  "voice_speaking", "voice_audibility_changed", "voice_mesh_signal", "map_ping", "ambience_changed", "ambience_sting",
])

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

  // Autopilot candidate check:
  const globalMode = Boolean(state.campaign?.gameSettings?.globalTurn?.enabled)
  const turn = state.campaign?.globalTurnState
  const encounter = state.encounter
  if (!encounter) {
    if (globalMode && turn && (turn.phase === "active" || turn.phase === "quorum_delay") && sequence(turn.roundNumber)) {
      const actions = turn.actionsByCharacter || {}
      const members = Array.isArray(state.members) ? state.members : []
      const sheets = Array.isArray(state.sheets) ? state.sheets : []
      for (const m of members) {
        if (!m?.autopilot || m.muted || Number(m.skipTurnsCount ?? 0) > 0) continue
        const s = sheets.find(item => item?.userId === m.userId && !item.isCompanion)
        if (!s || s.userId === state.campaign?.dmUserId || s.deathSaves?.dead) continue
        const usage = actions[s.id]
        if (usage && (Number(usage.actionsCount ?? 0) > 0 || Number(usage.phrasesCount ?? 0) > 0)) continue
        return { reason: "autopilot_action_requested", key: `autopilot:${turn.roundNumber}:${s.id}` }
      }
    } else if (!globalMode && state.campaign?.floor?.mode === "spotlight") {
      const floor = state.campaign.floor
      const members = Array.isArray(state.members) ? state.members : []
      const sheets = Array.isArray(state.sheets) ? state.sheets : []
      for (const m of members) {
        if (!m?.autopilot || m.muted || Number(m.skipTurnsCount ?? 0) > 0) continue
        if (!floor.userIds?.includes(m.userId) || floor.respondedUserIds?.includes(m.userId)) continue
        const s = sheets.find(item => item?.userId === m.userId && !item.isCompanion)
        if (!s || s.userId === state.campaign?.dmUserId) continue
        return { reason: "autopilot_action_requested", key: `autopilot:spotlight:${state.currentSeq ?? 0}:${s.id}` }
      }
    }
  }
}

// System-1 fast mechanics decision classifier: analyzes action-oriented player intent
// and derives canonical D&D 5e checks with discrete DC for instant pre-roll dispatch.
export function evaluateFastMechanics(message) {
  if (!message || message.kind === "ooc") return null
  const content = String(message.content || "").trim()
  if (!content || /^\s*\(ooc\)/i.test(content)) return null
  const isDo = message.kind === "do" || /^\*.*\*$/.test(content) || /^(я |пытаюсь |делаю |иду |хочу )/i.test(content)
  if (!isDo) return null

  const text = content.toLowerCase()
  if (/(крадус|прячус|тихо|бесшумн|незаметн|stealth)/i.test(text)) {
    return { kind: "skill_check", skill: "stealth", dc: 14, reason: "Скрытное перемещение" }
  }
  if (/(отмычк|взлом|замок|карман|ловкост.*рук|срезаю.*кошел|подсовыва|sleight)/i.test(text)) {
    return { kind: "skill_check", skill: "sleight_of_hand", dc: 15, reason: "Взлом или ловкость рук" }
  }
  if (/(выбива|карабка|лезу|взбира|прыга|толка|прорыва|плыву|залеза|athletics)/i.test(text)) {
    return { kind: "skill_check", skill: "athletics", dc: 14, reason: "Физическое усилие (атлетика)" }
  }
  if (/(кувырок|балансир|уворачива|соскальзыва|acrobatics)/i.test(text)) {
    return { kind: "skill_check", skill: "acrobatics", dc: 13, reason: "Ловкий манёвр (акробатика)" }
  }
  if (/(вглядыва|прислушива|осматрива|perception)/i.test(text)) {
    return { kind: "skill_check", skill: "perception", dc: 13, reason: "Внимательность (восприятие)" }
  }
  if (/(обыскива|ищу.*тайник|ищу.*улик|осматрива.*механизм|investigation)/i.test(text)) {
    return { kind: "skill_check", skill: "investigation", dc: 14, reason: "Поиск улик или механизмов (анализ)" }
  }
  if (/(вру|блефу|ложное.*имя|притворя|обман|deception)/i.test(text)) {
    return { kind: "skill_check", skill: "deception", dc: 14, reason: "Попытка обмана (обман)" }
  }
  if (/(убежда|уговарива|дипломатич|persuasion)/i.test(text)) {
    return { kind: "skill_check", skill: "persuasion", dc: 14, reason: "Дипломатическая попытка (убеждение)" }
  }
  if (/(угрожа|запугива|приставляю.*клинок|рычу|хватаю.*за.*горло|intimidation)/i.test(text)) {
    return { kind: "skill_check", skill: "intimidation", dc: 14, reason: "Угроза (запугивание)" }
  }
  if (/(врет.*ли|блефует.*ли|глаза|мимик|намерени|правду.*ли|insight)/i.test(text)) {
    return { kind: "skill_check", skill: "insight", dc: 13, reason: "Оценка искренности (проницательность)" }
  }
  if (/(магическ.*символ|руны|заклинани|аур|arcana)/i.test(text)) {
    return { kind: "skill_check", skill: "arcana", dc: 14, reason: "Магическое познание (магия)" }
  }
  if (/(след.*в.*гряз|следы|ориентир|развожу.*костер|survival)/i.test(text)) {
    return { kind: "skill_check", skill: "survival", dc: 13, reason: "Выживание и следопытство" }
  }
  return null
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

export function createDndWatcher({ read, wake, invoke, now = Date.now, onChange = () => {} }) {
  const entries = new Map()
  // Per-session key of the input that last woke the model; survives re-arms.
  const lastWake = new Map()
  // Campaigns with a live push link: their waits read on a signal, not every tick.
  const pushed = new Set()
  const view = entry => entry ? {
    status: entry.status, campaignId: entry.campaignId, afterSeq: entry.afterSeq,
    expiresAt: entry.expiresAt, ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.fastRoll ? { fastRoll: entry.fastRoll } : {}),
    ...(entry.auto ? { auto: true } : {}),
  } : { status: "stopped" }
  const changed = sessionID => { try { onChange(sessionID) } catch {} }
  const active = entry => entries.get(entry.context.sessionID) === entry && entry.status === "waiting"
  const waiting = () => [...entries.values()].filter(entry => entry.status === "waiting")
  const stop = sessionID => {
    const entry = entries.get(sessionID)
    if (entry) { entry.status = "stopped"; entry.controller.abort(); entries.delete(sessionID); changed(sessionID) }
    return { status: "stopped" }
  }
  async function finish(entry, status, reason, fastRoll = undefined) {
    if (!active(entry)) return
    entry.status = status
    entry.reason = reason
    if (fastRoll) entry.fastRoll = fastRoll
    entry.finishedAt = now()
    changed(entry.context.sessionID)
    try { await wake(entry.context.sessionID, view(entry), entry.controller.signal) }
    catch {
      if (entries.get(entry.context.sessionID) !== entry) return
      if (entry.auto && status === "triggered") {
        // An automatic wake that never reached the session keeps waiting and
        // delivers the same input again after a backoff.
        lastWake.delete(entry.context.sessionID)
        entry.wakeFailures = (entry.wakeFailures ?? 0) + 1
        Object.assign(entry, { status: "waiting", reason: undefined, finishedAt: undefined, retryAt: now() + Math.min(READ_MAX_BACKOFF_MS, 3000 * 2 ** Math.min(entry.wakeFailures, 5)) })
      } else entry.status = "notification_failed"
      changed(entry.context.sessionID)
    }
  }
  return {
    start(input, context, { auto = false, delayMs = 0 } = {}) {
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
        auto, errors: 0, retryAt: delayMs > 0 ? now() + delayMs : 0,
        dueAt: 0, poked: false, lastReadAt: 0,
      }
      entries.set(context.sessionID, entry)
      changed(context.sessionID)
      return view(entry)
    },
    stop,
    status: sessionID => view(entries.get(sessionID)),
    // Operator/panel detail; never sent to the model.
    detail(sessionID) {
      const entry = entries.get(sessionID)
      if (!entry) return undefined
      return {
        ...view(entry), errors: entry.errors, push: pushed.has(entry.campaignId),
        ...(entry.retryAt > now() ? { retryAt: entry.retryAt } : {}),
        ...(entry.lastReadAt ? { lastReadAt: entry.lastReadAt } : {}),
      }
    },
    waiting: () => waiting().length > 0,
    campaigns: () => new Set(waiting().map(entry => entry.campaignId)),
    // A woken turn failed: the same input may wake the model again.
    forget: sessionID => { lastWake.delete(sessionID) },
    // Push doorbell: read the campaign's waits as soon as the read gap allows.
    // Returns when the earliest of them is due, or undefined when none waits.
    poke(campaignId) {
      let due
      for (const entry of waiting()) if (entry.campaignId === campaignId) {
        entry.poked = true
        entry.dueAt = Math.min(entry.dueAt, entry.lastReadAt + MIN_READ_GAP_MS)
        due = Math.min(due ?? Infinity, Math.max(entry.dueAt, entry.retryAt))
      }
      return due
    },
    setPush(campaignId, live) {
      if (live === pushed.has(campaignId)) return
      if (live) pushed.add(campaignId)
      else pushed.delete(campaignId)
      // Going live reads once to catch up; losing the link resumes polling now.
      for (const entry of waiting()) if (entry.campaignId === campaignId) { entry.dueAt = 0; changed(entry.context.sessionID) }
    },
    close: () => { for (const id of [...entries.keys()]) stop(id) },
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
        if (entry.busy || now() < entry.retryAt || now() < entry.dueAt) return
        entry.busy = true
        entry.poked = false
        try {
          const state = await readSignals(read, {
            operation: "read", campaignId: entry.campaignId, afterSeq: entry.scanSeq,
            projection: "live", delta: true, includeAsks: true, paged: true, maxBytes: 131072,
          }, entry.context)
          if (!active(entry)) return
          if (!sequence(state.currentSeq) || !sequence(state.nextCursor) || state.nextCursor < entry.scanSeq || state.nextCursor > state.currentSeq || (state.hasMore && state.nextCursor === entry.scanSeq)) throw new Error("Invalid ODM cursor")
          const recovered = entry.errors > 0
          entry.errors = 0
          entry.retryAt = 0
          entry.lastReadAt = now()
          // A doorbell that rang during this read gets its own read; otherwise
          // a live link waits for the next signal and a missing one keeps polling.
          entry.dueAt = entry.poked ? now() + MIN_READ_GAP_MS : pushed.has(entry.campaignId) ? now() + SAFETY_READ_MS : 0
          const trigger = entry.epoch && state.timelineEpoch !== entry.epoch
            ? { reason: "resync", key: `resync:${state.timelineEpoch}` }
            : triggerFor(state, entry.scanSeq)
          const sessionID = entry.context.sessionID
          if (trigger && !(entry.auto && lastWake.get(sessionID) === trigger.key)) {
            lastWake.set(sessionID, trigger.key)
            let fastRoll
            if (trigger.reason === "player" && typeof invoke === "function") {
              const playerMsg = state.messages?.findLast(m => sequence(m.seq) && m.seq > entry.scanSeq && m.authorType === "player" && m.kind !== "ooc")
              const check = evaluateFastMechanics(playerMsg)
              if (check && playerMsg?.characterId) {
                try {
                  const invokeRes = await invoke({
                    action: "narrator.invoke",
                    params: {
                      campaignId: entry.campaignId,
                      expectedSeq: state.currentSeq,
                      name: "request_roll",
                      args: {
                        characterId: playerMsg.characterId,
                        kind: check.kind,
                        skill: check.skill,
                        dc: check.dc,
                        advantage: "none",
                        reason: check.reason,
                      },
                    },
                  }, entry.context)
                  if (invokeRes?.ok) {
                    fastRoll = { skill: check.skill, dc: check.dc, characterId: playerMsg.characterId }
                  }
                } catch {
                  // Fall back gracefully to standard wake if fast invoke is unavailable
                }
              }
            }
            await finish(entry, "triggered", trigger.reason, fastRoll)
            return
          }
          // Nothing new, or an automatic wait already woke the model for exactly this input.
          entry.epoch = state.timelineEpoch
          // This is a private scan watermark, never the narrator's processed cursor.
          entry.scanSeq = state.nextCursor
          if (recovered) changed(sessionID)
        } catch (error) {
          if (!active(entry)) return
          // Host tool errors are opaque (a denied permission and an outage look
          // alike), so an explicit wait reports any failure; the automatic one
          // outlives outages such as the nightly ODM backup.
          if (!entry.auto) { await finish(entry, "error", "odm_read_failed"); return }
          if (error?.message === SESSION_CHANGED) { stop(entry.context.sessionID); return }
          entry.errors += 1
          // Transient ODM/MCP failures back off quietly instead of waking the model.
          entry.retryAt = now() + Math.min(READ_MAX_BACKOFF_MS, 3000 * 2 ** Math.min(entry.errors, 5))
          changed(entry.context.sessionID)
        } finally { entry.busy = false }
      }))
    },
  }
}

// Minimal SSE framing: complete frames become signals, the tail waits for more bytes.
export function parseSse(buffer) {
  const frames = buffer.split(/\r?\n\r?\n/)
  const rest = frames.pop() ?? ""
  const events = []
  for (const frame of frames) {
    let id, type, data = ""
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "id") id = value
      else if (field === "event") type = value
      else if (field === "data") data = data ? `${data}\n${value}` : value
    }
    if (!type && !data) { events.push({ type: "ping" }); continue }
    let payload
    try { payload = data ? JSON.parse(data) : {} } catch { payload = {} }
    const seq = /^\d+$/.test(id ?? "") ? Number(id) : undefined
    events.push({ type: type || "message", ...(sequence(seq) ? { seq } : {}), data: payload && typeof payload === "object" ? payload : {} })
  }
  return { events, rest }
}

// Only signals that might need the DM trigger a read; the read decides.
export function isDoorbell(signal) {
  if (!signal?.type || QUIET.has(signal.type)) return false
  if (signal.type !== "message_added" && signal.type !== "message_updated") return true
  const { authorType, kind } = signal.data ?? {}
  return (authorType === undefined || authorType === "player") && kind !== "ooc"
}

function substitute(value) {
  return String(value)
    .replace(/\{file:([^}]+)\}/g, (_, path) => readFileSync(path.trim().replace(/^~(?=$|\/)/, homedir()), "utf8").trim())
    .replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name.trim()] ?? "")
}

// The ODM doorbell lives next to the narrator MCP endpoint (…/mcp/events) and
// uses the same credentials as the configured odm_narrator server.
export function narratorEndpoint(directory, env = process.env) {
  if (env.DND_WATCH_EVENTS_URL) {
    try {
      const token = readFileSync(env.DND_WATCH_TOKEN_FILE || join(homedir(), ".config", "odm", "mcp.token"), "utf8").trim()
      return { url: env.DND_WATCH_EVENTS_URL, headers: { Authorization: `Bearer ${token}` } }
    } catch { return undefined }
  }
  const configHome = env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
  const files = [...(directory ? [join(directory, "opencode.json"), join(directory, ".opencode", "opencode.json")] : []), join(configHome, "opencode.json")]
  for (const file of files) {
    let server
    try {
      const config = JSON.parse(readFileSync(file, "utf8"))
      server = (config.mcp?.servers ?? config.mcp)?.odm_narrator
    } catch { continue }
    if (!server || server.disabled === true || typeof server.url !== "string") continue
    try {
      const url = new URL(server.url)
      if (!/\/mcp\/?$/.test(url.pathname)) return undefined
      url.pathname = url.pathname.replace(/\/?$/, "/events")
      const headers = {}
      for (const [name, value] of Object.entries(server.headers ?? {})) headers[name] = substitute(value)
      return { url: url.toString(), headers }
    } catch { return undefined }
  }
}

// One reconnecting SSE link per campaign. Links carry no game text: only
// event types, sequence numbers and, for chat, the author type and kind.
export function createPushLinks({ endpoint, onSignal, onState, fetch: request = (...args) => globalThis.fetch(...args), now = Date.now, retryMs = 2000 }) {
  const links = new Map()
  const view = link => ({
    state: link.state, since: link.since,
    ...(link.retryAt ? { retryAt: link.retryAt } : {}),
    ...(link.lastEventAt ? { lastEventAt: link.lastEventAt } : {}),
    ...(link.lastByteAt ? { lastByteAt: link.lastByteAt } : {}),
  })
  const publish = link => { try { onState(link.campaignId, view(link)) } catch {} }
  const set = (link, state, retryAt = 0) => {
    if (link.state === state && link.retryAt === retryAt) return
    if (link.state !== state) link.since = now()
    link.state = state
    link.retryAt = retryAt
    publish(link)
  }
  const later = (link, state, delay) => {
    if (link.closed) return
    set(link, state, now() + delay)
    link.timer = setTimeout(() => { link.timer = undefined; void connect(link) }, delay)
    link.timer.unref?.()
  }
  const fail = link => {
    if (link.closed) return
    link.failures += 1
    later(link, "reconnecting", Math.min(PUSH_MAX_BACKOFF_MS, retryMs * 2 ** Math.min(link.failures - 1, 5)))
  }
  function receive(link, event) {
    link.lastByteAt = now()
    if (event.type === "ping") return
    if (sequence(event.seq)) link.cursor = event.type === "campaign_rewound" ? event.seq : Math.max(link.cursor, event.seq)
    if (event.type === "stream_checkpoint") {
      link.failures = 0
      set(link, "live")
      try { onSignal(link.campaignId, { type: "connected" }) } catch {}
      return
    }
    link.lastEventAt = now()
    try { onSignal(link.campaignId, event) } catch {}
  }
  async function connect(link) {
    if (link.closed) return
    let target
    try { target = await endpoint() } catch {}
    if (link.closed) return
    if (!target) return later(link, "unsupported", PUSH_UNSUPPORTED_RETRY_MS)
    const controller = new AbortController()
    link.controller = controller
    set(link, link.failures ? "reconnecting" : "connecting")
    let response
    try {
      const url = new URL(target.url)
      url.searchParams.set("campaignId", link.campaignId)
      url.searchParams.set("afterSeq", String(link.cursor))
      response = await request(url.toString(), {
        headers: { ...target.headers, accept: "text/event-stream", "last-event-id": String(link.cursor) },
        signal: controller.signal,
      })
    } catch { return fail(link) }
    if (link.closed) { controller.abort(); return }
    if (!response.ok || !response.body) {
      try { await response.body?.cancel() } catch {}
      if ([404, 405, 501].includes(response.status)) return later(link, "unsupported", PUSH_UNSUPPORTED_RETRY_MS)
      if (response.status === 401 || response.status === 403) return later(link, "denied", PUSH_UNSUPPORTED_RETRY_MS)
      return fail(link)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        // Heartbeats arrive every ~20 s; silence means a half-open connection (sleep, Wi-Fi switch).
        let idle
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { idle = setTimeout(() => reject(new Error("idle")), PUSH_IDLE_MS); idle.unref?.() }),
        ]).finally(() => clearTimeout(idle))
        if (chunk.done || link.closed) break
        buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length > 1 << 20) throw new Error("Oversized SSE frame")
        const parsed = parseSse(buffer)
        buffer = parsed.rest
        for (const event of parsed.events) receive(link, event)
      }
    } catch {}
    controller.abort()
    try { await reader.cancel() } catch {}
    fail(link)
  }
  function close(campaignId) {
    const link = links.get(campaignId)
    if (!link) return
    link.closed = true
    links.delete(campaignId)
    if (link.timer) clearTimeout(link.timer)
    link.controller?.abort()
    try { onState(campaignId, { state: "off", since: now() }) } catch {}
  }
  return {
    ensure(campaignId, cursor) {
      if (links.has(campaignId)) return
      const link = { campaignId, cursor: sequence(cursor) ? cursor : 0, failures: 0, state: "connecting", since: now(), retryAt: 0, closed: false }
      links.set(campaignId, link)
      publish(link)
      void connect(link)
    },
    close,
    state: campaignId => links.has(campaignId) ? view(links.get(campaignId)) : { state: "off" },
    campaigns: () => [...links.keys()],
    closeAll: () => { for (const id of [...links.keys()]) close(id) },
  }
}

// A table lives until the machine reboots (in WSL: Windows reboot or
// `wsl --shutdown`). Tables saved in an earlier boot are not restored: the
// narrator's next turn arms them again.
export function bootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() } catch {}
  return `boot-${Math.round((Date.now() - uptime() * 1000) / 60_000)}`
}

// A woken turn failed: retry the same input with backoff; after the last
// attempt drop that input but keep waiting for new ones.
export function failedTurn(failures, at = Date.now()) {
  if (failures >= TURN_MAX_ATTEMPTS) return { note: `ход не разобран после ${failures} попыток — жду новый ввод` }
  const delay = Math.min(TURN_RETRY_MAX_MS, TURN_RETRY_MS * 2 ** (failures - 1))
  return { turn: { state: "retry", retryAt: at + delay, failures }, note: `ход упал, повтор через ${Math.round(delay / 1000)}с` }
}

export function stateDirectory(env = process.env) {
  return join(env.CUSTOM_OPENCODE_STATE_DIR || join(homedir(), ".local", "state", "custom-opencode"), "dnd-watch")
}

// One status file per location, read by the TUI sidebar panel.
export function stateFileFor(directory, env = process.env) {
  return join(stateDirectory(env), `${createHash("sha256").update(String(directory)).digest("hex").slice(0, 16)}.json`)
}

let stateWrite = 0
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${++stateWrite}`
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
  renameSync(temporary, path)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

// Restart recovery keeps only identifiers of the narrator's last ODM call.
const pickContext = context => Object.fromEntries(["sessionID", "agent", "messageID", "id"]
  .filter(key => typeof context?.[key] === "string").map(key => [key, context[key]]))

function decodeResult(result) {
  const value = result.output ?? (typeof result.content === "string" ? result.content : result.content?.filter(part => part.type === "text").map(part => part.text).join("\n"))
  return typeof value === "string" ? JSON.parse(value) : value
}

export default {
  id: "custom.dnd-watch",
  async setup(ctx) {
    const registrations = []
    const push = enabled("DND_WATCH_PUSH")
    const keepAwake = enabled("DND_KEEP_AWAKE")
    const reportStatus = enabled("DND_WATCH_STATUS")
    const directory = ctx.location?.directory ?? ""
    const stateFile = stateFileFor(directory)
    const boot = bootId()
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

    // Per narrator session: campaign, last drained story cursor, auto flag, the
    // tool context of its last ODM call, the running turn and a short journal.
    // Only identifiers, cursors and statuses — never game text.
    const tables = new Map()
    const table = sessionID => {
      if (!tables.has(sessionID)) {
        if (tables.size >= MAX_ENTRIES) tables.delete(tables.keys().next().value)
        tables.set(sessionID, { auto: AUTO_WATCH, log: [] })
      }
      return tables.get(sessionID)
    }

    let publishTimer, awake = false, disposed = false
    const publish = () => {
      if (publishTimer || disposed) return
      publishTimer = setTimeout(() => { publishTimer = undefined; writeState() }, 250)
      publishTimer.unref?.()
    }
    const note = (sessionID, text) => {
      const entry = tables.get(sessionID)
      if (!entry) return
      entry.log = [...entry.log, { at: Date.now(), text }].slice(-LOG_LIMIT)
      publish()
    }
    const noteCampaign = (campaignId, text) => {
      for (const [sessionID, entry] of tables) if (entry.campaignId === campaignId) note(sessionID, text)
    }

    const watcher = createDndWatcher({
      onChange: publish,
      read: async (query, context) => {
        const session = await ctx.session.get({ sessionID: context.sessionID })
        if (session.parentID || session.agent !== context.agent || session.location?.directory !== ctx.location.directory) throw new Error(SESSION_CHANGED)
        const narrator = await getNarrator()
        // The native MCP executor still checks this session/agent's permissions.
        return decodeResult(await narrator.execute(query, { ...context, odmBackgroundRead: true, progress: async () => {} }))
      },
      invoke: async (query, context) => {
        const session = await ctx.session.get({ sessionID: context.sessionID })
        if (session.parentID || session.agent !== context.agent || session.location?.directory !== ctx.location.directory) throw new Error(SESSION_CHANGED)
        const narrator = await getNarrator()
        return decodeResult(await narrator.execute(query, { ...context, odmBackgroundRead: true, progress: async () => {} }))
      },
      wake: async (sessionID, result, signal) => {
        signal.throwIfAborted()
        const fastRollNote = result.fastRoll
          ? `\nFast-mechanics: A pending roll for ${result.fastRoll.skill} (DC ${result.fastRoll.dc}) has been requested on the table via ODM. The player is already rolling. Do not issue a duplicate request_roll; narrate the immediate scene tension or await the roll result.`
          : ""
        const text = result.auto
          // Every wake stays in the session; the turn rules already live in the system prompt.
          ? `DnD auto-watch: ${JSON.stringify(result)}\nWake signal (host bookkeeping, not a player action; never quote it). Read ODM from afterSeq, resolve the new input as the DM and publish it.${fastRollNote} In combat the last narration of a resolved turn carries passTurn:true. Do not act for a player or call dnd_watch. Reply to the operator with one short line.`
          : `DnD watcher: ${JSON.stringify(result)}\nThis is a wake signal, not a player action or an authoritative game receipt. Read ODM from afterSeq, drain pages/events, check asks and pending rolls, and obey initiative/global-turn barriers.${fastRollNote} Do not act for a player. After processing, re-arm dnd_watch only while the operator's waiting request remains active. On timeout or error, report the stopped wait; do not claim it is still running.`
        await ctx.session.synthetic({ sessionID, delivery: "queue", resume: true, text, metadata: { dndWatch: result } })
        const entry = tables.get(sessionID)
        if (!entry) return
        if (result.status === "triggered") {
          entry.woke = true
          if (entry.turn?.state === "retry") entry.turn = undefined
          note(sessionID, `проснулся: ${REASONS[result.reason] ?? result.reason}`)
        } else note(sessionID, result.status === "timed_out" ? "ручное ожидание истекло" : "ручное ожидание остановлено: ODM недоступен")
      },
    })

    let endpoint, endpointAt = 0
    const resolveEndpoint = () => {
      if (Date.now() - endpointAt > ENDPOINT_CACHE_MS) { endpoint = narratorEndpoint(directory); endpointAt = Date.now() }
      return endpoint
    }
    // Run a tick soon instead of waiting for the 3 s interval.
    let kickTimer, kickAt = Infinity
    const kick = (delay = 250) => {
      if (disposed || (kickTimer && kickAt <= Date.now() + delay)) return
      if (kickTimer) clearTimeout(kickTimer)
      kickAt = Date.now() + delay
      kickTimer = setTimeout(() => { kickTimer = undefined; kickAt = Infinity; void watcher.tick().catch(() => {}) }, delay)
      kickTimer.unref?.()
    }
    const linkStates = new Map()
    const links = createPushLinks({
      endpoint: resolveEndpoint,
      onSignal: (campaignId, signal) => {
        if (signal.type === "connected") { watcher.setPush(campaignId, true); kick(); return }
        if (signal.type !== "campaign_rewound" && !isDoorbell(signal)) return
        const due = watcher.poke(campaignId)
        if (due !== undefined) kick(Math.max(250, Math.min(due - Date.now(), 60_000)))
      },
      onState: (campaignId, state) => {
        if (state.state !== "live") watcher.setPush(campaignId, false)
        const previous = linkStates.get(campaignId)
        linkStates.set(campaignId, state.state)
        if (state.state !== previous) {
          if (state.state === "live") noteCampaign(campaignId, "push-канал к ODM подключён")
          else if (state.state === "reconnecting" && previous === "live") noteCampaign(campaignId, "связь с ODM потеряна, переподключаюсь")
          else if (state.state === "unsupported") noteCampaign(campaignId, "сервер без push — опрос каждые 3с")
          else if (state.state === "denied") noteCampaign(campaignId, "push отклонён (токен) — опрос каждые 3с")
        }
        publish()
      },
    })
    const lingering = new Map()
    function reconcileLinks() {
      if (!push) return
      const wanted = watcher.campaigns()
      // A connected narrator session keeps its doorbell even between waits, until
      // reboot: the players' header lamp means "the DM host is online".
      for (const entry of tables.values())
        if (entry.campaignId && entry.context) wanted.add(entry.campaignId)
      for (const campaignId of wanted) {
        lingering.delete(campaignId)
        // Start at the waits' own cursor: the replay then covers only what they have not seen.
        const cursors = [...tables.keys()].map(sessionID => watcher.detail(sessionID))
          .filter(detail => detail?.status === "waiting" && detail.campaignId === campaignId).map(detail => detail.afterSeq)
        if (!cursors.length) for (const entry of tables.values()) if (entry.campaignId === campaignId && sequence(entry.cursor)) cursors.push(entry.cursor)
        links.ensure(campaignId, cursors.length ? Math.min(...cursors) : 0)
      }
      for (const campaignId of links.campaigns()) {
        if (wanted.has(campaignId)) continue
        const since = lingering.get(campaignId) ?? Date.now()
        lingering.set(campaignId, since)
        if (Date.now() - since > PUSH_LINGER_MS) { lingering.delete(campaignId); links.close(campaignId) }
      }
    }
    // keep-awake is optional: without it the watcher still works, the PC may just sleep.
    // An armed table holds it until reboot; DND_KEEP_AWAKE=0 lets the PC sleep.
    let awakeHooks
    if (keepAwake) import("./keep-awake.js").then(hooks => { if (typeof hooks.holdAwake === "function") awakeHooks = hooks }).catch(() => {})
    function syncAwake() {
      const want = Boolean(awakeHooks) && [...tables.entries()].some(([sessionID, entry]) =>
        watcher.status(sessionID).status === "waiting" || entry.turn?.state === "running" || entry.turn?.state === "retry")
      if (want) awakeHooks.holdAwake(TOOL)
      else if (awake) awakeHooks?.releaseAwake(TOOL)
      if (want !== awake) { awake = want; publish() }
    }

    function writeState(extra = {}) {
      const sessions = {}
      for (const [sessionID, entry] of tables) {
        if (!entry.campaignId) continue
        sessions[sessionID] = {
          agent: entry.context?.agent, campaignId: entry.campaignId,
          ...(sequence(entry.cursor) ? { cursor: entry.cursor } : {}),
          autoWatch: entry.auto,
          watch: watcher.detail(sessionID) ?? { status: "stopped" },
          link: push ? links.state(entry.campaignId) : { state: "disabled" },
          ...(entry.turn ? { turn: entry.turn } : {}),
          awake, log: entry.log,
          ...(entry.context ? { context: pickContext(entry.context) } : {}),
        }
      }
      if (!Object.keys(sessions).length && !writeState.wrote) return
      writeState.wrote = true
      try { writeJsonAtomic(stateFile, { version: 1, pid: process.pid, bootId: boot, directory, updatedAt: Date.now(), sessions, ...extra }) } catch {}
    }

    // One narrator per table: every other session watching this campaign stops and
    // forgets it, so two DMs never resolve the same round. Returns how many were dropped.
    const evict = (sessionID, campaignId) => {
      let dropped = 0
      for (const [other, entry] of tables) if (other !== sessionID && entry.campaignId === campaignId) {
        watcher.stop(other)
        tables.delete(other)
        dropped++
      }
      return dropped
    }
    // A primary session that connects to a campaign takes the table over.
    async function takeOver(sessionID, campaignId) {
      if (disposed || (await ctx.session.get({ sessionID })).parentID || tables.get(sessionID)?.campaignId !== campaignId) return
      const dropped = evict(sessionID, campaignId)
      if (!dropped) return
      note(sessionID, `стол забран у прошлых сессий нарратора (${dropped})`)
      reconcileLinks()
      syncAwake()
    }

    const remember = (input, context, result) => {
      if (!context?.sessionID || context.odmBackgroundRead || !UUID.test(input?.campaignId || "")) return
      if (!String(context.agent || "").startsWith("dnd-")) return
      const entry = table(context.sessionID)
      if (entry.campaignId !== input.campaignId) Object.assign(entry, { campaignId: input.campaignId, cursor: undefined })
      entry.context = context
      if (input.operation === "connect") takeOver(context.sessionID, input.campaignId).catch(() => {})
      publish()
      if (input.operation !== "read") return
      let cursor
      try { cursor = drainedCursor(decodeResult(result)) } catch { return }
      if (cursor !== undefined) entry.cursor = cursor
    }
    // DM activity for the players' web UI: "thinking" when a table turn starts,
    // "idle" when it ends. Fire-and-forget through the same native executor as
    // the watcher's reads, so permissions still apply. Reports are chained per
    // session (an idle never overtakes its thinking); a failed report leaves
    // the table state unknown, so the next report for it goes out again.
    function dmStatus(sessionID, state) {
      const entry = tables.get(sessionID)
      if (!reportStatus || !entry?.campaignId || !entry.context) return
      if (entry.dmStatus === state || (state === "idle" && entry.dmStatus === undefined)) return
      entry.dmStatus = state
      // The idle goes to the campaign that was told "thinking", even if the turn switched campaigns.
      if (state === "thinking" || !entry.dmStatusCampaign) entry.dmStatusCampaign = entry.campaignId
      const campaignId = entry.dmStatusCampaign, context = entry.context
      entry.dmStatusChain = (entry.dmStatusChain ?? Promise.resolve()).then(async () => {
        if (entry.dmStatus !== state || disposed) return
        try {
          // Subagent sessions (dnd-reader, dnd-memory…) never speak for the DM.
          entry.primary ??= !(await ctx.session.get({ sessionID })).parentID
          if (!entry.primary) return
          const narrator = await getNarrator()
          await narrator.execute({ operation: "status", campaignId, state }, {
            ...context, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), odmBackgroundRead: true, progress: async () => {},
          })
        } catch { if (entry.dmStatus === state) entry.dmStatus = "unknown" }
      })
    }
    async function arm(sessionID) {
      const entry = tables.get(sessionID)
      if (!sessionID || !entry?.auto || !entry.context || !entry.campaignId || !sequence(entry.cursor)) return false
      if (watcher.status(sessionID).status === "waiting") return true
      const session = await ctx.session.get({ sessionID })
      if (session.parentID || session.agent !== entry.context.agent) {
        note(sessionID, session.parentID ? "автоожидание не взведено: дочерняя сессия" : `автоожидание не взведено: агент сессии ${session.agent ?? "?"}`)
        return false
      }
      const delayMs = entry.turn?.state === "retry" ? Math.max(0, entry.turn.retryAt - Date.now()) : 0
      watcher.start({ campaignId: entry.campaignId, afterSeq: entry.cursor, timeoutSeconds: AUTO_TIMEOUT_SECONDS }, entry.context, { auto: true, delayMs })
      reconcileLinks()
      kick()
      return true
    }

    // Restart recovery: re-arm narrator tables saved by a previous process of
    // this boot. After a reboot the panel is cleared and the tables stay off
    // until the narrator's next turn.
    const restored = []
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"))
      const owned = saved?.pid && saved.pid !== process.pid && alive(saved.pid) && Date.now() - saved.updatedAt < 3 * STATE_HEARTBEAT_MS
      const rebooted = Boolean(saved?.bootId) && saved.bootId !== boot
      if (rebooted) { writeState.wrote = true; publish() }
      for (const [sessionID, value] of owned || rebooted ? [] : Object.entries(saved?.sessions ?? {})) {
        const context = pickContext(value?.context)
        if (!UUID.test(value?.campaignId || "") || !sequence(value?.cursor) || context.sessionID !== sessionID || !String(context.agent || "").startsWith("dnd-")) continue
        Object.assign(table(sessionID), {
          campaignId: value.campaignId, cursor: value.cursor, auto: AUTO_WATCH && value.autoWatch !== false, context,
          log: Array.isArray(value.log) ? value.log.filter(item => typeof item?.text === "string").slice(-LOG_LIMIT) : [],
        })
        // Older files may hold several sessions on one campaign: the last one saved keeps it.
        evict(sessionID, value.campaignId)
        restored.push(sessionID)
        note(sessionID, "восстановлен после перезапуска opencode")
      }
    } catch {}
    // The host may still be starting: retry a failed re-arm twice before dropping it.
    let restoreTimer
    const rearm = (sessionIDs, attempt) => {
      restoreTimer = setTimeout(async () => {
        restoreTimer = undefined
        const failed = []
        await Promise.all(sessionIDs.map(sessionID => arm(sessionID).catch(() => { failed.push(sessionID) })))
        if (!failed.length || disposed) return
        if (attempt < 2) return rearm(failed, attempt + 1)
        for (const sessionID of failed) tables.delete(sessionID)
        publish()
      }, attempt ? 10_000 : 1000)
      restoreTimer.unref?.()
    }
    if (restored.length) rearm(restored, 0)

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
      description: "Background ODM watcher. Auto-watch is on by default: after each narrator turn the host itself waits for player input, Ask, whisper, roll result or round-ready in the campaign you read and resumes this session, so you never call this tool for that; start while auto-watch waits on the same campaign changes nothing. start is only for an explicit one-shot wait the operator asks for (another cursor or campaign); after starting, finish your response and do not poll. status/stop control only this session. Does not play for characters.",
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
          const entry = tables.get(context.sessionID)
          // The model sometimes "arms" a wait itself, often mid-turn: never let
          // that replace the resilient automatic wait on the same campaign.
          if (entry?.auto && entry.campaignId === input.campaignId && sequence(entry.cursor) && entry.context)
            result = { status: "auto", campaignId: input.campaignId, note: "auto-watch is on for this campaign: the host waits for players after this turn; nothing to start" }
          else {
            result = watcher.start(input, context)
            const own = table(context.sessionID)
            if (own.campaignId !== input.campaignId) Object.assign(own, { campaignId: input.campaignId, cursor: undefined })
            own.context ??= context
            note(context.sessionID, `ручное ожидание с #${input.afterSeq}`)
            reconcileLinks()
          }
        } else throw new Error("Unknown watcher action")
        return { content: JSON.stringify(result), metadata: { dndWatch: result } }
      },
    })))
    registrations.push(await ctx.command.transform(editor => editor.add({
      name: "dnd-watch", description: "Background ODM wait for this session: /dnd-watch status|stop|auto (stop also turns auto-watch off)",
      execute: async ({ sessionID, prompt }) => {
        const action = (prompt.text || "status").trim()
        if (!["status", "stop", "auto"].includes(action)) throw new Error("Usage: /dnd-watch status|stop|auto")
        if (action === "stop") { table(sessionID).auto = false; watcher.stop(sessionID); note(sessionID, "выключен оператором") }
        if (action === "auto") {
          const entry = table(sessionID)
          Object.assign(entry, { auto: true, failures: 0, turn: undefined })
          note(sessionID, "включён оператором")
          await arm(sessionID)
        }
        const entry = tables.get(sessionID)
        const result = {
          ...watcher.status(sessionID), autoWatch: entry?.auto ?? AUTO_WATCH,
          ...(entry?.campaignId && push ? { push: links.state(entry.campaignId).state } : {}),
          ...(entry?.turn ? { turn: entry.turn.state } : {}),
        }
        await ctx.session.synthetic({ sessionID, text: `DnD watcher: ${JSON.stringify(result)}`, resume: false })
      },
    })))
    const stopEvents = startEvents(ctx, event => {
      const sessionID = event.data?.sessionID
      const type = event.type
      if (["session.execution.interrupted", "session.execution.failed", "session.deleted", "session.moved", "session.agent.selected", "session.model.selected"].includes(type)
        || (type === "session.inbox.enqueued" && event.data?.item?.type === "user")) watcher.stop(sessionID)
      // A changed agent invalidates the remembered tool context until the next ODM call.
      if (["session.agent.selected", "session.moved"].includes(type) && tables.has(sessionID)) tables.get(sessionID).context = undefined
      if (type === "session.deleted") { tables.delete(sessionID); publish() }
      const entry = sessionID ? tables.get(sessionID) : undefined
      if (entry) {
        const woke = entry.woke
        if (type === "session.execution.started") dmStatus(sessionID, "thinking")
        else if (type === "session.idle" || ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) dmStatus(sessionID, "idle")
        if (type === "session.execution.started") { entry.turn = { state: "running", startedAt: Date.now() }; publish() }
        else if (type === "session.execution.succeeded") {
          if (woke) note(sessionID, "ход разобран, жду дальше")
          Object.assign(entry, { woke: false, failures: 0, turn: undefined })
          publish()
        } else if (type === "session.execution.interrupted") {
          if (woke) note(sessionID, event.data?.reason === "user" ? "ход прерван оператором" : `ход прерван (${event.data?.reason ?? "?"})`)
          Object.assign(entry, { woke: false, turn: undefined })
          publish()
        } else if (type === "session.execution.failed") {
          entry.woke = false
          if (!woke) entry.turn = undefined
          else {
            const next = failedTurn((entry.failures ?? 0) + 1)
            // The failed turn never handled the input: let the same input wake again, later.
            if (next.turn) watcher.forget(sessionID)
            Object.assign(entry, { failures: next.turn ? next.turn.failures : 0, turn: next.turn })
            note(sessionID, next.note)
          }
          publish()
        } else if (type === "session.idle" && entry.turn?.state === "running") { entry.turn = undefined; publish() }
      }
      // A model switch between turns stops the wait above; the table stays watched with the new model.
      if (["session.idle", "session.execution.succeeded", "session.execution.failed"].includes(type) || (type === "session.model.selected" && entry?.turn?.state !== "running")) return arm(sessionID).catch(() => {})
    })
    // ponytail: waits are process-local; the status file lets a restarted
    // process re-arm them, but a host job store would make that durable.
    const timer = setInterval(() => {
      void watcher.tick().catch(() => {})
      reconcileLinks()
      syncAwake()
      for (const entry of tables.values()) if (entry.turn?.state === "retry" && Date.now() > entry.turn.retryAt + 60_000) { entry.turn = undefined; publish() }
    }, 3000)
    timer.unref?.()
    const heartbeat = setInterval(() => writeState(), STATE_HEARTBEAT_MS)
    heartbeat.unref?.()
    return async () => {
      disposed = true
      clearInterval(timer); clearInterval(heartbeat)
      for (const pending of [publishTimer, kickTimer, restoreTimer]) if (pending) clearTimeout(pending)
      stopEvents(); links.closeAll(); watcher.close()
      if (awake) awakeHooks?.releaseAwake(TOOL)
      awake = false
      writeState({ stoppedAt: Date.now() })
      if (readerRegistration) await (await readerRegistration).dispose()
      await Promise.allSettled(registrations.map(registration => registration?.dispose?.()))
    }
  },
}
