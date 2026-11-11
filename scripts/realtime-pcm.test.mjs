import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setImmediate, setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerAvatarHttp } from '../src/host/avatar-http.ts'
import { RealtimePcmProvider } from '../src/host/realtime-pcm.ts'
import { RealtimeVoiceService } from '../src/host/realtime-voice.ts'

const STAGE = '11111111-1111-4111-8111-111111111111'
const OTHER_STAGE = '22222222-2222-4222-8222-222222222222'
const MESSAGE = '你好。'.repeat(70)
const OPENAI = { protocol: 'openai', model: 'local-tts', voice: 'whale', timeoutMs: 5000 }
const GPT = { protocol: 'gpt-sovits-v2', referenceAudio: '/private/whale.wav', referenceText: '固定样本台词。', referenceLanguage: 'zh' }
const PCM = Buffer.from([0, 0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 24, 30, 34, 36, 38, 40, 42])

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, upstream, options = {}) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/realtime-pcm-test-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const calls = []
  const ports = []
  const upstreamOrigin = await listen(t, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ method: req.method, url: req.url, input: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined, authorization: req.headers.authorization })
    ports.push(req.socket.remotePort)
    upstream(res, calls.length, req)
  })
  const pcm = new RealtimePcmProvider({ ...OPENAI, endpoint: `${upstreamOrigin}/${options.protocol === 'voxweft' ? 'generate' : 'speech'}`, ...options })
  const context = store.bindContext({ contextId: 'chat.voice', sessionId: 'voice-session', label: '语音', kind: 'chat' })
  const history = t.mock.fn(async () => ({ sessionId: context.sessionId, messages: [{ id: 'assistant-1', role: 'assistant', text: MESSAGE }] }))
  const avatar = { view: () => ({ presentation: { ready: true } }) }
  const synthesizeClip = t.mock.fn(async () => {
    const task = store.createTask({ capabilityId: 'media.tts', title: 'WAV fallback' })
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
    return task
  })
  const voice = new RealtimeVoiceService(store, { history }, { synthesizeClip }, avatar, undefined, pcm)
  t.after(async () => { await voice.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  let handler
  let origin
  registerAvatarHttp({ webServer: { getOrigin: () => origin, register: route => { handler = route.handler; return () => {} } } }, avatar, voice)
  origin = await listen(t, handler)
  const base = `${origin}/companion/avatar/api/realtime`
  const request = (suffix, payload, init = {}) => fetch(`${base}${suffix}`, {
    method: payload ? 'POST' : 'GET',
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    ...init,
    headers: { 'x-companion-request': '1', 'content-type': 'application/json', ...init.headers },
  })
  const start = async options => (await (await request('/start', { contextId: context.contextId, ...options })).json()).session
  const url = (session, index = 0, stage = STAGE) => `/stream/${session.id}/${index}?stageId=${stage}`
  const receipt = (session, segmentIndex, status, stageId = STAGE) => request('/receipt', { sessionId: session.id, segmentIndex, status, stageId })
  return { base, calls, context, history, ports, receipt, request, start, store, synthesizeClip, url, voice }
}

test('accepts exact loopback HTTP endpoints and fixed credentials-free provider configuration', () => {
  for (const endpoint of [
    'http://localhost:8000/speech', 'http://127.0.0.2:8000/speech', 'https://127.0.0.1/speech',
    'http://127.0.0.1/', 'http://user@127.0.0.1/speech', 'http://127.0.0.1/speech?token=x', 'http://127.0.0.1/speech#x', 'invalid',
  ]) assert.throws(() => new RealtimePcmProvider({ ...OPENAI, endpoint }), /exact loopback/u)
  const endpoint = 'http://[::1]:8000/speech'
  assert.throws(() => new RealtimePcmProvider({ ...OPENAI, endpoint, voice: '' }), /fixed model and voice/u)
  assert.throws(() => new RealtimePcmProvider({ ...OPENAI, endpoint, sampleRate: 50_000 }), /sample rate/u)
  assert.throws(() => new RealtimePcmProvider({ ...OPENAI, ...GPT, endpoint, referenceAudio: 'relative.wav' }), /reference voice/u)
  assert.equal(new RealtimePcmProvider({ ...OPENAI, endpoint }).sampleRate, 24_000)
  assert.equal(new RealtimePcmProvider({ ...OPENAI, ...GPT, endpoint }).sampleRate, 48_000)
  assert.equal(new RealtimePcmProvider({ ...OPENAI, ...GPT, endpoint, sampleRate: 32_000 }).sampleRate, 32_000)
  assert.throws(() => new RealtimePcmProvider({ ...OPENAI, endpoint, protocol: 'voxweft' }), /requires \/generate/u)
})

test('VoxWeft checks the named clone and refuses to synthesize in a fallback voice', async t => {
  let loaded = false
  const h = await fixture(t, (res, _count, req) => {
    if (req.url === '/voices') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        voices: [{ external_id: loaded ? 'deepseek-whale' : 'wrong-voice' }],
      }))
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PCM)
    }
  }, { protocol: 'voxweft', voice: 'deepseek-whale' })
  const missing = await h.start()
  assert.equal((await h.request(h.url(missing))).status, 502)
  assert.equal(h.voice.view().session.error, 'voice-stream-voice-unavailable')
  assert.deepEqual(h.calls.map(call => call.method), ['GET'])
  loaded = true
  const session = await h.start()
  const response = await h.request(h.url(session))
  assert.equal(response.headers.get('x-companion-sample-rate'), '48000')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM)
  assert.deepEqual(h.calls.slice(1).map(({ method, url, input }) => [method, url, input]), [
    ['GET', '/voices', undefined],
    ['POST', '/generate', { target_text: session.segments[0].text, voice: 'deepseek-whale', stream: true }],
  ])
})

