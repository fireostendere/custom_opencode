import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./opencode-plugin-stub-hooks.mjs', import.meta.url)
const { default: plugin } = await import('../config/plugins/tui/add-wizard.js')
let listener, rows, disposed = 0, closed = 0
const dispatched = [], warnings = []
let nativeCommands = [{ id: 'provider.connect' }]
const editor = {
  plainText: '',
  traits: { owner: 'opencode', role: 'prompt', status: 'NORMAL' },
  clear() { this.plainText = '' },
}
const cleanup = plugin.setup({
  renderer: {
    currentFocusedEditor: editor,
    keyInput: {
      prependListener(name, callback) { listener = callback },
      off(name, callback) { assert.equal(callback, listener); disposed++ },
    },
  },
  keymap: {
    layer(build) { rows = build().commands },
    commands() { return nativeCommands },
    dispatch(id) { dispatched.push(id) },
  },
  ui: {
    slot(slot) { slot.render(); return () => closed++ },
    toast: { show(value) { warnings.push(value.message) } },
  },
  // No client/session/storage: opening accounts must be entirely local.
})

const accounts = rows.find(row => row.slash?.name === 'accounts')
assert.equal(accounts.palette, true)
accounts.run()
assert.deepEqual(dispatched, ['provider.connect'])

function submit(text, extra = {}) {
  editor.plainText = text
  let consumed = false
  listener({ name: 'return', preventDefault() { consumed = true }, stopPropagation() {}, ...extra })
  return consumed
}
assert.equal(submit(' /ACCOUNTS  '), true)
assert.equal(editor.plainText, '')
assert.equal(dispatched.length, 2)
assert.equal(submit('/accounts do-not-send-to-model'), true)
assert.equal(editor.plainText, '')
assert.equal(dispatched.length, 2)
assert.match(warnings.at(-1), /без аргументов/)
for (const text of ['/accounts-other', 'hello', 'explain /accounts']) assert.equal(submit(text), false)
assert.equal(submit('/accounts', { shift: true }), false)
assert.equal(submit('/accounts', { name: 'escape' }), false)
editor.traits.status = 'SHELL'
assert.equal(submit('/accounts'), false)
editor.traits.status = 'NORMAL'
editor.traits.owner = 'dialog'
assert.equal(submit('/accounts'), false)
editor.traits.owner = 'opencode'
nativeCommands = []
assert.equal(submit('/accounts'), true)
assert.match(warnings.at(-1), /Обновите OpenCode V2/)
assert.equal(dispatched.length, 2)
cleanup()
assert.equal(disposed, 1)
assert.equal(closed, 1)
console.log('Accounts slash/palette routing, input isolation and cleanup passed')
