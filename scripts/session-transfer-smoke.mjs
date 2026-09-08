import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── Minimal browser environment for app.js module scope ────────────────────
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const events = []
globalThis.window = { addEventListener() {}, dispatchEvent(event) { events.push(event) } }
function makeElement() {
  return {
    value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, title: '', selectionStart: 0, selectionEnd: 0, scrollHeight: 42,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, focus() {}, showModal() {}, close() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
    querySelector() { return null }, querySelectorAll() { return [] },
    contains() { return false }, closest() { return null },
  }
}
const elements = new Map()
globalThis.document = {
  getElementById: (id) => elements.get(id) || (elements.set(id, makeElement()), elements.get(id)),
  querySelectorAll: () => [],
  addEventListener() {},
  hidden: false,
}

// ── Controllable api stub ──────────────────────────────────────────────────
const API_METHODS = [
  'getSession', 'getContext', 'createSession', 'sendPrompt',
  'deleteSession', 'forkSession', 'switchAgent', 'switchModel',
  'listProjects', 'listSessions', 'sessionStatuses',
]
const handlers = {}
globalThis.__smoke = {
  api: Object.fromEntries(API_METHODS.map((name) => [
    name,
    (...args) => handlers[name]?.(...args),
  ])),
  ux: await import(`data:text/javascript;base64,${Buffer.from(readFileSync(resolve(root, 'app/ux-state.js'), 'utf8')).toString('base64')}`),
}

// ── Load app.js as a module: swap imports/boot for stubs, expose internals ─
let source = readFileSync(resolve(root, 'app/app.js'), 'utf8')
source = source
  .replace("import * as api from './api.js'", 'const api = globalThis.__smoke.api')
  .replace(
    "import { escapeHtml, renderMarkdown } from './markdown.js'",
    'const escapeHtml = (value) => String(value ?? ""); const renderMarkdown = (value) => String(value ?? "")',
  )
  .replace("import { modeFromAgent, ORCHESTRATED_MODELS } from './ux-state.js'", 'const { modeFromAgent, ORCHESTRATED_MODELS } = globalThis.__smoke.ux')
  .replace("import { createAdaptivePoller, createRefreshCoalescer } from './refresh-coalescer.js'", 'const createAdaptivePoller = () => ({ start() {}, stop() {}, wake() {}, reschedule() {} }); const createRefreshCoalescer = () => (refresh, force) => refresh(force)')
assert.ok(!source.includes("from './api.js'"), 'api import replacement failed')
assert.ok(!source.includes("from './markdown.js'"), 'markdown import replacement failed')
assert.ok(!source.includes("from './ux-state.js'"), 'ux-state import replacement failed')
assert.ok(!source.includes("from './refresh-coalescer.js'"), 'refresh-coalescer import replacement failed')
const bootIndex = source.lastIndexOf('initialize().catch')
assert.ok(bootIndex > 0, 'app.js boot call not found')
source = source.slice(0, bootIndex)
  + 'globalThis.__smoke.exports = { transferSessionToProject, forkWithFallback, sessionWithControls, handoffText, messagePlainText, changeAgent, changeModel, loadSessionsNow, selectSession, resetPromptHistory, navigatePromptHistory, state, seedDraft: (id, value) => { drafts[id] = value }, draftOf: (id) => drafts[id] }\n'

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const app = globalThis.__smoke.exports
const state = app.state

const calls = { createSession: [], sendPrompt: [], deleteSession: [], switchAgent: [], switchModel: [] }
const error = (status, message = 'boom') => Object.assign(new Error(message), { status })

