import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { DevicePlaybackService } from '../src/host/device-playback.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'
import { SingingService } from '../src/host/singing.ts'
import { MAX_SINGING_MIDI_BYTES } from '../src/protocol/singing-midi.ts'
import { MAX_CHAT_ATTACHMENT_BYTES } from '../src/host/chat-attachments.ts'

const input = { title: '隔离歌曲', lyrics: 'fixture-private-lyrics', style: 'fixture-private-style', durationSeconds: 10 }

test('singing conversation advertises only the attachment paths available on this host', async t => {
  const legacy = { contextId: 'world.singing', maxTotalBytes: MAX_CHAT_ATTACHMENT_BYTES, shareAvailable: true }
  const convert = { engine: 'applio-rvc', convert: async () => fixtureWav() }
  const score = { synthesize: async () => fixtureWav() }
  const separator = { separate: async () => ({ vocal: fixtureWav(), accompaniment: fixtureWav() }) }
  const midi = { midiMaxBytes: MAX_SINGING_MIDI_BYTES }
  for (const [label, withStorage, cover, split, synthesize, expected] of [
    ['plain host', true, undefined, undefined, undefined, undefined],
    ['legacy WAV cover', true, convert, separator, undefined, legacy],
    ['WAV cover without attachment storage', false, convert, separator, undefined, undefined],
    ['score chat without attachment storage', false, convert, undefined, score, { ...legacy, scoreMaxSeconds: 180, wavAvailable: false }],
    ['MIDI and written score', true, convert, undefined, score, { ...legacy, ...midi, scoreMaxSeconds: 180, wavAvailable: false }],
    ['WAV and MIDI', true, convert, separator, score, { ...legacy, ...midi, scoreMaxSeconds: 180 }],
  ]) await t.test(label, async t => {
    mkdirSync('.work', { recursive: true })
    const directory = resolve(mkdtempSync('.work/device-singing-capability-'))
    const media = join(directory, 'media')
    const store = new CompanionStore(join(directory, 'store.sqlite'))
    const runtime = new CompanionRuntime({
      agents: { roots: () => [] }, get: key => key === 'attachments' && withStorage ? {} : undefined,
    }, store, 'test', { provider: 'piper', pythonPath: '/unavailable', modelPath: '/unavailable', mediaDir: media, timeoutMs: 5000 },
    media, directory, directory, directory, 'owner', undefined, undefined, undefined, cover, split, synthesize)
    t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }) })
    assert.deepEqual(runtime.view().singingConversation, expected)
    assert.deepEqual(runtime.view({ management: true }).singingConversation, expected)
  })
})

function fixtureWav({ rate = 16_000, channels = 1, seconds = 10 } = {}) {
  const frame = channels * 2
  const bytes = Buffer.alloc(44 + rate * frame * seconds)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * frame, 28)
  bytes.writeUInt16LE(frame, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  bytes.writeInt16LE(1_000, 44)
  return bytes
}

async function fixture(t, wav = fixtureWav()) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/device-singing-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const mediaRoot = join(directory, 'media')
  const singing = new SingingService(store, mediaRoot, { generate: async () => wav })
  let origin
  let deviceHandler
  const ctx = { webServer: { getOrigin: () => origin, register: route => {
    if (route.path === '/companion-device/api') deviceHandler = route.handler
    return () => {}
  } } }
  const playback = new DevicePlaybackService()
  const devices = new DeviceService(ctx, store, id => playback.revoke(id))
  const dispose = registerDeviceHttp(ctx, { singing, devicePlayback: playback }, devices)
  const server = createServer(deviceHandler)
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    devices.close()
    await new Promise(done => { server.close(done); server.closeAllConnections() })
    dispose()
    await singing.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const pair = () => devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const device = pair()
  const endpoint = `${origin}/companion-device/api/singing`
  const request = (suffix = '', { credential = device.credential, ...options } = {}) => fetch(`${endpoint}${suffix}`, {
    ...options, headers: { ...(credential ? { authorization: credential } : {}), ...options.headers },
  })
  const render = async (seconds = 10) => {
    const { task } = singing.submit({ ...input, durationSeconds: seconds }, { sessionId: 'fixture-private-session' })
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = store.taskById(task.id)
      if (current.status === 'succeeded') return current
      assert.ok(['accepted', 'running'].includes(current.status), current.error)
      await delay(2)
    }
    throw new Error('Song fixture did not settle')
  }
  return { devices, device, endpoint, mediaRoot, pair, playback, render, request, singing, store, wav }
}

