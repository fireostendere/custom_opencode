import assert from 'node:assert/strict'
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
console.log('Tool Fabric config passed: opt-in, workspace binding, literal paths, profile isolation')
