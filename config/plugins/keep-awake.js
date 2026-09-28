import { startEvents } from "../events.js"

const GRACE_MIN = 30
// A session that never reports idle (crash, lost event) cannot pin the machine awake forever.
const STALE_BUSY_MS = 6 * 60 * 60_000
let keeper = null
let warned = false
// The one shared keeper lives while ANY session is busy: parallel sessions and
// subagents finish independently and one idle session must not release it.
const busy = new Map()

function alive(process) {
  return !!process && process.exitCode === null && process.signalCode === null
}

function powershellCmd() {
  const ps = `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
$end = (Get-Date).AddMinutes(${GRACE_MIN})
while ((Get-Date) -lt $end) {
  [void][W.K]::SetThreadExecutionState([uint32]2147483649)
  Start-Sleep -Seconds 60
}`
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]
}

export function classify(type) {
  if (type === "session.execution.started") return "busy"
  if ([
    "session.idle",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ].includes(type)) return "idle"
  return "ignore"
}

function ensureKeeper() {
  if (!alive(keeper)) keeper = null
  if (keeper) return

  try {
    keeper = Bun.spawn(powershellCmd(), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  } catch (error) {
    if (!warned) {
      warned = true
      console.warn(`[keep-awake] cannot spawn powershell.exe: ${error?.message ?? error}`)
    }
  }
}

function releaseKeeper() {
  if (alive(keeper)) {
    try { keeper.kill() } catch {}
  }
  keeper = null
}

export function observe(event, now = Date.now()) {
  const kind = classify(event?.type)
  if (kind === "ignore") return busy.size > 0
  const id = String(event?.data?.sessionID || "")
  if (kind === "busy") busy.set(id, now)
  else busy.delete(id)
  for (const [session, since] of busy) if (now - since > STALE_BUSY_MS) busy.delete(session)
  return busy.size > 0
}

// Native V2 accepts a plain JS manifest; no runtime SDK dependency is needed.
export default {
  id: "keep-awake",
  setup(ctx) {
    const sync = (awake) => (awake ? ensureKeeper() : releaseKeeper())
    const stop = startEvents(ctx, (event) => {
      if (classify(event?.type) !== "ignore") sync(observe(event))
    })
    // The keeper script exits after GRACE_MIN; renew it for long busy turns.
    const renew = setInterval(() => sync(observe(null)), 5 * 60_000)
    renew.unref?.()
    return () => {
      stop()
      clearInterval(renew)
      busy.clear()
      releaseKeeper()
    }
  },
}

if (process.env.KEEP_AWAKE_SELF_CHECK) {
  const cases = [
    ["session.execution.started", "busy"],
    ["session.idle", "idle"],
    ["session.execution.failed", "idle"],
    ["session.updated", "ignore"],
  ]
  for (const [input, want] of cases) {
    const got = classify(input)
    if (got !== want) throw new Error(`classify(${JSON.stringify(input)}) = ${got}, want ${want}`)
  }
  console.log("keep-awake self-check OK")
}
