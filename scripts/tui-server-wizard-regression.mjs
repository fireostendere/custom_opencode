// Integration regression for the TUI server wizard (/server command).
import assert from "node:assert/strict"
import { register } from "node:module"

register("./opencode-plugin-stub-hooks.mjs", import.meta.url)

// Watchdog to prevent hangs (ref'd so it keeps event loop alive)
const watchdog = setTimeout(() => {
  console.error("regression timed out — runaway wizard loop")
  process.exit(1)
}, 20000)

const root = new URL("../", import.meta.url)
const commandModule = await import(new URL("config/plugins/tui/lib/server-command.js", root).href)

// --- parseServerCommand tests ---
assert.deepEqual(commandModule.parseServerCommand("/server"), { type: "wizard" })
assert.deepEqual(commandModule.parseServerCommand("/SERVER status"), { type: "status" })
assert.deepEqual(commandModule.parseServerCommand("/server blah"), { type: "error", message: "Use /server or /server status" })
assert.equal(commandModule.parseServerCommand("ordinary text"), null)

// --- Fake control and context ---
function createFakeContext(initialState) {
  const state = {
    deployed: initialState?.deployed ?? false,
    running: initialState?.running ?? false,
    defaultEnabled: initialState?.defaultEnabled ?? false,
    host: initialState?.host ?? "127.0.0.1",
    port: initialState?.port ?? 4098,
    users: initialState?.users ?? [],
  }
  const calls = []
  const toasts = []
  const alerts = []
  const prompts = []
  const selects = []
  const confirms = []
  const layers = []
  let slotRender
  let submitListener

  const selectQueue = []
  const promptQueue = []
  const confirmQueue = []

  const context = {
    webserverControl: {
      run(argumentsList) {
        calls.push(argumentsList)
        const cmd = argumentsList[0]
        if (cmd === "status") {
          return {
            ok: true,
            deployed: state.deployed,
            running: state.running,
            defaultEnabled: state.defaultEnabled,
            host: state.host,
            port: state.port,
            address: `http://${state.host}:${state.port}`,
            users: state.users,
          }
        }
        if (cmd === "user-list") {
          return { ok: true, users: state.users }
        }
        if (cmd === "deploy") {
          state.deployed = true
          state.running = argumentsList[argumentsList.indexOf("--running") + 1] === "on"
          state.defaultEnabled = argumentsList[argumentsList.indexOf("--default") + 1] === "on"
          return {
            ok: true,
            deployed: true,
            running: state.running,
            defaultEnabled: state.defaultEnabled,
            host: state.host,
            port: state.port,
            address: `http://${state.host}:${state.port}`,
          }
        }
        if (cmd === "apply") {
          state.running = argumentsList[argumentsList.indexOf("--running") + 1] === "on"
          state.defaultEnabled = argumentsList[argumentsList.indexOf("--default") + 1] === "on"
          return {
            ok: true,
            deployed: true,
            running: state.running,
            defaultEnabled: state.defaultEnabled,
            host: state.host,
            port: state.port,
            address: `http://${state.host}:${state.port}`,
          }
        }
        if (cmd === "default") {
          state.defaultEnabled = argumentsList[argumentsList.indexOf("--default") + 1] === "on"
          return {
            ok: true,
            deployed: true,
            running: state.running,
            defaultEnabled: state.defaultEnabled,
            host: state.host,
            port: state.port,
            address: `http://${state.host}:${state.port}`,
          }
        }
        if (cmd === "port") {
          const portIdx = argumentsList.indexOf("--port")
          const hostIdx = argumentsList.indexOf("--host")
          state.port = Number(argumentsList[portIdx + 1])
          state.host = argumentsList[hostIdx + 1]
          return {
            ok: true,
            host: state.host,
            port: state.port,
            restarted: state.running,
            address: `http://${state.host}:${state.port}`,
          }
        }
        if (cmd === "user-add") {
          const usernameIdx = argumentsList.indexOf("--username")
          const passwordIdx = argumentsList.indexOf("--password")
          const username = argumentsList[usernameIdx + 1]
          const hasPassword = passwordIdx >= 0
          const user = { username, source: "store", created_at: "2026-01-01" }
          state.users.push(user)
          if (!hasPassword) {
            return { ok: true, username, generatedPassword: `GEN_${username}_123`, users: state.users }
          }
          return { ok: true, username, users: state.users }
        }
        if (cmd === "user-remove") {
          const usernameIdx = argumentsList.indexOf("--username")
          const username = argumentsList[usernameIdx + 1]
          state.users = state.users.filter((u) => u.username !== username)
          return { ok: true, username, users: state.users }
        }
        return { ok: true }
      },
    },
    renderer: {
      currentFocusedRenderable: null,
      keyInput: {
        prependListener(name, listener) {
          assert.equal(name, "keypress")
          submitListener = listener
        },
        off(name, listener) {
          assert.equal(name, "keypress")
          assert.equal(listener, submitListener)
          submitListener = null
        },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_server_wizard" }) },
      dialog: {
        async select(input) {
          selects.push(input.title)
          return { value: selectQueue.shift() }
        },
        async prompt(input) {
          prompts.push(input.title)
          const val = promptQueue.shift()
          return val === undefined ? null : val
        },
        async alert(input) {
          alerts.push(input)
        },
        async confirm(input) {
          confirms.push(input.title)
          return confirmQueue.shift() ?? false
        },
      },
      toast: { show(input) { toasts.push(input) } },
      slot({ render }) {
        slotRender = render
        return () => {}
      },
    },
    keymap: { layer(factory) { layers.push(factory()) } },
  }

  return { 
    context, 
    state, 
    calls, 
    toasts, 
    alerts, 
    prompts, 
    selects, 
    confirms, 
    layers, 
    renderSlot: () => slotRender(),
    getSubmitListener: () => submitListener,
    selectQueue, 
    promptQueue, 
    confirmQueue 
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error("Timed out waiting for predicate")
}

// --- Load server-wizard module ---
const wizardModule = await import(`${new URL("config/plugins/tui/server-wizard.js", root).href}?server-regression=${Date.now()}`)

// --- Test registration ---
{
  const fake = createFakeContext({ deployed: true })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  assert.equal(fake.layers.length, 1)
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  assert.ok(row, "server-wizard command not found")
  assert.equal(row.slash.name, "server")
  assert.equal(row.group, "Services")
  assert.equal(fake.layers[0].priority, 961)
  assert.equal(row.palette, true)
  assert.equal(row.suggested, true)
  cleanup()
}

// --- Test status flow ---
{
  const fake = createFakeContext({
    deployed: true,
    running: true,
    defaultEnabled: true,
    host: "127.0.0.1",
    port: 4098,
    users: [
      { username: "envuser", source: "env" },
      { username: "alice", source: "store", created_at: "123" },
    ],
  })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  assert.equal(row.run("status"), true)
  await waitFor(() => fake.toasts.length > 0)
  const lastToast = fake.toasts.at(-1)
  assert.ok(lastToast.message.includes("http://127.0.0.1:4098"), "toast should contain address")
  assert.ok(lastToast.message.includes("пользователей: 2"), "toast should contain user count")
  assert.ok(lastToast.message.includes("envuser"), "toast should contain usernames")
  assert.ok(lastToast.message.includes("alice"), "toast should contain usernames")
  assert.deepEqual(fake.calls, [["status"]])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test not-deployed → deploy flow ---
{
  const fake = createFakeContext({ deployed: false })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("deploy", true, true)
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.deployed && fake.state.defaultEnabled === true)
  await waitFor(() => fake.toasts.at(-1)?.message.includes("автозапуск включён"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["deploy", "--running", "on", "--default", "on"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: start/stop (toggle) ---
{
  const fake = createFakeContext({ deployed: true, running: true, defaultEnabled: true })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("toggle", false, "exit")
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.running === false)
  await waitFor(() => fake.toasts.at(-1)?.message.includes("остановлен"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["apply", "--running", "off", "--default", "on"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: autostart ---
{
  const fake = createFakeContext({ deployed: true, running: true, defaultEnabled: true })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("autostart", false, "exit")
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.defaultEnabled === false)
  await waitFor(() => fake.toasts.at(-1)?.message.includes("автозапуск выключен"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["default", "off"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: port (with retries) ---
{
  const fake = createFakeContext({ deployed: true, running: false, defaultEnabled: false, host: "127.0.0.1", port: 4098 })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("port", "exit")
  fake.promptQueue.push("abc", "0", "5000", "127.0.0.1")
  fake.confirmQueue.push(true)
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.port === 5000)
  await waitFor(() => fake.alerts.length === 2)
  assert.ok(fake.alerts[0].message.includes("Порт должен быть числом 1-65535"))
  assert.ok(fake.alerts[1].message.includes("Порт должен быть числом 1-65535"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["port", "--port", "5000", "--host", "127.0.0.1"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: add user manual (with retries) ---
{
  const fake = createFakeContext({ deployed: true, running: false, defaultEnabled: false })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("add-user", "manual", "exit")
  fake.promptQueue.push("bad user!", "bob", "short", "password123", "password123")
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.users.length === 1)
  await waitFor(() => fake.alerts.length === 2)
  assert.ok(fake.alerts[0].message.includes("Допустимы буквы, цифры"))
  assert.ok(fake.alerts[1].message.includes("не короче 8"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["user-add", "--username", "bob", "--password", "password123"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: add user generate ---
{
  const fake = createFakeContext({ deployed: true, running: false, defaultEnabled: false })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("add-user", "generate", "exit")
  fake.promptQueue.push("charlie")
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.users.length === 1)
  await waitFor(() => fake.alerts.length === 1)
  assert.ok(fake.alerts[0].message.includes("GEN_charlie_123"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["user-add", "--username", "charlie"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: remove user ---
{
  const fake = createFakeContext({
    deployed: true,
    running: false,
    defaultEnabled: false,
    users: [
      { username: "envuser", source: "env" },
      { username: "alice", source: "store", created_at: "2026-01-01" },
    ],
  })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("remove-user", "alice", "exit")
  fake.confirmQueue.push(true)
  assert.equal(row.run(""), true)
  await waitFor(() => fake.state.users.length === 1)
  assert.deepEqual(fake.calls, [
    ["status"],
    ["user-list"],
    ["user-remove", "--username", "alice"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test menu: remove with empty store ---
{
  const fake = createFakeContext({
    deployed: true,
    running: false,
    defaultEnabled: false,
    users: [{ username: "envuser", source: "env" }],
  })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("remove-user", "exit")
  assert.equal(row.run(""), true)
  await waitFor(() => fake.alerts.length === 1)
  assert.ok(fake.alerts[0].message.includes("В хранилище нет пользователей"))
  assert.deepEqual(fake.calls, [
    ["status"],
    ["user-list"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test cancel at username prompt → back to menu → exit ---
{
  const fake = createFakeContext({ deployed: true, running: false, defaultEnabled: false })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const row = fake.layers[0].commands.find((item) => item.id === "custom.server-wizard.open")
  fake.selectQueue.push("add-user", "exit")
  fake.promptQueue.push(null)
  assert.equal(row.run(""), true)
  await waitFor(() => fake.calls.length >= 2)
  assert.deepEqual(fake.calls, [
    ["status"],
    ["status"],
  ])
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

// --- Test submit-router interception ---
{
  const fake = createFakeContext({ deployed: true, running: false, defaultEnabled: false })
  const cleanup = wizardModule.default.setup(fake.context)
  fake.renderSlot()
  const editor = {
    traits: { owner: "opencode", role: "prompt", status: "INPUT" },
    plainText: "/server",
    clear() { this.plainText = "" },
    gotoBufferEnd() {},
  }
  fake.context.renderer.currentFocusedRenderable = editor
  const event = {
    name: "return",
    eventType: "press",
    ctrl: false,
    meta: false,
    alt: false,
    option: false,
    super: false,
    hyper: false,
    shift: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
  }
  const listener = fake.getSubmitListener()
  assert.ok(listener, "submit listener not registered")
  listener(event)
  assert.equal(editor.plainText, "")
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  // Wait for fire-and-forget wizard to complete
  await waitFor(() => fake.calls.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  cleanup()
}

clearTimeout(watchdog)
console.log("TUI server wizard regression passed: /server command, registration, status, deploy, menu actions, user management, submit interception")
