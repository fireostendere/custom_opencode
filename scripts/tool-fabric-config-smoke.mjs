import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolFabricConfig } from '../config/plugins/tui/lib/tool-fabric.js'
import { filterMcpTools } from '../config/plugins/tui/lib/mcp-profiles.js'

assert.equal(toolFabricConfig('/tmp/project', {}), null)
const env = { OPENCODE_TOOL_FABRIC: '1', CUSTOM_OPENCODE_ROOT: '/tmp/adapter', OPENCODE_FABRIC_PYTHON: '/opt/fabric/python' }
const binding = toolFabricConfig('/tmp/project with spaces', env)
assert.deepEqual(binding.command, ['bash', '/tmp/adapter/scripts/tool-fabric.sh', '--workspace', '/tmp/project with spaces'])
assert.equal(binding.cwd, '/tmp/project with spaces')
assert.equal(binding.codemode, false)
assert.equal(binding.environment.OPENCODE_FABRIC_PYTHON, '/opt/fabric/python')
assert.throws(() => toolFabricConfig(undefined, env), /project directory/)
const tools = { fabric_catalog_search: {}, fabric_tool_run: {}, read: {} }
filterMcpTools(tools, { fabric: binding }, { core: { mcp: [] } }, { id: 'core' })
assert.deepEqual(Object.keys(tools), ['read'], 'fabric must obey existing profile isolation')
// Fabric refuses / and $HOME: registering it there only produces connect failures.
assert.equal(toolFabricConfig(homedir(), env), null, 'no fabric for the home directory')
assert.equal(toolFabricConfig('/', env), null, 'no fabric for the filesystem root')
const roots = mkdtempSync(join(tmpdir(), 'fabric-roots-'))
try {
  mkdirSync(join(roots, 'allowed', 'project'), { recursive: true })
  mkdirSync(join(roots, 'other'), { recursive: true })
  const bounded = { ...env, OPENCODE_PROJECT_ROOTS: `${join(roots, 'missing')};${join(roots, 'allowed')}` }
  assert.ok(toolFabricConfig(join(roots, 'allowed', 'project'), bounded), 'projects inside a configured root keep fabric')
  assert.equal(toolFabricConfig(join(roots, 'other'), bounded), null, 'directories outside OPENCODE_PROJECT_ROOTS get no fabric')
  assert.equal(toolFabricConfig(join(roots, 'allowed-sibling'), bounded), null, 'prefix siblings are outside the root')
} finally {
  rmSync(roots, { recursive: true, force: true })
}
console.log('Tool Fabric config passed: opt-in, workspace binding, literal paths, profile isolation, home/root/project-root refusal')
