import { randomUUID } from "node:crypto"
import { bodyChanged, capRequestBody, observeUsage } from "./tui/lib/request-budget.js"
import { resolveContextPolicy } from "./tui/lib/context-policy.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)

const WEB_HOST = process.env.OPENCODE_RUNTIME_PLUGIN_HOST || "127.0.0.1"
const WEB_PORT = process.env.OPENCODE_POLICY_PORT || process.env.OPENCODE_WEB_PORT || "4099"
// Read per call: sibling plugins reuse this client (hardware workers).
const runtimeToken = () =>
  process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD || ""
const BASE = `http://${WEB_HOST}:${WEB_PORT}`
const TIMEOUT = Number(process.env.OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS || 1800)
const SECRET_PREFIXES = (
  process.env.OPENCODE_SECRET_PREFIXES ||
  "TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_;GEMINI_;GOOGLE_"
)
  .split(";")
  .filter(Boolean)
// These credentials must never enter an agent shell, even when a configured
// broker scope explicitly grants other provider secrets to that shell.
const RESERVED_SECRETS = new Set([
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_BACKEND_PASSWORD",
  "OPENCODE_RUNTIME_PLUGIN_TOKEN",
  "OPENCODE_OPENAI_ACCESS",
  "OPENCODE_OPENAI_REFRESH",
  "OPENCODE_ZEN_KEY",
  "OPENCODE_GO_KEY",
])
const CONTEXT_MARKER = "Server runtime context"
const MANAGED_PREFIX = `${CONTEXT_MARKER} (deduplicated, budgeted, checkpoint/RAG/repo aware):\n`
const APPROVAL_WAIT_MS = 45000
const POLICY_HEALTH_TTL_MS = Number(process.env.OPENCODE_POLICY_HEALTH_TTL_MS || 30000)
// The runtime context envelope is fetched once per user turn. The first step
// waits at most this long; whatever is ready then stays frozen for the whole
// turn, so the provider prompt-cache prefix never changes mid-turn.
const CONTEXT_HOT_PATH_WAIT_MS = Number(process.env.OPENCODE_CONTEXT_HOT_PATH_WAIT_MS || 2000)
const CONTEXT_BACKOFF_MIN_MS = 5000
const CONTEXT_BACKOFF_MAX_MS = 300000
const WARN_INTERVAL_MS = 60000
const REQUEST_AFTER_TIMEOUT_MS = 5000
// A primary request reuses the budget snapshot bound by its own context hook.
const STEP_BINDING_TTL_MS = 120000
// Media parts count as a fixed estimate, never by base64 length.
const MEDIA_CHARS = 2200
const UNTRACKED = Symbol("untracked provider request")

const BUDGET_REASONS = [
  [/completion reserve already used/i, "резерв на финальный ответ уже израсходован"],
  [/completion-only request cannot execute tools/i, "после финального ответа инструменты недоступны"],
  [/model call budget exhausted/i, "исчерпан лимит вызовов модели"],
  [/tool-attempt budget exhausted/i, "исчерпан лимит вызовов инструментов"],
  [/time budget exhausted/i, "исчерпан лимит времени"],
  [/output\/reasoning budget exhausted/i, "исчерпан лимит выходных токенов"],
]
const RESERVE_SPENT = /completion reserve already used|completion-only request cannot execute tools/i

const isBudgetExceeded = (error) =>
  error?.name === "BudgetExceeded" || String(error?.message || error).includes("BudgetExceeded")

/** Short user-facing replacement for the runtime's BudgetExceeded payload. */
export function budgetError(detail) {
  const text = String(detail?.message || detail || "")
  const reason = BUDGET_REASONS.find(([pattern]) => pattern.test(text))?.[1] || "лимит исчерпан"
  const error = new Error(
    `Бюджет хода исчерпан: ${reason}. Одобрите расширение бюджета или отправьте новое сообщение — новый ход получит свежий бюджет.`,
  )
  error.name = "BudgetExceeded"
  return error
}

