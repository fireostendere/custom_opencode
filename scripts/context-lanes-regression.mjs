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
    pathToFileURL(new URL("../config/plugins/tui/lib/context-policy.js", import.meta.url).pathname).href
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
  const gameSkills = []
  let command
  const registration = () => ({ dispose: async () => {} })
  await plugin.setup({
    skill: { list: async () => ({ data: gameSkills }) },
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
  gameSkills.push({ id: 'odm-narrator', content: 'NARRATOR' }, { id: 'odm-dm-policy', content: 'POLICY' }, { id: 'odm-development', content: 'CODING' })
  await hooks.context(dnd)
  assert.deepEqual(dnd.system.slice(-2).map(item => item.text), ['Required game skill already loaded: odm-dm-policy\nPOLICY', 'Required game skill already loaded: odm-narrator\nNARRATOR'])
  assert.ok(!dnd.system.some(item => item.text.includes('CODING')), 'preloading must stay game-only')
  gameSkills.length = 0

  const dndPinnedModel = {
    sessionID: "dnd-pinned",
    agent: "dnd-narrator",
    model: { providerID: "openai", id: "gpt-5.6-sol" },
    system: [{ type: "text", text: "GENERIC CODING STARTUP" }],
  }
  await hooks.context(dndPinnedModel)
  assert.deepEqual(
    dndPinnedModel.system.map((x) => x.text),
    ["Custom DnD Edition policy:\nSTATIC DND"],
    "DnD agent must stay bare after its agent-level direct SOL model pin takes effect",
  )

  const dndModelLane = {
    sessionID: "dnd-model",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5.6-dnd-edition" },
    system: [
      { type: "text", text: "AGENTS.md: repository coding instructions" },
      { type: "text", text: "Ponytail V2 engineering policy (full): coding" },
      { type: "text", text: "Custom orchestrator coding prompt" },
      { type: "text", text: "builder prompt" },
      { type: "text", text: "reviewer prompt" },
      { type: "text", text: "planner prompt" },
      { type: "text", text: "SOLID/Torvalds policy" },
    ],
  }
  await hooks.context(dndModelLane)
  const dndTexts = dndModelLane.system.map((x) => x.text)
  assert.deepEqual(dndTexts, ["Custom DnD Edition policy:\nSTATIC DND"])
  for (const marker of ["AGENTS.md", "Ponytail", "orchestrator", "builder", "reviewer", "planner", "SOLID", "Torvalds"])
    assert.ok(!dndTexts.join("\n").includes(marker), `D&D lane leaked ${marker}`)
  const dndPolicy = policy.resolveContextPolicy(dndModelLane)
  assert.equal(dndPolicy.dndMinimalContext, true)
  assert.equal(dndPolicy.planning, false)
  assert.equal(dndPolicy.automaticReview, false)
  assert.equal(dndPolicy.automaticSubagents, false)
  assert.equal(dndPolicy.repoContext, false)
  assert.equal(dndPolicy.genericTools, false)

  const dndNativeModelID = {
    sessionID: "dnd-model-id",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-dnd-edition" },
    system: [{ type: "text", text: "AGENTS.md and Ponytail must not arrive" }],
  }
  await hooks.context(dndNativeModelID)
  assert.deepEqual(
    dndNativeModelID.system.map((x) => x.text),
    ["Custom DnD Edition policy:\nSTATIC DND"],
    "DnD modelID events must enter the hard minimal lane",
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
