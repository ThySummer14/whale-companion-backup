import assert from 'node:assert/strict'
import test from 'node:test'
import { projectHome } from '../src/core/home.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { RealtimeVoiceService } from '../src/host/realtime-voice.ts'

const now = new Date('2026-11-09T13:00:00.000Z')
const binding = (contextId, kind, sessionId = contextId) => ({ contextId, kind, sessionId, label: 'private scene' })
const bindings = [
  binding('chat.mobile', 'chat'),
  binding('topic.music', 'topic'),
  binding('game.minecraft', 'game'),
  binding('memory.curator', 'chat'),
  binding('autonomy.feed', 'topic'),
  binding('autonomy.minecraft-feed', 'topic'),
  binding('autonomy.minecraft-supply', 'topic'),
  binding('feed.reply.private', 'topic'),
]
const project = (overrides = {}) => projectHome({
  now, presence: 'idle', minecraft: false, speaking: false, quiet: false,
  bindings, runningSessions: new Set(), activities: [], ...overrides,
})

test('home prioritizes verified live sources and excludes internal sessions from chatting', () => {
  const runningSessions = new Set(['chat.mobile', 'topic.music'])
  const cases = [
    [{ minecraft: true, speaking: true, runningSessions, quiet: true }, 'minecraft', 'desk'],
    [{ speaking: true, runningSessions, quiet: true }, 'speaking', 'stage'],
    [{ runningSessions: new Set(['chat.mobile']), quiet: true }, 'chatting', 'sofa'],
    [{ runningSessions: new Set(['topic.music']), quiet: true }, 'chatting', 'sofa'],
    [{ presence: 'running', runningSessions: new Set(bindings.slice(2).map(item => item.sessionId)), quiet: true }, 'resting', 'bed'],
    [{ presence: 'running', runningSessions: new Set(['unbound']) }, 'idle', 'window'],
    [{ presence: 'idle', quiet: true }, 'resting', 'bed'],
    [{ presence: 'idle' }, 'idle', 'window'],
    [{ presence: 'offline', quiet: true }, 'offline', 'none'],
    [{ presence: 'unconfigured', quiet: true }, 'offline', 'none'],
  ]
  for (const [input, activity, anchor] of cases) {
    assert.deepEqual(project(input), { version: 1, activity, anchor, observedAt: now.toISOString(), recent: [] })
  }
})

test('only idle can show a live reflection, while the previous legacy activity and position stay intact', () => {
  const reflectionAt = '2026-11-09T20:59:11+08:00'
  const recentRevision = '2026-11-09T12:00:00.000Z'
  const live = project({ reflectionAt, journalRevisionAt: recentRevision })
  assert.equal(live.activity, 'idle')
  assert.equal(live.anchor, 'window')
  assert.deepEqual(live.journal, { state: 'reflecting', at: '2026-11-09T12:59:11.000Z' })
  for (const input of [{ minecraft: true }, { singing: true }, { speaking: true }, { browsing: true },
    { runningSessions: new Set(['chat.mobile']) }, { quiet: true }, { presence: 'offline' }]) {
    assert.equal(project({ ...input, reflectionAt }).journal, undefined)
    assert.deepEqual(project({ ...input, reflectionAt, journalRevisionAt: recentRevision }).journal, { state: 'revised', at: recentRevision })
  }
  assert.equal(project({ reflectionAt: 'future' }).journal, undefined)
  assert.equal(project({ reflectionAt: '2026-11-09T13:00:01.000Z' }).journal, undefined)
})

test('the last verified revision is visible for precisely 24 hours after its timestamp', () => {
  const at = '2026-11-08T13:00:00.001Z'
  assert.deepEqual(project({ journalRevisionAt: at }).journal, { state: 'revised', at })
  for (const value of [null, 'invalid', '2026-11-08T13:00:00.000Z', '2026-11-09T13:00:00.001Z']) {
    assert.equal(project({ journalRevisionAt: value ?? undefined }).journal, undefined)
  }
})

