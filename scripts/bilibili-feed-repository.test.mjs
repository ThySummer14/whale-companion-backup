import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_SHARE_CONTEXT, BILIBILI_SHARE_TTL_MS, DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { companionToolPolicy, isCompanionDecisionContext, restrictCompanionTools } from '../src/host/tool-policy.ts'

const NOW = Date.parse('2026-11-09T04:00:00.000Z')
const VIDEO = 'BV1234567891'
const SESSION = 'bilibili-share-session'
const SHA256 = 'a'.repeat(64)
const SHARE = { body: '我想再看看影子随着光线变化的样子。', author: 'companion', contextId: BILIBILI_SHARE_CONTEXT, sourceSessionId: SESSION }

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'bili-feed-repository-'))
  const path = join(directory, 'companion.db')
  let store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.bindContext({ contextId: BILIBILI_SHARE_CONTEXT, sessionId: SESSION, kind: 'system', label: 'B 站阅读分享' })
  return {
    get store() { return store },
    reopen() { store.close(); store = new CompanionStore(path) },
    path,
  }
}

function readVideo(store, options = {}) {
  const { part = 2, collection = false, local = false, subtitle = true } = options
  let source
  let candidate
  if (collection) {
    source = store.bilibili.addSource({ mid: '12345', seasonId: '12345' })
    assert.equal(store.bilibili.claimDiscovery(Date.now()).id, source.id)
    assert.equal(store.bilibili.finishDiscovery(source.id, Date.now(), { items: [{ bvid: VIDEO, title: '收藏来源' }] }), 1)
    candidate = store.bilibili.view().items[0]
  } else candidate = store.bilibili.add({ bvid: VIDEO, part })
  const provenance = local ? { kind: 'owner-supplied', sha256: SHA256 } : undefined
  if (local) {
    assert.ok(store.bilibiliSubtitles.save({
      bvid: VIDEO, part, cid: 1, format: 'srt', sha256: SHA256, cueCount: 1,
      excerpt: { status: 'excerpt', cues: [{ from: 5, to: 7, text: '不应进入动态投影。' }], language: 'zh-CN', truncated: false, provenance },
    }))
  }
  assert.equal(store.bilibili.begin(candidate.id), true)
  const readAt = new Date().toISOString()
  const kind = subtitle ? 'video.subtitle-read' : 'video.inspected'
  const activityId = store.recordActivity({
    contextId: BILIBILI_AUTONOMY_CONTEXT, source: 'media.bilibili', sessionId: 'bilibili-reading-session',
    status: 'success', kind, summary: '阅读完成', occurredAt: readAt,
    data: { bvid: candidate.bvid, part: candidate.part, candidateId: candidate.id,
      ...(local && { subtitleOrigin: 'owner-supplied', subtitleSha256: SHA256 }) },
  })
  assert.equal(store.bilibili.finish(candidate.id, { status: 'read', receipt: { activityId, at: readAt, kind, provenance } }), true)
  const read = store.autonomy.create({
    kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT, dedupeKey: `fixture:${candidate.id}`,
    runAfter: Date.now(), payload: { candidateId: candidate.id, activityId },
  })
  store.transitionTask(read.id, 'running')
  store.transitionTask(read.id, 'succeeded')
  return {
    source,
    snapshot: { candidateId: candidate.id, bvid: candidate.bvid, part: candidate.part, readTaskId: read.id, readAt, activityId, startSeconds: 5 },
  }
}

function makeShare(store, payload, { dedupeKey = `bili-share:${payload.bvid}:${payload.part}`, running = true } = {}) {
  const job = store.autonomy.create({
    kind: 'bilibili.share', contextId: BILIBILI_SHARE_CONTEXT, dedupeKey, runAfter: Date.now(), payload,
  })
  if (running) store.transitionTask(job.id, 'running')
  return job
}

