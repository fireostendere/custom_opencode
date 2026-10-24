import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { filterDndTools } from '../config/plugins/orchestrated-qwen.js'

const root = await mkdtemp('/tmp/opencode/dnd-gaps-')
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
  const tools = new Map([['odm_narrator', { execute: async () => ({ content: '{"currentSeq":1}' }) }]])
  await plugin.setup({ location: { directory: root }, permission: { assert: async () => {} }, tool: { transform: async fn => fn({ get: n => tools.get(n), update: (n, fn) => fn(tools.get(n)), add: t => tools.set(t.name, t) }) } })
  const context = { sessionID: 'session' }
  await assert.rejects(tools.get('dnd_rules_gap').execute(gap, context), /Connect/)
  await tools.get('odm_narrator').execute({ operation: 'read', campaignId: '00000000-0000-0000-0000-000000000001' }, context)
  const result = JSON.parse((await tools.get('dnd_rules_gap').execute(gap, context)).content)
  assert(result.id)
  const receipt = await tools.get('odm_narrator').execute({ operation: 'invoke', campaignId: '00000000-0000-0000-0000-000000000001', name: 'use_spell_slot', args: { manualResolution: gap } }, context)
  assert.equal(receipt.content, '{"currentSeq":1}', 'logging leaves the authoritative receipt intact')
  assert.equal((await readFile(DEBT_FILE, 'utf8')).trim().split('\n').length, 1, 'automatic and explicit reports deduplicate')
  assert.deepEqual(filterDndTools(['shell', 'edit', 'dnd_rules_gap', 'dnd_knowledge_search']), ['dnd_rules_gap', 'dnd_knowledge_search'])
} finally { await rm(root, { recursive: true, force: true }) }
console.log('D&D rules gaps: durable deduplication, edition separation, validation, bound campaign and tool isolation passed')
