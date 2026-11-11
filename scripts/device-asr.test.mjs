import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { LocalAsrProvider, MAX_ASR_WAV_BYTES } from '../src/host/asr.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'

function wav(rate = 16000, samples = 160, voiced = true) {
  const audio = Buffer.alloc(44 + samples * 2)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(rate, 24)
  audio.writeUInt32LE(rate * 2, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(samples * 2, 40)
  if (samples && voiced) audio.writeInt16LE(1024, 44)
  return audio
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
}

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, handler, timeoutMs = 3000) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/device-asr-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const calls = []
  let asr
  if (handler) {
    const origin = await listen(t, async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      handler(res, calls.length)
    })
    asr = new LocalAsrProvider(`${origin}/transcribe`, timeoutMs)
  }
  const routes = new Map()
  let origin
  const ctx = { webServer: { getOrigin: () => origin, register: route => { routes.set(route.path, route.handler); return () => {} } } }
  const media = join(directory, 'media')
  const options = { provider: 'piper', pythonPath: '/unavailable/python', modelPath: '/unavailable/model', mediaDir: join(media, 'voice'), timeoutMs: 5000 }
  const runtime = new CompanionRuntime(ctx, store, 'test', options, media, directory, directory, directory, 'owner', undefined, asr)
  const devices = new DeviceService(ctx, store)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await runtime.close()
  }
  t.after(async () => { devices.close(); await stop(); rmSync(directory, { recursive: true, force: true }) })
  registerDeviceHttp(ctx, runtime, devices)
  origin = await listen(t, (req, res) => routes.get([...routes.keys()].find(path => req.url.startsWith(`${path}/`)))(req, res))
  const pair = () => devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const device = pair()
  const endpoint = `${origin}/companion-device/api/transcribe`
  const headers = { authorization: device.credential, 'content-type': 'audio/wav' }
  const send = (body, { credential = device.credential, type = 'audio/wav', signal, suffix = '', encoding } = {}) => fetch(endpoint + suffix, {
    method: body === undefined ? 'GET' : 'POST', body, signal,
    headers: { ...(credential ? { authorization: credential } : {}), ...(type ? { 'content-type': type } : {}), ...(encoding ? { 'content-encoding': encoding } : {}) },
  })
  const revoke = () => fetch(`${origin}/companion/api/devices/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-companion-request': '1' }, body: JSON.stringify({ id: device.device.id }),
  })
  return { calls, endpoint, headers, pair, revoke, send, stop, store }
}

test('only enables exact loopback HTTP provider endpoints with a bounded deadline', () => {
  for (const endpoint of [
    'http://localhost:8000/transcribe', 'http://192.168.0.1/transcribe', 'https://127.0.0.1/transcribe',
    'http://127.0.0.1/', 'http://user@127.0.0.1/transcribe', 'http://127.0.0.1/transcribe?x=1', 'http://127.0.0.1/transcribe#x',
  ]) assert.throws(() => new LocalAsrProvider(endpoint, 1000), /exact loopback/u)
  const valid = 'http://[::1]:8000/transcribe'
  assert.throws(() => new LocalAsrProvider(valid, 999), /timeout/u)
  const provider = new LocalAsrProvider(valid, 1000)
  provider.close()
})

test('requires a paired device and reports whether local ASR is configured', async t => {
  const h = await fixture(t)
  assert.equal((await h.send(undefined, { credential: null })).status, 401)
  assert.equal((await h.send(wav(), { credential: null })).status, 401)
  const capability = await h.send()
  assert.equal(capability.status, 200)
  assert.equal(capability.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await capability.json(), { available: false, voiceReplyReady: true })
  assert.equal((await h.send(wav())).status, 404)
})

test('forwards valid 16 kHz and recorder fallback WAV bytes with a fixed upstream request', async t => {
  const h = await fixture(t, res => json(res, { text: '  测试转录。  ', ignored: 'private upstream data' }))
  assert.deepEqual(await (await h.send()).json(), { available: true, voiceReplyReady: true })
  assert.equal(h.calls.length, 0)
  for (const rate of [16000, 44100, 48000]) {
    const audio = wav(rate, rate * 15)
    const response = await h.send(audio, { type: 'Audio/Wav; name=recording.wav' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { text: '测试转录。' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const upstream = h.calls.at(-1)
    assert.equal(upstream.method, 'POST')
    assert.equal(upstream.url, '/transcribe')
    assert.equal(upstream.headers.authorization, undefined)
    assert.equal(upstream.headers['content-type'], 'audio/wav')
    assert.deepEqual(upstream.body, audio)
  }
  assert.deepEqual(h.store.tasks(), [])
  assert.deepEqual(h.store.media.list(), [])
})

test('rejects silence, unsupported media and malformed or oversized RIFF before upstream', async t => {
  const h = await fixture(t, res => json(res, { text: 'unexpected' }))
  const stereo = wav()
  stereo.writeUInt16LE(2, 22)
  const invalidDataSize = wav()
  invalidDataSize.writeUInt32LE(0xffffffff, 40)
  const oddFrame = wav().subarray(0, -1)
  oddFrame.writeUInt32LE(oddFrame.length - 8, 4)
  oddFrame.writeUInt32LE(oddFrame.length - 44, 40)
  const falseSignature = wav()
  falseSignature[0] = 0xd2
  for (const invalid of [Buffer.from('not wav'), wav(8000), stereo, invalidDataSize, oddFrame, wav().subarray(0, -1), falseSignature]) {
    assert.equal((await h.send(invalid)).status, 400)
  }
  assert.equal((await h.send(wav(), { type: 'application/json' })).status, 415)
  assert.equal((await h.send(wav(), { encoding: 'gzip' })).status, 415)
  assert.equal((await h.send(wav(), { suffix: '?endpoint=elsewhere' })).status, 400)
  assert.equal((await h.send(wav(16000, 0))).status, 422)
  assert.equal((await h.send(wav(16000, 160, false))).status, 422)
  assert.equal((await h.send(wav(16000, 16000 * 15 + 1))).status, 413)
  const uploadStatus = (headers, bytes) => new Promise((resolve, reject) => {
    const req = httpRequest(h.endpoint, { method: 'POST', headers: { ...h.headers, ...headers } }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    req.once('error', reject)
    req.end(bytes)
  })
  assert.equal(await uploadStatus({ 'content-length': MAX_ASR_WAV_BYTES + 1 }), 413)
  assert.equal(await uploadStatus({ 'transfer-encoding': 'chunked' }, Buffer.alloc(MAX_ASR_WAV_BYTES + 1)), 413)
  assert.equal(h.calls.length, 0)
})

test('bounds and validates provider output and refuses redirects', async t => {
  const h = await fixture(t, (res, count) => {
    if (count === 1) return json(res, { text: '  ' })
    if (count === 2) return json(res, { text: 42 })
    if (count === 3) return res.writeHead(200, { 'content-type': 'application/json' }).end('{')
    if (count === 4) return json(res, { text: 'x'.repeat(33_000) })
    if (count === 5) return res.writeHead(302, { location: '/other' }).end()
    if (count === 6) return json(res, { error: 'private error' }, 409)
    json(res, { error: 'private error' }, 503)
  })
  for (const status of [422, 502, 502, 502, 502, 409, 503]) {
    const response = await h.send(wav())
    assert.equal(response.status, status)
    assert.doesNotMatch(JSON.stringify(await response.json()), /private error/u)
  }
  assert.deepEqual(h.calls.map(call => call.url), Array(7).fill('/transcribe'))
})

test('shares one ASR slot across devices and closes provider work on client disconnect', { timeout: 8000 }, async t => {
  const reached = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const h = await fixture(t, (res, count) => {
    if (count === 2) return json(res, { text: '重试成功。' })
    res.once('close', closed.resolve)
    reached.resolve()
  })
  const controller = new AbortController()
  const first = h.send(wav(), { signal: controller.signal })
  await reached.promise
  assert.equal((await h.send(wav())).status, 409)
  const other = h.pair()
  assert.equal((await h.send(wav(), { credential: other.credential })).status, 409)
  assert.equal(h.calls.length, 1)
  controller.abort()
  await assert.rejects(first)
  await closed.promise
  assert.deepEqual(await (await h.send(wav(), { credential: other.credential })).json(), { text: '重试成功。' })
})

test('revocation cancels recognition and refuses later capability checks', { timeout: 8000 }, async t => {
  const reached = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const h = await fixture(t, res => { res.once('close', closed.resolve); reached.resolve() })
  const pending = h.send(wav())
  await reached.promise
  assert.equal((await h.revoke()).status, 200)
  assert.equal((await pending).status, 401)
  await closed.promise
  assert.equal((await h.send()).status, 401)
})

test('upstream timeout and Host shutdown release recognition without waiting for a response', { timeout: 8000 }, async t => {
  const reached = [Promise.withResolvers(), Promise.withResolvers()]
  const closed = [Promise.withResolvers(), Promise.withResolvers()]
  const h = await fixture(t, (res, count) => {
    res.once('close', closed[count - 1].resolve)
    reached[count - 1].resolve()
  }, 1000)
  const timedOut = await h.send(wav())
  assert.equal(timedOut.status, 503)
  assert.equal((await timedOut.json()).code, 'asr-timeout')
  await closed[0].promise
  const pending = h.send(wav())
  await reached[1].promise
  await h.stop()
  const stopped = await pending
  assert.equal(stopped.status, 503)
  assert.equal((await stopped.json()).code, 'asr-stopping')
  await closed[1].promise
})

test('a stalled upload expires before upstream and releases the slot', { timeout: 8000 }, async t => {
  const h = await fixture(t, res => json(res, { text: '恢复。' }), 1000)
  const interrupted = Promise.withResolvers()
  const req = httpRequest(h.endpoint, { method: 'POST', headers: { ...h.headers, 'content-length': 500 } })
  req.once('error', interrupted.resolve)
  req.write(Buffer.from('partial'))
  await interrupted.promise
  assert.equal(h.calls.length, 0)
  assert.deepEqual(await (await h.send(wav())).json(), { text: '恢复。' })
})
