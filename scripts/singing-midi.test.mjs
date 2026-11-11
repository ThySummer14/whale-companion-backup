import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_SINGING_MIDI_BYTES, parseSingingMidi, singingMidiDraft } from '../src/protocol/singing-midi.ts'
import { parseScoreDraft } from '../src/protocol/singing-score.ts'
import { MAX_SINGING_SCORE_ROWS } from '../src/protocol/singing.ts'

function variable(value) {
  const bytes = [value & 0x7f]
  while ((value >>= 7)) bytes.unshift((value & 0x7f) | 0x80)
  return bytes
}

const event = (delta, ...data) => [...variable(delta), ...data]
const meta = (delta, type, data) => event(delta, 0xff, type, ...variable(data.length), ...data)
const name = text => meta(0, 0x03, Buffer.from(text))
const lyric = (delta, text) => meta(delta, 0x05, Buffer.from(text))
const tempo = (delta, micros) => meta(delta, 0x51, [micros >>> 16, (micros >>> 8) & 0xff, micros & 0xff])
const end = () => meta(0, 0x2f, [])

function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.write(type)
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, Buffer.from(data)])
}

function midi(tracks, { format = tracks.length > 1 ? 1 : 0, ppq = 480, count = tracks.length, before = [] } = {}) {
  const header = Buffer.alloc(6)
  header.writeUInt16BE(format, 0)
  header.writeUInt16BE(count, 2)
  header.writeUInt16BE(ppq, 4)
  return Buffer.concat([chunk('MThd', header), ...before, ...tracks.map(events => chunk('MTrk', events.flat()))])
}

function note(pitch, duration = 480, delay = 0) {
  return [...event(delay, 0x90, pitch, 80), ...event(duration, pitch, 0)]
}

const pick = (overrides = {}) => ({ track: 1, channel: 1, start: 1, count: 1, ...overrides })

test('format 1 reads a named melody, conductor tempo, running status and aligned UTF-8 lyrics', () => {
  const melody = [
    name('主旋律'), lyric(480, '海'), event(0, 0x90, 60, 100), event(960, 60, 0),
    lyric(0, '风'), event(0, 0x90, 62, 100), event(480, 0x80, 62, 0),
    lyric(0, '_'), note(64), lyric(240, '归'), note(60, 960), end(),
  ]
  const drums = [event(0, 0x99, 36, 100), event(120, 0x89, 36, 0), end()]
  const input = midi([[tempo(0, 666_667), tempo(5_000, 500_000), end()], melody, drums],
    { before: [chunk('INFO', [1, 2, 3])] })
  const parsed = parseSingingMidi(input)
  assert.deepEqual(parsed.tracks, [{ track: 2, channel: 1, name: '主旋律', noteCount: 4 }])
  assert.deepEqual(singingMidiDraft(parsed, pick({ track: 2, count: 4 })), {
    bpm: 90, text: '60 2 海\n62 1 风\n64 1 _\nR 0.5\n60 2 归',
  })
})

test('format 0 keeps channels separate and leaves conflicting or unsupported lyric events blank', () => {
  const parsed = parseSingingMidi(midi([[
    name('声部\u202e1'), lyric(0, '原'), event(0, 0x92, 66, 80), event(0, 0x90, 60, 80),
    event(480, 0x80, 60, 0), event(0, 0x82, 66, 0),
    lyric(0, [0xd6, 0xd0]), note(62), lyric(0, '海风'), note(64),
    lyric(0, '潮'), lyric(0, '汐'), note(65), lyric(0, '声'), note(67), end(),
  ]]))
  assert.deepEqual(parsed.tracks, [
    { track: 1, channel: 1, name: '声部 1', noteCount: 5 },
    { track: 1, channel: 3, name: '声部 1', noteCount: 1 },
  ])
  assert.deepEqual(singingMidiDraft(parsed, pick({ count: 5 })), {
    bpm: 120, text: '60 1\n62 1\n64 1\n65 1\n67 1 声',
  })
  assert.deepEqual(singingMidiDraft(parsed, pick({ start: 4, count: 2, lyrics: '大\n鱼' })), {
    bpm: 120, text: '65 1 大\n67 1 鱼',
  })
  for (const lyrics of ['鱼', '鱼海浪', '大。', '大🐟']) {
    assert.throws(() => singingMidiDraft(parsed, pick({ count: 2, lyrics })), /歌词/)
  }
  for (const choice of [pick({ count: 6 }), pick({ start: 0 }), pick({ count: 1.5 }), pick({ count: MAX_SINGING_SCORE_ROWS + 1 })]) {
    assert.throws(() => singingMidiDraft(parsed, choice), /范围/)
  }
  assert.throws(() => singingMidiDraft(parsed, pick({ channel: 10 })), /轨道和通道/)
})

