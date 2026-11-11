import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { BILIBILI_AUTONOMY_CONTEXT } from '../src/core/model.ts'
import { BilibiliService } from '../src/host/bilibili.ts'
import { projectHome } from '../src/core/home.ts'

const target = { bvid: 'BV1dLx46TEhw', part: 1 }
const context = { contextId: BILIBILI_AUTONOMY_CONTEXT, sessionId: 'isolated-bili-decision' }
const START = Date.parse('2026-11-09T08:00:00.000Z')
const HOUR = 60 * 60_000
const collection = { mid: '7380321', seasonId: '678635' }

function discovered(index, title = `候选 ${index}`) {
  return { bvid: `BV${String(index).padStart(10, '0')}`, title }
}

function database(t) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync(join('.work', 'bili-queue-test-'))
  const path = join(dir, 'store.sqlite')
  let store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get store() { return store }, restart() { store.close(); store = new CompanionStore(path) } }
}

function evidence(store, id, data = {}, binding = context) {
  const at = new Date().toISOString()
  const kind = 'video.subtitle-read'
  const activityId = store.recordActivity({ ...binding, source: 'media.bilibili', kind, summary: 'isolated evidence', status: 'success', occurredAt: at, data: { ...target, candidateId: id, ...data } })
  return { activityId, at, kind }
}

test('the owner queue deduplicates active videos by canonical part, bounds slots and preserves withdrawal', t => {
  const { store } = database(t)
  const queue = store.bilibili
  const first = queue.add(target, 'first label')
  assert.equal(queue.add(target, 'duplicate label').id, first.id)
  assert.equal(queue.view().items[0].label, 'first label')
  for (let part = 2; part <= 20; part++) assert.ok(queue.add({ ...target, part }))
  assert.equal(queue.add({ ...target, part: 21 }), undefined)
  assert.equal(queue.cancel(first.id), true)
  assert.equal(queue.cancel(first.id), true)
  assert.equal(queue.view().items.find(item => item.id === first.id).status, 'cancelled')
  const addedAgain = queue.add(target)
  assert.ok(addedAgain && addedAgain.id !== first.id)
  assert.equal(queue.view().items.filter(item => item.status === 'queued').length, 20)
})

test('a read requires exact durable evidence and reserves the next decision before remote work', t => {
  const { store } = database(t)
  const queue = store.bilibili
  const first = queue.add(target)
  const second = queue.add({ ...target, part: 2 })
  const cooldown = Date.now() + 60_000
  assert.equal(queue.begin(first.id, cooldown), true)
  assert.equal(queue.begin(second.id), false)
  assert.equal(queue.view().nextDecisionAt, new Date(cooldown).toISOString())
  assert.equal(queue.finish(first.id, { status: 'read', receipt: evidence(store, first.id, { part: 2 }) }), false)
  assert.equal(queue.finish(first.id, { status: 'read', receipt: evidence(store, first.id, {}, { contextId: 'world.bilibili', sessionId: 'manual' }) }), false)
  const receipt = evidence(store, first.id)
  assert.equal(queue.finish(first.id, { status: 'read', receipt }), true)
  assert.deepEqual(queue.view().items.find(item => item.id === first.id).receipt, receipt)
  assert.equal(queue.begin(second.id), false)
  assert.equal(queue.cancel(first.id), false)
  queue.defer(cooldown - 1000)
  assert.equal(queue.view().nextDecisionAt, new Date(cooldown).toISOString())
})

test('restart uses actual stored receipts or records interruption without sending anything', t => {
  for (const recorded of [false, true]) {
    const db = database(t)
    const item = db.store.bilibili.add(target)
    const next = Date.now() + 60_000
    assert.equal(db.store.bilibili.begin(item.id, next), true)
    const receipt = recorded ? evidence(db.store, item.id) : undefined
    db.restart()
    db.store.bilibili.recover()
    const current = db.store.bilibili.view()
    assert.equal(current.nextDecisionAt, new Date(next).toISOString())
    assert.equal(current.items[0].status, recorded ? 'read' : 'failed')
    assert.deepEqual(current.items[0].receipt, receipt)
    assert.equal(current.items[0].error, recorded ? undefined : 'bili-interrupted')
  }
})

