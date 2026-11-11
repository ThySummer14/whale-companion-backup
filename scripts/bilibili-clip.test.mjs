import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseBilibiliClipRequest } from '../src/core/bilibili.ts'
import { BILIBILI_CONTEXT } from '../src/core/model.ts'
import { projectHome } from '../src/core/home.ts'
import { bilibiliTrackUrl, readBilibiliFragment, selectBilibiliTrack, sidxFragments } from '../src/host/bilibili-dash.ts'
import { BilibiliService } from '../src/host/bilibili.ts'
import { registerBilibiliClipInput, retainBilibiliClipReceipts } from '../src/host/bilibili-clip-input.ts'

const bvid = 'BV1dLx46TEhw'
const signal = new AbortController().signal
const explicit = `看这段 ${bvid} 00:12 6秒 画面和声音`
const url = 'https://upos-test.bilivideo.com/upgcxcode/13-1-30016.m4s'
const input = parseBilibiliClipRequest(explicit)

test('clip request accepts explicit modes, link pages and bounded time, rejecting vague and disguised instructions', () => {
  assert.deepEqual(input, { bvid, part: 1, start: 12, seconds: 6, mode: 'both' })
  assert.deepEqual(parseBilibiliClipRequest(`请帮我看这段 https://www.bilibili.com/video/${bvid}/?p=3 1:04:09 12秒 声音。`),
    { bvid, part: 3, start: 3849, seconds: 12, mode: 'audio' })
  assert.equal(parseBilibiliClipRequest(`看片段：${bvid} 0 1秒 画面`).mode, 'visual')
  assert.equal(parseBilibiliClipRequest(`看片段 ${bvid} 3 5秒`).mode, 'both')
  for (const text of [`我看过 ${bvid}`, `转发：${explicit}`, `${explicit}\n再读其他视频`, `看这段 ${bvid} 0 13秒`,
    `看这段 ${bvid} 00:60 1秒`, `看这段 ${bvid} 999999 1秒`, `看这段 https://b23.tv/any 0 1秒`,
    `看这段 ${bvid} -1 6秒`, `看这段 ${bvid} 0 0秒`]) assert.equal(parseBilibiliClipRequest(text), undefined, text)
})

function track(overrides = {}) {
  return { baseUrl: url, width: 640, height: 360, codecs: 'avc1.640033', bandwidth: 50_000,
    SegmentBase: { Initialization: '0-99', indexRange: '100-167' }, ...overrides }
}

test('DASH track selection admits exact HTTPS CID, bounded codecs, adjacent header and the cheaper eligible track', () => {
  for (const bad of [url.replace('13-', '17-'), url.replace('.com/', '.com.evil.test/'), url.replace('https:', 'http:'),
    url.replace('upos-test', '127.0.0.1@upos-test'), url.replace('.com/', '.com:9999/'), url + '#redirect']) {
    assert.equal(bilibiliTrackUrl(bad, 13), undefined, bad)
  }
  const result = selectBilibiliTrack({ dash: { video: [
    track({ codecs: 'hvc1.1', bandwidth: 1 }), track({ height: 1080, bandwidth: 2 }),
    track({ SegmentBase: { Initialization: '0-99', indexRange: '101-168' }, bandwidth: 3 }),
    track({ baseUrl: url.replace('30016', '30032'), bandwidth: 98_000 }), track(),
  ] } }, 'video', 13)
  assert.equal(result.url.href, url)
  assert.equal(selectBilibiliTrack({ dash: { audio: [track({ codecs: 'mp4a.40.5' })] } }, 'audio', 13), undefined)
  assert.ok(selectBilibiliTrack({ dash: { audio: [track({ codecs: 'mp4a.40.2' })] } }, 'audio', 13))
  assert.equal(selectBilibiliTrack({ durl: [{ url }] }, 'video', 13), undefined)
})

