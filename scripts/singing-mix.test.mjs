import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { SingingService, SINGING_CHAT_COVER_ID_PREFIX } from '../src/host/singing.ts'
import { mixSongWav, parseSongWav, songVocalEnvelope } from '../src/host/song-mix.ts'
import { MAX_SINGING_WAV_BYTES } from '../src/protocol/singing.ts'

function wave(rate, channels, frames, sample) {
  const size = frames * channels * 2
  const wav = Buffer.alloc(44 + size)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * channels * 2, 28)
  wav.writeUInt16LE(channels * 2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(size, 40)
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(sample(frame, channel), 44 + (frame * channels + channel) * 2)
  }
  return wav
}

test('mix aligns starts, interpolates the backing sample clock and pads short stereo backing', async () => {
  const vocal = wave(32_000, 1, 32_000, () => 1000)
  const backing = wave(16_000, 2, 2, (frame, channel) => (frame + 1) * (channel === 0 ? 2000 : -1000))
  const originalVocal = Buffer.from(vocal)
  const originalBacking = Buffer.from(backing)
  const mixed = parseSongWav(await mixSongWav(parseSongWav(vocal), parseSongWav(backing, 0, Infinity), 0, 0, new AbortController().signal))
  assert.equal(mixed.rate, 32_000)
  assert.equal(mixed.channels, 2)
  assert.equal(mixed.frames, 32_000)
  const firstSamples = Array.from({ length: 10 }, (_, index) => mixed.pcm.readInt16LE(index * 2))
  assert.deepEqual(firstSamples, [3000, 0, 4000, -500, 5000, -1000, 3000, 0, 1000, 1000])
  assert.deepEqual(vocal, originalVocal)
  assert.deepEqual(backing, originalBacking)
})

test('mix trims longer backing and preserves headroom at both polarity extremes', async () => {
  const vocal = parseSongWav(wave(16_000, 1, 16_000, frame => frame % 2 ? -32768 : 32767))
  const backing = parseSongWav(wave(16_000, 1, 32_000, frame => frame % 2 ? -32768 : 32767))
  const mixed = parseSongWav(await mixSongWav(vocal, backing, 6, 6, new AbortController().signal))
  assert.equal(mixed.frames, 16_000)
  assert.equal(mixed.channels, 1)
  const peak = Math.round(0.98 * 32767)
  assert.equal(mixed.pcm.readInt16LE(0), Math.round(0.98 * 32767 * 32767 / 32768))
  assert.equal(mixed.pcm.readInt16LE(2), -peak)
  assert.equal(mixed.pcm.readInt16LE(mixed.pcm.length - 2), -peak)
})

test('mixed processing yields to cancellation and rejects silence or malformed PCM', async () => {
  assert.throws(() => parseSongWav(wave(16_000, 1, 16_000, () => 0)), /Invalid PCM16 WAV/)
  const malformed = wave(16_000, 1, 16_000, () => 1000)
  malformed.writeUInt16LE(24, 34)
  assert.throws(() => parseSongWav(malformed), /Invalid PCM16 WAV/)
  const controller = new AbortController()
  const vocal = parseSongWav(wave(16_000, 1, 32_000, () => 1000))
  const processing = mixSongWav(vocal, vocal, 0, 0, controller.signal)
  controller.abort()
  await assert.rejects(processing, { name: 'AbortError' })
  const inverted = parseSongWav(wave(16_000, 1, 32_000, () => -1000))
  await assert.rejects(mixSongWav(vocal, inverted, 0, 0, new AbortController().signal), /no audible PCM samples/)
})

test('25 ms vocal RMS includes all channels, honors fractional sample boundaries, and saturates', async () => {
  const vocal = parseSongWav(wave(44_100, 2, 44_101, (frame, channel) => {
    const amplitude = frame < 1103 ? 0 : frame < 2205 ? 4096 : 32767
    return channel ? -amplitude : amplitude
  }))
  const signal = new AbortController().signal
  const levels = await songVocalEnvelope(vocal, signal)
  assert.equal(levels.length, 41)
  assert.deepEqual([...levels.slice(0, 3)], [0, 159, 255])
  assert.equal(levels.at(-1), 255)
  const controller = new AbortController()
  const computing = songVocalEnvelope(vocal, controller.signal)
  controller.abort()
  await assert.rejects(computing, { name: 'AbortError' })
})

