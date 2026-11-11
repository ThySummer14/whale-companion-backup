import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { SINGING_CONTEXT } from '../src/core/model.ts'
import { MAX_SINGING_WAV_BYTES } from '../src/protocol/singing.ts'

const sessionId = 'private-singing-session'
const otherSessionId = 'previous-singing-session'
const title = '夜风里的小船'
const now = '2026-11-09T10:00:00.000Z'
const hash = '6'.repeat(64)
const caption = '把刚唱完的小船送给夜风。'

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'song-feed-repository-'))
  const path = join(directory, 'companion.db')
  let store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.bindContext({ contextId: SINGING_CONTEXT, sessionId, kind: 'topic', label: '唱歌' })
  const createTask = (options = {}, status = 'succeeded') => {
    const task = store.createTask({ capabilityId: 'media.singing', contextId: SINGING_CONTEXT, sessionId, title, ...options })
    if (status === 'succeeded') store.transitionTask(task.id, 'running')
    return status === 'accepted' ? task : store.transitionTask(task.id, status)
  }
  const addAsset = (id, options = {}) => store.media.upsert({
    id, kind: 'song', path: `songs/${id}.wav`, hash, mimeType: 'audio/wav', bytes: 320_044,
    source: 'singing', sourceRef: id, retention: 'keep', createdAt: now, lastUsedAt: now, ...options,
  })
  const postInput = songTaskId => ({ songTaskId, sourceSessionId: sessionId, contextId: SINGING_CONTEXT, author: 'companion', body: ` ${caption} ` })
  return {
    get store() { return store }, createTask, addAsset, postInput,
    reopen() { store.close(); store = new CompanionStore(path) },
    inspect(callback) {
      const db = new DatabaseSync(path, { readOnly: true })
      try { return callback(db) } finally { db.close() }
    },
  }
}

test('a retained archive projects a bounded song card and survives a restart without copying its media', t => {
  const h = fixture(t)
  const task = h.createTask()
  h.addAsset(task.id)
  h.store.media.saveSongDuration(task.id, hash, 10.25)
  const post = h.store.feed.create(h.postInput(task.id))
  const song = { id: task.id, title, bytes: 320_044, durationSeconds: 10.25 }
  assert.deepEqual(post.song, song)
  assert.equal(post.body, caption)
  assert.equal(post.mediaId, undefined)
  assert.equal(post.sourceSessionId, undefined)
  assert.equal(post.sourceTaskId, undefined)
  assert.doesNotMatch(JSON.stringify(post), /private-singing-session|songs\/|666666/u)
  assert.deepEqual(h.store.feed.get(post.id).song, song)
  h.store.feed.create({ author: 'user', body: '听到了。', parentId: post.id })
  assert.equal(h.store.feed.get(post.id).replies.length, 1)
  assert.equal(h.store.media.all().length, 1)
  assert.equal(h.inspect(db => db.prepare('PRAGMA user_version').get().user_version), 43)
  assert.deepEqual(h.inspect(db => db.prepare('PRAGMA foreign_key_check').all()), [])
  h.reopen()
  assert.deepEqual(h.store.feed.list().items[0].song, song)
  assert.deepEqual(h.store.feed.bySongTask(task.id).song, song)
})

test('a withdrawn song stays unposted across retries and keeps its archived audio', t => {
  const h = fixture(t)
  const task = h.createTask()
  h.addAsset(task.id)
  const input = h.postInput(task.id)
  const post = h.store.feed.create(input)
  assert.deepEqual(post.song, { id: task.id, title, bytes: 320_044 })
  assert.throws(() => h.store.feed.create(input), /already shared/u)
  const removed = h.store.feed.delete(post.id, 'companion')
  assert.ok(removed.deletedAt)
  assert.equal(removed.song, undefined)
  assert.throws(() => h.store.feed.get(post.id), /not found/u)
  assert.deepEqual(h.store.feed.list().items, [])
  h.reopen()
  assert.equal(h.store.feed.bySongTask(task.id).deletedAt, removed.deletedAt)
  assert.throws(() => h.store.feed.create(input), /already shared/u)
  assert.equal(h.store.media.get(task.id).hash, hash)
})

