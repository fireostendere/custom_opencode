import { join } from "node:path"

// Optional, workspace-scoped native MCP. Existing MCP/profile configuration stays
// owned by config-manager; an explicit user binding named fabric takes precedence.
export function toolFabricConfig(directory, env = process.env) {
  if (env.OPENCODE_TOOL_FABRIC !== "1") return null
  const launcher = env.OPENCODE_FABRIC_LAUNCHER || (env.CUSTOM_OPENCODE_ROOT && join(env.CUSTOM_OPENCODE_ROOT, "scripts/tool-fabric.sh"))
  if (!launcher || !directory) throw new Error("Tool Fabric needs a launcher and a project directory")
  const command = ["bash", launcher, "--workspace", directory]
  if (env.OPENCODE_FABRIC_CONFIG) command.push("--config", env.OPENCODE_FABRIC_CONFIG)
  const environment = env.OPENCODE_FABRIC_PYTHON ? { OPENCODE_FABRIC_PYTHON: env.OPENCODE_FABRIC_PYTHON } : {}
  return { type: "local", command, cwd: directory, codemode: false, environment,
    timeout: { startup: 15000, catalog: 10000, execution: 15000 } }
}
