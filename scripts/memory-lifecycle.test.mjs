import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'

const DAY_MS = 86_400_000
const now = new Date('2026-11-09T10:00:00Z')
const before = days => new Date(now.getTime() - days * DAY_MS).toISOString()

function fixture(t) {
  mkdirSync(resolve('.work'), { recursive: true })
  const directory = mkdtempSync(resolve('.work/memory-lifecycle-'))
  const path = join(directory, 'companion.sqlite')
  const store = new CompanionStore(path)
  const db = new DatabaseSync(path)
  t.after(() => {
    db.close()
    store.close()
    rmSync(directory, { recursive: true })
  })
  const add = (content, patch = {}) => store.memory.create({
    content, kind: 'experience', status: 'active', scope: 'shared', contextId: 'chat.mobile', importance: 0.2, ...patch,
  })
  const age = (memory, days) => {
    const old = before(days)
    db.prepare('UPDATE memory SET created_at=?,updated_at=?,last_used_at=? WHERE id=?').run(old, old, old, memory.id)
    return store.memory.get(memory.id)
  }
  return { memory: store.memory, store, db, add, age }
}

test('only strong active hits reinforce once per UTC day without changing confidence, importance, revisions or recall count', t => {
  const { memory, add, age } = fixture(t)
  const active = age(add('蓝宝石收藏在营地'), 100)
  const candidate = add('蓝宝石尚未核对', { status: 'candidate' })
  const forgotten = add('蓝宝石旧记录', { status: 'forgotten' })
  const archived = memory.archive(add('蓝宝石旧矿脉').id)
  const wrongScope = { ...active, scope: 'context', contextId: 'game.minecraft' }
  memory.reinforce([wrongScope, active, candidate, forgotten, archived], '问蓝宝石还有哪些山川和星星以及传送门在哪里', now)
  assert.equal(memory.get(active.id).reinforcementCount, 0)
  memory.reinforce([wrongScope], '蓝宝石', now)
  assert.equal(memory.get(active.id).reinforcementCount, 0)
  memory.reinforce([active, active, candidate, forgotten, archived], '蓝宝石', now)
  memory.reinforce([active], '蓝宝石', new Date('2026-11-09T23:59:00Z'))
  const first = memory.get(active.id)
  assert.equal(first.reinforcementCount, 1)
  assert.equal(first.lastReinforcedAt, now.toISOString())
  memory.reinforce([active], '蓝宝石', new Date('2026-11-10T00:00:00Z'))
  memory.reinforce([active], '蓝宝石', now)
  const second = memory.get(active.id)
  assert.equal(second.reinforcementCount, 2)
  assert.equal(second.lastReinforcedAt, '2026-11-10T00:00:00.000Z')
  assert.equal(second.importance, active.importance)
  assert.equal(second.confidence, active.confidence)
  assert.equal(second.recallCount, 0)
  assert.equal(memory.revisions(active.id).length, 1)
  for (const other of [candidate, forgotten, archived]) assert.equal(memory.get(other.id).reinforcementCount, 0)
})

test('cross-day reinforcement affects relevant ranking, saturates, and decays while literal matches keep priority', t => {
  const { memory, add, age } = fixture(t)
  let readTime = now.getTime()
  t.mock.method(Date, 'now', () => readTime)
  const reinforced = age(add('营地东边有一口水井'), 100)
  const unused = age(add('营地西边有一棵樱花树'), 61)
  memory.reinforce([reinforced], '营地', now)
  assert.equal(memory.find('营地', { limit: 1 })[0].id, reinforced.id)
  assert.equal(memory.find('樱花树', { limit: 1 })[0].id, unused.id)
  for (let days = 1; days <= 25; days++) {
    readTime += DAY_MS
    memory.reinforce([reinforced], '营地', new Date(readTime))
  }
  const strength = memory.get(reinforced.id).retention
  assert.ok(strength > 0.98 && strength <= 1)
  readTime += 100 * DAY_MS
  assert.ok(memory.get(reinforced.id).retention < strength / 2)
  assert.equal(memory.get(reinforced.id).reinforcementCount, 26)
})

