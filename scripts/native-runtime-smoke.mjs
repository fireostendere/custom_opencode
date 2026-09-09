#!/usr/bin/env node
// Opt-in acceptance against an installed real OpenCode V2 service. Never runs
// against a normal user home: the clean-room fixture must explicitly opt in.
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readConfigReceipt } from '../config/plugins/tui/lib/config-receipt.js'

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]])
  return pairs
}, []))
if (!options['--home'] || !options['--output']) throw new Error('Usage: native-runtime-smoke.mjs --home ISOLATED_HOME --output REPORT.json')
const home = resolve(options['--home'])
await access(join(home, '.custom-opencode-audit-home'))
const service = JSON.parse(await readFile(join(home, '.local/state/opencode/service.json'), 'utf8'))
const url = new URL(service.url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Audit requires a loopback backend')
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`, 'Content-Type': 'application/json' }
async function request(method, path, body) {
  const response = await fetch(new URL(path, url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  if (!response.ok) { const error = new Error(`Native API ${method} ${path}: HTTP ${response.status}`); error.status = response.status; throw error }
  return text ? JSON.parse(text).data : undefined
}
const client = { session: {
  inbox: {
    list: ({ sessionID }) => request('GET', `/api/session/${sessionID}/inbox`),
    cancel: ({ sessionID, inboxID }) => request('DELETE', `/api/session/${sessionID}/inbox/${inboxID}`),
  },
  context: ({ sessionID }) => request('GET', `/api/session/${sessionID}/context`),
} }
const session = await request('POST', '/api/session', {
  title: 'Native configuration acceptance (zero inference)',
  model: { providerID: 'bailian-cli', id: 'qwen3.8-max' },
  location: { directory: join(home, 'scratch') },
})
const id = session.id
const prefix = `audit-${randomUUID().slice(0, 8)}`
const rows = []
const created = []
const statePath = join(home, '.config/opencode/.ponytail-active')
const originalMode = (await readFile(statePath, 'utf8')).trim()
async function command(name, value = '') {
  await request('POST', `/api/session/${id}/command`, { command: name, text: typeof value === 'string' ? value : JSON.stringify(value) })
}
async function registry() {
  const requestID = randomUUID()
  await command('managed', { requestID })
  const reply = await readConfigReceipt(client, id, requestID)
  assert.equal((await client.session.inbox.list({ sessionID: id })).some((item) => item.payload?.text?.startsWith(`custom.config.receipt:${requestID}\n`)), false)
  return reply.registry
}
function pass(name) { rows.push({ name, status: 'PASS' }); console.log(`PASS native ${name}`) }
let error
try {
  const names = new Set((await request('GET', `/api/command?location[directory]=${encodeURIComponent(join(home, 'scratch'))}`)).map((item) => item.name))
  for (const name of ['addprovider', 'addmodel', 'addmcp', 'addmcpprofile', 'addskill', 'addorchestration', 'managed', 'refreshmodels', 'remove-managed', 'ponytail']) assert.ok(names.has(name), name)
  pass('native command registration')
  assert.equal((await request('GET', `/api/session/${id}/context`)).length, 0)
  await registry()
  pass('empty context reads managed receipt from inbox and consumes it without inference')
  const cases = [
    ['addprovider', 'providers', prefix, { id: prefix, name: 'Audit provider', settings: { baseURL: 'http://127.0.0.1:1/v1', apiKey: '{env:AUDIT_API_KEY}' } }],
    ['addmodel', 'models', `${prefix}/coder`, { providerID: prefix, id: 'coder', name: 'Audit model', capabilities: { tools: true, input: ['text'], output: ['text'] } }],
    ['addmcp', 'mcp', prefix, { name: prefix, config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', disabled: true } }],
    ['addmcpprofile', 'mcpProfiles', prefix, { id: prefix, name: 'Audit profile', mcp: [prefix] }],
    ['addskill', 'skills', prefix, { id: prefix, name: 'Audit skill', description: 'Zero-inference fixture', content: 'Verify the bounded change.' }],
    ['addorchestration', 'orchestrations', `${prefix}/orchestrated`, { providerID: prefix, id: 'orchestrated', baseModelID: 'coder', name: 'Audit orchestration', prompt: 'Verify before completion.' }],
  ]
  for (const [name, type, key, value] of cases) {
    const requestID = randomUUID()
    await command(name, { ...value, requestID })
    created.push([type, key])
    assert.equal((await readConfigReceipt(client, id, requestID)).saved, true)
    assert.ok(Object.hasOwn((await registry())[type], key), `${type}/${key}`)
    pass(`${name}: real mutation, reload, receipt and durable read`)
  }
  await command('addmodel', { providerID: prefix, id: 'coder', name: 'Updated audit model' })
  assert.equal((await registry()).models[`${prefix}/coder`].name, 'Updated audit model')
  pass('update existing model')
  await assert.rejects(() => command('addprovider', { id: `${prefix}-bad`, settings: { apiKey: 'literal-not-a-real-secret' } }))
  assert.equal(Object.hasOwn((await registry()).providers, `${prefix}-bad`), false)
  pass('inline credential rejection and rollback')
  await command('refreshmodels')
  assert.ok(Object.hasOwn((await registry()).skills, prefix))
  pass('reload retains durable configuration')
  for (const mode of ['off', 'lite', 'full', 'ultra']) {
    await command('ponytail', mode)
    assert.equal((await readFile(statePath, 'utf8')).trim(), mode)
  }
  pass('Ponytail four native mode changes')
  for (const [type, key] of [...created].reverse()) {
    await command('remove-managed', { type, id: key })
    assert.equal(Object.hasOwn((await registry())[type], key), false)
    created.splice(created.findIndex((item) => item[0] === type && item[1] === key), 1)
  }
  pass('remove all six managed item types')
  const final = await request('GET', `/api/session/${id}`)
  assert.equal(final.cost, 0)
  assert.deepEqual(final.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  pass('zero model tokens and zero model cost')
} catch (caught) {
  error = caught
  rows.push({ name: caught.message, status: 'FAIL' })
} finally {
  const cleanupErrors = []
  for (const [type, key] of [...created].reverse()) {
    try { await command('remove-managed', { type, id: key }) } catch (caught) { cleanupErrors.push(caught.message) }
  }
  try { await command('ponytail', originalMode) } catch (caught) { cleanupErrors.push(caught.message) }
  try { await request('DELETE', `/api/session/${id}`) } catch (caught) { cleanupErrors.push(caught.message) }
  await writeFile(options['--output'], JSON.stringify({ ok: !error && !cleanupErrors.length, engineVersion: service.version, checks: rows, cleanupErrors }, null, 2)+'\n')
  if (cleanupErrors.length) throw new Error(`Native audit cleanup failed: ${cleanupErrors.join('; ')}`)
}
if (error) throw error
