// Integration regression for the TUI webserver command and wizard flow.
import assert from "node:assert/strict"
import { register } from "node:module"

register("./opencode-plugin-stub-hooks.mjs", import.meta.url)

const root = new URL("../", import.meta.url)
const commandModule = await import(new URL("config/plugins/tui/lib/webserver-command.js", root).href)
assert.deepEqual(commandModule.parseWebserverCommand("/webserver"), { type: "wizard" })
assert.deepEqual(commandModule.parseWebserverCommand("/WEBSERVER status"), { type: "status" })
assert.equal(commandModule.parseWebserverCommand("/webserver nope").type, "error")
assert.equal(commandModule.parseWebserverCommand("ordinary text"), null)

const wizardModule = await import(`${new URL("config/plugins/tui/webserver-wizard.js", root).href}?wizard-regression=${Date.now()}`)

const prompts = []
const selects = []
const toasts = []
const layers = []
let submitListener
let selectValues = []
const state = { deployed: false, running: false, defaultEnabled: false }
const calls = []
const context = {
  webserverControl: {
    run(argumentsList) {
      calls.push(argumentsList)
      if (argumentsList[0] === "status") return { ok: true, host: "localhost", port: 4098, ...state }
      const running = argumentsList[argumentsList.indexOf("--running") + 1] === "on"
      const defaultEnabled = argumentsList[argumentsList.indexOf("--default") + 1] === "on"
      state.deployed = true
      state.running = running
      state.defaultEnabled = defaultEnabled
      return { ok: true, host: "localhost", port: 4098, ...state }
    },
  },
  renderer: {
    currentFocusedRenderable: null,
    keyInput: {
      prependListener(name, listener) { assert.equal(name, "keypress"); submitListener = listener },
      off(name, listener) { assert.equal(name, "keypress"); assert.equal(listener, submitListener); submitListener = null },
    },
  },
  ui: {
    router: { current: () => ({ type: "session", sessionID: "ses_webserver_wizard" }) },
    dialog: {
      async select(input) { selects.push(input.title); return { value: selectValues.shift() } },
      async prompt(input) { prompts.push(input.title); return null },
    },
    toast: { show(input) { toasts.push(input) } },
    slot({ render }) { context.slotRender = render; return () => {} },
  },
  keymap: { layer(factory) { layers.push(factory()) } },
}
const cleanup = wizardModule.default.setup(context)
context.slotRender()
assert.equal(layers.length, 1)
const row = layers[0].commands.find((item) => item.id === "custom.webserver-wizard.open")
assert.ok(row)
assert.equal(row.slash.name, "webserver")

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out: ${JSON.stringify({ selects, toasts })}`)
}
selectValues = ["deploy", true, false]
assert.equal(row.run(""), true)
await waitFor(() => state.deployed && state.defaultEnabled === false)
await waitFor(() => toasts.at(-1)?.message.includes("автозапуск выключен"))
assert.ok(toasts.at(-1).message.includes("автозапуск выключен"))

selectValues = [false, true]
assert.equal(row.run(""), true)
await waitFor(() => state.running === false && state.defaultEnabled === true)
await waitFor(() => toasts.at(-1)?.message.includes("остановлен"))
assert.ok(toasts.at(-1).message.includes("остановлен"))

const editor = {
  traits: { owner: "opencode", role: "prompt", status: "INPUT" },
  plainText: "/webserver status",
  clear() { this.plainText = "" },
  gotoBufferEnd() {},
}
context.renderer.currentFocusedRenderable = editor
const event = {
  name: "return", eventType: "press", ctrl: false, meta: false, alt: false,
  option: false, super: false, hyper: false, shift: false,
  preventDefault() { this.prevented = true },
  stopPropagation() { this.stopped = true },
}
submitListener(event)
await waitFor(() => toasts.at(-1)?.message.includes("остановлен"))
assert.equal(editor.plainText, "")
assert.equal(event.prevented, true)
assert.equal(event.stopped, true)

assert.deepEqual(calls, [
  ["status"],
  ["deploy", "--running", "on", "--default", "off"],
  ["status"],
  ["apply", "--running", "off", "--default", "on"],
  ["status"],
])
cleanup()
console.log("TUI webserver wizard regression passed: first deploy + state toggles + /webserver status")
