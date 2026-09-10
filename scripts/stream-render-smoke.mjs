import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const storage = new Map()
const frames = []
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail } }
globalThis.window = { addEventListener() {}, dispatchEvent() {}, __permissionSuppression: null }

function element(id) {
  let html = ''
  return {
    id, hidden: false, value: '', textContent: '', style: {}, dataset: {}, scrollHeight: 100, scrollTop: 0, clientHeight: 100, renderWrites: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    get innerHTML() { return html }, set innerHTML(value) { html = value; if (id === 'messagesInner') this.renderWrites++ },
    querySelector() { return null }, querySelectorAll() { return [] }, scrollTo() {}, addEventListener() {},
  }
}
const elements = new Map()
globalThis.document = {
  hidden: false,
  getElementById: (id) => elements.get(id) || (elements.set(id, element(id)), elements.get(id)),
  querySelectorAll: () => [], addEventListener() {}, createElement: () => element('created'),
}
globalThis.__smoke = {
  api: { connectEvents() {}, async hasConversation() { return null } },
  ux: await import(`data:text/javascript;base64,${Buffer.from(readFileSync(resolve(root, 'app/ux-state.js'), 'utf8')).toString('base64')}`),
}

let source = readFileSync(resolve(root, 'app/app.js'), 'utf8')
source = source
  .replace("from './refresh-coalescer.js'", `from '${pathToFileURL(resolve(root, 'app/refresh-coalescer.js')).href}'`)
  .replace("import * as api from './api.js'", 'const api = globalThis.__smoke.api')
  .replace("import { escapeHtml, renderMarkdown } from './markdown.js'", 'const escapeHtml = (value) => String(value ?? ""); const renderMarkdown = (value) => String(value ?? "")')
  .replace("import { modeFromAgent, ORCHESTRATED_MODELS } from './ux-state.js'", 'const { modeFromAgent, ORCHESTRATED_MODELS } = globalThis.__smoke.ux')
const bootIndex = source.lastIndexOf('initialize().catch')
assert.ok(bootIndex > 0, 'app.js boot call not found')
source = source.slice(0, bootIndex) + 'globalThis.__smoke.exports = { handleEvent, state }\n'
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const { handleEvent, state } = globalThis.__smoke.exports
state.sessions = [{ id: 'ses_stream' }]
state.selected = state.sessions[0]
const inner = document.getElementById('messagesInner')

for (const payload of [
  { type: 'session.text.started', data: { sessionID: 'ses_stream', assistantMessageID: 'msg_stream' } },
  { type: 'session.text.delta', data: { sessionID: 'ses_stream', assistantMessageID: 'msg_stream', delta: 'one ' } },
  { type: 'session.text.delta', data: { sessionID: 'ses_stream', assistantMessageID: 'msg_stream', delta: 'two ' } },
  { type: 'session.text.ended', data: { sessionID: 'ses_stream', assistantMessageID: 'msg_stream', text: 'final answer' } },
]) handleEvent(payload)

assert.equal(frames.length, 1, 'a burst of stream events must queue one render frame')
assert.equal(inner.renderWrites, 0, 'the queued frame must defer DOM writes')
assert.equal(state.context[0].content[0].text, 'final answer', 'state must retain the terminal stream value before paint')
frames.shift()()
assert.equal(inner.renderWrites, 1, 'the queued frame must render once')
assert.match(inner.innerHTML, /final answer/, 'the single render must contain the final stream value')

console.log('Stream render smoke passed: burst SSE events coalesce into one final-state render')

// A previous session's DOM/profile must not relabel the active model.
globalThis.location = { hash: '#/session/ses_stream' }
document.documentElement = { dataset: {} }
const uxSource = readFileSync(resolve(root, 'app/ux-controls.js'), 'utf8')
  .replace("from './ux-state.js'", `from '${pathToFileURL(resolve(root, 'app/ux-state.js')).href}'`)
  .replace("if (typeof document !== 'undefined') init()", 'export { currentProfile, restoreDesiredProfile, syncModelSurface }')
const controls = await import(`data:text/javascript;base64,${Buffer.from(uxSource).toString('base64')}`)
const button = document.getElementById('modelButton')
for (const model of [...__smoke.ux.ORCHESTRATED_MODELS, { id: 'qwen3.8-max', providerID: 'bailian-cli' }, { id: 'gpt-5.6-sol-orchestrated', providerID: 'other' }]) {
  state.selected = { id: 'ses_stream', model }
  storage.set('opencode:web:model-profiles-v1', JSON.stringify({ ses_stream: model.label ? 'direct' : 'orchestrated' }))
  controls.restoreDesiredProfile()
  document.documentElement.dataset.orchestratedModel = 'gpt-5.6-sol-orchestrated'
  button.textContent = model.label || model.id
  controls.syncModelSurface()
  assert.equal(button.textContent, model.label || model.id, 'session model label must survive stale DOM state')
  assert.equal(controls.currentProfile(), model.label ? 'orchestrated' : 'direct', 'session model must override stored profile')
  assert.equal(document.documentElement.dataset.orchestratedModel, model.label ? model.id : undefined)
}
console.log('Model identity smoke passed: session model overrides stale labels and profiles')
