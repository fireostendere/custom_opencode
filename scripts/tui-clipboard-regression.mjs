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

console.log("TUI WSL clipboard regression passed: detection, protocol validation, private PNG lifecycle")
