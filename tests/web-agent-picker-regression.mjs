import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8')
const controls = source.slice(source.indexOf('function renderControls(){'), source.indexOf('async function changeModel('))
const elements = Object.fromEntries(['agentSelect', 'agentControls', 'modelButton', 'variantSelect'].map(id => [id, { dataset:{}, disabled:false }]))
const state = { selected:{ id:'s0', agent:'review' }, models:[], agents:[{id:'build'}, {id:'plan'}, {id:'review'}, {id:'build-direct', hidden:true}] }
let writes = 0, resolveWrite, rejectWrite
const sandbox = { state, pendingAgentChanges:new Set(), $:id=>elements[id], escapeHtml:value=>String(value).replaceAll('"', '&quot;'),
  document:{ documentElement:{dataset:{}}, querySelectorAll:()=>[] }, window:{dispatchEvent:()=>{}}, CustomEvent:class {},
  modeFromAgent:id=>id.startsWith('plan')?'plan':'build', activeModelRef:()=>null, activeModel:()=>null, modelRefLabel:()=>'', modelVariants:()=>[], toast:()=>{},
  api:{ switchAgent:()=>{ writes++; return new Promise((resolve,reject)=>{resolveWrite=resolve;rejectWrite=reject}) } } }
vm.createContext(sandbox)
vm.runInContext(controls, sandbox)
sandbox.renderControls()
assert.equal(elements.agentSelect.value, 'review')
assert.equal(writes, 0, 'render must not change agent')
assert.ok(!elements.agentSelect.innerHTML.includes('build-direct'))
assert.equal((elements.agentControls.innerHTML.match(/class="active"/g)||[]).length, 1)
const change = sandbox.changeAgent('plan')
assert.equal(elements.agentSelect.disabled, true)
assert.equal(await sandbox.changeAgent('build'), false)
rejectWrite(new Error('failed'))
assert.equal(await change, false)
assert.equal(elements.agentSelect.value, 'review')
assert.equal(elements.agentSelect.disabled, false)
const success = sandbox.changeAgent('plan')
resolveWrite()
assert.equal(await success, true)
assert.equal(elements.agentSelect.value, 'plan')
assert.equal(elements.agentSelect.disabled, false)
sandbox.document.documentElement.dataset.modelTransition='1'
sandbox.renderControls()
assert.equal(elements.agentSelect.disabled, true)
delete sandbox.document.documentElement.dataset.modelTransition
const pending = sandbox.changeAgent('plan')
state.selected = {id:'s1', agent:'missing-agent'}
sandbox.renderControls()
assert.equal(elements.agentSelect.value, 'missing-agent')
assert.ok(elements.agentSelect.innerHTML.includes('missing-agent'))
assert.equal(elements.agentSelect.disabled, false)
resolveWrite()
await pending
assert.equal(elements.agentSelect.value, 'missing-agent')
state.selected=null
state.draftAgent='build'
assert.equal(await sandbox.changeAgent('review'), true)
assert.equal(state.draftAgent, 'review')
assert.equal(writes, 3, 'draft switch must not write session API')
state.agents=[]
sandbox.renderControls()
assert.equal(elements.agentSelect.value, 'review', 'loading must retain current agent')
assert.equal(elements.agentSelect.disabled, true)
console.log('PASS agent picker: current/custom/missing agents, passive render, rollback, overlapping writes, session navigation, draft')
