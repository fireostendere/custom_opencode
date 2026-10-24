import { randomUUID } from 'node:crypto'
import { serviceSetting } from './config-manager.js'
import { runtimeCall } from './server-runtime-guard.js'
import { boundedText } from './tui/lib/hardware-core.js'
import { normalizeUsage } from './tui/lib/request-budget.js'

const ENDPOINT = 'https://api.openai.com/v1/decisions'
const MODEL = 'gpt-6-luna'
const MAX_BYTES = 1024 * 1024
const string = { type: 'string', minLength: 1, maxLength: 4000 }
const option = { type: 'object', additionalProperties: false, required: ['value'], properties: {
  value: { type: ['string', 'boolean'], maxLength: 4000 }, description: string,
} }
const level = { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: {
  label: string, description: string,
} }
const INPUT = { type: 'object', additionalProperties: false, required: ['input', 'questions'], properties: {
  // shortcut: text evidence only; add native image/conversation parts when a caller needs them.
  input: { type: 'string', minLength: 1, maxLength: 200000, description: 'Shared evidence as text or serialized JSON; send only evidence needed for these questions.' },
  questions: { type: 'array', minItems: 1, maxItems: 400, items: {
    type: 'object', additionalProperties: false, required: ['type', 'name', 'instructions'], properties: {
      type: { type: 'string', enum: ['predicate', 'choice', 'score'] },
      name: { type: 'string', minLength: 1, maxLength: 64 }, instructions: string,
      choices: { type: 'array', minItems: 2, maxItems: 255, items: option, description: 'Required only for choice; values must be distinct.' },
      levels: { type: 'array', minItems: 2, maxItems: 10, items: level, description: 'Required only for score; order from lowest to highest.' },
    },
  } },
} }

function text(value, maximum = 4000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}
function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
}

export function decisionBody(input) {
  if (!object(input, ['input', 'questions']) || !text(input.input, 200000) || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 400)
    throw Error('Decisions requires text input and 1–400 questions')
  const names = new Set()
  for (const q of input.questions) {
    const fields = ['type', 'name', 'instructions', ...(q?.type === 'choice' ? ['choices'] : q?.type === 'score' ? ['levels'] : [])]
    if (!object(q, fields) || !['predicate', 'choice', 'score'].includes(q.type) || !text(q.name, 64) || names.has(q.name) || !text(q.instructions))
      throw Error('Each decision needs a supported type, unique name and instructions; choices/levels belong only to their question type')
    names.add(q.name)
    if (q.type === 'choice' && (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 255 ||
        q.choices.some(c => !object(c, ['value', 'description']) || !['string', 'boolean'].includes(typeof c.value) || (typeof c.value === 'string' && c.value.length > 4000) || (c.description !== undefined && !text(c.description))) ||
        new Set(q.choices.map(c => c.value)).size !== q.choices.length))
      throw Error('Choice needs 2–255 distinct string/boolean values with optional descriptions')
    if (q.type === 'score' && (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10 ||
        q.levels.some(l => !object(l, ['label', 'description']) || !text(l.label) || !text(l.description))))
      throw Error('Score needs 2–10 ordered levels, each with a label and description')
  }
  const body = { model: MODEL, input: input.input, questions: input.questions }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw Error('Decisions request exceeds 1 MiB')
  return body
}

