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
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), payload: JSON.parse(init.body) })
  return new Response(
    JSON.stringify({
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
  const budgetTool = tools.find((tool) => tool.name === 'context_budget')
  assert.ok(budgetTool, 'context_budget tool registered')
  assert.deepEqual(budgetTool.input.properties.action.enum, ['status', 'request'])
  const budgetOutput = await budgetTool.execute({ action: 'request', tokens: 120000, reason: 'large refactor' }, { sessionID: 'ses_budget' })
  const budgetCall = calls.find((entry) => entry.url.endsWith('/internal/runtime/context-budget'))
  assert.equal(budgetCall.payload.sessionID, 'ses_budget')
  assert.equal(budgetCall.payload.action, 'request')
  assert.equal(budgetCall.payload.tokens, 120000)
  assert.ok(budgetOutput.content && typeof budgetOutput.content === 'string')
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
  console.log(
    "Server runtime guard regression OK: session-scoped shell policy, secret scrub, no stale pre-exec cache",
  )
} finally {
  globalThis.fetch = originalFetch
}
