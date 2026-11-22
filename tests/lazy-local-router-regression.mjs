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
// A failed start backs off: no new start script (and no 60 s poll) per request.
{
  let spawns = 0
  let healthy = false
  globalThis.fetch = async () => ({ ok: healthy })
  globalThis.Bun = {
    spawn() {
      spawns++
      return { exitCode: 1 }
    },
    sleep: async () => {},
  }
  const { ensureRouter } = await import(`../config/plugins/lazy-local-router.js?backoff=${Date.now()}`)
  await assert.rejects(ensureRouter(), /Failed to start local model router/)
  assert.equal(spawns, 1)
  await assert.rejects(ensureRouter(), /failed to start recently/)
  await assert.rejects(ensureRouter({ dnd: true }), /failed to start recently/)
  assert.equal(spawns, 1, "the back-off window must not spawn another start")
  healthy = true
  await ensureRouter()
  assert.equal(spawns, 1, "a router started by other means is used at once")
  healthy = false
  await assert.rejects(ensureRouter(), /Failed to start local model router/)
  assert.equal(spawns, 2, "a healthy observation clears the back-off")
  const realNow = Date.now
  Date.now = () => realNow() + 5 * 60_000 + 1
  try {
    await assert.rejects(ensureRouter(), /Failed to start local model router/)
  } finally {
    Date.now = realNow
  }
  assert.equal(spawns, 3, "the start is retried after the back-off")
}
console.log("Lazy local router startup regression passed (incl. 5-minute start back-off)")