test('recent home activity projects only receipt kind and time, preserving order and the four item cap', () => {
  const record = (source, kind, overrides = {}) => ({
    source, kind, id: 123, eventId: 'private-id', taskId: 'private-task', summary: 'private text',
    occurredAt: '2026-11-09T20:09:00+08:00', status: 'success',
    data: { x: 3126, y: 72, z: -13, key: 'private-key' }, ...overrides,
  })
  const chat = record('core.session', 'assistant.completed', { contextId: 'chat.mobile', sessionId: 'chat.mobile' })
  const game = action => record(`minecraft.${action}`, 'task.succeeded', { contextId: 'game.minecraft' })
  const feed = (kind, author) => record('core.feed', kind, { data: { author, postId: 'private-post' } })
  const activities = [
    { ...chat, status: 'warning' },
    { ...chat, data: { interrupted: true } },
    { ...chat, sessionId: 'stale' },
    { ...chat, contextId: 'memory.curator', sessionId: 'memory.curator' },
    { ...chat, occurredAt: 'invalid' },
    feed('post.created', 'owner'),
    feed('post.deleted', 'companion'),
    game('move'), game('prepare'),
    { ...game('build'), kind: 'task.running', status: 'info' },
    { ...game('craft'), contextId: 'chat.mobile' },
    feed('post.replied', 'companion'), game('return'), game('build'), game('craft'),
    chat, game('dig'), feed('post.created', 'companion'),
  ]
  const at = '2026-11-09T12:09:00.000Z'
  assert.deepEqual(project({ activities }).recent, ['reply', 'return', 'build', 'craft'].map(kind => ({ kind, at })))
  const projection = project({ activities: activities.slice(-3) })
  assert.equal(projection.activity, 'idle')
  assert.deepEqual(projection.recent, ['chat', 'gather', 'post'].map(kind => ({ kind, at })))
})

test('the home distinguishes a live song from speech and an archived track from stage completion', () => {
  const at = '2026-11-09T13:00:00.000Z'
  const activity = { occurredAt: at, status: 'success', source: 'media.realtime', kind: 'song.played', data: { title: 'private song' } }
  const result = project({ singing: true, speaking: true, activities: [
    { ...activity, source: 'media.singing', kind: 'song.archived' },
    { ...activity, status: 'warning' }, activity,
  ] })
  assert.equal(result.activity, 'singing')
  assert.equal(result.anchor, 'stage')
  assert.deepEqual(result.recent, [{ kind: 'song', at }])
  assert.equal(project({ singing: true, minecraft: true }).activity, 'minecraft')
})

test('the existing quiet-hours schedule supplies the home rest boundary', () => {
  const service = (quietStart, quietEnd) => new AutonomyService({ autonomy: { settings: () => ({ quietStart, quietEnd }) } }, {})
  const minute = (hour, minutes = 0) => new Date(2026, 10, 9, hour, minutes)
  const night = service('23:00', '07:00')
  assert.equal(night.isQuietTime(minute(22, 59)), false)
  assert.equal(night.isQuietTime(minute(23)), true)
  assert.equal(night.isQuietTime(minute(0)), true)
  assert.equal(night.isQuietTime(minute(6, 59)), true)
  assert.equal(night.isQuietTime(minute(7)), false)
  assert.equal(service('12:00', '13:00').isQuietTime(minute(12)), true)
  assert.equal(service('12:00', '13:00').isQuietTime(minute(13)), false)
  assert.equal(service('00:00', '00:00').isQuietTime(minute(0)), false)
})

test('Minecraft home presence uses only fresh worker poll evidence and invalidates a racing disconnect', async t => {
  const service = new MinecraftService({ updateCapability() {} }, {}, { dataDir: '.', serverRoot: '.', owner: 'owner' })
  service.ready = true
  const active = { items: [], presence: { online: true, action: 'build' } }
  let reply = active
  t.mock.method(service, 'request', async path => {
    if (path === '/disconnect') return { online: false }
    assert.equal(path, '/events?after=0')
    return reply
  })
  await service.refreshEvents()
  assert.equal(service.homeActive(Date.now()), true)
  assert.equal(service.homeActive(Date.now(), true), true)
  assert.equal(service.homeActive(Date.now() + 5001), false)
  reply = { items: [], presence: { online: true, action: 'house-cell' } }
  await service.refreshEvents()
  assert.equal(service.homeActive(Date.now()), true)
  assert.equal(service.homeActive(Date.now(), true), false)
  reply = { items: [], presence: { online: true } }
  await service.refreshEvents()
  assert.equal(service.homeActive(Date.now()), false)
  reply = { items: [] }
  await service.refreshEvents()
  assert.equal(service.homeActive(Date.now()), false)
  const pending = Promise.withResolvers()
  reply = pending.promise
  const poll = service.refreshEvents()
  await service.disconnect()
  pending.resolve(active)
  await poll
  assert.equal(service.homeActive(Date.now()), false)
})

