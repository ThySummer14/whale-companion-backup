import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { RealtimeVoicePlayer } from '../src/avatar/voice.mjs'

function fixture(t, stageId = 'stage') {
  const song = { id: 'session', kind: 'song', songDurationMs: 99_999, status: 'preparing', segments: [{ taskId: 'archived', index: 0, status: 'ready' }] }
  const host = { owner: 'stage', offline: false }
  const receipts = []
  const analyse = t.mock.fn(samples => samples.fill(0.125))
  let audioClock = 1
  const sources = []
  const player = new RealtimeVoicePlayer(async (path, body) => {
    if (host.offline) throw new Error('舞台失去连接')
    if (path === '/realtime/cancel') song.status = 'cancelling'
    if (path === '/realtime/receipt') {
      receipts.push(body)
      song.status = body.status === 'completed' ? 'succeeded' : body.status === 'error' ? 'failed' : body.status
      song.segments[0].status = body.status
    }
    return { session: structuredClone(song), songStageId: host.owner }
  }, stageId)
  player.context = {
    state: 'running',
    get currentTime() { return audioClock },
    decodeAudioData: async () => ({ duration: 4 }),
    createBufferSource() {
      const source = {
        connect() {}, disconnect() {},
        start() { this.started = true },
        stop() { this.stopped = true },
      }
      sources.push(source)
      return source
    },
    createAnalyser: () => ({ connect() {}, disconnect() {}, getFloatTimeDomainData: analyse }),
  }
  t.after(() => player.stopLocal())
  return { player, host, song, sources, receipts, analyse, clock: now => { audioClock = now } }
}

async function until(condition) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return
    await turn()
  }
  assert.fail('Timed out waiting for the song stage')
}

test('a missing or different song owner and a locked stage cannot fetch the song', async t => {
  const { player, host } = fixture(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(44)))
  for (const owner of [undefined, 'different-stage']) {
    host.owner = owner
    await player.tick()
    assert.equal(player.canInterrupt, false)
  }
  host.owner = 'stage'
  player.context.state = 'suspended'
  await player.tick()
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(player.songReady, false)
})

test('a selected stage drives the mouth from WAV and completes at its measured end', async t => {
  const { player, sources, receipts, clock } = fixture(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(44)))
  await player.tick()
  await until(() => receipts.length === 1)
  assert.equal(fetch.mock.calls[0].arguments[0], '/companion/avatar/api/realtime/audio/archived?stageId=stage')
  assert.equal(sources[0].started, true)
  assert.deepEqual(receipts[0], { sessionId: 'session', segmentIndex: 0, stageId: 'stage', status: 'playing', positionMs: 0, energy: 0 })
  const engine = {}
  clock(2.25)
  player.applyMouth(engine)
  assert.equal(player.telemetry().kind, 'song')
  assert.equal(player.telemetry().mouthSource, 'mixed-audio')
  assert.equal(engine.speechPose.values.ParamMouthOpenY, 0.625)
  assert.equal(player.telemetry().positionMs, 1250)
  // A delayed onended callback cannot inflate the duration of the decoded WAV.
  clock(5.4)
  sources[0].onended()
  await until(() => receipts.length === 2)
  assert.equal(receipts[1].status, 'completed')
  assert.equal(receipts[1].positionMs, 4000)
  assert.equal(player.telemetry().playing, false)
  player.applyMouth(engine)
  assert.equal(engine.speechReserved, false)
})

const withEnvelope = value => new Response(new Uint8Array(44), { headers: { 'x-companion-vocal-envelope': value } })

test('a vocal envelope closes the mouth over backing-only audio and follows the same song clock', async t => {
  const { player, sources, receipts, analyse, clock } = fixture(t)
  const samples = Buffer.alloc(160)
  samples[4] = 204
  const fetch = t.mock.method(globalThis, 'fetch', async () => withEnvelope(`v1:${samples.toString('base64')}`))
  await player.tick()
  await until(() => receipts.length === 1)
  const engine = {}
  for (const [elapsed, expected] of [[0.033, 0], [0.107, 0.8], [0.176, 0]]) {
    clock(1 + elapsed)
    player.applyMouth(engine)
    assert.equal(engine.speechReserved, true)
    assert.equal(engine.speechPose.values.ParamMouthOpenY, expected)
    assert.equal(player.telemetry().mouthSource, 'vocal-envelope')
    assert.equal(player.telemetry().energy, expected)
    assert.equal(player.telemetry().positionMs, Math.round(elapsed * 1000))
  }
  assert.equal(analyse.mock.callCount(), 0)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(sources.length, 1)
  clock(1.107)
  player.applyMouth(engine)
  await player.interrupt()
  assert.equal(sources[0].stopped, true)
  assert.equal(receipts[1].status, 'cancelled')
  assert.equal(player.telemetry().mouthSource, undefined)
  assert.equal(player.telemetry().energy, 0)
  player.applyMouth(engine)
  assert.equal(engine.speechPose, undefined)
  assert.equal(engine.speechReserved, false)
})

