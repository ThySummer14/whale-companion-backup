import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MINECRAFT_SHARE_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

function openStore(t) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync(join('.work', 'minecraft-feed-repository-test-'))
  const path = join(dir, 'companion.db')
  const store = new CompanionStore(path)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { path, store }
}

function succeedTask(store, action, contextId = 'game.minecraft') {
  const task = store.createTask({ contextId, capabilityId: `minecraft.${action}`, title: 'Minecraft test' })
  store.transitionTask(task.id, 'running')
  return store.transitionTask(task.id, 'succeeded')
}

test('Minecraft feed requires a verified action and keeps one durable source across deletion', t => {
  const { path, store } = openStore(t)
  const task = succeedTask(store, 'dig')
  const pending = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.dig', title: 'pending' })
  const chat = succeedTask(store, 'chat')
  const unrelated = succeedTask(store, 'dig', 'chat.mobile')
  const share = { author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, body: '今天采到一根原木。' }
  const regular = store.feed.create({ author: 'user', body: '普通动态' })
  assert.equal(regular.sourceTaskId, undefined)
  assert.throws(() => store.feed.create(share), /requires a source task/u)
  for (const id of [pending.id, chat.id, unrelated.id, 'unknown']) {
    assert.throws(() => store.feed.create({ ...share, sourceTaskId: id }), /not an eligible completed action/u)
  }
  for (const patch of [{ author: 'user' }, { contextId: 'autonomy.feed' }, { parentId: regular.id }]) {
    assert.throws(() => store.feed.create({ ...share, sourceTaskId: task.id, ...patch }), /Only an autonomous Minecraft post/u)
  }

  const post = store.feed.create({ ...share, sourceTaskId: task.id })
  assert.equal(store.feed.get(post.id).sourceTaskId, task.id)
  assert.equal(store.feed.bySourceTask(task.id).id, post.id)
  const deleted = store.feed.delete(post.id, 'companion')
  assert.deepEqual(store.feed.list().items.map(item => item.id), [regular.id])
  assert.equal(store.feed.bySourceTask(task.id).deletedAt, deleted.deletedAt)
  assert.throws(() => store.feed.create({ ...share, sourceTaskId: task.id }), /already shared/u)

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 14)
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(post)').all()
    assert.ok(foreignKeys.some(key => key.from === 'source_task_id' && key.table === 'task' && key.to === 'id'))
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('shared cooldown uses latest top-level companion publication, including tombstones', t => {
  const { store } = openStore(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T04:00:00.000Z') })
  const contexts = ['autonomy.feed', MINECRAFT_SHARE_CONTEXT]
  assert.equal(store.feed.latestAutonomousPostAt([]), undefined)
  assert.equal(store.feed.latestAutonomousPostAt(contexts), undefined)
  const daily = store.feed.create({ author: 'companion', contextId: contexts[0], body: '日常动态' })
  t.mock.timers.tick(1000)
  const task = succeedTask(store, 'build')
  const game = store.feed.create({
    author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, body: '营地搭好了。', sourceTaskId: task.id,
  })
  t.mock.timers.tick(1000)
  store.feed.create({ author: 'companion', contextId: contexts[0], parentId: daily.id, body: '回复' })
  store.feed.create({ author: 'user', contextId: contexts[0], body: '用户动态' })
  store.feed.create({ author: 'companion', contextId: 'chat.mobile', body: '其他场景' })
  store.feed.delete(game.id, 'companion')
  assert.equal(store.feed.latestAutonomousPostAt(contexts), game.createdAt)
  assert.equal(store.feed.latestAutonomousPostAt([contexts[0]]), daily.createdAt)
})

test('a generated survey card can only be published with its own survey task', t => {
  const { store } = openStore(t)
  const survey = succeedTask(store, 'survey')
  const another = succeedTask(store, 'survey')
  const dig = succeedTask(store, 'dig')
  const at = new Date().toISOString()
  const image = { kind: 'image', mimeType: 'image/png', bytes: 120, createdAt: at, lastUsedAt: at, retention: 'keep' }
  const card = store.media.upsert({
    ...image, path: 'images/survey-fixture.png', hash: 'fixture', source: 'minecraft-survey-card', sourceRef: survey.id,
  })
  const photo = store.media.upsert({
    ...image, path: 'images/photo.png', hash: 'photo', source: 'companion-device',
  })
  const share = { author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, body: '从营地出发探了路。' }
  const withCard = { ...share, mediaId: card.id }
  assert.throws(() => store.feed.create({ ...withCard, sourceTaskId: another.id }), /matching Minecraft task/u)
  assert.throws(() => store.feed.create({ ...withCard, sourceTaskId: dig.id }), /matching Minecraft task/u)
  assert.throws(() => store.feed.create({ author: 'user', body: '照片', mediaId: card.id }), /matching Minecraft task/u)
  assert.throws(() => store.feed.create({ ...share, sourceTaskId: survey.id, mediaId: photo.id }), /matching Minecraft task/u)
  assert.equal(store.feed.create({ ...withCard, sourceTaskId: survey.id }).mediaId, card.id)
  assert.equal(store.feed.create({ ...share, sourceTaskId: another.id }).mediaId, undefined)
  assert.equal(store.feed.create({ author: 'user', body: '照片', mediaId: photo.id }).mediaId, photo.id)
})
