import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from "node:fs/promises"
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
  let skillLists = 0
  let command
  let emit
  const events = new ReadableStream({ start(controller) { emit = (event) => controller.enqueue(event) } })
  const registration = () => ({ dispose: async () => {} })
  const cleanup = await plugin.setup({
    event: { subscribe: () => events.values() },
    skill: { list: async () => { skillLists += 1; return { data: gameSkills } } },
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
    model: { providerID: "openai", id: "gpt-6-sol-direct" },
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
    model: { providerID: "openai", id: "gpt-6-sol-orchestrated" },
    system: [{ type: "text", text: "NATIVE" }],
  }
  await hooks.context(staticFull)
  assert.ok(staticFull.system.some((x) => x.text === "Custom orchestrated SOL policy:\nSTATIC SOL"))

  const dnd = {
    sessionID: "dnd",
    agent: "dnd-narrator",
    model: { providerID: "openai", id: "gpt-6-dnd-edition" },
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
  gameSkills.push({ id: 'odm-narrator', content: 'NARRATOR' }, { id: 'yolo-dm', content: 'YOLO' }, { id: 'odm-dm-policy', content: 'POLICY' }, { id: 'odm-development', content: 'CODING' })
  // Skill reload invalidates the cached pair; ordinary steps never re-list the catalog.
  emit({ type: 'skill.updated', data: {} })
  await new Promise((resolve) => setImmediate(resolve))
  const listsBeforeSteps = skillLists
  await hooks.context(dnd)
  for (let step = 0; step < 5; step++) await hooks.context({ ...dnd, system: [] })
  assert.equal(skillLists, listsBeforeSteps + 1, 'D&D steps must reuse the cached game skills')
  assert.deepEqual(dnd.system.slice(-2).map(item => item.text), ['Required game skill already loaded: odm-dm-policy\nPOLICY', 'Required game skill already loaded: odm-narrator\nNARRATOR'])
  assert.ok(!dnd.system.some(item => item.text.includes('YOLO')), 'dnd-edition.md owns the style; yolo-dm is not preloaded')
  assert.ok(!dnd.system.some(item => item.text.includes('CODING')), 'preloading must stay game-only')
  gameSkills.length = 0
  emit({ type: 'skill.updated', data: {} })
  await new Promise((resolve) => setImmediate(resolve))

  const dndPinnedModel = {
    sessionID: "dnd-pinned",
    agent: "dnd-narrator",
    model: { providerID: "openai", id: "gpt-6-sol-direct" },
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
    model: { providerID: "openai", id: "gpt-6-dnd-edition" },
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
    model: { providerID: "openai", modelID: "gpt-6-dnd-edition" },
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

  // Readers build nothing: no Ponytail even when a class override grants "full".
  await command.execute({ sessionID: "reader", prompt: { text: "full" } })
  const reader = { sessionID: "reader", agent: "sol-fast-reader", model: { providerID: "openai", id: "gpt-6-luna-direct" }, system: [] }
  await hooks.context(reader)
  assert.ok(reader.system.some((x) => x.text.includes("FULL ENGINEERING")))
  assert.ok(!reader.system.some((x) => x.text.includes("PONYTAIL")), "readers must not receive Ponytail")
  assert.equal(policy.resolveContextPolicy({ agent: "fast-reader", model: { providerID: "openai", id: "gpt-6-sol-direct" } }).ponytail, false)
  assert.equal(policy.resolveContextPolicy({ agent: "build", model: { providerID: "openai", id: "gpt-6-sol-direct" } }).ponytail, true)

  // Ponytail state is cached by mtime; a bad state file or checkout never fails a request.
  const stateFile = join(process.env.XDG_CONFIG_HOME, "opencode", ".ponytail-active")
  await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  const ponytailText = async () => {
    const event = { sessionID: "ponytail", agent: "build", model: { providerID: "openai", id: "gpt-6-sol-direct" }, system: [] }
    await hooks.context(event)
    return event.system.find((x) => x.text.startsWith("Ponytail V2 engineering policy"))?.text || ""
  }
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(" "))
  try {
    await writeFile(stateFile, "ultra\n")
    assert.ok((await ponytailText()).includes("PONYTAIL ultra"))
    await writeFile(stateFile, "lite\n")
    await utimes(stateFile, new Date(), new Date(Date.now() + 5000))
    assert.ok((await ponytailText()).includes("PONYTAIL lite"), "a changed mode file is picked up")
    await writeFile(stateFile, "bogus\n")
    await utimes(stateFile, new Date(), new Date(Date.now() + 10000))
    assert.ok((await ponytailText()).includes("PONYTAIL full"), "an invalid mode falls back to the default")
    assert.equal(warnings.filter((line) => line.includes("Invalid Ponytail mode")).length, 1)
    await ponytailText()
    assert.equal(warnings.filter((line) => line.includes("Invalid Ponytail mode")).length, 1, "the unchanged bad file is not re-read or re-logged")
    await rm(stateFile)
    await writeFile(join(tmp, "elsewhere"), "ultra\n")
    await symlink(join(tmp, "elsewhere"), stateFile)
    assert.ok((await ponytailText()).includes("PONYTAIL full"), "an unsafe symlink falls back to the default")
    await rm(stateFile)
    process.env.PONYTAIL_CHECKOUT_DIR = join(tmp, "missing-checkout")
    assert.equal(await ponytailText(), "", "a missing checkout drops Ponytail instead of failing the request")
    process.env.PONYTAIL_CHECKOUT_DIR = join(tmp, "ponytail")
  } finally {
    console.warn = warn
  }
  await cleanup()

  console.log("Context lanes regression passed: managed/static bare isolation, DnD-only policy, cached game skills, lite kernel, normal/full layering, override, reader/Ponytail fallbacks")
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(tmp, { recursive: true, force: true })
}
