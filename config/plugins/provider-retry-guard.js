const MAX_ATTEMPTS = 3
const MAX_DELAY_MS = 30_000
const AUTH_ERROR = /(?:unauthori[sz]ed|authori[sz]ation|forbidden|authentication|invalid api key|not logged in|login required|token expired)/i
// A 2xx whose stream could not be decoded (truncated SSE, half-written JSON) is
// transient on the Codex/ChatGPT backend, but the engine treats it as terminal.
const DECODE_ERROR = /\bdecode error\b|unexpected end of (?:json|stream)/i
const DECODE_RETRY_DELAY_MS = 3_000

export function applyRetryGuard(event) {
  const status = Number(event?.error?.status)
  const message = `${event?.error?.type || ""} ${event?.error?.message || ""}`

  if (status === 401 || status === 403 || AUTH_ERROR.test(message) || Number(event?.attempt) >= MAX_ATTEMPTS) {
    event.decision = { retry: false }
  } else if (event?.decision?.retry && Number.isFinite(event.decision.delay) && event.decision.delay > MAX_DELAY_MS) {
    event.decision = { retry: true, delay: MAX_DELAY_MS }
  } else if (!event?.decision?.retry && !(status >= 400) && DECODE_ERROR.test(message)) {
    event.decision = { retry: true, delay: DECODE_RETRY_DELAY_MS }
  }
  return event.decision
}

export default {
  id: "provider-retry-guard",
  async setup(ctx) {
    const registration = await ctx.session.hook("retry", applyRetryGuard)
    return () => registration.dispose()
  },
}
