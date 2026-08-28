import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { Plugin } from "@opencode-ai/plugin"

const BASE = `${process.env.HOME}/.config/opencode`
const DIR = `${BASE}/backups`
const KEEP = 20

export function pruneList(names, keep) {
  return names.slice(0, Math.max(0, names.length - keep))
}

function backup() {
  const src = [`${BASE}/opencode.json`, `${BASE}/opencode.jsonc`].find((path) => existsSync(path))
  if (!src) return

  mkdirSync(DIR, { recursive: true })
  const content = readFileSync(src)
  const files = readdirSync(DIR).filter((file) => file.startsWith("opencode.json.")).sort()
  const latest = files.at(-1)
  if (!latest || !content.equals(readFileSync(`${DIR}/${latest}`))) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
    writeFileSync(`${DIR}/opencode.json.${stamp}`, content)
    files.push(`opencode.json.${stamp}`)
  }
  for (const file of pruneList(files, KEEP)) unlinkSync(`${DIR}/${file}`)
}

export default Plugin.define({
  id: "config-backup",
  setup() {
    try {
      backup()
    } catch (error) {
      console.warn(`[config-backup] skipped: ${error?.message ?? error}`)
    }
  },
})
