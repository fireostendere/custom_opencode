#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const listeners = new Map()
const pending = []
const row = {
  hidden: true, dataset: {},
  querySelector(selector) { return selector.includes('badge') ? badge : reason },
}
const badge = { textContent: '' }, reason = { textContent: '' }
const summary = { textContent: '', dataset: {} }
const banner = { hidden: false, dataset: { permissionSession: 'A', permissionId: 'p1' } }
const permissionText = { append() {} }
globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn) } }
globalThis.document = {
  hidden: false,
  getElementById(id) { return ({ permissionBanner: banner, permissionRisk: row, permissionSummary: summary })[id] || null },
  querySelector(selector) { return selector === '#permissionBanner .permission-text' ? permissionText : null },
  addEventListener(name, fn) { listeners.set(name, fn) },
  createElement() { return row },
}
globalThis.location = { hash: '#/session/A' }
globalThis.MutationObserver = class { observe() {} }
globalThis.setInterval = () => 1
globalThis.fetch = (path) => new Promise((resolveResponse) => pending.push({ path, resolveResponse }))

const file = resolve('app/control-plane.js')
const source = readFileSync(file, 'utf8').replace("'./refresh-coalescer.js'", `'${pathToFileURL(resolve('app/refresh-coalescer.js')).href}'`)
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
assert.equal(pending.length, 1)

location.hash = '#/session/B'
banner.dataset = { permissionSession: 'B', permissionId: 'p2' }
listeners.get('hashchange')()
pending.shift().resolveResponse({ ok:true, json:async () => ({ permissionID:'p1', risk:'R4', preview:'stale', auto:true }) })
await new Promise((resolveTick) => setTimeout(resolveTick, 0))
assert.equal(summary.textContent, '', 'old session result must not replace permission copy')
assert.equal(row.hidden, true, 'old session result must not show a stale risk')
assert.equal(pending.length, 1, 'session switch must recheck the current permission')

pending.shift().resolveResponse({ ok:true, json:async () => ({ permissionID:'p2', risk:'R2', preview:'current', auto:false }) })
await new Promise((resolveTick) => setTimeout(resolveTick, 0))
assert.equal(summary.textContent, 'current')
assert.equal(row.dataset.risk, 'R2')
console.log('Permission risk ignores stale session response')