test('a clip feed write requires its own completed clip task, exact current session, and active permission', async t => {
  for (const mismatch of ['valid', 'disabled', 'wrong timestamp', 'wrong task', 'another session', 'wrong time point', 'different video',
    'wrong activity', 'deleted source', 'wrong modalities', 'unsafe reaction', 'unfinished read']) await t.test(mismatch, t => {
    const { store } = fixture(t)
    const collection = store.bilibili.addSource({ mid: '12345', seasonId: '12345' })
    assert.equal(store.bilibili.claimDiscovery(Date.now()).id, collection.id)
    store.bilibili.finishDiscovery(collection.id, Date.now(), { items: [{ bvid: VIDEO, title: 'Authorized clip' }] })
    const candidate = store.bilibili.view().items[0]
    const read = store.autonomy.create({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT, dedupeKey: candidate.id,
      runAfter: Date.now(), payload: { candidateId: candidate.id } })
    store.transitionTask(read.id, 'running')
    assert.equal(store.bilibili.beginClip(candidate.id, Date.now() + 60_000), true)
    const clip = { start: 12, seconds: 6, visual: true, audio: false }
    const readAt = new Date().toISOString()
    const readSession = 'isolated-real-clip'
    const activityId = store.recordActivity({ contextId: BILIBILI_CLIP_CONTEXT, source: 'media.bilibili', sessionId: readSession, taskId: read.id,
      status: 'success', kind: 'video.clip-sampled', summary: 'verified', occurredAt: readAt,
      data: { candidateId: candidate.id, bvid: candidate.bvid, part: candidate.part, ...clip } })
    assert.ok(store.bilibili.finish(candidate.id, { status: 'read', receipt: { kind: 'video.clip-sampled', activityId, at: readAt, clip } }))
    store.autonomy.update(read.id, { payload: { ...read.payload, activityId } })
    if (mismatch !== 'unfinished read') store.transitionTask(read.id, 'succeeded')
    store.bindContext({ contextId: BILIBILI_CLIP_CONTEXT, kind: 'system', label: 'Clip', sessionId: mismatch === 'another session' ? 'new-system-session' : readSession })
    store.autonomy.saveSettings({ ...store.autonomy.settings(), feedEnabled: true, bilibiliEnabled: true, bilibiliClipsEnabled: true,
      bilibiliClipShareEnabled: mismatch !== 'disabled' })
    const snapshot = { kind: 'clip', candidateId: candidate.id, bvid: candidate.bvid, part: candidate.part, activityId, readTaskId: read.id,
      readAt, startSeconds: clip.start,
      ...(mismatch === 'wrong timestamp' && { readAt: new Date(NOW - 500).toISOString() }),
      ...(mismatch === 'wrong task' && { readTaskId: '0a6189c1-137a-49c1-a55d-fbd1df66984' }),
      ...(mismatch === 'wrong activity' && { activityId: activityId + 1 }),
      ...(mismatch === 'wrong time point' && { startSeconds: clip.start + 1 }),
      ...(mismatch === 'different video' && { bvid: 'BV1dLx46TEhw' }) }
    const job = makeShare(store, snapshot)
    if (mismatch === 'deleted source') assert.ok(store.bilibili.revokeSource(collection.id))
    const body = (mismatch === 'wrong modalities' ? '我听了一小段 B 站视频的声音。' : '我抽样看了一小段 B 站视频的画面。') +
      (mismatch === 'unsafe reaction' ? '我想看看 https://example.com 这个网站。' : SHARE.body)
    const write = () => store.feed.create({ ...SHARE, sourceTaskId: job.id, sourceSessionId: readSession, body })
    if (mismatch === 'valid') {
      assert.deepEqual(write().bilibiliSource, { bvid: VIDEO, part: 1, startSeconds: 12 })
      assert.throws(write, /already shared/u)
    } else {
      assert.throws(write, /Bilibili (?:share|clip share)/u)
      assert.equal(store.feed.list().items.length, 0)
    }
  })
})

