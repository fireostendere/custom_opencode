import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const DIR = process.env.OPENCODE_CONFIG_BACKUP_DIR || join(BASE, "backups")
const KEEP = Number(process.env.OPENCODE_CONFIG_BACKUP_KEEP || 20)
// Only this plugin's own fixed-width timestamps are backups it may compare
// against or prune; manual copies in the directory are never touched.
const OWN = /^opencode\.json\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/

export function pruneList(names, keep) {
  return names.slice(0, Math.max(0, names.length - keep))
}

export function backup() {
  const src = [join(BASE, "opencode.json"), join(BASE, "opencode.jsonc")].find((path) => existsSync(path))
  if (!src) return

  // The config can reference credentials: keep the directory and copies private.
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  chmodSync(DIR, 0o700)
  const content = readFileSync(src)
  const files = readdirSync(DIR).filter((file) => OWN.test(file)).sort()
  const latest = files.at(-1)
  if (!latest || !content.equals(readFileSync(join(DIR, latest)))) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
    const name = `opencode.json.${stamp}`
    // wx: never follow or overwrite an existing path (same-second reload).
    if (!files.includes(name)) {
      writeFileSync(join(DIR, name), content, { mode: 0o600, flag: "wx" })
      files.push(name)
    }
  }
  for (const file of pruneList(files, KEEP)) unlinkSync(join(DIR, file))
  for (const file of files.slice(Math.max(0, files.length - KEEP))) {
    const path = join(DIR, file)
    const info = lstatSync(path)
    // Tighten copies written by older versions (0644); never follow a symlink.
    if (info.isFile() && info.mode & 0o077) chmodSync(path, 0o600)
  }
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "config-backup",
  setup() {
    try {
      backup()
    } catch (error) {
      console.warn(`[config-backup] skipped: ${error?.message ?? error}`)
    }
  },
}
