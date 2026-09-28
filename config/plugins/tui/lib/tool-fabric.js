import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"

const canonical = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)

/** Fabric refuses "/" and $HOME (app/tool_fabric.py); outside configured project
 * roots it is not a project either. Registering such a server only produces
 * connect failures, and every MCP flap re-injects its instructions. */
export function fabricWorkspaceAllowed(directory, env = process.env) {
  const home = canonical(env.HOME || homedir())
  const workspace = canonical(directory)
  if (workspace === sep || workspace === home) return false
  const roots = String(env.OPENCODE_PROJECT_ROOTS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => canonical(item.replace(/^~(?=$|\/)/, home)))
  return !roots.length || roots.some((root) => inside(workspace, root))
}

// Optional, workspace-scoped native MCP. Existing MCP/profile configuration stays
// owned by config-manager; an explicit user binding named fabric takes precedence.
export function toolFabricConfig(directory, env = process.env) {
  if (env.OPENCODE_TOOL_FABRIC !== "1") return null
  const launcher = env.OPENCODE_FABRIC_LAUNCHER || (env.CUSTOM_OPENCODE_ROOT && join(env.CUSTOM_OPENCODE_ROOT, "scripts/tool-fabric.sh"))
  if (!launcher || !directory) throw new Error("Tool Fabric needs a launcher and a project directory")
  if (!fabricWorkspaceAllowed(directory, env)) return null
  const command = ["bash", launcher, "--workspace", directory]
  if (env.OPENCODE_FABRIC_CONFIG) command.push("--config", env.OPENCODE_FABRIC_CONFIG)
  const environment = env.OPENCODE_FABRIC_PYTHON ? { OPENCODE_FABRIC_PYTHON: env.OPENCODE_FABRIC_PYTHON } : {}
  return { type: "local", command, cwd: directory, codemode: false, environment,
    timeout: { startup: 15000, catalog: 10000, execution: 15000 } }
}
