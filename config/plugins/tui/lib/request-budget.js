// Protocol-aware output ceilings and streaming usage extraction. No credentials,
// message contents or provider response text enter the usage ledger.
export function capRequestBody(body, maximum, finishOnly = false, providerID = "", requestURL = "") {
  const result = structuredClone(body)
  const cap = (old) => Math.max(1, Math.min(maximum, Number(old) > 0 ? Number(old) : maximum))
  if (Array.isArray(result.messages)) {
    const key =
      "max_completion_tokens" in result
        ? "max_completion_tokens"
        : "max_tokens" in result
          ? "max_tokens"
          : providerID === "openai"
            ? "max_completion_tokens"
            : "max_tokens"
    result[key] = cap(result[key])
    if (
      result.thinking?.type === "enabled" &&
      Number(result.thinking.budget_tokens) >= result[key]
    ) {
      // The configured reasoning allocation cannot exceed the total generation
      // allowance. Report the effective cap in the ledger; never raise it.
      result.thinking.budget_tokens = Math.max(1, result[key] - 1)
    }
  } else if ("input" in result) {
    // ponytail: ChatGPT rejects wire caps; the ledger accounts actual output
    // after completion. Add an in-flight cap if that endpoint supports one.
    if (requestURL.startsWith("https://chatgpt.com/backend-api/codex/"))
      delete result.max_output_tokens
    else result.max_output_tokens = cap(result.max_output_tokens)
  } else if (Array.isArray(result.contents)) {
    result.generationConfig ||= {}
    result.generationConfig.maxOutputTokens = cap(result.generationConfig.maxOutputTokens)
  } else
    throw new Error("Unsupported provider request schema: output reservation cannot be enforced")
  if (finishOnly) {
    delete result.tools
    delete result.tool_choice
    delete result.toolConfig
  }
  return result
}

export function normalizeUsage(event, previous = {}) {
  const usage =
    event?.usage || event?.response?.usage || event?.message?.usage || event?.usageMetadata
  if (!usage || typeof usage !== "object") return previous
  const value = { ...previous }
  const number = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined)
  const input = number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount)
  const output = number(usage.output_tokens ?? usage.completion_tokens)
  if (input !== undefined) value.input = input
  if (output !== undefined) value.output = output
  const reasoning = number(
    usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.thoughtsTokenCount,
  )
  if (reasoning !== undefined) value.reasoning = reasoning
  if (number(usage.candidatesTokenCount) !== undefined)
    value.output = usage.candidatesTokenCount + (number(usage.thoughtsTokenCount) || 0)
  const read = number(
    usage.cache_read_input_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cachedContentTokenCount,
  )
  const write = number(usage.cache_creation_input_tokens)
  if (read !== undefined) value.cacheRead = read
  if (write !== undefined) value.cacheWrite = write
  return value
}

export function observeUsage(response, done) {
  let notified = false
  const finish = async (usage, error = null) => {
    if (notified) return
    notified = true
    await done(usage && Object.keys(usage).length ? usage : null, response.status, error)
  }
  if (!response.body) {
    void finish(null, "empty provider response")
    return response
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = "",
    usage = {},
    oversized = false,
    terminal = false
  const parse = (line) => {
    const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!text) return
    if (text === "[DONE]") {
      terminal = true
      return
    }
    try {
      const event = JSON.parse(text)
      usage = normalizeUsage(event, usage)
      terminal ||=
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "message_stop" ||
        Boolean(event.usageMetadata && event.candidates?.some((c) => c.finishReason))
    } catch {
      /* non-JSON SSE fields; never retain response text in the ledger */
    }
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done: ended } = await reader.read()
        if (ended) {
          buffer += decoder.decode()
          if (!oversized) parse(buffer)
          await finish(usage)
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let pos
        while ((pos = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, pos)
          buffer = buffer.slice(pos + 1)
          if (!oversized) parse(line)
          oversized = false
        }
        if (buffer.length > 1048576) {
          buffer = ""
          oversized = true
        }
        // SDKs commonly cancel immediately after [DONE]/message_stop. A flush
        // callback is then never called. Persist usage before forwarding the
        // terminal bytes, and also account for an early consumer cancellation.
        if (terminal) await finish(usage)
        controller.enqueue(value)
      } catch (error) {
        try {
          await finish(usage, String(error?.message || error).slice(0, 300))
        } finally {
          controller.error(error)
        }
      }
    },
    async cancel(reason) {
      try {
        await finish(usage, terminal ? null : "provider stream cancelled before terminal event")
      } finally {
        await reader.cancel(reason)
      }
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