function coverFixture(t, cover, separator, activityRetention) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/singing-vocal-test-'))
  const path = join(root, 'store.sqlite')
  const media = join(root, 'media')
  const store = new CompanionStore(path, activityRetention)
  const singing = new SingingService(store, media, undefined, cover, separator)
  t.after(async () => { await singing.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { path, media, store, singing }
}

async function settled(store, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = store.taskById(id)
    if (task && !['accepted', 'running'].includes(task.status)) return task
    await delay(5)
  }
  assert.fail('Cover task did not settle')
}

test('single-source cover progresses through separation and conversion before archiving a single mix', async t => {
  const origin = { sessionId: 'dedicated-song-session', messageId: 'owner-cover-request' }
  const source = wave(16_000, 1, 48_000, () => 3000)
  const guide = wave(44_100, 1, 132_300, () => 1000)
  const backing = wave(32_000, 2, 96_000, () => 2000)
  const converted = wave(16_000, 1, 48_000, frame => frame >= 8000 ? 4000 : 0)
  let finishSeparation, finishConversion, jobSignal
  const { path, media, store, singing } = coverFixture(t, { engine: 'applio-rvc', convert: (input, signal) => {
    assert.equal(input, guide)
    assert.equal(signal, jobSignal)
    return new Promise((resolve, reject) => {
      finishConversion = resolve
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } }, { separate: (input, signal) => {
    assert.equal(input, source)
    jobSignal = signal
    return new Promise((resolve, reject) => {
      finishSeparation = resolve
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } }, 8)
  assert.equal(singing.sourceCoverAvailable, true)
  assert.equal(singing.view().sourceCoverAvailable, true)
  assert.equal(singing.view().coverEngine, 'applio-rvc')
  assert.equal(singing.sourceCoverForMessage(origin), undefined)
  const accepted = singing.submitSourceCover(' 自动分轨翻唱 ', source, { vocalGainDb: 0, backingGainDb: 0 }, origin)
  const { id } = accepted.task
  assert.equal(accepted.task.status, 'accepted')
  assert.equal(accepted.task.title, '自动分轨翻唱')
  assert.equal(accepted.task.sessionId, origin.sessionId)
  assert.equal(accepted.task.contextId, 'world.singing')
  assert.match(accepted.task.externalId, /^singing:chat-cover:[0-9a-f]{64}$/u)
  assert.equal(accepted.coverPhase, 'separating')
  assert.equal(accepted.coverEngine, undefined)
  const replay = singing.sourceCoverForMessage(origin)
  assert.equal(replay.task.id, id)
  assert.equal(replay.task.status, 'accepted')
  assert.equal(replay.coverPhase, 'separating')
  assert.deepEqual(singing.submitSourceCover('重试改了标题', source, undefined, origin), replay)
  assert.throws(() => singing.submitCover('已有任务', source), { code: 'singing-busy' })
  assert.throws(() => singing.submitSourceCover('其他会话的消息', source, undefined, { ...origin, sessionId: 'other-session' }), { code: 'singing-busy' })
  assert.equal(singing.sessionTask('other-session', id), undefined)
  assert.equal(singing.sessionTask(origin.sessionId, 'malformed'), undefined)
  await nextTick()
  assert.equal(singing.view().tasks[0].coverPhase, 'separating')
  const paddedBacking = Buffer.concat([Buffer.alloc(1), backing])
  finishSeparation({ vocal: guide, accompaniment: new Uint8Array(paddedBacking.buffer, paddedBacking.byteOffset + 1, backing.length) })
  await nextTick()
  assert.equal(singing.view().tasks[0].coverPhase, 'converting')
  const active = singing.submitSourceCover('重复调用', source, undefined, origin)
  assert.equal(active.task.id, id)
  assert.equal(active.task.status, 'running')
  assert.equal(active.coverPhase, 'converting')
  assert.equal(active.coverEngine, undefined)
  assert.deepEqual(singing.sessionTask(origin.sessionId), active)
  await assert.rejects(singing.audio(id), { code: 'singing-audio-not-found' })
  const originalTransition = store.transitionTask.bind(store)
  t.mock.method(store, 'transitionTask', (taskId, status, ...rest) => {
    if (status === 'succeeded') assert.equal(singing.view().tasks[0].coverPhase, 'archiving')
    return originalTransition(taskId, status, ...rest)
  })
  finishConversion(converted)
  await nextTick()
  assert.equal(singing.view().tasks[0].coverPhase, 'mixing')
  assert.equal((await settled(store, id)).status, 'succeeded')
  assert.equal(singing.view().tasks[0].coverPhase, undefined)
  assert.equal(singing.view().tasks[0].coverEngine, 'applio-rvc')
  const audio = await singing.audio(id, undefined, true)
  const mixed = parseSongWav(Buffer.from(audio.data))
  assert.equal(mixed.pcm.readInt16LE(0), 2000)
  assert.equal(mixed.pcm.readInt16LE(8000 * 4), 6000)
  assert.equal(audio.vocalEnvelope[0], 0)
  assert.ok(audio.vocalEnvelope[20] > 0)
  const receipt = store.activities().find(item => item.kind === 'song.archived')
  assert.equal(receipt.data.mode, 'cover')
  assert.equal(receipt.data.sourceSeparated, true)
  assert.equal(receipt.data.backingMixed, true)
  assert.equal(receipt.data.coverEngine, 'applio-rvc')
  assert.equal(receipt.sessionId, origin.sessionId)
  assert.equal(store.activities().filter(item => item.kind === 'task.accepted').length, 1)
  assert.equal(store.activities().filter(item => item.kind === 'song.archived').length, 1)
  await singing.close()
  assert.equal(singing.sourceCoverAvailable, false)
  assert.equal(singing.view().coverEngine, undefined)
  assert.deepEqual(readdirSync(join(media, 'songs')), [`${id}.wav`])
  for (let event = 0; event < 8; event++) store.recordActivity({ source: 'test', kind: 'test', summary: 'Expire prior activity' })
  assert.equal(store.activities().some(item => item.kind === 'song.archived'), false)
  const reopened = new CompanionStore(path)
  try {
    const reloaded = new SingingService(reopened, media, undefined, { engine: 'seed-vc', convert: async () => source })
    assert.equal(reloaded.view().coverEngine, 'seed-vc')
    const recovered = reloaded.sourceCoverForMessage(origin)
    assert.equal(recovered.task.id, id)
    assert.equal(recovered.task.status, 'succeeded')
    assert.equal(recovered.audio.id, id)
    assert.equal(recovered.coverEngine, 'applio-rvc')
    assert.equal(reopened.media.songCoverEngine(id, '0'.repeat(64)), undefined)
    assert.deepEqual(reloaded.submitSourceCover('重启后重试', source, undefined, origin), recovered)
    assert.deepEqual(reloaded.sessionTask(origin.sessionId, id), recovered)
    assert.equal(reloaded.sessionTask('other-session', id), undefined)
    assert.throws(() => reloaded.submitSourceCover('重启后新消息', source, undefined, { ...origin, messageId: 'fresh' }), { code: 'singing-source-cover-unavailable' })
  } finally { reopened.close() }
})

test('archive provenance ignores generic activity and rolls back when the genuine receipt fails', async t => {
  const source = wave(16_000, 1, 48_000, () => 1000)
  const legacy = coverFixture(t, { convert: async () => source })
  const earlier = legacy.singing.submitCover('已有翻唱', source).task
  assert.equal((await settled(legacy.store, earlier.id)).status, 'succeeded')
  legacy.store.recordActivity({
    taskId: earlier.id, contextId: 'world.singing', source: 'media.singing', kind: 'song.archived', status: 'success',
    summary: 'An activity cannot set archive provenance', data: { coverEngine: 'seed-vc' },
  })
  assert.equal(legacy.singing.view().tasks[0].coverEngine, undefined)
  assert.ok(legacy.singing.view().tasks[0].audio)

  const { path, store, singing } = coverFixture(t, { engine: 'seed-vc', convert: async () => source })
  const recordActivity = store.recordActivity.bind(store)
  t.mock.method(store, 'recordActivity', input => {
    if (input.kind === 'song.archived') throw new Error('isolated receipt failure')
    return recordActivity(input)
  })
  const failed = singing.submitCover('归档失败', source).task
  assert.equal((await settled(store, failed.id)).status, 'failed')
  assert.equal(singing.view().tasks[0].coverEngine, undefined)
  assert.equal(store.media.get(failed.id), undefined)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM state WHERE key GLOB ?').get(`singing.cover-engine:${failed.id}:*`).count, 0)
  } finally { db.close() }
})

test('single-source cover rejects unavailable backends, invalid uploads and drifting model outputs', async t => {
  const source = wave(16_000, 1, 48_000, () => 1000)
  const shifted = wave(16_000, 1, 51_200, () => 1000)
  const disabled = coverFixture(t, { convert: async () => source }).singing
  assert.equal(disabled.view().coverAvailable, true)
  assert.equal(disabled.view().sourceCoverAvailable, undefined)
  assert.throws(() => disabled.submitSourceCover('没有分轨', source), { code: 'singing-source-cover-unavailable' })
  let accompaniment = shifted
  let conversions = 0
  const { media, store, singing } = coverFixture(t, { convert: async () => { conversions++; return shifted } }, {
    separate: async () => ({ vocal: source, accompaniment }),
  })
  assert.throws(() => singing.submitSourceCover('   ', source), { code: 'singing-invalid-source' })
  assert.throws(() => singing.submitSourceCover('坏输入', Buffer.from('bad')), { code: 'singing-invalid-source' })
  assert.throws(() => singing.submitSourceCover('输入太短', wave(16_000, 1, 32_000, () => 1000)), { code: 'singing-invalid-source' })
  assert.throws(() => singing.submitSourceCover('无效增益', source, { backingGainDb: Infinity }), { code: 'singing-invalid-gain' })
  assert.deepEqual(singing.view().tasks, [])

  const origin = { sessionId: 'song-session', messageId: 'failed-cover' }
  const first = singing.submitSourceCover('分轨时长偏差', source, undefined, origin).task
  assert.equal((await settled(store, first.id)).error, 'singing-invalid-stems')
  assert.equal(conversions, 0)
  assert.equal(singing.submitSourceCover('同一条失败请求', source, undefined, origin).task.status, 'failed')
  await nextTick()
  accompaniment = source
  const second = singing.submitSourceCover('转换时长偏差', source).task
  assert.equal((await settled(store, second.id)).error, 'singing-invalid-audio')
  assert.equal(conversions, 1)
  await singing.close()
  assert.deepEqual(singing.archive().items, [])
  assert.deepEqual(readdirSync(join(media, 'songs')), [])
})

test('cancelling separation aborts its provider and blocks any later conversion or archive', async t => {
  const source = wave(16_000, 1, 48_000, () => 1000)
  let finishSeparation, separatorSignal
  const convert = t.mock.fn(async () => source)
  const { media, store, singing } = coverFixture(t, { convert }, { separate: (_input, signal) => {
    separatorSignal = signal
    return new Promise(resolve => { finishSeparation = resolve })
  } })
  const origin = { sessionId: 'song-session', messageId: 'cancelled-cover' }
  const { task } = singing.submitSourceCover('取消自动分轨', source, undefined, origin)
  await nextTick()
  const cancelled = singing.cancel(task.id)
  finishSeparation({ vocal: source, accompaniment: source })
  assert.equal(cancelled.task.status, 'cancelled')
  assert.equal(cancelled.coverPhase, undefined)
  assert.equal(separatorSignal.aborted, true)
  assert.deepEqual(singing.submitSourceCover('同一条取消请求', source, undefined, origin), cancelled)
  await singing.close()
  assert.equal(convert.mock.callCount(), 0)
  assert.equal(store.media.get(task.id), undefined)
  assert.deepEqual(readdirSync(join(media, 'songs')), [])
})

test('chat cover rejects an external ID owned by another capability, context or session', async t => {
  const wav = wave(16_000, 1, 48_000, () => 1000)
  const { store, singing } = coverFixture(t, { convert: async () => wav }, {
    separate: async () => ({ vocal: wav, accompaniment: wav }),
  })
  const sessionId = 'song-session'
  for (const fields of [
    { capabilityId: 'core.chat' }, { contextId: 'chat.main' }, { sessionId: 'other-session' },
  ]) {
    const messageId = JSON.stringify(fields)
    const digest = createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex')
    const task = store.createTask({
      externalId: `${SINGING_CHAT_COVER_ID_PREFIX}${digest}`, capabilityId: 'media.singing',
      contextId: 'world.singing', sessionId, title: 'existing', ...fields,
    })
    assert.throws(() => singing.sourceCoverForMessage({ sessionId, messageId }), { code: 'singing-cover-message-conflict' })
    assert.throws(() => singing.submitSourceCover('should not submit', wav, undefined, { sessionId, messageId }), { code: 'singing-cover-message-conflict' })
    assert.equal(singing.sessionTask(sessionId, task.id), undefined)
  }
  assert.equal(singing.sessionTask(sessionId), undefined)
  assert.equal(store.activities().filter(item => item.kind === 'song.archived').length, 0)
})

test('verified mixed WAV retains a compact envelope from converted vocal only', async t => {
  const rate = 44_100
  const guide = wave(rate, 1, rate * 3, () => 2000)
  const converted = wave(rate, 2, rate * 3 + 1, (frame, channel) =>
    frame >= rate && frame < rate * 2 ? (channel ? -4096 : 4096) : 0)
  const accompaniment = wave(32_000, 2, 32_000 * 4, (_frame, channel) => channel ? -5000 : 5000)
  const { path, media, store, singing } = coverFixture(t, { convert: async () => converted })
  const { task } = singing.submitCover('伴奏口型核验', guide, { accompaniment })
  assert.equal((await settled(store, task.id)).status, 'succeeded')
  const archive = await singing.audio(task.id)
  const stage = await singing.audio(task.id, undefined, true)
  assert.equal(archive.vocalEnvelope, undefined)
  assert.ok(stage.vocalEnvelope instanceof Uint8Array)
  assert.deepEqual(Buffer.from(stage.data), await mixSongWav(parseSongWav(converted),
    parseSongWav(accompaniment), -2, -10, new AbortController().signal))
  assert.notEqual(parseSongWav(Buffer.from(stage.data)).pcm.readInt16LE(0), 0)
  assert.deepEqual([...stage.vocalEnvelope], [...Array(40).fill(0), ...Array(40).fill(159), ...Array(41).fill(0)])
  assert.equal(store.activities().find(item => item.kind === 'song.archived').data.vocalEnvelopeSamples, 121)
  await singing.close()
  assert.deepEqual(readdirSync(join(media, 'songs')), [`${task.id}.wav`])
  const reopened = new CompanionStore(path)
  try {
    assert.deepEqual((await new SingingService(reopened, media).audio(task.id, undefined, true)).vocalEnvelope, stage.vocalEnvelope)
  } finally { reopened.close() }

  const sqlite = new DatabaseSync(path)
  try {
    sqlite.prepare('UPDATE song_vocal_envelope SET audio_hash=? WHERE asset_id=?').run('a'.repeat(64), task.id)
    assert.equal((await singing.audio(task.id, undefined, true)).vocalEnvelope, undefined)
    sqlite.prepare('UPDATE song_vocal_envelope SET audio_hash=?, samples=? WHERE asset_id=?')
      .run(store.media.get(task.id).hash, stage.vocalEnvelope.subarray(0, 120), task.id)
    assert.equal((await singing.audio(task.id, undefined, true)).vocalEnvelope, undefined)
  } finally { sqlite.close() }
  const tampered = Buffer.from(stage.data)
  tampered[tampered.length - 1] ^= 1
  writeFileSync(stage.filePath, tampered)
  await assert.rejects(singing.audio(task.id, undefined, true), { code: 'singing-audio-not-found' })
})

test('vocal metadata and WAV never survive cancellation or an archive transaction rollback', async t => {
  const guide = wave(16_000, 1, 48_000, () => 1000)
  const accompaniment = wave(16_000, 1, 48_000, () => 2000)
  for (const scenario of ['cancelled', 'failed']) {
    await t.test(scenario, async t => {
      let release
      const { path, media, store, singing } = coverFixture(t, { convert: () => new Promise(resolve => { release = resolve }) })
      const original = store.recordActivity.bind(store)
      if (scenario === 'failed') t.mock.method(store, 'recordActivity', event => {
        if (event.kind === 'song.archived') throw new Error('simulated failure after envelope write')
        return original(event)
      })
      const { task } = singing.submitCover('取消口型归档', guide, { accompaniment })
      await nextTick()
      assert.equal(store.taskById(task.id).status, 'running')
      if (scenario === 'cancelled') singing.cancel(task.id)
      release(guide)
      assert.equal((await settled(store, task.id)).status, scenario)
      await singing.close()
      assert.equal(store.media.get(task.id), undefined)
      assert.deepEqual(readdirSync(join(media, 'songs')), [])
      const sqlite = new DatabaseSync(path, { readOnly: true })
      try { assert.equal(sqlite.prepare('SELECT count(*) AS n FROM song_vocal_envelope').get().n, 0) }
      finally { sqlite.close() }
    })
  }
})

test('owner multipart cover validates all parts and archives only a successful mixed WAV', async t => {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/singing-mix-test-'))
  const store = new CompanionStore(join(root, 'store.sqlite'))
  const guide = wave(16_000, 1, 48_000, () => 1000)
  const backing = wave(32_000, 2, 32_000, (_frame, channel) => channel === 0 ? 500 : 100)
  const singing = new SingingService(store, join(root, 'media'), undefined, { convert: async bytes => bytes })
  t.after(async () => { await singing.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  let route, origin
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }, { singing })
  const server = createServer(route.handler)
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections() }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/companion/api/singing/covers?title=Cover`
  const validForm = (accompaniment = backing) => {
    const form = new FormData()
    form.append('guide', new Blob([guide], { type: 'audio/wav' }), 'guide.wav')
    form.append('accompaniment', new Blob([accompaniment], { type: 'audio/wav' }), 'accompaniment.wav')
    return form
  }
  const send = (form, authorized = true) => fetch(endpoint, { method: 'POST', headers: authorized ? { 'x-companion-request': '1' } : {}, body: form })
  assert.equal((await send(validForm(), false)).status, 403)
  const unknown = validForm()
  unknown.append('unknown', 'x')
  assert.equal((await (await send(unknown)).json()).code, 'singing-invalid-multipart')
  const duplicate = validForm()
  duplicate.append('guide', 'x')
  assert.equal((await (await send(duplicate)).json()).code, 'singing-invalid-multipart')
  const gain = validForm()
  gain.append('backingGainDb', '6.1')
  assert.equal((await (await send(gain)).json()).code, 'singing-invalid-gain')
  assert.equal((await (await send(validForm(Buffer.from('malformed')))).json()).code, 'singing-invalid-accompaniment')
  const oversize = await new Promise((done, reject) => {
    const req = request(endpoint, { method: 'POST', headers: {
      'x-companion-request': '1', 'content-type': 'multipart/form-data; boundary=test',
      'content-length': String(2 * MAX_SINGING_WAV_BYTES + 65_537),
    } }, res => { res.resume(); done(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(oversize, 413)
  assert.equal(singing.view().tasks.length, 0)

  const accepted = await send(validForm())
  assert.equal(accepted.status, 202)
  const { task } = await accepted.json()
  for (let attempt = 0; attempt < 100 && ['accepted', 'running'].includes(store.taskById(task.id).status); attempt++) await delay(10)
  assert.equal(store.taskById(task.id).status, 'succeeded')
  const archived = parseSongWav(Buffer.from((await singing.audio(task.id)).data))
  assert.equal(archived.frames, 48_000)
  assert.equal(archived.channels, 2)
  assert.equal(archived.pcm.readInt16LE(0), Math.round(1000 * 10 ** (-2 / 20) + 500 * 10 ** (-10 / 20)))
  assert.equal(archived.pcm.readInt16LE(47_999 * 4), Math.round(1000 * 10 ** (-2 / 20)))
  const receipt = store.activities().find(item => item.kind === 'song.archived')
  assert.equal(receipt.data.mode, 'cover')
  assert.equal(receipt.data.backingMixed, true)
  assert.equal(receipt.data.durationSeconds, 3)
})
