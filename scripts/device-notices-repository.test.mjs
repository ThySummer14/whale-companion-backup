import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { surveyWindowKey } from '../src/core/minecraft-survey-window.ts'
import { MINECRAFT_SUPPLY_CONTEXT, SINGING_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

const NOW = '2026-11-09T04:00:00.000Z'
const CHAT = { kind: 'chat-reply' }

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'device-notices-repository-'))
  const path = join(directory, 'companion.db')
  let store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    get store() { return store },
    pair(name) {
      const id = randomUUID()
      store.createDevice({ id, name, secretHash: 'test-fixture', createdAt: NOW })
      return id
    },
    reopen() { store.close(); store = new CompanionStore(path) },
    inspect(run) {
      const db = new DatabaseSync(path, { readOnly: true })
      try { return run(db) } finally { db.close() }
    },
  }
}

test('notice baselines and read state belong to each device and survive restart', t => {
  const h = fixture(t)
  const first = h.pair('first')
  const notices = h.store.notices
  assert.deepEqual(notices.summary(first), { version: 1, unread: 0 })
  assert.equal(notices.add(CHAT, 'first'), true)
  const oldest = notices.list(first).items[0]
  const second = h.pair('second')
  assert.deepEqual(notices.list(second), { version: 1, unread: 0, items: [] })
  assert.equal(notices.add(CHAT, 'second'), true)
  assert.equal(notices.add(CHAT, 'second'), false)
  assert.equal(notices.add(CHAT, 'third'), true)
  const [latest, middle] = notices.list(first).items
  assert.deepEqual(oldest, { id: oldest.id, kind: 'chat-reply', occurredAt: NOW, read: false })
  assert.ok(latest.id > middle.id && middle.id > oldest.id)
  assert.equal(notices.markRead(second, { id: oldest.id }), undefined)
  assert.equal(notices.markRead(second, { through: oldest.id }), undefined)
  assert.deepEqual(notices.markRead(first, { id: middle.id }), { version: 1, unread: 2 })
  assert.equal(notices.markRead(first, { id: middle.id }).unread, 2)
  assert.deepEqual(notices.list(second).items.map(item => [item.id, item.read]), [[latest.id, false], [middle.id, false]])
  assert.equal(notices.markRead(first, { through: middle.id }).unread, 1)
  assert.equal(notices.markRead(first, { through: oldest.id }).unread, 1)
  assert.equal(notices.add(CHAT, 'fourth'), true)
  h.reopen()
  assert.deepEqual(h.store.notices.list(first).items.map(item => item.read), [false, false, true, true])
  assert.equal(h.store.notices.summary(second).unread, 3)
  assert.equal(h.store.revokeDevice(first, NOW), true)
  assert.equal(h.store.notices.summary(first), undefined)
  assert.equal(h.store.notices.list(first), undefined)
  assert.equal(h.store.notices.markRead(first, { id: latest.id }), undefined)
  assert.equal(h.store.notices.summary(randomUUID()), undefined)
})

test('feed receipts expose only references and disappear when a post or its parent is deleted', t => {
  const h = fixture(t)
  const device = h.pair('reader')
  const { feed, notices } = h.store
  const post = feed.create({ author: 'companion', body: 'private post text' })
  const user = feed.create({ author: 'user', body: 'private user post' })
  const reply = feed.create({ author: 'companion', parentId: user.id, body: 'private reply text' })
  const other = feed.create({ author: 'user', parentId: post.id, body: 'private user reply' })
  assert.equal(notices.add({ kind: 'feed-post', postId: user.id }, 'invalid-user-post'), false)
  assert.equal(notices.add({ kind: 'feed-post', postId: reply.id }, 'invalid-reply-as-post'), false)
  assert.equal(notices.add({ kind: 'feed-reply', postId: post.id, replyId: other.id }, 'invalid-user-reply'), false)
  assert.equal(notices.add({ kind: 'feed-reply', postId: post.id, replyId: reply.id }, 'invalid-parent'), false)
  assert.equal(notices.add({ kind: 'feed-post', postId: randomUUID() }, 'missing-post'), false)
  assert.equal(notices.add({ kind: 'feed-post', postId: post.id }, 'private dedupe key'), true)
  assert.equal(notices.add({ kind: 'feed-reply', postId: user.id, replyId: reply.id }, 'valid-reply'), true)
  const [replyNotice, postNotice] = notices.list(device).items
  assert.deepEqual(replyNotice, { id: replyNotice.id, kind: 'feed-reply', postId: user.id, replyId: reply.id, occurredAt: NOW, read: false })
  assert.deepEqual(postNotice, { id: postNotice.id, kind: 'feed-post', postId: post.id, occurredAt: NOW, read: false })
  feed.delete(user.id, 'user')
  assert.equal(notices.add({ kind: 'feed-reply', postId: user.id, replyId: reply.id }, 'deleted-parent'), false)
  assert.equal(notices.markRead(device, { id: replyNotice.id }), undefined)
  assert.deepEqual(notices.list(device), { version: 1, unread: 1, items: [postNotice] })
  feed.delete(post.id, 'companion')
  assert.equal(notices.markRead(device, { through: postNotice.id }), undefined)
  assert.deepEqual(notices.list(device), { version: 1, unread: 0, items: [] })
})

