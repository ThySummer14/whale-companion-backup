import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { parseSongWav } from '../src/host/song-mix.ts'
import { SingingService } from '../src/host/singing.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'

const input = { title: '隔离歌唱任务', lyrics: '仅在测试中的原创歌词', style: '短歌，清唱', durationSeconds: 10 }

function fixture(t, provider) {
  const work = resolve('.work')
  mkdirSync(work, { recursive: true })
  const root = mkdtempSync(join(work, 'singing-service-'))
  const store = new CompanionStore(join(root, 'state.sqlite'))
  const deviceId = '7fa20af4-505b-48a6-96c9-e39460528900'
  store.createDevice({ id: deviceId, name: 'Singing fixture', secretHash: 'fixture', createdAt: new Date().toISOString() })
  const service = new SingingService(store, join(root, 'media'), provider)
  const songs = join(root, 'media', 'songs')
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const notices = () => store.notices.list(deviceId, {}).items.map(({ kind, taskId }) => ({ kind, taskId }))
  return { service, store, songs, root, notices }
}

function wav({ seconds = 10, bits = 16, silent = false } = {}) {
  const rate = 16_000
  const size = seconds * rate * 2
  const bytes = Buffer.alloc(44 + size)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(bits, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(size, 40)
  if (!silent) bytes.writeInt16LE(1000, 44)
  return bytes
}

async function settled(store, id) {
  for (let count = 0; count < 500; count++) {
    const task = store.taskById(id)
    if (task && ['succeeded', 'failed', 'cancelled'].includes(task.status)) return task
    await delay(2)
  }
  throw new Error('Singing fixture did not settle')
}

test('only verified WAV bytes are archived as a private retained song with a durable receipt', async t => {
  const bytes = wav()
  const { store, service, songs, notices } = fixture(t, { async generate(value) { assert.deepEqual(value, input); return bytes } })
  service.start()
  assert.equal(service.view().available, true)
  const { task, audio } = service.submit(input, { sessionId: 'singing-test' })
  assert.equal(task.status, 'accepted')
  assert.equal(task.sessionId, 'singing-test')
  assert.equal(audio, undefined)
  await assert.rejects(service.audio(task.id), { code: 'singing-audio-not-found' })
  assert.equal((await settled(store, task.id)).status, 'succeeded')
  const result = await service.audio(task.id)
  assert.equal(result.filePath, join(songs, `${task.id}.wav`))
  assert.equal(result.bytes, bytes.length)
  assert.equal(result.mimeType, 'audio/wav')
  const archivedPcm = parseSongWav(result.data).pcm
  let archivedPeak = 0
  for (let i = 0; i < archivedPcm.length; i += 2) archivedPeak = Math.max(archivedPeak, Math.abs(archivedPcm.readInt16LE(i)))
  assert.equal(archivedPeak, Math.round(32767 * 10 ** (-1.5 / 20)))
  assert.deepEqual(readFileSync(result.filePath), result.data)
  assert.equal(statSync(result.filePath).mode & 0o777, 0o600)
  assert.equal(statSync(songs).mode & 0o777, 0o700)
  const archive = store.media.get(task.id)
  assert.equal(archive.retention, 'keep')
  assert.equal(archive.kind, 'song')
  assert.equal(archive.source, 'singing')
  assert.equal(archive.sourceRef, task.id)
  assert.equal(archive.hash.length, 64)
  assert.deepEqual(store.media.cleanupPreview(0).candidates, [])
  const receipt = store.activities().find(item => item.kind === 'song.archived')
  assert.equal(receipt.taskId, task.id)
  assert.equal(receipt.data.durationSeconds, 10)
  assert.doesNotMatch(JSON.stringify(store.activities()), /原创歌词/u)
  assert.deepEqual(notices(), [{ kind: 'song-ready', taskId: task.id }])
  assert.equal(service.archive().items[0].id, task.id)
  await service.close()
  assert.deepEqual(readdirSync(songs), [`${task.id}.wav`])
})

test('music pages use archive order, retain older songs, and reject invalid cursors', t => {
  const { store, service } = fixture(t)
  const ids = []
  for (let i = 0; i < 23; i++) {
    const task = store.createTask({ capabilityId: 'media.singing', title: `音乐作品 ${i}` })
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
    const archivedAt = new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString()
    store.media.upsert({
      id: task.id, kind: 'song', path: `songs/${task.id}.wav`, hash: 'test',
      mimeType: 'audio/wav', bytes: 100, source: 'singing', sourceRef: task.id, retention: 'keep',
      createdAt: archivedAt, lastUsedAt: archivedAt, lastVerifiedAt: archivedAt,
    })
    ids.unshift(task.id)
  }
  const first = service.archive()
  assert.deepEqual(first.items.map(item => item.id), ids.slice(0, 20))
  store.media.touch(`songs/${ids.at(-1)}.wav`, '2027-01-01T00:00:00.000Z')
  const second = service.archive(first.nextCursor)
  assert.deepEqual(second.items.map(item => item.id), ids.slice(20))
  assert.equal(second.nextCursor, undefined)
  assert.throws(() => service.archive('invalid'), { code: 'invalid-song-cursor' })
})

test('only one active render is admitted and cancel prevents a late provider response from publishing a song', async t => {
  let complete
  let receivedSignal
  let closes = 0
  const { store, service, songs, notices } = fixture(t, {
    generate(_value, signal) {
      receivedSignal = signal
      return new Promise(resolve => { complete = resolve })
    },
    close() { closes++ },
  })
  const { task } = service.submit(input)
  assert.throws(() => service.submit(input), { code: 'singing-busy' })
  await nextTick()
  assert.equal(store.taskById(task.id).status, 'running')
  assert.equal(service.cancel(task.id).task.status, 'cancelled')
  assert.equal(receivedSignal.aborted, true)
  await Promise.all([service.close(), service.close()])
  assert.equal(closes, 1)
  complete(wav())
  await nextTick()
  assert.equal(service.cancel(task.id).task.status, 'cancelled')
  assert.equal(store.media.get(task.id), undefined)
  assert.deepEqual(notices(), [])
  assert.deepEqual(readdirSync(songs), [])
})

test('silent, invalid and out-of-bounds results fail without an archive or task audio', async t => {
  for (const bytes of [wav({ silent: true }), wav({ bits: 32 }), wav({ seconds: 1 }), wav({ seconds: 66 }), Buffer.alloc(24 * 1024 * 1024 + 1)]) {
    const { store, service, songs, notices } = fixture(t, { async generate() { return bytes } })
    const { task } = service.submit(input)
    const current = await settled(store, task.id)
    assert.equal(current.status, 'failed')
    assert.equal(current.error, 'singing-invalid-audio')
    assert.equal(store.media.get(task.id), undefined)
    assert.deepEqual(notices(), [{ kind: 'song-failed', taskId: task.id }])
    await assert.rejects(service.audio(task.id), { code: 'singing-audio-not-found' })
    await service.close()
    assert.deepEqual(readdirSync(songs), [])
  }
})

test('same-length modification and symlink substitution are rejected at authenticated audio lookup', async t => {
  const { store, service, songs } = fixture(t, { async generate() { return wav() } })
  const { task } = service.submit(input)
  assert.equal((await settled(store, task.id)).status, 'succeeded')
  const { filePath } = await service.audio(task.id)
  const contents = readFileSync(filePath)
  contents[contents.length - 1] = 99
  writeFileSync(filePath, contents)
  await assert.rejects(service.audio(task.id), { code: 'singing-audio-not-found' })
  rmSync(filePath)
  writeFileSync(join(songs, 'replacement.wav'), wav())
  symlinkSync(join(songs, 'replacement.wav'), filePath)
  await assert.rejects(service.audio(task.id), { code: 'singing-audio-not-found' })
})

test('restart fails interrupted work without replay and removes only owned uncommitted output names', t => {
  const { store, service, songs } = fixture(t, { async generate() { throw new Error('must never be called') } })
  const task = store.createTask({ capabilityId: 'media.singing', title: 'interrupted' })
  const other = store.createTask({ capabilityId: 'media.tts', title: 'other task' })
  store.transitionTask(task.id, 'running')
  mkdirSync(songs, { recursive: true })
  writeFileSync(join(songs, `${task.id}.pending.wav`), wav())
  writeFileSync(join(songs, `${task.id}.wav`), wav())
  writeFileSync(join(songs, `${other.id}.pending.wav`), wav())
  service.start()
  assert.equal(store.taskById(task.id).status, 'failed')
  assert.equal(existsSync(join(songs, `${task.id}.pending.wav`)), false)
  assert.equal(existsSync(join(songs, `${task.id}.wav`)), false)
  assert.equal(existsSync(join(songs, `${other.id}.pending.wav`)), true)
  assert.equal(service.view().tasks.length, 1)
})

test('a failure after a manifest write rolls back both the archive record and terminal task receipt', async t => {
  const { store, service, songs } = fixture(t, { async generate() { return wav() } })
  const original = store.media.upsert.bind(store.media)
  store.media.upsert = input => {
    original(input)
    throw new Error('isolated receipt failure')
  }
  const { task } = service.submit(input)
  assert.equal((await settled(store, task.id)).status, 'failed')
  await service.close()
  assert.equal(store.media.get(task.id), undefined)
  assert.deepEqual(readdirSync(songs), [])
  assert.equal(store.activities().some(item => item.taskId === task.id && item.kind === 'task.succeeded'), false)
})

test('song sharing verifies the archive and current turn, coalesces publication, and keeps withdrawn audio', async t => {
  const { store, service, songs, notices } = fixture(t, { async generate() { return wav() } })
  const contextId = 'world.singing'
  const sessionId = 'owner-singing-session'
  store.bindContext({ contextId, sessionId, kind: 'topic', label: '歌唱' })
  const { task } = service.submit(input, { sessionId })
  const runtime = Object.assign(Object.create(CompanionRuntime.prototype), {
    store, singing: service, events: [], autonomy: { observePost() {} },
  })
  const command = { operation: 'share', selector: input.title, sessionId, caption: '留给你的一段短歌。',
    signal: new AbortController().signal, assertCurrent() {} }
  const change = patch => runtime.changeSongShare({ ...command, ...patch })
  await assert.rejects(change({}), { code: 'singing-share-not-found' })
  await settled(store, task.id)
  await assert.rejects(change({ sessionId: 'other', selector: task.id }), { code: 'singing-share-not-found' })
  await assert.rejects(change({ caption: 'a'.repeat(281) }), { code: 'singing-share-invalid-caption' })
  let assertions = 0
  await assert.rejects(change({ assertCurrent() { if (++assertions > 1) throw new Error('turn ended') } }), /turn ended/u)
  assert.deepEqual(store.feed.list().items, [])
  const file = join(songs, `${task.id}.wav`)
  const original = readFileSync(file)
  const tampered = Buffer.from(original)
  tampered[44] ^= 1
  writeFileSync(file, tampered)
  await assert.rejects(change({}), { code: 'singing-audio-not-found' })
  assert.deepEqual(store.feed.list().items, [])
  writeFileSync(file, original)
  const results = await Promise.all([change({}), change({ selector: task.id })])
  assert.deepEqual(results.map(result => result.status).sort(), ['already-shared', 'shared'])
  const postId = results[0].postId
  assert.equal(results[1].postId, postId)
  assert.equal(store.feed.get(postId).song.id, task.id)
  assert.equal(notices().filter(item => item.kind === 'feed-post').length, 1)
  assert.deepEqual(await change({ operation: 'withdraw', caption: undefined }), { status: 'withdrawn', postId, title: input.title })
  assert.equal((await change({ operation: 'withdraw' })).postId, postId)
  await assert.rejects(change({}), { code: 'singing-share-withdrawn' })
  assert.throws(() => store.feed.get(postId), /Post not found/u)
  assert.deepEqual((await service.audio(task.id)).data, original)
  assert.deepEqual(notices().map(item => item.kind), ['song-ready'])
})

test('rejects invalid inputs and refuses a symlinked song directory before a task is created', t => {
  const { root, store, service, songs } = fixture(t, { async generate() { return wav() } })
  assert.throws(() => service.submit({ ...input, durationSeconds: 61 }), { code: 'singing-invalid-input' })
  const unrelated = join(root, 'unrelated')
  mkdirSync(unrelated)
  chmodSync(unrelated, 0o755)
  mkdirSync(join(root, 'media'))
  symlinkSync(unrelated, songs)
  assert.throws(() => service.submit(input), { code: 'singing-archive-unavailable' })
  assert.equal(statSync(unrelated).mode & 0o777, 0o755)
  assert.deepEqual(store.tasks(10, 'media.singing'), [])
})
