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
  let command, disposed = 0
  const receipts = []
  const registration = () => ({ dispose: () => { disposed++ } })
  const cleanup = await plugin.setup({
    session: {
      synthetic: async receipt => { assert.equal(receipt.resume, false); receipts.push(receipt) },
    },
    command: { transform: async fn => { fn({ add: def => { command = def } }); return registration() } },
  })
  assert.equal(command.name, 'ponytail')
  for (const mode of ['lite', 'full', 'ultra', 'off']) {
    await command.execute({ sessionID: 'test', prompt: { text: mode } })
    assert.equal(receipts.at(-1).text, `Ponytail: ${mode}`)
  }
  const state = join(process.env.XDG_CONFIG_HOME, 'opencode', '.ponytail-active')
  assert.equal((await stat(state)).mode & 0o777, 0o600)
  await assert.rejects(command.execute({ sessionID: 'test', prompt: { text: 'invalid' } }), /mode must/)
  assert.equal((await readFile(state, 'utf8')).trim(), 'off')
  await command.execute({ sessionID: 'test', prompt: { text: '' } })
  assert.equal(receipts.at(-1).text, 'Ponytail: off')

  await rm(state)
  await symlink(join(tmp, 'outside'), state)
  await assert.rejects(
    command.execute({ sessionID: 'test', prompt: { text: '' } }),
    /Unsafe/,
    'state symlink must still be rejected even though prompt injection moved to context-lanes',
  )

  await cleanup()
  assert.equal(disposed, 1)
  process.env.PONYTAIL_ENABLED = '0'
  await plugin.setup({})
  console.log('Ponytail V2 regression passed: mode command, no inference, atomic private state, symlink rejection; injection owned by context-lanes')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(tmp, { recursive: true, force: true })
}
