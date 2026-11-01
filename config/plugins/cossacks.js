import { spawn } from 'node:child_process'
import { realpathSync, existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { serviceSetting } from './config-manager.js'

export function projectFile(root, name) {
  if (typeof name !== 'string' || !name || name.length > 512 || isAbsolute(name)) throw Error('Project-relative artifact path required')
  const base = realpathSync(join(root, 'data/derived'))
  const path = realpathSync(resolve(root, name))
  const rel = relative(base, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Use an artifact inside this project data/derived directory')
  return path
}

export function labCommand(root, input) {
  if (!input || Object.keys(input).some(k => !['action', 'artifact'].includes(k)) || !['status', 'review-input', 'dataset-audit'].includes(input.action))
    throw Error('Supported offline Cossacks lab action required')
  if (input.action === 'status') {
    if (input.artifact !== undefined) throw Error('Status takes no artifact')
    return [join(root, 'scripts/run_script_advisor.py'), 'status']
  }
  const path = projectFile(root, input.artifact)
  return [join(root, 'scripts/run_script_advisor.py'), input.action === 'review-input' ? 'inspect' : 'dataset-audit',
    input.action === 'review-input' ? '--request' : '--dataset', path]
}

export function runLab(python, args, { signal, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let output = '', overflow = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (Buffer.byteLength(output) > 65536) { overflow = true; output = ''; child.kill() }
    })
    child.stderr.resume()
    child.on('error', () => reject(Error('Cossacks lab process unavailable or cancelled')))
    child.on('close', code => {
      if (code !== 0 || overflow) return reject(Error('Cossacks lab did not complete; no game action was issued'))
      try { resolvePromise(JSON.parse(output)) }
      catch { reject(Error('Invalid Cossacks lab receipt')) }
    })
  })
}

export default {
  id: 'custom.cossacks',
  async setup(ctx) {
    const configured = serviceSetting('COSSACKS_PROJECT_ROOT') || ctx.location?.directory
    if (!configured || !existsSync(join(configured, 'scripts/run_script_advisor.py'))) return
    const root = realpathSync(configured)
    const python = serviceSetting('COSSACKS_PYTHON') || 'python3'
    const controller = new AbortController()
    const registration = await ctx.tool.transform(tools => tools.add({
      name: 'cossacks_lab',
      description: 'Read-only offline Cossacks lab: inspect script-advice input, available backends and outcome-labelled dataset partitions. Never applies gameplay proposals, edits scripts, trains during a match or starts the game. Use the documented offline CLI for research training and paid backend comparisons.',
      input: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['status', 'review-input', 'dataset-audit'] },
        artifact: { type: 'string', maxLength: 512, description: 'Project-relative file under data/derived; omitted for status.' },
      } },
      options: { pinned: true, codemode: false },
      execute: async (input, context) => {
        const args = labCommand(root, input)
        await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
          source: { type: 'tool', messageID: context.messageID, id: context.id },
          action: 'cossacks_lab', resources: [root] })
        const signals = [controller.signal, AbortSignal.timeout(15000)]
        const native = context.signal || context.abortSignal
        if (native instanceof AbortSignal) signals.push(native)
        const result = await runLab(python, args, { cwd: root, signal: AbortSignal.any(signals) })
        return { content: JSON.stringify(result), metadata: { mode: 'offline-read-only' } }
      },
    }))
    return async () => { controller.abort(); await registration.dispose() }
  },
}
