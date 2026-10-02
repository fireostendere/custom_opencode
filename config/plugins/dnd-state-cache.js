import { startEvents } from '../events.js'

const TOOLS = new Set(['odm_narrator', 'odm_narrator_odm_narrator'])
const RESET_EVENTS = new Set([
  'session.deleted', 'session.moved', 'session.agent.selected', 'session.model.selected',
  'session.execution.interrupted',
  'session.compaction.started', 'session.compaction.ended', 'session.compacted',
])
// The installer caps native tool output at 48 000 bytes (tool_output.max_bytes);
// a bigger ODM page is clipped by the host, the model sees a broken JSON page and
// this cache has to drop its baseline. Ask for pages that always fit.
const PAGE_BYTES = 45056
const WRITES = new Set(['invoke', 'narrate', 'release_floor', 'delete_message', 'edit_message', 'autopilot_action', 'finish_global_round'])
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
  function takePendingRead(id) {
    const states = sessions.get(id)
    for (const { page } of states?.values() ?? []) {
      if (!page) continue
      const key = JSON.stringify([page.query.campaignId, page.hash, page.nextPage])
      if (states.continuation === key) return
      states.continuation = key // One wake per cursor, including a failed delivery; never loop paid turns.
      return { ...page.query, operation: 'read', pageCursor: page.nextPage }
    }
  }
  function readParams(id, input) {
    if (input.pageCursor) {
      // Frozen pages require the first page's exact query. The model echoes only its own
      // arguments, so replay the prepared one or every continuation is a 409.
      const page = sessions.get(id)?.get(keyOf(input))?.page
      return page?.nextPage === input.pageCursor ? { ...page.query, pageCursor: input.pageCursor } : input
    }
    const requested = Number(input.maxBytes)
    const result = { projection: 'live', delta: true, paged: true, ...input, maxBytes: Number.isSafeInteger(requested) ? Math.min(requested, PAGE_BYTES) : PAGE_BYTES }
    if (result.stateDelta === false || Object.keys(result.knownSections ?? {}).length) return result
    result.stateDelta = true
    const known = sessions.get(id)?.get(keyOf(result))
    if (known?.revision) result.knownStateRevision ??= known.revision
    return result
  }
  function prepare(id, input) {
    if (!id || !input?.campaignId) return input
    if (WRITES.has(input.operation) || ['set_floor', 'request_response', 'end_campaign'].includes(input.operation)) {
      const page = [...sessions.get(id)?.values() ?? []].find(state => state.page?.query.campaignId === input.campaignId)?.page
      if (page) throw new Error(`Finish reading ODM before writing: call read with ${JSON.stringify({ ...page.query, operation: 'read', pageCursor: page.nextPage })}. Drain all nextPage continuations first; no action was sent.`)
    }
    if (input.operation === 'read') return readParams(id, input)
    if (input.operation === 'connect') return { projection: 'live', stateDelta: true, ...input }
    if (input.operation === 'catalog' && !input.action) return { summaryOnly: true, ...input }
    if (input.operation === 'snapshot') {
      // The model copies read options here; ODM rejects them and the step is wasted.
      const { projection: _p, stateDelta: _s, knownStateRevision: _k, delta: _d, paged: _g, maxBytes: _m, ...snapshot } = input
      return snapshot
    }
    if (input.readAfter && typeof input.readAfter === 'object') {
      const { campaignId: _campaign, ...readAfter } = readParams(id, { campaignId: input.campaignId, ...input.readAfter })
      return { ...input, readAfter }
    }
    // Without readAfter the sidecar attaches a full live state to every write.
    // Ask for the bounded delta against the acknowledged baseline instead.
    if ((input.readAfter === undefined || input.readAfter === true) && WRITES.has(input.operation)) {
      const { campaignId: _campaign, ...readAfter } = readParams(id, { campaignId: input.campaignId })
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
        const query0 = query.pageCursor ? prior.query : query
        states.set(key, { ...previous, page: { fields, hash: value.hash, nextPage: value.nextPage, offset: value.offset + value.entries.length, query: query0 } })
        return
      }
      state = { ...fields, currentSeq: value.currentSeq }
      const { page: _completed, ...acknowledged } = previous ?? {}
      states.set(key, acknowledged) // Finishing the pages clears the barrier even with stateDelta:false.
    }
    const delta = state?.stateDelta
    if (delta?.format !== 'odm.state.delta.v1' || !digest(delta.revision) || delta.checksum !== delta.revision || !digest(state.timelineEpoch) || !sequence(state.currentSeq)) return
    if (!delta.full && (delta.baseRevision !== previous?.revision || state.timelineEpoch !== previous?.epoch)) return
    if (state.timelineEpoch === previous?.epoch && state.currentSeq < previous.seq) return
    if (states.size >= 16 && !states.has(key)) states.delete(states.keys().next().value)
    states.set(key, { revision: delta.revision, epoch: state.timelineEpoch, seq: state.currentSeq })
  }
  // A complete single page carries paging scaffolding (shape, hash, a key/index wrapper
  // per item) the model never needs: hand it the plain object, empty arrays left out as
  // the page left them out. Multi-page reads stay pages; their cursors matter.
  function plainPage(value) {
    if (value?.format !== 'odm.read.page.v1' || !value.complete || value.offset !== 0 || !value.shape) return value
    const state = {}
    for (const entry of value.entries) {
      if (value.shape[entry.key] === 'array') (state[entry.key] ??= []).push(entry.value)
      else state[entry.key] = entry.value
    }
    return state
  }
  function withText(result, before, after) {
    if (after === before) return result
    const text = JSON.stringify(after)
    return { ...result, content: typeof result.content === 'string' ? text : [{ type: 'text', text }] }
  }
  // The same schema lookup again in one session is already in the model's context
  // (a compaction or reconnect resets the session). Say so instead of resending it.
  function repeatCatalog(states, query, result) {
    const text = typeof result?.content === 'string' ? result.content
      : Array.isArray(result?.content) && result.content.length === 1 && result.content[0].type === 'text' ? result.content[0].text : null
    if (!text || result.isError) return result
    const seen = states.catalogs ??= new Map(), key = JSON.stringify({ ...query, campaignId: undefined })
    if (seen.get(key) !== text) { seen.set(key, text); return result }
    return withText(result, null, { unchanged: true, note: 'Same catalog answer as your earlier call with these arguments in this session.' })
  }
  function wrap(execute) {
    return async (input, context) => {
      const id = context.sessionID
      if (!id || !input?.campaignId || context.odmBackgroundRead) return execute(input, context)
      if (input.operation === 'connect') reset(id)
      const states = session(id), prepared = prepare(id, input)
      // Never replay a write. A refused or lost call leaves the acknowledged baseline
      // valid (the server diffs from it or answers with a full resync), so errors pass
      // through without a reset; dropping it made every engine refusal resend ~11 KB of sheets.
      const result = await execute(prepared, context)
      if (sessions.get(id) !== states || context.signal?.aborted) return result
      try {
        // A preview/artifact is not an acknowledged baseline. The runtime's default
        // inline budget is 128 KiB; honor a smaller configured limit as well.
        const limit = Math.min(131072, Number(process.env.OPENCODE_TOOL_ARTIFACT_THRESHOLD || 131072))
        if (result?.metadata?.truncated || result?.metadata?.artifactID || Buffer.byteLength(JSON.stringify(result)) > limit) {
          reset(id); return result
        }
        if (prepared.operation === 'catalog') return repeatCatalog(states, prepared, result)
        const value = decode(result)
        if (value?.readRequired) { reset(id); return result }
        if (prepared.operation === 'read') {
          observe(states, prepared, value)
          return withText(result, value, plainPage(value))
        }
        if (value?.state && value.readAfter) {
          observe(states, { ...value.readAfter, campaignId: input.campaignId }, value.state)
          return withText(result, value, { ...value, state: plainPage(value.state) })
        }
      } catch { reset(id) } // A cache failure must not turn a committed action into an error.
      return result
    }
  }
  return { prepare, wrap, reset, takePendingRead }
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
    // The native host has no 'compaction' hook; compaction is observable only
    // as session events. A compacted transcript no longer proves the baseline.
    const stop = startEvents(ctx, async event => {
      const id = event.data?.sessionID
      if (RESET_EVENTS.has(event?.type)) cache.reset(id)
      if (!['session.idle', 'session.execution.succeeded'].includes(event?.type) || !id || !ctx.session?.get || !ctx.session?.synthetic) return
      try {
        const session = await ctx.session.get({ sessionID: id })
        if (session.parentID || session.location?.directory !== ctx.location?.directory
          || !(session.agent === 'dnd-luna-reserve' || /^dnd-narrator(?:-|$)/.test(session.agent ?? ''))) return
        const read = cache.takePendingRead(id)
        if (!read) return
        await ctx.session.synthetic({ sessionID: id, delivery: 'queue', resume: true,
          text: `ODM read continuation (host bookkeeping, not a player action; never quote it): call odm_narrator with ${JSON.stringify(read)}. Drain every nextPage before writing or finishing. Do not replay any committed action.`,
          metadata: { dndReadContinuation: read },
        })
      } catch {} // A failed notification leaves writes blocked, without retrying model execution.
    })
    return async () => { stop(); await registration?.dispose?.() }
  },
}