function sidx(refs, { wide = false, firstOffset = 0, earliest = 0 } = {}) {
  const head = wide ? 40 : 32
  const bytes = Buffer.alloc(head + refs.length * 12)
  bytes.writeUInt32BE(bytes.length)
  bytes.write('sidx', 4)
  bytes[8] = wide ? 1 : 0
  bytes.writeUInt32BE(1000, 16)
  if (wide) {
    bytes.writeBigUInt64BE(BigInt(earliest), 20)
    bytes.writeBigUInt64BE(BigInt(firstOffset), 28)
  } else {
    bytes.writeUInt32BE(earliest, 20)
    bytes.writeUInt32BE(firstOffset, 24)
  }
  bytes.writeUInt16BE(refs.length, head - 2)
  for (const [index, [length, duration, sap = 0x9000_0000]] of refs.entries()) {
    const at = head + index * 12
    bytes.writeUInt32BE(length, at)
    bytes.writeUInt32BE(duration, at + 4)
    bytes.writeUInt32BE(sap, at + 8)
  }
  return bytes
}

test('SIDX supports wide offsets and validates timing, SAP flags, sizes, nesting and truncation', () => {
  const bytes = sidx([[200, 2000], [400, 2000, 0x1000_0000]], { wide: true, firstOffset: 12, earliest: 200 })
  const index = { first: 100, last: 100 + bytes.length - 1 }
  assert.deepEqual(sidxFragments(bytes, index), [
    { first: 176, last: 375, from: 0.2, to: 2.2, independent: true },
    { first: 376, last: 775, from: 2.2, to: 4.2, independent: false },
  ])
  for (const bad of [sidx([[0, 1000]]), sidx([[15, 0]]), sidx([[2 ** 31, 1000]]), sidx([], {}), bytes.subarray(0, bytes.length - 2)]) {
    assert.throws(() => sidxFragments(bad, { first: 100, last: 99 + bad.length }), { code: 'bili-clip-index-unavailable' })
  }
})

test('fragment read only requests initialization plus selected ranges and seeks to a prior video keyframe', async () => {
  const indexed = sidx([[600, 2000], [800, 2000, 0], [1200, 2000]])
  const selected = { url: new URL(url), initialization: { first: 0, last: 99 }, index: { first: 100, last: 99 + indexed.length } }
  const ranges = []
  const read = async (_url, range) => {
    ranges.push(range)
    return range.first === 0 ? Buffer.concat([Buffer.alloc(100), indexed]) : Buffer.alloc(range.last - range.first + 1)
  }
  const result = await readBilibiliFragment(selected, 'video', 3, 2, read)
  assert.equal(result.skip, 3)
  assert.deepEqual(ranges, [{ first: 0, last: 167 }, { first: 168, last: 2767 }])
  assert.equal(result.data.length, 2700)
  const expensive = sidx([[2_000_000, 2000]])
  const limit = { ...selected, index: { first: 100, last: 99 + expensive.length } }
  await assert.rejects(readBilibiliFragment(limit, 'audio', 0, 2, async (_, range) => {
    assert.equal(range.first, 0)
    return Buffer.concat([Buffer.alloc(100), expensive])
  }), { code: 'bili-clip-budget' })
})

function service(t, media = { ffmpeg: 'ffmpeg' }, options = {}) {
  const requests = []
  const recordings = []
  const ok = data => Response.json({ code: 0, data })
  const instance = new BilibiliService({ recordActivity: record => recordings.push(record) }, async (url, init) => {
    requests.push([url, init])
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.ok(!Object.keys(init.headers).some(header => /cookie|authorization/i.test(header)))
    if (url.pathname === '/x/web-interface/view') return ok({ bvid, aid: 1, title: '样片', owner: { name: '样片作者' },
      duration: 24, pages: [{ page: 1, cid: 13, part: 'P1', duration: 24 }, { page: 2, cid: 27, part: 'P2', duration: 3 }] })
    if (url.pathname === '/x/web-interface/nav') return Response.json({ code: -101, data: { isLogin: false, wbi_img: {
      img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png',
    } } })
    if (url.pathname === '/x/player/wbi/playurl') {
      assert.equal(url.searchParams.get('cid'), '13')
      assert.equal(url.searchParams.get('fnval'), '16')
      assert.match(url.searchParams.get('w_rid'), /^[0-9a-f]{32}$/u)
      return ok(options.manifest ?? { dash: { video: [track()] } })
    }
    return options.range?.(url, init) ?? new Response(new Uint8Array(168), { status: 200 })
  }, media)
  t.after(() => instance.close())
  return { instance, requests, recordings }
}

