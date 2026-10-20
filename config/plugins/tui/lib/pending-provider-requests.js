import { Buffer } from 'node:buffer'

// A replacement Request inherits an opaque identity, without keeping its source
// Request/body alive. Sibling HTTP hooks share this weak identity registry.
const identities = new WeakMap()
export function linkProviderRequest(original, replacement) {
  let identity = identities.get(original)
  if (!identity) { identity = {}; identities.set(original, identity) }
  identities.set(replacement, identity)
  return replacement
}

// Error bodies may arrive slowly, or never finish. Cancel the cloned reader on
// lifecycle changes and only retain the small prefix needed to detect rejection.
export async function providerErrorDetail(response, signal, limit = 64 * 1024) {
  let reader
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  try {
    if (signal.aborted) return ''
    reader = response.clone().body?.getReader()
    if (!reader) return ''
    signal.addEventListener('abort', cancel, { once: true })
    const decoder = new TextDecoder()
    let detail = '', size = 0
    while (!signal.aborted && size < limit) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = value.subarray(0, limit - size)
      size += chunk.byteLength
      detail += decoder.decode(chunk, { stream: true })
    }
    return signal.aborted ? '' : detail + decoder.decode()
  } catch {
    return ''
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader?.releaseLock()
  }
}

// Short-lived fallback bodies for http.request/http.response plugins. A request
// that never receives a response must not keep a transcript alive until restart.
export function createPendingProviderRequests({ maxEntries = 256, maxBytes = 16 * 1024 * 1024, ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const pending = new Map()
  const requests = new WeakMap()
  const byIdentity = new WeakMap()
  let bytes = 0, timer, timerAt = Infinity, disposed = false

  function remove(entry, cancel = true) {
    if (!pending.delete(entry)) return
    bytes -= entry.bytes
    entry.body = undefined
    if (cancel) entry.controller?.abort()
    for (const [signal, listener] of entry.listeners) signal.removeEventListener('abort', listener)
    entry.listeners.length = 0
  }
  function arm() {
    const due = pending.size ? Math.min(...[...pending.keys()].map(entry => entry.until)) : Infinity
    if (due === timerAt) return
    clearTimeout(timer)
    timer = undefined
    timerAt = due
    if (due === Infinity || disposed) return
    timer = setTimeout(() => { timer = undefined; timerAt = Infinity; prune() }, Math.max(0, due - now()))
    timer.unref?.()
  }
  function prune() {
    for (const entry of pending.keys()) if (entry.until <= now()) remove(entry)
    arm()
  }
  const matches = (entry, event) => entry.sessionID === event.sessionID
    && (!event.agent || !entry.agent || event.agent === entry.agent)
    && (!event.kind || !entry.kind || event.kind === entry.kind)

  return {
    add(event, body, metadata = {}, aliases = []) {
      prune()
      const size = typeof body === 'string' ? Buffer.byteLength(body) : 0
      const related = [event.request, ...aliases].filter(request => request && typeof request === 'object')
      if (disposed || !event.sessionID || !event.request || !size || size > maxBytes || related.some(request => request.signal?.aborted)) return false
      while (pending.size >= maxEntries || bytes + size > maxBytes) remove(pending.keys().next().value)
      const entry = { ...metadata, sessionID: event.sessionID, agent: event.agent, kind: event.kind,
        body, bytes: size, until: now() + ttlMs, listeners: [] }
      pending.set(entry, true)
      bytes += size
      linkProviderRequest(aliases[0] || event.request, event.request)
      const identity = identities.get(event.request)
      byIdentity.set(identity, byIdentity.has(identity) && byIdentity.get(identity) !== entry ? null : entry)
      for (const request of related) {
        // Reusing an input Request for two attempts makes that alias ambiguous;
        // each newly constructed outgoing Request still identifies its own body.
        requests.set(request, requests.has(request) && requests.get(request) !== entry ? null : entry)
        const signal = request.signal
        if (!signal || entry.listeners.some(([known]) => known === signal)) continue
        const listener = () => { remove(entry); arm() }
        signal.addEventListener('abort', listener, { once: true })
        entry.listeners.push([signal, listener])
      }
      arm()
      return true
    },
    claim(event) {
      prune()
      let entry
      if (event.request) {
        entry = requests.has(event.request) ? requests.get(event.request) : byIdentity.get(identities.get(event.request))
        // A late response (or a Request replaced by another plugin) must never
        // take a newer session's fallback merely because the session ID matches.
        if (!entry || !pending.has(entry) || !matches(entry, event)) return
      } else {
        // Legacy adapters omit request identity. Keep that contract only when
        // exactly one matching request is pending; ambiguous replies cannot retry.
        const candidates = [...pending.keys()].filter(value => matches(value, event))
        if (candidates.length !== 1) return
        entry = candidates[0]
      }
      if (entry.claimed) return
      entry.claimed = true
      entry.controller = new AbortController()
      entry.signal = entry.controller.signal
      // Keep the same mutable entry under the byte/TTL/lifecycle limits while
      // the response body is read. Invalidation clears it even across an await.
      return entry
    },
    release(entry) { remove(entry, false); arm() },
    forget(sessionID) {
      for (const entry of pending.keys()) if (entry.sessionID === sessionID) remove(entry)
      arm()
    },
    stats() { prune(); return { entries: pending.size, bytes } },
    dispose() {
      disposed = true
      for (const entry of pending.keys()) remove(entry)
      clearTimeout(timer)
      timer = undefined
      timerAt = Infinity
    },
  }
}

export const FALLBACK_RESET_EVENTS = new Set([
  'session.execution.failed', 'session.execution.interrupted', 'session.deleted',
  'session.moved', 'session.agent.selected', 'session.model.selected',
])
