import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBilibiliTarget, wbiPlayerQuery } from '../src/core/bilibili.ts'
import { BilibiliService } from '../src/host/bilibili.ts'

const bvid = 'BV1dLx46TEhw'
const video = {
  bvid, aid: 42, title: '标题', desc: '简介\u0000\n 下一句', owner: { name: '作者' }, duration: 50,
  pages: [{ page: 1, cid: 13, part: '第一集', duration: 20 }, { page: 2, cid: 17, part: '第二集', duration: 30 }],
}
const wbi = {
  img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png',
}
const track = { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json?code=private-looking' }
const ok = data => Response.json({ code: 0, data })
const source = { mid: '7380321', seasonId: '678635' }
const discoveryPath = '/x/polymer/web-space/seasons_archives_list'
const collection = archives => ({ meta: { mid: Number(source.mid), season_id: Number(source.seasonId) }, archives })
const archive = { bvid, title: '合集标题', state: 0 }

function fixture(override = () => undefined) {
  const requests = []
  const receipts = []
  const service = new BilibiliService({ recordActivity: item => receipts.push(item) }, async (url, options) => {
    requests.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(Object.keys(options.headers).some(key => /authorization|cookie/iu.test(key)), false)
    const result = await override(url, options)
    if (result) return result
    if (url.pathname === '/x/web-interface/view') return ok({ ...video, bvid: url.searchParams.get('bvid') })
    if (url.pathname === '/x/web-interface/nav') return Response.json({ code: -101, data: { isLogin: false, wbi_img: wbi } })
    if (url.pathname === '/x/player/wbi/v2') return ok({ bvid, aid: 42, cid: 17, subtitle: { subtitles: [track] } })
    if (url.host === 'aisubtitle.hdslb.com') return Response.json({ body: [{ from: 0, to: 2, content: '一句真实摘录' }] })
    assert.fail(`unexpected request ${url.origin}${url.pathname}`)
  })
  return { service, requests, receipts }
}

test('canonicalizes exact video references and rejects ambiguous or untrusted locations', () => {
  const url = `https://www.bilibili.com/video/${bvid}/?p=2&trackid=ignored`
  assert.deepEqual(parseBilibiliTarget(url), { bvid, part: 2 })
  assert.deepEqual(parseBilibiliTarget(url, 1), { bvid, part: 1 })
  for (const input of [
    'BVx', `http://www.bilibili.com/video/${bvid}`, `https://www.bilibili.com.example/video/${bvid}`,
    `https://www.bilibili.com@localhost/video/${bvid}`, `https://www.bilibili.com:443/video/${bvid}`,
    `https://www.bilibili.com/video/${bvid}/?p=1&p=2`, `https://www.bilibili.com/video/${bvid}/?p=0`,
    `https://www.bilibili.com/video/${bvid}/..`, `https://www.bilibili.com/video/${bvid}/%20`,
    'https://b23.tv/redirect',
  ]) assert.equal(parseBilibiliTarget(input), undefined)
})

test('matches an independent WBI signature vector for the selected video and cid', () => {
  const params = wbiPlayerQuery({ bvid, cid: 17 }, wbi.img_url, wbi.sub_url, 1786200100)
  assert.equal(params.toString(), `bvid=${bvid}&cid=17&wts=1786200100&w_rid=e1e3b3cb2bc3c6ac3afecb52d8cf97f4`)
  assert.equal(wbiPlayerQuery({ bvid, cid: 17 }, 'http://i0.hdslb.com/invalid', wbi.sub_url, 1786200100), undefined)
})

test('inspects metadata once, reuses validated metadata, and records only minimal successful evidence', async () => {
  const { service, requests, receipts } = fixture()
  const first = await service.read({ video: bvid })
  const next = await service.read({ video: bvid, part: 2 }, { contextId: 'world.bilibili', sessionId: 'isolated-topic' })
  assert.equal(requests.length, 1)
  assert.equal(first.description, '简介 下一句')
  assert.equal(first.subtitle.status, 'not-requested')
  assert.equal(next.part, 2)
  assert.equal(next.url, `https://www.bilibili.com/video/${bvid}/?p=2`)
  assert.equal(next.partDurationSeconds, 30)
  assert.equal(receipts[1].kind, 'video.inspected')
  assert.equal(receipts[1].contextId, 'world.bilibili')
  assert.deepEqual(receipts[1].data, { bvid, part: 2 })
  assert.ok(receipts.every(item => item.source === 'media.bilibili' && !JSON.stringify(item).includes('简介')))
  await assert.rejects(service.read({ video: bvid, part: 3 }), { code: 'bili-part-unavailable' })
  assert.equal(receipts.length, 2)
})

test('World status tracks an in-flight read and expires a successful observation without polling upstream', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { service, requests } = fixture(async () => { await pending })
  assert.equal(service.worldHealth(), 'standby')
  assert.equal(requests.length, 0)
  const read = service.read({ video: bvid })
  assert.equal(service.worldHealth(), 'busy')
  release()
  await read
  assert.equal(service.worldHealth(), 'ready')
  assert.equal(service.worldHealth(Date.now() + 120_001), 'standby')
  assert.equal(requests.length, 1)
  service.close()
  assert.equal(service.worldHealth(), 'unavailable')
})

