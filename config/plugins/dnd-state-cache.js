import { startEvents } from '../events.js'

const TOOLS = new Set(['odm_narrator', 'odm_narrator_odm_narrator'])
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sequence = value => Number.isSafeInteger(value) && value >= 0
const keyOf = input => JSON.stringify([input.campaignId, input.projection ?? 'live'])

function decode(result) {
  let value = result
  for (let i = 0; i < 5; i++) {
    if (typeof value === 'string') { value = JSON.parse(value); continue }
    if (!value || value.isError || value.artifactID) return null
    if (value.currentSeq !== undefined || value.state || value.readRequired) return value
    if (value.output !== undefined) { value = value.output; continue }
    if (typeof value.content === 'string') { value = value.content; continue }
    if (Array.isArray(value.content) && value.content.length === 1 && value.content[0].type === 'text') {
      value = value.content[0].text; continue
    }
    return null
  }
  return null
}

// Only acknowledged revisions live here, never cached answers or private campaign text.
export function createDndStateCache() {
  const sessions = new Map()
  function session(id) {
    if (!sessions.has(id)) {
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value)
      sessions.set(id, new Map())
    }
    return sessions.get(id)
  }
  const reset = id => sessions.delete(id)
  function readParams(id, input) {
    if (input.pageCursor) return input // Frozen pages require the original query exactly.
    const result = { projection: 'live', delta: true, paged: true, maxBytes: 131072, ...input }
    if (result.stateDelta === false || Object.keys(result.knownSections ?? {}).length) return result
    result.stateDelta = true
    const known = sessions.get(id)?.get(keyOf(result))
    if (known?.revision) result.knownStateRevision ??= known.revision
    return result
  }
  function prepare(id, input) {
    if (!id || !input?.campaignId) return input
    if (input.operation === 'read') return readParams(id, input)
    if (input.operation === 'connect') return { projection: 'live', stateDelta: true, ...input }
    if (input.operation === 'catalog' && !input.action) return { summaryOnly: true, ...input }
    if (input.readAfter && typeof input.readAfter === 'object') {
      const { campaignId: _campaign, ...readAfter } = readParams(id, { campaignId: input.campaignId, ...input.readAfter })
      return { ...input, readAfter }
    }
    return input
  }
  function observe(states, query, value) {
    const key = keyOf(query), previous = states.get(key)
    let state = value
    if (value?.format === 'odm.read.page.v1') {
      if (!Array.isArray(value.entries) || value.complete !== (value.nextPage === null)) return
      const prior = previous?.page
      if (query.pageCursor && (!prior || prior.nextPage !== query.pageCursor || prior.hash !== value.hash || prior.offset !== value.offset)) return
      if (!query.pageCursor && value.offset !== 0) return
      const fields = query.pageCursor ? { ...prior.fields } : {}
      for (const entry of value.entries) {
        if (['timelineEpoch', 'stateDelta'].includes(entry.key)) fields[entry.key] = entry.value
      }
      if (!value.complete) {
        states.set(key, { ...previous, page: { fields, hash: value.hash, nextPage: value.nextPage, offset: value.offset + value.entries.length } })
        return
      }
      state = { ...fields, currentSeq: value.currentSeq }
    }
    const delta = state?.stateDelta
    if (delta?.format !== 'odm.state.delta.v1' || !digest(delta.revision) || delta.checksum !== delta.revision || !digest(state.timelineEpoch) || !sequence(state.currentSeq)) return
    if (!delta.full && (delta.baseRevision !== previous?.revision || state.timelineEpoch !== previous?.epoch)) return
    if (state.timelineEpoch === previous?.epoch && state.currentSeq < previous.seq) return
    if (states.size >= 16 && !states.has(key)) states.delete(states.keys().next().value)
    states.set(key, { revision: delta.revision, epoch: state.timelineEpoch, seq: state.currentSeq })
  }
  function wrap(execute) {
    return async (input, context) => {
      const id = context.sessionID
      if (!id || !input?.campaignId || context.odmBackgroundRead) return execute(input, context)
      if (input.operation === 'connect') reset(id)
      const states = session(id), prepared = prepare(id, input)
      let result
      try { result = await execute(prepared, context) }
      catch (error) { reset(id); throw error } // Never replay a write.
      if (sessions.get(id) !== states || context.signal?.aborted) return result
      try {
        // A preview/artifact is not an acknowledged baseline. The runtime's default
        // inline budget is 128 KiB; honor a smaller configured limit as well.
        const limit = Math.min(131072, Number(process.env.OPENCODE_TOOL_ARTIFACT_THRESHOLD || 131072))
        if (result?.metadata?.truncated || result?.metadata?.artifactID || Buffer.byteLength(JSON.stringify(result)) > limit) {
          reset(id); return result
        }
        const value = decode(result)
        if (value?.readRequired) { reset(id); return result }
        if (prepared.operation === 'read') observe(states, prepared, value)
        else if (value?.state && value.readAfter) observe(states, { ...value.readAfter, campaignId: input.campaignId }, value.state)
      } catch { reset(id) } // A cache failure must not turn a committed action into an error.
      return result
    }
  }
  return { prepare, wrap, reset }
}

export default {
  id: 'custom.dnd-state-cache',
  async setup(ctx) {
    const cache = createDndStateCache()
    const registration = await ctx.tool.transform(editor => {
      for (const name of TOOLS) if (editor.get(name)) editor.update(name, tool => {
        tool.execute = cache.wrap(tool.execute)
      })
    })
    const compaction = await ctx.session.hook('compaction', event => cache.reset(event.sessionID))
    const stop = startEvents(ctx, event => {
      if (['session.deleted', 'session.moved', 'session.agent.selected', 'session.model.selected'].includes(event.type)) cache.reset(event.data?.sessionID)
    })
    return async () => { stop(); await registration.dispose(); await compaction.dispose() }
  },
}
