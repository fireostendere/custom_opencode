import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { decode } from './dnd-art.js'

const fields = ['edition', 'feature', 'source', 'missing', 'expected', 'workaround']
const schema = { type: 'object', additionalProperties: false, required: fields,
  properties: Object.fromEntries(fields.map(name => [name, { type: 'string', minLength: 1, maxLength: 2000 }])) }
export const DEBT_FILE = join(homedir(), '.local', 'state', 'opencode', 'dnd', 'DND_TECH_DEBT.jsonl')

export async function recordGap(file, campaignId, input) {
  if (!input || Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000)) throw Error('Supply edition, feature, source, missing, expected and workaround (1–2000 characters each)')
  const gap = Object.fromEntries(fields.map(key => [key, input[key].trim()]))
  const id = createHash('sha256').update(JSON.stringify([campaignId, ...['edition', 'feature', 'missing'].map(key => gap[key].toLowerCase())])).digest('hex').slice(0, 24)
  let text = ''
  try { text = await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  // ponytail: O(n) local journal scan; index if it grows large. Builders group concurrent duplicates by id.
  if (text.split('\n').some(line => line && JSON.parse(line).id === id)) return { id, file, existing: true }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await appendFile(file, JSON.stringify({ id, status: 'open', createdAt: new Date().toISOString(), campaignId, ...gap }) + '\n', { mode: 0o600, flush: true })
  return { id, file, existing: false }
}

export default {
  id: 'custom.dnd-rules-gap',
  async setup(ctx) {
    const bound = new Map()
    // Serialize this location's appends; no general file-writing capability is exposed.
    let queue = Promise.resolve()
    const record = (campaignId, input) => {
      const next = queue.then(() => recordGap(DEBT_FILE, campaignId, input))
      queue = next.catch(() => {})
      return next
    }
    await ctx.tool.transform(editor => {
      for (const name of ['odm_narrator', 'odm_narrator_odm_narrator']) if (editor.get(name)) editor.update(name, tool => {
        const execute = tool.execute
        tool.execute = async (input, context) => {
          const result = await execute(input, context)
          let value
          try { value = decode(result) } catch { return result }
          if (['connect', 'read'].includes(input.operation) && /^[a-f0-9-]{36}$/i.test(input.campaignId ?? '')) {
            if (bound.size >= 128) bound.delete(bound.keys().next().value)
            bound.set(context.sessionID, input.campaignId)
          }
          if (input.operation === 'invoke' && input.name === 'use_spell_slot' && input.args?.manualResolution && value?.ok === true && bound.get(context.sessionID) === input.campaignId) {
            try { await record(input.campaignId, input.args.manualResolution) }
            catch {
              // Keep the receipt byte-for-byte parseable by the state cache.
              console.warn('[dnd-rules-gap] Journal unavailable; the ODM action must not be replayed')
              return { ...result, metadata: { ...result.metadata, rulesGapWarning: 'Journal unavailable; do not repeat the ODM action.' } }
            }
          }
          return result
        }
      })
      editor.add({ name: 'dnd_rules_gap', description: 'Record one missing engine mechanic for a future builder in the fixed private DND_TECH_DEBT.jsonl journal. Requires ODM connect/read. Supply a concise rules specification, source/edition and actual workaround; no private Ask, whispers, plot, raw player instructions or code. Narrative-only improvisation needs no debt. Does not execute code or change game state.',
        input: schema, options: { pinned: true, codemode: false },
        execute: async (input, context) => {
          await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: 'tool', messageID: context.messageID, id: context.id }, action: 'dnd_rules_gap', resources: ['*'] })
          const campaignId = bound.get(context.sessionID)
          if (!campaignId) throw Error('Connect/read the campaign before recording a rules gap')
          return { content: JSON.stringify(await record(campaignId, input)) }
        },
      })
    })
  },
}