test('streams aligned PCM before provider EOF, pins the stage and verifies ordered receipts without WAV jobs', { timeout: 8000 }, async t => {
  const release = Promise.withResolvers()
  const h = await fixture(t, (res, count) => {
    res.writeHead(200, { 'content-type': 'audio/pcm; rate="24000"; channels=1; format=s16le' })
    if (count === 1) {
      res.write(PCM.subarray(0, 13))
      void release.promise.then(() => res.end(PCM.subarray(13)))
    } else res.end(PCM)
  })
  const session = await h.start()
  assert.equal(h.voice.view().streamingAvailable, true)
  assert.equal(session.streaming, true)
  assert.equal(session.segments.length, 2)
  assert.ok(session.segments.every(segment => segment.status === 'ready' && segment.taskId === undefined))
  assert.equal((await fetch(`${h.base}${h.url(session)}`)).status, 403)
  assert.equal((await h.request(h.url(session), undefined, { headers: { origin: 'https://outside.example' } })).status, 403)
  assert.equal((await h.request(`${h.url(session)}&text=private`)).status, 400)
  assert.equal((await h.request(h.url({ id: OTHER_STAGE }))).status, 404)
  assert.equal((await h.request(h.url(session, 1))).status, 409)
  assert.equal((await h.receipt(session, 0, 'playing')).status, 409)
  assert.equal(h.calls.length, 0)

  const response = await h.request(h.url(session), undefined, { headers: { authorization: 'ignored-client-credential' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('x-companion-sample-rate'), '24000')
  assert.match(response.headers.get('cache-control'), /no-store/u)
  assert.deepEqual(h.calls, [{ method: 'POST', url: '/speech', input: { model: 'local-tts', voice: 'whale', input: session.segments[0].text, response_format: 'pcm' }, authorization: undefined }])
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.deepEqual(Buffer.from(first.value), PCM.subarray(0, 12))
  assert.equal(h.voice.view().streamStageId, STAGE)
  assert.equal(h.voice.view().playbackStageId, undefined)
  assert.equal((await h.request(h.url(session))).status, 409)
  assert.equal((await h.request(h.url(session, 0, OTHER_STAGE))).status, 409)
  assert.equal((await h.receipt(session, 0, 'playing', OTHER_STAGE)).status, 409)
  assert.equal((await h.receipt(session, 0, 'playing')).status, 200)
  assert.equal((await h.receipt(session, 0, 'completed')).status, 409)
  assert.equal(h.store.taskById(session.taskId).status, 'running')
  release.resolve()
  const second = await reader.read()
  assert.deepEqual(Buffer.concat([first.value, second.value]), PCM)
  assert.equal((await reader.read()).done, true)
  assert.equal((await h.receipt(session, 0, 'completed')).status, 200)

  const next = await h.request(h.url(session, 1))
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), PCM)
  assert.equal((await h.receipt(session, 1, 'playing')).status, 200)
  assert.equal((await h.receipt(session, 1, 'completed')).status, 200)
  assert.equal((await h.request(h.url(session, 1))).status, 409)
  assert.equal(h.store.taskById(session.taskId).status, 'succeeded')
  assert.equal(h.synthesizeClip.mock.callCount(), 0)
  assert.deepEqual(h.store.tasks().map(task => task.capabilityId), ['media.realtime'])
  assert.equal(new Set(h.ports).size, 1)
})