function reset() {
  storage.clear()
  events.length = 0
  state.sessions = []
  state.selected = null
  state.context = []
  state.projects = []
  state.running.clear()
  state.queues.clear()
  for (const list of Object.values(calls)) list.length = 0
  handlers.getSession = async () => ({})
  handlers.getContext = async () => []
  handlers.createSession = async (value) => { calls.createSession.push(value); return { id: 'ses_new' } }
  handlers.sendPrompt = async (session, value) => { calls.sendPrompt.push({ session, value }) }
  handlers.deleteSession = async (id) => { calls.deleteSession.push(id) }
  handlers.forkSession = async () => { throw error(404, 'fork unsupported') }
  handlers.switchAgent = async (id, agent) => { calls.switchAgent.push({ id, agent }) }
  handlers.switchModel = async (id, model) => { calls.switchModel.push({ id, model }) }
  handlers.listProjects = async () => []
  handlers.listSessions = async () => []
  handlers.sessionStatuses = async () => ({})
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const sourceSession = { id: 'ses_src', title: 'Source', location: { directory: '/src' } }
const targetProject = { id: 'proj_dst', name: 'Dst', canonical: '/dst' }

// ── Scenario 1: transfer with source removal copies the draft and cleans up ─
reset()
handlers.getSession = async () => ({ model: { providerID: 'bailian-cli', id: 'qwen-flash', variant: 'low' }, agent: 'build' })
handlers.getContext = async () => [
  { type: 'user', text: 'первый вопрос' },
  { type: 'assistant', content: [{ type: 'text', text: 'ответ' }] },
]
app.seedDraft('ses_src', 'черновик')
state.sessions = [sourceSession]

let result = await app.transferSessionToProject(sourceSession, targetProject, { removeSource: true })
assert.equal(result.sourceRemoved, true, 'source removal must succeed')
assert.equal(result.created.id, 'ses_new')
assert.equal(calls.createSession[0].directory, '/dst')
assert.equal(calls.createSession[0].agent, 'build-direct', 'ordinary copied sessions must use the no-delegation agent')
assert.deepEqual(calls.createSession[0].model, { providerID: 'bailian-cli', id: 'qwen-flash', variant: 'low' })
const handoffSent = calls.sendPrompt[0].value.text
assert.ok(handoffSent.includes('первый вопрос') && handoffSent.includes('ответ'), 'handoff must carry the source context')
assert.ok(handoffSent.includes('USER:') && handoffSent.includes('ASSISTANT:'), 'handoff must label roles')
assert.equal(app.draftOf('ses_new'), 'черновик', 'draft must move to the transferred session')
assert.equal(app.draftOf('ses_src'), undefined, 'source draft must be removed with the source session')
assert.ok(state.sessions.some((session) => session.id === 'ses_new'), 'new session must stay listed')
assert.ok(!state.sessions.some((session) => session.id === 'ses_src'), 'source session must disappear')
assert.equal(state.running.has('ses_new'), true, 'handoff session stays running until the drain settles')
assert.equal(state.running.has('ses_src'), false)
assert.deepEqual(calls.deleteSession, ['ses_src'])

// ── Scenario 2: empty transfer creates a session without a handoff ──────────
reset()
state.sessions = [sourceSession]

result = await app.transferSessionToProject(sourceSession, targetProject)
assert.equal(result.created.id, 'ses_new')
assert.equal(calls.createSession.length, 1)
assert.equal(calls.sendPrompt.length, 0, 'empty transfer must not send a handoff prompt')
assert.equal(state.running.has('ses_new'), false, 'empty transfer must not mark a handoff as running')

// ── Scenario 3: sendPrompt failure rolls the created session back ──────────
reset()
handlers.getContext = async () => [{ type: 'user', text: 'вопрос' }]
handlers.sendPrompt = async () => { throw error(500) }
state.sessions = [sourceSession]

await assert.rejects(
  app.transferSessionToProject(sourceSession, targetProject, {}),
  /boom/,
  'sendPrompt failure must surface',
)
assert.deepEqual(calls.deleteSession, ['ses_new'], 'failed handoff must delete the created session')
assert.ok(!state.sessions.some((session) => session.id === 'ses_new'), 'rolled-back session must not stay listed')
assert.equal(state.running.has('ses_new'), false)
assert.ok(state.sessions.some((session) => session.id === 'ses_src'), 'source session must survive the failed copy')

// ── Scenario 4: source delete failure keeps the copy and the source ────────
reset()
handlers.getContext = async () => [{ type: 'user', text: 'вопрос' }]
handlers.deleteSession = async (id) => { calls.deleteSession.push(id); if (id === 'ses_src') throw error(500, 'locked') }
app.seedDraft('ses_src', 'черновик')
state.sessions = [sourceSession]

result = await app.transferSessionToProject(sourceSession, targetProject, { removeSource: true })
assert.equal(result.sourceRemoved, false, 'failed source removal must be reported, not thrown')
assert.ok(state.sessions.some((session) => session.id === 'ses_src'), 'source session must stay listed when delete fails')
assert.ok(state.sessions.some((session) => session.id === 'ses_new'), 'copy must survive source delete failure')
assert.equal(app.draftOf('ses_src'), 'черновик', 'source draft must survive failed removal')
assert.equal(app.draftOf('ses_new'), 'черновик')

// ── Scenario 5: sessionWithControls merges detail over the list item ───────
reset()
handlers.getSession = async () => ({ model: { variant: 'low' }, agent: 'plan' })
let merged = await app.sessionWithControls({ id: 's1', model: { providerID: 'p', id: 'm' } })
assert.deepEqual(merged.model, { providerID: 'p', id: 'm', variant: 'low' })
assert.equal(merged.agent, 'plan')
handlers.getSession = async () => { throw error(500) }
const original = { id: 's2' }
merged = await app.sessionWithControls(original)
assert.equal(merged, original, 'detail fetch failure must fall back to the list item')

// ── Scenario 6: fork fallback (404) slices context at messageID ────────────
reset()
state.selected = sourceSession
state.context = [
  { id: 'm1', type: 'user', text: 'один' },
  { id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'два' }] },
  { id: 'm3', type: 'user', text: 'три' },
]
handlers.createSession = async (value) => { calls.createSession.push(value); return { id: 'ses_fork' } }

