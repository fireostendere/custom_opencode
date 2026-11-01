#!/usr/bin/env node
// Autonomous bounded JSONL transport. No OpenCode session, tools or game access.
import { pathToFileURL } from 'node:url'
import { fetchDecision, decisionBody, decisionResult } from '../config/plugins/decisions.js'
import { serviceSetting } from '../config/plugins/config-manager.js'

export class DecisionsWorker {
  constructor({ apiKey, maxCalls = 64, timeoutMs = 4000, fetcher = fetchDecision } = {}) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 256 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
      throw Error('Bounded pre-match call and deadline limits required')
    this.apiKey = apiKey
    this.maxCalls = maxCalls
    this.timeoutMs = timeoutMs
    this.fetcher = fetcher
    this.calls = 0
    this.seen = new Set()
    this.suspended = false
  }

  async handle(packet) {
    const id = packet?.id
    if (!packet || Object.keys(packet).sort().join(',') !== 'id,input,questions' || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      return { id: null, error: 'INVALID_REQUEST', suspended: this.suspended }
    let body
    try { body = decisionBody({ input: packet.input, questions: packet.questions }) }
    catch { return { id, error: 'INVALID_REQUEST', suspended: this.suspended } }
    if (Buffer.byteLength(JSON.stringify(body)) > 32768)
      return { id, error: 'CONTEXT_OVERFLOW', suspended: this.suspended }
    if (!this.apiKey?.trim() || this.apiKey === 'CHANGE_ME')
      return { id, error: 'API_KEY_UNAVAILABLE', suspended: this.suspended }
    if (this.suspended || this.calls >= this.maxCalls || this.seen.has(id))
      return { id, error: 'LANE_UNAVAILABLE', suspended: this.suspended }
    this.seen.add(id)
    this.calls++
    let data
    try {
      data = await this.fetcher({ input: packet.input, questions: packet.questions }, {
        apiKey: this.apiKey, signal: AbortSignal.timeout(this.timeoutMs) })
      if (data?.model !== body.model) throw Error('Unexpected model')
      const usage = data?.usage
      if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
          !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0)
        throw Error('Unknown final usage')
      const result = decisionResult(data, body.questions)
      return { id, result, suspended: false }
    } catch {
      // Local timeout/exit does not prove remote termination or zero billing.
      this.suspended = true
      const usage = data?.usage
      return { id, error: 'PROVIDER_FAILED', suspended: true,
        usage: usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 &&
          Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0
          ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : null }
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--max-calls')) throw Error('Usage: decisions-worker.mjs [--max-calls 1..256]')
  const worker = new DecisionsWorker({ apiKey: serviceSetting('OPENAI_DECISIONS_API_KEY'), maxCalls: args.length ? Number(args[1]) : 64 })
  let buffer = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 65536) throw Error('Bounded JSONL input required')
    let end
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end)
      buffer = buffer.subarray(end + 1)
      let reply
      try { reply = await worker.handle(JSON.parse(line.toString('utf8'))) }
      catch { reply = { id: null, error: 'INVALID_REQUEST', suspended: worker.suspended } }
      process.stdout.write(JSON.stringify(reply) + '\n')
    }
  }
  if (buffer.length) throw Error('Incomplete JSONL input')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write('Decisions worker stopped; no request was retried.\n'); process.exitCode = 1 })
