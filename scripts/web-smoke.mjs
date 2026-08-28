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

console.log('Web smoke passed: Markdown safety/rendering + current/compat prompt contracts')
