import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const tmp = await mkdtemp(join(tmpdir(), "context-lanes-"))
const original = { ...process.env }
try {
  process.env.OPENCODE_CONFIG_DIR = join(tmp, "config", "opencode")
  process.env.XDG_CONFIG_HOME = join(tmp, "config")
  process.env.XDG_DATA_HOME = join(tmp, "data")
  process.env.PONYTAIL_ENABLED = "1"
  process.env.PONYTAIL_CHECKOUT_DIR = join(tmp, "ponytail")
  await mkdir(join(process.env.OPENCODE_CONFIG_DIR, "prompts"), { recursive: true })
  await mkdir(join(process.env.PONYTAIL_CHECKOUT_DIR, "hooks"), { recursive: true })
  await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "prompts", "engineering.md"), "FULL ENGINEERING")
  await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "prompts", "engineering-lite.md"), "LITE KERNEL")
  await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "prompts", "orchestrator.md"), "STATIC QWEN")
  await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "prompts", "orchestrator-sol.md"), "STATIC SOL")
  await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "prompts", "dnd-edition.md"), "STATIC DND")
  await writeFile(
    join(process.env.PONYTAIL_CHECKOUT_DIR, "hooks", "ponytail-instructions.js"),
    "exports.getPonytailInstructions = mode => 'PONYTAIL ' + mode",
  )
  await writeFile(
    join(process.env.PONYTAIL_CHECKOUT_DIR, "hooks", "ponytail-config.js"),
    "exports.getDefaultMode = () => 'full'; exports.normalizePersistedMode = mode => mode",
  )

  const policy = await import(
    pathToFileURL(new URL("../config/plugins/context-policy-lib.js", import.meta.url).pathname).href
  )
  policy.syncManagedOrchestrations({
    "game/dnd-orchestrated": {
      providerID: "game",
      id: "dnd-orchestrated",
      prompt: "RUN DND ONLY",
      contextClass: "bare",
    },
  })

  const plugin = (
    await import(
      pathToFileURL(new URL("../config/plugins/context-lanes.js", import.meta.url).pathname).href
    )
  ).default
  const hooks = {}
  let command
  const registration = () => ({ dispose: async () => {} })
  await plugin.setup({
    session: {
      hook: async (name, fn) => {
        hooks[name] = fn
        return registration()
      },
      synthetic: async () => {},
    },
    command: {
      transform: async (fn) => {
        fn({ add: (value) => (command = value) })
        return registration()
      },
    },
  })

  const bare = {
    sessionID: "bare",
    agent: "build",
    model: { providerID: "game", id: "dnd-orchestrated" },
    system: [{ type: "text", text: "NATIVE CODING RULES" }, { type: "text", text: "PROJECT AGENTS" }],
  }
  await hooks.context(bare)
  assert.deepEqual(
    bare.system.map((x) => x.text),
    ["Managed orchestration game/dnd-orchestrated:\nRUN DND ONLY"],
    "bare orchestration must receive only its own policy",
  )

  const lite = {
    sessionID: "lite",
    agent: "build",
    model: { providerID: "ollama", id: "qwen3.8:27b" },
    system: [{ type: "text", text: "NATIVE HEAVY PROMPT" }],
  }
  await hooks.context(lite)
  assert.deepEqual(lite.system.map((x) => x.text), ["Custom lite execution kernel:\nLITE KERNEL"])

  const normal = {
    sessionID: "normal",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5.6-sol" },
    system: [{ type: "text", text: "NATIVE" }],
  }
  await hooks.context(normal)
  assert.equal(normal.system[0].text, "NATIVE")
  assert.ok(normal.system.some((x) => x.text.includes("FULL ENGINEERING")))
  assert.ok(normal.system.some((x) => x.text.includes("PONYTAIL full")))
  assert.ok(normal.system.some((x) => x.text.startsWith("Custom visible plan policy:")))

  const staticFull = {
    sessionID: "static",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5.6-sol-orchestrated" },
    system: [{ type: "text", text: "NATIVE" }],
  }
  await hooks.context(staticFull)
  assert.ok(staticFull.system.some((x) => x.text === "Custom orchestrated SOL policy:\nSTATIC SOL"))

  const dnd = {
    sessionID: "dnd",
    agent: "dnd-narrator",
    model: { providerID: "openai", id: "gpt-5.6-dnd-edition" },
    system: [
      { type: "text", text: "NATIVE CODING" },
      { type: "text", text: "Custom engineering policy:\nOLD" },
      { type: "text", text: "Ponytail V2 engineering policy (ultra):\nOLD" },
    ],
  }
  await hooks.context(dnd)
  assert.deepEqual(
    dnd.system.map((x) => x.text),
    ["Custom DnD Edition policy:\nSTATIC DND"],
    "DnD Edition must receive only its own policy",
  )

  assert.equal(command.name, "contextclass")
  await command.execute({ sessionID: "normal", prompt: { text: "bare" } })
  normal.system = [{ type: "text", text: "NATIVE AGAIN" }]
  await hooks.context(normal)
  assert.deepEqual(normal.system, [])
  await command.execute({ sessionID: "normal", prompt: { text: "auto" } })
  normal.system = [{ type: "text", text: "NATIVE AGAIN" }]
  await hooks.context(normal)
  assert.ok(normal.system.length > 1)

  console.log("Context lanes regression passed: managed/static bare isolation, DnD-only policy, lite kernel, normal/full layering, override")
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(tmp, { recursive: true, force: true })
}