test('tempo changes constrain the selected interval, including rests and exact boundaries', () => {
  const parsed = parseSingingMidi(midi([
    [tempo(0, 500_000), tempo(240, 500_000), tempo(480, 750_000), tempo(480, 333_333), end()],
    [note(60), note(62, 720, 240), note(64), end()],
  ]))
  assert.deepEqual(singingMidiDraft(parsed, pick({ track: 2 })), { bpm: 120, text: '60 1' })
  assert.throws(() => singingMidiDraft(parsed, pick({ track: 2, start: 2 })), /变速/)
  assert.deepEqual(singingMidiDraft(parsed, pick({ track: 2, start: 3 })), { bpm: 180, text: '64 1' })
  const slow = parseSingingMidi(midi([[tempo(0, 1_500_000), note(60), end()]]))
  assert.throws(() => singingMidiDraft(slow, pick()), /60–180/)
  const inRest = parseSingingMidi(midi([
    [tempo(720, 600_000), end()], [note(60), note(62, 480, 480), end()],
  ]))
  assert.throws(() => singingMidiDraft(inRest, pick({ track: 2, count: 2 })), /变速/)
})

test('quarter-beat grid permits a one-tick roundoff and keeps larger rests in editable rows', () => {
  const snapped = parseSingingMidi(midi([[note(60, 241, 90), note(61, 479, 119), end()]]))
  assert.equal(singingMidiDraft(snapped, pick({ count: 2 })).text, '60 0.5\nR 0.25\n61 1')
  const rest = parseSingingMidi(midi([[note(60), note(62, 480, 4_080), end()]]))
  assert.equal(singingMidiDraft(rest, pick({ count: 2 })).text, '60 1\nR 8\nR 0.5\n62 1')
  for (const [duration, error] of [[477, /网格/], [1, /单个音符/], [4_320, /单个音符/]]) {
    const parsed = parseSingingMidi(midi([[note(60, duration), end()]]))
    assert.throws(() => singingMidiDraft(parsed, pick()), error)
  }
  const distant = parseSingingMidi(midi([[note(60), note(62, 480, 3840 * MAX_SINGING_SCORE_ROWS), end()]]))
  assert.throws(() => singingMidiDraft(distant, pick({ count: 2 })), /512 个/)
})

test('imports a single selection spanning more than 64 notes and plans consecutive phrases', () => {
  const notes = Array.from({ length: 96 }, () => note(60, 120))
  const parsed = parseSingingMidi(midi([[...notes, end()]]))
  const { bpm, text } = singingMidiDraft(parsed, pick({ count: notes.length, lyrics: '鱼'.repeat(notes.length) }))
  const score = parseScoreDraft(text, bpm)
  assert.equal(score.duration, 12)
  assert.equal(score.notes.length, 96)
  assert.deepEqual(score.phrases, [
    { start: 0, end: 64, startBeats: 0, endBeats: 16 },
    { start: 64, end: 96, startBeats: 16, endBeats: 24 },
  ])
})

test('rejects a chord within or crossing the selected range and preserves a separate later passage', () => {
  const chord = [event(0, 0x90, 60, 80), event(0, 64, 80), event(480, 60, 0), event(0, 64, 0)]
  const parsed = parseSingingMidi(midi([[...chord, note(67), note(85), end()]]))
  for (const choice of [pick(), pick({ start: 2 }), pick({ count: 2 })]) {
    assert.throws(() => singingMidiDraft(parsed, choice), /重叠/)
  }
  assert.equal(singingMidiDraft(parsed, pick({ start: 3 })).text, '67 1')
  assert.throws(() => singingMidiDraft(parsed, pick({ start: 4 })), /48–84/)
})

test('rejects malformed chunks, unsafe lengths, invalid running status, and unsupported clocks', () => {
  const valid = midi([[note(60), end()]])
  const cases = [
    [new Uint8Array(MAX_SINGING_MIDI_BYTES + 1), /256 KiB/],
    [Buffer.from('RIFFjunk'), /标准 MIDI/],
    [valid.subarray(0, -1), /不完整/],
    [midi([[end()]], { format: 2 }), /格式 0 或 1/],
    [midi([[end()]], { format: 1, count: 33 }), /32 条/],
    [midi([[end()]], { format: 1, count: 2 }), /轨道数量/],
    [midi([[end()]], { ppq: 0xe728 }), /PPQ/],
    [midi([[event(0, 60, 80), end()]]), /运行状态/],
    [midi([[note(60), lyric(0, '海'), event(0, 62, 80), end()]]), /运行状态/],
    [midi([[event(0, 0x90, 60, 80), end()]]), /未结束/],
    [midi([[event(0, 0x80, 60, 0), end()]]), /未配对/],
    [midi([[note(60)]]), /缺少结束/],
    [midi([[end(), end()]]), /结束事件无效/],
    [midi([[[0x80, 0x80, 0x80, 0x80, 0x00], end()]]), /可变长度/],
    [midi([[tempo(0, 0), note(60), end()]]), /速度事件/],
    [midi([[tempo(0, 500_000), tempo(0, 600_000), note(60), end()]]), /不同速度/],
    [midi([[event(0, 0x99, 36, 90), event(480, 0x89, 36, 0), end()]]), /没有可选/],
  ]
  for (const [input, error] of cases) assert.throws(() => parseSingingMidi(input), error)
})
