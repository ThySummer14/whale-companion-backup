import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SHARE_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY } from '../src/core/minecraft-house-project.ts'
import { deviceActivity, deviceContextAllowed, registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { EventHub } from '../src/host/events.ts'

const deviceRoot = '/companion-device/api'
const chat = 'chat.mobile'
const privateContexts = [BILIBILI_REFLECTION_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SHARE_CONTEXT]
const secret = '隔离字幕正文，仅限决策会话'

async function setup(t) {
  await mkdir('.work', { recursive: true })
  const root = await mkdtemp(resolve('.work/device-bili-privacy-'))
  const store = new CompanionStore(join(root, 'companion.db'))
  const routes = new Map()
  const upgrades = new Map()
  let origin
  const ctx = { webServer: {
    host: '127.0.0.1',
    getOrigin: () => origin,
    register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    registerUpgrade: route => { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path) },
  } }
  const devices = new DeviceService(ctx, store)
  const called = []
  const sessionRoots = []
  const publicHistory = { contextId: chat, messages: [{ role: 'assistant', text: '合法的配对聊天' }] }
  const privateTtsId = randomUUID()
  const runtime = {
    store,
    view: () => ({
      bindings: store.bindings(), sessions: sessionRoots, activities: store.activities(), tasks: store.tasks(),
      autonomy: { jobs: store.autonomy.list() }, home: { activity: 'idle' },
    }),
    sessions: {
      create: async input => { called.push('create'); return { binding: input } },
      send: async () => { called.push('send'); return {} },
      cancel: async () => { called.push('cancel') },
      history: async contextId => { called.push('history'); return contextId === chat ? publicHistory : { text: secret } },
      chatAttachment: async () => { called.push('attachment'); throw new Error('unreachable') },
    },
    tts: {
      get: () => ({ id: privateTtsId, contextId: BILIBILI_REFLECTION_CONTEXT, status: 'succeeded' }),
      synthesizeMessage: async () => { called.push('tts'); return {} },
    },
    audio: async () => { called.push('audio'); throw new Error('unreachable') },
    streamDeviceVoice: () => { called.push('voice'); throw new Error('unreachable') },
    publishPost: input => { called.push('post'); return store.feed.create(input) },
  }
  const dispose = registerDeviceHttp(ctx, runtime, devices)
  const server = createServer((req, res) => {
    const base = [...routes.keys()].find(path => req.url.startsWith(path + '/'))
    if (base) void routes.get(base)(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(new URL(req.url, origin).pathname)
    if (handler) handler(req, socket, head)
    else socket.destroy()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const { credential } = devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const hub = new EventHub(ctx, store, {
    path: deviceRoot + '/events', authorize: req => devices.authorize(req), contextAllowed: deviceContextAllowed, projectActivity: deviceActivity,
  })
  hub.start()
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    hub.close()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    dispose()
    devices.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = (path, data, method = data === undefined ? 'GET' : 'POST') => fetch(origin + deviceRoot + path, {
    method, headers: { authorization: credential, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  function connect(contextId) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + deviceRoot + '/events' +
      (contextId ? '?contextId=' + contextId : ''), { headers: { authorization: credential } })
    sockets.push(socket)
    const frames = []
    socket.on('message', bytes => frames.push(JSON.parse(bytes)))
    return { socket, frames }
  }
  return { request, connect, store, called, hub, privateTtsId, publicHistory, sessionRoots }
}

test('paired HTTP cannot read, write, or synthesize private decision sessions', async t => {
  const { request, store, called, privateTtsId, publicHistory } = await setup(t)
  for (const contextId of privateContexts) {
    for (const [path, input] of [
      ['/sessions', { contextId, kind: 'system', label: 'Private' }],
      ['/messages', { contextId, text: '我要字幕' }],
      ['/messages/cancel', { contextId }],
      ['/messages/history?contextId=' + contextId, undefined],
      ['/messages/attachment?contextId=' + contextId + '&messageId=m1&attachmentId=a1', undefined],
      ['/messages/m1/tts', { contextId }],
      ['/tts', { contextId, messageId: 'm1' }],
      ['/voice-stream', { contextId, messageId: 'm1' }],
    ]) {
      const response = await request(path, input)
      assert.equal(response.status, 403, path)
      assert.equal((await response.json()).code, 'device-context-forbidden')
    }
  }
  for (const method of ['GET', 'HEAD']) {
    for (const suffix of ['', '/audio']) assert.equal((await request('/tts/' + privateTtsId + suffix, undefined, method)).status, 403)
  }
  const sessionInput = { contextId: chat, kind: 'chat', label: 'Paired' }
  store.bindContext({ ...sessionInput, sessionId: 'paired-session' })
  store.bindContext({ contextId: DAILY_AUTONOMY_CONTEXT, sessionId: 'active-private-decision', kind: 'system', label: 'Private' })
  for (const resume of [true, false]) {
    for (const sessionId of ['unbound-private-decision', 'active-private-decision']) {
      assert.equal((await request('/sessions', { ...sessionInput, sessionId, resume })).status, 403)
    }
  }
  assert.equal((await request('/feed', { body: '尝试公开私有决策', contextId: DAILY_AUTONOMY_CONTEXT })).status, 400)
  assert.equal((await request('/feed', { body: '尝试公开私有复盘', contextId: DAILY_REFLECTION_CONTEXT })).status, 400)
  assert.equal((await request('/feed', { body: '尝试公开现场决定', contextId: DAILY_VISIT_CONTEXT })).status, 400)
  assert.deepEqual(called, [])
  assert.equal((await request('/sessions', { ...sessionInput, sessionId: 'paired-session', resume: true })).status, 201)
  assert.deepEqual(await (await request('/messages/history?contextId=' + chat)).json(), publicHistory)
  const post = await request('/feed', { body: '配对端普通动态' })
  assert.equal(post.status, 201)
  assert.equal((await post.json()).author, 'user')
  assert.deepEqual(called, ['create', 'history', 'post'])
})

test('paired state omits daily choice and reflection bindings, decisions, tasks and payloads while keeping public activity', async t => {
  const { request, store, sessionRoots } = await setup(t)
  const bound = 'current-private-session'
  const former = 'former-private-session'
  const review = 'private-review-session'
  const paired = 'paired-session'
  store.bindContext({ contextId: DAILY_AUTONOMY_CONTEXT, sessionId: bound, kind: 'system', label: secret })
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, sessionId: review, kind: 'system', label: secret })
  store.bindContext({ contextId: chat, sessionId: paired, kind: 'chat', label: '手机' })
  store.recordActivity({ contextId: DAILY_AUTONOMY_CONTEXT, sessionId: former, source: 'test', kind: 'fixture.private', summary: secret })
  store.recordActivity({ contextId: DAILY_REFLECTION_CONTEXT, sessionId: review, source: 'core.self-note', kind: 'self-note.created', summary: secret })
  store.recordActivity({ contextId: chat, sessionId: paired, source: 'test', kind: 'fixture.public', summary: '手机真实活动' })
  const job = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:2026-11-09',
    runAfter: Date.now(), payload: { candidateLabel: secret } })
  const reflection = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT, dedupeKey: `daily-reflection:${job.id}`,
    runAfter: Date.now(), payload: { dailyTaskId: job.id } })
  const child = store.autonomy.create({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT, dedupeKey: 'daily:bilibili:2026-11-09',
    runAfter: Date.now(), payload: { candidateId: 'public-receipt-fixture', dailyTaskId: job.id } })
  for (const id of [bound, former, review, paired]) sessionRoots.push({ id, status: 'idle' })
  const response = await request('/state')
  assert.equal(response.status, 200)
  const view = await response.json()
  assert.deepEqual(view.bindings.map(binding => binding.contextId), [chat])
  assert.deepEqual(view.sessions.map(session => session.id), [paired])
  assert.deepEqual(view.activities.map(activity => activity.kind), ['task.accepted', 'fixture.public'])
  assert.deepEqual(view.tasks.map(task => task.id), [child.id])
  assert.deepEqual(view.autonomy.jobs.map(({ id, payload }) => ({ id, payload })), [
    { id: child.id, payload: { candidateId: 'public-receipt-fixture' } },
  ])
  assert.deepEqual(view.home, { activity: 'idle' })
  for (const value of [bound, former, review, secret, job.id, reflection.id, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT]) assert.ok(!JSON.stringify(view).includes(value))
})