test('auto-read starts directly with fixed GPT-SoVITS streaming voice; manual WAV opt-out reuses clip jobs', async t => {
  const h = await fixture(t, res => res.writeHead(200, { 'content-type': 'audio/raw' }).end(PCM), GPT)
  h.voice.enableAutoRead(h.context.contextId, STAGE)
  h.voice.observe(h.context, { type: 'assistant/message', seq: 1, data: { turn: 1, message: { id: 'auto-1', content: [{ type: 'text', text: '你好，大肥鱼。' }] } } })
  h.voice.observe(h.context, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(h.voice.pollAutoRead(STAGE), { enabled: true, pending: false, started: true })
  assert.equal(h.voice.view().playbackStageId, STAGE)
  const auto = h.voice.view().session
  assert.equal((await h.request(h.url(auto, 0, OTHER_STAGE))).status, 409)
  const response = await h.request(h.url(auto))
  assert.equal(response.headers.get('x-companion-sample-rate'), '48000')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM)
  assert.deepEqual(h.calls[0].input, {
    text: '你好，大肥鱼。', text_lang: 'zh', ref_audio_path: GPT.referenceAudio, prompt_text: GPT.referenceText,
    prompt_lang: 'zh', text_split_method: 'cut0', gpt_streaming: true, streaming_mode: 2, batch_size: 1, media_type: 'raw',
  })
  assert.equal((await h.receipt(auto, 0, 'playing')).status, 200)
  assert.equal((await h.receipt(auto, 0, 'completed')).status, 200)
  const manual = await h.start({ streaming: false })
  assert.equal(manual.streaming, undefined)
  assert.equal((await h.request(h.url(manual))).status, 404)
  await setImmediate()
  assert.equal(h.synthesizeClip.mock.callCount(), 2)
  assert.equal(h.voice.view().session.segments[0].status, 'ready')
  assert.ok(h.voice.view().session.segments[0].taskId)
  assert.equal(h.calls.length, 1)
})

test('stop aborts upstream even before its first PCM, and requires the bound stage cancel receipt', { timeout: 8000 }, async t => {
  const connecting = Promise.withResolvers()
  const disconnected = Promise.withResolvers()
  const h = await fixture(t, res => {
    res.once('close', disconnected.resolve)
    connecting.resolve()
  })
  const session = await h.start()
  const stream = h.request(h.url(session))
  await connecting.promise
  const cancelling = await h.request('/cancel', { sessionId: session.id })
  assert.equal((await cancelling.json()).session.status, 'cancelling')
  await disconnected.promise
  assert.equal((await stream).status, 502)
  assert.equal((await h.receipt(session, 0, 'error')).status, 409)
  assert.equal((await h.receipt(session, 0, 'cancelled', OTHER_STAGE)).status, 409)
  assert.equal((await h.receipt(session, 0, 'cancelled')).status, 200)
  assert.equal(h.store.taskById(session.taskId).status, 'cancelled')
})

test('client disconnect aborts provider immediately; cancel handshake wins and abandoned streams settle', { timeout: 8000 }, async t => {
  const dropped = [Promise.withResolvers(), Promise.withResolvers()]
  const h = await fixture(t, (res, count) => {
    res.once('close', dropped[count - 1].resolve)
    res.writeHead(200, { 'content-type': 'audio/pcm' }).write(PCM)
  })
  for (const [index, closed] of dropped.entries()) {
    const session = await h.start()
    const controller = new AbortController()
    const response = await h.request(h.url(session), undefined, { signal: controller.signal })
    assert.equal(response.status, 200)
    controller.abort()
    await closed.promise
    if (index === 0) {
      await h.request('/cancel', { sessionId: session.id })
      await h.receipt(session, 0, 'cancelled')
      assert.equal(h.store.taskById(session.taskId).status, 'cancelled')
    } else {
      for (let n = 0; n < 40 && h.voice.view().session.status !== 'failed'; n++) await setTimeout(50)
      assert.equal(h.voice.view().session.error, 'voice-stream-disconnected')
      assert.equal(h.store.taskById(session.taskId).status, 'failed')
    }
  }
})

