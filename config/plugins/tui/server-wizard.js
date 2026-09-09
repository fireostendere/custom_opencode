import { Plugin } from "@opencode-ai/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { SERVER_COMMAND, parseServerCommand } from "./lib/server-command.js"
import {
  runControl,
  chooseState,
  statusText,
  isOpenCodePrompt,
  promptText,
  clearPromptEditor,
  toast,
} from "./lib/webserver-control.js"

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/

function buildAddress(value) {
  return value?.host && value?.port ? `http://${value.host}:${value.port}` : value?.address || ""
}

function statusToastPayload(value) {
  if (!value?.deployed) return { message: "Web server ещё не развёрнут.", variant: "warning" }
  let message = statusText(value)
  const users = Array.isArray(value?.users) ? value.users : []
  message += ` · пользователей: ${users.length}`
  if (users.length) message += ` (${users.map((u) => u.username).join(", ")})`
  if (value?.usersError) message += " · хранилище пользователей повреждено"
  return { message, variant: "success" }
}

async function ask(context, options) {
  const { title, placeholder, validate, message } = options
  const initial = options.value
  while (true) {
    const answer = await context.ui.dialog.prompt({
      title,
      placeholder,
      ...(initial !== undefined ? { value: String(initial) } : {}),
    })
    if (answer == null) return null
    const value = String(answer).trim()
    if (!validate) return value
    const error = validate(value)
    if (!error) return value
    await context.ui.dialog.alert({ title, message: error || message || "Неверное значение." })
  }
}

async function refreshStatus(context) {
  return runControl(context, ["status"])
}

async function doStatus(context, value) {
  const payload = statusToastPayload(value)
  toast(context, payload.message, payload.variant)
}

async function doToggle(context, current) {
  const state = await chooseState(context, "Состояние web server сейчас", current.running)
  if (state == null) return
  const value = await runControl(context, ["apply", "--running", state ? "on" : "off", "--default", current.defaultEnabled ? "on" : "off"])
  toast(context, statusText(value), "success")
}

async function doAutostart(context, current) {
  const state = await chooseState(context, "Запускать web server по умолчанию?", current.defaultEnabled)
  if (state == null) return
  const value = await runControl(context, ["default", state ? "on" : "off"])
  toast(context, statusText(value), "success")
}

async function doPort(context, current) {
  const portString = await ask(context, {
    title: "Порт web server",
    placeholder: "1-65535",
    value: String(current.port),
    validate: (value) => {
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n < 1 || n > 65535 || String(n) !== value) return "Порт должен быть числом 1-65535"
      return ""
    },
  })
  if (portString == null) return
  const port = Number.parseInt(portString, 10)
  const host = await ask(context, {
    title: "Адрес (host) web server",
    value: current.host,
    validate: (value) => {
      if (!value || value.length > 253 || /\s/.test(value) || !value.replace(/\.$/, "").split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return "Укажите IPv4-адрес или DNS-имя"
      return ""
    },
  })
  if (host == null) return
  const ok = await context.ui.dialog.confirm({
    title: "Применить адрес?",
    message: `http://${host}:${port} — сервис будет перезапущен, если запущен.`,
  })
  if (!ok) return
  const value = await runControl(context, ["port", "--port", String(port), "--host", host])
  toast(context, `Адрес: ${buildAddress(value)}` + (value.restarted ? " · сервис перезапущен" : " · перезапуск при следующем старте"), "success")
}

async function doAddUser(context) {
  const username = await ask(context, {
    title: "Имя нового пользователя",
    placeholder: "letters, digits, . _ -",
    validate: (value) => USERNAME_RE.test(value) ? "" : "Допустимы буквы, цифры, . _ - (до 64 символов).",
  })
  if (username == null) return
  const mode = await context.ui.dialog.select({
    title: "Пароль пользователя",
    options: [
      { title: "Ввести пароль", value: "manual", description: "Минимум 8 символов" },
      { title: "Сгенерировать пароль", value: "generate", description: "Показать один раз после создания" },
    ],
  }).then((result) => {
    if (result == null) return null
    const value = result.value ?? result
    return typeof value === "string" ? value : null
  })
  if (mode == null) return

  if (mode === "generate") {
    const value = await runControl(context, ["user-add", "--username", username])
    await context.ui.dialog.alert({
      title: "Пароль показан один раз",
      message: `${username}: ${value.generatedPassword}`,
    })
    toast(context, `Пользователь ${username} добавлен`, "success")
    return
  }

  let password
  while (true) {
    const first = await context.ui.dialog.prompt({ title: "Пароль (минимум 8 символов)" })
    if (first == null) return
    if (String(first).length < 8) {
      await context.ui.dialog.alert({ title: "Пароль (минимум 8 символов)", message: "Пароль должен быть не короче 8 символов." })
      continue
    }
    const second = await context.ui.dialog.prompt({ title: "Повторите пароль" })
    if (second == null) return
    if (String(first) !== String(second)) {
      await context.ui.dialog.alert({ title: "Пароли не совпадают", message: "Пароли не совпадают. Попробуйте ещё раз." })
      continue
    }
    password = String(first)
    break
  }
  await runControl(context, ["user-add", "--username", username, "--password", password])
  toast(context, `Пользователь ${username} добавлен`, "success")
}

