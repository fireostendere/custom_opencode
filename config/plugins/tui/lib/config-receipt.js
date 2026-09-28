// V2 synthetic(resume:false) replies enter the durable inbox before context.
// Consume only our exact correlation ID; never wake a model to read a receipt.
//
// Cost: `session.context` returns the whole model context of the session, so
// it is read only after a `session.inbox.delivered` event for this session or
// on a sparse schedule, never on every poll. Inbox polls back off
// exponentially and `session.inbox.enqueued` events (when `options.on` is the
// TUI `context.data.on`) wake the reader at once.
//
// config-manager's context hook strips admitted receipts, so they never reach
// the model (isConfigReceipt).
const POLL_DELAYS_MS = [50, 100, 200, 400, 800]
const MAX_POLL_DELAY_MS = 1_600
const CONTEXT_ATTEMPTS = new Set([2, 5])
const DEFAULT_TIMEOUT_MS = 5_000

function eventData(event) {
  return event?.data ?? event?.properties ?? event
}

async function consume(client, sessionID, inboxID, text, marker) {
  const value = JSON.parse(text.slice(marker.length))
  try { await client.session.inbox.cancel({ sessionID, inboxID }) }
  catch (error) {
    // A running session may already have admitted it; never cancel any
    // replacement/user input.
    if (![404, 409].includes(error.status ?? error.statusCode)) throw error
  }
  return value
}

export async function readConfigReceipt(client, sessionID, requestID, options = {}) {
  const marker = `custom.config.receipt:${requestID}\n`
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let enqueued = null
  let delivered = false
  let wake = null
  const unsubscribers = []
  const listen = (type, handler) => {
    try {
      const unsubscribe = options.on?.(type, handler)
      if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe)
    } catch {}
  }
  listen("session.inbox.enqueued", (event) => {
    const data = eventData(event)
    const text = data?.item?.payload?.text
    if (data?.sessionID !== sessionID || data?.item?.type !== "synthetic") return
    if (typeof text !== "string" || !text.startsWith(marker)) return
    enqueued = { inboxID: data.inboxID, text }
    wake?.()
  })
  listen("session.inbox.delivered", (event) => {
    if (eventData(event)?.sessionID !== sessionID) return
    delivered = true
    wake?.()
  })
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (enqueued) return await consume(client, sessionID, enqueued.inboxID, enqueued.text, marker)
      const inbox = await client.session.inbox?.list?.({ sessionID }) || []
      const pending = inbox.find((item) => item.type === "synthetic" && item.payload?.text?.startsWith(marker))
      if (pending) return await consume(client, sessionID, pending.id, pending.payload.text, marker)
      const final = Date.now() >= deadline
      if (delivered || final || CONTEXT_ATTEMPTS.has(attempt)) {
        delivered = false
        const messages = await client.session.context({ sessionID })
        const admitted = messages.find((item) => item.text?.startsWith(marker))
        if (admitted) return JSON.parse(admitted.text.slice(marker.length))
      }
      if (final) break
      const delay = Math.min(POLL_DELAYS_MS[attempt] ?? MAX_POLL_DELAY_MS, Math.max(0, deadline - Date.now()))
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = null
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe() } catch {}
    }
  }
  throw new Error("Configuration response missing; check config-manager plugin status.")
}