test('paired state preserves the game session and hides on-site work receipts and decisions', async t => {
  const { request, store, sessionRoots } = await setup(t)
  const game = 'public-game-session'
  const plan = 'private-camp-plan'
  store.bindContext({ contextId: 'game.minecraft', sessionId: game, kind: 'game', label: '游戏' })
  store.bindContext({ contextId: DAILY_VISIT_CONTEXT, sessionId: plan, kind: 'system', label: '现场决定' })
  sessionRoots.push({ id: game, status: 'idle' }, { id: plan, status: 'idle' })
  store.recordActivity({ contextId: DAILY_VISIT_CONTEXT, source: 'game.minecraft', kind: 'world.visit-supply', summary: secret, data: { receipt: 'private-receipt' } })
  const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: 'autonomy.minecraft-supply', dedupeKey: `visit-supply:${randomUUID()}`,
    runAfter: Date.now(), payload: { visitId: randomUUID(), goal: 'planks', visitSupply: { inventory: 'private-inventory' } } })
  store.recordActivity({ contextId: DAILY_VISIT_CONTEXT, source: 'game.minecraft', kind: 'world.visit-build', summary: secret, data: { receipt: 'private-build-receipt' } })
  const build = store.autonomy.create({ kind: 'minecraft.supply', contextId: 'autonomy.minecraft-supply', dedupeKey: `visit-build:${randomUUID()}`,
    runAfter: Date.now(), payload: { visitId: randomUUID(), goal: 'camp', visitBuild: { inventory: 'private-build-inventory' } } })
  store.recordActivity({ contextId: DAILY_VISIT_CONTEXT, source: 'game.minecraft', kind: 'world.visit-revisit', summary: secret, data: { receipt: 'private-revisit-receipt' } })
  const revisit = store.autonomy.create({ kind: 'minecraft.supply', contextId: 'autonomy.minecraft-supply', dedupeKey: `visit-revisit:${randomUUID()}`,
    runAfter: Date.now(), payload: { visitId: randomUUID(), goal: 'revisit', visitRevisit: { matchedBlocks: 8 }, constructionTaskId: 'private-construction-id' } })
  const view = await (await request('/state')).json()
  assert.deepEqual(view.sessions.map(session => session.id), [game])
  assert.deepEqual(view.bindings.map(binding => binding.contextId), ['game.minecraft'])
  assert.deepEqual(view.autonomy.jobs.find(item => item.id === child.id).payload, { goal: 'planks' })
  assert.deepEqual(view.autonomy.jobs.find(item => item.id === build.id).payload, { goal: 'camp' })
  assert.deepEqual(view.autonomy.jobs.find(item => item.id === revisit.id).payload, { goal: 'revisit' })
  assert.doesNotMatch(JSON.stringify(view), /private-camp-plan|private-construction-id|private-(?:(?:build|revisit)-)?(?:receipt|inventory)|world\.visit-(?:supply|build|revisit)/u)
})

