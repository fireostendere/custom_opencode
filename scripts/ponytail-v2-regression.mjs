import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../config/plugins/ponytail-v2.js'

const tmp = await mkdtemp(join(tmpdir(), 'ponytail-v2-'))
const original = { ...process.env }
try {
  process.env.PONYTAIL_ENABLED = '1'
  process.env.PONYTAIL_CHECKOUT_DIR = join(tmp, 'upstream')
  process.env.XDG_CONFIG_HOME = join(tmp, 'config')
  const hooks = join(process.env.PONYTAIL_CHECKOUT_DIR, 'hooks')
  await mkdir(hooks, { recursive: true })
  await writeFile(join(hooks, 'ponytail-instructions.js'), `exports.getPonytailInstructions = mode => 'Reviewed rules: ' + mode`)
  await writeFile(join(hooks, 'ponytail-config.js'), `exports.getDefaultMode = () => 'full'; exports.normalizePersistedMode = mode => mode`)
  let contextHook, command, disposed = 0
  const receipts = []
  const registration = () => ({ dispose: () => { disposed++ } })
  const cleanup = await plugin.setup({
    session: { hook: async (name, fn) => { assert.equal(name, 'context'); contextHook = fn; return registration() },
      synthetic: async receipt => { assert.equal(receipt.resume, false); receipts.push(receipt) } },
    command: { transform: async fn => { fn({ add: def => { command = def } }); return registration() } },
  })
  assert.equal(command.name, 'ponytail')
  let event = { system: [] }
  contextHook(event); contextHook(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0].text, /Reviewed rules: full/)
  for (const mode of ['lite', 'full', 'ultra', 'off']) {
    await command.execute({ sessionID: 'test', prompt: { text: mode } })
    event = { system: [] }; contextHook(event)
    assert.equal(event.system.length, mode === 'off' ? 0 : 1)
    if (mode !== 'off') assert.match(event.system[0].text, new RegExp('Reviewed rules: ' + mode))
  }
  const state = join(process.env.XDG_CONFIG_HOME, 'opencode', '.ponytail-active')
  assert.equal((await stat(state)).mode & 0o777, 0o600)
  await assert.rejects(command.execute({ sessionID: 'test', prompt: { text: 'invalid' } }), /mode must/)
  assert.equal((await readFile(state, 'utf8')).trim(), 'off')
  await command.execute({ sessionID: 'test', prompt: { text: '' } })
  assert.equal(receipts.at(-1).text, 'Ponytail: off')
  await rm(state); await symlink(join(tmp, 'outside'), state)
  assert.throws(() => contextHook({ system: [] }), /Unsafe/)
  await cleanup(); assert.equal(disposed, 2)
  process.env.PONYTAIL_ENABLED = '0'
  await plugin.setup({})
  console.log('Ponytail V2 regression passed: native context, mode commands, no inference, atomic private state, symlink rejection, cleanup, disabled mode')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(tmp, { recursive: true, force: true })
}
