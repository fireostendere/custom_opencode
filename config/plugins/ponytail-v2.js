// Native OpenCode V2 bridge to the reviewed upstream Ponytail instruction builder.
// The upstream OpenCode entrypoint uses V1 hooks, which V2 does not register.
import { createRequire } from "node:module"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const MODES = new Set(["off", "lite", "full", "ultra"])
const MARKER = "Ponytail V2 engineering policy"

export default {
  id: "custom.ponytail-v2",
  async setup(ctx) {
    if (process.env.PONYTAIL_ENABLED === "0") return
    const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const root = process.env.PONYTAIL_CHECKOUT_DIR || join(data, "opencode", "ponytail")
    const { getPonytailInstructions } = require(join(root, "hooks", "ponytail-instructions.js"))
    const { getDefaultMode, normalizePersistedMode } = require(join(root, "hooks", "ponytail-config.js"))
    const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
    const target = join(directory, ".ponytail-active")
    const readMode = () => {
      try {
        const info = lstatSync(target)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Ponytail state path")
        const mode = normalizePersistedMode(readFileSync(target, "utf8").trim())
        if (!MODES.has(mode)) throw new Error("Invalid Ponytail mode in state file")
        return mode
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        return getDefaultMode()
      }
    }
    const registrations = await Promise.all([
      ctx.session.hook("context", (event) => {
        if (!Array.isArray(event.system)) return
        const mode = readMode()
        if (mode === "off" || event.system.some((part) => String(part?.text ?? part).startsWith(MARKER))) return
        event.system.push({ type: "text", text: `${MARKER} (${mode}):\n${getPonytailInstructions(mode)}` })
      }),
      ctx.command.transform((commands) => commands.add({
        name: "ponytail",
        description: "Show Ponytail mode or set off / lite / full / ultra (no model call)",
        execute: async ({ sessionID, prompt }) => {
          const requested = String(prompt?.text || "").trim().toLowerCase()
          let mode = readMode()
          if (requested) {
            if (!MODES.has(requested)) throw new Error("Ponytail mode must be off, lite, full or ultra")
            mkdirSync(directory, { recursive: true, mode: 0o700 })
            const temporary = join(directory, `.ponytail-${randomUUID()}.tmp`)
            try {
              writeFileSync(temporary, `${requested}\n`, { mode: 0o600, flag: "wx" })
              renameSync(temporary, target)
            } finally { rmSync(temporary, { force: true }) }
            mode = requested
          }
          await ctx.session.synthetic({ sessionID, text: `Ponytail: ${mode}`, resume: false })
        },
      })),
    ])
    return async () => Promise.allSettled(registrations.map((item) => item?.dispose?.()))
  },
}
