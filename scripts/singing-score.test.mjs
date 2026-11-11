import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { SingingScoreInputSchema } from '../src/host/api-schemas.ts'
import { registerHttp } from '../src/host/http.ts'
import { SingingService, SINGING_CHAT_SCORE_ID_PREFIX } from '../src/host/singing.ts'
import { allocateSongWav, parseSongWav } from '../src/host/song-mix.ts'
import { scoreDurationSeconds } from '../src/protocol/singing.ts'

const input = {
  title: '潮汐短歌', bpm: 120, notes: [
    { midi: 60, beats: 2, lyric: '微' }, { midi: 62, beats: 1, lyric: '光' },
    { midi: 64, beats: 1, lyric: '_' }, { midi: null, beats: 2 }, { midi: 60, beats: 4, lyric: '归' },
  ],
}

function wav(seconds = 5) {
  const rate = 16_000
  const size = rate * seconds * 2
  const bytes = Buffer.alloc(44 + size)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(size, 40)
  bytes.writeInt16LE(800, 44)
  return bytes
}

function fixture(t, synthesize, convert = async bytes => bytes) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/singing-score-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const singing = new SingingService(store, join(directory, 'media'), undefined,
    { engine: 'applio-rvc', convert }, undefined, synthesize && { synthesize })
  t.after(async () => { await singing.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, singing }
}

async function terminal(store, id) {
  for (let n = 0; n < 100; n++) {
    const task = store.taskById(id)
    if (!['accepted', 'running'].includes(task.status)) return task
    await delay(5)
  }
  assert.fail('Score task did not settle')
}

test('score schema checks alignment, rests, melisma and finite rhythm before inference', () => {
  assert.equal(scoreDurationSeconds(SingingScoreInputSchema.parse(input)), 5)
  const update = (i, value) => input.notes.map((note, n) => n === i ? { ...note, ...value } : note)
  for (const invalid of [
    { notes: update(0, { lyric: '_' }) }, { notes: update(4, { lyric: '_' }) },
    { notes: update(3, { lyric: '音' }) }, { notes: update(1, { midi: 85 }) },
    { notes: update(0, { lyric: 'aa' }) }, { notes: update(0, { beats: 1.1 }) },
    { notes: [{ midi: 60, beats: 2, lyric: '微' }, { midi: 62, beats: 1, lyric: '光' }] },
    { notes: Array.from({ length: 91 }, () => input.notes[4]) }, { bpm: 59 }, { modelPath: '/private' },
  ]) assert.equal(SingingScoreInputSchema.safeParse({ ...input, ...invalid }).success, false, JSON.stringify(invalid))
})

test('owner endpoint queues a score and verifies both PCM stages before archival', async t => {
  const calls = []
  const audio = wav()
  const { store, singing } = fixture(t, async score => { calls.push(score); return audio },
    async guide => { calls.push('cover'); assert.deepEqual(guide, audio); return guide })
  let handler, origin
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } }, { store, singing })
  const server = createServer(handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const post = (payload, owner = true, suffix = 'singing/score') => fetch(origin + '/companion/api/' + suffix, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(owner && { 'x-companion-request': '1' }) },
    body: JSON.stringify(payload),
  })
  assert.equal((await post(input, false)).status, 403)
  assert.equal((await post({ ...input, bpm: 0 })).status, 400)
  const forged = await post({ capabilityId: 'core.chat', title: 'fake', externalId: SINGING_CHAT_SCORE_ID_PREFIX + '0'.repeat(64) }, true, 'tasks')
  assert.equal(forged.status, 403)
  const response = await post(input)
  assert.equal(response.status, 202)
  const accepted = await response.json()
  assert.equal(accepted.coverPhase, 'synthesizing')
  assert.equal(accepted.audio, undefined)
  assert.equal((await terminal(store, accepted.task.id)).status, 'succeeded')
  assert.deepEqual(calls, [input, 'cover'])
  assert.equal(singing.view().tasks[0].coverEngine, 'applio-rvc')
  assert.equal(singing.archive().items[0].id, accepted.task.id)
  assert.deepEqual(Buffer.from((await singing.audio(accepted.task.id)).data), audio)
  const receipt = store.activities().find(activity => activity.kind === 'song.archived')
  assert.equal(receipt.data.mode, 'score')
  assert.equal(receipt.data.coverEngine, 'applio-rvc')
  assert.ok(!JSON.stringify(receipt.data).includes('微'))
})

test('score rejects mistimed synthesis before conversion and mistimed conversion before archival', async t => {
  let converted = 0
  const badGuide = fixture(t, async () => wav(3), async bytes => { converted++; return bytes })
  const guideTask = badGuide.singing.submitScore(input).task
  assert.equal((await terminal(badGuide.store, guideTask.id)).error, 'singing-score-output-invalid')
  assert.equal(converted, 0)
  const badCover = fixture(t, async () => wav(), async () => wav(6))
  const coverTask = badCover.singing.submitScore(input).task
  assert.equal((await terminal(badCover.store, coverTask.id)).error, 'singing-invalid-audio')
  assert.deepEqual(badCover.singing.archive().items, [])
})

