import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = await readFile(new URL('config/plugins/tui/panel-slash.jsx', root), 'utf8')
const routerUrl = new URL('config/plugins/tui/lib/panel-submit-router.js', root)

for (const marker of [
  'installPanelSubmitRouter',
  'currentFocusedEditor',
  'parsePanelCommand(promptText(editor))',
  'panelCommandID(parsed)',
  'traits.owner === "opencode"',
  'traits.role === "prompt"',
  'traits.status !== "SHELL"',
  'context.ui.toast?.(',
  'clearPromptEditor(editor)',
  'context.keymap.dispatchCommand?.(target)',
]) {
  assert.ok(source.includes(marker), `Typed /panel submit contract missing: ${marker}`)
}

for (const forbidden of [
  'context.keymap.intercept(',
  'bind: "enter"',
  'bind: "return"',
  'context.ui.toast.show(',
  'context.client',
  'sdk.client',
  'session.prompt(',
  'session.command(',
]) {
  assert.ok(!source.includes(forbidden), `Typed /panel router must stay local/compatible: ${forbidden}`)
}

const router = await import(`${routerUrl.href}?contract=${Date.now()}`)

function enterEvent() {
  return {
    name: 'return', eventType: 'press', ctrl: false, meta: false, alt: false,
    option: false, super: false, hyper: false, shift: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
  }
}

assert.equal(router.isPlainSubmit(enterEvent()), true)
assert.equal(router.isPlainSubmit({ ...enterEvent(), shift: true }), false)
assert.equal(router.isPlainSubmit({ ...enterEvent(), name: 'x' }), false)

// Older beta path: renderer keyInput exists, keymap.intercept does not.
let rendererListener
let rendererOff = 0
let interceptTouched = 0
const betaContext = {
  renderer: {
    keyInput: {
      prependListener(name, listener) {
        assert.equal(name, 'keypress')
        rendererListener = listener
      },
      off(name, listener) {
        assert.equal(name, 'keypress')
        assert.equal(listener, rendererListener)
        rendererOff++
      },
    },
  },
  keymap: {
    intercept() {
      interceptTouched++
      throw new Error('must not use intercept when renderer transport exists')
    },
  },
}
let handled = 0
const beta = router.installPanelSubmitRouter(betaContext, () => { handled++; return true })
assert.equal(beta.transport, 'renderer-keyinput')
assert.equal(interceptTouched, 0)
const betaEvent = enterEvent()
rendererListener(betaEvent)
assert.equal(handled, 1)
assert.equal(betaEvent.prevented, true)
assert.equal(betaEvent.stopped, true)
beta.dispose()
assert.equal(rendererOff, 1)

// Ordinary prompt: handler rejects it, event must fall through untouched.
const passContext = {
  renderer: betaContext.renderer,
  keymap: {},
}
const pass = router.installPanelSubmitRouter(passContext, () => false)
const passEvent = enterEvent()
rendererListener(passEvent)
assert.equal(passEvent.prevented, false)
assert.equal(passEvent.stopped, false)
pass.dispose()

// Newer beta path: keymap intercept is available when renderer transport is not.
let interceptCallback
let interceptOptions
let interceptDisposed = 0
const newContext = {
  renderer: {},
  keymap: {
    intercept(name, callback, options) {
      assert.equal(name, 'key')
      interceptCallback = callback
      interceptOptions = options
      return () => { interceptDisposed++ }
    },
  },
}
const modern = router.installPanelSubmitRouter(newContext, () => true)
assert.equal(modern.transport, 'keymap-intercept')
assert.deepEqual(interceptOptions, { priority: 10_000 })
let consumed = 0
interceptCallback({ event: enterEvent(), consume() { consumed++ } })
assert.equal(consumed, 1)
modern.dispose()
assert.equal(interceptDisposed, 1)

// Unknown API surface must never make the plugin fail to load.
const none = router.installPanelSubmitRouter({ renderer: {}, keymap: {} }, () => true)
assert.equal(none.transport, 'none')
assert.doesNotThrow(() => none.dispose())

console.log('Panel submit regression passed: typed /panel is local and loader-compatible across OpenCode beta transports')