test('notice pagination remains ordered and bounded when the oldest notices and reads are pruned', t => {
  const h = fixture(t)
  const device = h.pair('reader')
  const notices = h.store.notices
  notices.add(CHAT, 'retention:0')
  const oldest = notices.list(device).items[0].id
  notices.markRead(device, { id: oldest })
  for (let i = 1; i <= 205; i++) assert.equal(notices.add(CHAT, `retention:${i}`), true)
  assert.equal(notices.summary(device).unread, 200)
  assert.equal(notices.list(device).items.length, 30)
  assert.equal(notices.list(device, { before: Number.MAX_SAFE_INTEGER }).items[0].id, notices.list(device).items[0].id)
  assert.deepEqual(notices.list(device, { before: oldest }).items, [])
  for (const before of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(notices.list(device, { before }), undefined)
    assert.equal(notices.markRead(device, { id: before }), undefined)
  }
  for (const limit of [-1, 0, 1.5, 51]) assert.equal(notices.list(device, { limit }), undefined)
  assert.equal(notices.markRead(device, { through: oldest }), undefined)
  assert.equal(notices.markRead(device, { through: Number.MAX_SAFE_INTEGER }), undefined)
  const pages = []
  let before
  do {
    const page = notices.list(device, { before, limit: 50 })
    pages.push(...page.items.map(item => item.id))
    before = page.nextBefore
  } while (before !== undefined)
  assert.deepEqual(pages, Array.from({ length: 200 }, (_, index) => oldest + 205 - index))
  assert.equal(h.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM device_notice_read').get().count), 0)
  assert.deepEqual(h.inspect(db => db.prepare('PRAGMA foreign_key_check').all()), [])
  h.reopen()
  assert.equal(h.store.notices.add(CHAT, 'retention:next'), true)
  assert.ok(h.store.notices.list(device).items[0].id > pages[0])
})

test('task notices require matching terminal song status and verified Minecraft permit receipts', t => {
  const h = fixture(t)
  const device = h.pair('reader')
  const { store } = h
  const notices = store.notices
  const song = store.createTask({ capabilityId: 'media.singing', contextId: SINGING_CONTEXT, title: 'private title' })
  const ready = { kind: 'song-ready', taskId: song.id }
  assert.equal(notices.add(ready, 'song:ready'), false)
  store.transitionTask(song.id, 'running')
  store.transitionTask(song.id, 'succeeded', undefined, () => {
    assert.equal(notices.add({ kind: 'song-failed', taskId: song.id }, 'song:wrong-status'), false)
    assert.equal(notices.add(ready, 'song:ready'), true)
  })
  const failed = store.createTask({ capabilityId: 'media.singing', contextId: SINGING_CONTEXT, title: 'private title' })
  store.transitionTask(failed.id, 'failed', 'private failure', () => {
    assert.equal(notices.add({ kind: 'song-failed', taskId: failed.id }, 'song:failed'), true)
  })
  const unrelated = store.createTask({ capabilityId: 'core.autonomy', contextId: SINGING_CONTEXT, title: 'other task' })
  store.transitionTask(unrelated.id, 'failed')
  assert.equal(notices.add({ kind: 'song-failed', taskId: unrelated.id }, 'song:unrelated'), false)

  const createReceipt = (goal, surveyOutcome, window = false) => {
    const zoneId = randomUUID()
    const job = store.autonomy.create({
      kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
      dedupeKey: window ? surveyWindowKey('2026-11-09') : `permit:${zoneId}`, runAfter: Date.now(),
    })
    const task = store.createTask({ capabilityId: goal === 'survey' ? 'minecraft.survey' : 'minecraft.craft',
      contextId: 'game.minecraft', title: 'private location' })
    store.transitionTask(job.id, 'running')
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
    assert.equal(notices.add({ kind: 'camp-completed', taskId: job.id }, `camp:${job.id}`), false)
    store.transitionTask(job.id, 'succeeded', undefined, () => {
      const kind = surveyOutcome === 'recovered' ? 'camp-returned' : 'camp-completed'
      const wrongKind = kind === 'camp-completed' ? 'camp-returned' : 'camp-completed'
      assert.equal(notices.add({ kind, taskId: job.id }, `camp:${job.id}`), false)
      const payload = { goal, expiresAt: Date.now() + 60_000, receiptTaskId: task.id }
      store.autonomy.update(job.id, { payload: goal === 'survey'
        ? { ...payload, surveyOutcome, direction: 'north', surveySteps: 4,
          ...(window ? { windowSurveyZoneId: zoneId, windowRuleId: randomUUID() } : { surveyZoneId: zoneId }) }
        : { ...payload, zoneId } })
      assert.equal(notices.add({ kind: wrongKind, taskId: job.id }, `camp:wrong:${job.id}`), false)
      assert.equal(notices.add({ kind, taskId: job.id }, `camp:${job.id}`), true)
    })
    return job.id
  }
  const supply = createReceipt('planks')
  const survey = createReceipt('survey', 'completed')
  const returned = createReceipt('survey', 'recovered')
  const scheduled = createReceipt('survey', 'completed', true)
  assert.throws(() => store.transaction(() => {
    assert.equal(notices.add(CHAT, 'rollback'), true)
    throw new Error('rollback producer')
  }), /rollback producer/u)
  h.reopen()
  const actual = h.store.notices.list(device)
  assert.equal(actual.unread, 6)
  assert.deepEqual(actual.items.map(item => [item.kind, item.taskId]), [
    ['camp-completed', scheduled], ['camp-returned', returned], ['camp-completed', survey], ['camp-completed', supply],
    ['song-failed', failed.id], ['song-ready', song.id],
  ])
})