test('connector does not fetch unsupported modalities, rejects part overflow and refuses a CDN full-file response', async t => {
  const { instance, requests, recordings } = service(t)
  const unsupported = await instance.sampleClip(input, false, signal)
  assert.equal(unsupported.visual.reason, 'bili-clip-vision-unavailable')
  assert.equal(unsupported.audio.reason, 'bili-clip-asr-unavailable')
  assert.equal(requests.length, 0)
  await assert.rejects(instance.sampleClip({ ...input, part: 2 }, true, signal), { code: 'bili-clip-outside-part' })
  assert.equal(requests.length, 1)
  const result = await instance.sampleClip(input, true, signal)
  assert.equal(result.visual.reason, 'bili-clip-range-unavailable')
  assert.deepEqual(requests.at(-1)[1].headers.range, 'bytes=0-167')
  assert.equal(recordings.length, 0)
})

test('mismatched content-range, oversized data and stale CID return unavailable before decoding', async t => {
  for (const [name, manifest, response, reason] of [
    ['wrong content-range', { dash: { video: [track()] } }, () => new Response(new Uint8Array(168), { status: 206, headers: { 'content-range': 'bytes 1-168/500' } }), 'bili-clip-range-unavailable'],
    ['oversize response', { dash: { video: [track()] } }, () => new Response(new Uint8Array(200), { status: 206, headers: { 'content-range': 'bytes 0-167/500' } }), 'bili-upstream-too-large'],
    ['other CID', { dash: { video: [track({ baseUrl: url.replace('13-', '27-') })] } }, () => assert.fail('should not request CDN'), 'bili-clip-stream-unavailable'],
  ]) await t.test(name, async t => {
    const { instance } = service(t, undefined, { manifest, range: response })
    assert.equal((await instance.sampleClip(input, true, signal)).visual.reason, reason)
  })
})

test('a transport failure retries just the same range once, while upstream denial pauses the connector', async t => {
  for (const mode of ['transport', 'upstream-denial']) await t.test(mode, async t => {
    const seen = []
    const { instance } = service(t, undefined, { range: (_url, init) => {
      seen.push(init.headers.range)
      if (mode === 'transport') throw new Error('transport disconnected')
      return new Response('', { status: 403 })
    } })
    if (mode === 'transport') {
      assert.equal((await instance.sampleClip(input, true, signal)).visual.reason, 'bili-network-error')
      assert.deepEqual(seen, ['bytes=0-167', 'bytes=0-167'])
    } else {
      await assert.rejects(instance.sampleClip(input, true, signal), { code: 'bili-upstream-paused' })
      assert.deepEqual(seen, ['bytes=0-167'])
    }
  })
})

