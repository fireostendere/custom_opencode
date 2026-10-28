// OpenCode V2 session data → dock panel rows. Pure functions: no Solid, no
// plugin context, so the regression suite can drive them with fixtures.
//
// V2 messages carry `type` (user, assistant, synthetic, shell, compaction,
// idle, ...), user text in `text` and assistant parts in `content`; the V1
// `role`/`parts` shape the panels were first written for no longer exists.

/** V2 events after which a panel may show something new. */
export const PANEL_EVENTS = [
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.text.ended",
  "session.synthetic",
  "session.shell.ended",
  "session.compaction.ended",
  "session.inbox.delivered",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
]
/** V2 events that change which sessions exist or how they are named. */
export const SESSION_TREE_EVENTS = [
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.archived",
  "session.unarchived",
  "session.moved",
]

// Icons follow the OpenCode transcript (→ read, ✱ search, ← edit, $ shell) so both read alike.
const TOOLS = {
  bash: ["$", "команда"],
  shell: ["$", "команда"],
  execute: ["$", "код"],
  read: ["→", "чтение"],
  edit: ["←", "правка"],
  write: ["←", "запись"],
  patch: ["←", "правка"],
  apply_patch: ["←", "правка"],
  grep: ["✱", "поиск"],
  glob: ["✱", "файлы"],
  list: ["✱", "список"],
  codesearch: ["✱", "поиск"],
  webfetch: ["›", "веб"],
  fetch: ["›", "веб"],
  websearch: ["›", "веб-поиск"],
  task: ["◇", "подагент"],
  question: ["?", "вопрос"],
  plan_update: ["≡", "план"],
  todowrite: ["≡", "задачи"],
  goal_update: ["≡", "цель"],
  skill: ["·", "навык"],
}

export function truncate(text, max = 160) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim()
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function created(message) {
  return Number(message?.time?.created ?? 0)
}

/** Messages in time order; the store may append late items (compactions, retries) out of order. */
export function sortedMessages(messages) {
  return [...(messages ?? [])].sort((a, b) => created(a) - created(b))
}

function input(part) {
  let value = part?.state?.input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { raw: value }
    }
  }
  return value && typeof value === "object" ? value : {}
}

/** The tail of a path, where the file name is: "…/native/vqe_audit.c". */
export function pathTail(path, max = 32) {
  const value = String(path ?? "").trim()
  if (value.length <= max) return value
  const parts = value.split("/")
  let tail = parts.pop() ?? ""
  while (parts.length && tail.length + parts.at(-1).length + 2 <= max) tail = `${parts.pop()}/${tail}`
  return `…/${tail}`
}

/** A command as a person would say it: no `cd … &&`, env assignments or `.venv/bin/python -m`. */
export function shortCommand(command) {
  let value = String(command ?? "").split("\n").find((line) => line.trim()) ?? ""
  value = value.replace(/^\s*cd\s+\S+\s*&&\s*/, "").replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "")
  value = value.replace(/^\S*\/(?:python3?|node|bun)(?:\s+-m)?\s+/, "").replace(/^(?:\.\/|\S+\/bin\/)/, "")
  return truncate(value, 80)
}

