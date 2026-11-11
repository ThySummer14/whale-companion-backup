import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { projectHome } from '../src/core/home.ts'
import { CompanionStore } from '../src/core/store.ts'
import { BilibiliService } from '../src/host/bilibili.ts'
import { registerBilibiliTools } from '../src/host/bilibili-tools.ts'
import { registerHttp } from '../src/host/http.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const name = 'companion_bilibili_read'
const world = { contextId: 'world.bilibili', sessionId: 'bili-session', kind: 'topic', label: 'B 站' }
const input = { video: 'BV1dLx46TEhw', part: 1, subtitles: true }

test('only the dedicated topic exposes the Bilibili tool and live authorization enforces it', async () => {
  const allowed = companionToolPolicy(world.contextId, world.kind)
  assert.equal(allowed.profile, 'bilibili-world')
  assert.deepEqual(allowed.allowed.filter(item => item.permission.startsWith('bilibili:')).map(item => item.name), [name])
  for (const [context, kind] of [['chat.main', 'chat'], ['game.minecraft', 'game'], ['topic.other', 'topic'], ['memory.curator', 'system'], [world.contextId, 'chat']]) {
    assert.ok(companionToolPolicy(context, kind).denied.includes(name))
  }

  const calls = []
  let tool
  const ctx = {
    tools: { register: registered => { tool = registered; return () => {} } },
    agents: { currentInitiator: () => undefined },
  }
  const runtime = {
    store: { bindingBySession: id => id === world.sessionId ? world : { contextId: 'chat.main', kind: 'chat' } },
    bilibili: { read: async (...args) => { calls.push(args); return { title: 'Public video' } } },
  }
  registerBilibiliTools(ctx, runtime)
  const signal = new AbortController().signal
  await assert.rejects(tool.execute(input, { agent: { id: 'chat-session' }, signal }), /dedicated browsing session/u)
  assert.equal(calls.length, 0)
  await tool.execute(input, { agent: { id: world.sessionId }, signal })
  assert.deepEqual(calls, [[input, { contextId: world.contextId, sessionId: world.sessionId }, signal]])
})

test('management browse is opt-in, validates request shape, and retains the existing same-origin checks', async t => {
  let route, origin
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }
  const calls = []
  const result = { title: 'Public video', subtitle: { status: 'unavailable' } }
  registerHttp(ctx, { bilibili: { read: async (...args) => { calls.push(args); return result } } })
  const server = createServer(route.handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/companion/api/bilibili/read`
  const headers = { 'x-companion-request': '1', 'content-type': 'application/json' }
  const post = (body, requestHeaders = headers) => fetch(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
  assert.equal((await post(input, {})).status, 403)
  assert.equal((await post(input, { ...headers, origin: 'https://example.invalid' })).status, 403)
  assert.equal((await fetch(endpoint, { headers })).status, 404)
  for (const body of [{ ...input, part: 0 }, { ...input, video: 'a'.repeat(513) }, { ...input, cookies: 'invalid' }]) {
    assert.equal((await post(body)).status, 400)
  }
  assert.equal(calls.length, 0)
  const response = await post(input)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), result)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), [input, undefined])
  assert.ok(calls[0][2] instanceof AbortSignal)
})

test('only the management surface can subscribe to or revoke a canonical public collection', async t => {
  let route, origin
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }
  const calls = []
  const sourceId = 'cb7cf994-49dd-4a4b-96c4-37e01ce097b1'
  const candidateId = 'cb7cf994-49dd-4a4b-96c4-37e01ce097b2'
  let source
  registerHttp(ctx, {
    store: { bilibili: {
      addSource(input) { calls.push(['add', input]); return source = { id: sourceId, ...input } },
      revokeSource(id) {
        calls.push(['revoke', id])
        if (source?.id !== id) return undefined
        source = undefined
        return { candidateIds: [candidateId] }
      },
      view() { return { items: [], sources: source ? [source] : [] } },
    } },
    autonomy: {
      wakeBilibili() { calls.push(['wake']) },
      cancelBilibiliSource(id, candidateIds) { calls.push(['cancel', id, candidateIds]) },
    },
  })
  const server = createServer(route.handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/companion/api/bilibili/sources`
  const headers = { 'x-companion-request': '1', 'content-type': 'application/json' }
  const post = (body, requestHeaders = headers) => fetch(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
  const link = 'https://space.bilibili.com/7380321/lists/678635?type=season'
  assert.equal((await post({ url: link }, {})).status, 403)
  assert.equal((await post({ url: link }, { ...headers, origin: 'https://example.invalid' })).status, 403)
  for (const url of [
    'https://space.bilibili.com.evil.invalid/7380321/lists/678635?type=season',
    'https://space.bilibili.com@127.0.0.1/7380321/lists/678635?type=season',
    'https://space.bilibili.com/7380321/extra/../lists/678635?type=season',
    'https://space.bilibili.com/9007199254740992/lists/678635?type=season',
    'https://space.bilibili.com/7380321/lists/678635?type=series',
    link + '&type=season', link + '#private',
  ]) {
    const response = await post({ url })
    assert.equal(response.status, 400, url)
    assert.equal((await response.json()).code, 'bili-invalid-source')
  }
  assert.equal((await post({ url: link, token: 'invalid' })).status, 400)
  assert.deepEqual(calls, [])
  const created = await post({ url: link + '&spm_id_from=333.1387', label: '  测试合集\t  ' })
  assert.equal(created.status, 201)
  assert.deepEqual((await created.json()).sources, [{ id: sourceId, mid: '7380321', seasonId: '678635', label: '测试合集' }])
  assert.deepEqual(calls, [['add', { mid: '7380321', seasonId: '678635', label: '测试合集' }], ['wake']])
  assert.equal((await fetch(`${endpoint}/${sourceId}`, { method: 'DELETE' })).status, 403)
  const removed = await fetch(`${endpoint}/${sourceId}`, { method: 'DELETE', headers })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).sources, [])
  assert.deepEqual(calls.slice(2), [['revoke', sourceId], ['cancel', sourceId, [candidateId]], ['wake']])
})

