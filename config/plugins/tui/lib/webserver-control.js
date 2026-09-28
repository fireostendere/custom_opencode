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
// Only deploy may run for long (install.sh; webserver-control.py itself stops
// it after OPENCODE_WEBSERVER_DEPLOY_TIMEOUT=1800 s). Service changes wait for
// HTTP readiness (OPENCODE_WEBSERVER_READY_TIMEOUT=50 s by default) after up to
// three systemctl calls; queries must answer quickly.
export const CONTROL_TIMEOUT = 1_900_000
export const QUERY_TIMEOUT = 20_000
export const SERVICE_TIMEOUT = 90_000
const COMMAND_TIMEOUTS = {
  status: QUERY_TIMEOUT,
  "user-list": QUERY_TIMEOUT,
  "user-add": QUERY_TIMEOUT,
  "user-remove": QUERY_TIMEOUT,
  apply: SERVICE_TIMEOUT,
  default: SERVICE_TIMEOUT,
  start: SERVICE_TIMEOUT,
  stop: SERVICE_TIMEOUT,
  port: SERVICE_TIMEOUT,
  deploy: CONTROL_TIMEOUT,
}

export function controlTimeout(argumentsList) {
  return COMMAND_TIMEOUTS[argumentsList?.[0]] ?? QUERY_TIMEOUT
}

// Commands currently running in this TUI (shared by /server and /webserver).
const running = new Map()
let nextRun = 0

/** Name of a control command still running, if any. */
export function activeControl() {
  return running.size ? [...running.values()].at(-1) : null
}

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

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch {}
  }
}

/**
 * Run one webserver control command. `options.input` is written to stdin
 * (secrets must never travel in argv, which /proc/<pid>/cmdline exposes).
 * The command runs in its own process group, killed as a whole on timeout.
 */
export function runControl(context, argumentsList, options = {}) {
  const id = ++nextRun
  running.set(id, argumentsList[0])
  const done = () => running.delete(id)
  const injected = context.webserverControl?.run
  if (typeof injected === "function") {
    return Promise.resolve().then(() => injected(argumentsList, { input: options.input })).finally(done)
  }
  const timeoutMs = options.timeoutMs ?? controlTimeout(argumentsList)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(CONTROL_COMMAND, [...CONTROL_ARGS, ...argumentsList], {
        stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    if (options.input != null) {
      child.stdin.on("error", () => {})
      child.stdin.end(String(options.input))
    }
    let output = ""
    let errorOutput = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killGroup(child, "SIGTERM")
      const killer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) killGroup(child, "SIGKILL")
      }, 2_000)
      killer.unref?.()
      reject(new Error(`web server control timed out after ${Math.ceil(timeoutMs / 1000)} s (${argumentsList[0]})`))
    }, timeoutMs)
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
  }).finally(done)
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