test('real FFmpeg decodes only the requested late picture and six seconds of audio from synthetic DASH ranges', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('FFmpeg unavailable'); return }
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/bili-dash-')
  t.after(() => rmSync(dir, { recursive: true }))
  const paths = { video: join(dir, 'video.mp4'), audio: join(dir, 'audio.mp4') }
  const common = ['-nostdin', '-loglevel', 'error', '-movflags', '+empty_moov+default_base_moof+global_sidx']
  const run = args => {
    const result = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  run(['-f', 'lavfi', '-i', "color=red:size=320x180:rate=10:duration=10[r];color=blue:size=320x180:rate=10:duration=14[b];[r][b]concat=n=2:v=1:a=0",
    '-threads', '1', '-c:v', 'libx264', '-g', '20', '-bf', '0', '-sc_threshold', '0', ...common, paths.video])
  run(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=10[a];sine=frequency=880:sample_rate=16000:duration=14[b];[a][b]concat=n=2:v=0:a=1',
    '-threads', '1', '-c:a', 'aac', '-b:a', '48k', '-frag_duration', '2000000', ...common, paths.audio])
  const files = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, readFileSync(path)]))
  const tracks = Object.fromEntries(Object.entries(files).map(([kind, bytes]) => {
    const first = bytes.indexOf('sidx') - 4
    const last = first + bytes.readUInt32BE(first) - 1
    return [kind, track({ baseUrl: url.replace('30016', kind === 'audio' ? '30216' : '30016'),
      codecs: kind === 'audio' ? 'mp4a.40.2' : 'avc1.640033', SegmentBase: { Initialization: `0-${first - 1}`, indexRange: `${first}-${last}` } })]
  }))
  let crossings
  const { instance, requests } = service(t, { ffmpeg: 'ffmpeg', asr: { async transcribe(read, signal) {
    const wav = await read(signal)
    assert.equal(wav.readUInt32LE(24), 16_000)
    assert.equal(wav.readUInt32LE(40), 6 * 16_000 * 2)
    crossings = 0
    for (let at = 44 + 32002; at < 44 + 64000; at += 2) {
      if (wav.readInt16LE(at - 2) <= 0 && wav.readInt16LE(at) > 0) crossings++
    }
    return { text: '实际音频样片的识别替身' }
  } } }, { manifest: { dash: { audio: [tracks.audio], video: [tracks.video] } }, range: (url, init) => {
    const file = files[url.pathname.includes('30216') ? 'audio' : 'video']
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range)
    return new Response(file.subarray(Number(from), Number(to) + 1), { status: 206, headers: { 'content-range': `bytes ${from}-${to}/${file.length}` } })
  } })
  const result = await instance.sampleClip(input, true, signal)
  assert.deepEqual(result.visual, { status: 'sampled' })
  assert.deepEqual(result.audio, { status: 'sampled' })
  assert.ok(crossings > 840 && crossings < 920, crossings)
  const pixel = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0',
    '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { input: result.picture })
  assert.equal(pixel.status, 0)
  assert.ok(pixel.stdout[2] > 190 && pixel.stdout[0] < 40, [...pixel.stdout])
  assert.equal(requests.filter(([, init]) => init.headers.range).length, 4)
  assert.ok(requests.filter(([, init]) => init.headers.range).every(([, init]) => !init.headers.range.endsWith('-')))
})

function clipFixture(t) {
  const id = 'bili-test-session'
  const session = { id, header: {}, surface: { nodes: [] } }
  const agent = { id, session, options: { provider: 'fixture', model: 'test' } }
  const state = { bound: { contextId: BILIBILI_CONTEXT, kind: 'topic', sessionId: id }, agent, image: true }
  const events = new Map()
  const receipts = []
  const samples = []
  const info = []
  const ctx = {
    agents: { get: () => state.agent },
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    get(name) {
      assert.equal(name, 'attachments')
      return { async saveImages([image]) {
        if (state.failAttachment) throw new Error('disk unavailable')
        return [{ attachmentId: 'sha256:fixture', mediaType: image.mediaType, bytes: image.data.length, name: image.name }]
      } }
    },
    llm: { async resolveModelInfo(...args) { info.push(args); return { inputModalities: state.image ? ['text', 'image'] : ['text'] } } },
  }
  t.after(registerBilibiliClipInput(ctx, {
    store: { bindingByContext: () => state.bound, recordActivity: record => receipts.push(record) },
    bilibili: { async sampleClip(...args) {
      samples.push(args)
      if (state.sample) return state.sample(...args)
      return { title: '隔离视频', picture: args[1] ? Buffer.from('jpeg') : undefined, transcript: '隔离听到的内容',
        visual: args[1] ? { status: 'sampled' } : { status: 'unavailable', reason: 'bili-clip-vision-unavailable' }, audio: { status: 'sampled' } }
    } },
  }))
  const emit = (type, data, surfaceOp) => events.get('session/event')(session, { type, data, surfaceOp })
  const message = (text = explicit, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] })
  function prime(claims = [message()], turn = 1) {
    emit('turn/start', { turn })
    for (const message of claims) events.get('agent/inbox/claimed')({ agent, message, turn })
    return async ({ admitted = claims, signal: turnSignal = signal, step = 1, reject = false } = {}) =>
      events.get('agent/pre-step')({ agent, messages: claims, turn, step, signal: turnSignal },
        async () => reject ? { kind: 'reject' } : { kind: 'accept', messages: admitted })
  }
  function admit(messages, turn = 1) {
    emit('step/start', { turn, step: 1 })
    for (const message of messages) emit('user/message', message, 'append')
  }
  return { session, state, info, samples, receipts, message, prime, emit, admit }
}