test('unusable or unrelated envelopes retain analyser fallback, while one rounded bucket is accepted', async t => {
  const canonical = Buffer.alloc(160).toString('base64')
  const cases = [
    ['other version', `v2:${canonical}`, 'song', 'mixed-audio'],
    ['invalid padding', `v1:${canonical.slice(0, -2)}`, 'song', 'mixed-audio'],
    ['nonzero padding bits', `v1:${canonical.slice(0, -3)}B==`, 'song', 'mixed-audio'],
    ['different duration', `v1:${Buffer.alloc(158).toString('base64')}`, 'song', 'mixed-audio'],
    ['too many samples', `v1:${Buffer.alloc(2601).toString('base64')}`, 'song', 'mixed-audio'],
    ['one bucket short', `v1:${Buffer.alloc(159).toString('base64')}`, 'song', 'vocal-envelope'],
    ['one bucket long', `v1:${Buffer.alloc(161).toString('base64')}`, 'song', 'vocal-envelope'],
    ['speech ignores header', `v1:${canonical}`, 'speech', undefined],
  ]
  for (const [name, header, kind, source] of cases) {
    await t.test(name, async t => {
      const { player, song, receipts, analyse, clock } = fixture(t)
      song.kind = kind
      t.mock.method(globalThis, 'fetch', async () => withEnvelope(header))
      await player.tick()
      await until(() => receipts.length === 1)
      clock(2.25)
      const engine = {}
      player.applyMouth(engine)
      assert.equal(player.telemetry().mouthSource, source)
      assert.equal(engine.speechPose.values.ParamMouthOpenY, source === 'vocal-envelope' ? 0 : 0.625)
      assert.equal(analyse.mock.callCount(), source === 'vocal-envelope' ? 0 : 1)
      assert.equal(player.telemetry().error, undefined)
    })
  }
})

test('song ownership is checked again after decoding', async t => {
  const { player, host, sources, receipts } = fixture(t)
  const decoding = Promise.withResolvers()
  const decoded = Promise.withResolvers()
  player.context.decodeAudioData = async () => { decoding.resolve(); return decoded.promise }
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(44)))
  await player.tick()
  await decoding.promise
  host.owner = 'different-stage'
  decoded.resolve({ duration: 4 })
  await until(() => !player.loading)
  assert.deepEqual(sources, [])
  assert.deepEqual(receipts, [])
})

test('hiding a selected stage aborts a pending download and reports cancellation', async t => {
  const { player, sources, receipts } = fixture(t)
  let request
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
    request = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await player.tick()
  assert.ok(request)
  await player.setSongForeground(false)
  assert.equal(request.aborted, true)
  assert.equal(player.songReady, false)
  assert.deepEqual(sources, [])
  assert.deepEqual(receipts.map(receipt => [receipt.status, receipt.stageId]), [['cancelled', 'stage']])
})

test('loss of host polling stops a song locally without replaying its stale reservation', async t => {
  const { player, host, song, sources, receipts } = fixture(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(44)))
  await player.tick()
  await until(() => receipts.length === 1)
  host.offline = true
  await player.tick()
  assert.equal(sources[0].stopped, true)
  assert.equal(player.telemetry().playing, false)
  assert.equal(player.songReady, false)
  host.offline = false
  song.status = 'preparing'
  song.segments[0].status = 'ready'
  await player.tick()
  assert.equal(fetch.mock.callCount(), 1)
  song.id = 'fresh-session'
  await player.tick()
  await until(() => receipts.length === 2)
  assert.equal(fetch.mock.callCount(), 2)
})
