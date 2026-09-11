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
