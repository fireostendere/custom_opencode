// Behavioral regression for the always-visible Build plan plugin.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { register } from "node:module"

register("./opencode-plugin-stub-hooks.mjs", import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const planDirectory = mkdtempSync(join(tmpdir(), "custom-opencode-visible-plan-"))
process.env.OPENCODE_PLAN_DIRECTORY = planDirectory
process.env.OPENCODE_VISIBLE_PLAN = "strict"

try {
  const source = readFileSync(resolve(root, "config/plugins/visible-plan.js"), "utf8")
  const plugin = (
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  ).default
  assert.equal(plugin.id, "custom.visible-plan")

  let planTool
  const hooks = {}
  const registration = () => ({ dispose: async () => {} })
  const ctx = {
    tool: {
      transform: async (callback) => {
        callback({
          add: (tool) => {
            planTool = tool
          },
        })
        return registration()
      },
      hook: async (name, callback) => {
        hooks[`tool:${name}`] = callback
        return registration()
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[`session:${name}`] = callback
        return registration()
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  assert.equal(planTool.name, "plan_update")
  assert.equal(planTool.options.pinned, true)
  assert.equal(planTool.options.codemode, false)

  const contextHook = hooks["session:context"]
  const beforeHook = hooks["tool:execute.before"]
  const context = {
    sessionID: "ses_visible_plan",
    agent: "build",
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Измени проект" }] }],
  }
  await contextHook(context)
  assert.equal(context.system.length, 1)
  assert.match(context.system[0].text, /private reasoning/)
  await contextHook(context)
  assert.equal(context.system.length, 1, "policy must not duplicate inside one context")

  await beforeHook({ sessionID: context.sessionID, messageID: "msg_1", tool: "read" })
  await assert.rejects(
    async () => beforeHook({ sessionID: context.sessionID, messageID: "msg_1", tool: "edit" }),
    /plan_update/,
  )

  const result = await planTool.execute(
    {
      title: "Видимый план",
      todos: [
        { content: "Проверить текущий поток", status: "completed" },
        { content: "Подключить публикацию", status: "in_progress" },
        { content: "Запустить проверки", status: "pending" },
      ],
    },
    { sessionID: context.sessionID, agent: "build", messageID: "msg_1" },
  )
  assert.match(result.content, /3 items/)
  await beforeHook({ sessionID: context.sessionID, messageID: "msg_2", tool: "edit" })

  const target = join(planDirectory, "ses_visible_plan-plan.md")
  assert.equal(
    readFileSync(target, "utf8"),
    "# Видимый план\n\n- [x] Проверить текущий поток\n- [>] Подключить публикацию\n- [ ] Запустить проверки\n",
  )
  assert.equal(statSync(target).mode & 0o777, 0o600)

  const nextTurn = {
    ...context,
    system: [],
    messages: [
      ...context.messages,
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "Продолжай" }] },
    ],
  }
  await contextHook(nextTurn)
  await assert.rejects(
    async () => beforeHook({ sessionID: context.sessionID, messageID: "msg_3", tool: "shell" }),
    /plan_update/,
    "a new user turn must publish its own plan before state-changing tools",
  )
  const planContext = {
    ...context,
    sessionID: "ses_plan",
    agent: "plan",
    system: [],
    messages: context.messages,
  }
  await contextHook(planContext)
  assert.match(planContext.system[0].text, /complex or risky multi-step/)
  await beforeHook({ sessionID: planContext.sessionID, messageID: "msg_4", tool: "edit" })
  await beforeHook({
    sessionID: "ses_subagent",
    agent: "role-builder",
    messageID: "msg_5",
    tool: "edit",
  })
  await assert.rejects(
    planTool.execute(
      { title: "Bad", todos: [] },
      { sessionID: "ses_bad", agent: "build", messageID: "msg_6" },
    ),
    /1-7/,
  )
  await cleanup()
  console.log(
    "Visible plan regression OK: pinned tool, system policy, mutation gate, atomic session plan",
  )
} finally {
  rmSync(planDirectory, { recursive: true, force: true })
}