test('archive is separate from forget, preserves original state and scope, and never enters standard recall', t => {
  const { memory, add, store } = fixture(t)
  const refs = [{ contextId: 'chat.mobile', eventSeq: 17 }, { taskId: 'demo-receipt' }]
  const active = add('井边树荫是私有经验', { scope: 'context', sourceRefs: refs })
  const candidate = add('井边树荫仍待确认', { status: 'candidate', confidence: 0.9 })
  const pinned = add('井边树荫锚点', { pinned: true })
  assert.throws(() => memory.archive(pinned.id), /memory-archive-protected/)
  assert.throws(() => memory.update(active.id, { status: 'archived' }), /memory-archive-state/)
  assert.throws(() => add('伪造归档', { status: 'archived' }), /memory-archive-state/)
  const archived = memory.archive(active.id, '暂时收起')
  memory.archive(candidate.id)
  assert.equal(archived.archivedFrom, 'active')
  assert.equal(archived.archiveReason, '暂时收起')
  assert.deepEqual(archived.sourceRefs, refs)
  assert.deepEqual(memory.recordRecall([active]), [])
  assert.deepEqual(memory.find('井边树荫', { status: 'active+candidate' }).map(item => item.id), [pinned.id])
  assert.deepEqual(memory.find('井边树荫', { status: 'archived', contextId: 'game.minecraft' }).map(item => item.id), [candidate.id])
  assert.equal(memory.counts().archived, 2)
  assert.throws(() => memory.update(archived.id, { pinned: true }), /memory-archive-state/)
  assert.throws(() => memory.update(archived.id, { status: 'active' }), /memory-archive-state/)
  assert.throws(() => memory.archive(archived.id), /memory-archive-state/)
  const restored = memory.restore(archived.id)
  assert.equal(restored.status, 'active')
  assert.equal(restored.archivedFrom, undefined)
  assert.deepEqual(restored.sourceRefs, refs)
  assert.equal(memory.restore(candidate.id).status, 'candidate')
  assert.deepEqual(memory.revisions(archived.id).map(item => item.snapshot.status), ['active', 'archived', 'active'])
  assert.ok(store.activities().some(item => item.kind === 'memory.restored' && item.data.memoryId === archived.id))
  const forgotten = add('旧营地', { status: 'forgotten' })
  assert.equal(memory.restore(forgotten.id).status, 'candidate')
})

test('preview bounds metadata and applies only still-eligible rows, respecting fresh use, evidence and owner changes', t => {
  const { memory, add, age, db } = fixture(t)
  const untouched = age(add('🍂'.repeat(130), { scope: 'context' }), 60)
  const edited = age(add('后来修订', { confidence: 0.8 }), 60)
  const used = age(add('预览之后刚被召回'), 60)
  const fresh = age(add('59 天前的记忆'), 59)
  const reinforced = age(add('低重要度但曾多次被问到'), 80)
  db.prepare('UPDATE memory SET last_reinforced_at=?,reinforcement_count=? WHERE id=?').run(before(61), 15, reinforced.id)
  const protectedRows = [
    age(add('保留锚点', { pinned: true }), 80), age(add('高重要度', { importance: 0.4 }), 80),
    age(add('已核验经验', { confidence: 0.8, sourceRefs: [{ activityId: 1 }] }), 80), fresh, reinforced,
  ]
  const preview = memory.previewArchive(now)
  assert.deepEqual(new Set(preview.map(item => item.id)), new Set([untouched.id, edited.id, used.id]))
  const sample = preview.find(item => item.id === untouched.id)
  assert.equal(Array.from(sample.excerpt).length, 120)
  assert.equal(sample.scope, 'context')
  assert.equal(sample.contextId, untouched.contextId)
  assert.ok(sample.retention > 0 && sample.retention < 0.35)
  memory.update(edited.id, { content: '已修订内容' })
  db.prepare('UPDATE memory SET last_used_at=? WHERE id=?').run(now.toISOString(), used.id)
  assert.deepEqual(memory.archiveStale(preview, now), { archived: 1, skipped: 2 })
  for (const item of [edited, used, ...protectedRows]) assert.equal(memory.get(item.id).status, 'active')
  assert.equal(memory.get(untouched.id).status, 'archived')
  assert.deepEqual(memory.archiveStale(preview, now), { archived: 0, skipped: 3 })
})

test('archive batches are bounded and rollback all mutations when a later write fails', t => {
  const { memory, add, age, db } = fixture(t)
  for (let i = 0; i < 52; i++) age(add(`旧线索 ${i}`), 80)
  const preview = memory.previewArchive(now)
  assert.equal(preview.length, 50)
  db.prepare(`CREATE TRIGGER fixture_archive_failure BEFORE UPDATE OF status ON memory WHEN NEW.id='${preview[1].id}'
    BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END`).run()
  assert.throws(() => memory.archiveStale(preview, now), /fixture archive failure/)
  assert.equal(memory.get(preview[0].id).status, 'active')
  assert.equal(memory.revisions(preview[0].id).length, 1)
  assert.equal(memory.counts().archived, 0)
})
