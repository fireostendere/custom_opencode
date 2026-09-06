import { Plugin } from "@opencode-ai/plugin/tui"
import { installPanelSubmitRouter } from "./lib/panel-submit-router.js"
import { WEB_SERVER_COMMAND, parseWebserverCommand } from "./lib/webserver-command.js"
import {
  runControl,
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
