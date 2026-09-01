import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = await readFile(new URL('config/plugins/tui/panel-slash.jsx', root), 'utf8')

for (const marker of [
  'context.keymap.intercept(',
  '"key"',
  'consume()',
  '{ priority: 10_000 }',
  'currentFocusedEditor',
  'parsePanelCommand(promptText(editor))',
  'panelCommandID(parsed)',
  'traits.owner === "opencode"',
  'traits.role === "prompt"',
  'traits.status !== "SHELL"',
  'context.ui.toast(',
  'clearPromptEditor(editor)',
  'context.keymap.dispatchCommand?.(target)',
]) {
  assert.ok(source.includes(marker), `Typed /panel submit contract missing: ${marker}`)
}

for (const forbidden of [
  'bind: "enter"',
  'bind: "return"',
  'context.ui.toast.show(',
  'context.client',
  'sdk.client',
  'session.prompt(',
  'session.command(',
]) {
  assert.ok(!source.includes(forbidden), `Typed /panel router must stay local: ${forbidden}`)
}

assert.match(source, /event\.name !== "return".*event\.name !== "enter".*event\.name !== "kpenter"/s)
assert.match(source, /if \(!isPlainSubmit\(event\)\) return[\s\S]*parsePanelCommand\(promptText\(editor\)\)[\s\S]*if \(!parsed\) return[\s\S]*consume\(\)/)

console.log('Panel submit regression passed: typed /panel is consumed locally before both prompt submit paths')