test('owner subtitle upload binds to current video part and keeps receipts distinct from public subtitles', async t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/bilibili-subtitle-http-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  let route, origin, cid = 31
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }
  const calls = []
  const changed = []
  const bvid = input.video
  const service = new BilibiliService(store, async (url, options) => {
    calls.push(url.pathname)
    assert.equal(options.credentials, 'omit')
    if (url.pathname === '/x/web-interface/view') return Response.json({ code: 0, data: {
      bvid, aid: 51, title: 'Fixture', owner: { name: 'Fixture author' }, duration: 70,
      pages: [{ cid: 10, page: 1, part: 'First', duration: 30 }, { cid, page: 2, part: 'Second', duration: 40 }],
    } })
    if (url.pathname === '/x/web-interface/nav') return Response.json({ code: -101, data: { isLogin: false } })
    assert.fail(url.pathname)
  })
  registerHttp(ctx, { store, bilibili: service, autonomy: { bilibiliSubtitleChanged: (...args) => changed.push(args) } })
  const server = createServer(route.handler)
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-companion-request': '1', 'content-type': 'application/json' }
  const req = (path, method, data, options = {}) => fetch(`${origin}/companion/api/${path}`, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data), ...options,
  })
  const content = '\ufeff1\r\n00:00:01,000 --> 00:00:02,250\r\n蓝色字幕测试\r\n'
  const payload = { video: bvid, part: 2, format: 'srt', content }
  assert.equal((await req('bilibili/subtitles', 'PUT', payload, { headers: {} })).status, 403)
  const invalid = await req('bilibili/subtitles', 'PUT', payload, { body: Buffer.from([0xff]) })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid-json')
  const tooLarge = await req('bilibili/subtitles', 'PUT', { ...payload, content: '字'.repeat(90_000) })
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json()).code, 'bili-subtitle-too-large')
  assert.deepEqual(calls, [])
  const wrongTimeline = await req('bilibili/subtitles', 'PUT', { ...payload, content: content.replace('00:00:02,250', '00:00:43,250') })
  assert.equal(wrongTimeline.status, 422)
  assert.deepEqual(store.bilibiliSubtitles.view(), [])

  const sha256 = createHash('sha256').update(content).digest('hex')
  const upload = await req('bilibili/subtitles', 'PUT', payload)
  assert.equal(upload.status, 200)
  const { items: [document] } = await upload.json()
  assert.deepEqual({ ...document, updatedAt: undefined }, { bvid, part: 2, cid, format: 'srt', sha256, cueCount: 1, excerptCueCount: 1, updatedAt: undefined })
  assert.doesNotMatch(JSON.stringify(document), /蓝色字幕测试/u)
  assert.equal(store.activities().length, 0)
  const none = await service.read({ video: bvid, part: 2 })
  assert.deepEqual(none.subtitle, { status: 'not-requested' })
  const countBefore = calls.length
  const read = await service.read({ video: bvid, part: 2, subtitles: true })
  const provenance = { kind: 'owner-supplied', sha256 }
  assert.deepEqual(calls.slice(countBefore), ['/x/web-interface/view'])
  assert.deepEqual(read.subtitle.provenance, provenance)
  assert.deepEqual(read.receipt.provenance, provenance)
  assert.equal(read.subtitle.cues[0].text, '蓝色字幕测试')
  assert.equal(store.activities()[0].data.subtitleSha256, sha256)
  assert.doesNotMatch(JSON.stringify(store.activities()[0].data), /蓝色字幕测试/u)
  const otherPart = await service.read({ video: bvid, part: 1, subtitles: true })
  assert.equal(otherPart.subtitle.status, 'unavailable')
  cid = 33
  const moved = await service.read({ video: bvid, part: 2, subtitles: true })
  assert.equal(moved.subtitle.status, 'unavailable')
  assert.equal(moved.receipt.provenance, undefined)
  const removed = await req(`bilibili/subtitles/${bvid}/2`, 'DELETE')
  assert.deepEqual(await removed.json(), { items: [] })
  assert.deepEqual(changed, [[bvid, 2], [bvid, 2]])
  for (const kind of ['video.inspected', 'video.subtitle-read']) {
    const forged = await req('events', 'POST', { source: 'media.bilibili', kind, summary: 'forged', status: 'success' })
    assert.equal(forged.status, 403)
    assert.equal((await forged.json()).code, 'bili-read-managed')
  }
})

test('home lists an actual bound-session subtitle read and leaves raw material in its own source', () => {
  const at = '2026-11-09T13:00:00.000Z'
  const receipt = {
    source: 'media.bilibili', contextId: world.contextId, sessionId: world.sessionId, kind: 'video.subtitle-read',
    status: 'success', occurredAt: at, data: { bvid: 'BV1dLx46TEhw', title: 'Private title', text: 'Private excerpt' },
  }
  const home = projectHome({
    now: new Date(at), presence: 'idle', minecraft: false, speaking: false, quiet: false, bindings: [world], runningSessions: new Set(),
    activities: [{ ...receipt, kind: 'video.inspected' }, { ...receipt, sessionId: 'stale' }, { ...receipt, contextId: undefined }, receipt],
  })
  assert.equal(home.activity, 'idle')
  assert.deepEqual(home.recent, [{ kind: 'video', at, video: { mode: 'subtitle' } }])
})