test('only a live role read moves home to phone and an owner lookup leaves it alone', async t => {
  const { store } = database(t)
  const project = service => projectHome({
    now: new Date(), presence: 'idle', minecraft: false, speaking: false, browsing: service.homeActive(),
    bindings: [], runningSessions: new Set(), quiet: false, activities: [],
  })
  const setup = () => {
    let respond
    const service = new BilibiliService(store, () => new Promise(resolve => { respond = resolve }))
    return { service, finish: () => respond(Response.json({ code: -404, data: null })) }
  }
  const owner = setup()
  const lookup = owner.service.read({ video: target.bvid })
  assert.equal(project(owner.service).anchor, 'window')
  owner.finish()
  await assert.rejects(lookup, /bili-video-unavailable/u)
  const role = setup()
  const reading = role.service.read({ video: target.bvid }, context)
  assert.equal(project(role.service).anchor, 'phone')
  role.finish()
  await assert.rejects(reading, /bili-video-unavailable/u)
  assert.equal(project(role.service).anchor, 'window')
})

test('collection permissions are finite, exact, canonical and empty by default', t => {
  const { store } = database(t)
  const queue = store.bilibili
  assert.deepEqual(queue.view().sources, [])
  assert.equal(queue.claimDiscovery(START), undefined)
  for (const mid of ['0', '00', '0001', '-1', '1e5', '1.0', '9007199254740992']) {
    assert.equal(queue.addSource({ ...collection, mid }), undefined)
  }
  const first = queue.addSource({ ...collection, label: '朋友的合集' })
  assert.equal(queue.addSource({ ...collection, label: '不要覆盖旧备注' }).label, '朋友的合集')
  for (let offset = 1; offset <= 7; offset++) {
    assert.ok(queue.addSource({ ...collection, seasonId: String(Number(collection.seasonId) + offset) }))
  }
  assert.equal(queue.addSource({ ...collection, seasonId: '12' }), undefined)
  assert.equal(queue.view().sources.length, 8)
  assert.deepEqual(queue.revokeSource(first.id), { candidateIds: [] })
  assert.equal(queue.revokeSource(first.id), undefined)
  const next = queue.addSource(collection)
  assert.ok(next.id !== first.id)
  assert.equal(queue.view().sources.length, 8)
})

test('discovery consumes a restart-safe global slot and rotates sources with per-source failure backoff', t => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const db = database(t)
  const first = db.store.bilibili.addSource(collection)
  const second = db.store.bilibili.addSource({ ...collection, seasonId: '23' })
  assert.equal(db.store.bilibili.claimDiscovery(START).id, first.id)
  assert.equal(db.store.bilibili.finishDiscovery(first.id, START - 1, { items: [] }), undefined)
  assert.equal(db.store.bilibili.finishDiscovery(first.id, START, { error: 'fetch leaked auth header' }), 0)
  assert.equal(db.store.bilibili.finishDiscovery(first.id, START, { items: [discovered(1)] }), undefined)
  db.restart()
  assert.equal(db.store.bilibili.view().sources[0].error, 'bili-discovery-failed')
  assert.equal(Date.parse(db.store.bilibili.view().nextDiscoveryAt), START + 6 * HOUR)
  assert.equal(db.store.bilibili.claimDiscovery(START + 6 * HOUR - 1), undefined)
  t.mock.timers.setTime(START + 6 * HOUR)
  const secondClaim = db.store.bilibili.claimDiscovery(Date.now())
  assert.equal(secondClaim.id, second.id)
  assert.equal(db.store.bilibili.finishDiscovery(second.id, Date.now(), { items: [] }), 0)
  assert.equal(Date.parse(db.store.bilibili.view().nextDiscoveryAt), START + 30 * HOUR)
  assert.equal(db.store.bilibili.claimDiscovery(START + 30 * HOUR - 1), undefined)
  t.mock.timers.setTime(START + 30 * HOUR)
  assert.equal(db.store.bilibili.claimDiscovery(Date.now()).id, second.id)
  t.mock.timers.setTime(START + 30 * HOUR + 120_000)
  assert.equal(db.store.bilibili.finishDiscovery(second.id, START + 30 * HOUR, { items: [discovered(1)] }), undefined)
  assert.equal(db.store.bilibili.view().sources[1].status, 'waiting')
  assert.equal(db.store.bilibili.claimDiscovery(START + 48 * HOUR).id, first.id)
  assert.equal(db.store.bilibili.view().items.length, 0)
})

