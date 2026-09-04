import { spawn } from "node:child_process"
import { Plugin } from "@opencode-ai/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { WEB_SERVER_COMMAND, parseWebserverCommand } from "./lib/webserver-command.js"

const CONTROL_COMMAND = process.env.CUSTOM_OPENCODE_WEBSERVER_COMMAND || "custom-opencode-webserver"
const CONTROL_ARGS = (() => {
  try {
    const value = JSON.parse(process.env.CUSTOM_OPENCODE_WEBSERVER_ARGS || "[]")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
  } catch {
    return []
  }
})()
const CONTROL_TIMEOUT = 1_900_000

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

function toast(context, message, variant = "warning") {
  context.ui.toast.show({ message, variant })
}

function runControl(context, argumentsList) {
  const injected = context.webserverControl?.run
  if (typeof injected === "function") return Promise.resolve().then(() => injected(argumentsList))
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(CONTROL_COMMAND, [...CONTROL_ARGS, ...argumentsList], { stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      reject(error)
      return
    }
    let output = ""
    let errorOutput = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error("web server control timed out"))
    }, CONTROL_TIMEOUT)
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk) })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = output.trim().split("\n").filter(Boolean)
      let value = null
      try { value = lines.length ? JSON.parse(lines.at(-1)) : null } catch {}
      if (code !== 0 || value?.ok === false) {
        reject(new Error(value?.error || errorOutput.trim() || `web server control exited ${code}`))
        return
      }
      resolve(value || {})
    })
  })
}

async function chooseState(context, title, enabled) {
  return context.ui.dialog.select({
    title,
    options: [
      { title: "Включено", value: true, description: enabled ? "Текущее значение" : "Запустить или включить" },
      { title: "Выключено", value: false, description: enabled ? "Остановить или отключить" : "Оставить выключенным" },
    ],
  }).then((result) => result?.value ?? result ?? null)
}

function statusText(value) {
  const running = value?.running ? "запущен" : "остановлен"
  const defaultState = value?.defaultEnabled ? "автозапуск включён" : "автозапуск выключен"
  const address = value?.host && value?.port ? `http://${value.host}:${value.port}` : "адрес неизвестен"
  return `Web server: ${running}, ${defaultState} · ${address}`
}

async function showStatus(context) {
  try {
    const value = await runControl(context, ["status"])
    toast(context, value.deployed ? statusText(value) : "Web server ещё не развёрнут.", value.deployed ? "success" : "warning")
  } catch (error) {
    toast(context, `Web server: ${error.message}`)
  }
}

let wizardOpen = false
async function openWizard(context) {
  if (wizardOpen) return
  wizardOpen = true
  try {
    const current = await runControl(context, ["status"])
    if (!current.deployed) {
      const deploy = await context.ui.dialog.select({
        title: "Развернуть web server?",
        options: [
          { title: "Развернуть", value: "deploy", description: "Установить user systemd service через штатный installer." },
          { title: "Отмена", value: "cancel" },
        ],
      }).then((result) => result?.value ?? result ?? null)
      if (deploy !== "deploy") return
      const running = await chooseState(context, "Запустить web server сейчас?", true)
      if (running == null) return
      const defaultEnabled = await chooseState(context, "Запускать web server по умолчанию?", true)
      if (defaultEnabled == null) return
      toast(context, "Разворачиваю web server…")
      const value = await runControl(context, ["deploy", "--running", running ? "on" : "off", "--default", defaultEnabled ? "on" : "off"])
      toast(context, statusText(value), "success")
      return
    }

    const running = await chooseState(context, "Состояние web server сейчас", current.running)
    if (running == null) return
    const defaultEnabled = await chooseState(context, "Состояние web server по умолчанию", current.defaultEnabled)
    if (defaultEnabled == null) return
    const value = await runControl(context, ["apply", "--running", running ? "on" : "off", "--default", defaultEnabled ? "on" : "off"])
    toast(context, statusText(value), "success")
  } catch (error) {
    toast(context, `Web server wizard: ${error.message}`)
  } finally {
    wizardOpen = false
  }
}

function processCommand(context, parsed) {
  if (parsed.type === "error") {
    toast(context, parsed.message)
    return true
  }
  if (parsed.type === "status") {
    void showStatus(context)
    return true
  }
  void openWizard(context)
  return true
}

export default Plugin.define({
  id: "custom.webserver-wizard",
  setup(context) {
    const submitRouter = installPanelSubmitRouter(context, () => {
      const editor = context.renderer?.currentFocusedEditor ?? context.renderer?.currentFocusedRenderable
      if (!isOpenCodePrompt(editor)) return false
      const parsed = parseWebserverCommand(promptText(editor))
      if (!parsed) return false
      clearPromptEditor(editor)
      return processCommand(context, parsed)
    })

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 960,
          commands: [{
            id: "custom.webserver-wizard.open",
            title: "Web server: deploy and configure",
            description: "Deploy, start/stop and set the default startup state",
            group: "Services",
            palette: true,
            suggested: true,
            slash: { name: WEB_SERVER_COMMAND, arguments: true },
            run: (input) => processCommand(context, parseWebserverCommand(`/${WEB_SERVER_COMMAND}${input ? ` ${input}` : ""}`)),
          }],
        }))
        return null
      },
    })

    if (submitRouter.transport === "none") toast(context, "Web server: local submit interception is unavailable.")
    return () => {
      submitRouter.dispose?.()
      unslot?.()
    }
  },
})
