import { spawn } from "node:child_process"

export const CONTROL_COMMAND = process.env.CUSTOM_OPENCODE_WEBSERVER_COMMAND || "custom-opencode-webserver"
export const CONTROL_ARGS = (() => {
  try {
    const value = JSON.parse(process.env.CUSTOM_OPENCODE_WEBSERVER_ARGS || "[]")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
  } catch {
    return []
  }
})()
export const CONTROL_TIMEOUT = 1_900_000

export function promptText(editor) {
  if (!editor || editor.isDestroyed) return ""
  if (typeof editor.plainText === "string") return editor.plainText
  if (typeof editor.getText === "function") return String(editor.getText() ?? "")
  return ""
}

export function clearPromptEditor(editor) {
  if (!editor || editor.isDestroyed) return
  if (typeof editor.clear === "function") editor.clear()
  else if (typeof editor.setText === "function") editor.setText("")
  editor.extmarks?.clear?.()
  editor.gotoBufferEnd?.()
}

export function isOpenCodePrompt(editor) {
  const traits = editor?.traits ?? {}
  return Boolean(editor && !editor.isDestroyed && traits.owner === "opencode" && traits.role === "prompt" && traits.status !== "SHELL")
}

export function toast(context, message, variant = "warning") {
  context.ui.toast.show({ message, variant })
}

export function runControl(context, argumentsList) {
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

export async function chooseState(context, title, enabled) {
  return context.ui.dialog.select({
    title,
    options: [
      { title: "Включено", value: true, description: enabled ? "Текущее значение" : "Запустить или включить" },
      { title: "Выключено", value: false, description: enabled ? "Остановить или отключить" : "Оставить выключенным" },
    ],
  }).then((result) => result?.value ?? result ?? null)
}

export function statusText(value) {
  const running = value?.running ? "запущен" : "остановлен"
  const defaultState = value?.defaultEnabled ? "автозапуск включён" : "автозапуск выключен"
  const address = value?.host && value?.port ? `http://${value.host}:${value.port}` : "адрес неизвестен"
  return `Web server: ${running}, ${defaultState} · ${address}`
}