test('paired state hides clip publication bookkeeping and the source understanding session', async t => {
  const { request, store, sessionRoots } = await setup(t)
  const privateSession = 'private-clip-actor'
  store.bindContext({ contextId: BILIBILI_CLIP_CONTEXT, sessionId: privateSession, kind: 'system', label: secret })
  sessionRoots.push({ id: privateSession, status: 'idle' })
  const share = store.autonomy.create({ kind: 'bilibili.share', contextId: BILIBILI_SHARE_CONTEXT, dedupeKey: 'private-clip-share',
    runAfter: Date.now(), payload: { kind: 'clip', candidateId: 'private-clip-candidate' } })
  store.recordActivity({ contextId: BILIBILI_SHARE_CONTEXT, sessionId: privateSession, taskId: share.id, source: 'core.feed',
    kind: 'post.created', summary: '私有分享回执', status: 'success' })
  const view = await (await request('/state')).json()
  for (const value of [privateSession, share.id, secret, 'private-clip-candidate', BILIBILI_CLIP_CONTEXT, BILIBILI_SHARE_CONTEXT]) {
    assert.ok(!JSON.stringify(view).includes(value), value)
  }
})

async function until(matches) {
  for (let index = 0; index < 100; index++) {
    if (matches()) return
    await delay(10)
  }
  assert.fail('Expected a WebSocket event')
}

