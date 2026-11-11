import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerAvatarHttp } from '../src/host/avatar-http.ts'
import { RealtimeVoiceService } from '../src/host/realtime-voice.ts'

const STAGE = '11111111-1111-4111-8111-111111111111'
const OTHER_STAGE = '22222222-2222-4222-8222-222222222222'
const assistant = (seq, turn, messageId, text = '一条完整的助手回复。', extra = {}) => ({
  type: 'assistant/message', seq,
  data: { turn, message: { id: messageId, content: [{ type: 'text', text }] }, ...extra },
})
const end = (seq, turn, kind = 'completed') => ({ type: 'turn/end', seq, data: { turn, reason: { kind } } })

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/voice-auto-test-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const chat = store.bindContext({ contextId: 'chat.mobile', sessionId: 'mobile', label: '手机聊天', kind: 'chat' })
  const game = store.bindContext({ contextId: 'game.minecraft', sessionId: 'game', label: 'Minecraft', kind: 'game' })
  store.bindContext({ contextId: 'memory.curator', sessionId: 'internal', label: '记忆整理', kind: 'system' })
  const calls = []
  const history = t.mock.fn(async () => ({ sessionId: 'mobile', messages: [{ id: 'manual', role: 'assistant', text: '手动播放。' }] }))
  const avatar = { view: () => ({ presentation: { ready: true } }) }
  const tts = {
    synthesizeClip: async (contextId, messageId, text) => {
      calls.push({ contextId, messageId, text })
      const task = store.createTask({ capabilityId: 'media.tts', title: '测试语音' })
      store.transitionTask(task.id, 'running')
      store.transitionTask(task.id, 'succeeded')
      return task
    },
    audio: async taskId => ({ taskId }),
  }
  const voice = new RealtimeVoiceService(store, { history }, tts, avatar)
  t.after(async () => { await voice.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { voice, store, chat, game, history, avatar, calls }
}

test('auto-reading is off by default and waits for a completed turn in the chosen scene', async t => {
  const { voice, chat, game, calls, history } = fixture(t)
  voice.observe(chat, assistant(1, 1, 'old'))
  voice.observe(chat, end(2, 1))
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: false })
  assert.deepEqual(voice.autoReadScenes().map(scene => scene.contextId), ['chat.mobile', 'game.minecraft'])
  assert.throws(() => voice.enableAutoRead('memory.curator', STAGE), { code: 'voice-auto-scene-not-found' })
  voice.enableAutoRead(chat.contextId, STAGE)
  voice.observe(game, assistant(1, 1, 'wrong-scene'))
  voice.observe(game, end(2, 1))
  voice.observe(chat, assistant(3, 2, 'intermediate', '', { message: { id: 'intermediate', content: [{ type: 'text', text: '正在查找' }, { type: 'tool-call' }] } }))
  voice.observe(chat, end(4, 2))
  voice.observe(chat, assistant(5, 3, 'partial', '被打断', { interrupted: true }))
  voice.observe(chat, end(6, 3))
  voice.observe(chat, assistant(7, 4, 'aborted'))
  voice.observe(chat, end(8, 4, 'aborted'))
  voice.observe(chat, assistant(9, 5, 'oversized', '字'.repeat(901)))
  voice.observe(chat, end(10, 5))
  voice.observe(chat, assistant(11, 6, 'new'))
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: true, pending: false })
  assert.deepEqual(calls, [])
  voice.observe(chat, end(12, 6))
  voice.pollAutoRead(STAGE)
  await setImmediate()
  assert.deepEqual(calls.map(call => call.messageId), ['new'])
  assert.equal(history.mock.callCount(), 0)
  assert.equal(voice.view().session.messageId, 'new')
  assert.equal(voice.view().session.segments[0].status, 'ready')
})

