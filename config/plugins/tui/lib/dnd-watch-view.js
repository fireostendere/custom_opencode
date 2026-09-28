/**
 * D&D table watcher status for the sidebar panel.
 *
 * The dnd-watch server plugin writes one JSON file per location into
 * `<state>/dnd-watch/`. This module reads those files asynchronously (re-read
 * only when mtime/size change); the pure view model that turns one session's
 * snapshot into rows lives in dnd-watch-describe.js, shared with the web UI.
 * The files hold statuses, cursors and a short journal — never game text.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export { describeWatch } from "./dnd-watch-describe.js"

export function watchStateDirectory(env = process.env) {
  return join(env.CUSTOM_OPENCODE_STATE_DIR || join(homedir(), ".local", "state", "custom-opencode"), "dnd-watch")
}

const files = new Map()
/** sessionID → snapshot, the freshest file winning when two processes wrote one. */
export async function readWatchStates(directory = watchStateDirectory()) {
  let names
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"))
  } catch {
    files.clear()
    return new Map()
  }
  const paths = new Set(names.map((name) => join(directory, name)))
  for (const path of files.keys()) if (!paths.has(path)) files.delete(path)
  const sessions = new Map()
  for (const path of paths) {
    let info
    try {
      info = await stat(path)
    } catch {
      files.delete(path)
      continue
    }
    const key = `${info.mtimeMs}:${info.size}`
    let value = files.get(path)?.key === key ? files.get(path).value : undefined
    if (value === undefined) {
      try {
        value = JSON.parse(await readFile(path, "utf8"))
      } catch {
        value = null
      }
      files.set(path, { key, value })
    }
    for (const [sessionID, session] of Object.entries(value?.sessions ?? {})) {
      const previous = sessions.get(sessionID)
      if (previous && previous.updatedAt >= value.updatedAt) continue
      sessions.set(sessionID, { ...session, updatedAt: value.updatedAt, ...(value.stoppedAt ? { stoppedAt: value.stoppedAt } : {}) })
    }
  }
  return sessions
}

export function sameWatchStates(a, b) {
  if (a === b) return true
  if (a?.size !== b?.size) return false
  for (const [id, value] of a) if (JSON.stringify(value) !== JSON.stringify(b.get(id))) return false
  return true
}

/** Poll the status files every `intervalMs`; `onChange` runs only on a real change. */
export function watchWatchStates(onChange, options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000))
  const read = options.read ?? readWatchStates
  let current = new Map()
  let timer = null
  let stopped = false
  async function poll() {
    timer = null
    let next = current
    try {
      next = await read()
    } catch {}
    if (stopped) return
    if (!sameWatchStates(current, next)) {
      current = next
      try { onChange(next) } catch {}
    }
    timer = setTimeout(poll, intervalMs)
    timer.unref?.()
  }
  void poll()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** The block appears only for narrator sessions of the table project. */
export function isTableSession(session, snapshot) {
  if (snapshot) return true
  if (String(session?.agent ?? "").startsWith("dnd-")) return true
  return /(^|[\\/])dungeon_master([\\/]|$)/i.test(String(session?.location?.directory ?? ""))
}
