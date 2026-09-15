import assert from "node:assert/strict"

process.env.OPENCODE_LOCAL_AUTO_START = "1"
process.env.OPENCODE_LOCAL_PROVIDER = "ollama"
process.env.OPENCODE_LOCAL_ROUTER_URL = "http://router.test"
process.env.OPENCODE_LOCAL_ROUTER_START = "/tmp/start-router.sh"

let callback
let fetches = 0
const fetchedURLs = []
let spawned = 0
let exitAwaited = false
globalThis.fetch = async (url) => {
  fetchedURLs.push(url)
  return { ok: ++fetches > 1 }
}
globalThis.Bun = {
  spawn() {
    spawned++
    return {
      exitCode: null,
      get exited() {
        exitAwaited = true
        return new Promise(() => {})
      },
    }
  },
  sleep: async () => {},
}

const plugin = (await import(`../config/plugins/lazy-local-router.js?test=${Date.now()}`)).default
await plugin.setup({ session: { hook: async (_event, handler) => {
  callback = handler
  return { dispose() {} }
} } })
await Promise.race([
  callback({ model: { providerID: "ollama" } }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("startup hook waited for router exit")), 100)),
])

assert.equal(spawned, 1)
assert.equal(exitAwaited, false)
assert.equal(fetches, 2)
assert.deepEqual(fetchedURLs, ["http://router.test", "http://router.test"])
console.log("Lazy local router startup regression passed")
