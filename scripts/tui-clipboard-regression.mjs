import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { dirname } from "node:path"
import {
  MAX_CLIPBOARD_BYTES,
  isWSL,
  materializeClipboardPNG,
  parseClipboardProtocol,
} from "../config/plugins/tui/lib/wsl-clipboard.js"

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const protocol = (type, bytes = Buffer.alloc(0)) => `${type}\n${bytes.toString("base64")}`

assert.equal(isWSL({ platform: "win32", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "Microsoft" }), false)
assert.equal(isWSL({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "generic" }), true)
assert.equal(isWSL({ platform: "linux", env: {}, release: "custom-kernel-microsoft-standard-WSL2" }), true)
assert.equal(isWSL({ platform: "linux", env: {}, release: "6.8.0-generic" }), false)

const image = parseClipboardProtocol(protocol("image/png", png))
assert.equal(image.kind, "image")
assert.deepEqual(image.bytes, png)
const text = parseClipboardProtocol(protocol("text/plain", Buffer.from("Привет", "utf8")))
assert.equal(text.kind, "text")
assert.equal(text.bytes.toString("utf8"), "Привет")
assert.equal(parseClipboardProtocol("empty\n").kind, "empty")
for (const bad of [
  "wat\n",
  "empty\neA==",
  "text/plain\n%%",
  protocol("image/png", Buffer.from("not a png")),
  protocol("text/plain", Buffer.alloc(MAX_CLIPBOARD_BYTES + 1)),
]) {
  assert.throws(() => parseClipboardProtocol(bad), undefined, `must reject ${bad.slice(0, 20)}`)
}

const file = await materializeClipboardPNG(png)
assert.match(file.path, /custom-opencode-clipboard-/)
assert.equal((await stat(dirname(file.path))).mode & 0o777, 0o700)
assert.equal((await stat(file.path)).mode & 0o777, 0o600)
await file.cleanup()
await assert.rejects(stat(file.path))

// Paste routing: a text bracketed paste is delivered natively (no
// powershell.exe round trip); only an empty paste reads the Windows clipboard.
process.env.WSL_DISTRO_NAME ||= "regression"
const { readFile } = await import("node:fs/promises")
let pluginSource = await readFile(new URL("../config/plugins/tui/wsl-clipboard.jsx", import.meta.url), "utf8")
pluginSource = pluginSource
  .replace('import { Plugin } from "@opencode-ai/plugin/tui"', "const Plugin = { define(value) { return value } }")
  .replace('"./lib/wsl-clipboard.js"', JSON.stringify(new URL("../config/plugins/tui/lib/wsl-clipboard.js", import.meta.url).href))
assert.ok(!pluginSource.includes("@opencode-ai/plugin/tui"))
const plugin = (await import(`data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`)).default
const editor = { traits: { owner: "opencode", role: "prompt", status: "NORMAL" } }
let pasteListener
let clipboardReads = 0
const injected = []
const context = {
  wslClipboard: {
    async read() {
      clipboardReads += 1
      return { kind: "text", bytes: Buffer.from("from windows") }
    },
  },
  renderer: {
    currentFocusedEditor: editor,
    keyInput: {
      prependListener(name, listener) {
        assert.equal(name, "paste")
        pasteListener = listener
      },
      off() {},
      processPaste(bytes, metadata) {
        injected.push([Buffer.from(bytes).toString("utf8"), metadata.kind])
        pasteListener({ bytes, preventDefault() {}, stopPropagation() {} })
      },
    },
  },
  keymap: { layer() {}, dispatch() {} },
  ui: { slot: () => () => {}, toast: { show() {} } },
}
const dispose = plugin.setup(context)
assert.equal(typeof pasteListener, "function")
function paste(text) {
  const event = { bytes: Buffer.from(text), prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
  pasteListener(event)
  return event
}
const textPaste = paste("hello from the terminal")
assert.equal(textPaste.prevented, false, "A text paste must reach the prompt natively")
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(clipboardReads, 0, "A text paste must not spawn powershell.exe")
const emptyPaste = paste("")
assert.equal(emptyPaste.prevented, true, "An empty paste (image-only clipboard) must be handled by the bridge")
for (let attempt = 0; attempt < 50 && !injected.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(clipboardReads, 1)
assert.deepEqual(injected, [["from windows", "text"]], "The Windows clipboard content must be injected once, without recursion")
dispose()

console.log("TUI WSL clipboard regression passed: detection, protocol validation, private PNG lifecycle, native text paste / bridged empty paste")
