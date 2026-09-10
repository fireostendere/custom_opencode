import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../app/', import.meta.url)
const source = (await readFile(new URL('advanced-features.js', root), 'utf8'))
  .replace("from './refresh-coalescer.js'", `from '${new URL('refresh-coalescer.js', root).href}'`)
  .replace("if (typeof document !== 'undefined') init()", 'export { state, applyProjectDefaultsOnce, saveProjectSettings }')
const { state, applyProjectDefaultsOnce, saveProjectSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const stored = new Map(), switched = [], requests = [], elements = new Map()
globalThis.sessionStorage = { getItem:key=>stored.get(key), setItem:(key,value)=>stored.set(key,value) }
globalThis.window = { CustomOpenCodeControls:{ changeModel:async model=>{ switched.push(model);return true } } }
globalThis.document = { getElementById:id=>elements.get(id) }
globalThis.fetch = async (path, options) => {
  requests.push({ path, options })
  return Response.json({ data:[] })
}
state.sessionID = 'empty'
state.settings = { defaultModel:'sol-orchestrated', rag:'off' }
await applyProjectDefaultsOnce()
assert.deepEqual(switched, [{providerID:'openai',id:'gpt-5.6-sol-orchestrated'}], 'Saved SOL alias must actually select SOL')
await applyProjectDefaultsOnce()
assert.equal(switched.length, 1, 'Do not reapply a default over a manual selection')
state.sessionID = 'history'
globalThis.fetch = async () => Response.json({ data:[{id:'msg'}] })
await applyProjectDefaultsOnce()
assert.equal(switched.length, 1, 'Existing conversations keep their model')
state.sessionID = 'unreachable'
globalThis.fetch = async () => new Response('unavailable', { status:503 })
await applyProjectDefaultsOnce()
assert.equal(switched.length, 1, 'Unknown history is not an empty conversation')
assert.equal(stored.has('opencode:web:project-defaults:unreachable'), false)

// A save remains scoped to the project whose form was opened.
state.sessionID = 'save'
const target = { sessionID:'save', directory:'/project-a' }
state.settingsTarget = target
for (const [id,value] of Object.entries({projectInstructions:'Rule',projectDefaultModel:'inherit',projectRag:'off'})) elements.set(id,{value})
elements.set('projectPermissionRules',{querySelectorAll:()=>[]})
elements.set('projectSettingsSave',{disabled:false})
elements.set('projectSettingsStatus',{textContent:''})
let release
globalThis.fetch = async (path, options) => {
  requests.push({path,options})
  return new Promise(resolve=>{release=()=>resolve(Response.json({settings:{instructions:'Rule'}}))})
}
const saving = saveProjectSettings({preventDefault(){}})
assert.equal(elements.get('projectSettingsSave').disabled, true)
assert.equal(JSON.parse(requests.at(-1).options.body).sessionID, 'save')
state.sessionID = 'other'
state.settingsTarget = {sessionID:'other',directory:'/project-b'}
state.settings = { instructions:'Other project' }
elements.get('projectSettingsStatus').textContent='Other form'
release();await saving
assert.equal(state.settings.instructions, 'Other project', 'Late save must not overwrite another project')
assert.equal(elements.get('projectSettingsStatus').textContent, 'Other form')
console.log('Project settings: SOL default, once-only selection, existing/unknown history and stale save isolation passed')
