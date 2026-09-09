// V2 synthetic(resume:false) replies enter the durable inbox before context.
// Consume only our exact correlation ID; never wake a model to read a receipt.
export async function readConfigReceipt(client, sessionID, requestID) {
  const marker = `custom.config.receipt:${requestID}\n`
  const inbox = await client.session.inbox?.list?.({ sessionID }) || []
  const pending = inbox.find((item) => item.type === "synthetic" && item.payload?.text?.startsWith(marker))
  if (pending) {
    const value = JSON.parse(pending.payload.text.slice(marker.length))
    try { await client.session.inbox.cancel({ sessionID, inboxID: pending.id }) }
    catch (error) {
      // A running session may already have admitted it. Its context hook removes
      // receipts before inference; do not cancel any replacement/user input.
      if (![404, 409].includes(error.status ?? error.statusCode)) throw error
    }
    return value
  }
  const messages = await client.session.context({ sessionID })
  const admitted = messages.find((item) => item.text?.startsWith(marker))
  if (!admitted) throw new Error("Configuration response missing; check config-manager plugin status.")
  return JSON.parse(admitted.text.slice(marker.length))
}