const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export function decisionResult(data, questions) {
  if (!data || typeof data.model !== 'string' || !Array.isArray(data.answers) || data.answers.length !== questions.length)
    throw Error('Invalid Decisions response')
  for (const [i, answer] of data.answers.entries()) {
    const q = questions[i]
    if (!answer || answer.name !== q.name || (answer.type !== q.type && answer.type !== 'refusal')) throw Error('Decisions answer does not match its question')
    if (answer.type === 'refusal') continue
    if (q.type === 'predicate') {
      if (!probability(answer.probability)) throw Error('Invalid Decisions probability')
      continue
    }
    const values = q.type === 'choice' ? q.choices.map(c => c.value) : q.levels.map((_, index) => index)
    const probabilities = answer.probabilities
    if (!probability(answer.confidence) || !Array.isArray(probabilities) || probabilities.length !== values.length ||
        probabilities.some(p => !p || !values.includes(p.value) || !probability(p.probability)) || new Set(probabilities.map(p => p.value)).size !== values.length)
      throw Error('Invalid Decisions distribution')
    if (q.type === 'choice' ? !values.includes(answer.choice) : !(typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= values.length - 1))
      throw Error('Decisions returned a value outside the supplied choices/levels')
  }
  return { model: data.model, answers: data.answers, usage: data.usage }
}

export default {
  id: 'custom.decisions',
  async setup(ctx) {
    const controller = new AbortController()
    const registration = await ctx.tool.transform(tools => tools.add({
      name: 'decisions',
      description: 'OpenAI Decisions API: fast bounded judgments over supplied text/JSON evidence. Batch independent predicate (probability), choice (fixed options) or score (ordered levels) questions. Returns typed answers, confidence and usage, including explicit refusals. Advisory only: never grants permissions, runs actions, replaces game-engine rolls or verifies facts absent from the evidence. Requires OPENAI_DECISIONS_API_KEY; billed separately from ChatGPT.',
      input: INPUT, options: { pinned: true, codemode: false },
      execute: async (input, context) => {
        const body = decisionBody(input)
        const apiKey = serviceSetting('OPENAI_DECISIONS_API_KEY')?.trim()
        if (!apiKey || apiKey === 'CHANGE_ME') throw Error('Set OPENAI_DECISIONS_API_KEY in custom_opencode/.env and run scripts/install.sh. ChatGPT OAuth cannot authenticate Decisions.')
        await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: 'tool', messageID: context.messageID, id: context.id }, action: 'decisions', resources: [ENDPOINT] })
        const signals = [controller.signal, AbortSignal.timeout(15000)]
        const nativeSignal = context.signal || context.abortSignal
        if (nativeSignal instanceof AbortSignal) signals.push(nativeSignal)
        const signal = AbortSignal.any(signals)
        signal.throwIfAborted()
        const started = Date.now()
        let tracking, usage, status, failure
        try {
          if (process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN || process.env.OPENCODE_SERVER_PASSWORD) {
            const requestID = randomUUID()
            // Decisions has no generated output; reserve one token on the existing request ledger.
            await runtimeCall('/internal/runtime/request-before', { sessionID: context.sessionID, requestID, outputLimit: 1, finishOnly: false })
            tracking = { sessionID: context.sessionID, requestID }
          }
          signal.throwIfAborted()
          let response
          try {
            response = await fetch(ENDPOINT, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body), signal })
          } catch {
            throw Error(signal.aborted ? 'Decisions request cancelled or timed out' : 'Decisions network request failed')
          }
          status = response.status
          if (!response.ok) {
            await response.body?.cancel()
            throw Error(`OpenAI Decisions HTTP ${status}; check API key, access, credits or rate limits. No automatic retry.`)
          }
          let data
          try { data = JSON.parse(await boundedText(response, MAX_BYTES)) }
          catch { throw Error('Invalid or oversized Decisions response') }
          usage = normalizeUsage({ usage: data.usage })
          const result = decisionResult(data, body.questions)
          return { content: JSON.stringify(result), metadata: { model: result.model, usage: result.usage, elapsedMs: Date.now() - started } }
        } catch (error) {
          failure = 'Decisions request failed'
          throw error
        } finally {
          if (tracking) void runtimeCall('/internal/runtime/request-after', { ...tracking, usage: usage ?? null, status: status ?? null, error: failure ?? null }, { timeoutMs: 5000, repair: false }).catch(() => {})
        }
      },
    }))
    return async () => { controller.abort(); await registration.dispose() }
  },
}
