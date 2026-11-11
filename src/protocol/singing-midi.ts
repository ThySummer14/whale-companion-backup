import { MAX_SINGING_SCORE_ROWS } from './singing.ts'
import { SINGING_SCORE_LYRIC } from './singing-score.ts'

export const MAX_SINGING_MIDI_BYTES = 256 * 1024
export const MAX_SINGING_MIDI_TRACKS = 32

const DEFAULT_TEMPO = 500_000
const nameDecoder = new TextDecoder()
const lyricDecoder = new TextDecoder('utf-8', { fatal: true })

interface MidiNote {
  pitch: number
  start: number
  end: number
}

interface MidiTrack {
  name?: string
  notes: Map<number, MidiNote[]>
  lyrics: Map<number, string | null>
}

interface MidiTempo {
  tick: number
  micros: number
}

interface MidiTrackChoice {
  track: number
  channel: number
  name?: string
  noteCount: number
}

interface ParsedSingingMidi {
  tracks: MidiTrackChoice[]
  ticksPerBeat: number
  tempos: MidiTempo[]
  sourceTracks: MidiTrack[]
}

class MidiReader {
  private offset = 0
  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get done() { return this.offset === this.bytes.length }

  read(length: number): Uint8Array {
    const end = this.offset + length
    if (end > this.bytes.length) throw new Error('MIDI 文件或轨道数据不完整。')
    const result = this.bytes.subarray(this.offset, end)
    this.offset = end
    return result
  }

  uint(length: number): number {
    let result = 0
    for (const byte of this.read(length)) result = result * 256 + byte
    return result
  }

  variableLength(): number {
    let result = 0
    for (let n = 0; n < 4; n++) {
      const byte = this.uint(1)
      result = result * 128 + (byte & 0x7f)
      if (byte < 0x80) return result
    }
    throw new Error('MIDI 文件含无效的可变长度字段。')
  }
}

function embeddedLyric(bytes: Uint8Array): string | undefined {
  if (bytes.length > 32) return
  try {
    const lyric = lyricDecoder.decode(bytes).trim()
    if (SINGING_SCORE_LYRIC.test(lyric)) return lyric
  } catch {
    // Lyrics with a different encoding remain blank in the draft.
  }
}

function readTrack(reader: MidiReader, tempos: Map<number, number>): MidiTrack {
  const notes = new Map<number, MidiNote[]>()
  const lyrics = new Map<number, string | null>()
  const active = new Map<number, MidiNote[]>()
  let tick = 0
  let runningStatus = 0
  let name: string | undefined
  while (!reader.done) {
    tick += reader.variableLength()
    const byte = reader.uint(1)
    const status = byte < 0x80 ? runningStatus : byte
    if (status === 0) throw new Error('MIDI 轨道含无效的运行状态。')
    if (status >= 0xf0) {
      runningStatus = 0
      if (status === 0xf0 || status === 0xf7) {
        reader.read(reader.variableLength())
        continue
      }
      if (status !== 0xff) throw new Error('MIDI 轨道含无效的系统事件。')
      const type = reader.uint(1)
      const data = reader.read(reader.variableLength())
      if (type === 0x2f) {
        if (data.length || !reader.done) throw new Error('MIDI 轨道结束事件无效。')
        if (active.size) throw new Error('MIDI 轨道有未结束的音符。')
        return { name, notes, lyrics }
      }
      if (type === 0x03 && name === undefined) {
        name = nameDecoder.decode(data.subarray(0, 256)).replace(/\p{C}/gu, ' ').trim().slice(0, 80)
      }
      if (type === 0x05) {
        const lyric = embeddedLyric(data)
        if (lyric) {
          const previous = lyrics.get(tick)
          lyrics.set(tick, previous === undefined || previous === lyric ? lyric : null)
        }
      }
      if (type === 0x51) {
        const micros = new MidiReader(data).uint(3)
        if (data.length !== 3 || !micros) throw new Error('MIDI 速度事件无效。')
        const previous = tempos.get(tick)
        if (previous !== undefined && previous !== micros) throw new Error('MIDI 在同一位置指定了不同速度。')
        tempos.set(tick, micros)
      }
      continue
    }

    runningStatus = status
    const command = status & 0xf0
    const channel = (status & 0x0f) + 1
    const first = byte < 0x80 ? byte : reader.uint(1)
    const second = command === 0xc0 || command === 0xd0 ? 0 : reader.uint(1)
    if (first >= 0x80 || second >= 0x80) throw new Error('MIDI 轨道含无效的通道事件。')
    if (channel === 10 || (command !== 0x80 && command !== 0x90)) continue

    const key = channel * 128 + first
    const open = active.get(key) ?? []
    if (command === 0x90 && second > 0) {
      const note = { pitch: first, start: tick, end: tick }
      const channelNotes = notes.get(channel) ?? []
      channelNotes.push(note)
      notes.set(channel, channelNotes)
      open.push(note)
      active.set(key, open)
    } else {
      const note = open.pop()
      if (!note) throw new Error('MIDI 轨道有未配对的音符结束事件。')
      note.end = tick
      if (!open.length) active.delete(key)
    }
  }
  throw new Error('MIDI 轨道缺少结束事件。')
}

