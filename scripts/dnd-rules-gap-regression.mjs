import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { filterDndTools } from '../config/plugins/orchestrated-qwen.js'

const root = await mkdtemp(join(tmpdir(), 'opencode-dnd-gaps-'))
const home = process.env.HOME
process.env.HOME = root
const { default: plugin, recordGap, DEBT_FILE } = await import('../config/plugins/dnd-rules-gap.js')
process.env.HOME = home
const file = join(root, 'DND_TECH_DEBT.jsonl')
const gap = { edition: '5e-2024', feature: 'Speak with Dead', source: 'SRD 5.2.1 / Speak with Dead', missing: 'No executable effect plan', expected: 'Five questions to a corpse; no compelled truth; ten-minute duration.', workaround: 'Paid normal slot and action; corpse dialogue adjudicated by narrator.' }
try {
  const first = await recordGap(file, 'campaign', gap)
  assert.equal((await recordGap(file, 'campaign', gap)).id, first.id)
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1)
  await recordGap(file, 'campaign', { ...gap, edition: '5e-2014' })
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2)
  await assert.rejects(recordGap(file, 'campaign', { ...gap, expected: '' }))
  await assert.rejects(recordGap(file, 'campaign', { ...gap, path: '/etc/passwd' }))
  let refused = false
  const tools = new Map([['odm_narrator', { execute: async input => ({ content: input.operation === 'invoke' ? refused ? '{"error":"refused"}' : '{"result":{"ok":true}}' : '{"currentSeq":1}' }) }]])
  await plugin.setup({ location: { directory: root }, permission: { assert: async () => {} }, tool: { transform: async fn => fn({ get: n => tools.get(n), update: (n, fn) => fn(tools.get(n)), add: t => tools.set(t.name, t) }) } })
  const context = { sessionID: 'session' }
  await assert.rejects(tools.get('dnd_rules_gap').execute(gap, context), /Connect/)
  await tools.get('odm_narrator').execute({ operation: 'read', campaignId: '00000000-0000-0000-0000-000000000001' }, context)
  const result = JSON.parse((await tools.get('dnd_rules_gap').execute(gap, context)).content)
  assert(result.id)
  const call = { operation: 'invoke', campaignId: '00000000-0000-0000-0000-000000000001', name: 'use_spell_slot', args: { manualResolution: { ...gap, missing: 'No question limit tracker' } } }
  const receipt = await tools.get('odm_narrator').execute(call, context)
  assert.equal(receipt.content, '{"result":{"ok":true}}', 'logging leaves the authoritative receipt intact')
  assert.equal((await readFile(DEBT_FILE, 'utf8')).trim().split('\n').length, 2, 'a successful manual cast is logged automatically')
  await tools.get('odm_narrator').execute(call, context)
  assert.equal((await readFile(DEBT_FILE, 'utf8')).trim().split('\n').length, 2, 'recovered receipts deduplicate')
  refused = true
  await tools.get('odm_narrator').execute({ ...call, args: { manualResolution: { ...gap, missing: 'Rejected cast' } } }, context)
  assert.equal((await readFile(DEBT_FILE, 'utf8')).trim().split('\n').length, 2, 'refusals are not recorded as successful workarounds')
  refused = false
  await rm(DEBT_FILE); await mkdir(DEBT_FILE)
  const brokenJournal = await tools.get('odm_narrator').execute(call, context)
  assert.equal(brokenJournal.content, receipt.content, 'a journal failure cannot corrupt a successful game receipt')
  assert(brokenJournal.metadata.rulesGapWarning)
  assert.deepEqual(filterDndTools(['shell', 'edit', 'dnd_rules_gap', 'dnd_knowledge_search']), ['dnd_rules_gap', 'dnd_knowledge_search'])
} finally { await rm(root, { recursive: true, force: true }) }
console.log('D&D rules gaps: durable deduplication, edition separation, validation, bound campaign and tool isolation passed')