test('discovery keeps manual priority, history deduplication, and finite batch and active capacity', t => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { store } = database(t)
  const queue = store.bilibili
  const first = queue.addSource(collection)
  const second = queue.addSource({ ...collection, seasonId: '23' })
  queue.addSource({ ...collection, seasonId: '25' })
  const old = queue.add({ bvid: discovered(1).bvid, part: 1 })
  assert.ok(queue.cancel(old.id))
  assert.equal(queue.claimDiscovery(START).id, first.id)
  assert.equal(queue.finishDiscovery(first.id, START, { items: [
    discovered(1), discovered(2, '清理\n\u0000标题'), discovered(2), discovered(3), discovered(4), discovered(5),
  ] }), 3)
  const entries = queue.view().items.filter(item => item.status === 'queued')
  assert.deepEqual(entries.map(item => item.bvid), [2, 3, 4].map(index => discovered(index).bvid))
  assert.equal(entries[0].sourceTitle, '清理 标题')
  assert.equal(entries[0].label, undefined)
  assert.ok(entries.every(item => item.sourceId === first.id && item.part === 1))
  const manual = queue.add({ bvid: target.bvid, part: 1 }, '手动优先')
  assert.equal(queue.view().items[0].id, manual.id)
  t.mock.timers.setTime(START + 6 * HOUR)
  assert.equal(queue.claimDiscovery(Date.now()).id, second.id)
  assert.equal(queue.finishDiscovery(second.id, Date.now(), { items: [5, 6, 7, 8].map(index => discovered(index)) }), 3)
  assert.equal(queue.claimDiscovery(START + 24 * HOUR), undefined)
  assert.equal(queue.view().items.filter(item => item.sourceId && item.status === 'queued').length, 6)
  for (let part = 2; part <= 14; part++) assert.ok(queue.add({ ...target, part }))
  assert.equal(queue.add({ ...target, part: 15 }), undefined)
})

test('a commit after queue saturation inserts nothing even when a slot existed at claim', t => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { store } = database(t)
  const queue = store.bilibili
  const source = queue.addSource(collection)
  for (let part = 1; part <= 19; part++) assert.ok(queue.add({ ...target, part }))
  assert.ok(queue.claimDiscovery(START))
  assert.ok(queue.add({ ...target, part: 20 }))
  assert.equal(queue.finishDiscovery(source.id, START, { items: [discovered(1)] }), 0)
  assert.equal(queue.view().sources[0].status, 'unchanged')
  assert.equal(queue.view().sources[0].lastAdded, 0)
  assert.equal(queue.claimDiscovery(START + 24 * HOUR), undefined)
  assert.equal(Date.parse(queue.view().sources[0].lastCheckedAt), START)
})

test('revoke cancels only sourced pending reads and rejects their late receipts or late discoveries', t => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { store } = database(t)
  const queue = store.bilibili
  const source = queue.addSource(collection)
  assert.ok(queue.claimDiscovery(START))
  assert.equal(queue.finishDiscovery(source.id, START, { items: [1, 2, 3].map(index => discovered(index)) }), 3)
  const [finished, promoted, inFlight] = queue.view().items
  assert.equal(queue.finish(finished.id, { status: 'skipped' }), true)
  assert.equal(queue.add({ bvid: promoted.bvid, part: 1 }, '主人独立授权').sourceId, undefined)
  assert.equal(queue.begin(inFlight.id), true)
  assert.equal(queue.add({ bvid: inFlight.bvid, part: 1 }, '不要切换正在读取的授权').sourceId, source.id)
  assert.equal(queue.view().items[0].status, 'reading')
  const receipt = evidence(store, inFlight.id, { bvid: inFlight.bvid })
  t.mock.timers.setTime(START + 24 * HOUR)
  assert.ok(queue.claimDiscovery(Date.now()))
  assert.deepEqual(queue.revokeSource(source.id), { candidateIds: [inFlight.id] })
  assert.equal(queue.finish(inFlight.id, { status: 'read', receipt }), false)
  assert.equal(queue.finishDiscovery(source.id, Date.now(), { items: [discovered(4)] }), undefined)
  assert.equal(queue.get(finished.id).status, 'skipped')
  assert.equal(queue.get(finished.id).sourceId, source.id)
  assert.equal(queue.get(inFlight.id).status, 'cancelled')
  assert.equal(queue.get(promoted.id).status, 'queued')
  assert.equal(queue.get(promoted.id).label, '主人独立授权')
  assert.deepEqual(queue.view().sources, [])
  const restored = queue.addSource(collection)
  assert.ok(restored.id !== source.id)
  assert.equal(queue.claimDiscovery(Date.now()), undefined)
})
