import { Plugin } from "@opencode-ai/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { ADD_KINDS, nativeAddCommand, parseAddCommand } from "./lib/add-command.js"

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MODEL_ID_RE = /^(?!.*#).{1,200}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/
const SENSITIVE_NAME_RE = /(?:^|[-_])(?:api[-_]?key|key|token|access[-_]?token|secret|password|passphrase|authorization|auth|credential)(?:$|[-_])/i

const TITLES = {
  provider: "Добавить provider",
  model: "Добавить model",
  mcp: "Добавить MCP",
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

async function ask(context, title, placeholder, validate, optional = false) {
  while (true) {
    const answer = await context.ui.dialog.prompt({ title, placeholder })
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
  return result?.value ?? result ?? null
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
  const type = await choose(context, "MCP transport", [
    { title: "Remote URL", value: "remote", description: "Connect to an HTTP(S) MCP server." },
    { title: "Local command", value: "local", description: "Run an MCP server command." },
  ])
  if (type == null) return null

  let config = { type }
  if (type === "remote") {
    const url = await ask(context, "Remote MCP URL", "https://mcp.example.com", (value) => {
      let parsed
      try { parsed = new URL(value) } catch { return "Remote MCP requires an http(s) URL." }
      if (!["http:", "https:"].includes(parsed.protocol)) return "Remote MCP requires an http(s) URL."
      if (parsed.username || parsed.password) return "Remote MCP URL must not include credentials."
      for (const [key, item] of parsed.searchParams) if (isSensitiveName(key) && !credentialReference(item)) return `${key} must use {env:VAR}.`
      return ""
    })
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
    })
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
  return { name, config: { ...config, codemode, disabled } }
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
    await context.client.session.command({ sessionID: current, command: parsed.command, arguments: parsed.arguments })
    toast(context, `${TITLES[parsed.kind]} сохранён`, "success")
  } catch (error) {
    toast(context, `Не удалось сохранить: ${error.message}`)
  }
}

let wizardOpen = false
async function openWizard(context, kind) {
  if (wizardOpen) return
  const current = sessionID(context)
  if (!current) {
    toast(context, "Select an active session before adding configuration.")
    return
  }
  wizardOpen = true
  try {
    const input = await inputFor(context, kind)
    if (input) await saveNative(context, { kind, command: nativeAddCommand(kind), arguments: JSON.stringify(input) })
  } catch (error) {
    toast(context, `Wizard failed: ${error.message}`)
  } finally {
    wizardOpen = false
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

function commandRows(context) {
  return [
    {
      id: "custom.add-wizard.add",
      title: "Добавить configuration",
      description: "Wizard: provider, model, MCP, skill or orchestration",
      group: "Configuration",
      palette: true,
      suggested: true,
      slash: { name: "add", arguments: true },
      run: (input) => processParsed(context, parseAddCommand(slashInput("add", input))),
    },
    ...ADD_KINDS.map((kind) => {
      const command = nativeAddCommand(kind)
      return {
        id: `custom.add-wizard.${kind}`,
        title: TITLES[kind],
        description: `Wizard or native JSON command for ${kind}`,
        group: "Configuration",
        palette: true,
        slash: { name: command, arguments: true },
        run: (input) => processParsed(context, parseAddCommand(slashInput(command, input))),
      }
    }),
  ]
}

export default Plugin.define({
  id: "custom.add-wizard",
  setup(context) {
    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor = context.renderer?.currentFocusedEditor
      if (!isOpenCodePrompt(editor)) return false
      const parsed = parseAddCommand(promptText(editor))
      if (!parsed) return false
      clearPromptEditor(editor)
      return processParsed(context, parsed)
    })

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({ mode: "global", priority: 950, commands: commandRows(context) }))
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
