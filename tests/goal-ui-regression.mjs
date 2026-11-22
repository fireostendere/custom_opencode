import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { describeGoal, watchGoal } from '../config/plugins/tui/lib/goal-view.js'

const shared = new URL('../config/plugins/tui/lib/goal-view.js', import.meta.url).href
const api = new URL('../app/api.js', import.meta.url).href
const source = (await readFile(new URL('../app/goal-banner.js', import.meta.url), 'utf8'))
  .replace("'/client-goal-view.js'", JSON.stringify(shared)).replace("'./api.js'", JSON.stringify(api))
const { goalMarkup } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const goal = { id:'fixture', status:'active', objective:'<img src=x onerror=alert(1)>', summary:'Проверяю тесты', turns:3, failures:0 }
for (const [status, label] of Object.entries({ active:'Достижение цели', paused:'Цель на паузе', blocked:'Цель заблокирована', completed:'Цель достигнута' })) {
  const value = { ...goal, status }
  assert.equal(describeGoal(value).headline, label)
  const markup = goalMarkup(value)
  assert.match(markup, /&lt;img/)
  assert.ok(!markup.includes('<img'))
  assert.ok(markup.includes(label))
  assert.ok(markup.includes('Проверяю тесты'))
  assert.equal(markup.includes('data-goal-action="stop"'), status === 'active')
  assert.equal(markup.includes('data-goal-action="resume"'), ['paused', 'blocked'].includes(status))
}
assert.equal(goalMarkup(null), '')
assert.match(goalMarkup({ ...goal, unavailable:true }), /Нет связи/)
assert.ok(!goalMarkup({ ...goal, unavailable:true }).includes('data-goal-action'))

mock.timers.enable({ apis:['setTimeout'] })
const flush = async () => { for (let i=0; i<5; i++) await setImmediate() }
let release, fail = false
const changes = [], reads = []
const watcher = watchGoal({
  read: async id => {
    reads.push(id)
    if (id === 'old') return new Promise(resolve => { release = resolve })
    if (fail) throw new Error('offline')
    return { goal }
  },
  onChange: value => changes.push(value), intervalMs:100,
})
try {
  watcher.setSession('old', '/project')
  watcher.setSession('new', '/project')
  release({ goal:{ ...goal, objective:'DO NOT SHOW OLD GOAL' } })
  await flush(); mock.timers.tick(0); await flush()
  assert.deepEqual(reads, ['old', 'new'])
  assert.deepEqual(changes, [goal], 'late old-session reply must never paint the new session')
  mock.timers.tick(100); await flush()
  assert.equal(changes.length, 1, 'unchanged polling must not rebuild the composer')
  fail = true
  await watcher.refresh()
  assert.equal(changes.at(-1).unavailable, true)
  assert.match(describeGoal(changes.at(-1)).headline, /недоступен/)
  fail = false
  await watcher.refresh()
  assert.equal(changes.at(-1).unavailable, undefined)
  watcher.setSession(null)
  assert.equal(changes.at(-1), null)
  mock.timers.tick(1000); await flush()
  const count = reads.length
  watcher.stop()
  mock.timers.tick(1000); await flush()
  assert.equal(reads.length, count)
} finally { watcher.stop(); mock.timers.reset() }
console.log('Goal UI passed: all states, shared wording, escaped objective, actions, session isolation, unchanged polls, offline recovery and cleanup')
