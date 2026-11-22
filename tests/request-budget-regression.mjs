import assert from "node:assert/strict"
import {
  capRequestBody,
  normalizeUsage,
  observeUsage,
} from "../config/plugins/tui/lib/request-budget.js"
const cases = [
  [{ messages: [], max_tokens: 4096 }, "fixture", "max_tokens"],
  [{ messages: [], max_completion_tokens: 4096 }, "openai", "max_completion_tokens"],
  [{ input: [], max_output_tokens: 4096 }, "openai", "max_output_tokens"],
]
for (const [body, provider, key] of cases) {
  const copy = JSON.stringify(body),
    capped = capRequestBody(body, 1024, false, provider)
  assert.equal(capped[key], 1024)
  assert.equal(JSON.stringify(body), copy)
}
assert.equal(
  capRequestBody({ contents: [], generationConfig: { maxOutputTokens: 4096 } }, 1024)
    .generationConfig.maxOutputTokens,
  1024,
)
assert.equal(capRequestBody({ messages: [], max_tokens: 500 }, 1024).max_tokens, 500)
// ChatGPT rejects the field even when the client already supplied it.
const codexURL = "https://chatgpt.com/backend-api/codex/responses"
const bare = capRequestBody({ input: [] }, 1024, false, "openai", codexURL)
assert.equal("max_output_tokens" in bare, false)
const codexBody = { input: [], max_output_tokens: 4096, tools: [{}], tool_choice: "auto" }
const codexCapped = capRequestBody(codexBody, 1024, true, "openai", codexURL)
assert.equal("max_output_tokens" in codexCapped, false)
assert.equal(codexCapped.tools, undefined)
assert.equal(codexCapped.tool_choice, undefined)
assert.equal(codexBody.max_output_tokens, 4096)
for (const url of [
  "",
  "https://api.openai.com/v1/responses",
  "https://chatgpt.com.example/backend-api/codex/responses",
  "https://chatgpt.com/other/responses",
])
  assert.equal(capRequestBody({ input: [] }, 1024, false, "openai", url).max_output_tokens, 1024)
assert.throws(() => capRequestBody({ opaque: true }, 1024), /Unsupported/)
assert.equal(
  capRequestBody({ messages: [], tools: [{}], tool_choice: "auto" }, 1024, true).tools,
  undefined,
)
const reasoning = normalizeUsage({
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 7 },
  },
})
assert.equal(reasoning.output, 20)
assert.equal(reasoning.reasoning, 7)
assert.equal(
  normalizeUsage({ usageMetadata: { candidatesTokenCount: 20, thoughtsTokenCount: 7 } }).output,
  27,
)
let result
const bytes =
  "data: " +
  JSON.stringify({ usage: { input_tokens: 100 } }) +
  "\n\ndata: " +
  JSON.stringify({ usage: { output_tokens: 20 } }) +
  "\n\ndata: [DONE]\n\n"
const response = observeUsage(
  new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
  async (...args) => {
    result = args
  },
)
assert.equal(await response.text(), bytes)
assert.deepEqual(result[0], { input: 100, output: 20 })
const noUsage = observeUsage(new Response('data: {"text":"answer"}\n\n'), async (...args) => {
  result = args
})
await noUsage.text()
assert.equal(result[0], null)
// Streaming fragmentation is not a license to truncate or modify provider data.
const encoder = new TextEncoder()
const fragmented = new ReadableStream({
  start(controller) {
    for (const char of bytes) controller.enqueue(encoder.encode(char))
    controller.close()
  },
})
const observed = observeUsage(new Response(fragmented), async (...args) => {
  result = args
})
assert.equal(await observed.text(), bytes)
assert.equal(result[0].output, 20)
console.log(
  "PASS: four provider wire formats, lower-limit preservation, reasoning, unknown usage and byte-exact fragmented streaming",
)

assert.equal(
  capRequestBody({ messages: [], max_tokens: 500 }, 1024, false, "openai").max_tokens,
  500,
)
// A native SDK is allowed to cancel after the terminal event without asking
// for EOF. The request still gets exactly one durable usage record.
let notifications = 0
const ending = new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode(bytes))
  },
})
const tracked = observeUsage(new Response(ending), async (...args) => {
  notifications++
  result = args
})
const reader = tracked.body.getReader()
await reader.read()
await reader.cancel()
assert.equal(notifications, 1)
assert.equal(result[0].output, 20)
console.log("PASS: early SDK cancellation after terminal event persists usage exactly once")

// Escape must reach the provider before a slow ledger write completes.
let providerCancelled = false
let releaseLedger
const ledger = new Promise(resolve => { releaseLedger = resolve })
const slowLedger = observeUsage(new Response(new ReadableStream({
  cancel() { providerCancelled = true },
})), () => ledger)
const cancelling = slowLedger.body.cancel("Escape")
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(providerCancelled, true, "usage accounting must not delay provider cancellation")
await Promise.race([cancelling, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel waited for ledger')), 100))])
releaseLedger()
await cancelling
console.log("PASS: cancellation reaches provider while ledger is still pending")

// The final SSE chunk and EOF reach the SDK while the ledger write is pending.
{
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let recorded = null
  const held = observeUsage(new Response(bytes), async (usage) => { await pending; recorded = usage })
  const delivered = await Promise.race([
    held.text(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("terminal chunk waited for the ledger")), 200)),
  ])
  assert.equal(delivered, bytes)
  assert.equal(recorded, null, "the ledger write is still in flight")
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(recorded.output, 20)
  // A rejecting ledger never surfaces into the provider stream.
  const failing = observeUsage(new Response(bytes), async () => { throw new Error("ledger down") })
  assert.equal(await failing.text(), bytes)
  console.log("PASS: terminal bytes are forwarded without waiting for usage accounting")
}

// Copy-on-write capping: no deep clone of history/media, unchanged fields stay identical.
{
  const { bodyChanged } = await import("../config/plugins/tui/lib/request-budget.js")
  const media = { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(100000) }
  const body = { input: [{ role: "user", content: [media] }], max_output_tokens: 512, reasoning: { effort: "high" } }
  const capped = capRequestBody(body, 1024, false, "openai", "https://api.openai.com/v1/responses")
  assert.equal(capped.input, body.input, "history/media must be shared, not cloned")
  assert.equal(capped.reasoning, body.reasoning)
  assert.equal(bodyChanged(body, capped), false, "a body inside the allocation is unchanged")
  assert.equal(bodyChanged(body, capRequestBody(body, 256, false, "openai", "https://api.openai.com/v1/responses")), true)
  assert.equal(bodyChanged(body, capRequestBody(body, 1024, true, "openai", "https://api.openai.com/v1/responses")), false, "no tools to strip")
  const thinking = { messages: [], max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 4000 } }
  const thinkingCapped = capRequestBody(thinking, 1024)
  assert.equal(thinkingCapped.thinking.budget_tokens, 1023)
  assert.equal(thinking.thinking.budget_tokens, 4000, "nested fields are copied, never mutated")
  const gemini = { contents: [], generationConfig: { maxOutputTokens: 512, temperature: 0 } }
  assert.equal(capRequestBody(gemini, 1024).generationConfig, gemini.generationConfig)
  const geminiCapped = capRequestBody(gemini, 100)
  assert.deepEqual(geminiCapped.generationConfig, { maxOutputTokens: 100, temperature: 0 })
  assert.equal(gemini.generationConfig.maxOutputTokens, 512)
  console.log("PASS: copy-on-write capping shares payloads and reports unchanged bodies")
}
