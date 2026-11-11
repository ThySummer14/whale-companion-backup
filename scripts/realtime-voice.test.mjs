import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeVoicePlayer } from '../src/avatar/voice.mjs'

test('silent PCM keeps the mouth closed while speech opens it', () => {
  const player = new RealtimeVoicePlayer(() => {})
  let sample = 0
  player.context = { currentTime: 1, state: 'running' }
  player.current = {
    startedAt: 0,
    samples: new Float32Array(256),
    analyser: { getFloatTimeDomainData: samples => samples.fill(sample) },
  }
  const engine = {}
  player.applyMouth(engine)
  assert.equal(engine.speechPose.values.ParamMouthOpenY, 0)
  sample = -0.125
  player.applyMouth(engine)
  assert.equal(engine.speechPose.values.ParamMouthOpenY, 0.625)
})

test('cancelling a slow download does not wait for decoding or start audio', async t => {
  const segment = { index: 0, status: 'ready', taskId: 'clip' }
  const session = { id: 'voice', status: 'preparing', segments: [segment] }
  const receipts = []
  const player = new RealtimeVoicePlayer(async (path, input) => {
    if (path === '/realtime/cancel') session.status = 'cancelling'
    if (path === '/realtime/receipt') {
      receipts.push(input.status)
      session.status = input.status
    }
    return { session: structuredClone(session) }
  })
  player.context = { state: 'running', decodeAudioData: t.mock.fn() }
  let downloadSignal
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
    downloadSignal = signal
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await player.tick()
  assert.ok(downloadSignal)
  await player.interrupt()
  assert.ok(downloadSignal.aborted)
  assert.deepEqual(receipts, ['cancelled'])
  assert.equal(player.telemetry().playing, false)
  assert.equal(player.context.decodeAudioData.mock.callCount(), 0)
})

test('a decode that finishes after stopping cannot create an audio source', async t => {
  const session = { id: 'voice', status: 'preparing' }
  const segment = { index: 0, taskId: 'clip' }
  const player = new RealtimeVoicePlayer(async () => ({}))
  const decoding = Promise.withResolvers()
  const decoded = Promise.withResolvers()
  player.context = {
    decodeAudioData: async () => { decoding.resolve(); return decoded.promise },
    createBufferSource: t.mock.fn(),
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(44)))
  const pending = player.play(session, segment)
  await decoding.promise
  player.stopLocal()
  decoded.resolve({})
  await pending
  assert.equal(player.context.createBufferSource.mock.callCount(), 0)
  assert.equal(player.telemetry().playing, false)
})

test('local auto-read disable blocks stale automatic playback and preserves manual playback', async t => {
  const segment = { index: 0, status: 'ready', taskId: 'clip' }
  const session = { id: 'voice', status: 'preparing', segments: [segment] }
  let playbackStageId = 'stage'
  const player = new RealtimeVoicePlayer(async () => ({ session, playbackStageId }), 'stage')
  player.context = { state: 'running' }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
    requests.push(signal)
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  player.setAutoReadEnabled(true)
  await player.tick()
  assert.equal(requests.length, 1)
  player.setAutoReadEnabled(false)
  assert.equal(requests[0].aborted, true)
  await player.tick()
  assert.equal(requests.length, 1)
  playbackStageId = undefined
  await player.tick()
  assert.equal(requests.length, 2)
  player.stopLocal()
})

function streamFixture(t, body, headers = { 'content-type': 'application/octet-stream', 'x-companion-sample-rate': '16000' }, segmentCount = 1) {
  const session = { id: 'pcm', status: 'preparing', streaming: true, segments: Array.from({ length: segmentCount }, (_, index) => ({ index, status: 'ready' })) }
  const receipts = []
  const owner = { stageId: 'stage/one' }
  const player = new RealtimeVoicePlayer(async (path, input) => {
    if (path === '/realtime/cancel') session.status = 'cancelling'
    if (path === '/realtime/receipt') {
      receipts.push(input)
      session.segments[input.segmentIndex].status = input.status
      session.status = input.status === 'error' ? 'failed' : input.status === 'completed' && session.segments.some(segment => segment.status !== 'completed') ? 'playing' : input.status
      session.error = input.error
    }
    return { session: structuredClone(session), streamStageId: owner.stageId }
  }, 'stage/one')
  const buffers = []
  const sources = []
  const origin = performance.now()
  player.context = {
    state: 'running',
    get currentTime() { return (performance.now() - origin) / 1000 },
    createAnalyser: () => ({ connect() {}, disconnect() {} }),
    createBuffer: (channels, frames, rate) => {
      assert.equal(channels, 1)
      const samples = new Float32Array(frames)
      buffers.push(samples)
      return { duration: frames / rate, getChannelData: () => samples }
    },
    createBufferSource() {
      const context = this
      let timer
      const source = {
        connect() {},
        disconnect() { source.disconnected = true },
        stop() { source.stopped = true; clearTimeout(timer) },
        start(when) {
          timer = setTimeout(() => source.onended?.(), Math.ceil((when + source.buffer.duration - context.currentTime) * 1000))
        },
      }
      sources.push(source)
      return source
    },
  }
  const requests = t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers }))
  t.after(() => player.stopLocal())
  return { player, receipts, buffers, sources, requests, owner }
}