test('World status distinguishes upstream errors from cooldown and malformed user input', async () => {
  const failed = fixture(() => new Response(null, { status: 503 }))
  await assert.rejects(failed.service.read({ video: 'not a video' }), { code: 'bili-invalid-video' })
  assert.equal(failed.service.worldHealth(), 'standby')
  assert.equal(failed.requests.length, 0)
  await assert.rejects(failed.service.read({ video: bvid }), { code: 'bili-upstream-error' })
  assert.equal(failed.service.worldHealth(), 'unavailable')

  const paused = fixture(() => new Response(null, { status: 429 }))
  await assert.rejects(paused.service.read({ video: bvid }), { code: 'bili-upstream-paused' })
  assert.equal(paused.service.worldHealth(), 'paused')
  assert.equal(paused.service.worldHealth(Date.now() + 120_001), 'standby')
})

test('takes anonymous public keys, reads a matching signed track and limits excerpts to 1200 UTF-8 bytes', async () => {
  const { service, requests, receipts } = fixture((url) => {
    if (url.host === 'aisubtitle.hdslb.com') return Response.json({ body: [
      { from: 0, to: 1, content: '中文'.repeat(220) }, { from: 2, to: 4, content: '后文' },
    ] })
  })
  const result = await service.read({ video: bvid, part: 2, subtitles: true })
  assert.equal(requests.length, 4)
  const signed = requests[2]
  assert.equal(signed.pathname, '/x/player/wbi/v2')
  assert.equal(signed.searchParams.get('cid'), '17')
  assert.match(signed.searchParams.get('w_rid'), /^[0-9a-f]{32}$/u)
  assert.equal(result.subtitle.status, 'excerpt')
  assert.equal(result.subtitle.truncated, true)
  assert.equal(Buffer.byteLength(result.subtitle.cues[0].text), 1200)
  assert.equal(result.receipt.kind, 'video.subtitle-read')
  assert.deepEqual(receipts[0].data, { bvid, part: 2 })
  assert.doesNotMatch(JSON.stringify(receipts), /私|中文|private-looking/u)
})

test('caps the number of short cues and retains numeric timestamps', async () => {
  const { service } = fixture(url => url.host === 'aisubtitle.hdslb.com' && Response.json({
    body: Array.from({ length: 15 }, (_, i) => ({ from: i, to: i + .7, content: `片段${i}` })),
  }))
  const result = await service.read({ video: bvid, part: 2, subtitles: true })
  assert.equal(result.subtitle.cues.length, 12)
  assert.equal(result.subtitle.cues[11].to, 11.7)
  assert.equal(result.subtitle.truncated, true)
})

test('reports empty subtitles honestly and tries the selected signed track again on a later explicit request', async () => {
  let reads = 0
  const { service, requests, receipts } = fixture(url => {
    if (url.pathname === '/x/player/wbi/v2') return ok({ cid: 17, subtitle: { subtitles: [{ lan: 'zh', subtitle_url: ' ' }, track] } })
    if (url.host === 'aisubtitle.hdslb.com' && reads++ === 0) return Response.json({ body: [] })
  })
  const input = { video: bvid, part: 2, subtitles: true }
  assert.equal((await service.read(input)).subtitle.status, 'unavailable')
  assert.equal((await service.read(input)).subtitle.status, 'excerpt')
  assert.equal(requests.length, 7)
  assert.deepEqual(receipts.map(item => item.kind), ['video.inspected', 'video.subtitle-read'])
})

test('does not follow a wrong or unproven part identity', async () => {
  for (const [cid, error] of [[13, 'bili-subtitle-identity'], [undefined, undefined]]) {
    const { service, requests, receipts } = fixture(url => url.pathname === '/x/player/wbi/v2' && ok({ bvid, cid, subtitle: { subtitles: [track] } }))
    const work = service.read({ video: bvid, part: 2, subtitles: true })
    if (error) await assert.rejects(work, { code: error })
    else assert.deepEqual((await work).subtitle, { status: 'unavailable' })
    assert.equal(requests.length, 3)
    assert.deepEqual(receipts.map(item => item.kind), error ? [] : ['video.inspected'])
  }
})