test('first model step receives exact requested material and only native admission creates the receipt', async t => {
  const h = clipFixture(t)
  const preStep = h.prime()
  const { messages } = await preStep()
  assert.equal(messages.length, 2)
  assert.deepEqual(h.samples[0].slice(0, 2), [input, true])
  assert.equal(h.receipts.length, 0)
  assert.equal(messages[1].source.form, 'sample')
  assert.deepEqual(JSON.parse(messages[1].content[0].text).url, `https://www.bilibili.com/video/${bvid}/?p=1&t=12`)
  assert.ok(messages[1].content[0].text.includes('隔离听到的内容'))
  assert.equal(messages[1].content[1].type, 'image')
  assert.equal((await preStep()).messages.length, 1)
  h.admit(messages)
  h.admit(messages)
  assert.equal(h.receipts.length, 1)
  const receipt = h.receipts[0]
  assert.deepEqual(receipt.data, { bvid, part: 1, start: 12, seconds: 6, visual: true, audio: true })
  const view = projectHome({ now: new Date(), presence: 'idle', minecraft: false, speaking: false, quiet: false,
    bindings: [h.state.bound], runningSessions: new Set(), activities: [{ ...receipt, occurredAt: new Date().toISOString() }] })
  assert.equal(view.recent[0].kind, 'video')
})

test('paired audio request bypasses vision lookup and a changed delivery cannot record a receipt', async t => {
  const h = clipFixture(t)
  const claim = h.message(`看这段 ${bvid} 0 1秒 声音`, { kind: 'companion-mobile', form: 'relay' })
  const { messages } = await h.prime([claim])()
  assert.equal(h.info.length, 0)
  assert.deepEqual(h.samples[0].slice(0, 2), [{ bvid, part: 1, start: 0, seconds: 1, mode: 'audio' }, false])
  assert.equal(messages[1].content.length, 1)
  h.admit([claim, { ...messages[1], content: [{ type: 'text', text: '被替换的内容' }] }])
  assert.equal(h.receipts.length, 0)
})