test('busy stage keeps only the latest reply, and the opted-in page owns the resulting playback', async t => {
  const { voice, chat, calls } = fixture(t)
  voice.enableAutoRead(chat.contextId, STAGE)
  const manual = (await voice.startSession(chat.contextId)).session
  await setImmediate()
  voice.receipt({ sessionId: manual.id, segmentIndex: 0, status: 'playing' })
  voice.observe(chat, assistant(1, 1, 'first'))
  voice.observe(chat, end(2, 1))
  voice.observe(chat, assistant(3, 2, 'latest'))
  voice.observe(chat, end(4, 2))
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: true, pending: true })
  assert.deepEqual(voice.pollAutoRead(OTHER_STAGE), { enabled: false })
  assert.throws(() => voice.enableAutoRead(chat.contextId, OTHER_STAGE), { code: 'voice-auto-stage-busy' })
  voice.receipt({ sessionId: manual.id, segmentIndex: 0, status: 'completed' })
  voice.pollAutoRead(STAGE)
  await setImmediate()
  assert.deepEqual(calls.map(call => call.messageId), ['manual', 'latest'])
  const view = voice.view()
  assert.equal(view.playbackStageId, STAGE)
  const clip = view.session.segments[0].taskId
  await assert.rejects(voice.audio(clip, OTHER_STAGE), { code: 'voice-audio-not-ready' })
  assert.deepEqual(await voice.audio(clip, STAGE), { taskId: clip })
  const receipt = { sessionId: view.session.id, segmentIndex: 0, status: 'playing' }
  assert.throws(() => voice.receipt({ ...receipt, stageId: OTHER_STAGE }), { code: 'voice-auto-stage-mismatch' })
  voice.receipt({ ...receipt, stageId: STAGE })
  voice.receipt({ ...receipt, stageId: STAGE, status: 'completed' })
  voice.observe(chat, assistant(3, 2, 'latest'))
  voice.observe(chat, end(4, 2))
  voice.pollAutoRead(STAGE)
  assert.equal(calls.length, 2)
})

test('stop clears queued speech and an expired or rebound stage cannot speak', async t => {
  const { voice, chat, store, calls } = fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  voice.enableAutoRead(chat.contextId, STAGE)
  voice.observe(chat, assistant(1, 1, 'active'))
  voice.observe(chat, end(2, 1))
  voice.pollAutoRead(STAGE)
  await setImmediate()
  const current = voice.view().session
  voice.observe(chat, assistant(3, 2, 'queued'))
  voice.observe(chat, end(4, 2))
  voice.cancel(current.id)
  voice.receipt({ sessionId: current.id, segmentIndex: 0, stageId: STAGE, status: 'cancelled' })
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: false })
  assert.deepEqual(calls.map(call => call.messageId), ['active'])
  voice.enableAutoRead(chat.contextId, STAGE)
  voice.observe(chat, assistant(5, 3, 'expired'))
  voice.observe(chat, end(6, 3))
  t.mock.timers.tick(5001)
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: false })
  voice.enableAutoRead(chat.contextId, STAGE)
  const rebound = store.bindContext({ ...chat, sessionId: 'replacement' })
  voice.observe(rebound, assistant(1, 1, 'replacement'))
  voice.observe(rebound, end(2, 1))
  assert.deepEqual(voice.pollAutoRead(STAGE), { enabled: false })
  assert.equal(calls.length, 1)
})

test('automatic speech endpoints remain behind management request checks', async t => {
  const { voice, avatar } = fixture(t)
  let handler
  let origin
  registerAvatarHttp({ webServer: { getOrigin: () => origin, register: route => { handler = route.handler; return () => {} } } }, avatar, voice)
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  origin = `http://127.0.0.1:${server.address().port}`
  const path = `${origin}/companion/avatar/api/realtime`
  const request = (suffix, payload) => fetch(`${path}${suffix}`, {
    method: payload ? 'POST' : 'GET',
    headers: { 'x-companion-request': '1', 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
  assert.equal((await fetch(`${path}/scenes`)).status, 403)
  assert.deepEqual(await (await request('/scenes')).json(), voice.autoReadScenes())
  assert.equal((await request('/auto', { stageId: 'invalid', contextId: 'chat.mobile' })).status, 400)
  assert.deepEqual(await (await request('/auto', { stageId: STAGE, contextId: 'chat.mobile' })).json(), { enabled: true, contextId: 'chat.mobile' })
  assert.deepEqual(await (await request('/auto/poll', { stageId: STAGE })).json(), { enabled: true, pending: false })
  assert.deepEqual(await (await request('/auto', { stageId: STAGE })).json(), { enabled: false })
})
