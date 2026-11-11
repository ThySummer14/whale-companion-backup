import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { DAILY_REFLECTION_CONTEXT } from '../src/core/model.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { registerHttp } from '../src/host/http.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'
import { registerAvatarHttp } from '../src/host/avatar-http.ts'

const STAGE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

test('existing management and paired-device routes expose the same bounded home snapshot', async t => {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/home-http-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const routes = new Map()
  const agent = { id: 'home-chat-test', status: 'idle' }
  let origin
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent] },
    webServer: {
      host: '127.0.0.1', getOrigin: () => origin,
      register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
  }
  const media = join(directory, 'media')
  const options = { provider: 'piper', pythonPath: '/unavailable/python', modelPath: '/unavailable/model', mediaDir: join(media, 'voice'), timeoutMs: 5000 }
  const runtime = new CompanionRuntime(ctx, store, 'test', options, media, directory, directory, directory, 'owner')
  for (const [path, contents] of Object.entries({
    'model/大肥鱼.model3.json': '{}', 'model/大肥鱼.moc3': '', 'model/大肥鱼.physics3.json': '{}', 'model/Exp3/脸红.exp3.json': '{}',
    'model/Animation/竖手指切出来动画.motion3.json': '{"Meta":{"Duration":1.5}}', 'data/model-profile.json': '{}',
    'vendor/live2dcubismcore.min.js': '', 'lib/avatar/index.html': '',
  })) {
    const file = join(directory, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  runtime.avatar.start()
  const devices = new DeviceService(ctx, store)
  const server = createServer((req, res) => {
    const route = [...routes.keys()].findLast(path => req.url.startsWith(`${path}/`))
    if (route) routes.get(route)(req, res)
    else res.writeHead(404).end()
  })
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    devices.close()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  registerHttp(ctx, runtime)
  registerDeviceHttp(ctx, runtime, devices)
  registerAvatarHttp(ctx, runtime.avatar, runtime.realtimeVoice, () => runtime.homeActivity())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const device = devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const request = (path, headers) => fetch(`${origin}${path}`, { headers })
  const management = '/companion/api/state'
  const mobile = '/companion-device/api/state'
  const managementHeaders = { 'x-companion-request': '1' }
  const mobileHeaders = { authorization: device.credential }
  assert.equal((await request(management)).status, 403)
  assert.equal((await request(management, { ...managementHeaders, origin: 'https://example.invalid' })).status, 403)
  assert.equal((await request(mobile)).status, 401)
  const offlineResponse = await request(management, managementHeaders)
  const offlineBody = await offlineResponse.json()
  assert.equal(offlineResponse.status, 200, offlineBody.error)
  const offline = offlineBody.home
  assert.equal(offline.activity, 'offline')
  assert.equal(offline.anchor, 'none')
  assert.deepEqual(offlineBody.community, { version: 1, activeSite: null, recentCamp: [] })
  assert.deepEqual(offlineBody.community, { version: 1, activeSite: null, recentCamp: [] })

  store.bindContext({ contextId: 'chat.main', kind: 'chat', label: 'Chat', sessionId: agent.id })
  store.bilibili.add({ bvid: 'BV1dLx46TEhw', part: 1 }, 'owner-only-label')
  const collection = store.bilibili.addSource({ mid: '7380321', seasonId: '678635', label: 'owner-only-collection' })
  const subtitleDigest = 'e'.repeat(64)
  store.bilibiliSubtitles.save({ bvid: 'BV1dLx46TEhw', part: 1, cid: 80, format: 'vtt', sha256: subtitleDigest, cueCount: 1,
    excerpt: { status: 'excerpt', language: 'und', cues: [{ from: 0, to: 1, text: 'owner-only-subtitle-text' }], truncated: false,
      provenance: { kind: 'owner-supplied', sha256: subtitleDigest } } })
  agent.status = 'running'
  const userPost = runtime.publishPost({ author: 'user', body: 'user-private-text' })
  for (let i = 0; i < 6; i++) runtime.publishPost({ author: 'companion', body: `private-text-${i}` })
  runtime.publishPost({ author: 'companion', body: 'private-reply', parentId: userPost.id })

  const responses = await Promise.all([request(management, managementHeaders), request(mobile, mobileHeaders)])
  const states = await Promise.all(responses.map(async response => {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const state = await response.json()
    assert.equal(state.schemaVersion, 2)
    assert.equal(state.pluginVersion, 'test')
    assert.equal(state.presence, 'running')
    assert.equal(state.home.version, 1)
    assert.equal(state.home.activity, 'chatting')
    assert.equal(state.home.anchor, 'sofa')
    assert.equal(state.home.observedAt, state.generatedAt)
    assert.deepEqual(state.community, { version: 1, activeSite: 'home', recentCamp: [] })
    assert.deepEqual(state.bilibiliConversation, { contextId: 'world.bilibili', version: 1, maxClipSeconds: 12 })
    assert.deepEqual(state.home.recent.map(event => event.kind), ['reply', 'post', 'post', 'post'])
    for (const event of state.home.recent) {
      assert.deepEqual(Object.keys(event).sort(), ['at', 'kind'])
      assert.ok(Number.isFinite(Date.parse(event.at)))
    }
    assert.doesNotMatch(JSON.stringify(state.home), /private|home-chat-test/u)
    return state
  }))
  assert.deepEqual(states[0].home.recent, states[1].home.recent)
  assert.deepEqual(states[0].community, { version: 1, activeSite: 'home', recentCamp: [] })
  assert.deepEqual(states[0].community, states[1].community)
  assert.deepEqual(states[0].community, states[1].community)
  assert.equal(states[0].bilibiliQueue.items[0].label, 'owner-only-label')
  assert.equal(states[0].bilibiliQueue.sources[0].id, collection.id)
  assert.equal(states[0].bilibiliSubtitles[0].sha256, subtitleDigest)
  assert.doesNotMatch(JSON.stringify(states[0]), /owner-only-subtitle-text/u)
  assert.equal(states[1].bilibiliQueue, undefined)
  assert.equal(states[1].bilibiliSubtitles, undefined)
  assert.doesNotMatch(JSON.stringify(states[1]), /owner-only-collection|7380321|678635/u)
  assert.equal((await fetch(`${origin}/companion/api/bilibili/sources/${collection.id}`, {
    method: 'DELETE', headers: mobileHeaders,
  })).status, 403)

  const stageApi = '/companion/avatar/api'
  const mutate = (path, data, method = 'POST', headers = managementHeaders) => fetch(`${origin}${path}`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  assert.equal((await mutate('/companion/api/events', { source: 'core.self-note', contextId: DAILY_REFLECTION_CONTEXT,
    kind: 'self-note.created', summary: 'forged revision', status: 'success', data: { journalRevision: true } })).status, 403)
  const readStates = async () => Promise.all([request(management, managementHeaders), request(mobile, mobileHeaders)]
    .map(async response => (await response).json()))
  const reflectionAt = new Date(Date.now() - 1_000).toISOString()
  const activeReflection = t.mock.method(runtime.autonomy, 'homeReflection', () => reflectionAt)
  for (const state of await readStates()) assert.equal(state.home.journal, undefined)
  runtime.autonomy.updateSettings({ quietStart: '00:00', quietEnd: '00:00' })
  agent.status = 'idle'
  for (const state of await readStates()) {
    assert.deepEqual(state.home.journal, { state: 'reflecting', at: reflectionAt })
    assert.equal(state.home.activity, 'idle')
    assert.equal(state.home.anchor, 'window')
  }
  activeReflection.mock.restore()
  for (const state of await readStates()) assert.equal(state.home.journal, undefined)

  const noteId = randomUUID()
  const supersedes = randomUUID()
  const revisedAt = new Date(Date.now() - 30_000).toISOString()
  const sourceRefs = [{ contextId: DAILY_REFLECTION_CONTEXT, sessionId: 'private-journal-actor' }]
  const db = new DatabaseSync(join(directory, 'store.sqlite'))
  try {
    db.prepare(`INSERT INTO self_note (id,content,basis,status,confidence,evidence_json,counter_evidence_json,source_refs_json,
      authorship_json,created_by,created_at,updated_at) VALUES (?,?, 'inference','active',0.6,'[]','[]',?,?,'companion',?,?)`).run(
      noteId, 'private-journal-content', JSON.stringify(sourceRefs),
      JSON.stringify({ supersedes, experienceReceipt: { at: revisedAt, fact: 'private-source-fact' }, revisionReason: 'private-revision-reason' }),
      revisedAt, revisedAt)
  } finally { db.close() }
  const revision = { source: 'core.self-note', contextId: DAILY_REFLECTION_CONTEXT, sessionId: sourceRefs[0].sessionId, kind: 'self-note.created',
    status: 'success', occurredAt: revisedAt, summary: 'private-journal-summary', data: { noteId, supersedes, journalRevision: true, trait: 'private-journal-trait' } }
  for (const update of [{ sessionId: 'other-private-actor' }, { status: 'info' }, { contextId: 'game.minecraft' },
    { data: { ...revision.data, journalRevision: 'true' } }, { data: { ...revision.data, supersedes: randomUUID() } }]) {
    store.recordActivity({ ...revision, ...update })
  }
  for (const state of await readStates()) assert.equal(state.home.journal, undefined)
  store.recordActivity(revision)
  for (let index = 0; index < 105; index++) store.recordActivity({ source: 'core.runtime', kind: 'noise', summary: 'unrelated activity' })
  for (const state of await readStates()) {
    assert.deepEqual(state.home.journal, { state: 'revised', at: revisedAt })
    assert.equal(state.home.anchor, 'window')
    for (const secret of [noteId, supersedes, 'private-journal']) assert.ok(!JSON.stringify(state.home).includes(secret))
  }
  agent.status = 'running'
  const heartbeat = (stageId, overrides = {}, headers) => mutate(`${stageApi}/heartbeat`, {
    stageId, ready: true, frames: 20, nonFinite: 0, actionReady: true, ...overrides,
  }, 'POST', headers)
  const action = (id, stageId) => mutate(`${stageApi}/actions`, { action: id, stageId })
  assert.deepEqual(await (await request('/companion/api/presenter', managementHeaders)).json(), { running: false })
  assert.equal((await mutate('/companion/api/presenter/start', {}, 'POST', mobileHeaders)).status, 403)
  assert.deepEqual(await (await mutate('/companion/api/presenter/stop', {})).json(), { running: false })
  assert.equal((await heartbeat(STAGE, {}, mobileHeaders)).status, 403)
  assert.equal((await (await heartbeat(STAGE, { frames: 0 })).json()).homeActivity, undefined)
  assert.equal((await (await heartbeat(STAGE, { actionReady: false })).json()).homeActivity, undefined)
  assert.equal((await action('nod', STAGE)).status, 409)
  const stage = await (await heartbeat(STAGE, { homeActivity: 'singing' })).json()
  assert.equal(stage.homeActivity, states[0].home.activity)
  assert.deepEqual(stage.actions.map(item => item.id), ['blush', 'point', 'nod', 'shake'])
  assert.doesNotMatch(JSON.stringify(stage), /private-text|home-chat-test/u)
  assert.equal((await (await heartbeat(OTHER)).json()).homeActivity, 'chatting')
  const started = await action('nod', STAGE)
  assert.equal(started.status, 202)
  const { taskId } = await started.json()
  assert.equal((await (await heartbeat(OTHER)).json()).pendingActions.length, 0)
  assert.deepEqual((await (await heartbeat(STAGE)).json()).pendingActions.map(item => item.taskId), [taskId])
  assert.equal((await mutate(`/companion/api/tasks/${taskId}`, { status: 'succeeded' }, 'PATCH')).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'media.avatar', kind: 'avatar.action.completed', summary: '未播放' })).status, 403)
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'minecraft.survey', contextId: 'game.minecraft', title: '伪造勘察' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'minecraft.survey', contextId: 'game.minecraft', kind: 'task.succeeded', status: 'success', summary: '伪造返回' })).status, 403)
  const surveyWindow = '/companion/api/minecraft/survey-window'
  const zone = store.createBuildZone({ name: '营地时段验收', dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, radius: 6 })
  const houses = '/companion/api/minecraft/houses'
  const draft = store.minecraftHouses.create({ name: '试验小屋', layout: { width: 1, height: 1, depth: 1, blocks: 'o' } },
    { sessionId: agent.id, messageId: 'fixture-house' })
  assert.equal((await request(houses, mobileHeaders)).status, 403)
  assert.equal((await request('/companion-device/api/minecraft/houses', mobileHeaders)).status, 404)
  assert.deepEqual(await (await request(houses, managementHeaders)).json(), { drafts: [draft], available: false, revisionsAvailable: true })
  assert.equal((await mutate(`${houses}/${draft.id}/build`, { zoneId: zone.id })).status, 400)
  assert.equal((await mutate(`${houses}/${draft.id}/preview`, { zoneId: zone.id, layout: draft.layout })).status, 400)
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'minecraft.house', contextId: 'game.minecraft', title: '伪造小屋' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.house-built', summary: '伪造小屋' })).status, 403)
  const schedule = { zoneId: zone.id, start: '07:00', end: '08:00', days: 2 }
  assert.equal((await request(surveyWindow)).status, 403)
  assert.equal((await request('/companion-device/api/minecraft/survey-window', mobileHeaders)).status, 404)
  const scheduleCapabilities = { version: 1, rule: null, dailyChoiceAvailable: true, campVisitAvailable: true,
    campVisitSupplyAvailable: true, campVisitBuildAvailable: true, campVisitProjectAvailable: true, campVisitProjectGatherAvailable: true,
    campPatrolAvailable: true, campGatherAvailable: true }
  assert.deepEqual(await (await request(surveyWindow, managementHeaders)).json(), scheduleCapabilities)
  assert.equal((await mutate(surveyWindow, schedule, 'PUT', mobileHeaders)).status, 403)
  assert.equal((await mutate(surveyWindow, { ...schedule, end: '23:59' }, 'PUT')).status, 400)
  assert.equal((await mutate(surveyWindow, { ...schedule, goal: 'camp' }, 'PUT')).status, 400)
  const allowedWindow = await mutate(surveyWindow, schedule, 'PUT')
  assert.equal(allowedWindow.status, 200)
  assert.equal((await allowedWindow.json()).rule.zoneId, zone.id)
  assert.equal((await mutate(surveyWindow, schedule, 'PUT')).status, 409)
  const reserved = 'autonomy:minecraft.supply:survey-window:2026-11-09'
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'core.autonomy', title: '伪造窗口任务', externalId: reserved })).status, 403)
  for (const [kind, contextId, dedupeKey] of [
    ['daily.choice', 'autonomy.daily', 'daily:2026-11-09'],
    ['bilibili.review', 'autonomy.bilibili', 'daily:2026-11-10'],
  ]) {
    const externalId = `autonomy:${kind}:${dedupeKey}`
    assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'core.autonomy', title: '伪造日常任务', externalId })).status, 403)
    const realTask = store.autonomy.create({ kind, contextId, dedupeKey, runAfter: Date.now() })
    assert.equal((await mutate(`/companion/api/tasks/${realTask.id}`, { status: 'running' }, 'PATCH')).status, 403)
  }
  assert.equal((await mutate('/companion/api/events', { source: 'core.autonomy', kind: 'survey-window.authorized', summary: '伪造时段' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'core.autonomy', contextId: 'autonomy.daily', kind: 'task.succeeded', summary: '伪造今日活动' })).status, 403)
  const visitExternalId = 'minecraft-visit-survey:5fb63313-5c45-4adf-aea2-b42c10fa11d1'
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'core.autonomy', title: '伪造短访勘察', externalId: visitExternalId })).status, 403)
  for (const prefix of ['minecraft-visit-supply:', 'autonomy:minecraft.supply:visit-supply:', 'minecraft-visit-build:',
    'autonomy:minecraft.supply:visit-build:', 'minecraft-visit-revisit:', 'autonomy:minecraft.supply:visit-revisit:']) {
    const externalId = `${prefix}5fb63313-5c45-4adf-aea2-b42c10fa11d1`
    assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'core.autonomy', title: '伪造短访任务', externalId })).status, 403)
  }
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.visit-offline', summary: '伪造下线' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'autonomy.daily-visit', kind: 'world.visit-supply', summary: '伪造补给' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.visit-build', summary: '伪造施工回执' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.visit-revisit', summary: '伪造复访回执' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.patrol-segment', summary: '伪造巡视回执' })).status, 403)
  assert.equal((await mutate('/companion/api/events', { source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.visit-gather', summary: '伪造采集回执' })).status, 403)
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'minecraft.survey', contextId: 'game.minecraft', title: '伪造巡视',
    externalId: 'minecraft-visit-patrol:5fb63313-5c45-4adf-aea2-b42c10fa11d1:1' })).status, 403)
  assert.deepEqual(await (await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).json(), scheduleCapabilities)
  assert.equal((await mutate(surveyWindow, { ...schedule, allowMinecraftSupply: true }, 'PUT')).status, 400)
  const visitWindow = await mutate(surveyWindow, { ...schedule, allowMinecraftLogin: true, allowMinecraftSupply: true }, 'PUT')
  assert.equal(visitWindow.status, 200)
  const visitRule = (await visitWindow.json()).rule
  assert.equal(visitRule.allowMinecraftLogin, true)
  assert.equal(visitRule.allowMinecraftSupply, true)
  assert.equal(visitRule.allowMinecraftBuild, undefined)
  assert.equal(visitRule.allowBilibili, undefined)
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  assert.equal((await mutate(surveyWindow, { ...schedule, allowMinecraftBuild: true }, 'PUT')).status, 400)
  const buildWindow = await mutate(surveyWindow, { ...schedule, allowMinecraftLogin: true, allowMinecraftBuild: true }, 'PUT')
  assert.equal(buildWindow.status, 200)
  const buildRule = (await buildWindow.json()).rule
  assert.equal(buildRule.allowMinecraftBuild, true)
  assert.equal(buildRule.allowMinecraftSupply, undefined)
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  const projectGrant = { ...schedule, allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true, allowMinecraftProject: true }
  assert.equal((await mutate(surveyWindow, { ...projectGrant, allowMinecraftSupply: undefined }, 'PUT')).status, 400)
  const projectWindow = await mutate(surveyWindow, projectGrant, 'PUT')
  assert.equal(projectWindow.status, 200)
  assert.deepEqual((await projectWindow.json()).project, { stage: 'gathering', supplyVisits: 0 })
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  assert.equal((await mutate(surveyWindow, { ...schedule, allowMinecraftPatrol: true }, 'PUT')).status, 400)
  const patrolWindow = await mutate(surveyWindow, { ...projectGrant, allowMinecraftPatrol: true }, 'PUT')
  assert.equal(patrolWindow.status, 200)
  const patrolGrant = (await patrolWindow.json()).rule
  assert.equal(patrolGrant.allowMinecraftPatrol, true)
  assert.equal(patrolGrant.allowMinecraftProject, true)
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  assert.equal((await mutate(surveyWindow, { ...schedule, allowMinecraftGather: true }, 'PUT')).status, 400)
  const gatherWindow = await mutate(surveyWindow, { ...projectGrant, allowMinecraftPatrol: true, allowMinecraftGather: true }, 'PUT')
  assert.equal(gatherWindow.status, 200)
  const gatherGrant = (await gatherWindow.json()).rule
  assert.equal(gatherGrant.allowMinecraftGather, true)
  assert.equal(gatherGrant.allowMinecraftPatrol, true)
  assert.equal(gatherGrant.allowMinecraftProject, true)
  assert.equal(gatherGrant.allowMinecraftProjectGather, undefined)
  assert.deepEqual((await (await request(surveyWindow, managementHeaders)).json()).project, { stage: 'gathering', supplyVisits: 0 })
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  const projectGather = { ...projectGrant, allowMinecraftGather: true, allowMinecraftProjectGather: true }
  assert.equal((await mutate(surveyWindow, { ...projectGather, allowMinecraftGather: undefined }, 'PUT')).status, 400)
  assert.equal((await mutate(surveyWindow, { ...projectGather, allowMinecraftProject: undefined }, 'PUT')).status, 400)
  const projectGatherWindow = await mutate(surveyWindow, projectGather, 'PUT')
  assert.equal(projectGatherWindow.status, 200)
  const projectGatherView = await projectGatherWindow.json()
  assert.equal(projectGatherView.rule.allowMinecraftProjectGather, true)
  assert.deepEqual(projectGatherView.project, { stage: 'gathering', supplyVisits: 0, gatheredLogs: 0 })
  const pairedProject = (await (await request(mobile, mobileHeaders)).json()).community.campProject
  assert.deepEqual(pairedProject, { ...projectGatherView.project, availability: 'active' })
  assert.equal((await fetch(`${origin}${surveyWindow}`, { headers: managementHeaders, method: 'DELETE' })).status, 200)
  const dailyWindow = await mutate(surveyWindow, { ...schedule, allowBilibili: true }, 'PUT')
  assert.equal(dailyWindow.status, 200)
  assert.equal((await dailyWindow.json()).rule.allowBilibili, true)
  const fabricated = await mutate('/companion/api/events', {
    source: 'game.minecraft', contextId: 'game.minecraft', kind: 'world.action', status: 'success',
    summary: '未经游戏回执的地理信息', data: { surveyOutcome: 'completed', surveyTrail: 'east-south', surveyCheckpoints: 2 },
  })
  assert.equal(fabricated.status, 201)
  assert.deepEqual((await (await request(mobile, mobileHeaders)).json()).community.recentCamp, [])
  assert.equal(states[0].autonomy.settings.idleCompactionEnabled, false)
  const enableCompaction = await mutate('/companion/api/autonomy', { idleCompactionEnabled: true }, 'PUT')
  assert.equal(enableCompaction.status, 200)
  assert.equal((await enableCompaction.json()).settings.idleCompactionEnabled, true)
  assert.equal((await mutate('/companion/api/tasks', { capabilityId: 'core.context.compaction', title: '伪造压缩' })).status, 403)
  for (const [source, kind] of [['core.context.compaction', 'session.compaction.completed'], ['core.memory', 'memory.reviewed']]) {
    assert.equal((await mutate('/companion/api/events', { source, kind, summary: '伪造完成' })).status, 403)
  }
  const receipt = (status, frames, stageId = STAGE) => mutate(`${stageApi}/receipt`, { taskId, status, frames, stageId })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  assert.deepEqual(runtime.avatar.presenterFrame(now, false), { available: true })
  assert.equal((await receipt('playing', 20, OTHER)).status, 409)
  assert.equal((await receipt('completed', 30)).status, 409)
  assert.equal((await receipt('playing', 20)).status, 200)
  await heartbeat(STAGE, { voice: { playing: true, energy: 0.38, positionMs: 100, audioContextState: 'running' } })
  assert.deepEqual(runtime.avatar.presenterFrame(now, false), { available: true, action: { id: 'nod', startedAt: now, elapsedMs: 0 } })
  assert.equal(runtime.avatar.presenterFrame(now, true).voiceEnergy, 0.38)
  assert.deepEqual(runtime.avatar.presenterFrame(now + 1500, true), { available: true })
  assert.equal(store.taskById(taskId).status, 'running')
  assert.equal((await receipt('completed', 30)).status, 409)
  now += 1200
  assert.equal((await receipt('completed', 20)).status, 409)
  assert.equal((await receipt('completed', 31)).status, 200)
  assert.equal(runtime.avatar.presenterFrame(now, false).action, undefined)
  assert.equal(store.taskById(taskId).status, 'succeeded')
  assert.equal(store.activities().filter(item => item.kind === 'avatar.action.completed').length, 1)
  const shake = await (await action('shake', OTHER)).json()
  assert.ok(shake.taskId)
  await heartbeat(OTHER, { actionReady: false })
  assert.equal(store.taskById(shake.taskId).status, 'cancelled')

  const queuePath = '/companion/api/bilibili/queue'
  const body = JSON.stringify({ video: 'https://www.bilibili.com/video/BV1dLx46TEhw/?p=2', label: 'second part' })
  const add = headers => fetch(`${origin}${queuePath}`, { method: 'POST', headers, body })
  assert.equal((await add(mobileHeaders)).status, 403)
  assert.equal((await request('/companion-device/api/bilibili/queue', mobileHeaders)).status, 404)
  const added = await add({ ...managementHeaders, 'content-type': 'application/json' })
  assert.equal(added.status, 201)
  const candidate = (await added.json()).items.find(item => item.part === 2)
  assert.equal(candidate.status, 'queued')
  const removed = await fetch(`${origin}${queuePath}/${candidate.id}`, { method: 'DELETE', headers: managementHeaders })
  assert.equal(removed.status, 200)
  const queue = await (await request(queuePath, managementHeaders)).json()
  assert.equal(queue.items.find(item => item.id === candidate.id).status, 'cancelled')

  const mobileHealth = await request('/companion-device/api/health', mobileHeaders)
  assert.deepEqual(await mobileHealth.json(), { ok: true, schemaVersion: 2, pluginVersion: 'test', deviceId: device.device.id,
    feedPublish: { version: 1, maxImageBytes: 10 * 1024 * 1024 } })
  devices.revoke(device.device.id)
  assert.equal((await request(mobile, mobileHeaders)).status, 401)
})