test('clip admission does not fetch without a single unchanged current owner instruction', async t => {
  for (const kind of ['vague', 'synthetic', 'rewritten', 'overwritten', 'wrong-step', 'delegate', 'depth', 'rebound',
    'no-agent', 'rejected', 'cancelled', 'multiple-claims', 'missing-owner-admission', 'new-owner-admission', 'attached-command']) {
    await t.test(kind, async t => {
      const h = clipFixture(t)
      let claim = h.message()
      if (kind === 'vague') claim = h.message(`上次我提过 ${bvid}`)
      if (kind === 'synthetic') claim = h.message(explicit, { kind: 'companion-world', form: 'minecraft-event' })
      if (kind === 'attached-command') claim = { ...claim, content: [...claim.content, { type: 'image', attachment: { attachmentId: 'sample' } }] }
      const claims = kind === 'multiple-claims' ? [claim, h.message()] : [claim]
      const preStep = h.prime(claims)
      const options = {}
      if (kind === 'rewritten') options.admitted = [h.message()]
      if (kind === 'overwritten') options.admitted = [{ ...claim, content: [{ type: 'text', text: '其他任务' }] }]
      if (kind === 'wrong-step') options.step = 2
      if (kind === 'rebound') h.state.bound = { ...h.state.bound, sessionId: 'other' }
      if (kind === 'no-agent') h.state.agent = undefined
      if (kind === 'delegate') h.session.header.origin = 'subagent'
      if (kind === 'depth') h.session.header.delegationDepth = 1
      if (kind === 'rejected') options.reject = true
      if (kind === 'cancelled') options.signal = AbortSignal.abort()
      if (kind === 'missing-owner-admission') options.admitted = []
      if (kind === 'new-owner-admission') options.admitted = [...claims, h.message()]
      await preStep(options)
      assert.equal(h.samples.length, 0)
      assert.equal(h.receipts.length, 0)
    })
  }
})

test('visionless route can receive audio and a late rebind or abort suppresses pending material', async t => {
  const h = clipFixture(t)
  h.state.image = false
  const { messages } = await h.prime()()
  assert.equal(messages[1].content.length, 1)
  assert.equal(JSON.parse(messages[1].content[0].text).visual.reason, 'bili-clip-vision-unavailable')
  h.admit(messages)
  assert.equal(h.receipts[0].data.visual, false)
  for (const kind of ['rebind', 'abort']) await t.test(kind, async t => {
    const h = clipFixture(t)
    const controller = new AbortController()
    h.state.sample = async () => {
      if (kind === 'rebind') h.state.bound = undefined
      else controller.abort()
      return { transcript: '迟到的片段' }
    }
    const { messages } = await h.prime()({ signal: controller.signal })
    assert.equal(messages.length, 1)
    h.admit(messages)
    assert.equal(h.receipts.length, 0)
  })
})

test('clip fetch failures send a compact explanation without claiming a reading or leaking the exception', async t => {
  const h = clipFixture(t)
  h.state.sample = async () => { throw Object.assign(new Error('private details'), { code: 'bili-upstream-paused' }) }
  const { messages } = await h.prime()()
  assert.equal(messages[1].source.form, 'unavailable')
  assert.match(messages[1].content[0].text, /bili-upstream-paused/u)
  assert.doesNotMatch(messages[1].content[0].text, /private details/u)
  h.admit(messages)
  assert.equal(h.receipts.length, 0)
})

test('a failed image save leaves available audio and reports why the picture is missing', async t => {
  const h = clipFixture(t)
  h.state.failAttachment = true
  const { messages } = await h.prime()()
  assert.equal(messages[1].content.length, 1)
  assert.match(messages[1].content[0].text, /bili-clip-attachments-unavailable/u)
  h.admit(messages)
  assert.equal(h.receipts[0].data.visual, false)
  assert.equal(h.receipts[0].data.audio, true)
})

test('later requests keep only a clip source receipt while native logs retain the original material', () => {
  const session = Session.create(SessionId('bili-surface-qa'))
  const original = createUserMessage({ content: [{ type: 'text', text: 'PRIVATE-ORIGINAL-ASR' }],
    source: { kind: 'companion-bili-clip', form: 'sample', clip: input } })
  session.append('user/message', original, { surfaceOp: 'append' })
  retainBilibiliClipReceipts(session)
  const count = session.seq
  retainBilibiliClipReceipts(session)
  assert.equal(session.seq, count)
  assert.ok(session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === original.id))
  const [receipt] = session.deriveMessages()
  assert.equal(receipt.source.form, 'receipt')
  assert.match(receipt.content[0].text, /BV1dLx46TEhw.*12 秒.*6 秒/u)
  assert.ok(!receipt.content[0].text.includes('PRIVATE-ORIGINAL-ASR'))
})