test('only a completed archive from the current bound singing topic may become a top-level song post', t => {
  const h = fixture(t)
  const parent = h.store.feed.create({ author: 'user', body: '普通动态' })
  const task = h.createTask()
  h.addAsset(task.id)
  const input = h.postInput(task.id)
  for (const patch of [
    { author: 'user' }, { sourceSessionId: undefined }, { sourceSessionId: otherSessionId }, { contextId: 'chat.mobile' },
    { parentId: parent.id }, { mediaId: randomUUID() }, { sourceTaskId: randomUUID() }, { body: '歌'.repeat(281) },
  ]) assert.throws(() => h.store.feed.create({ ...input, ...patch }), /authorized|current singing session/u)
  assert.throws(() => h.store.feed.create({ ...input, body: ' \n ' }), /must contain text/u)
  assert.throws(() => h.store.feed.create({ ...input, songTaskId: 'not-a-task' }), /verified archive/u)
  const wrongSession = h.createTask({ sessionId: otherSessionId })
  const wrongCapability = h.createTask({ capabilityId: 'media.tts' })
  const wrongContext = h.createTask({ contextId: 'chat.mobile' })
  const pending = h.createTask({}, 'accepted')
  const failed = h.createTask({}, 'failed')
  for (const unavailable of [wrongSession, wrongCapability, wrongContext, pending, failed]) {
    h.addAsset(unavailable.id)
    assert.throws(() => h.store.feed.create(h.postInput(unavailable.id)), /verified archive/u)
  }
  h.store.bindContext({ contextId: SINGING_CONTEXT, sessionId, kind: 'chat', label: '并非歌唱话题' })
  assert.throws(() => h.store.feed.create(input), /verified archive/u)
  assert.deepEqual(h.store.feed.list().items.map(post => post.id), [parent.id])
})

test('invalid manifests are rejected and a missing song loses only its playback card', t => {
  const h = fixture(t)
  for (const asset of [
    { kind: 'image' }, { source: 'tts' }, { sourceRef: randomUUID() }, { path: 'elsewhere.wav' }, { hash: 'bad' },
    { mimeType: 'image/png' }, { bytes: MAX_SINGING_WAV_BYTES + 1 }, { bytes: 43 }, { retention: 'cache' },
    { missingAt: now }, { deletedAt: now },
  ]) {
    const task = h.createTask()
    h.addAsset(task.id, asset)
    assert.throws(() => h.store.feed.create(h.postInput(task.id)), /verified archive/u)
  }
  const task = h.createTask()
  h.addAsset(task.id)
  const post = h.store.feed.create(h.postInput(task.id))
  h.store.media.markDeleted(task.id, now)
  const latest = h.store.feed.get(post.id)
  assert.equal(latest.body, caption)
  assert.equal(latest.song, undefined)
  assert.equal(h.store.feed.bySongTask(task.id).id, post.id)
})

test('title matching is exact, session-scoped and bounded at two completed songs', t => {
  const h = fixture(t)
  const only = h.createTask()
  h.createTask({}, 'accepted')
  h.createTask({}, 'failed')
  h.createTask({ sessionId: otherSessionId })
  h.createTask({ capabilityId: 'media.tts' })
  h.createTask({ contextId: 'chat.mobile' })
  assert.deepEqual(h.store.feed.completedSongIdsByTitle(sessionId, title), [only.id])
  assert.deepEqual(h.store.feed.completedSongIdsByTitle(sessionId, title + ' '), [])
  const duplicates = [only, h.createTask(), h.createTask()].map(task => task.id)
  const matches = h.store.feed.completedSongIdsByTitle(sessionId, title)
  assert.equal(matches.length, 2)
  assert.ok(matches.every(id => duplicates.includes(id)))
})
