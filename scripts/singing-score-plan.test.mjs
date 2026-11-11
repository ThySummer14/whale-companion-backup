import assert from 'node:assert/strict'
import test from 'node:test'
import { SingingScoreInputSchema } from '../src/host/api-schemas.ts'
import { parseScoreDraft, planSingingScore } from '../src/protocol/singing-score.ts'
import { MAX_SINGING_SCORE_ROWS, MAX_SINGING_SCORE_SECONDS, scoreDurationSeconds } from '../src/protocol/singing.ts'

const sung = (beats, lyric = '鱼') => ({ midi: 60, beats, lyric })
const rest = beats => ({ midi: null, beats })
const score = (notes, bpm = 60) => ({ title: '潮声', bpm, notes })
const draft = notes => notes.map(({ midi, beats, lyric }) => midi === null ? `R ${beats}` : `${midi} ${beats} ${lyric}`).join('\n')

function assertExactCoverage(input, phrases) {
  let row = 0
  let beats = 0
  for (const phrase of phrases) {
    const notes = input.notes.slice(phrase.start, phrase.end)
    assert.equal(phrase.start, row)
    assert.equal(phrase.startBeats, beats)
    assert.notEqual(notes[0].lyric, '_')
    assert.ok(notes.length <= 64)
    assert.ok(notes.filter(({ lyric }) => lyric && lyric !== '_').length >= 2)
    beats += notes.reduce((total, note) => total + note.beats, 0)
    row = phrase.end
    assert.equal(phrase.endBeats, beats)
    const duration = scoreDurationSeconds({ bpm: input.bpm, notes })
    assert.ok(duration >= 4 && duration <= 24)
  }
  assert.equal(row, input.notes.length)
  assert.equal(beats * 60 / input.bpm, scoreDurationSeconds(input))
}

test('keeps valid short scores as one phrase and preserves fractional beat offsets', () => {
  const input = score([rest(0.25), sung(2.25), sung(3, '_'), sung(2.5), rest(0.5)], 123)
  const parsed = parseScoreDraft(draft(input.notes), input.bpm)
  assert.ok(!('error' in parsed))
  const expected = [{ start: 0, end: 5, startBeats: 0, endBeats: 8.5 }]
  assert.deepEqual(parsed.phrases, expected)
  assert.deepEqual(planSingingScore(input), expected)
  assertExactCoverage(input, parsed.phrases)
  assert.equal(SingingScoreInputSchema.safeParse(input).success, true)
})

test('prefers a rest boundary with the fewest phrases and preserves a continued syllable', () => {
  const notes = Array.from({ length: 10 }, () => sung(3))
  notes[5] = rest(3)
  notes[7] = sung(3, '_')
  const input = score(notes)
  const phrases = planSingingScore(input)
  assert.deepEqual(phrases, [
    { start: 0, end: 6, startBeats: 0, endBeats: 18 },
    { start: 6, end: 10, startBeats: 18, endBeats: 30 },
  ])
  assertExactCoverage(input, phrases)
})

test('chooses a shorter first phrase when a longest cut would strand the last syllable', () => {
  const input = score([...Array.from({ length: 12 }, () => sung(2)), sung(2, '_')])
  const phrases = planSingingScore(input)
  assert.equal(phrases.length, 2)
  assert.equal(phrases[0].end, 10)
  assertExactCoverage(input, phrases)
})

test('supports the full 512-row score while independently limiting each phrase and total time', () => {
  const dense = score(Array.from({ length: MAX_SINGING_SCORE_ROWS }, () => sung(0.25)), 120)
  const parsed = parseScoreDraft(draft(dense.notes), dense.bpm)
  assert.ok(!('error' in parsed))
  assert.equal(parsed.phrases.length, 8)
  assertExactCoverage(dense, parsed.phrases)
  assert.equal(SingingScoreInputSchema.safeParse(dense).success, true)
  assert.equal(SingingScoreInputSchema.safeParse(score([...dense.notes, sung(0.25)], dense.bpm)).success, false)
  const longest = score(Array.from({ length: 60 }, () => sung(3)))
  assert.equal(scoreDurationSeconds(longest), MAX_SINGING_SCORE_SECONDS)
  assertExactCoverage(longest, planSingingScore(longest))
  assert.equal(SingingScoreInputSchema.safeParse(longest).success, true)
  assert.equal(SingingScoreInputSchema.safeParse(score([...longest.notes, sung(0.25)])).success, false)
})

test('rejects scores with a syllable or silence that cannot be partitioned before scheduling', () => {
  const cases = [
    [sung(8), sung(8, '_'), sung(8, '_'), sung(1, '_'), sung(3), sung(3)],
    [sung(2), sung(2), ...Array.from({ length: 7 }, () => rest(8)), sung(2), sung(2)],
  ]
  for (const notes of cases) {
    assert.equal(planSingingScore(score(notes)), undefined)
    assert.equal(SingingScoreInputSchema.safeParse(score(notes)).success, true)
    assert.match(parseScoreDraft(draft(notes), 60).error, /无法按音节完整分段/u)
  }
})