const forked = await app.forkWithFallback(sourceSession, 'm2')
assert.equal(forked.id, 'ses_fork')
assert.equal(calls.createSession[0].directory, '/src', 'fork must stay in the source directory')
const forkPrompt = calls.sendPrompt[0].value.text
assert.ok(forkPrompt.includes('один') && forkPrompt.includes('два'), 'fork handoff must keep messages up to messageID')
assert.ok(!forkPrompt.includes('три'), 'fork handoff must not carry messages after messageID')
assert.equal(state.running.has('ses_fork'), true)

// ── Scenario 7: empty fork fallback creates a session without a handoff ────
reset()
state.selected = sourceSession
handlers.createSession = async (value) => { calls.createSession.push(value); return { id: 'ses_empty_fork' } }

const emptyFork = await app.forkWithFallback(sourceSession, undefined)
assert.equal(emptyFork.id, 'ses_empty_fork')
assert.equal(calls.createSession.length, 1)
assert.equal(calls.sendPrompt.length, 0, 'empty fork fallback must not send a handoff prompt')
assert.equal(state.running.has('ses_empty_fork'), false, 'empty fork fallback must not mark a handoff as running')

// ── Scenario 8: fork fallback validates the created session id ─────────────
reset()
handlers.forkSession = async () => { throw error(405, 'no fork route') }
handlers.createSession = async () => ({})
state.selected = sourceSession
state.context = [{ id: 'm1', type: 'user', text: 'один' }]

await assert.rejects(app.forkWithFallback(sourceSession, undefined), /id/, 'missing session id must throw')
assert.equal(calls.sendPrompt.length, 0, 'no prompt may be sent without a valid session id')

// ── Scenario 9: fork fallback rolls back on sendPrompt failure ─────────────
reset()
state.selected = sourceSession
state.context = [{ id: 'm1', type: 'user', text: 'один' }]
handlers.createSession = async () => ({ id: 'ses_fork2' })
handlers.sendPrompt = async () => { throw error(500) }

await assert.rejects(app.forkWithFallback(sourceSession, undefined), /boom/)
assert.deepEqual(calls.deleteSession, ['ses_fork2'], 'failed fork handoff must delete the created session')
assert.equal(state.running.has('ses_fork2'), false)

