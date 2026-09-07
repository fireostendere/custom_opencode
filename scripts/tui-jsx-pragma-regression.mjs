#!/usr/bin/env node
// Every .jsx plugin that actually contains JSX must declare the OpenTUI solid
// pragma on its first line.
//
// Without `/** @jsxImportSource @opentui/solid */` the JSX transform does not
// target OpenTUI's solid renderer, so elements are created outside the
// RendererContext provider. @opentui/solid then throws "No renderer found"
// (useRenderer / reconciler createElement) at render time.
//
// This class of bug is invisible to logic-only headless tests because they
// normally stub `@opencode-ai/plugin/tui`. The production model selector is
// intentionally JSX-free now; if JSX is ever reintroduced, this scan will
// require the renderer pragma again.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginsDir = join(root, 'config', 'plugins')

const PRAGMA = '/** @jsxImportSource @opentui/solid */'
const JSX_CLOSE = /<\/[a-zA-Z][\w.-]*\s*>/
const JSX_SELF_CLOSING = /<[a-zA-Z][\w.-]*(?:\s[^<>]*)?\/>/

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      await collect(full, out)
    } else if (entry.name.endsWith('.jsx')) {
      out.push(full)
    }
  }
  return out
}

const files = (await collect(pluginsDir)).sort()
assert.ok(files.length > 0, 'no .jsx plugin sources found — scan path is wrong')
const relativeFiles = files.map((file) => relative(root, file))
assert.ok(
  relativeFiles.includes('config/plugins/tui/model-selector.jsx'),
  'model-selector.jsx must be covered by this scan',
)

const withJsx = []
const violations = []

for (const file of files) {
  const rel = relative(root, file)
  const source = await readFile(file, 'utf8')
  const hasJsx = JSX_CLOSE.test(source) || JSX_SELF_CLOSING.test(source)
  const lines = source.split('\n')
  const pragmaLine = lines.findIndex((line) => line.trim() === PRAGMA)

  if (hasJsx) {
    withJsx.push(rel)
    if (pragmaLine !== 0) {
      violations.push(
        pragmaLine === -1
          ? `${rel}: contains JSX but never declares "${PRAGMA}"`
          : `${rel}: contains JSX but the pragma is on line ${pragmaLine + 1}, it must be line 1`,
      )
    }
  } else if (pragmaLine !== -1) {
    console.log(`note: ${rel} declares the pragma but contains no JSX`)
  }
}

assert.deepEqual(
  violations,
  [],
  `JSX plugins must target the OpenTUI solid renderer or they throw "No renderer found":\n  ${violations.join('\n  ')}`,
)

console.log(
  `TUI JSX pragma regression passed: ${withJsx.length} of ${files.length} .jsx plugins contain JSX, all declare @jsxImportSource @opentui/solid on line 1; model-selector.jsx is scanned and currently JSX-free`,
)
