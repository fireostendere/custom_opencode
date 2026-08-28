import { Plugin } from "@opencode-ai/plugin"
import { startEvents } from "../events.js"

const IDLE_MIN_MS = 60_000
const ASK_DEDUPE_MS = 10_000
const FOCUS_APPS = (process.env.NOTIFY_WIN_FOCUS_APPS ?? "WindowsTerminal,OpenConsole,ConHost,Code")
  .split(",").map((value) => value.trim()).filter(Boolean)

export function psQuote(value) {
  return String(value ?? "").replace(/'/g, "''").slice(0, 200)
}

function toast(title, message) {
  const apps = FOCUS_APPS.map(psQuote).join(",")
  const ps = `
Add-Type -Namespace F -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);'
$ns = [int]0
[void][F.W]::SHQueryUserNotificationState([ref]$ns)
if ($ns -ne 5) { exit }
$h = [F.W]::GetForegroundWindow()
$fgpid = [uint32]0
[void][F.W]::GetWindowThreadProcessId($h, [ref]$fgpid)
$fg = (Get-Process -Id $fgpid -ErrorAction SilentlyContinue).ProcessName
if (@(${apps}) -contains $fg) { exit }
$m = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = $m::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($xml.CreateTextNode('${psQuote(title)}'))
[void]$t.Item(1).AppendChild($xml.CreateTextNode('${psQuote(message)}'))
$m::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`
  try {
    Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
  } catch {}
}

export default Plugin.define({
  id: "notify-win",
  async setup(ctx) {
    let busySince = 0
    let lastAskAt = 0

    async function label(sessionID) {
      if (!sessionID) return ""
      try {
        const session = await ctx.session.get({ sessionID })
        return (session.title ?? "").slice(0, 80)
      } catch {
        return ""
      }
    }

    const permission = await ctx.permission.hook("evaluate", ({ sessionID, action, resources }) => {
      const now = Date.now()
      busySince ||= now
      if (now - lastAskAt < ASK_DEDUPE_MS) return
      lastAskAt = now
      toast("opencode: ждёт разрешения", `${action}${resources[0] ? ` — ${resources[0]}` : ""}`)
    })

    const stop = startEvents(ctx, async (event) => {
      const sessionID = event.data?.sessionID
      if (event.type === "session.execution.started") {
        busySince ||= Date.now()
      } else if (event.type === "session.idle") {
        const duration = busySince ? Date.now() - busySince : 0
        busySince = 0
        if (duration < IDLE_MIN_MS) return
        const title = await label(sessionID)
        toast("opencode: джоба завершилась", `${title ? `${title} · ` : ""}работала ${Math.round(duration / 60_000)} мин`)
      } else if (event.type === "session.execution.failed") {
        busySince = 0
        toast("opencode: ошибка в джобе", await label(sessionID) || "сессия упала с ошибкой")
      } else if (event.type === "session.execution.interrupted") {
        busySince = 0
      }
    })

    return async () => {
      stop()
      await permission.dispose()
    }
  },
})

if (process.env.NOTIFY_WIN_SELF_CHECK) {
  if (psQuote("it's") !== "it''s") throw new Error("apostrophe not doubled")
  if (psQuote("x".repeat(300)).length !== 200) throw new Error("length cap")
  if (psQuote(undefined) !== "") throw new Error("undefined -> empty")
  console.log("notify-win self-check OK")
}