// ── Scenario 10: handoffText keeps only the last 40 messages ───────────────
const manyMessages = Array.from({ length: 45 }, (_, index) => ({
  type: index % 2 ? 'assistant' : 'user',
  text: `msg-${String(index).padStart(2, '0')}`,
}))
let clippedHandoff = app.handoffText({ id: 'ses_x', location: { directory: '/d' } }, manyMessages)
const rows = (clippedHandoff.match(/^(USER|ASSISTANT):/gm) || []).length
assert.equal(rows, 40, 'handoff must cap at the last 40 messages')
assert.ok(clippedHandoff.includes('msg-44') && clippedHandoff.includes('msg-05'))
assert.ok(!clippedHandoff.includes('msg-04'), 'messages beyond the 40-message window must be dropped')

// ── Scenario 11: handoffText caps the transcript at 24 000 characters ──────
const bigMessages = Array.from({ length: 3 }, (_, index) => ({
  type: 'user',
  text: 'abc'[index].repeat(10000),
}))
clippedHandoff = app.handoffText({ id: 'ses_x', location: { directory: '/d' } }, bigMessages)
const joined = bigMessages.map((message) => `USER:\n${message.text}`).join('\n\n')
assert.ok(joined.length > 24000, 'fixture must exceed the cap')
assert.ok(clippedHandoff.endsWith(joined.slice(-24000)), 'handoff must keep exactly the last 24 000 transcript characters')
const prefixLength = app.handoffText({ id: 'ses_x', location: { directory: '/d' } }, []).length
assert.equal(clippedHandoff.length, prefixLength + 24000)