async function waitFor(condition) {
  for (let i = 0; i < 300; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for PCM playback')
}

test('streaming starts before EOF, decodes split signed PCM samples, and counts only played samples', async t => {
  let feed
  const body = new ReadableStream({ start(controller) { feed = controller } })
  const { player, receipts, buffers, requests } = streamFixture(t, body)
  await player.tick()
  assert.equal(requests.mock.calls[0].arguments[0], '/companion/avatar/api/realtime/stream/pcm/0?stageId=stage%2Fone')
  const pcm = Buffer.alloc(1600)
  pcm.writeInt16LE(-32768, 0)
  pcm.writeInt16LE(32767, 2)
  pcm.writeInt16LE(-1, 4)
  pcm.writeInt16LE(1234, 1278)
  feed.enqueue(pcm.subarray(0, 1))
  feed.enqueue(pcm.subarray(1, 1279))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(receipts, [])
  assert.equal(buffers.length, 0)
  feed.enqueue(pcm.subarray(1279, 1281))
  await waitFor(() => receipts.length)
  assert.equal(receipts[0].status, 'playing')
  assert.equal(receipts[0].stageId, 'stage/one')
  assert.deepEqual(Array.from(buffers[0].subarray(0, 4)), [-1, 32767 / 32768, -1 / 32768, 0])
  assert.equal(buffers[0].at(-1), 1234 / 32768)
  assert.equal(buffers.length, 1)
  await waitFor(() => !player.telemetry().playing)
  assert.deepEqual(receipts.map(item => item.status), ['playing'])
  feed.enqueue(pcm.subarray(1281))
  feed.close()
  await waitFor(() => receipts.length === 2)
  assert.deepEqual(receipts.map(item => item.status), ['playing', 'completed'])
  assert.equal(receipts[1].positionMs, 50)
  assert.equal(player.telemetry().pcm.underruns, 1)
  const { firstPacketMs, firstScheduledMs, audioClockReachedMs } = player.telemetry().pcm
  assert.ok(firstPacketMs <= firstScheduledMs && firstScheduledMs <= audioClockReachedMs)
})

test('streaming keeps a bounded queue and interruption stops scheduled sources and aborts the request', async t => {
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(Buffer.alloc(32000)) },
  }, { highWaterMark: 0 })
  const { player, receipts, sources, requests } = streamFixture(t, body)
  await player.tick()
  await waitFor(() => player.telemetry().pcm.peakBufferedMs >= 150 && receipts.length === 1)
  assert.equal(pulls, 1)
  assert.ok(player.telemetry().pcm.peakBufferedMs <= 201)
  const pending = [...player.current.sources.keys()]
  await player.interrupt()
  assert.equal(requests.mock.calls[0].arguments[1].signal.aborted, true)
  assert.ok(pending.length >= 4)
  assert.ok(pending.every(source => source.stopped))
  assert.ok(sources.every(source => source.disconnected))
  assert.deepEqual(receipts.map(item => item.status), ['playing', 'cancelled'])
  assert.equal(player.telemetry().playing, false)
})

test('streaming rejects a partial sample, an empty response, and malformed metadata before playing', async t => {
  for (const [body, headers, error] of [
    [new Uint8Array(1), undefined, '流式语音在样本中间结束'],
    [new Uint8Array(0), undefined, '流式语音未返回样本'],
    [new Uint8Array(2), { 'content-type': 'audio/wav', 'x-companion-sample-rate': '16000' }, '流式语音格式无效'],
    [new Uint8Array(2), { 'content-type': 'application/octet-stream', 'x-companion-sample-rate': '48001' }, '流式语音格式无效'],
  ]) {
    await t.test(error, async sub => {
      const { player, receipts, sources } = streamFixture(sub, body, headers)
      await player.tick()
      await waitFor(() => receipts.length)
      assert.equal(sources.length, 0)
      assert.deepEqual(receipts.map(item => [item.status, item.error]), [['error', error]])
    })
  }
})

test('streaming drops buffered audio and reports error on a broken transport', async t => {
  let feed
  const body = new ReadableStream({ start(controller) { feed = controller } })
  const { player, receipts, sources } = streamFixture(t, body)
  feed.enqueue(Buffer.alloc(3200))
  await player.tick()
  await waitFor(() => receipts.length)
  feed.error(new Error('connection lost'))
  await waitFor(() => receipts.length === 2)
  assert.deepEqual(receipts.map(item => item.status), ['playing', 'error'])
  assert.equal(receipts[1].error, 'connection lost')
  assert.ok(sources.every(source => source.disconnected))
  assert.equal(player.telemetry().playing, false)
})

test('a completed PCM block immediately wakes the next ready segment without a stage heartbeat', async t => {
  const { player, receipts, requests } = streamFixture(t, Buffer.alloc(640), undefined, 2)
  await player.tick()
  await waitFor(() => receipts.length === 4)
  assert.deepEqual(receipts.map(item => [item.segmentIndex, item.status]), [
    [0, 'playing'], [0, 'completed'], [1, 'playing'], [1, 'completed'],
  ])
  assert.match(requests.mock.calls[1].arguments[0], /\/stream\/pcm\/1\?/)
})

test('streaming does not fetch until unlocked and a different stage cannot take ownership', async t => {
  const { player, requests, owner } = streamFixture(t, new Uint8Array(2))
  player.context.state = 'suspended'
  await player.tick()
  assert.equal(requests.mock.callCount(), 0)
  player.context.state = 'running'
  owner.stageId = 'stage/two'
  await player.tick()
  assert.equal(requests.mock.callCount(), 0)
  assert.equal(player.canInterrupt, false)
})

test('losing a simultaneous PCM claim to another stage leaves the winning playback untouched', async t => {
  const { player, requests, owner, receipts } = streamFixture(t, new Uint8Array(2))
  requests.mock.mockImplementation(async () => {
    owner.stageId = 'stage/two'
    return new Response(null, { status: 409 })
  })
  await player.tick()
  await waitFor(() => !player.loading)
  await player.tick()
  assert.equal(requests.mock.callCount(), 1)
  assert.deepEqual(receipts, [])
  assert.equal(player.telemetry().error, undefined)
  assert.equal(player.canInterrupt, false)
})
