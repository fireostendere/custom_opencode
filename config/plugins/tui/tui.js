import { Plugin } from "@opencode-ai/plugin/tui"
import effortIndicator from "./effort-indicator.jsx"
import addWizard from "./add-wizard.js"
import webserverWizard from "./webserver-wizard.js"
import serverWizard from "./server-wizard.js"
import modelSelector from "./model-selector.jsx"
import panelSlash from "./panel-slash.jsx"
import retiredPanel from "./limits-panels.jsx"
import workspacePanel from "./workspace-panel.jsx"
import wslClipboard from "./wsl-clipboard.jsx"
import { installDialogScrollbars } from "./lib/dialog-scrollbar.js"
import locationRecovery from "./location-recovery.jsx"

const plugins = [
  locationRecovery,
  effortIndicator,
  addWizard,
  webserverWizard,
  serverWizard,
  modelSelector,
  panelSlash,
  retiredPanel,
  workspacePanel,
  wslClipboard,
]

export default Plugin.define({
  id: "custom.tui-bundle",
  setup(context) {
    const cleanups = [installDialogScrollbars(context)]
    for (const plugin of plugins) {
      const cleanup = plugin.setup(context)
      if (typeof cleanup === "function") cleanups.push(cleanup)
    }

    return () => {
      for (let index = cleanups.length - 1; index >= 0; index--) cleanups[index]()
    }
  },
})
