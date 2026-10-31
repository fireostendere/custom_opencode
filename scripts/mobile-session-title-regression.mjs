import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const loadSource = async (relative) => {
  const sourcePath = resolve(root, relative)
  const source = readFileSync(sourcePath, "utf8").replace(
    /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
    (_, start, specifier, end) =>
      `${start}${pathToFileURL(resolve(dirname(sourcePath), specifier)).href}${end}`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
}

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : status === 204 ? "No Content" : "Error",
  headers: { get: () => "application/json" },
  json: async () => value,
  text: async () => (typeof value === "string" ? value : JSON.stringify(value)),
})

// Test 1: api.createSession strips default placeholder titles like 'Новая сессия'
const api = await loadSource("app/api.js")
let capturedRequests = []
globalThis.fetch = async (path, options = {}) => {
  capturedRequests.push({ path, options })
  return response(200, { data: { id: "ses_new_1", location: { directory: "/test" } } })
}

// Case 1a: Calling with 'Новая сессия' should NOT send title to OpenCode backend
await api.createSession({ directory: "/test", title: "Новая сессия" })
assert.equal(capturedRequests.length, 1, "Only one POST request expected")
let sentBody = JSON.parse(capturedRequests[0].options.body)
assert.equal(sentBody.title, undefined, "'Новая сессия' must not be sent in POST /api/session body")

// Case 1b: Calling with 'New session' should NOT send title
capturedRequests = []
await api.createSession({ directory: "/test", title: "New session" })
assert.equal(capturedRequests.length, 1)
sentBody = JSON.parse(capturedRequests[0].options.body)
assert.equal(sentBody.title, undefined, "'New session' must not be sent in POST /api/session body")

// Case 1c: Calling with custom title SHOULD send title
capturedRequests = []
globalThis.fetch = async (path, options = {}) => {
  capturedRequests.push({ path, options })
  const body = options.body ? JSON.parse(options.body) : {}
  return response(200, { data: { id: "ses_new_1", title: body.title, location: { directory: "/test" } } })
}
await api.createSession({ directory: "/test", title: "Custom Title" })
assert.equal(capturedRequests.length, 1)
sentBody = JSON.parse(capturedRequests[0].options.body)
assert.equal(sentBody.title, "Custom Title", "Explicit non-default title must be sent")

// Test 2: api.renameSession tries PATCH first
capturedRequests = []
globalThis.fetch = async (path, options = {}) => {
  capturedRequests.push({ path, options })
  return response(204, null)
}
await api.renameSession("ses_123", "Renamed Title")
assert.equal(capturedRequests.length, 1)
assert.equal(capturedRequests[0].options.method, "PATCH", "renameSession should use PATCH /api/session/:id")

// Test 3: app.js source invariants
const appSource = readFileSync(resolve(root, "app/app.js"), "utf8")

// 3a: sessionTitle must fall back to 'Новая сессия' instead of 'Без названия'
assert.ok(
  appSource.includes("DEFAULT_SESSION_TITLE_RE"),
  "app.js must define DEFAULT_SESSION_TITLE_RE for auto-generated placeholder titles",
)
assert.ok(
  !appSource.includes("|| 'Без названия'"),
  "app.js must not fall back to 'Без названия' for untitled sessions",
)

// 3b: createNewSession and selectProjectTarget must not hardcode 'Новая сессия'
assert.ok(
  !appSource.includes("createAt(dir,'Новая сессия')") && !appSource.includes("createAt(dir, 'Новая сессия')"),
  "createNewSession must not pass 'Новая сессия' title",
)
assert.ok(
  !appSource.includes("createAt(project.canonical,'Новая сессия')") &&
    !appSource.includes("createAt(project.canonical, 'Новая сессия')"),
  "selectProjectTarget must not pass 'Новая сессия' title",
)

// 3c: handleEvent must process session.renamed and session.updated
assert.ok(
  appSource.includes("session.renamed"),
  "handleEvent must listen to session.renamed events",
)

// 3d: server.py proxy invariant
const serverSource = readFileSync(resolve(root, "app/server.py"), "utf8")
assert.ok(
  serverSource.includes('payload.get("title") in ("Новая сессия", "New session")'),
  "server.py must strip default session title in POST /api/session",
)

console.log("PASS mobile session title regression: placeholder stripping, PATCH rename, dynamic titling invariants")
