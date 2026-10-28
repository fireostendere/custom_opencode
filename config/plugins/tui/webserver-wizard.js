import { Plugin } from "@opencode/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { WEB_SERVER_COMMAND, parseWebserverCommand } from "./lib/webserver-command.js"
import {
  runControl,
  activeControl,
  chooseState,
  statusText,
  isOpenCodePrompt,
  promptText,
  clearPromptEditor,
  toast,
} from "./lib/webserver-control.js"

async function showStatus(context) {
  try {
    const value = await runControl(context, ["status"])
    toast(context, value.deployed ? statusText(value) : "Веб-сервер ещё не развёрнут.", value.deployed ? "success" : "warning")
  } catch (error) {
    toast(context, `Веб-сервер: ${error.message}`)
  }
}

let wizardOpen = false
async function openWizard(context) {
  if (wizardOpen) {
    const command = activeControl()
    toast(context, command ? `Веб-сервер: команда «${command}» ещё выполняется, подождите…` : "Веб-сервер: мастер уже открыт", "info")
    return
  }
  wizardOpen = true
  try {
    const current = await runControl(context, ["status"])
    if (!current.deployed) {
      const deploy = await context.ui.dialog.select({
        title: "Развернуть веб-сервер?",
        options: [
          { title: "Развернуть", value: "deploy", description: "Установить пользовательский сервис systemd штатным установщиком." },
          { title: "Отмена", value: "cancel" },
        ],
      }).then((result) => result?.value ?? result ?? null)
      if (deploy !== "deploy") return
      const running = await chooseState(context, "Запустить веб-сервер сейчас?", true)
      if (running == null) return
      const defaultEnabled = await chooseState(context, "Запускать веб-сервер по умолчанию?", true)
      if (defaultEnabled == null) return
      toast(context, "Разворачиваю веб-сервер…")
      const value = await runControl(context, ["deploy", "--running", running ? "on" : "off", "--default", defaultEnabled ? "on" : "off"])
      toast(context, statusText(value), "success")
      return
    }

    const running = await chooseState(context, "Состояние веб-сервера сейчас", current.running)
    if (running == null) return
    const defaultEnabled = await chooseState(context, "Состояние веб-сервера по умолчанию", current.defaultEnabled)
    if (defaultEnabled == null) return
    toast(context, "Применяю состояние веб-сервера…", "info")
    const value = await runControl(context, ["apply", "--running", running ? "on" : "off", "--default", defaultEnabled ? "on" : "off"])
    toast(context, statusText(value), "success")
  } catch (error) {
    toast(context, `Мастер веб-сервера: ${error.message}`)
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
            title: "Веб-сервер: развернуть и настроить",
            description: "Развёртывание, запуск и остановка, состояние при старте",
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

    if (submitRouter.transport === "none") toast(context, "Веб-сервер: перехват локальной отправки недоступен.")
    return () => {
      submitRouter.dispose?.()
      unslot?.()
    }
  },
})