function remember(map, key, value, limit) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

const warned = new Map()
function warnLimited(kind, message) {
  const state = warned.get(kind) || { at: 0, suppressed: 0 }
  const now = Date.now()
  if (now - state.at < WARN_INTERVAL_MS) {
    state.suppressed += 1
    warned.set(kind, state)
    return
  }
  const suffix = state.suppressed ? ` (+${state.suppressed} similar since last report)` : ""
  console.warn(`[server-runtime-guard] ${message}${suffix}`)
  warned.set(kind, { at: now, suppressed: 0 })
}

let ensureFlight
let lastHealth = 0

function startPolicyEnsure(command) {
  if (!ensureFlight)
    ensureFlight = (async () => {
      await execFileAsync(command, ["ensure"], { timeout: 20000, maxBuffer: 16000 })
      lastHealth = Date.now()
    })().finally(() => {
      ensureFlight = undefined
    })
  return ensureFlight
}

async function ensurePolicy(blocking = false) {
  const command = process.env.OPENCODE_POLICY_COMMAND
  if (!command) return
  if (!blocking && Date.now() - lastHealth < POLICY_HEALTH_TTL_MS) return
  if (!command.startsWith("/"))
    throw new Error("OPENCODE_POLICY_COMMAND must be an absolute installed launcher")
  const flight = startPolicyEnsure(command)
  // Health refreshes are speculative, including first use. Try the local
  // runtime immediately; if it is actually down, call() awaits this same
  // single-flight ensure and retries once.
  if (blocking) return flight
  flight.catch(() => {})
}

async function runtimeFetch(path, payload, timeoutMs, token) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenCode-Runtime": token },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** Private runtime control call. options.repair=false never runs `ensure`. */
export async function runtimeCall(path, payload, options = {}) {
  const repair = options.repair !== false
  if (repair) await ensurePolicy(false)
  const token = runtimeToken()
  if (!token) throw new Error("Runtime plugin token is not configured")
  const contextBudgetRequest =
    path.endsWith("/context-budget") && payload?.action === "request"
  const timeoutMs =
    options.timeoutMs ??
    (contextBudgetRequest
      ? Math.max(90000, TIMEOUT)
      : path.endsWith("/context")
        ? Math.max(15000, TIMEOUT)
        : TIMEOUT)
  let response
  try {
    response = await runtimeFetch(path, payload, timeoutMs, token)
  } catch (error) {
    // The sidecar may have died after the last health check. Repair once and
    // retry, but never run the periodic "ensure" subprocess synchronously.
    if (!repair || !process.env.OPENCODE_POLICY_COMMAND) throw error
    await ensurePolicy(true)
    response = await runtimeFetch(path, payload, timeoutMs, token)
  }
  if (!response.ok)
    throw new Error(`runtime control ${response.status}: ${(await response.text()).slice(0, 300)}`)
  // Any successful answer proves the sidecar is alive: no periodic `ensure`.
  lastHealth = Date.now()
  return response.json()
}
const call = runtimeCall

function contextOf(event) {
  return {
    sessionID: event?.sessionID || event?.context?.sessionID || event?.metadata?.sessionID || "",
    cwd: event?.cwd || event?.directory || event?.context?.directory || "",
  }
}

function stripSecrets(env) {
  for (const key of Object.keys(env || {}))
    if (RESERVED_SECRETS.has(key) || SECRET_PREFIXES.some((prefix) => key.startsWith(prefix)))
      delete env[key]
}

function systemText(item) {
  if (typeof item === "string") return item
  if (item && typeof item === "object" && typeof item.text === "string") return item.text
  return ""
}

const isManagedPart = (part) =>
  part?.type === "text" && typeof part.text === "string" && part.text.startsWith(MANAGED_PREFIX)

function lastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index]?.role === "user") return index
  return -1
}