// ── Scenario 12: messagePlainText extracts text parts only ─────────────────
assert.equal(app.messagePlainText({ type: 'user', text: 'привет' }), 'привет')
assert.equal(
  app.messagePlainText({ type: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool', text: 'skip' }, { type: 'text', text: 'b' }] }),
  'a\nb',
)

// ── Scenario 13: prompt history is limited to the selected session ──────────
reset()
state.selected = { id: 'ses_current' }
state.context = [
  { type: 'user', text: 'первый prompt' },
  { type: 'assistant', content: [{ type: 'text', text: 'ответ' }] },
  { type: 'user', text: 'второй prompt' },
]
const promptInput = document.getElementById('input')
promptInput.value = 'новый draft'
promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length)
app.resetPromptHistory('ses_current')
const promptKey = { shiftKey:false, altKey:false, ctrlKey:false, metaKey:false }
assert.equal(app.navigatePromptHistory(-1, promptKey), true)
assert.equal(promptInput.value, 'второй prompt')
assert.equal(app.navigatePromptHistory(-1, promptKey), true)
assert.equal(promptInput.value, 'первый prompt')
assert.equal(app.navigatePromptHistory(1, { ...promptKey, }), true)
assert.equal(promptInput.value, 'второй prompt')
assert.equal(app.navigatePromptHistory(1, promptKey), true)
assert.equal(promptInput.value, 'новый draft')

// ── Scenario 14: draft isolation for agent/model controls ──────────────────
reset()
state.selected = null
await app.changeAgent('plan')
await app.changeModel({ id: 'qwen-flash', providerID: 'bailian-cli', variant: 'low' })
assert.equal(state.draftAgent, 'plan')
assert.deepEqual(state.draftModel, { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'low' })
assert.equal(calls.switchAgent.length, 0, 'home-screen agent change must not hit the API')
assert.equal(calls.switchModel.length, 0, 'home-screen model change must not hit the API')

state.selected = { id: 'ses_sel', agent: 'build', model: { id: 'old', providerID: 'p' } }
await app.changeAgent('build')
await app.changeModel({ id: 'new', providerID: 'np' })
assert.deepEqual(calls.switchAgent, [{ id: 'ses_sel', agent: 'build' }])
assert.deepEqual(calls.switchModel, [{ id: 'ses_sel', model: { id: 'new', providerID: 'np' } }])
assert.equal(state.selected.agent, 'build')
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np' })
assert.equal(state.draftAgent, 'plan', 'selected-session agent switch must not touch the home draft')
assert.deepEqual(state.draftModel, { id: 'qwen-flash', providerID: 'bailian-cli', variant: 'low' }, 'selected-session model switch must not touch the home draft')

// ── Scenario 15: stale list refresh must not undo a model switch ────────────
reset()
const listed = { id: 'ses_list', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [listed]
state.selected = listed
const staleList = deferred()
handlers.listSessions = async () => staleList.promise
const refresh = app.loadSessionsNow({ background: true })
await app.changeModel({ id: 'new', providerID: 'np', variant: 'high' })
staleList.resolve([{ id: 'ses_list', agent: 'build', model: { id: 'old', providerID: 'p' } }])
await refresh
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np', variant: 'high' }, 'stale list response must preserve the switched selected model')
assert.deepEqual(state.sessions[0].model, { id: 'new', providerID: 'np', variant: 'high' }, 'stale list response must preserve the switched list model')

// ── Scenario 16: stale session detail must not undo a model switch ──────────
reset()
const detailSession = { id: 'ses_detail', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [detailSession]
const staleDetail = deferred()
handlers.getSession = async () => staleDetail.promise
const selecting = app.selectSession('ses_detail', { push: false })
await app.changeModel({ id: 'new', providerID: 'np', variant: 'high' })
staleDetail.resolve({ agent: 'plan', model: { id: 'old', providerID: 'p' } })
await selecting
assert.equal(state.selected.agent, 'plan', 'stale detail may still update unrelated fields')
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np', variant: 'high' }, 'stale detail must preserve the switched selected model')
assert.deepEqual(state.sessions[0].model, { id: 'new', providerID: 'np', variant: 'high' }, 'stale detail must preserve the switched list model')

// ── Scenario 17: post-switch stale reads stay overridden until confirmation ─
reset()
const consistentSession = { id: 'ses_consistent', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [consistentSession]
state.selected = consistentSession
await app.changeModel({ id: 'new', providerID: 'np', variant: 'high' })
handlers.listSessions = async () => [{ id: 'ses_consistent', agent: 'build', model: { id: 'old', providerID: 'p' } }]
await app.loadSessionsNow({ background: true })
assert.deepEqual(state.sessions[0].model, { id: 'new', providerID: 'np', variant: 'high' }, 'a stale refresh started after switch must keep the local override')
handlers.listSessions = async () => [{ id: 'ses_consistent', agent: 'build', model: { id: 'new', providerID: 'np', variant: 'high' } }]
await app.loadSessionsNow({ background: true })
assert.deepEqual(state.sessions[0].model, { id: 'new', providerID: 'np', variant: 'high' }, 'the matching backend model must confirm the override')

// ── Scenario 18: a post-switch stale detail stays overridden until confirmed
reset()
const eventualDetailSession = { id: 'ses_eventual_detail', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [eventualDetailSession]
state.selected = eventualDetailSession
await app.changeModel({ id: 'new', providerID: 'np', variant: 'high' })
handlers.getSession = async () => ({ model: { id: 'old', providerID: 'p' } })
await app.selectSession('ses_eventual_detail', { push: false })
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np', variant: 'high' }, 'a stale detail started after switch must keep the local override')
handlers.getSession = async () => ({ model: { id: 'new', providerID: 'np', variant: 'high' } })
await app.selectSession('ses_eventual_detail', { push: false })
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np', variant: 'high' }, 'the matching detail must confirm the override')

// ── Scenario 19: a pre-mutation detail cannot roll back after confirmation ──
reset()
const confirmedSession = { id: 'ses_confirmed', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [confirmedSession]
const preMutationDetail = deferred()
handlers.getSession = async () => preMutationDetail.promise
const pendingSelection = app.selectSession('ses_confirmed', { push: false })
await app.changeModel({ id: 'new', providerID: 'np', variant: 'high' })
handlers.listSessions = async () => [{ id: 'ses_confirmed', agent: 'build', model: { id: 'new', providerID: 'np', variant: 'high' } }]
await app.loadSessionsNow({ background: true })
preMutationDetail.resolve({ model: { id: 'old', providerID: 'p' } })
await pendingSelection
assert.deepEqual(state.selected.model, { id: 'new', providerID: 'np', variant: 'high' }, 'a pre-mutation detail must stay stale even after another read confirms the model')

// ── Scenario 20: model requests are serialized and recover after failure ───
reset()
const queuedSession = { id: 'ses_queue', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [queuedSession]
state.selected = queuedSession
const firstSwitch = deferred(), secondSwitch = deferred()
handlers.switchModel = async (id, model) => {
  calls.switchModel.push({ id, model })
  return calls.switchModel.length === 1 ? firstSwitch.promise : secondSwitch.promise
}
const switchA = app.changeModel({ id: 'a', providerID: 'p' })
const switchB = app.changeModel({ id: 'b', providerID: 'p' })
await new Promise(setImmediate)
assert.deepEqual(calls.switchModel.map((call) => call.model.id), ['a'], 'the second switch must wait for the first backend call')
firstSwitch.resolve()
await new Promise(setImmediate)
assert.deepEqual(calls.switchModel.map((call) => call.model.id), ['a', 'b'], 'the second switch must start after the first settles')
secondSwitch.resolve()
assert.equal(await switchA, true)
assert.equal(await switchB, true)
assert.deepEqual(state.selected.model, { id: 'b', providerID: 'p' }, 'the final UI model must be the last selection')
assert.deepEqual(state.sessions[0].model, { id: 'b', providerID: 'p' }, 'the list model must follow the final selection')

reset()
const recoverSession = { id: 'ses_recover', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [recoverSession]
state.selected = recoverSession
let recoverCalls = 0
handlers.switchModel = async (id, model) => {
  calls.switchModel.push({ id, model })
  if (++recoverCalls === 1) throw error(500, 'first failed')
}
const failedA = app.changeModel({ id: 'a', providerID: 'p' })
const recoveredB = app.changeModel({ id: 'b', providerID: 'p' })
assert.equal(await failedA, false, 'the first failure must be reported')
assert.equal(await recoveredB, true, 'a failed switch must not block the next request')
assert.deepEqual(calls.switchModel.map((call) => call.model.id), ['a', 'b'])
assert.deepEqual(state.selected.model, { id: 'b', providerID: 'p' })

// ── Scenario 21: a queued switch after deletion must not call the API ───────
reset()
const deletedQueueSession = { id: 'ses_deleted_queue', agent: 'build', model: { id: 'old', providerID: 'p' } }
state.sessions = [deletedQueueSession]
state.selected = deletedQueueSession
const activeDeletedSwitch = deferred()
handlers.switchModel = async (id, model) => {
  calls.switchModel.push({ id, model })
  return activeDeletedSwitch.promise
}
const deletingA = app.changeModel({ id: 'a', providerID: 'p' })
const deletingB = app.changeModel({ id: 'b', providerID: 'p' })
await new Promise(setImmediate)
state.sessions = []
state.selected = null
activeDeletedSwitch.resolve()
assert.equal(await deletingA, false, 'an in-flight result after deletion must fail locally')
assert.equal(await deletingB, false, 'a queued request after deletion must fail locally')
assert.deepEqual(calls.switchModel.map((call) => call.model.id), ['a'], 'the queued request must not call switchModel after deletion')
assert.equal(events.at(-1).detail.ok, false)
assert.equal(events.at(-1).detail.error, 'session removed')

// ── Scenario 22: old-session completion cannot overwrite last model ─────────
reset()
const oldSession = { id: 'ses_old', agent: 'build', model: { id: 'old', providerID: 'p' } }
const currentSession = { id: 'ses_current', agent: 'build', model: { id: 'current', providerID: 'p' } }
state.sessions = [oldSession, currentSession]
state.selected = oldSession
const lateOldSwitch = deferred()
handlers.switchModel = async (id, model) => {
  calls.switchModel.push({ id, model })
  return id === oldSession.id ? lateOldSwitch.promise : undefined
}
const oldChange = app.changeModel({ id: 'old-result', providerID: 'p' })
await new Promise(setImmediate)
state.selected = currentSession
await app.changeModel({ id: 'current-result', providerID: 'p' })
lateOldSwitch.resolve()
assert.equal(await oldChange, true)
assert.deepEqual(JSON.parse(localStorage.getItem('opencode:web:last-model-v1')), { id: 'current-result', providerID: 'p' }, 'a late old-session result must not overwrite the latest selected model')

console.log('Session transfer smoke passed: handoff rollback + draft move + source-delete safety + fork fallback + clipping + session prompt history + draft isolation + stale model guards + serialized model changes')