test('paired state and live Minecraft recovery expose confirmed work without daily authorization metadata', async t => {
  const { request, connect, store } = await setup(t)
  const job = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:fixture-house',
    runAfter: Date.now(), payload: { initiative: { goal: secret } } })
  const child = store.createTask({ contextId: 'game.minecraft', capabilityId: HOUSE_PROJECT_SECTION_CAPABILITY,
    externalId: DAILY_HOUSE_PROJECT_TASK_PREFIX + job.id, title: '自主续建西段' })
  const projectId = randomUUID()
  const zoneId = randomUUID()
  const publicData = { index: 0, built: true, checked: 100, placed: 2, consumed: { spruce_planks: 2 }, recovery: true }
  const { frames } = connect()
  await until(() => frames.some(frame => frame.type === 'stream.replay.complete'))
  const activityId = store.recordActivity({ contextId: 'game.minecraft', taskId: child.id, source: 'game.minecraft',
    kind: 'world.house-project-section', summary: '自主施工第 1 区已核对 100 处位置，本次放置 2 块。',
    status: 'success', data: { ...publicData, dailyTaskId: job.id, projectId, zoneId } })
  await until(() => frames.some(frame => frame.payload.kind === 'world.house-project-section'))
  const state = await (await request('/state')).json()
  const task = state.tasks.find(value => value.id === child.id)
  assert.equal(task.capabilityId, HOUSE_PROJECT_SECTION_CAPABILITY)
  assert.equal(task.externalId, undefined)
  assert.deepEqual(state.activities.find(value => value.id === activityId).data, publicData)
  assert.deepEqual(frames.find(frame => frame.payload.kind === 'world.house-project-section').payload.data, publicData)
  for (const privateValue of [job.id, projectId, zoneId, secret]) {
    assert.ok(!JSON.stringify(state).includes(privateValue))
    assert.ok(!JSON.stringify(frames).includes(privateValue))
  }
  assert.equal(store.taskById(child.id).externalId, DAILY_HOUSE_PROJECT_TASK_PREFIX + job.id)
  assert.deepEqual(store.activityById(activityId).data, { ...publicData, dailyTaskId: job.id, projectId, zoneId })
})

test('Minecraft share text remains visible in paired list, detail and live feed without review IDs', async t => {
  const { request, connect, store, hub } = await setup(t)
  const source = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.dig', title: '已核验采集' })
  store.transitionTask(source.id, 'running')
  store.transitionTask(source.id, 'succeeded')
  const sessionId = 'private-minecraft-share-review'
  store.bindContext({ contextId: MINECRAFT_SHARE_CONTEXT, sessionId, kind: 'system', label: '私有决策' })
  const { frames } = connect()
  await until(() => frames.some(frame => frame.type === 'stream.replay.complete'))
  const body = '核验背包后，今天的木料终于齐了。'
  const post = store.feed.create({ author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, body, sourceTaskId: source.id, sourceSessionId: sessionId })
  hub.postChanged('post.created', post)
  await until(() => frames.some(frame => frame.type === 'post.created'))
  const list = await (await request('/feed')).json()
  const detail = await (await request('/feed/' + post.id)).json()
  const live = frames.find(frame => frame.type === 'post.created')
  for (const projected of [list.items[0], detail, live.payload.post]) {
    assert.equal(projected.body, body)
    assert.equal(projected.sourceSessionId, undefined)
    assert.equal(projected.sourceTaskId, undefined)
  }
  assert.equal(live.sessionId, undefined)
  assert.equal(store.feed.get(post.id).sourceTaskId, source.id)
  assert.equal(store.feed.get(post.id).sourceSessionId, sessionId)
  const view = await (await request('/state')).json()
  assert.ok(!JSON.stringify(view).includes(sessionId))
})

