import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loadSource = async (relative) => {
  const source = readFileSync(resolve(root, relative), 'utf8')
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

const markdown = await loadSource('app/markdown.js')
const rendered = markdown.renderMarkdown('# Header\n\n```js\nconst x = 1\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>')
if (!rendered.includes('copy-code')) throw new Error('Markdown code copy control missing')
if (!rendered.includes('<table')) throw new Error('Markdown table rendering failed')
if (rendered.includes('<script>')) throw new Error('Raw HTML was not escaped')

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: { get: () => 'application/json' },
  json: async () => value,
  text: async () => typeof value === 'string' ? value : JSON.stringify(value),
})

const api = await loadSource('app/api.js')
let calls = []
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options })
  return response(200, { data: { ok: true } })
}
await api.sendPrompt({ id: 'ses_native' }, { text: 'hello', files: [{ uri: 'data:text/plain;base64,WA==', name: 'x' }], delivery: 'queue' })
let body = JSON.parse(calls.at(-1).options.body)
if (body.delivery !== 'queue' || body.prompt?.text !== 'hello') throw new Error('Current V2 prompt contract regression')

calls = []
let attempt = 0
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options })
  attempt++
  return attempt === 1 ? response(422, 'unsupported shape') : response(200, { data: { ok: true } })
}
await api.sendPrompt({ id: 'ses_compat' }, { text: 'fallback', files: [], delivery: 'steer' })
body = JSON.parse(calls.at(-1).options.body)
if (body.text !== 'fallback' || body.delivery !== 'steer') throw new Error('Compatibility prompt fallback regression')

const enhancements = await loadSource('app/enhancements.js')
if (enhancements.parseSlash('/status')?.command !== 'status') throw new Error('Slash parser failed')
if (enhancements.parseSlash('/doctor')?.command !== 'doctor') throw new Error('Doctor slash parser failed')
if (enhancements.parseSlash('/review foo bar')?.arguments !== 'foo bar') throw new Error('Slash arguments parser failed')
if (enhancements.parseSlash('ordinary text') !== null) throw new Error('Slash parser accepted normal text')
if (enhancements.commandName({ name:'/init' }) !== 'init') throw new Error('Slash command normalization failed')
if (enhancements.windowLabel(300) !== 'Сессия · 5ч' || enhancements.windowLabel(10080) !== 'Неделя · 7д') throw new Error('Rate-limit window labels failed')

const ui = await loadSource('app/ui-enhancements.js')
const zeroCost = [{ input:0, output:0, cache:{ read:0, write:0 } }]
const paidCost = [{ input:0.1, output:0, cache:{ read:0, write:0 } }]
if (!ui.isFreeModel({ id:'dynamic-free', cost:zeroCost })) throw new Error('Zero-cost model was not grouped as free')
if (ui.isFreeModel({ id:'paid-model', cost:paidCost })) throw new Error('Paid model was incorrectly grouped as free')
if (!ui.isFreeModel({ id:'hy3-free' })) throw new Error('Free-ID fallback failed')
if (!ui.isFreeModel({ id:'big-pickle' })) throw new Error('Big Pickle free fallback failed')

const doctor = await loadSource('app/doctor.js')
if (typeof doctor.openDoctor !== 'function') throw new Error('Doctor UI module does not export openDoctor')

console.log('Web smoke passed: Markdown + prompt contracts + slash/doctor parsing + free-model classification')
