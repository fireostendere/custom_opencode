import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const DIR = process.env.OPENCODE_CONFIG_BACKUP_DIR || join(BASE, "backups")
const KEEP = Number(process.env.OPENCODE_CONFIG_BACKUP_KEEP || 20)

export function pruneList(names, keep) {
  return names.slice(0, Math.max(0, names.length - keep))
}

function backup() {
  const src = [join(BASE, "opencode.json"), join(BASE, "opencode.jsonc")].find((path) => existsSync(path))
  if (!src) return

  mkdirSync(DIR, { recursive: true })
  const content = readFileSync(src)
  const files = readdirSync(DIR).filter((file) => file.startsWith("opencode.json.")).sort()
  const latest = files.at(-1)
  if (!latest || !content.equals(readFileSync(join(DIR, latest)))) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
    const name = `opencode.json.${stamp}`
    writeFileSync(join(DIR, name), content)
    files.push(name)
  }
  for (const file of pruneList(files, KEEP)) unlinkSync(join(DIR, file))
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
