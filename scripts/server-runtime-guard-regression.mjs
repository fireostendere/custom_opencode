import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { register } from "node:module"

register("./opencode-plugin-stub-hooks.mjs", import.meta.url)
process.env.OPENCODE_RUNTIME_PLUGIN_TOKEN = "test-token"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = readFileSync(resolve(root, "config/plugins/server-runtime-guard.js"), "utf8")
assert.ok(!source.includes("/internal/runtime/tool-cache"))

const calls = []
let contextFailure = false
let catalogCalls = 0
let recoveredBudget = false
let delayedContextBudget = false
let contextBudgetAborted = false
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (contextFailure && String(url).endsWith('/internal/runtime/context'))
    throw new DOMException('The operation timed out.', 'TimeoutError')
  calls.push({ url: String(url), payload: JSON.parse(init.body) })
  if (delayedContextBudget && String(url).endsWith('/internal/runtime/context-budget'))
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response(JSON.stringify({ granted: false, state: 'pending' }), { status: 200, headers: { 'content-type': 'application/json' } })),
        2100,
      )
      init.signal.addEventListener('abort', () => {
        contextBudgetAborted = true
        clearTimeout(timer)
        reject(init.signal.reason)
      }, { once: true })
    })
  if (String(url).endsWith('/internal/runtime/execution-budget'))
    return new Response(JSON.stringify({ granted: recoveredBudget, state: recoveredBudget ? 'granted' : 'pending' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const exhausted = recoveredBudget && String(url).endsWith('/internal/runtime/bind')
  return new Response(
    JSON.stringify({
      maxOutputTokens: 1024,
      tools: exhausted ? 10 : 0,
      calls: exhausted ? 10 : 0,
      output_reserved: 0,
      started_at: Date.now(),
      limits: { toolAttempts: 10, calls: 10, outputTokens: 4096, finishTokens: 256, seconds: 60 },
      command: "wrapped",
      cwd: "/repo",
      shell: "/bin/sh",
      env: {
        OPENCODE_SERVER_PASSWORD: "must-not-be-regranted",
        OPENCODE_RUNTIME_PLUGIN_TOKEN: "must-not-be-regranted",
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
}

try {
  const plugin = (
    await import(pathToFileURL(resolve(root, "config/plugins/server-runtime-guard.js")).href)
  ).default
  const hooks = {}
  const tools = []
  const ctx = {
    session: {
      hook: async (name, callback) => {
        hooks[`session:${name}`] = callback
      },
    },
    catalog: {
      model: {
        list: async () => {
          catalogCalls += 1
          throw new Error('catalog unavailable')
        },
      },
    },
    tool: {
      hook: async (name, callback) => {
        hooks[`tool:${name}`] = callback
      },
      transform: async (fn) => {
        await fn({
          add: (tool) => tools.push(tool),
        })
      },
    },
    shell: {
      hook: async (name, callback) => {
        hooks[`shell:${name}`] = callback
      },
    },
  }
  await plugin.setup(ctx)
  for (const [url, expected] of [
    ["https://chatgpt.com/backend-api/codex/responses", undefined],
    ["https://api.openai.com/v1/responses", 1024],
  ]) {
    const requestEvent = {
      sessionID: "ses_request_budget",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      request: new Request(url, {
        method: "POST",
        body: JSON.stringify({ input: [], max_output_tokens: 4096 }),
      }),
    }
    await hooks["session:http.request"](requestEvent)
    assert.equal((await requestEvent.request.json()).max_output_tokens, expected)
  }
  assert.equal(catalogCalls, 1, 'catalog refresh must be cached across hooks')
  recoveredBudget = true
  const recoveredRequest = {
    sessionID: 'ses_recovered_budget',
    model: { providerID: 'openai', id: 'gpt-5.6-luna' },
    request: new Request('https://api.openai.com/v1/responses', {
      method: 'POST', body: JSON.stringify({ input: [], tools: [{ type: 'function', name: 'ordinary_tool' }], max_output_tokens: 4096 }),
    }),
  }
  await hooks['session:http.request'](recoveredRequest)
  assert.deepEqual((await recoveredRequest.request.json()).tools, [{ type: 'function', name: 'ordinary_tool' }], 'approved extension must restore ordinary tools')
  recoveredBudget = false
  // Compaction consumes final text; Qwen can otherwise finish in reasoning only.
  for (const [agent, providerID, id, expected] of [
    ['compaction', 'ollama', 'qwen3.8-heretic:27b', 'none'],
    ['compaction', 'ollama', 'qwen3.8:27b', 'none'],
    ['build', 'ollama', 'qwen3.8-heretic:27b', 'high'],
    ['compaction', 'ollama', 'gpt-oss:20b', 'high'],
    ['compaction', 'other', 'qwen3.8:27b', 'high'],
  ]) {
    const event = {
      sessionID: 'ses_compaction', agent, model: { providerID, id },
      request: new Request('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Summarize the Cedar project.' }], max_tokens: 8192, reasoning_effort: 'high' }),
      }),
    }
    await hooks['session:http.request'](event)
    const body = await event.request.json()
    assert.equal(body.reasoning_effort, expected, `${agent}/${providerID}/${id}`)
    assert.equal(body.max_tokens, 1024, 'compaction must retain the output budget cap')
  }
  const budgetTool = tools.find((tool) => tool.name === 'context_budget')
  assert.ok(budgetTool, 'context_budget tool registered')
  assert.deepEqual(budgetTool.input.properties.action.enum, ['status', 'request'])
  const budgetOutput = await budgetTool.execute({ action: 'request', tokens: 120000, reason: 'large refactor' }, { sessionID: 'ses_budget' })
  const budgetCall = calls.find((entry) => entry.url.endsWith('/internal/runtime/context-budget'))
  assert.equal(budgetCall.payload.sessionID, 'ses_budget')
  assert.equal(budgetCall.payload.action, 'request')
  assert.equal(budgetCall.payload.tokens, 120000)
  assert.ok(budgetOutput.content && typeof budgetOutput.content === 'string')
  delayedContextBudget = true
  const waitedAt = Date.now()
  await budgetTool.execute({ action: 'request', tokens: 121000, reason: 'wait for human' }, { sessionID: 'ses_budget_wait' })
  assert.ok(Date.now() - waitedAt >= 2000, 'context request must outlive the normal 1.8s control timeout')
  assert.equal(contextBudgetAborted, false, 'fresh human approval wait must not be aborted early')
  delayedContextBudget = false
  const event = {
    sessionID: "ses_shell_owner",
    cwd: "/repo",
    command: "printf ok",
    shell: "/bin/sh",
    env: {
      SAFE_VALUE: "ok",
      GEMINI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret-too",
      OPENCODE_SERVER_PASSWORD: "web-secret",
      OPENCODE_BACKEND_PASSWORD: "backend-secret",
      OPENCODE_RUNTIME_PLUGIN_TOKEN: "internal-secret",
      OPENCODE_OPENAI_REFRESH: "oauth-secret",
      OPENCODE_OPENAI_ACCESS: "access-secret",
      OPENCODE_ZEN_KEY: "zen-secret",
      OPENCODE_GO_KEY: "go-secret",
      OPENCODE_WEB_PORT: "4098",
    },
  }
  await hooks["shell:create.before"](event)
  const shellCall = calls.find((entry) => entry.url.endsWith("/internal/runtime/shell"))
  assert.ok(shellCall, "shell policy call recorded")
  assert.equal(shellCall.payload.sessionID, "ses_shell_owner")
  assert.equal(event.env.SAFE_VALUE, "ok")
  assert.ok(
    !Object.hasOwn(event.env, "GEMINI_API_KEY") && !Object.hasOwn(event.env, "GOOGLE_API_KEY"),
  )
  for (const name of [
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_BACKEND_PASSWORD",
    "OPENCODE_RUNTIME_PLUGIN_TOKEN",
    "OPENCODE_OPENAI_REFRESH",
    "OPENCODE_OPENAI_ACCESS",
    "OPENCODE_ZEN_KEY",
    "OPENCODE_GO_KEY",
  ])
    assert.ok(!Object.hasOwn(event.env, name), `${name} leaked to shell`)
  assert.equal(event.env.OPENCODE_WEB_PORT, "4098")
  assert.equal(event.command, "wrapped")

  // Runtime context is an additive enrichment. A slow index/RAG refresh must
  // leave native context and the provider request usable.
  contextFailure = true
  const contextEvent = {
    sessionID: 'ses_context_timeout',
    model: { providerID: 'openai', id: 'gpt-5.6-luna' },
    system: [{ type: 'text', text: 'Server runtime context (deduplicated, budgeted, checkpoint/RAG/repo aware):\nprevious snapshot' }],
  }
  await hooks['session:context'](contextEvent)
  assert.equal(contextEvent.system[0].text, 'Server runtime context (deduplicated, budgeted, checkpoint/RAG/repo aware):\nprevious snapshot')
  const requestAfterContextTimeout = {
    sessionID: 'ses_context_timeout',
    model: contextEvent.model,
    request: new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [], max_output_tokens: 4096 }),
    }),
  }
  await hooks['session:http.request'](requestAfterContextTimeout)
  assert.equal((await requestAfterContextTimeout.request.json()).max_output_tokens, 1024)
  contextFailure = false
  console.log(
    "Server runtime guard regression OK: session-scoped shell policy, secret scrub, additive context timeout",
  )
} finally {
  globalThis.fetch = originalFetch
}