test('rejects non-PCM, oversized, redirect and stalled provider responses before sending audio', { timeout: 8000 }, async t => {
  const variants = [
    { headers: { 'content-type': 'audio/wav' }, body: PCM, error: 'voice-stream-invalid-format' },
    { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('RIFFxxxxWAVE'), error: 'voice-stream-invalid-format' },
    { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '16000' }, body: PCM, error: 'voice-stream-invalid-format' },
    { headers: { 'content-type': 'audio/pcm' }, body: Buffer.alloc(0), error: 'voice-stream-invalid-format' },
    { headers: { 'content-type': 'audio/pcm', 'content-length': '2880002' }, body: PCM, error: 'voice-stream-too-large' },
    { status: 302, headers: { location: '/other' }, body: '', error: 'voice-stream-provider-status' },
    { error: 'voice-stream-timeout' },
  ]
  const h = await fixture(t, (res, count) => {
    const { headers, status, body } = variants[count - 1]
    if (headers) res.writeHead(status ?? 200, headers).end(body)
  }, { timeoutMs: 1000 })
  for (const { error } of variants) {
    const session = await h.start()
    const response = await h.request(h.url(session))
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error })
    assert.equal(h.voice.view().session.error, error)
    assert.equal(h.store.taskById(session.taskId).status, 'failed')
  }
  assert.equal(h.calls.length, variants.length)
  assert.equal(h.synthesizeClip.mock.callCount(), 0)
})

test('invalid trailing sample destroys a previously audible stream instead of sending successful EOF', { timeout: 8000 }, async t => {
  const release = Promise.withResolvers()
  const h = await fixture(t, res => {
    res.writeHead(200, { 'content-type': 'audio/pcm' }).write(PCM)
    void release.promise.then(() => res.end(Buffer.from([42])))
  })
  const session = await h.start()
  const response = await h.request(h.url(session))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  assert.deepEqual(Buffer.from((await reader.read()).value), PCM)
  release.resolve()
  await assert.rejects(reader.read())
  assert.equal(h.voice.view().session.error, 'voice-stream-invalid-format')
  assert.equal(h.store.taskById(session.taskId).status, 'failed')
})

test('a stage playback error or service shutdown aborts an active provider stream', { timeout: 8000 }, async t => {
  const dropped = [Promise.withResolvers(), Promise.withResolvers()]
  const h = await fixture(t, (res, count) => {
    res.once('close', dropped[count - 1].resolve)
    res.writeHead(200, { 'content-type': 'audio/pcm' }).write(PCM)
  })
  for (const [index, closed] of dropped.entries()) {
    const session = await h.start()
    const response = await h.request(h.url(session))
    const reader = response.body.getReader()
    assert.deepEqual(Buffer.from((await reader.read()).value), PCM)
    if (index === 0) assert.equal((await h.receipt(session, 0, 'error')).status, 200)
    else await h.voice.close()
    await assert.rejects(reader.read())
    await closed.promise
    assert.equal(h.store.taskById(session.taskId).status, index === 0 ? 'failed' : 'cancelled')
  }
})

test('lost playback, next segment and stop receipts expire even when another stage is online', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const h = await fixture(t, res => res.writeHead(200, { 'content-type': 'audio/pcm' }).end(PCM))
  for (const next of [false, true]) {
    const session = await h.start()
    const response = await h.request(h.url(session))
    await response.arrayBuffer()
    assert.equal((await h.receipt(session, 0, 'playing')).status, 200)
    if (next) assert.equal((await h.receipt(session, 0, 'completed')).status, 200)
    t.mock.timers.tick(5002)
    assert.equal(h.voice.view().session.error, 'voice-stream-receipt-timeout')
    assert.equal(h.store.taskById(session.taskId).status, 'failed')
  }
  const session = await h.start()
  await h.request('/cancel', { sessionId: session.id })
  t.mock.timers.tick(5001)
  assert.equal(h.voice.view().session.error, 'voice-stop-unconfirmed')
  assert.equal(h.store.taskById(session.taskId).status, 'failed')
})