test('paired snapshots, replay and live activity keep camp geometry and memory actors on the host', async t => {
  const { connect, request, store } = await setup(t)
  const actor = 'old-private-decision-session'
  const zone = store.createBuildZone({ name: 'private-camp-zone', dimension: 'minecraft:overworld', x: 34, y: 65, z: -43, radius: 6 })
  const addMemory = summary => store.recordActivity({ contextId: 'game.minecraft', source: 'core.memory', kind: 'memory.created',
    sessionId: actor, summary })
  const replayId = addMemory('可见的经历回执')
  const view = await (await request('/state')).json()
  assert.equal(view.activities.find(activity => activity.id === replayId).sessionId, undefined)
  assert.doesNotMatch(JSON.stringify(view), /old-private-decision-session|private-camp-zone|minecraft:overworld/u)

  const { frames } = connect()
  await until(() => frames.some(frame => frame.type === 'stream.replay.complete'))
  const replay = frames.find(frame => frame.payload.id === replayId)
  assert.ok(replay)
  assert.equal(replay.sessionId, undefined)
  assert.equal(replay.payload.sessionId, undefined)
  store.revokeBuildZone(zone.id)
  const liveId = addMemory('实时经历回执')
  await until(() => frames.some(frame => frame.payload.id === liveId))
  const live = frames.find(frame => frame.payload.id === liveId)
  assert.equal(live.sessionId, undefined)
  assert.equal(live.payload.sessionId, undefined)
  assert.doesNotMatch(JSON.stringify(frames), /old-private-decision-session|private-camp-zone|minecraft:overworld/u)
  assert.equal(store.activityById(liveId).sessionId, actor)
  assert.equal(store.activities().find(activity => activity.kind === 'build-zone.created').data.x, 34)
})

test('paired WebSocket filters decision events on replay and live stream but delivers typed feed posts', async t => {
  const { connect, store, hub } = await setup(t)
  for (const [index, contextId] of privateContexts.entries()) {
    store.bindContext({ contextId, sessionId: 'private-session-' + index, label: 'Decision', kind: 'system' })
    store.recordActivity({ source: 'test', contextId, kind: 'fixture.private', summary: secret })
    const { socket } = connect(contextId)
    const status = await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_req, response) => {
        response.resume()
        resolve(response.statusCode)
      })
      socket.once('error', reject)
    })
    assert.equal(status, 403)
  }
  store.bindContext({ contextId: chat, sessionId: 'paired-session', label: 'Paired', kind: 'chat' })
  store.recordActivity({ source: 'test', contextId: chat, kind: 'fixture.public', summary: '公开回放' })
  const { socket, frames } = connect()
  await until(() => frames.some(frame => frame.type === 'stream.replay.complete'))
  assert.ok(frames.some(frame => frame.payload.summary === '公开回放'))
  for (const [index, contextId] of privateContexts.entries()) {
    socket.send(JSON.stringify({ contextId }))
    await until(() => frames.filter(frame => frame.type === 'message.failed').length === index + 1)
  }
  const chunk = text => ({ type: 'chunk', attemptId: 'fixture', revision: 0, index: 0, chunk: { type: 'text-delta', text } })
  for (const [index, contextId] of privateContexts.entries()) {
    const sessionId = 'private-session-' + index
    hub.assistantStream({ agent: { id: sessionId }, frame: chunk(secret) })
    hub.assistantMessage(sessionId, { type: 'assistant/message', seq: 1, time: Date.now(),
      data: { message: { id: 'private', content: [{ type: 'text', text: secret }] }, turn: 1, step: 0 } })
    store.recordActivity({ source: 'test', contextId, kind: 'fixture.private', summary: secret })
  }
  hub.assistantStream({ agent: { id: 'paired-session' }, frame: chunk('公开流式回复') })
  const bilibiliSource = { bvid: 'BV1dLx46TEhw', part: 1, startSeconds: 5 }
  hub.postChanged('post.created', {
    id: randomUUID(), author: 'companion', contextId: BILIBILI_SHARE_CONTEXT, body: '我想回头再看看。',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), replyCount: 0, bilibiliSource,
    sourceSessionId: 'private-clip-source-session', sourceTaskId: 'private-clip-source-task',
  })
  store.recordActivity({ source: 'test', contextId: chat, kind: 'fixture.public', summary: '公开实时活动' })
  await until(() => frames.some(frame => frame.payload.summary === '公开实时活动'))
  assert.ok(frames.some(frame => frame.payload.text === '公开流式回复'))
  assert.deepEqual(frames.find(frame => frame.type === 'post.created').payload.post.bilibiliSource, bilibiliSource)
  assert.doesNotMatch(JSON.stringify(frames), /private-clip-source/u)
  assert.doesNotMatch(JSON.stringify(frames), new RegExp(secret, 'u'))
  assert.ok(!frames.some(frame => frame.type !== 'post.created' && privateContexts.includes(frame.contextId)))
})