test('rejects non-public track URLs before network and fails invalid timelines without success', async () => {
  for (const subtitle_url of ['https://aisubtitle.hdslb.com.evil.test/bfs/ai_subtitle/x.json', 'https://i0.hdslb.com:8787/x.json', 'https://user@i0.hdslb.com/x.json', 'http://i0.hdslb.com/x.json', 'https://i0.hdslb.com/video.mp4']) {
    const { service, requests, receipts } = fixture(url => url.pathname === '/x/player/wbi/v2' && ok({ bvid, cid: 17, subtitle: { subtitles: [{ ...track, subtitle_url }] } }))
    await assert.rejects(service.read({ video: bvid, part: 2, subtitles: true }), { code: 'bili-subtitle-url-denied' })
    assert.equal(requests.length, 3)
    assert.equal(receipts.length, 0)
  }
  const { service, receipts } = fixture(url => url.host === 'aisubtitle.hdslb.com' && Response.json({ body: [{ from: 3, to: 150, content: '其他视频' }] }))
  await assert.rejects(service.read({ video: bvid, part: 2, subtitles: true }), { code: 'bili-subtitle-timeline' })
  assert.equal(receipts.length, 0)
})

test('stops on redirect, invalid metadata identity and actual body byte overflow', async () => {
  for (const [makeResponse, code] of [
    [() => Response.redirect('https://127.0.0.1/forbidden'), 'bili-upstream-error'],
    [() => ok({ ...video, bvid: 'BV1234567890' }), 'bili-upstream-invalid'],
    [() => new Response(new Uint8Array(512 * 1024 + 1)), 'bili-upstream-too-large'],
  ]) {
    const { service, requests, receipts } = fixture(makeResponse)
    await assert.rejects(service.read({ video: bvid }), { code })
    assert.equal(requests.length, 1)
    assert.equal(receipts.length, 0)
  }
})

test('pauses after a risk response and enforces the rolling public request budget', async () => {
  const risk = fixture(() => new Response(null, { status: 412 }))
  for (let i = 0; i < 2; i++) await assert.rejects(risk.service.read({ video: bvid }), { code: 'bili-upstream-paused' })
  assert.equal(risk.requests.length, 1)
  const budget = fixture()
  for (let i = 0; i < 16; i++) await budget.service.read({ video: `BV${String(i).padStart(10, '0')}` })
  await assert.rejects(budget.service.read({ video: bvid }), { code: 'bili-budget-exhausted' })
  assert.equal(budget.requests.length, 16)
})

test('concurrent reads are bounded and shutdown aborts work without recording any receipt', async () => {
  const { service, requests, receipts } = fixture((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }))
  const work = service.read({ video: bvid })
  await assert.rejects(service.read({ video: bvid }), { code: 'bili-busy' })
  service.close()
  await assert.rejects(work, { code: 'bili-stopping' })
  assert.equal(requests.length, 1)
  assert.equal(receipts.length, 0)
})

test('discovery reads one fixed anonymous collection page and projects only bounded public candidates', async () => {
  const second = 'BV1Ta411V7LR'
  const { service, requests, receipts } = fixture(() => ok(collection([
    { ...archive, title: ' 合集\u0000\n标题 ', desc: '不要传给评估' },
    { ...archive, title: '重复标题' },
    { bvid: second, title: '长'.repeat(100), state: 0 },
    { bvid: 'BV1hS4y1S7wL', title: '不可见', state: -2 },
  ])))
  assert.deepEqual(await service.discover(source, new AbortController().signal), [
    { bvid, title: '合集 标题' }, { bvid: second, title: '长'.repeat(80) },
  ])
  assert.deepEqual(requests.map(String), [
    `https://api.bilibili.com${discoveryPath}?mid=7380321&season_id=678635&page_num=1&page_size=6`,
  ])
  assert.deepEqual(receipts, [])
  assert.equal(service.homeActive(), false)
  assert.equal(service.isIdle(), true)
})