test('archived score silences explicit rests while preserving adjacent sung samples', async t => {
  const audio = wav()
  for (let offset = 44; offset < audio.length; offset += 2) audio.writeInt16LE(700, offset)
  const { store, singing } = fixture(t, async () => audio)
  const { task } = singing.submitScore(input)
  assert.equal((await terminal(store, task.id)).status, 'succeeded')
  const result = Buffer.from((await singing.audio(task.id)).data)
  const sample = seconds => result.readInt16LE(44 + Math.round(seconds * 16_000) * 2)
  assert.equal(sample(1.999), 700)
  assert.ok(sample(2.006) > 0 && sample(2.006) < 700)
  assert.ok(result.subarray(44 + 2.02 * 32_000, 44 + 2.98 * 32_000).every(byte => byte === 0))
  assert.ok(sample(2.994) > 0 && sample(2.994) < 700)
  assert.equal(sample(3.001), 700)
  assert.equal(audio.readInt16LE(44 + 2.5 * 32_000), 700)
})

test('score shares the single render slot and keeps a durable one-task receipt for each owner message', async t => {
  const { singing, store } = fixture(t, async (_, signal) => { await delay(60_000, undefined, { signal }); return wav() })
  const origin = { sessionId: 'score-session', messageId: 'original-message' }
  const { task } = singing.submitScore(input, origin)
  assert.equal(singing.submitScore({ ...input, title: 'model replay' }, origin).task.id, task.id)
  assert.throws(() => singing.submitCover('other', wav()), { code: 'singing-busy' })
  assert.equal(singing.sessionTask('another-session', task.id), undefined)
  assert.equal(singing.cancel(task.id).task.status, 'cancelled')
  await singing.close()
  assert.equal(singing.submitScore(input, origin).task.status, 'cancelled')
  assert.equal(singing.scoreForMessage(origin).task.status, 'cancelled')
  assert.equal(singing.scoreForMessage({ ...origin, sessionId: 'another-session' }), undefined)
  assert.equal(store.tasks(5, 'media.singing').length, 1)
  assert.equal(singing.archive().items.length, 0)
})

test('score requires both local engines before exposing its capability', t => {
  const { singing } = fixture(t)
  assert.equal(singing.view().scoreAvailable, undefined)
  assert.throws(() => singing.submitScore(input), { code: 'singing-score-unavailable' })
})

const longScore = {
  title: '长谱回归', bpm: 120,
  notes: Array.from({ length: 12 }, () => [
    { midi: 60, beats: 8, lyric: '微' }, { midi: 62, beats: 3, lyric: '光' }, { midi: null, beats: 1 },
  ]).flat(),
}

function sound(seconds, rate, channels, value) {
  const bytes = allocateSongWav(rate, channels, Math.round(seconds * rate))
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(value, i)
  return bytes
}

test('long score batches one guide, converts at planned seams and archives a single exact-timeline WAV', async t => {
  const converted = []
  let synthesis = 0
  let releaseFirst
  const gate = new Promise(resolve => { releaseFirst = resolve })
  const { store, singing } = fixture(t, async (score, _signal, plan) => {
    synthesis++
    assert.deepEqual(score, longScore)
    assert.deepEqual(plan.map(phrase => phrase.endBeats), [48, 96, 144])
    return sound(72, 24_000, 1, 500)
  }, async (part, signal) => {
    const index = converted.length
    converted.push(parseSongWav(part).durationSeconds)
    if (index === 0) await Promise.race([gate, delay(2000, undefined, { signal })])
    return sound(index === 0 ? 23.98 : 24.02, 48_000, 2, 600 + index * 100)
  })
  const { task } = singing.submitScore(longScore)
  for (let i = 0; i < 100 && !converted.length; i++) await delay(5)
  assert.deepEqual(singing.view().tasks[0].scoreProgress, { stage: 'converting', completed: 0, total: 3 })
  releaseFirst()
  assert.equal((await terminal(store, task.id)).status, 'succeeded')
  assert.equal(synthesis, 1)
  assert.deepEqual(converted, [24, 24, 24])
  const [item] = singing.archive().items
  assert.equal(item.durationSeconds, 72)
  assert.equal(singing.view().tasks[0].audio.durationSeconds, 72)
  const result = parseSongWav(Buffer.from((await singing.audio(task.id)).data), 72, 72)
  assert.equal(result.channels, 1)
  assert.equal(result.pcm.readInt16LE(1 * 48_000 * 2), 600)
  assert.equal(result.pcm.readInt16LE(25 * 48_000 * 2), 700)
  assert.equal(result.pcm.readInt16LE(49 * 48_000 * 2), 800)
  assert.ok(result.pcm.subarray(23.52 * 48_000 * 2, 23.98 * 48_000 * 2).every(byte => byte === 0))
  assert.equal(store.activities().find(activity => activity.kind === 'song.archived').data.conversionBlocks, 3)
})

test('cancelling a later conversion block leaves no partial track or successful receipt', async t => {
  let enteredSecond
  const second = new Promise(resolve => { enteredSecond = resolve })
  let blocks = 0
  const { store, singing } = fixture(t, async () => sound(72, 16_000, 1, 500), async (part, signal) => {
    if (++blocks === 1) return part
    enteredSecond()
    await delay(60_000, undefined, { signal })
    return part
  })
  const { task } = singing.submitScore(longScore)
  await second
  assert.deepEqual(singing.view().tasks[0].scoreProgress, { stage: 'converting', completed: 1, total: 3 })
  assert.equal(singing.cancel(task.id).task.status, 'cancelled')
  await singing.close()
  assert.equal(blocks, 2)
  assert.deepEqual(singing.archive().items, [])
  assert.equal(store.activities().filter(activity => activity.kind === 'song.archived').length, 0)
})
