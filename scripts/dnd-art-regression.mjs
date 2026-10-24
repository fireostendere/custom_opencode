import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtWorker, decode, imageInfo, libraryEntry, publishArt, generateImage } from '../config/plugins/dnd-art.js'

// A real, tiny PNG: exercise bytes, not a generator-shaped string.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
assert.deepEqual(imageInfo(png), { width: 1, height: 1, mime: 'image/png' })
assert.throws(() => imageInfo(Buffer.from('not an image')))
assert.deepEqual(decode({ content: [{ type: 'text', text: '{"result":{"ok":true}}' }] }), { ok: true })
assert.deepEqual(decode({ content: '{"currentSeq":1}' }), { currentSeq: 1 })
assert.throws(() => decode({ content: '{"isError":true}' }))
const entry = libraryEntry(png, { kind: 'npc_portrait', style: 'normal' })
assert.equal(entry.category, 'npc')
assert(!JSON.stringify(entry).includes('campaign'))
let head = 'old', collisions = 0, writes = 0
const api = async (path, body) => {
  if (path === 'git/ref/heads/main') return { object: { sha: head } }
  if (path.startsWith('git/commits/')) return { tree: { sha: 'base' } }
  if (path === 'git/trees/base') return { tree: [{ path: 'art-index.json', type: 'blob', sha: 'index' }] }
  if (path === 'git/blobs/index') return { content: Buffer.from(JSON.stringify({ images: [], imageCount: 0 })).toString('base64') }
  if (path === 'git/blobs') return { sha: 'blob' }
  if (path === 'git/trees') return { sha: 'tree' }
  if (path === 'git/commits') return { sha: 'new' }
  if (path === 'git/refs/heads/main') {
    assert.equal(body.force, false)
    if (!collisions++) { head = 'concurrent'; throw new Error('conflict') }
    writes++; return { object: { sha: 'new' } }
  }
  throw Error(path)
}
assert.equal((await publishArt(png, entry, api)).commit, 'new')
assert.equal(writes, 1, 'non-fast-forward publication retries index merge, not generation')

const root = await mkdtemp(join(tmpdir(), 'dnd-art-'))
try {
  const records = new Map(), storage = { get: async k => records.get(k), set: async (k,v) => records.set(k, structuredClone(v)) }
  let generates = 0, publishes = 0, submits = 0, rejectPublish = true
  const job = { id: 'job', target: { type: 'npc', id: 'npc' }, kind: 'npc_portrait', status: 'available' }
  const calls = []
  const assets = async args => {
    calls.push(args)
    if (args.operation === 'health') return { primaryOnlyIfMissing: true }
    if (args.operation === 'plan_campaign') return { pack: { jobs: [job] } }
    if (args.operation === 'get_image') return { image: null }
    if (args.operation === 'create_upload') return { uploadId: 'upload', uploadUrl: 'https://odm.test/api/assets/ingest/upload', authorization: { token: 'scoped' } }
    if (args.operation === 'submit_result') { submits++; return { asset: { id: 'asset' } } }
    return { job }
  }
  const worker = createArtWorker({ storage, root, assets,
    generate: async () => { generates++; return png },
    publish: async () => { publishes++; if (rejectPublish) throw Error('offline'); return { url: 'https://example.test/art.png' } },
    upload: async () => {},
  })
  const input = { campaignId: 'campaign', entityId: 'npc', kind: 'npc_portrait', publicPrompt: 'A dwarf with a red beard', style: 'normal' }
  await assert.rejects(worker.run(input), /offline/)
  rejectPublish = false
  const result = await worker.run(input)
  assert.equal(result.status, 'ready')
  assert.equal(generates, 1, 'publishing failure must reuse saved image')
  assert.equal(publishes, 2)
  assert.equal(submits, 1)
  await worker.run(input)
  assert.equal(submits, 1, 'completed work is idempotent')
  assert.equal((await readFile(join(root, result.id + '.png'))).length, png.length)
  assert.equal(calls.find(c => c.operation === 'submit_result').metadata.onlyIfMissing, true)
  await assert.rejects(worker.run({ ...input, entityId: 'other' }), /missing art job/)
  const existing = createArtWorker({ storage, root, assets: async a => a.operation === 'health' ? { primaryOnlyIfMissing: true } : a.operation === 'plan_campaign' ? { pack: { jobs: [{ ...job, target: { ...job.target, id: 'existing' } }] } } : { image: { url: '/uploads/real.png' } }, generate: () => { throw Error('must not generate') } })
  assert.equal((await existing.run({ ...input, entityId: 'existing' })).status, 'existing')
  const oldServer = createArtWorker({ storage, root, assets: async () => ({}) })
  await assert.rejects(oldServer.run({ ...input, entityId: 'old-server' }), /Update ODM/)
  await assert.rejects(generateImage('test', { signal: AbortSignal.abort() }), /abort/i)
} finally { await rm(root, { recursive: true, force: true }) }
console.log('D&D art: image validation, conflict merge, saved-result recovery, target guard and idempotency passed')
