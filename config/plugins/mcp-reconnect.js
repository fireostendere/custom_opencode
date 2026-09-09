import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const DELAYS = [2000, 10000, 30000]
const TRANSIENT = /connection closed|request timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i

export function createMcpRecovery({ list, connect, now = Date.now, report = () => {} }) {
  const retries = new Map()
  let scanning = false
  let stopped = false
  return {
    stop() { stopped = true },
    async tick() {
      if (stopped || scanning) return
      scanning = true
      try {
        const rows = await list()
        if (stopped) return
        for (const name of retries.keys()) if (!rows.some(row => row.name === name)) retries.delete(name)
        await Promise.all(rows.map(async ({ name, status }) => {
          const previous = retries.get(name)
          if (status?.status === "connected") {
            // A flapping connection must not reset its retry budget on every handshake.
            if (previous) {
              previous.healthySince ??= now()
              if (now() - previous.healthySince >= 60000) retries.delete(name)
            }
            return
          }
          if (status?.status !== "failed" || !TRANSIENT.test(status.error || "")) {
            retries.delete(name)
            return
          }
          const retry = previous || { attempts: 0, next: now() + DELAYS[0] }
          delete retry.healthySince
          retries.set(name, retry)
          if (retry.attempts >= DELAYS.length || now() < retry.next || stopped) return
          // Respect a manual disconnect/removal that happened during the backoff.
          const current = (await list()).find(row => row.name === name)
          if (stopped || current?.status?.status !== "failed" || !TRANSIENT.test(current.status.error || "")) return
          retry.attempts++
          report({ server: name, attempt: retry.attempts, state: "reconnecting" })
          let connected = false
          try {
            await connect(name)
            const result = (await list()).find(row => row.name === name)
            connected = result?.status?.status === "connected"
            report({ server: name, attempt: retry.attempts, state: result?.status?.status || "removed" })
          } catch {
            report({ server: name, attempt: retry.attempts, state: "failed" })
          }
          retry.next = now() + (DELAYS[retry.attempts] ?? 0)
          if (!connected && retry.attempts === DELAYS.length) report({ server: name, state: "retry-budget-exhausted" })
        }))
      } finally { scanning = false }
    },
  }
}

export default {
  id: "custom.mcp-reconnect",
  async setup(ctx) {
    // Use only this process's loopback service. Never send its credential to a
    // configured remote endpoint or let a standalone instance control another server.
    const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local/state")
    let service
    let url
    try {
      service = JSON.parse(await readFile(join(stateRoot, "opencode/service.json"), "utf8"))
      url = new URL(service.url)
    }
    catch { return }
    if (service.pid !== process.pid || typeof service.password !== "string" || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return
    const controller = new AbortController()
    const recovery = createMcpRecovery({
      list: async () => (await ctx.mcp.list()).data,
      connect: async (name) => {
        const endpoint = new URL(`/api/mcp/${encodeURIComponent(name)}/connect`, url)
        endpoint.searchParams.set("location[directory]", ctx.location.directory)
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error",
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]),
        })
        if (!response.ok) throw new Error(`MCP reconnect HTTP ${response.status}`)
      },
      report: (event) => console.info("mcp automatic recovery", JSON.stringify(event)),
    })
    const timer = setInterval(() => { void recovery.tick().catch(() => {}) }, 2000)
    timer.unref?.()
    return () => { recovery.stop(); clearInterval(timer); controller.abort() }
  },
}