export function parseSingingMidi(bytes: Uint8Array): ParsedSingingMidi {
  if (bytes.length > MAX_SINGING_MIDI_BYTES) throw new Error('MIDI 文件最多 256 KiB。')
  const reader = new MidiReader(bytes)
  if (reader.uint(4) !== 0x4d546864) throw new Error('请选择标准 MIDI 文件（.mid 或 .midi）。')
  const header = new MidiReader(reader.read(reader.uint(4)))
  const format = header.uint(2)
  const trackCount = header.uint(2)
  const ticksPerBeat = header.uint(2)
  if (format !== 0 && format !== 1) throw new Error('请使用 MIDI 格式 0 或 1。')
  if (!trackCount || trackCount > MAX_SINGING_MIDI_TRACKS || (format === 0 && trackCount !== 1)) {
    throw new Error('MIDI 格式 0 需要一条轨道，格式 1 最多 32 条。')
  }
  if (!ticksPerBeat || ticksPerBeat >= 0x8000) throw new Error('请用以拍为单位的 PPQ MIDI 导出。')

  const tracks: MidiTrackChoice[] = []
  const sourceTracks: MidiTrack[] = []
  const tempoEvents = new Map<number, number>()
  while (!reader.done) {
    const type = reader.uint(4)
    const chunk = reader.read(reader.uint(4))
    if (type !== 0x4d54726b) continue
    if (sourceTracks.length >= trackCount) throw new Error('MIDI 轨道数量与文件头不符。')
    const track = readTrack(new MidiReader(chunk), tempoEvents)
    sourceTracks.push(track)
    for (const [channel, notes] of [...track.notes].sort(([left], [right]) => left - right)) {
      tracks.push({ track: sourceTracks.length, channel, name: track.name || undefined, noteCount: notes.length })
    }
  }
  if (sourceTracks.length !== trackCount) throw new Error('MIDI 轨道数量与文件头不符。')
  if (!tracks.length) throw new Error('MIDI 文件中没有可选的旋律音符。')
  const tempos = Array.from(tempoEvents, ([tick, micros]) => ({ tick, micros })).sort((left, right) => left.tick - right.tick)
  return { tracks, ticksPerBeat, tempos, sourceTracks }
}

function draftBpm(tempos: MidiTempo[], start: number, end: number): number {
  let micros = DEFAULT_TEMPO
  for (const tempo of tempos) {
    if (tempo.tick >= end) break
    if (tempo.tick > start && tempo.micros !== micros) throw new Error('所选片段含变速，请选一段恒速旋律。')
    micros = tempo.micros
  }
  const bpm = Math.round(60_000_000 / micros)
  if (bpm < 60 || bpm > 180) throw new Error('所选片段的速度须在 60–180 BPM 之间。')
  return bpm
}

