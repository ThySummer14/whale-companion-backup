import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { AvatarService } from '../src/host/avatar.ts'
import { registerAvatarHttp } from '../src/host/avatar-http.ts'
import { registerHttp } from '../src/host/http.ts'
import { RealtimeVoiceService } from '../src/host/realtime-voice.ts'
import { SingingService } from '../src/host/singing.ts'
import { SONG_VOCAL_ENVELOPE_HEADER } from '../src/protocol/singing.ts'

const STAGE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function wave() {
  const bytes = Buffer.alloc(44 + 4 * 16_000 * 2)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  bytes.writeInt16LE(800, 44)
  return bytes
}

async function fixture(t, readSong, mixed = false) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/song-stage-test-'))
  const store = new CompanionStore(join(root, 'store.sqlite'))
  const avatar = new AvatarService(store, root, root)
  const bytes = wave()
  const backing = mixed ? wave() : undefined
  if (backing) {
    bytes.writeInt16LE(0, 44)
    for (let offset = 44; offset < backing.length; offset += 2) {
      backing.writeInt16LE(10_000, offset)
      if (offset >= 44 + 32_000) bytes.writeInt16LE(4_000, offset)
    }
  }
  const singing = new SingingService(store, join(root, 'media'), undefined, { convert: async () => bytes })
  const { task } = singing.submitCover('舞台归档曲目', bytes, backing && { accompaniment: backing })
  for (let wait = 0; wait < 100 && store.taskById(task.id).status !== 'succeeded'; wait++) await delay(10)
  assert.equal(store.taskById(task.id).status, 'succeeded')
  const history = t.mock.fn(async () => ({ sessionId: 'mobile', messages: [{ id: 'manual', role: 'assistant', text: '测试朗读。' }] }))
  const chat = store.bindContext({ contextId: 'chat.mobile', sessionId: 'mobile', kind: 'chat', label: '手机聊天' })
  const synthesizeClip = t.mock.fn(async () => {
    const clip = store.createTask({ capabilityId: 'media.tts', title: '测试朗读' })
    store.transitionTask(clip.id, 'running')
    store.transitionTask(clip.id, 'succeeded')
    return clip
  })
  const archive = readSong ? { audio: (id, signal) => readSong(singing, id, signal) } : singing
  const voice = new RealtimeVoiceService(store, { history }, { synthesizeClip }, avatar, undefined, undefined, archive)
  t.after(async () => { await voice.close(); await singing.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  const heartbeat = (stageId = STAGE, overrides = {}) => ({
    ready: true, frames: 12, nonFinite: 0, stageId, songReady: true,
    voice: { playing: false, positionMs: 0, energy: 0, audioContextState: 'running' }, ...overrides,
  })
  return { avatar, bytes, voice, store, task, heartbeat, synthesizeClip, chat, singing }
}

test('archived songs play through the exact ready stage and require complete WAV delivery, time and an actual end receipt', async t => {
  const { avatar, bytes, voice, store, task, heartbeat, synthesizeClip } = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let origin
  const routes = new Map()
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { routes.set(route.path, route.handler); return () => {} } } }
  registerAvatarHttp(ctx, avatar, voice)
  registerHttp(ctx, { store })
  const server = createServer((req, res) => routes.get(req.url.startsWith('/companion/avatar/') ? '/companion/avatar' : '/companion')(req, res))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const call = (path, init) => fetch(`${origin}/companion/avatar/api${path}`, init)
  const headers = { 'x-companion-request': '1' }
  const post = (path, data, requestHeaders = headers) => call(path, { method: 'POST', headers: { ...requestHeaders, 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const management = (path, method, data) => fetch(`${origin}/companion/api${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const start = { taskId: task.id, stageId: STAGE }
  assert.equal((await post('/realtime/song', start, {})).status, 403)
  await post('/heartbeat', heartbeat(STAGE, { songReady: false }))
  assert.equal((await post('/realtime/song', start)).status, 409)
  await post('/heartbeat', heartbeat())
  await post('/heartbeat', heartbeat(OTHER))
  const accepted = await post('/realtime/song', start)
  assert.equal(accepted.status, 202)
  const { session, songStageId } = await accepted.json()
  assert.equal(songStageId, STAGE)
  assert.equal(session.kind, 'song')
  assert.equal(session.title, task.title)
  assert.equal(session.songDurationMs, 4000)
  assert.equal(store.taskById(session.taskId).status, 'accepted')
  const managementAttempts = await Promise.all([
    management('/tasks', 'POST', { capabilityId: 'media.realtime', contextId: 'world.singing', title: '绕过舞台创建任务' }),
    management(`/tasks/${session.taskId}`, 'PATCH', { status: 'succeeded' }),
    management('/events', 'POST', { source: 'media.realtime', kind: 'song.played', summary: '绕过舞台记录成功', status: 'success' }),
  ])
  for (const attempt of managementAttempts) {
    assert.equal(attempt.status, 403)
    assert.equal((await attempt.json()).code, 'song-stage-managed')
  }
  assert.equal(voice.homeSinging(now), false)
  const receipt = { sessionId: session.id, segmentIndex: 0, stageId: STAGE, status: 'playing', positionMs: 0 }
  const path = `/realtime/audio/${task.id}?stageId=${STAGE}`
  assert.equal((await call(`/realtime/audio/${task.id}?stageId=${OTHER}`, { headers })).status, 404)
  assert.equal((await post('/realtime/receipt', { ...receipt, stageId: OTHER })).status, 409)
  const partial = await call(path, { headers: { ...headers, range: 'bytes=0-31' } })
  assert.equal(partial.status, 206)
  await partial.arrayBuffer()
  assert.equal((await post('/realtime/receipt', receipt)).status, 409)
  const audio = await call(path, { headers })
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  assert.equal(audio.headers.get(SONG_VOCAL_ENVELOPE_HEADER), null)
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), bytes)
  assert.equal((await post('/realtime/receipt', receipt)).status, 200)
  assert.equal(store.taskById(session.taskId).status, 'running')
  assert.equal(voice.homeSinging(now), true)
  assert.equal(voice.homeSpeaking(now), false)
  const completed = { ...receipt, status: 'completed', positionMs: 4000 }
  assert.equal((await post('/realtime/receipt', completed)).status, 409)
  now += 3900
  assert.equal((await post('/realtime/receipt', { ...completed, positionMs: 1100 })).status, 409)
  assert.equal((await post('/realtime/receipt', completed)).status, 200)
  assert.equal((await post('/realtime/receipt', completed)).status, 200)
  assert.equal(store.taskById(session.taskId).status, 'succeeded')
  assert.equal(store.taskById(task.id).status, 'succeeded')
  assert.equal(voice.homeSinging(now), false)
  const events = store.activities().filter(item => item.kind === 'song.played')
  assert.equal(events.length, 1)
  assert.equal(events[0].taskId, session.taskId)
  assert.equal(events[0].data.songTaskId, task.id)
  assert.equal(synthesizeClip.mock.callCount(), 0)
  assert.equal((await call(path, { headers })).status, 404)
})

test('the vocal-only envelope accompanies only full WAV delivery to the assigned stage', async t => {
  const { avatar, voice, store, task, heartbeat, singing } = await fixture(t, undefined, true)
  let origin
  const routes = new Map()
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { routes.set(route.path, route.handler); return () => {} } } }
  registerAvatarHttp(ctx, avatar, voice)
  registerHttp(ctx, { store, singing })
  const server = createServer((req, res) => routes.get(req.url.startsWith('/companion/avatar/') ? '/companion/avatar' : '/companion')(req, res))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  avatar.heartbeat(heartbeat())
  avatar.heartbeat(heartbeat(OTHER))
  await voice.startSong(task.id, STAGE)
  const headers = { 'x-companion-request': '1' }
  const url = `${origin}/companion/avatar/api/realtime/audio/${task.id}`
  const forbidden = await fetch(`${url}?stageId=${STAGE}`)
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.headers.get(SONG_VOCAL_ENVELOPE_HEADER), null)
  const otherStage = await fetch(`${url}?stageId=${OTHER}`, { headers })
  assert.equal(otherStage.status, 404)
  assert.equal(otherStage.headers.get(SONG_VOCAL_ENVELOPE_HEADER), null)
  const partial = await fetch(`${url}?stageId=${STAGE}`, { headers: { ...headers, range: 'bytes=0-63' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get(SONG_VOCAL_ENVELOPE_HEADER), null)
  await partial.arrayBuffer()
  const archive = await fetch(`${origin}/companion/api/singing/tasks/${task.id}/audio`, { headers })
  assert.equal(archive.status, 200)
  assert.equal(archive.headers.get(SONG_VOCAL_ENVELOPE_HEADER), null)
  const delivered = await fetch(`${url}?stageId=${STAGE}`, { headers })
  assert.equal(delivered.status, 200)
  const header = delivered.headers.get(SONG_VOCAL_ENVELOPE_HEADER)
  assert.match(header, /^v1:[A-Za-z0-9+/]+={0,2}$/u)
  const samples = Buffer.from(header.slice(3), 'base64')
  assert.equal(samples.length, 160)
  assert.deepEqual(samples.subarray(0, 40), Buffer.alloc(40))
  assert.ok(samples.subarray(40).every(value => value > 0))
  const full = Buffer.from(await delivered.arrayBuffer())
  assert.ok(full.readInt16LE(44) > 0)
  assert.deepEqual(full, Buffer.from(await archive.arrayBuffer()))
})

test('the song slot includes verification, preserves queued auto-read and releases after real cancellation', async t => {
  let allow
  const paused = new Promise(resolve => { allow = resolve })
  const { avatar, voice, task, heartbeat, chat, synthesizeClip, store } = await fixture(t, async (singing, id, signal) => {
    await paused
    return singing.audio(id, signal)
  })
  avatar.heartbeat(heartbeat())
  voice.enableAutoRead(chat.contextId, STAGE)
  const playing = voice.startSong(task.id)
  await assert.rejects(voice.startSong(task.id), { code: 'voice-session-busy' })
  await assert.rejects(voice.startSession(chat.contextId), { code: 'voice-session-busy' })
  voice.observe(chat, { type: 'assistant/message', seq: 1, data: { turn: 1, message: { id: 'queued', content: [{ type: 'text', text: '朗读排队。' }] } } })
  voice.observe(chat, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: true, pending: true })
  allow()
  const { session } = await playing
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: true, pending: true })
  voice.cancel(session.id)
  assert.equal(voice.view().session.status, 'cancelling')
  await assert.rejects(voice.audio(task.id, STAGE), { code: 'voice-audio-not-ready' })
  assert.equal(voice.receipt({ sessionId: session.id, stageId: STAGE, segmentIndex: 0, status: 'cancelled' }).session.status, 'cancelled')
  assert.equal(store.activities().some(item => item.kind === 'song.played'), false)
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: true, pending: false })
  await setImmediate()
  assert.equal(synthesizeClip.mock.callCount(), 1)
  assert.equal(voice.view().session.messageId, 'queued')
})

test('stage heartbeat loss, startup timeout and runtime restart leave no successful song receipt', async t => {
  const { avatar, voice, task, heartbeat, store } = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  avatar.heartbeat(heartbeat())
  const first = (await voice.startSong(task.id)).session
  avatar.heartbeat(heartbeat(OTHER))
  now += 5001
  avatar.heartbeat(heartbeat(OTHER))
  assert.equal(voice.view().session.error, 'song-stage-offline')
  assert.equal(store.taskById(first.taskId).status, 'failed')
  const second = (await voice.startSong(task.id)).session
  now += 25_000
  avatar.heartbeat(heartbeat(OTHER))
  assert.equal(voice.view().session.error, 'song-playback-receipt-timeout')
  assert.equal(store.taskById(second.taskId).status, 'failed')
  const interrupted = store.createTask({ capabilityId: 'media.realtime', contextId: 'world.singing', title: '重启前舞台歌曲' })
  voice.start()
  assert.equal(store.taskById(interrupted.id).status, 'cancelled')
  assert.equal(store.activities().some(item => item.kind === 'song.played'), false)
})