test('Live2D home speech needs a playing receipt, current stage and currently playing segment', () => {
  let ready = true
  let stageReads = 0
  const store = { tasks: () => [], taskById: () => undefined }
  const voice = new RealtimeVoiceService(store, {}, {}, {
    view: () => { stageReads++; return { presentation: ready ? { ready } : undefined } },
  })
  const isSpeaking = () => voice.homeSpeaking(Date.now())
  voice.session = {
    id: 'voice', status: 'preparing',
    segments: [{ index: 0, status: 'ready' }, { index: 1, status: 'ready' }],
  }
  assert.equal(isSpeaking(), false)
  assert.equal(stageReads, 0)
  const receipt = status => voice.receipt({ sessionId: 'voice', segmentIndex: 0, status })
  receipt('playing')
  assert.equal(isSpeaking(), true)
  ready = false
  assert.equal(isSpeaking(), false)
  ready = true
  receipt('completed')
  assert.equal(isSpeaking(), false)
})


test('video history links only validated public details from the current owner browsing topic', async t => {
  const binding = { contextId: 'world.bilibili', kind: 'topic', sessionId: 'public-video-session' }
  const host = { contextId: 'autonomy.bilibili', kind: 'system', sessionId: 'private-video-session' }
  const at = '2026-11-09T12:09:00.000Z'
  const bvid = 'BV1dLx46TEhw'
  const manual = { contextId: binding.contextId, sessionId: binding.sessionId, occurredAt: at,
    status: 'success', source: 'media.bilibili', kind: 'video.clip-sampled',
    data: { bvid, part: 3, start: 12, seconds: 6, visual: true, audio: false, transcript: 'PRIVATE-TRANSCRIPT' } }
  const one = activity => project({ bindings: [binding, host], activities: [activity] }).recent[0]
  assert.deepEqual(one(manual), { kind: 'video', at, video: { mode: 'clip',
    source: { bvid, part: 3, startSeconds: 12, seconds: 6, visual: true, audio: false } } })
  assert.deepEqual(one({ ...manual, kind: 'video.subtitle-read' }).video, { mode: 'subtitle', source: { bvid, part: 3 } })
  for (const [name, changes] of [
    ['stale session', { sessionId: 'outdated' }],
    ['inspect only', { kind: 'video.inspected' }],
    ['wrong connector', { source: 'api.manual' }],
    ['failed read', { status: 'error' }],
    ['no material', { data: { ...manual.data, visual: false, audio: false } }],
  ]) await t.test(name, () => assert.equal(one({ ...manual, ...changes }), undefined))
  for (const [name, data] of [
    ['foreign URL', { bvid: 'https://example.com/private' }],
    ['wrong part', { part: 1001 }],
    ['invalid range start', { start: -1 }],
    ['out of range', { start: 604801 }],
    ['clip too long', { seconds: 13 }],
    ['malformed flags', { audio: 'true' }],
  ]) await t.test(name, () => assert.deepEqual(one({ ...manual, data: { ...manual.data, ...data } }).video, { mode: 'clip' }))
  assert.deepEqual(one({ ...manual, contextId: 'autonomy.bilibili-clip', sessionId: 'private-clip', taskId: 'private-task' }).video,
    { mode: 'clip' })
  assert.deepEqual(one({ ...manual, contextId: host.contextId, sessionId: host.sessionId, kind: 'video.subtitle-read',
    data: { ...manual.data, candidateId: 'private-id' } }).video, { mode: 'subtitle' })
})
