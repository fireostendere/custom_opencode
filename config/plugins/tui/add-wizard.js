import { Plugin } from "@opencode-ai/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { ADD_KINDS, nativeAddCommand, parseAddCommand } from "./lib/add-command.js"
import { profileTemplates } from "./lib/mcp-profiles.js"

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MODEL_ID_RE = /^(?!.*#).{1,200}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/
const SENSITIVE_NAME_RE = /(?:^|[-_])(?:api[-_]?key|key|token|access[-_]?token|secret|password|passphrase|authorization|auth|credential)(?:$|[-_])/i

const TITLES = {
  catalog: "Каталог моделей",
  provider: "Добавить provider",
  model: "Добавить model",
  mcp: "Добавить MCP",
  "mcp-profile": "MCP profile: создать / изменить",
  skill: "Добавить skill",
  orchestration: "Добавить orchestration",
}

function isSensitiveName(value) {
  return SENSITIVE_NAME_RE.test(String(value).replace(/([a-z])([A-Z])/g, "$1_$2"))
}

function credentialReference(value) {
  return ENV_REF_RE.test(String(value).trim())
}

function promptText(editor) {
  if (!editor || editor.isDestroyed) return ""
  if (typeof editor.plainText === "string") return editor.plainText
  if (typeof editor.getText === "function") return String(editor.getText() ?? "")
  return ""
}

function clearPromptEditor(editor) {
  if (!editor || editor.isDestroyed) return
  if (typeof editor.clear === "function") editor.clear()
  else if (typeof editor.setText === "function") editor.setText("")
  editor.extmarks?.clear?.()
  editor.gotoBufferEnd?.()
}

function isOpenCodePrompt(editor) {
  const traits = editor?.traits ?? {}
  return Boolean(editor && !editor.isDestroyed && traits.owner === "opencode" && traits.role === "prompt" && traits.status !== "SHELL")
}

function sessionID(context) {
  const current = context.ui.router.current
  const route = typeof current === "function" ? current() : current
  const type = route?.type ?? route?.name
  return type === "session" ? String(route?.sessionID ?? route?.params?.sessionID ?? "") : ""
}

function toast(context, message, variant = "warning") {
  context.ui.toast.show({ message, variant })
}

async function alert(context, message) {
  await context.ui.dialog.alert({ title: "Add configuration", message })
}

async function ask(context, title, placeholder, validate, optional = false, initial) {
  while (true) {
    const answer = await context.ui.dialog.prompt({ title, placeholder, ...(initial !== undefined ? { value: String(initial) } : {}) })
    if (answer == null) return null
    const value = String(answer).trim()
    if (optional && !value) return ""
    const error = validate?.(value)
    if (!error) return value
    await alert(context, error)
  }
}

async function choose(context, title, options) {
  const result = await context.ui.dialog.select({ title, options })
  return result && typeof result === "object" && Object.hasOwn(result, "value") ? result.value : result ?? null
}

// Read via the native command/receipt API; no TUI copy of the durable registry.
async function managed(context) {
  const current = sessionID(context)
  const requestID = globalThis.crypto.randomUUID()
  await context.client.session.command({ sessionID: current, command: "managed", text: JSON.stringify({ requestID }) })
  const messages = await context.client.session.context({ sessionID: current })
  const message = messages.find((item) => item.text?.startsWith(`custom.config.receipt:${requestID}\n`))
  if (!message) throw new Error("Configuration response missing; check config-manager plugin status.")
  return JSON.parse(message.text.slice(message.text.indexOf("\n") + 1))
}

async function multiple(context, title, options, initial = []) {
  const selected = new Set(initial)
  while (true) {
    const choice = await choose(context, `${title} · ${selected.size} selected`, [
      { title: "Done — continue", value: "__done" },
      ...options.map((option) => ({ ...option, title: `[${selected.has(option.value) ? "x" : " "}] ${option.title}` })),
    ])
    if (choice == null) return null
    if (choice === "__done") return [...selected]
    if (selected.has(choice)) selected.delete(choice)
    else selected.add(choice)
  }
}

async function profileInput(context) {
  const { registry, installed } = await managed(context)
  const profiles = registry.mcpProfiles
  const existing = Object.keys(profiles).length ? await choose(context, "MCP profile", [
    { title: "Create profile", value: "__new" },
    ...Object.values(profiles).map((p) => ({ title: `${p.name} (${p.id})`, value: p.id, description: `${p.mcp.length} MCP · ${p.risk}` })),
  ]) : "__new"
  if (existing == null) return null
  const id = existing !== "__new" ? existing : await ask(context, "Profile ID", "core / frontend / custom", (value) => requiredID(value, "Profile ID") || (["auto", "all"].includes(value.toLowerCase()) ? "Auto and All are reserved." : ""))
  if (id == null) return null
  const previous = profiles[id] || profileTemplates[id] || {}
  const name = await ask(context, "Profile display name", id, null, true, previous.name)
  if (name == null) return null
  const names = [...new Set([...Object.keys(installed), ...(previous.mcp || [])])].sort()
  const mcp = await multiple(context, "MCP servers", names.map((id) => ({ title: id, value: id, description: !installed[id] ? "Missing — retained until unchecked" : installed[id].disabled ? "Disabled" : installed[id].type })), previous.mcp)
  if (mcp == null) return null
  const risk = await choose(context, "Profile risk", [
    { title: `${previous.risk === "elevated" ? "Elevated" : "Normal"} (current)`, value: previous.risk || "normal" },
    { title: previous.risk === "elevated" ? "Normal" : "Elevated — hardware / debugger", value: previous.risk === "elevated" ? "normal" : "elevated" },
  ])
  if (risk == null) return null
  const keywords = await ask(context, "Auto: task keywords (comma separated)", "frontend, css", null, true, previous.keywords?.join(", ") || "")
  if (keywords == null) return null
  const agents = await ask(context, "Auto: worker IDs (comma separated)", "frontend-builder", null, true, previous.agents?.join(", ") || "")
  if (agents == null) return null
  const split = (value) => value.split(",").map((s) => s.trim()).filter(Boolean)
  return { id, name: name || id, mcp, risk, keywords: split(keywords), agents: split(agents) }
}

async function selectProfile(context) {
  const state = await managed(context)
  const mode = await choose(context, `MCP profile: ${state.mode}`, [
    { title: "Auto", value: "auto", description: "Worker assignment → task keywords → core fallback" },
    ...Object.values(state.registry.mcpProfiles).map((p) => ({ title: `${p.name} (${p.id})`, value: p.id, description: `${p.mcp.join(", ") || "Empty"} · ${p.risk}` })),
    { title: "All", value: "all", description: "All enabled MCP tools" },
  ])
  if (mode == null) return
  const scope = await choose(context, "Apply MCP profile", [
    { title: "This session and its workers", value: "session" },
    { title: "Default for new sessions", value: "default" },
    ...(mode !== "auto" && state.registry.mcpProfiles[mode]?.risk !== "elevated" ? [{ title: "Auto fallback for ambiguous tasks", value: "fallback" }] : []),
  ])
  if (scope == null) return
  await context.client.session.command({ sessionID: sessionID(context), command: "mcp-profile", text: JSON.stringify({ mode, scope }) })
  toast(context, `MCP profile: ${mode} · ${scope}`, "success")
}

async function configure(context) {
  if (!sessionID(context)) return toast(context, "Open a session first.")
  const action = await choose(context, "Configuration", [
    { title: "Add / update configuration", value: "add" },
    { title: "MCP profile: select", value: "profile" },
    { title: "MCP tool exposure / status", value: "status" },
    { title: "Remove managed item", value: "remove" },
  ])
  if (action === "add") return openWizard(context)
  if (action === "profile") return selectProfile(context)
  if (action === "status") {
    const state = await managed(context)
    const report = state.exposure
    const connections = await context.client.mcp.list({ location: context.location })
    return context.ui.dialog.alert({ title: `MCP profile: ${state.mode}`, message: [
      `Installed MCP: ${Object.keys(state.installed).length}`,
      ...(report ? [`Last request: ${report.id} · ${report.agent}`, `Active MCP: ${report.active.length} (${report.active.join(", ")})`, `Exposed MCP tools: ${report.exposed.length}`, `Inactive tools excluded: ${report.excluded.length}`, ...report.warnings] : ["No model request observed yet. Send a prompt to measure exposure."]),
      ...connections.map((server) => `${server.name}: ${server.status.status}`),
      "Profiles use native tool definitions; stored Code Mode resumes when no profiles exist.",
    ].join("\n") })
  }
  if (action === "remove") {
    const { registry } = await managed(context)
    const options = ["providers", "models", "mcp", "mcpProfiles", "skills", "orchestrations"].flatMap((type) => Object.keys(registry[type]).map((id) => ({ title: `${type}: ${id}`, value: JSON.stringify({ type, id }) })))
    const item = await choose(context, "Remove managed item", options)
    if (item && await context.ui.dialog.confirm({ title: "Remove configuration?", message: item })) {
      await context.client.session.command({ sessionID: sessionID(context), command: "remove-managed", text: item })
      toast(context, "Configuration removed", "success")
    }
  }
}

function requiredID(value, label) {
  return ID_RE.test(value) ? "" : `${label} must start with a letter and be at most 64 characters.`
}

function requiredModelID(value, label) {
  return MODEL_ID_RE.test(value) ? "" : `${label} must be 1-200 characters and must not contain #.`
}

function envNames(value) {
  if (!value) return []
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
}

function validateEnvNames(value) {
  return envNames(value).every((item) => ENV_NAME_RE.test(item)) ? "" : "Use comma-separated uppercase environment variable names."
}

async function providerInput(context) {
  const id = await ask(context, "Provider ID", "acme", (value) => requiredID(value, "Provider ID"))
  if (id == null) return null
  const name = await ask(context, "Provider name", id, null, true)
  if (name == null) return null
  const packageName = await ask(context, "Provider package", "@opencode-ai/ai/providers/openai-compatible", null, true)
  if (packageName == null) return null
  const baseURL = await ask(context, "Base URL (optional)", "https://llm.example/v1", null, true)
  if (baseURL == null) return null
  const apiKeyName = await ask(context, "API key environment variable (optional)", "ACME_API_KEY", (value) => ENV_NAME_RE.test(value) ? "" : "Use an uppercase environment variable name.", true)
  if (apiKeyName == null) return null
  const extraEnv = await ask(context, "Additional environment variables (optional)", "REGION, TENANT_ID", validateEnvNames, true)
  if (extraEnv == null) return null

  const env = [...new Set([...envNames(extraEnv), ...(apiKeyName ? [apiKeyName] : [])])]
  const settings = {
    ...(baseURL ? { baseURL } : {}),
    ...(apiKeyName ? { apiKey: `{env:${apiKeyName}}` } : {}),
  }
  return {
    id,
    name: name || id,
    package: packageName || "@opencode-ai/ai/providers/openai-compatible",
    ...(env.length ? { env } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}

async function modelInput(context) {
  const providerID = await ask(context, "Provider ID", "acme", (value) => requiredID(value, "Provider ID"))
  if (providerID == null) return null
  const id = await ask(context, "Model alias", "coder", (value) => requiredModelID(value, "Model alias"))
  if (id == null) return null
  const modelID = await ask(context, "Upstream model ID", id, (value) => requiredModelID(value, "Upstream model ID"), true)
  if (modelID == null) return null
  const name = await ask(context, "Model name", id, null, true)
  if (name == null) return null
  return { providerID, id, modelID: modelID || id, name: name || id }
}

async function mcpInput(context) {
  const name = await ask(context, "MCP name", "docs", (value) => requiredID(value, "MCP name"))
  if (name == null) return null
  const state = await managed(context)
  const previous = state.registry.mcp[name] || {}
  const type = await choose(context, "MCP transport", [
    { title: "Remote URL", value: "remote", description: "Connect to an HTTP(S) MCP server." },
    { title: "Local command", value: "local", description: "Run an MCP server command." },
  ])
  if (type == null) return null

  let config = previous.type === type ? { ...previous, type } : { type }
  if (type === "remote") {
    const url = await ask(context, "Remote MCP URL", "https://mcp.example.com", (value) => {
      let parsed
      try { parsed = new URL(value) } catch { return "Remote MCP requires an http(s) URL." }
      if (!["http:", "https:"].includes(parsed.protocol)) return "Remote MCP requires an http(s) URL."
      if (parsed.username || parsed.password) return "Remote MCP URL must not include credentials."
      for (const [key, item] of parsed.searchParams) if (isSensitiveName(key) && !credentialReference(item)) return `${key} must use {env:VAR}.`
      return ""
    }, false, previous.url)
    if (url == null) return null
    config.url = url
  } else {
    const command = await ask(context, "Local command (JSON array)", '["npx", "-y", "example-mcp"]', (value) => {
      let parsed
      try { parsed = JSON.parse(value) } catch { return "Local command must be a JSON array of strings." }
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string" || !item.trim())) return "Local command must be a non-empty JSON array of strings."
      for (let index = 0; index < parsed.length; index += 1) {
        const argument = parsed[index]
        const flag = /^--([^=]+)(?:=(.*))?$/i.exec(argument)
        const valueToCheck = flag && (isSensitiveName(flag[1]) || /^(?:env|header)$/i.test(flag[1]))
          ? flag[2] === undefined ? parsed[index + 1] : flag[2]
          : /^-[eH]$/.test(argument) ? parsed[index + 1] : argument
        const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(String(valueToCheck || ""))
        const header = /^([^:]+):\s*(.*)$/.exec(String(valueToCheck || ""))
        const sensitive = flag && isSensitiveName(flag[1]) ? [flag[1], valueToCheck] : assignment ? [assignment[1], assignment[2]] : header ? [header[1], header[2]] : null
        if (sensitive && isSensitiveName(sensitive[0]) && !credentialReference(sensitive[1])) return `${sensitive[0]} must use {env:VAR}.`
      }
      return ""
    }, false, previous.command ? JSON.stringify(previous.command) : undefined)
    if (command == null) return null
    config.command = JSON.parse(command)
  }
  const codemode = await choose(context, "Enable MCP code mode?", [
    { title: "No", value: false },
    { title: "Yes", value: true },
  ])
  if (codemode == null) return null
  const disabled = await choose(context, "Disable this MCP server?", [
    { title: "No", value: false },
    { title: "Yes", value: true },
  ])
  if (disabled == null) return null
  const profiles = Object.values(state.registry.mcpProfiles)
  const selected = profiles.length ? await multiple(context, "Profiles", profiles.map((p) => ({ title: `${p.name} (${p.id})`, value: p.id })), profiles.filter((p) => p.mcp.includes(name)).map((p) => p.id)) : []
  if (selected == null) return null
  return { name, config: { ...config, codemode, disabled }, profiles: selected }
}

async function skillInput(context) {
  const id = await ask(context, "Skill ID", "review", (value) => requiredID(value, "Skill ID"))
  if (id == null) return null
  const name = await ask(context, "Skill name", id, null, true)
  if (name == null) return null
  const description = await ask(context, "Skill description", "Review current changes")
  if (description == null) return null
  const content = await ask(context, "Skill content", "Paste the skill instructions", (value) => value ? "" : "Skill content is required.")
  if (content == null) return null
  const autoinvoke = await choose(context, "Enable autoinvoke?", [
    { title: "No", value: false },
    { title: "Yes", value: true },
  ])
  if (autoinvoke == null) return null
  return { id, name: name || id, description, content, autoinvoke }
}

async function orchestrationInput(context) {
  const providerID = await ask(context, "Provider ID", "acme", (value) => requiredID(value, "Provider ID"))
  if (providerID == null) return null
  const id = await ask(context, "Orchestration alias", "coder-orchestrated", (value) => requiredModelID(value, "Orchestration alias"))
  if (id == null) return null
  const baseModelID = await ask(context, "Base model ID", "coder", (value) => requiredModelID(value, "Base model ID"))
  if (baseModelID == null) return null
  const name = await ask(context, "Orchestration name", `${id} · Orchestrated`, null, true)
  if (name == null) return null
  const prompt = await ask(context, "Managed system policy", "Verify before completion.")
  if (prompt == null) return null
  return { providerID, id, baseModelID, name: name || `${id} · Orchestrated`, prompt }
}

async function inputFor(context, kind) {
  if (kind === "provider") return providerInput(context)
  if (kind === "model") return modelInput(context)
  if (kind === "mcp") return mcpInput(context)
  if (kind === "mcp-profile") return profileInput(context)
  if (kind === "skill") return skillInput(context)
  if (kind === "orchestration") return orchestrationInput(context)
  return null
}

async function saveNative(context, parsed) {
  const current = sessionID(context)
  if (!current) {
    toast(context, "Select an active session before adding configuration.")
    return
  }
  try {
    await context.client.session.command({ sessionID: current, command: parsed.command, text: parsed.arguments })
    toast(context, `${TITLES[parsed.kind]} сохранён`, "success")
  } catch (error) {
    toast(context, `Не удалось сохранить: ${error.message}`)
  }
}

async function openWizard(context, kind) {
  const current = sessionID(context)
  if (!current) {
    toast(context, "Select an active session before adding configuration.")
    return
  }
  try {
    if (!kind) kind = await choose(context, "Add / update configuration", ADD_KINDS.map((value) => ({ title: TITLES[value], value })))
    if (!kind) return
    const input = await inputFor(context, kind)
    if (input && await context.ui.dialog.confirm({ title: "Save configuration?", message: JSON.stringify(input, null, 2) })) await saveNative(context, { kind, command: nativeAddCommand(kind), arguments: JSON.stringify(input) })
  } catch (error) {
    toast(context, `Wizard failed: ${error.message}`)
  }
}

function processParsed(context, parsed) {
  if (parsed.type === "error") {
    toast(context, parsed.message)
    return true
  }
  if (parsed.type === "wizard") {
    void openWizard(context, parsed.kind)
    return true
  }
  void saveNative(context, parsed)
  return true
}

function slashInput(name, input) {
  const argumentsText = String(input ?? "").trim()
  return `/${name}${argumentsText ? ` ${argumentsText}` : ""}`
}

function openAccounts(context) {
  // Reuse V2's credential-backed multi-account UI, including OAuth refresh.
  const connect = context.keymap.commands().find((command) => command.id === "provider.connect")
  if (!connect) {
    toast(context, "В этой версии OpenCode недоступен визард подключений. Обновите OpenCode V2.")
    return
  }
  context.keymap.dispatch(connect.id)
}

function commandRows(context, process) {
  return [
    {
      id: "custom.models.refresh",
      title: "Обновить список моделей",
      description: "Перечитать сохранённые модели и оркестрации",
      group: "Configuration",
      palette: true,
      slash: { name: "refreshmodels" },
      run: () => saveNative(context, { kind: "catalog", command: "refreshmodels", arguments: "" }),
    },
    {
      id: "custom.add-wizard.accounts",
      title: "Аккаунты провайдеров",
      description: "Добавить аккаунт, переименовать или переключить активный",
      group: "Configuration",
      palette: true,
      suggested: true,
      slash: { name: "accounts" },
      run: () => openAccounts(context),
    },
    {
      id: "custom.add-wizard.add",
      title: "Добавить configuration",
      description: "Create or update providers, models, MCP, profiles, skills and orchestration",
      group: "Configuration",
      palette: true,
      suggested: true,
      slash: { name: "add", arguments: true },
      run: (input) => process(parseAddCommand(slashInput("add", input))),
    },
    ...ADD_KINDS.map((kind) => {
      const command = nativeAddCommand(kind)
      return {
        id: `custom.add-wizard.${kind}`,
        title: TITLES[kind],
        description: `Wizard or native JSON command for ${kind}`,
        group: "Configuration",
        palette: true,
        run: (input) => process(parseAddCommand(slashInput(command, input))),
      }
    }),
    { id: "custom.add-wizard.configure", title: "Configuration: manage", group: "Configuration", palette: true, slash: { name: "configure" }, run: () => { void configure(context).catch((error) => toast(context, error.message)); return true } },
    { id: "custom.add-wizard.profile", title: "MCP profile: select", group: "Configuration", palette: true, run: () => { void selectProfile(context).catch((error) => toast(context, error.message)); return true } },
  ]
}

export default Plugin.define({
  id: "custom.add-wizard",
  setup(context) {
    let busy = false
    const run = (parsed) => {
      if (busy) return true
      if (parsed?.type !== "wizard") return processParsed(context, parsed)
      busy = true
      void openWizard(context, parsed.kind).finally(() => { busy = false })
      return true
    }
    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor = context.renderer?.currentFocusedEditor ?? context.renderer?.currentFocusedRenderable
      if (!isOpenCodePrompt(editor)) return false
      const text = promptText(editor)
      if (/^\/accounts(?:\s|$)/i.test(text.trim())) {
        clearPromptEditor(editor)
        if (text.trim().toLowerCase() === "/accounts") openAccounts(context)
        else toast(context, "Используйте /accounts без аргументов; данные аккаунта вводятся в визарде.")
        return true
      }
      if (text.trim() === "/mcp-profile") {
        clearPromptEditor(editor)
        void selectProfile(context).catch((error) => toast(context, error.message))
        return true
      }
      const parsed = parseAddCommand(text)
      if (!parsed) return false
      clearPromptEditor(editor)
      return run(parsed)
    })

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({ mode: "global", priority: 950, commands: commandRows(context, run) }))
        return null
      },
    })

    if (submitRouter.transport === "none") toast(context, "Add wizard: local submit interception is unavailable.")
    return () => {
      submitRouter.dispose?.()
      unslot?.()
    }
  },
})
