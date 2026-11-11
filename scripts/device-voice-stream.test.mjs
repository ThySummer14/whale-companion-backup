import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerAvatarHttp } from '../src/host/avatar-http.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { RealtimePcmProvider } from '../src/host/realtime-pcm.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'

const CONTEXT = 'chat.phone'
const SESSION = 'test-phone-session'
const STAGE = '11111111-1111-4111-8111-111111111111'
const TEXT = '  你好，大肥鱼。  '
const PCM = Buffer.from([0, 0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 24, 30, 34, 36, 38, 40, 42])
const assistant = (id, text) => ({ type: 'assistant/message', data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } } })
const REQUEST = { contextId: CONTEXT, messageId: 'assistant' }

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, upstream, { readEvents, timeoutMs = 3000 } = {}) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/device-voice-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const calls = []
  let pcm
  if (upstream) {
    const local = await listen(t, async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      calls.push({ input: JSON.parse(Buffer.concat(chunks)), authorization: req.headers.authorization })
      upstream(res, calls.length)
    })
    pcm = new RealtimePcmProvider({ endpoint: `${local}/speech`, protocol: 'openai', model: 'test-model', voice: 'test-whale', timeoutMs })
  }
  store.bindContext({ contextId: CONTEXT, sessionId: SESSION, label: 'Phone', kind: 'chat' })
  const agents = { get: t.mock.fn(() => { throw new Error('PCM must not wake an agent') }) }
  const closeHandle = t.mock.fn(async () => {})
  const read = t.mock.fn(readEvents ?? (async () => ({ events: [assistant('assistant', TEXT), assistant('long', '字'.repeat(241)), assistant('empty', '   '), { type: 'user/message', data: { message: { id: 'user', role: 'user', content: [{ type: 'text', text: '私人文字' }] } } }] })))
  const stat = t.mock.fn(async () => ({ eventCount: 5000 }))
  const open = t.mock.fn(async () => ({ read, close: closeHandle }))
  let origin
  const routes = new Map()
  const ctx = { agents, sessionPersistence: { stat, open }, webServer: { getOrigin: () => origin, register: route => { routes.set(route.path, route.handler); return () => {} } } }
  const options = { provider: 'piper', pythonPath: '/unavailable/python', modelPath: '/unavailable/model', mediaDir: join(directory, 'media', 'voice'), timeoutMs: 5000 }
  const runtime = new CompanionRuntime(ctx, store, 'test', options, join(directory, 'media'), directory, directory, directory, 'owner', pcm)
  const devices = new DeviceService(ctx, store, id => runtime.devicePlayback.revoke(id))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await runtime.close()
  }
  t.after(async () => { devices.close(); await stop(); rmSync(directory, { recursive: true, force: true }) })
  registerDeviceHttp(ctx, runtime, devices)
  registerAvatarHttp(ctx, runtime.avatar, runtime.realtimeVoice)
  origin = await listen(t, (req, res) => {
    const route = [...routes.keys()].find(path => req.url.startsWith(`${path}/`))
    return routes.get(route)(req, res)
  })
  const pair = () => devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const device = pair()
  const post = (path, payload, { credential = device.credential, signal, headers = {} } = {}) => fetch(`${origin}/companion-device/api/${path}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', ...(credential ? { authorization: credential } : {}), ...headers }, body: JSON.stringify(payload),
  })
  const request = (payload = REQUEST, { suffix = '', ...options } = {}) => post(`voice-stream${suffix}`, payload, options)
  const management = (path, payload) => fetch(`${origin}${path}`, {
    method: payload ? 'POST' : 'GET', headers: { 'x-companion-request': '1', 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
  return { agents, calls, closeHandle, device, devices, management, open, pair, post, read, request, runtime, stat, stop, store }
}

test('streams persisted assistant text to a paired device before provider EOF and creates no media or jobs', { timeout: 8000 }, async t => {
  const release = Promise.withResolvers()
  const h = await fixture(t, res => {
    res.writeHead(200, { 'content-type': 'audio/pcm;rate=24000' }).write(PCM.subarray(0, 13))
    void release.promise.then(() => res.end(PCM.subarray(13)))
  })
  const response = await h.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('x-companion-sample-rate'), '24000')
  assert.equal(response.headers.get('x-companion-playback-id'), null)
  assert.match(response.headers.get('cache-control'), /no-store/u)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.deepEqual(Buffer.from(first.value), PCM.subarray(0, 12))
  assert.deepEqual(h.calls, [{ input: { model: 'test-model', voice: 'test-whale', input: TEXT.trim(), response_format: 'pcm' }, authorization: undefined }])
  assert.deepEqual(h.open.mock.calls[0].arguments.slice(0, 2), [SESSION, 'read'])
  assert.deepEqual(h.read.mock.calls[0].arguments.slice(0, 2), [904, 4096])
  assert.equal(h.closeHandle.mock.callCount(), 1)
  assert.equal(h.agents.get.mock.callCount(), 0)
  assert.deepEqual(h.store.tasks(), [])
  assert.deepEqual(h.store.media.list(), [])
  release.resolve()
  const second = await reader.read()
  assert.deepEqual(Buffer.concat([first.value, second.value]), PCM)
  assert.equal((await reader.read()).done, true)
})

test('first PCM can authorize playback, but only the paired phone receipt changes Home', async t => {
  const h = await fixture(t, res => res.writeHead(200, { 'content-type': 'audio/pcm' }).end(PCM))
  h.agents.get.mock.mockImplementation(() => ({ status: 'idle' }))
  const oldHome = h.runtime.homeLive().activity
  const headers = { 'x-companion-playback-client': 'ab'.repeat(16) }
  const unknown = await h.request({ ...REQUEST, messageId: 'unknown' }, { headers })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers.get('x-companion-playback-id'), null)
  const stream = await h.request(REQUEST, { headers })
  const id = stream.headers.get('x-companion-playback-id')
  assert.match(id, /^[a-f0-9-]{36}$/u)
  assert.deepEqual(Buffer.from(await stream.arrayBuffer()), PCM)
  assert.equal(h.runtime.homeLive().activity, oldHome)

  const receipt = { id, sequence: 1, state: 'playing' }
  const report = (value, options) => h.post('audio-playback', value, options)
  assert.equal((await report(receipt, { credential: null })).status, 401)
  assert.equal((await report(receipt, { credential: h.pair().credential })).status, 404)
  assert.equal((await report({ ...receipt, sequence: 0 })).status, 400)
  assert.equal((await report({ ...receipt, kind: 'singing' })).status, 400)
  assert.equal((await report({ ...receipt, state: 'fake' })).status, 400)
  assert.equal((await h.post('audio-playback?fake=1', receipt)).status, 400)
  assert.equal((await (await report({ ...receipt, id: 'a'.repeat(1000) })).json()).code, 'body-too-large')
  assert.equal(h.runtime.homeLive().activity, oldHome)
  assert.deepEqual(await (await report(receipt)).json(), { ok: true })
  const live = h.runtime.homeLive()
  assert.deepEqual(live, { version: 1, activity: 'speaking', anchor: 'stage', activeSite: 'studio', observedAt: live.observedAt })
  assert.equal(h.runtime.homeActivity(), 'speaking')
  assert.equal(h.runtime.realtimeVoice.homeSpeaking(Date.now()), false)

  assert.equal((await report({ ...receipt, state: 'paused' })).status, 200)
  assert.equal((await report(receipt)).status, 200)
  assert.equal(h.runtime.homeLive().activity, oldHome)
  assert.equal((await report({ ...receipt, sequence: 2 })).status, 200)
  assert.equal(h.runtime.homeLive().activity, 'speaking')
  assert.equal(h.devices.revoke(h.device.device.id), true)
  assert.equal(h.runtime.homeLive().activity, oldHome)
  assert.equal((await report({ ...receipt, sequence: 3 })).status, 401)
  assert.deepEqual(h.store.tasks(), [])
  assert.deepEqual(h.store.media.list(), [])
})

test('rejects missing credentials, unbound, user, empty and over-limit messages and client synthesis options', async t => {
  const h = await fixture(t, () => { throw new Error('The provider must not be called') })
  assert.equal((await h.request(REQUEST, { credential: null })).status, 401)
  assert.equal((await h.request(REQUEST, { credential: 'Device invalid.value' })).status, 401)
  assert.equal((await h.request({ ...REQUEST, contextId: 'chat.other' })).status, 404)
  for (const id of ['unknown', 'user', 'empty']) assert.equal((await h.request({ ...REQUEST, messageId: id })).status, 404)
  assert.equal((await h.request({ ...REQUEST, messageId: 'long' })).status, 422)
  assert.equal((await h.request({ ...REQUEST, text: 'arbitrary' })).status, 400)
  assert.equal((await h.request({ ...REQUEST, voice: 'arbitrary' })).status, 400)
  assert.equal((await h.request(REQUEST, { suffix: '?text=arbitrary' })).status, 400)
  assert.equal(h.calls.length, 0)
})

test('returns 404 without a PCM provider and does not open persisted history', async t => {
  const h = await fixture(t)
  const response = await h.request()
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'voice-stream-unavailable', code: 'voice-stream-unavailable' })
  assert.equal(h.open.mock.callCount(), 0)
})

test('can read recent JSONL replies without an event count and refuses oversized logs', async t => {
  const events = Array.from({ length: 4200 }, () => ({ type: 'user/message' }))
  events.push(assistant('assistant', TEXT))
  const h = await fixture(t, res => res.writeHead(200, { 'content-type': 'audio/pcm' }).end(PCM), {
    readEvents: async (offset, length) => ({ events: events.slice(offset, length === undefined ? undefined : offset + length) }),
  })
  h.stat.mock.mockImplementation(async () => ({ sizeBytes: 200_000 }))
  const response = await h.request()
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM)
  assert.deepEqual(h.read.mock.calls[0].arguments.slice(0, 2), [0, undefined])
  h.stat.mock.mockImplementation(async () => ({ sizeBytes: 17 * 1024 * 1024 }))
  const oversized = await h.request()
  assert.equal(oversized.status, 503)
  assert.equal((await oversized.json()).code, 'voice-stream-history-too-large')
  assert.equal(h.open.mock.callCount(), 1)
  assert.equal(h.calls.length, 1)
})

test('holds one PCM slot across paired devices and Live2D and releases it after interruption', { timeout: 8000 }, async t => {
  const closed = Promise.withResolvers()
  const h = await fixture(t, (res, count) => {
    res.writeHead(200, { 'content-type': 'audio/pcm' })
    if (count > 1) return res.end(PCM)
    res.once('close', closed.resolve)
    res.write(PCM)
  })
  const other = h.pair()
  const client = new AbortController()
  const stream = await h.request(REQUEST, { signal: client.signal })
  assert.equal(stream.status, 200)
  assert.equal((await h.request()).status, 409)
  assert.equal((await h.request(REQUEST, { credential: other.credential })).status, 409)
  assert.equal(h.open.mock.callCount(), 1)
  h.runtime.avatar.heartbeat({ ready: true, frames: 1, nonFinite: 0 })
  const binding = h.store.bindingByContext(CONTEXT)
  h.runtime.realtimeVoice.enableAutoRead(CONTEXT, STAGE)
  h.runtime.realtimeVoice.observe(binding, { ...assistant('stage', '舞台测试。'), seq: 1, data: { ...assistant('stage', '舞台测试。').data, turn: 1 } })
  h.runtime.realtimeVoice.observe(binding, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  h.runtime.realtimeVoice.pollAutoRead(STAGE)
  const stage = h.runtime.realtimeVoice.view().session
  const stageResponse = await h.management(`/companion/avatar/api/realtime/stream/${stage.id}/0?stageId=${STAGE}`)
  assert.equal(stageResponse.status, 409)
  assert.equal(h.calls.length, 1)
  client.abort()
  await closed.promise
  const retry = await h.request(REQUEST, { credential: other.credential })
  assert.deepEqual(Buffer.from(await retry.arrayBuffer()), PCM)
  assert.equal(h.calls.length, 2)
})

test('revocation aborts an active provider and returns device-unauthorized before any audio', { timeout: 8000 }, async t => {
  const reached = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const h = await fixture(t, res => { res.once('close', closed.resolve); reached.resolve() })
  const pending = h.request()
  await reached.promise
  assert.equal((await h.management('/companion/api/devices/revoke', { id: h.device.device.id })).status, 200)
  const response = await pending
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'device-unauthorized', code: 'device-unauthorized' })
  await closed.promise
  assert.equal((await h.request()).status, 401)
})

test('does not forward stale context data when the binding changes during history lookup', async t => {
  const reading = Promise.withResolvers()
  const release = Promise.withResolvers()
  const h = await fixture(t, () => { throw new Error('The provider must not be called') }, {
    readEvents: async () => { reading.resolve(); await release.promise; return { events: [assistant('assistant', TEXT)] } },
  })
  const pending = h.request()
  await reading.promise
  h.store.bindContext({ contextId: CONTEXT, sessionId: 'different-session', label: 'Phone', kind: 'chat' })
  release.resolve()
  assert.equal((await pending).status, 409)
  assert.equal(h.closeHandle.mock.callCount(), 1)
  assert.equal(h.calls.length, 0)
})

test('reports failure and timeout before audio, and destroys transport after a malformed trailing sample', { timeout: 8000 }, async t => {
  const release = Promise.withResolvers()
  const h = await fixture(t, (res, count) => {
    if (count === 1) return res.writeHead(500).end('Private provider error')
    if (count === 2) return
    res.writeHead(200, { 'content-type': 'audio/pcm' }).write(PCM)
    void release.promise.then(() => res.end(Buffer.from([42])))
  }, { timeoutMs: 1000 })
  const failed = await h.request()
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).code, 'voice-stream-provider-status')
  const stalled = await h.request()
  assert.equal(stalled.status, 503)
  assert.equal((await stalled.json()).code, 'voice-stream-timeout')
  const started = await h.request()
  assert.equal(started.status, 200)
  const reader = started.body.getReader()
  assert.deepEqual(Buffer.from((await reader.read()).value), PCM)
  release.resolve()
  await assert.rejects(reader.read())
})

test('runtime shutdown cancels device PCM without waiting for the provider deadline', { timeout: 8000 }, async t => {
  const reached = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const h = await fixture(t, res => { res.once('close', closed.resolve); reached.resolve() })
  const pending = h.request()
  await reached.promise
  await h.stop()
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'voice-stream-stopping')
  await closed.promise
})