function userText(message) {
  const content = message?.content
  if (typeof content === "string") return content.slice(0, 12000)
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part?.type === "text" && !isManagedPart(part))
    .map((part) => part.text)
    .join("\n")
    .slice(0, 12000)
}

function jsonLength(value) {
  try {
    return JSON.stringify(value)?.length || 0
  } catch {
    return 0
  }
}

/** Text-part estimate of the active transcript; media never counts by base64 size. */
export function estimateContextTokens(messages) {
  let chars = 0
  for (const message of messages || []) {
    const content = message?.content
    if (typeof content === "string") {
      chars += content.length
      continue
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (!part || typeof part !== "object") continue
      if (typeof part.text === "string") chars += part.text.length
      else if (part.type === "media") chars += MEDIA_CHARS
      else if (part.type === "tool-call") chars += jsonLength(part.input)
      else if (part.type === "tool-result") {
        const value = part.result?.value
        if (typeof value === "string") chars += value.length
        else if (Array.isArray(value))
          for (const item of value) chars += typeof item?.text === "string" ? item.text.length : MEDIA_CHARS
        else chars += jsonLength(value)
      }
    }
  }
  return Math.ceil(chars / 2.2)
}

function withTurnContext(message, text) {
  const content = Array.isArray(message.content)
    ? message.content.filter((part) => !isManagedPart(part))
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : []
  return { ...message, content: text ? [{ type: "text", text: `${MANAGED_PREFIX}${text}` }, ...content] : content }
}

function exhausted(budget) {
  const limits = budget?.limits || {}
  return (
    budget?.finish_used >= 1 ||
    budget?.tools >= limits.toolAttempts ||
    budget?.calls >= limits.calls ||
    budget?.output_reserved >= limits.outputTokens - limits.finishTokens ||
    Date.now() - budget?.started_at > limits.seconds * 1000
  )
}

function raceTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "custom-opencode.server-runtime-guard",
  setup: async (ctx) => {
    const nativeBindings = new Map()
    const sessionFacts = new Map()
    const managedContexts = new Map()
    const contextFlights = new Map()
    const contextFailures = new Map()
    const requests = new WeakMap()
    let catalog = [],
      catalogAt = 0,
      catalogFlight = null

    function refreshCatalog() {
      if (!ctx.catalog?.model?.list) return Promise.resolve()
      catalogFlight ??= (async () => {
        try {
          const value = await ctx.catalog.model.list({})
          catalog = Array.isArray(value) ? value : value?.data || []
        } catch {
          // Catalog refresh is metadata only. Keep the last snapshot so a
          // provider catalog hiccup cannot block an otherwise valid request.
        } finally {
          catalogAt = Date.now()
          catalogFlight = null
        }
      })()
      return catalogFlight
    }
    async function catalogSnapshot() {
      // Only the first binding waits; later refreshes never sit on a request.
      if (!catalogAt) await refreshCatalog()
      else if (Date.now() - catalogAt > 30000) void refreshCatalog()
      return catalog
    }
    const recordFor = (model) =>
      (Array.isArray(catalog) ? catalog : []).find(
        (item) => item.id === model?.id && (item.providerID || item.provider) === model?.providerID,
      )
    const outputLimitFor = (model) => {
      const record = recordFor(model)
      return Number(record?.limit?.output || record?.outputLimit || 16384)
    }
    async function factsFor(sessionID) {
      // parentID never changes and the directory comes from ctx.location, so
      // one session.get per session replaces one per model step.
      const cached = sessionFacts.get(sessionID)
      if (cached) return cached
      const session = ctx.session.get ? await ctx.session.get({ sessionID }) : {}
      const facts = {
        parentID: session?.parentID || null,
        directory: session?.location?.directory || "",
        model: session?.model,
      }
      remember(sessionFacts, sessionID, facts, 1000)
      return facts
    }

    async function bindNative(event, turnID = "", options = {}) {
      const sessionID = event.sessionID
      if (!sessionID) throw new Error("Native request lacks session identity")
      const previous = nativeBindings.get(sessionID)
      const messages = Array.isArray(options.messages) ? options.messages : null
      const index = messages ? lastUserIndex(messages) : -1
      const turn = index >= 0 ? messages[index] : undefined
      // Compaction/generate prompts are id-less: they belong to the current turn.
      const auxiliary = Boolean(turn && !turn.id)
      const model = event.model || previous?.binding.model
      const effectiveTurn = turnID || previous?.binding.turnID || ""
      const key = JSON.stringify([
        effectiveTurn,
        messages ? messages.length : (previous?.count ?? -1),
        model?.providerID,
        model?.id,
      ])
      // One /bind per model step: (session, turn, message count) identifies it.
      if (!options.force && previous?.key === key && previous.budget) return previous
      const facts = await factsFor(sessionID)
      await catalogSnapshot()
      const record = recordFor(model || facts.model)
      const binding = {
        sessionID,
        parentID: facts.parentID,
        directory: ctx.location?.directory || facts.directory || process.cwd(),
        turnID: effectiveTurn,
        model: model || facts.model,
        query: messages && !auxiliary ? userText(turn) : previous?.binding.query,
        activeContextTokens: messages
          ? estimateContextTokens(messages)
          : previous?.binding.activeContextTokens,
        modelRecord: record
          ? {
              id: record.id,
              providerID: record.providerID,
              limit: record.limit,
              capabilities: record.capabilities,
              name: record.name,
            }
          : null,
        outputLimit: Number(record?.limit?.output || record?.outputLimit || 16384),
      }
      const budget = await call("/internal/runtime/bind", binding)
      const entry = {
        key,
        count: messages ? messages.length : previous?.count,
        binding,
        budget,
        boundAt: Date.now(),
      }
      remember(nativeBindings, sessionID, entry, 1000)
      return entry
    }

    function requestBinding(event, primary) {
      const current = nativeBindings.get(event.sessionID)
      // http.request events carry no transcript: reuse the step bound by the
      // context hook. Auxiliary requests only need an existing server binding.
      if (current?.budget && (!primary || Date.now() - current.boundAt < STEP_BINDING_TTL_MS))
        return current
      return bindNative(event, "", { force: Boolean(current) })
    }

    async function recoverExecutionBudget(sessionID, explicit = false, waitMs = APPROVAL_WAIT_MS) {
      const requestID = randomUUID()
      let result = await call("/internal/runtime/execution-budget", { sessionID, action: "request", requestID, explicit })
      const until = Date.now() + waitMs
      while (!result?.granted && ["pending", "creating"].includes(result?.state) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        result = await call("/internal/runtime/execution-budget", { sessionID, action: "check", requestID })
      }
      if (result?.granted) result = await call("/internal/runtime/execution-budget", { sessionID, action: "apply", requestID })
      return result
    }

    // Returns finishOnly for an exhausted root, or throws a readable error.
    async function gate(sessionID, budget) {
      if (!exhausted(budget)) return false
      // Nothing is left for another completion after the reserve: apply an
      // already-approved grant if one exists, never poll a human form here.
      const reserveSpent = budget.finish_used >= 1
      const recovered = await recoverExecutionBudget(sessionID, false, reserveSpent ? 0 : APPROVAL_WAIT_MS)
      if (recovered?.granted) {
        // The cached step snapshot is exhausted; a retry of this step must re-bind.
        nativeBindings.delete(sessionID)
        return false
      }
      if (reserveSpent) throw budgetError("completion reserve already used")
      return true
    }

    const reserve = (sessionID, requestID, outputLimit, finishOnly) =>
      call("/internal/runtime/request-before", { sessionID, requestID, outputLimit, finishOnly })

    await ctx.session.hook("http.request", async (event) => {
      // Titles, compaction and generation are never budget-gated: they must
      // not poll for approvals or fail a session over the root budget.
      const primary = !event.kind || event.kind === "primary"
      let step = await requestBinding(event, primary)
      let finishOnly = primary ? await gate(event.sessionID, step.budget) : false
      const outputLimit = outputLimitFor(event.model || step.binding.model)
      let requestID = randomUUID()
      let allocation
      try {
        allocation = await reserve(event.sessionID, requestID, outputLimit, finishOnly)
      } catch (error) {
        if (!isBudgetExceeded(error)) throw error
        if (!primary) {
          requests.set(event.request, UNTRACKED)
          warnLimited("auxiliary-budget", `${event.kind} request ran without a budget reservation: ${String(error.message).slice(0, 200)}`)
          return
        }
        if (finishOnly) throw budgetError(error)
        // The step snapshot can predate spending by parallel child sessions:
        // decide once more from a fresh root before failing the turn.
        step = await bindNative(event, "", { force: true })
        finishOnly = await gate(event.sessionID, step.budget)
        requestID = randomUUID()
        try {
          allocation = await reserve(event.sessionID, requestID, outputLimit, finishOnly)
        } catch (retryError) {
          throw isBudgetExceeded(retryError) ? budgetError(retryError) : retryError
        }
      }
      const original = event.request
      const body = await original.clone().json()
      const capped = capRequestBody(
        body,
        allocation.maxOutputTokens,
        finishOnly,
        event.model?.providerID,
        original.url,
      )
      // Qwen can put the entire summary in reasoning, which native compaction ignores.
      if (event.agent === "compaction" && event.model?.providerID === "ollama" && event.model?.id?.startsWith("qwen"))
        capped.reasoning_effort = "none"
      const tracking = { sessionID: event.sessionID, requestID }
      requests.set(original, tracking)
      // An unchanged body is forwarded as-is: no re-serialization of history/media.
      if (!bodyChanged(body, capped)) return
      const headers = new Headers(original.headers)
      headers.delete("content-length")
      const request = new Request(original, { headers, body: JSON.stringify(capped) })
      requests.set(request, tracking)
      event.request = request
    })
    await ctx.session.hook("http.response", async (event) => {
      const tracking = requests.get(event.request)
      if (tracking === UNTRACKED) return
      if (!tracking) {
        // Never fail a finished provider call over bookkeeping.
        warnLimited("lost-request", "provider response lost its request budget identity; usage not recorded")
        return
      }
      requests.delete(event.request)
      event.response = observeUsage(event.response, (usage, status, error) =>
        // Fire-and-forget with a short timeout; never spawn `ensure` here.
        call(
          "/internal/runtime/request-after",
          { ...tracking, usage, status, error },
          { timeoutMs: REQUEST_AFTER_TIMEOUT_MS, repair: false },
        ).catch(() => {
          /* Reservation remains durable/unknown; never replay inference. */
        }),
      )
    })

    function noteContextFailure(sessionID, error) {
      const previous = contextFailures.get(sessionID)
      const wait = Math.min(CONTEXT_BACKOFF_MAX_MS, previous ? previous.wait * 2 : CONTEXT_BACKOFF_MIN_MS)
      remember(contextFailures, sessionID, { wait, until: Date.now() + wait }, 1000)
      warnLimited(
        "context",
        `runtime context unavailable for ${sessionID}; retry after ${Math.round(wait / 1000)}s: ${String(error?.message || error).slice(0, 240)}`,
      )
    }

    function freeze(sessionID, key, text) {
      remember(managedContexts, sessionID, { key, text, at: Date.now() }, 1000)
      return text
    }

    // One envelope per (session, turn): a cache miss waits once, then freezes.
    async function refreshManagedContext(sessionID, model, key, contextClass) {
      const cached = managedContexts.get(sessionID)
      if (cached?.key === key) return cached.text
      if (Date.now() < (contextFailures.get(sessionID)?.until || 0)) return freeze(sessionID, key, "")
      let flight = contextFlights.get(sessionID)
      if (flight?.key !== key) {
        const promise = call(
          "/internal/runtime/context",
          { sessionID, model, contextClass },
          { timeoutMs: Math.max(15000, TIMEOUT) },
        )
          .then((managed) => {
            contextFailures.delete(sessionID)
            return String(managed?.text || "")
          })
          .catch((error) => {
            noteContextFailure(sessionID, error)
            return ""
          })
          .finally(() => {
            if (contextFlights.get(sessionID)?.promise === promise) contextFlights.delete(sessionID)
          })
        flight = { key, promise }
        contextFlights.set(sessionID, flight)
      }
      const text = await raceTimeout(flight.promise, CONTEXT_HOT_PATH_WAIT_MS)
      // A concurrent step of the same turn may have frozen the value already.
      const current = managedContexts.get(sessionID)
      if (current?.key === key) return current.text
      // A late envelope is dropped for this turn instead of changing the prefix.
      return freeze(sessionID, key, text ?? "")
    }

    await ctx.session.hook("context", async (event) => {
      const sessionID = event?.sessionID || ""
      if (!sessionID) return
      event.system ||= []
      const policy = resolveContextPolicy(event)
      const messages = Array.isArray(event.messages) ? event.messages : []
      const index = lastUserIndex(messages)
      const turn = index >= 0 ? messages[index] : undefined
      event.system = event.system.filter((part) => !systemText(part).startsWith(MANAGED_PREFIX))
      // D&D skips generic runtime enrichment, but still needs a fresh execution
      // root for every user turn before the provider request hook runs.
      if (policy.dndMinimalContext) {
        await bindNative(event, turn?.id || "", { messages: event.messages })
        managedContexts.delete(sessionID)
        return
      }
      let binding
      // Unit adapters without native introspection retain the legacy contract;
      // the pinned native runtime always supports catalog and session.get.
      if (ctx.catalog?.model?.list) {
        ;({ binding } = await bindNative(event, turn?.id || "", { messages: event.messages }))
      }
      if (!policy.runtime) {
        managedContexts.delete(sessionID)
        return
      }
      // Compaction and session.generate end with an id-less prompt: no enrichment.
      if (turn && !turn.id) return
      const key = JSON.stringify([
        binding?.directory || "",
        turn?.id || binding?.turnID || "",
        event.model?.providerID || "",
        event.model?.id || "",
        policy.contextClass,
      ])
      const text = await refreshManagedContext(sessionID, event.model, key, policy.contextClass)
      if (turn) {
        // The block rides on the current user message, so the system prompt
        // and earlier history stay byte-identical and provider-cacheable.
        const content = Array.isArray(turn.content) ? turn.content : []
        if (!text && !content.some(isManagedPart)) return
        const next = messages.slice()
        next[index] = withTurnContext(turn, text)
        event.messages = next
      } else if (text) {
        // Adapters without a user message keep the frozen block in system.
        event.system.push({ type: "text", text: `${MANAGED_PREFIX}${text}` })
      }
    })

    if (ctx.tool.transform)
      await ctx.tool.transform((tools) => {
        tools.add({
          name: "runtime_artifact_read",
          description:
            "Read a range or search a large tool-output artifact from this session. Offsets and limits are characters.",
          input: {
            type: "object",
            additionalProperties: false,
            required: ["artifactID"],
            properties: {
              artifactID: { type: "string" },
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 16000 },
              query: { type: "string", maxLength: 500 },
            },
          },
          options: { pinned: true, codemode: false },
          execute: async (input, context) => {
            const result = await call("/internal/runtime/artifact", {
              ...input,
              sessionID: context.sessionID,
            })
            return { content: JSON.stringify(result), metadata: { artifactID: input.artifactID } }
          },
        })
        tools.add({
          name: "execution_budget",
          description: "Inspect or explicitly request one bounded execution-budget extension. Every grant requires a fresh native human approval form.",
          input: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["status", "request"] } } },
          options: { pinned: true, codemode: false },
          execute: async (input, context) => {
            const sessionID = String(context?.sessionID || "")
            const result = input?.action === "request"
              ? await recoverExecutionBudget(sessionID, true)
              : await call("/internal/runtime/execution-budget", { sessionID, action: "status" })
            return { content: JSON.stringify(result, null, 1), metadata: result }
          },
        })
        // Adaptive context budget: the model can inspect and request expansion of
        // its session working budget, bounded by the real model limit and user policy.
        tools.add({
          name: "context_budget",
          description:
            "Inspect or request a larger session working-context budget. action=status returns used/working/base/ceiling/model-limit/policy-max tokens; action=request waits only for a fresh human approval of this exact bounded target, never switches model or tariff.",
          input: {
            type: "object",
            required: ["action"],
            properties: {
              action: {
                type: "string",
                enum: ["status", "request"],
                description: "status = inspect the budget, request = ask for more working context",
              },
              tokens: {
                type: "number",
                description: "Desired total working context in tokens (action=request)",
              },
              reason: {
                type: "string",
                description: "Why more working context is needed (action=request)",
              },
            },
          },
          options: { pinned: true, codemode: false },
          execute: async (input, context) => {
            const result = await call("/internal/runtime/context-budget", {
              sessionID: String(context?.sessionID || ""),
              action: String(input?.action || "status"),
              tokens: input?.tokens,
              reason: input?.reason,
            })
            if (!result || result.ok === false)
              throw new Error(String(result?.error || "context budget unavailable"))
            return { content: JSON.stringify(result, null, 1), metadata: result }
          },
        })
      })

    await ctx.tool.hook("execute.before", async (event) => {
      const c = contextOf(event)
      const controlTool = ["context_budget", "execution_budget"].includes(event.tool?.name || event.tool)
      const payload = {
        ...c,
        tool: event.tool,
        input: event.input,
        countBudget: Boolean(ctx.catalog?.model?.list && !controlTool),
      }
      let decision
      try {
        decision = await call("/internal/runtime/tool-before", payload)
      } catch (error) {
        if (!payload.countBudget || !isBudgetExceeded(error)) throw error
        // After the completion reserve only an already-approved grant helps;
        // do not hold the tool call for a human form.
        const recovered = await recoverExecutionBudget(
          c.sessionID,
          false,
          RESERVE_SPENT.test(String(error?.message)) ? 0 : APPROVAL_WAIT_MS,
        )
        if (!recovered?.granted) throw budgetError(error)
        decision = await call("/internal/runtime/tool-before", payload)
      }
      if (decision?.allow === false)
        throw new Error(decision.reason || "Tool denied by server runtime")
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const c = contextOf(event)
      try {
        const decision = await call("/internal/runtime/tool-after", {
          ...c,
          tool: event.tool,
          result: event.result,
          output: event.output,
          outputPaths: event.outputPaths,
          status: event.status,
        })
        if (decision?.replace) {
          // Native ToolResult is a content/metadata envelope, not an arbitrary
          // JSON object. Preserve its contract so the model sees the preview
          // rather than the literal string "undefined".
          const content = JSON.stringify(decision.result)
          event.result = {
            ...(event.result && typeof event.result === "object" ? event.result : {}),
            content,
            metadata: { ...event.result?.metadata, artifactID: decision.result.artifactID },
          }
          if ("output" in event) event.output = content
        }
      } catch {
        // Post-processing cannot turn an already successful tool into a failed tool.
      }
    })

    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before", async (event) => {
        event.env ||= {}
        stripSecrets(event.env)
        const decision = await call("/internal/runtime/shell", {
          ...contextOf(event),
          command: event.command,
          shell: event.shell,
        })
        if (decision?.command) event.command = decision.command
        if (decision?.cwd) event.cwd = decision.cwd
        if (decision?.shell) event.shell = decision.shell
        Object.assign(event.env, decision?.env || {})
        for (const name of RESERVED_SECRETS) delete event.env[name]
      })
    }
  },
}