function beatUnits(tick: number, ticksPerBeat: number): number {
  const units = Math.round(tick * 4 / ticksPerBeat)
  // Some exporters round a grid position to its nearest integer MIDI tick.
  if (Math.abs(tick * 4 - units * ticksPerBeat) > 4) {
    throw new Error('音符起止须落在 0.25 拍网格上，请先在制谱软件量化。')
  }
  return units
}

export function singingMidiDraft(midi: ParsedSingingMidi, input: {
  track: number
  channel: number
  start: number
  count: number
  lyrics?: string
}): { bpm: number; text: string } {
  const { track, channel, start, count } = input
  const source = midi.sourceTracks[track - 1]
  const notes = source?.notes.get(channel)
  if (!source || !notes) throw new Error('请选择有旋律的 MIDI 轨道和通道。')
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > MAX_SINGING_SCORE_ROWS ||
    start + count - 1 > notes.length) throw new Error(`音符范围超出所选通道，每次可导入 1–${MAX_SINGING_SCORE_ROWS} 个音符。`)

  const selected = notes.slice(start - 1, start - 1 + count)
  const first = selected[0]!
  const last = selected.at(-1)!
  if (notes.slice(0, start - 1).some(note => note.end > first.start) ||
    (notes[start - 1 + count]?.start ?? Infinity) < last.end) {
    throw new Error('所选片段有重叠音符，请选单声部旋律。')
  }
  const bpm = draftBpm(midi.tempos, first.start, last.end)
  const words = Array.from(input.lyrics?.replace(/\s/gu, '') ?? '')
  if (words.length && (words.length !== count || words.some(word => !SINGING_SCORE_LYRIC.test(word)))) {
    throw new Error('歌词须为每个有音高的音符填写一个汉字或 _，数量需和所选音符一致。')
  }

  // Lyric events are track-wide. Do not guess their destination when two melodic channels start at the same tick.
  const otherStarts = new Set<number>()
  if (!words.length && source.lyrics.size) {
    for (const [otherChannel, otherNotes] of source.notes) {
      if (otherChannel === channel) continue
      for (const note of otherNotes) otherStarts.add(note.start)
    }
  }
  const rows: string[] = []
  let previousEnd = first.start
  let previousBeat = 0
  for (const [index, note] of selected.entries()) {
    if (note.start < previousEnd) throw new Error('所选片段有重叠音符，请选单声部旋律。')
    if (note.pitch < 48 || note.pitch > 84) throw new Error('所选片段的音高须在 C3–C6（MIDI 48–84）之间。')
    const onset = beatUnits(note.start - first.start, midi.ticksPerBeat)
    const end = beatUnits(note.end - first.start, midi.ticksPerBeat)
    if (end <= onset || end - onset > 32) throw new Error('所选片段的单个音符须为 0.25–8 拍。')
    let gap = onset - previousBeat
    // There is no need to materialize a long rest when it already exceeds the score row budget.
    if (rows.length + Math.ceil(gap / 32) + count - index > MAX_SINGING_SCORE_ROWS) {
      throw new Error(`曲谱最多 ${MAX_SINGING_SCORE_ROWS} 个音符和休止。`)
    }
    while (gap > 0) {
      const rest = Math.min(gap, 32)
      rows.push(`R ${rest / 4}`)
      gap -= rest
    }
    const lyric = words[index] ?? (otherStarts.has(note.start) ? undefined : source.lyrics.get(note.start))
    const row = `${note.pitch} ${(end - onset) / 4}`
    rows.push(lyric ? `${row} ${lyric}` : row)
    previousEnd = note.end
    previousBeat = end
  }
  return { bpm, text: rows.join('\n') }
}