async function doRemoveUser(context) {
  const list = await runControl(context, ["user-list"])
  const users = Array.isArray(list?.users) ? list.users : []
  const store = users.filter((u) => u.source === "store")
  if (!store.length) {
    await context.ui.dialog.alert({
      title: "Нет пользователей",
      message: "В хранилище нет пользователей. Env-пользователь управляется через .env.",
    })
    return
  }
  const choice = await context.ui.dialog.select({
    title: "Удалить пользователя",
    options: [
      ...store.map((u) => ({
        title: u.username,
        value: u.username,
        ...(u.created_at ? { description: `добавлен ${u.created_at}` } : {}),
      })),
      { title: "Отмена", value: null },
    ],
  }).then((result) => {
    if (result == null) return null
    const value = result.value ?? result
    return typeof value === "string" ? value : null
  })
  if (choice == null) return
  const ok = await context.ui.dialog.confirm({
    title: "Удалить пользователя?",
    message: `${choice} будет удалён, его сессии сразу станут недействительны.`,
  })
  if (!ok) return
  await runControl(context, ["user-remove", "--username", choice])
  toast(context, `Пользователь ${choice} удалён`, "success")
}

async function deployFlow(context) {
  const deploy = await context.ui.dialog.select({
    title: "Развернуть web server?",
    options: [
      { title: "Развернуть", value: "deploy", description: "Установить user systemd service через штатный installer." },
      { title: "Отмена", value: "cancel" },
    ],
  }).then((result) => {
    if (result == null) return null
    const value = result.value ?? result
    return typeof value === "string" ? value : null
  })
  if (deploy !== "deploy") return false
  const running = await chooseState(context, "Запустить web server сейчас?", true)
  if (running == null) return false
  const defaultEnabled = await chooseState(context, "Запускать web server по умолчанию?", true)
  if (defaultEnabled == null) return false
  toast(context, "Разворачиваю web server…")
  const value = await runControl(context, ["deploy", "--running", running ? "on" : "off", "--default", defaultEnabled ? "on" : "off"])
  toast(context, statusText(value), "success")
  return true
}

async function menuLoop(context, initial) {
  let current = initial
  while (true) {
    const choice = await context.ui.dialog.select({
      title: `Web server — ${buildAddress(current) || "адрес неизвестен"}`,
      options: [
        { title: "Статус", value: "status", description: `${buildAddress(current)} · ${current.running ? "запущен" : "остановлен"} · ${current.defaultEnabled ? "автозапуск вкл" : "автозапуск выкл"}` },
        { title: "Запустить или остановить", value: "toggle" },
        { title: "Автозапуск", value: "autostart" },
        { title: "Порт и адрес", value: "port" },
        { title: "Добавить пользователя", value: "add-user" },
        { title: "Удалить пользователя", value: "remove-user" },
        { title: "Выход", value: "exit" },
      ],
    }).then((result) => result?.value !== undefined ? result.value : null)
    if (choice == null || choice === "exit") return
    try {
      if (choice === "status") await doStatus(context, current)
      else if (choice === "toggle") await doToggle(context, current)
      else if (choice === "autostart") await doAutostart(context, current)
      else if (choice === "port") await doPort(context, current)
      else if (choice === "add-user") await doAddUser(context)
      else if (choice === "remove-user") await doRemoveUser(context)
    } catch (error) {
      toast(context, `Server: ${error.message}`)
    }
    current = await refreshStatus(context)
  }
}

let wizardOpen = false
async function openWizard(context) {
  if (wizardOpen) return
  wizardOpen = true
  try {
    const current = await runControl(context, ["status"])
    if (!current.deployed) {
      const done = await deployFlow(context)
      if (!done) return
      return
    }
    await menuLoop(context, current)
  } catch (error) {
    toast(context, `Server: ${error.message}`)
  } finally {
    wizardOpen = false
  }
}

async function processCommandStatus(context) {
  try {
    const value = await runControl(context, ["status"])
    const payload = statusToastPayload(value)
    toast(context, payload.message, payload.variant)
  } catch (error) {
    toast(context, `Server: ${error.message}`)
  }
}

function processCommand(context, parsed) {
  if (parsed.type === "error") {
    toast(context, parsed.message)
    return true
  }
  if (parsed.type === "status") {
    void processCommandStatus(context)
    return true
  }
  void openWizard(context)
  return true
}

export default Plugin.define({
  id: "custom.server-wizard",
  setup(context) {
    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor = context.renderer?.currentFocusedEditor ?? context.renderer?.currentFocusedRenderable
      if (!isOpenCodePrompt(editor)) return false
      const parsed = parseServerCommand(promptText(editor))
      if (!parsed) return false
      clearPromptEditor(editor)
      return processCommand(context, parsed)
    })

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 961,
          commands: [{
            id: "custom.server-wizard.open",
            title: "Server: manage web server",
            description: "Status, start/stop, autostart, port/address, users",
            group: "Services",
            palette: true,
            suggested: true,
            slash: { name: SERVER_COMMAND, arguments: true },
            run: (input) => processCommand(context, parseServerCommand(`/${SERVER_COMMAND}${input ? ` ${input}` : ""}`)),
          }],
        }))
        return null
      },
    })

    if (submitRouter.transport === "none") toast(context, "Server: local submit interception is unavailable.")
    return () => {
      submitRouter.dispose?.()
      unslot?.()
    }
  },
})