test('paired devices list only archived songs and read the exact WAV with bounded Range and HEAD', async t => {
  const h = await fixture(t)
  assert.equal((await h.request('', { credential: null })).status, 401)
  assert.deepEqual(await (await h.request()).json(), { version: 1, items: [] })
  const task = await h.render()
  const unrelated = h.store.createTask({ capabilityId: 'media.singing', title: '没有归档的任务' })
  h.store.transitionTask(unrelated.id, 'running')
  h.store.transitionTask(unrelated.id, 'succeeded')
  const list = await h.request()
  assert.equal(list.status, 200)
  assert.match(list.headers.get('cache-control'), /no-store/u)
  assert.deepEqual(await list.json(), { version: 1, items: [{
    id: task.id, title: input.title, createdAt: task.createdAt, bytes: h.wav.length, mimeType: 'audio/wav', durationSeconds: 10,
  }] })

  const audioPath = `/${task.id}/audio`
  assert.equal((await h.request(audioPath, { credential: null })).status, 401)
  assert.equal((await h.request(`/${unrelated.id}/audio`)).status, 404)
  assert.equal((await h.request('', { method: 'POST' })).status, 404)
  assert.equal((await h.request(`${audioPath}?path=/tmp/unrelated.wav`)).status, 400)
  const whole = await h.request(audioPath)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('x-companion-playback-id'), null)
  assert.equal(whole.headers.get('content-type'), 'audio/wav')
  assert.equal(whole.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), h.wav)
  const partial = await h.request(audioPath, { headers: { range: 'bytes=40-49' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 40-49/${h.wav.length}`)
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), h.wav.subarray(40, 50))
  const head = await h.request(audioPath, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('accept-ranges'), 'bytes')
  assert.equal(Number(head.headers.get('content-length')), h.wav.length)
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const invalid = await h.request(audioPath, { headers: { range: `bytes=${h.wav.length}-` } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), `bytes */${h.wav.length}`)

  const modified = Buffer.from(h.wav)
  modified.writeInt16LE(123, 44)
  writeFileSync(join(h.mediaRoot, 'songs', `${task.id}.wav`), modified)
  const rejected = await h.request(audioPath)
  assert.equal(rejected.status, 404)
  assert.deepEqual(await rejected.json(), { error: 'singing-audio-not-found', code: 'singing-audio-not-found' })
})

test('only a valid singing WAV transfer from byte zero issues a singing receipt', async t => {
  const h = await fixture(t)
  const task = await h.render()
  const path = `/${task.id}/audio`
  const client = { 'x-companion-playback-client': 'ab'.repeat(16) }
  for (const [method, range, status] of [['HEAD', '', 200], ['GET', 'bytes=40-49', 206], ['GET', 'bytes=bogus', 416]]) {
    const response = await h.request(path, { method, headers: { ...client, ...(range && { range }) } })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('x-companion-playback-id'), null)
    await response.arrayBuffer()
  }
  const first = await h.request(path, { headers: { ...client, range: 'bytes=0-43' } })
  assert.equal(first.status, 206)
  const id = first.headers.get('x-companion-playback-id')
  assert.match(id, /^[a-f0-9-]{36}$/u)
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), h.wav.subarray(0, 44))
  assert.deepEqual(h.playback.activity(Date.now()), { speaking: false, singing: false })
  const response = await fetch(new URL('audio-playback', h.endpoint + '/../'), {
    method: 'POST', headers: { authorization: h.device.credential, 'content-type': 'application/json' },
    body: JSON.stringify({ id, sequence: 1, state: 'playing' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(h.playback.activity(Date.now()), { speaking: false, singing: true })
})

test('revocation during archive verification returns 401 without exposing WAV bytes', async t => {
  const h = await fixture(t)
  const task = await h.render()
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const read = h.singing.audio.bind(h.singing)
  t.mock.method(h.singing, 'audio', async (id, signal) => {
    started.resolve(signal)
    await release.promise
    return read(id, signal)
  })
  const pending = h.request(`/${task.id}/audio`)
  const signal = await started.promise
  h.devices.revoke(h.device.device.id)
  assert.equal(signal.aborted, true)
  release.resolve()
  const response = await pending
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'device-unauthorized', code: 'device-unauthorized' })
  assert.equal((await h.request()).status, 401)
})

test('revocation interrupts a song response still writing to a paused device', { timeout: 8000 }, async t => {
  const h = await fixture(t, fixtureWav({ rate: 96_000, channels: 2, seconds: 60 }))
  const task = await h.render(60)
  const path = `/${task.id}/audio`
  const response = await new Promise((done, fail) => {
    get(`${h.endpoint}${path}`, { headers: { authorization: h.device.credential } }, message => {
      message.pause()
      done(message)
    }).once('error', fail)
  })
  assert.equal(response.statusCode, 200)
  const closed = new Promise(done => {
    response.on('error', () => {})
    response.once('close', done)
  })
  assert.equal((await h.request(path)).status, 409)
  h.devices.revoke(h.device.device.id)
  response.resume()
  await closed
  assert.equal(response.complete, false)
  assert.equal((await h.request(path)).status, 401)
})
