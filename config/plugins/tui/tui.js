import { Plugin } from "@opencode-ai/plugin/tui"
import effortIndicator from "./effort-indicator.jsx"
import modelSelector from "./model-selector.jsx"
import panelSlash from "./panel-slash.jsx"
import promptHistory from "./prompt-history.jsx"
import retiredPanel from "./limits-panels.jsx"
import workspacePanel from "./workspace-panel.jsx"
import wslClipboard from "./wsl-clipboard.jsx"

const plugins = [
  effortIndicator,
  modelSelector,
  panelSlash,
  promptHistory,
  retiredPanel,
  workspacePanel,
  wslClipboard,
]

export default Plugin.define({
  id: "custom.tui-bundle",
  setup(context) {
    const cleanups = []
    for (const plugin of plugins) {
      const cleanup = plugin.setup(context)
      if (typeof cleanup === "function") cleanups.push(cleanup)
    }

    return () => {
      for (let index = cleanups.length - 1; index >= 0; index--) cleanups[index]()
    }
  },
})
