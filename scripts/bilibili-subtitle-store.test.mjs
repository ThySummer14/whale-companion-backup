import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { BILIBILI_AUTONOMY_CONTEXT } from '../src/core/model.ts'

const bvid = 'BV1dLx46TEhw'
const digest = 'a'.repeat(64)
const provenance = { kind: 'owner-supplied', sha256: digest }

function database(t) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync(join('.work', 'bili-subtitle-store-'))
  const path = join(dir, 'store.sqlite')
  let store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get store() { return store }, restart() { store.close(); store = new CompanionStore(path) } }
}

function attachment(overrides = {}) {
  return {
    bvid, part: 1, cid: 71, format: 'srt', sha256: digest, cueCount: 2,
    excerpt: { status: 'excerpt', language: 'und', truncated: true, provenance, cues: [{ from: 0.5, to: 1.75, text: '主人提供的片段' }] },
    ...overrides,
  }
}

function recordRead(store, item, data = {}, kind = 'video.subtitle-read') {
  const at = new Date().toISOString()
  const activityId = store.recordActivity({
    contextId: BILIBILI_AUTONOMY_CONTEXT, sessionId: 'subtitle-qa', source: 'media.bilibili', kind,
    status: 'success', occurredAt: at, summary: 'fixture', data: { bvid: item.bvid, part: item.part, candidateId: item.id, ...data },
  })
  return { activityId, at, kind }
}

test('attachment rows preserve exact part, CID and provenance and only return text on targeted get', t => {
  const db = database(t)
  const repo = db.store.bilibiliSubtitles
  assert.deepEqual(repo.view(), [])
  const input = attachment()
  input.excerpt.unexpectedRawContent = 'FULL-FILE-MUST-NOT-PERSIST'
  input.excerpt.cues[0].unexpectedRawContent = 'FULL-CUE-MUST-NOT-PERSIST'
  const saved = repo.save(input)
  assert.equal(saved.excerptCueCount, 1)
  assert.deepEqual(repo.view(), [saved])
  assert.doesNotMatch(JSON.stringify(repo.view()), /主人提供的片段|excerpt_json/u)
  assert.equal(repo.get(bvid, 2), undefined)
  db.restart()
  const loaded = db.store.bilibiliSubtitles.get(bvid, 1)
  assert.deepEqual(loaded, { ...saved, excerpt: attachment().excerpt })
  assert.doesNotMatch(JSON.stringify(loaded), /MUST-NOT-PERSIST/u)
  assert.equal(db.store.bilibiliSubtitles.remove(bvid, 2), false)
  assert.equal(db.store.bilibiliSubtitles.remove(bvid, 1), true)
  assert.equal(db.store.bilibiliSubtitles.get(bvid, 1), undefined)
})

test('attachment storage rejects mismatched provenance, malformed identity and invalid excerpt bounds', t => {
  const repo = database(t).store.bilibiliSubtitles
  for (const fields of [
    { bvid: `https://www.bilibili.com/video/${bvid}` }, { part: 0 }, { cid: 0 }, { format: 'ass' },
    { sha256: 'invalid' }, { cueCount: 0 }, { cueCount: 6001 },
  ]) assert.equal(repo.save(attachment(fields)), undefined)
  for (const fields of [
    { provenance: undefined }, { provenance: { ...provenance, sha256: 'b'.repeat(64) } }, { language: undefined }, { cues: [] },
    { cues: [{ from: 1, to: 1, text: 'time' }] },
    { cues: [{ from: 0, to: 1, text: '中'.repeat(401) }] },
    { cues: [{ from: 2, to: 3, text: 'later' }, { from: 1, to: 2, text: 'earlier' }] },
    { cues: [null] },
  ]) assert.equal(repo.save(attachment({ excerpt: { ...attachment().excerpt, ...fields } })), undefined)
  const tooMany = Array.from({ length: 13 }, (_, i) => ({ from: i, to: i + 1, text: 'line' }))
  assert.equal(repo.save(attachment({ cueCount: 13, excerpt: { ...attachment().excerpt, cues: tooMany } })), undefined)
  assert.deepEqual(repo.view(), [])
})

test('the attachment cap is 32 exact targets while replacement and removal remain available', t => {
  const repo = database(t).store.bilibiliSubtitles
  for (let part = 1; part <= 32; part++) assert.ok(repo.save(attachment({ part })))
  assert.equal(repo.save(attachment({ part: 33 })), undefined)
  const sha256 = 'b'.repeat(64)
  const changed = repo.save(attachment({ sha256, cid: 98, format: 'vtt', excerpt: { ...attachment().excerpt, provenance: { ...provenance, sha256 } } }))
  assert.equal(changed.cid, 98)
  assert.equal(repo.get(bvid, 1).excerpt.provenance.sha256, sha256)
  assert.equal(repo.view().length, 32)
  assert.equal(repo.remove(bvid, 2), true)
  assert.ok(repo.save(attachment({ part: 33 })))
})

test('durable queue proof requires the connector digest and retains it after attachment removal', t => {
  const db = database(t)
  const queue = db.store.bilibili
  const item = queue.add({ bvid, part: 1 })
  assert.ok(db.store.bilibiliSubtitles.save(attachment()))
  assert.equal(queue.begin(item.id), true)
  const receipt = recordRead(db.store, item, { subtitleOrigin: provenance.kind, subtitleSha256: digest })
  assert.equal(queue.finish(item.id, { status: 'read', receipt }), false)
  assert.equal(queue.finish(item.id, { status: 'read', receipt: { ...receipt, provenance: { ...provenance, sha256: 'b'.repeat(64) } } }), false)
  assert.equal(queue.finish(item.id, { status: 'read', receipt: { ...receipt, provenance } }), true)
  db.store.bilibiliSubtitles.remove(bvid, 1)
  db.restart()
  assert.deepEqual(db.store.bilibili.get(item.id).receipt, { ...receipt, provenance })
})

test('recovery accepts exact owner proof and rejects incomplete or metadata provenance', t => {
  const cases = [
    { data: { subtitleOrigin: provenance.kind, subtitleSha256: digest }, kind: 'video.subtitle-read', read: true },
    { data: { subtitleOrigin: provenance.kind }, kind: 'video.subtitle-read', read: false },
    { data: { subtitleSha256: digest }, kind: 'video.subtitle-read', read: false },
    { data: { subtitleOrigin: provenance.kind, subtitleSha256: digest }, kind: 'video.inspected', read: false },
  ]
  for (const itemCase of cases) {
    const db = database(t)
    const item = db.store.bilibili.add({ bvid, part: 1 })
    assert.equal(db.store.bilibili.begin(item.id), true)
    const receipt = recordRead(db.store, item, itemCase.data, itemCase.kind)
    db.restart()
    db.store.bilibili.recover()
    assert.equal(db.store.bilibili.get(item.id).status, itemCase.read ? 'read' : 'failed')
    assert.deepEqual(db.store.bilibili.get(item.id).receipt, itemCase.read ? { ...receipt, provenance } : undefined)
  }
})
