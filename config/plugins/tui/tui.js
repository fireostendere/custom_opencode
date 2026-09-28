import { Plugin } from "@opencode-ai/plugin/tui"
import effortIndicator from "./effort-indicator.jsx"
import dndWatchPanel from "./dnd-watch-panel.jsx"
import addWizard from "./add-wizard.js"
import webserverWizard from "./webserver-wizard.js"
import serverWizard from "./server-wizard.js"
import modelSelector from "./model-selector.jsx"
import panelSlash from "./panel-slash.jsx"
import retiredPanel from "./limits-panels.jsx"
import workspacePanel from "./workspace-panel.jsx"
import wslClipboard from "./wsl-clipboard.jsx"
import { installDialogScrollbars } from "./lib/dialog-scrollbar.js"
import { installCompactionRecovery } from "./lib/compaction-recovery.js"
import locationRecovery from "./location-recovery.jsx"

const plugins = [
  locationRecovery,
  effortIndicator,
  dndWatchPanel,
  addWizard,
  webserverWizard,
  serverWizard,
  modelSelector,
  panelSlash,
  retiredPanel,
  workspacePanel,
  wslClipboard,
]

// One failing sub-plugin must neither abort the others nor leak the patches
// and timers of those already installed: the bundle cleanup always unwinds
// every successful setup (otherwise a hot reload double-wraps them), and one
// throwing cleanup does not skip the rest. Each failure is logged once.
const reported = new Set()
function report(context, stage, name, error) {
  const key = `${stage}:${name}`
  if (reported.has(key)) return
  reported.add(key)
  try {
    console.error(`[custom.tui-bundle] ${name} ${stage} failed:`, error)
  } catch {}
  if (stage !== "setup") return
  try {
    context.ui?.toast?.show?.({ message: `TUI plugin ${name} failed to load: ${error?.message ?? error}`, variant: "error" })
  } catch {}
}

function setupBundle(context, parts) {
  const cleanups = []
  let disposed = false
  const keep = (name, cleanup) => {
    if (typeof cleanup !== "function") return
    if (disposed) {
      try { cleanup() } catch (error) { report(context, "cleanup", name, error) }
    } else cleanups.push({ name, cleanup })
  }
  for (const { name, setup } of parts) {
    try {
      const result = setup(context)
      if (typeof result?.then === "function") {
        result.then((cleanup) => keep(name, cleanup), (error) => report(context, "setup", name, error))
      } else keep(name, result)
    } catch (error) {
      report(context, "setup", name, error)
    }
  }
  return () => {
    disposed = true
    for (let index = cleanups.length - 1; index >= 0; index--) {
      const { name, cleanup } = cleanups[index]
      try {
        cleanup()
      } catch (error) {
        report(context, "cleanup", name, error)
      }
    }
    cleanups.length = 0
  }
}

export default Plugin.define({
  id: "custom.tui-bundle",
  setup(context) {
    return setupBundle(context, [
      { name: "dialog-scrollbar", setup: () => installDialogScrollbars(context) },
      { name: "compaction-recovery", setup: () => installCompactionRecovery(context) },
      ...plugins.map((plugin) => ({ name: plugin.id ?? "plugin", setup: (value) => plugin.setup(value) })),
    ])
  },
})