/** The most telling argument of a tool call: file, command, pattern, address or question. */
export function toolDetail(part) {
  const value = input(part)
  const name = String(part?.name ?? "")
  if (typeof value.patchText === "string") {
    const files = [...value.patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1])
    return files.length ? pathTail(files[0]) + (files.length > 1 ? ` +${files.length - 1}` : "") : ""
  }
  if (typeof value.command === "string") return shortCommand(value.command)
  if (typeof value.code === "string") return truncate(value.code, 60)
  if (name === "question" && Array.isArray(value.questions)) return truncate(value.questions[0]?.header ?? value.questions[0]?.question, 80)
  if (typeof value.pattern === "string") return truncate(value.pattern, 60)
  if (typeof value.url === "string") return truncate(value.url.replace(/^https?:\/\//, ""), 80)
  for (const key of ["filePath", "path"]) if (typeof value[key] === "string" && value[key].trim()) return pathTail(value[key])
  for (const key of ["query", "description", "title", "status", "id", "action", "prompt", "raw"]) {
    if (typeof value[key] === "string" && value[key].trim()) return truncate(value[key], 80)
  }
  return ""
}

export function messageText(message) {
  if (typeof message?.text === "string") return message.text.trim()
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
}

function toolRow(part, time) {
  const name = String(part?.name ?? "tool")
  const [icon, label] = TOOLS[name] ?? ["·", name]
  const status = String(part?.state?.status ?? "")
  const tone = status === "error" ? "error" : status === "running" || status === "streaming" ? "active" : "base"
  const detail = toolDetail(part)
  // A known tool's icon already says what it did, so its target gets the room; the word stays for the rest.
  return { time, icon, title: TOOLS[name] && detail ? "" : label, detail, tone }
}

const IDLE = {
  succeeded: ["■", "готово", "success"],
  failed: ["✗", "ошибка", "error"],
  interrupted: ["‖", "прервано", "muted"],
}

/** One line per event: what happened, with its target. Newest last. */
export function activityRows(messages, limit = 60) {
  const rows = []
  for (const message of sortedMessages(messages)) {
    const time = created(message)
    if (message?.type === "user") rows.push({ time, icon: "›", title: "вы", detail: truncate(messageText(message), 120), tone: "accent" })
    else if (message?.type === "shell") rows.push({ time, icon: "$", title: "shell", detail: truncate(message.command, 120), tone: "base" })
    else if (message?.type === "compaction") rows.push({ time, icon: "⇣", title: "сжатие контекста", detail: "", tone: "muted" })
    else if (message?.type === "idle") {
      const [icon, title, tone] = IDLE[message.outcome] ?? IDLE.succeeded
      rows.push({ time, icon, title, detail: "", tone })
    } else if (message?.type === "assistant") {
      for (const part of message.content ?? []) if (part?.type === "tool") rows.push(toolRow(part, Number(part.time?.created ?? time)))
      const text = messageText(message)
      if (text && message.time?.completed) rows.push({ time: Number(message.time.completed), icon: "◆", title: "ответ", detail: truncate(text, 120), tone: "base" })
    }
  }
  // Tools carry their own start times; a stable sort keeps same-time rows in message order.
  return rows.sort((a, b) => a.time - b.time).slice(-limit)
}

/** What the user asked, newest first. */
export function historyRows(messages) {
  return sortedMessages(messages)
    .filter((message) => message?.type === "user")
    .map((message) => ({ time: created(message), text: truncate(messageText(message), 400) }))
    .filter((row) => row.text)
    .reverse()
}

export function planProgress(todos) {
  const items = todos ?? []
  const done = items.filter((todo) => todo?.status === "completed").length
  const current = items.find((todo) => todo?.status === "in_progress") ?? items.find((todo) => todo?.status !== "completed")
  return { done, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0, current }
}

/** "только что", "5 мин назад", "2 ч назад", or nothing for an unknown time. */
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return ""
  const minutes = Math.floor((now - Number(ts)) / 60_000)
  if (minutes < 1) return "только что"
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} д назад`
}

export function formatTokens(value) {
  const n = Number(value ?? 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** The session card: identity, model, cost and token totals from V2 SessionInfo. */
export function sessionCard(info, status) {
  if (!info) return null
  const tokens = info.tokens ?? {}
  const cache = tokens.cache ?? {}
  return {
    title: info.title || "Сессия",
    id: info.id,
    running: status === "running",
    outcome: info.outcome,
    agent: info.agent,
    model: info.model ? [info.model.id, info.model.variant].filter(Boolean).join(" · ") : "",
    cost: Number(info.cost ?? 0),
    input: Number(tokens.input ?? 0),
    output: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0),
    cached: Number(cache.read ?? 0),
    created: info.time?.created,
    updated: info.time?.updated,
  }
}
