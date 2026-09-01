/** @jsxImportSource @opentui/solid */
/**
 * Migration tombstone for the former single right-side `custom.universal-panel`.
 *
 * `workspace-panel.jsx` now owns all four dock zones and migrates the persisted
 * universal-panel state. Keeping this filename inert ensures upgrades overwrite
 * an older auto-discovered implementation instead of loading two panel hosts.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

export default Plugin.define({
  id: "custom.limits-panels-retired",
  setup() {
    return () => {}
  },
})