test('verified subtitle reading projects only a stable public card and survives deletion and restart', t => {
  const h = fixture(t)
  const { store, path } = h
  const { snapshot } = readVideo(store)
  const job = makeShare(store, snapshot)
  assert.equal(store.autonomy.settings().bilibiliShareEnabled, false)
  const post = store.feed.create({ ...SHARE, sourceTaskId: job.id })
  const publicCard = { bvid: VIDEO, part: 2, startSeconds: 5 }
  assert.deepEqual(post.bilibiliSource, publicCard)
  assert.deepEqual(store.feed.get(post.id).bilibiliSource, publicCard)
  assert.deepEqual(store.feed.list().items[0].bilibiliSource, publicCard)
  assert.deepEqual(store.feed.bySourceTask(job.id).bilibiliSource, publicCard)
  for (const field of ['candidateId', 'readTaskId', 'activityId', 'readAt', 'cues']) {
    assert.equal(Object.hasOwn(post, field), false)
  }
  assert.throws(() => store.feed.create({ ...SHARE, sourceTaskId: job.id }), /already shared/u)
  store.transitionTask(job.id, 'succeeded')
  h.reopen()
  assert.deepEqual(h.store.feed.list().items[0].bilibiliSource, publicCard)
  const deleted = h.store.feed.delete(post.id, 'companion')
  assert.deepEqual(deleted.bilibiliSource, publicCard)
  assert.deepEqual(h.store.feed.list().items, [])
  assert.equal(h.store.feed.bySourceTask(job.id).deletedAt, deleted.deletedAt)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 43)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('reserved context only accepts live bound companion root shares and refuses forged source fields', t => {
  const { store } = fixture(t)
  const { snapshot } = readVideo(store)
  const job = makeShare(store, snapshot, { running: false })
  const input = { ...SHARE, sourceTaskId: job.id }
  const user = store.feed.create({ body: '真实动态', author: 'user' })
  for (const patch of [{ sourceTaskId: undefined }, { author: 'user' }, { parentId: user.id }, { mediaId: 'media' }]) {
    assert.throws(() => store.feed.create({ ...input, ...patch }), /authorized top-level text post/u)
  }
  assert.throws(() => store.feed.create({ ...input, contextId: 'chat.mobile' }), /Only an autonomous Minecraft post/u)
  assert.throws(() => store.feed.create(input), /source job is missing or invalid/u)
  store.transitionTask(job.id, 'running')
  assert.throws(() => store.feed.create({ ...input, sourceSessionId: 'forged' }), /source job is missing or invalid/u)
  store.bindContext({ contextId: BILIBILI_SHARE_CONTEXT, sessionId: SESSION, kind: 'topic', label: 'untrusted bind' })
  assert.throws(() => store.feed.create(input), /source job is missing or invalid/u)
  store.bindContext({ contextId: BILIBILI_SHARE_CONTEXT, sessionId: SESSION, kind: 'system', label: 'decision' })
  for (const patch of [{ startSeconds: -1 }, { startSeconds: 0.5 }, { startSeconds: 604_801 }, { bvid: 'https://bad.example/' }, { cues: [] }]) {
    store.autonomy.update(job.id, { payload: { ...snapshot, ...patch } })
    assert.throws(() => store.feed.create(input), /source job is missing or invalid/u)
  }
  for (const patch of [{ activityId: snapshot.activityId + 1 }, { readTaskId: job.id }, { readAt: new Date(NOW - 1000).toISOString() }]) {
    store.autonomy.update(job.id, { payload: { ...snapshot, ...patch } })
    assert.throws(() => store.feed.create(input), /lacks an eligible subtitle reading receipt/u)
  }
  store.autonomy.update(job.id, { payload: snapshot })
  t.mock.timers.tick(BILIBILI_SHARE_TTL_MS)
  assert.throws(() => store.feed.create(input), /source job is missing or invalid/u)
  assert.deepEqual(store.feed.list().items.map(row => row.id), [user.id])
})

test('metadata-only readings, revoked collections, and removed local subtitles cannot authorize shares', t => {
  const { store } = fixture(t)
  const { snapshot: metadata } = readVideo(store, { subtitle: false })
  const metadataJob = makeShare(store, metadata)
  assert.throws(() => store.feed.create({ ...SHARE, sourceTaskId: metadataJob.id }), /lacks an eligible subtitle reading receipt/u)
  const { source, snapshot: collected } = readVideo(store, { collection: true })
  const collectedJob = makeShare(store, collected)
  assert.ok(store.bilibili.revokeSource(source.id))
  assert.throws(() => store.feed.create({ ...SHARE, sourceTaskId: collectedJob.id }), /lacks an eligible subtitle reading receipt/u)
  const { snapshot: local } = readVideo(store, { part: 3, local: true })
  const localJob = makeShare(store, local)
  assert.equal(store.bilibiliSubtitles.remove(VIDEO, 3), true)
  assert.throws(() => store.feed.create({ ...SHARE, sourceTaskId: localJob.id }), /lacks an eligible subtitle reading receipt/u)
  assert.deepEqual(store.feed.list().items, [])
})

test('Bilibili share and daily choice sessions have no Companion or native tool access', () => {
  for (const [contextId, profile] of [[BILIBILI_SHARE_CONTEXT, 'bilibili-share'], [DAILY_AUTONOMY_CONTEXT, 'daily-choice']]) {
    assert.equal(isCompanionDecisionContext(contextId), true)
    const policy = companionToolPolicy(contextId, 'system')
    assert.equal(policy.profile, profile)
    assert.deepEqual(policy.allowed, [])
    const filters = []
    restrictCompanionTools({
      effect: action => action(), tools: { restrict: filter => filters.push(filter) },
    }, contextId, 'system')
    assert.deepEqual(filters, [{ allow: [] }])
  }
})

test('session tool restrictions only name tools actually registered on this host', () => {
  const filters = []
  const registered = new Set(['mc_status', 'companion_memory_search', 'companion_post_create', 'working_directory'])
  const ctx = { effect: action => action(), tools: {
    get: name => registered.has(name) ? { name } : undefined,
    restrict: filter => filters.push(filter),
  } }
  restrictCompanionTools(ctx, 'chat.mobile', 'chat')
  assert.deepEqual(filters[0], { deny: ['companion_post_create', 'mc_status'] })
  registered.add('mc_change_appearance')
  registered.add('companion_singing_score')
  restrictCompanionTools(ctx, 'chat.mobile', 'chat')
  assert.deepEqual(filters[1], { deny: ['companion_post_create', 'mc_status', 'mc_change_appearance', 'companion_singing_score'] })
})

test('management HTTP accepts the optional setting but cannot submit the reserved share context', async t => {
  const { store } = fixture(t)
  const { snapshot } = readVideo(store)
  const job = makeShare(store, snapshot)
  let route
  let origin
  let calls = 0
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }, {
    autonomy: {
      updateSettings(input) {
        store.autonomy.saveSettings({ ...store.autonomy.settings(), ...input })
        return { settings: store.autonomy.settings() }
      },
    },
    idleCompaction: { policyChanged() {} },
    publishPost(input) { calls++; return store.feed.create(input) },
  })
  const server = createServer(route.handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-companion-request': '1', 'content-type': 'application/json' }
  const request = (path, method, value, requestHeaders = headers) => fetch(`${origin}/companion/api/${path}`, {
    method, headers: requestHeaders, body: JSON.stringify(value),
  })
  assert.equal((await request('autonomy', 'PUT', { bilibiliShareEnabled: true }, {})).status, 403)
  assert.equal((await request('autonomy', 'PUT', { bilibiliShareEnabled: 'yes' })).status, 400)
  const updated = await request('autonomy', 'PUT', { bilibiliShareEnabled: true })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).settings.bilibiliShareEnabled, true)
  const forged = await request('feed', 'POST', { ...SHARE, sourceTaskId: job.id })
  assert.equal(forged.status, 400)
  assert.equal(calls, 0)
  const plain = await request('feed', 'POST', { body: '普通动态', bilibiliSource: { bvid: VIDEO, part: 2, startSeconds: 5 } })
  assert.equal(plain.status, 201)
  assert.equal((await plain.json()).bilibiliSource, undefined)
  assert.equal(calls, 1)
})