test('discovery rejects invalid source IDs locally and mismatched or malformed upstream results atomically', async () => {
  const noNetwork = fixture()
  for (const target of [
    { ...source, mid: '0' }, { ...source, mid: '01' }, { ...source, mid: 'https://localhost' },
    { ...source, seasonId: '1&pn=2' }, { ...source, seasonId: '9007199254740992' },
  ]) await assert.rejects(noNetwork.service.discover(target, new AbortController().signal), { code: 'bili-invalid-source' })
  assert.deepEqual(noNetwork.requests, [])
  for (const [data, code] of [
    [{ ...collection([archive]), meta: { mid: 1, season_id: Number(source.seasonId) } }, 'bili-source-identity'],
    [{ ...collection([archive]), meta: { mid: Number(source.mid), season_id: 1 } }, 'bili-source-identity'],
    [{ archives: [archive] }, 'bili-upstream-invalid'],
    [collection(Array.from({ length: 7 }, () => archive)), 'bili-upstream-invalid'],
    [collection([archive, { ...archive, bvid: `https://www.bilibili.com/video/${bvid}/` }]), 'bili-upstream-invalid'],
    [collection([archive, { bvid: 'BV1Ta411V7LR', title: '\u0000\n', state: 0 }]), 'bili-upstream-invalid'],
  ]) {
    const { service, requests, receipts } = fixture(() => ok(data))
    await assert.rejects(service.discover(source, new AbortController().signal), { code })
    assert.equal(requests.length, 1)
    assert.deepEqual(receipts, [])
  }
})

test('discovery honors anonymous access and shares upstream risk and byte bounds with video reads', async () => {
  const controller = new AbortController()
  const unavailable = fixture(() => Response.json({ code: -101, data: null }))
  await assert.rejects(unavailable.service.discover(source, controller.signal), { code: 'bili-source-unavailable' })
  const redirected = fixture(() => Response.redirect('https://127.0.0.1/forbidden'))
  await assert.rejects(redirected.service.discover(source, controller.signal), { code: 'bili-upstream-error' })
  const risk = fixture(() => Response.json({ code: -412, data: null }))
  await assert.rejects(risk.service.discover(source, controller.signal), { code: 'bili-upstream-paused' })
  await assert.rejects(risk.service.read({ video: bvid }), { code: 'bili-upstream-paused' })
  assert.equal(risk.requests.length, 1)
  const large = fixture(() => new Response(new Uint8Array(512 * 1024 + 1)))
  await assert.rejects(large.service.discover(source, controller.signal), { code: 'bili-upstream-too-large' })
  const budget = fixture(url => url.pathname === discoveryPath && ok(collection([])))
  assert.deepEqual(await budget.service.discover(source, controller.signal), [])
  for (let i = 0; i < 15; i++) await budget.service.read({ video: `BV${String(i).padStart(10, '0')}` })
  await assert.rejects(budget.service.discover(source, controller.signal), { code: 'bili-budget-exhausted' })
  assert.equal(budget.requests.length, 16)
})

test('discovery shares exclusivity, remains absent from home, and cannot complete after cancellation', async () => {
  const controller = new AbortController()
  const response = Promise.withResolvers()
  const { service, requests, receipts } = fixture(url => url.pathname === discoveryPath && response.promise)
  const work = service.discover(source, controller.signal)
  assert.equal(service.isIdle(), false)
  assert.equal(service.homeActive(), false)
  await assert.rejects(service.read({ video: bvid }, { contextId: 'world.bilibili', sessionId: 'topic' }), { code: 'bili-busy' })
  await assert.rejects(service.discover(source, controller.signal), { code: 'bili-busy' })
  controller.abort()
  response.resolve(ok(collection([archive])))
  await assert.rejects(work, { code: 'bili-cancelled' })
  assert.equal(requests.length, 1)
  assert.equal(service.isIdle(), true)
  assert.deepEqual(receipts, [])
  await service.read({ video: bvid })
  assert.equal(receipts.length, 1)
})

test('shutdown aborts the collection lookup and a current read prevents concurrent discovery', async () => {
  const blocking = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  const controller = new AbortController()
  const read = fixture(blocking)
  const reading = read.service.read({ video: bvid }, { contextId: 'world.bilibili', sessionId: 'topic' })
  assert.equal(read.service.homeActive(), true)
  await assert.rejects(read.service.discover(source, controller.signal), { code: 'bili-busy' })
  read.service.close()
  await assert.rejects(reading, { code: 'bili-stopping' })

  const discovery = fixture(blocking)
  const listing = discovery.service.discover(source, controller.signal)
  discovery.service.close()
  await assert.rejects(listing, { code: 'bili-stopping' })
  assert.equal(discovery.service.homeActive(), false)
  assert.equal(discovery.service.isIdle(), false)
  assert.equal(discovery.requests.length, 1)
  assert.deepEqual(discovery.receipts, [])
})
