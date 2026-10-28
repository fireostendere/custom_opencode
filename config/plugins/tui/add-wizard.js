import { Plugin } from "@opencode/plugin/tui"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { ADD_KINDS, nativeAddCommand, parseAddCommand } from "./lib/add-command.js"
import { readConfigReceipt } from "./lib/config-receipt.js"
import { profileTemplates } from "./lib/mcp-profiles.js"
import { parseSkill } from "./lib/skill-frontmatter.js"

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MODEL_ID_RE = /^(?!.*#).{1,200}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/
const SENSITIVE_NAME_RE =
  /(?:^|[-_])(?:api[-_]?key|key|token|access[-_]?token|secret|password|passphrase|authorization|auth|credential)(?:$|[-_])/i
const PATH_MAX_LENGTH = 4096

const TITLES = {
  catalog: "Каталог моделей",
  provider: "Добавить провайдера",
  model: "Добавить модель",
  mcp: "Добавить MCP",
  "mcp-profile": "Профиль MCP: создать / изменить",
  skill: "Добавить навык",
  orchestration: "Добавить оркестрацию",
}

function isSensitiveName(value) {
  return SENSITIVE_NAME_RE.test(String(value).replace(/([a-z])([A-Z])/g, "$1_$2"))
}

function credentialReference(value) {
  return ENV_REF_RE.test(String(value).trim())
}

function validateOptionalPath(value) {
  if (!value) return ""
  if (value.includes("\0")) return "Рабочая папка не должна содержать NUL-байты."
  if (value.length > PATH_MAX_LENGTH) return `Рабочая папка: не длиннее ${PATH_MAX_LENGTH} символов.`
  return ""
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
  return Boolean(
    editor &&
      !editor.isDestroyed &&
      traits.owner === "opencode" &&
      traits.role === "prompt" &&
      traits.status !== "SHELL",
  )
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
  await context.ui.dialog.alert({ title: "Добавление конфигурации", message })
}

async function ask(context, title, placeholder, validate, optional = false, initial) {
  while (true) {
    const answer = await context.ui.dialog.prompt({
      title,
      placeholder,
      ...(initial !== undefined ? { value: String(initial) } : {}),
    })
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
  return result && typeof result === "object" && Object.hasOwn(result, "value")
    ? result.value
    : (result ?? null)
}

// Read via the native command/receipt API; no TUI copy of the durable registry.
async function managed(context) {
  const current = sessionID(context)
  const requestID = globalThis.crypto.randomUUID()
  await context.client.session.command({
    sessionID: current,
    name: "managed",
    text: JSON.stringify({ requestID }),
  })
  const on = typeof context.data?.on === "function" ? (type, handler) => context.data.on(type, handler) : undefined
  return readConfigReceipt(context.client, current, requestID, { on })
}

async function multiple(context, title, options, initial = []) {
  const selected = new Set(initial)
  while (true) {
    const choice = await choose(context, `${title} · выбрано: ${selected.size}`, [
      { title: "Готово — продолжить", value: "__done" },
      ...options.map((option) => ({
        ...option,
        title: `[${selected.has(option.value) ? "x" : " "}] ${option.title}`,
      })),
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
  const existing = Object.keys(profiles).length
    ? await choose(context, "Профиль MCP", [
        { title: "Создать профиль", value: "__new" },
        ...Object.values(profiles).map((p) => ({
          title: `${p.name} (${p.id})`,
          value: p.id,
          description: `${p.mcp.length} MCP · ${p.risk}`,
        })),
      ])
    : "__new"
  if (existing == null) return null
  const id =
    existing !== "__new"
      ? existing
      : await ask(
          context,
          "ID профиля",
          "core / frontend / custom",
          (value) =>
            requiredID(value, "ID профиля") ||
            (["auto", "all"].includes(value.toLowerCase()) ? "Имена auto и all зарезервированы." : ""),
        )
  if (id == null) return null
  const previous = profiles[id] || profileTemplates[id] || {}
  const name = await ask(context, "Отображаемое имя профиля", id, null, true, previous.name)
  if (name == null) return null
  const names = [...new Set([...Object.keys(installed), ...(previous.mcp || [])])].sort()
  const mcp = await multiple(
    context,
    "MCP-серверы",
    names.map((id) => ({
      title: id,
      value: id,
      description: !installed[id]
        ? "Не найден — останется, пока не снимете отметку"
        : installed[id].disabled
          ? "Отключён"
          : installed[id].type,
    })),
    previous.mcp,
  )
  if (mcp == null) return null
  const risk = await choose(context, "Уровень риска профиля", [
    {
      title: `${previous.risk === "elevated" ? "Повышенный" : "Обычный"} (текущий)`,
      value: previous.risk || "normal",
    },
    {
      title: previous.risk === "elevated" ? "Обычный" : "Повышенный — железо / отладчик",
      value: previous.risk === "elevated" ? "normal" : "elevated",
    },
  ])
  if (risk == null) return null
  const keywords = await ask(
    context,
    "Авто: ключевые слова задач (через запятую)",
    "frontend, css",
    null,
    true,
    previous.keywords?.join(", ") || "",
  )
  if (keywords == null) return null
  const agents = await ask(
    context,
    "Авто: ID исполнителей (через запятую)",
    "frontend-builder",
    null,
    true,
    previous.agents?.join(", ") || "",
  )
  if (agents == null) return null
  const split = (value) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  return { id, name: name || id, mcp, risk, keywords: split(keywords), agents: split(agents) }
}

async function selectProfile(context) {
  const state = await managed(context)
  const mode = await choose(context, `Профиль MCP: ${state.mode}`, [
    {
      title: "Авто",
      value: "auto",
      description: "Назначение исполнителя → ключевые слова → запасной core",
    },
    ...Object.values(state.registry.mcpProfiles).map((p) => ({
      title: `${p.name} (${p.id})`,
      value: p.id,
      description: `${p.mcp.join(", ") || "Empty"} · ${p.risk}`,
    })),
    { title: "Все", value: "all", description: "Все включённые инструменты MCP" },
  ])
  if (mode == null) return
  const scope = await choose(context, "Применить профиль MCP", [
    { title: "Эта сессия и её исполнители", value: "session" },
    { title: "По умолчанию для новых сессий", value: "default" },
    ...(mode !== "auto" && state.registry.mcpProfiles[mode]?.risk !== "elevated"
      ? [{ title: "Авто для неоднозначных задач", value: "fallback" }]
      : []),
  ])
  if (scope == null) return
  await context.client.session.command({
    sessionID: sessionID(context),
    name: "mcp-profile",
    text: JSON.stringify({ mode, scope }),
  })
  toast(context, `Профиль MCP: ${mode} · ${scope}`, "success")
}

// /mcp: durable on/off per installed server, for this folder or everywhere.
async function toggleMcp(context) {
  const current = sessionID(context)
  if (!current) return toast(context, "Сначала откройте сессию.")
  while (true) {
    const { installed, registry, directory } = await managed(context)
    const toggles = registry.mcpToggles || {}
    const chosen = (id) => Object.values(toggles).some((scoped) => Object.hasOwn(scoped, id))
    // The registry snapshot predates later plugin transforms (folder scopes);
    // native status is what the sidebar shows and what actually runs.
    const listed = await context.client.mcp
      .list({ location: directory ? { directory } : context.location })
      .catch(() => [])
    const live = new Map(
      (Array.isArray(listed) ? listed : listed?.data || []).map((server) => [server.name, server.status?.status]),
    )
    const running = (id) => (live.has(id) ? live.get(id) !== "disabled" : !installed[id]?.disabled)
    const name = await choose(
      context,
      `MCP · ${directory ? basename(directory) : "?"}`,
      [...new Set([...Object.keys(installed), ...live.keys()])].sort().map((id) => ({
        title: `[${running(id) ? "x" : " "}] ${id}`,
        value: id,
        description: Object.hasOwn(toggles[directory] || {}, id)
          ? "выбрано для этой папки"
          : Object.hasOwn(toggles["*"] || {}, id)
            ? "выбрано для всех папок"
            : live.get(id) || installed[id]?.type,
      })),
    )
    if (name == null) return
    const enabled = !running(name)
    const verb = enabled ? "Включить" : "Выключить"
    const scope = await choose(context, name, [
      { title: `${verb} в этой папке`, value: "folder", description: directory },
      { title: `${verb} везде`, value: "global", description: "Заменяет выбор отдельных папок" },
      ...(chosen(name)
        ? [{ title: "Как в конфиге", value: "reset", description: "Убрать выбор /mcp для этого MCP" }]
        : []),
    ])
    if (scope == null) continue
    await context.client.session.command({
      sessionID: current,
      name: "mcp-toggle",
      text: JSON.stringify(scope === "reset" ? { name, enabled: null } : { name, scope, enabled }),
    })
  }
}

async function configure(context) {
  if (!sessionID(context)) return toast(context, "Сначала откройте сессию.")
  const action = await choose(context, "Конфигурация", [
    { title: "Добавить или изменить конфигурацию", value: "add" },
    { title: "Профиль MCP: выбрать", value: "profile" },
    { title: "Видимость инструментов MCP и статус", value: "status" },
    { title: "Удалить управляемый элемент", value: "remove" },
  ])
  if (action === "add") return openWizard(context)
  if (action === "profile") return selectProfile(context)
  if (action === "status") {
    const state = await managed(context)
    const report = state.exposure
    const listed = await context.client.mcp.list({ location: context.location })
    const connections = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : []
    return context.ui.dialog.alert({
      title: `Профиль MCP: ${state.mode}`,
      message: [
        `Установлено MCP: ${Object.keys(state.installed).length}`,
        ...(report
          ? [
              `Последний запрос: ${report.id} · ${report.agent}`,
              `Активные MCP: ${report.active.length} (${report.active.join(", ")})`,
              `Видимых инструментов MCP: ${report.exposed.length}`,
              `Исключено неактивных инструментов: ${report.excluded.length}`,
              ...report.warnings,
            ]
          : ["Запросов к модели ещё не было. Отправьте сообщение, чтобы измерить видимость."]),
        ...connections.map((server) => `${server.name}: ${server.status?.status ?? "unknown"}`),
        "Профили используют нативные описания инструментов; сохранённый режим кода вернётся, когда профилей не останется.",
      ].join("\n"),
    })
  }
  if (action === "remove") {
    const { registry } = await managed(context)
    const options = [
      "providers",
      "models",
      "mcp",
      "mcpProfiles",
      "skills",
      "orchestrations",
    ].flatMap((type) =>
      Object.keys(registry[type]).map((id) => ({
        title: `${type}: ${id}`,
        value: JSON.stringify({ type, id }),
      })),
    )
    const item = await choose(context, "Удалить управляемый элемент", options)
    if (
      item &&
      (await context.ui.dialog.confirm({ title: "Удалить конфигурацию?", message: item }))
    ) {
      await context.client.session.command({
        sessionID: sessionID(context),
        name: "remove-managed",
        text: item,
      })
      toast(context, "Конфигурация удалена", "success")
    }
  }
}

function requiredID(value, label) {
  return ID_RE.test(value) ? "" : `${label}: начинается с буквы, не длиннее 64 символов.`
}

function requiredModelID(value, label) {
  return MODEL_ID_RE.test(value) ? "" : `${label}: от 1 до 200 символов, без #.`
}

function envNames(value) {
  if (!value) return []
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function validateEnvNames(value) {
  return envNames(value).every((item) => ENV_NAME_RE.test(item))
    ? ""
    : "Укажите имена переменных окружения заглавными буквами через запятую."
}

async function providerInput(context) {
  const id = await ask(context, "ID провайдера", "acme", (value) => requiredID(value, "ID провайдера"))
  if (id == null) return null
  const name = await ask(context, "Название провайдера", id, null, true)
  if (name == null) return null
  const packageName = await ask(
    context,
    "Пакет провайдера",
    "@opencode/ai/providers/openai-compatible",
    null,
    true,
  )
  if (packageName == null) return null
  const baseURL = await ask(context, "Базовый URL (необязательно)", "https://llm.example/v1", null, true)
  if (baseURL == null) return null
  const apiKeyName = await ask(
    context,
    "Переменная окружения с API-ключом (необязательно)",
    "ACME_API_KEY",
    (value) => (ENV_NAME_RE.test(value) ? "" : "Укажите имя переменной окружения заглавными буквами."),
    true,
  )
  if (apiKeyName == null) return null
  const extraEnv = await ask(
    context,
    "Дополнительные переменные окружения (необязательно)",
    "REGION, TENANT_ID",
    validateEnvNames,
    true,
  )
  if (extraEnv == null) return null

  const env = [...new Set([...envNames(extraEnv), ...(apiKeyName ? [apiKeyName] : [])])]
  const settings = {
    ...(baseURL ? { baseURL } : {}),
    ...(apiKeyName ? { apiKey: `{env:${apiKeyName}}` } : {}),
  }
  return {
    id,
    name: name || id,
    package: packageName || "@opencode/ai/providers/openai-compatible",
    ...(env.length ? { env } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}

async function modelInput(context) {
  const providerID = await ask(context, "ID провайдера", "acme", (value) =>
    requiredID(value, "ID провайдера"),
  )
  if (providerID == null) return null
  const id = await ask(context, "Псевдоним модели", "coder", (value) =>
    requiredModelID(value, "Псевдоним модели"),
  )
  if (id == null) return null
  const modelID = await ask(
    context,
    "ID модели у провайдера",
    id,
    (value) => requiredModelID(value, "ID модели у провайдера"),
    true,
  )
  if (modelID == null) return null
  const name = await ask(context, "Название модели", id, null, true)
  if (name == null) return null
  return { providerID, id, modelID: modelID || id, name: name || id }
}

async function mcpInput(context) {
  const name = await ask(context, "Имя MCP", "docs", (value) => requiredID(value, "Имя MCP"))
  if (name == null) return null
  const state = await managed(context)
  const previous = state.registry.mcp[name] || {}
  const type = await choose(context, "Транспорт MCP", [
    { title: "Удалённый URL", value: "remote", description: "Подключиться к MCP-серверу по HTTP или HTTPS." },
    { title: "Локальная команда", value: "local", description: "Запустить команду MCP-сервера." },
  ])
  if (type == null) return null

  let config = previous.type === type ? { ...previous, type } : { type }
  if (type === "remote") {
    const url = await ask(
      context,
      "URL удалённого MCP",
      "https://mcp.example.com",
      (value) => {
        let parsed
        try {
          parsed = new URL(value)
        } catch {
          return "Удалённому MCP нужен URL http(s)."
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          return "Удалённому MCP нужен URL http(s)."
        if (parsed.username || parsed.password)
          return "URL удалённого MCP не должен содержать учётные данные."
        for (const [key, item] of parsed.searchParams)
          if (isSensitiveName(key) && !credentialReference(item))
            return `${key}: используйте {env:VAR}.`
        return ""
      },
      false,
      previous.url,
    )
    if (url == null) return null
    config.url = url
  } else {
    const command = await ask(
      context,
      "Локальная команда (массив JSON)",
      '["npx", "-y", "example-mcp"]',
      (value) => {
        let parsed
        try {
          parsed = JSON.parse(value)
        } catch {
          return "Локальная команда должна быть массивом строк JSON."
        }
        if (
          !Array.isArray(parsed) ||
          !parsed.length ||
          parsed.some((item) => typeof item !== "string" || !item.trim())
        )
          return "Локальная команда должна быть непустым массивом строк JSON."
        for (let index = 0; index < parsed.length; index += 1) {
          const argument = parsed[index]
          const flag = /^--([^=]+)(?:=(.*))?$/i.exec(argument)
          const valueToCheck =
            flag && (isSensitiveName(flag[1]) || /^(?:env|header)$/i.test(flag[1]))
              ? flag[2] === undefined
                ? parsed[index + 1]
                : flag[2]
              : /^-[eH]$/.test(argument)
                ? parsed[index + 1]
                : argument
          const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(String(valueToCheck || ""))
          const header = /^([^:]+):\s*(.*)$/.exec(String(valueToCheck || ""))
          const sensitive =
            flag && isSensitiveName(flag[1])
              ? [flag[1], valueToCheck]
              : assignment
                ? [assignment[1], assignment[2]]
                : header
                  ? [header[1], header[2]]
                  : null
          if (sensitive && isSensitiveName(sensitive[0]) && !credentialReference(sensitive[1]))
            return `${sensitive[0]}: используйте {env:VAR}.`
        }
        return ""
      },
      false,
      previous.command ? JSON.stringify(previous.command) : undefined,
    )
    if (command == null) return null
    config.command = JSON.parse(command)
    const cwd = await ask(context, "Рабочая папка (необязательно)", ".", validateOptionalPath, true, previous.cwd)
    if (cwd == null) return null
    if (cwd) config.cwd = cwd
    else delete config.cwd
  }
  const codemode = await choose(context, "Включить режим кода для MCP?", [
    { title: "Нет", value: false },
    { title: "Да", value: true },
  ])
  if (codemode == null) return null
  const disabled = await choose(context, "Отключить этот MCP-сервер?", [
    { title: "Нет", value: false },
    { title: "Да", value: true },
  ])
  if (disabled == null) return null
  const profiles = Object.values(state.registry.mcpProfiles)
  const selected = profiles.length
    ? await multiple(
        context,
        "Профили",
        profiles.map((p) => ({ title: `${p.name} (${p.id})`, value: p.id })),
        profiles.filter((p) => p.mcp.includes(name)).map((p) => p.id),
      )
    : []
  if (selected == null) return null
  return { name, config: { ...config, codemode, disabled }, profiles: selected }
}

async function skillInput(context) {
  const source = await choose(context, "Источник навыка", [
    {
      title: "Импортировать локальный SKILL.md",
      value: "import",
      description: "Использовать готовый файл или папку навыка.",
    },
    { title: "Ввести инструкции вручную", value: "manual" },
  ])
  if (source == null) return null
  let content = ""
  let defaultID = "review"
  let defaultName = ""
  let defaultDescription = ""
  if (source === "import") {
    while (true) {
      const inputPath = await ask(
        context,
        "Путь к навыку",
        "/путь/к/навыку или /путь/к/SKILL.md",
        (value) => (value ? "" : "Нужен путь к навыку."),
      )
      if (inputPath == null) return null
      const expanded =
        inputPath === "~"
          ? homedir()
          : inputPath.startsWith("~/")
            ? join(homedir(), inputPath.slice(2))
            : inputPath
      const path =
        basename(expanded).toLowerCase() === "skill.md" ? expanded : join(expanded, "SKILL.md")
      try {
        const sourceText = await readFile(path, "utf8")
        const parsed = parseSkill(sourceText)
        defaultName = parsed.name
        defaultDescription = parsed.description
        content = parsed.content
        defaultID = defaultName
        break
      } catch (error) {
        await alert(context, `Не удалось прочитать навык: ${error.message}`)
      }
    }
  }
  let id = defaultID
  let name = defaultName
  let description = defaultDescription
  if (source === "manual") {
    id = await ask(context, "ID навыка", "review", (value) => requiredID(value, "ID навыка"))
    if (id == null) return null
    name = await ask(context, "Название навыка", id, null, true)
    if (name == null) return null
    description = await ask(context, "Описание навыка", "Проверить текущие изменения")
    if (description == null) return null
    content = await ask(context, "Содержимое навыка", "Вставьте инструкции навыка", (value) =>
      value ? "" : "Нужно содержимое навыка.",
    )
    if (content == null) return null
  }
  const autoinvoke = await choose(context, "Включить автовызов?", [
    { title: "Нет", value: false },
    { title: "Да", value: true },
  ])
  if (autoinvoke == null) return null
  return { id, name: name || id, description, content, autoinvoke }
}

async function orchestrationInput(context) {
  const providerID = await ask(context, "ID провайдера", "acme", (value) =>
    requiredID(value, "ID провайдера"),
  )
  if (providerID == null) return null
  const id = await ask(context, "Псевдоним оркестрации", "coder-orchestrated", (value) =>
    requiredModelID(value, "Псевдоним оркестрации"),
  )
  if (id == null) return null
  const baseModelID = await ask(context, "ID базовой модели", "coder", (value) =>
    requiredModelID(value, "ID базовой модели"),
  )
  if (baseModelID == null) return null
  const name = await ask(context, "Название оркестрации", `${id} · Orchestrated`, null, true)
  if (name == null) return null
  const prompt = await ask(context, "Управляемая системная политика", "Проверяй перед завершением.")
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
    toast(context, "Выберите активную сессию, прежде чем добавлять конфигурацию.")
    return
  }
  try {
    await context.client.session.command({
      sessionID: current,
      name: parsed.command,
      text: parsed.arguments,
    })
    toast(context, `${TITLES[parsed.kind]} сохранён`, "success")
  } catch (error) {
    toast(context, `Не удалось сохранить: ${error.message}`)
  }
}

async function openWizard(context, kind) {
  const current = sessionID(context)
  if (!current) {
    toast(context, "Выберите активную сессию, прежде чем добавлять конфигурацию.")
    return
  }
  try {
    if (!kind)
      kind = await choose(
        context,
        "Добавить или изменить конфигурацию",
        ADD_KINDS.map((value) => ({ title: TITLES[value], value })),
      )
    if (!kind) return
    const input = await inputFor(context, kind)
    if (
      input &&
      (await context.ui.dialog.confirm({
        title: "Сохранить конфигурацию?",
        message: JSON.stringify(input, null, 2),
      }))
    )
      await saveNative(context, {
        kind,
        command: nativeAddCommand(kind),
        arguments: JSON.stringify(input),
      })
  } catch (error) {
    toast(context, `Ошибка мастера: ${error.message}`)
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
      group: "Конфигурация",
      palette: true,
      slash: { name: "refreshmodels" },
      run: () => saveNative(context, { kind: "catalog", command: "refreshmodels", arguments: "" }),
    },
    {
      id: "custom.add-wizard.accounts",
      title: "Аккаунты провайдеров",
      description: "Добавить аккаунт, переименовать или переключить активный",
      group: "Конфигурация",
      palette: true,
      suggested: true,
      slash: { name: "accounts" },
      run: () => openAccounts(context),
    },
    {
      id: "custom.add-wizard.add",
      title: "Добавить конфигурацию",
      description: "Провайдеры, модели, MCP, профили, навыки и оркестрация",
      group: "Конфигурация",
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
        description: "Мастер или команда JSON",
        group: "Конфигурация",
        palette: true,
        run: (input) => process(parseAddCommand(slashInput(command, input))),
      }
    }),
    {
      id: "custom.add-wizard.configure",
      title: "Конфигурация: управление",
      group: "Конфигурация",
      palette: true,
      slash: { name: "configure" },
      run: () => {
        void configure(context).catch((error) => toast(context, error.message))
        return true
      },
    },
    {
      id: "custom.add-wizard.mcp-toggle",
      title: "MCP: включить / выключить",
      description: "Для этой папки или везде; выключенный MCP не запускается",
      group: "Конфигурация",
      palette: true,
      slash: { name: "mcp" },
      run: () => {
        void toggleMcp(context).catch((error) => toast(context, error.message))
        return true
      },
    },
    {
      id: "custom.add-wizard.profile",
      title: "Профиль MCP: выбрать",
      group: "Конфигурация",
      palette: true,
      run: () => {
        void selectProfile(context).catch((error) => toast(context, error.message))
        return true
      },
    },
  ]
}

export default Plugin.define({
  id: "custom.add-wizard",
  setup(context) {
    let busy = false
    const run = (parsed) => {
      if (busy) {
        toast(context, "Визард уже открыт: закройте его и повторите команду")
        return true
      }
      if (parsed?.type !== "wizard") return processParsed(context, parsed)
      busy = true
      void openWizard(context, parsed.kind).finally(() => {
        busy = false
      })
      return true
    }
    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor =
        context.renderer?.currentFocusedEditor ?? context.renderer?.currentFocusedRenderable
      if (!isOpenCodePrompt(editor)) return false
      const text = promptText(editor)
      if (/^\/accounts(?:\s|$)/i.test(text.trim())) {
        clearPromptEditor(editor)
        if (text.trim().toLowerCase() === "/accounts") openAccounts(context)
        else
          toast(
            context,
            "Используйте /accounts без аргументов; данные аккаунта вводятся в визарде.",
          )
        return true
      }
      if (text.trim() === "/mcp") {
        clearPromptEditor(editor)
        void toggleMcp(context).catch((error) => toast(context, error.message))
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
        context.keymap.layer(() => ({
          mode: "global",
          priority: 950,
          commands: commandRows(context, run),
        }))
        return null
      },
    })

    if (submitRouter.transport === "none")
      toast(context, "Мастер добавления: перехват локальной отправки недоступен.")
    return () => {
      submitRouter.dispose?.()
      unslot?.()
    }
  },
})
