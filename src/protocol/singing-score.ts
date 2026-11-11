import { MAX_SINGING_SCORE_ROWS, MAX_SINGING_SCORE_SECONDS, MIN_SINGING_SCORE_SECONDS, scoreDurationSeconds, type SingingScoreInput } from './singing.ts'

const PITCH_CLASSES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const
const MAX_PHRASE_SECONDS = 24
const MAX_PHRASE_ROWS = 64
export const SINGING_SCORE_LYRIC = /^(?:[\u3400-\u4dbf\u4e00-\u9fff]|_)$/u

export interface SingingScorePhrase {
  start: number
  end: number
  startBeats: number
  endBeats: number
}

type Score = Pick<SingingScoreInput, 'bpm' | 'notes'>

function scoreBeatOffsets({ bpm, notes }: Score): number[] | undefined {
  if (!Number.isInteger(bpm) || bpm < 60 || bpm > 180 || notes.length < 2 || notes.length > MAX_SINGING_SCORE_ROWS) return
  const beatOffsets = [0]
  let previousSung = false
  let syllables = 0
  for (const { midi, beats, lyric } of notes) {
    if (!Number.isInteger(beats * 4) || beats < 0.25 || beats > 8) return
    if (midi === null) {
      if (lyric !== undefined) return
    } else if (!Number.isInteger(midi) || midi < 48 || midi > 84 ||
      !lyric || !SINGING_SCORE_LYRIC.test(lyric) || (lyric === '_' && !previousSung)) return
    if (midi !== null && lyric !== '_') syllables++
    previousSung = midi !== null
    beatOffsets.push(beatOffsets.at(-1)! + beats)
  }
  const totalBeatSeconds = beatOffsets.at(-1)! * 60
  if (syllables < 2 || totalBeatSeconds < MIN_SINGING_SCORE_SECONDS * bpm || totalBeatSeconds > MAX_SINGING_SCORE_SECONDS * bpm) return
  return beatOffsets
}

export function isValidSingingScore(score: Score): boolean {
  return scoreBeatOffsets(score) !== undefined
}

/** Cover every row exactly once without cutting a continued syllable. */
export function planSingingScore(score: Score): SingingScorePhrase[] | undefined {
  const beatOffsets = scoreBeatOffsets(score)
  if (!beatOffsets) return
  const { bpm, notes } = score

  // Solve from the end so a viable suffix is known before taking a cut. Among
  // the fewest phrases, prefer rests at the joins, then longer earlier phrases.
  const suffixes: ({ end: number; phrases: number; voicedCuts: number } | undefined)[] = []
  suffixes[notes.length] = { end: notes.length, phrases: 0, voicedCuts: 0 }
  for (let start = notes.length - 1; start >= 0; start--) {
    if (notes[start]!.lyric === '_') continue
    let syllables = 0
    for (let end = start + 1; end <= notes.length && end - start <= MAX_PHRASE_ROWS; end++) {
      const beatSeconds = (beatOffsets[end]! - beatOffsets[start]!) * 60
      if (beatSeconds > MAX_PHRASE_SECONDS * bpm) break
      const previous = notes[end - 1]!
      if (previous.midi !== null && previous.lyric !== '_') syllables++
      const suffix = suffixes[end]
      if (!suffix || syllables < 2 || beatSeconds < MIN_SINGING_SCORE_SECONDS * bpm) continue
      const phrases = suffix.phrases + 1
      const voicedCuts = suffix.voicedCuts + Number(end < notes.length && previous.midi !== null && notes[end]!.midi !== null)
      const best = suffixes[start]
      if (!best || phrases < best.phrases || (phrases === best.phrases && voicedCuts <= best.voicedCuts)) {
        suffixes[start] = { end, phrases, voicedCuts }
      }
    }
  }
  if (!suffixes[0]) return

  const plan: SingingScorePhrase[] = []
  for (let start = 0; start < notes.length;) {
    const { end } = suffixes[start]!
    plan.push({ start, end, startBeats: beatOffsets[start]!, endBeats: beatOffsets[end]! })
    start = end
  }
  return plan
}

function midiNumber(value: string): number {
  if (/^\d{1,3}$/u.test(value)) return Number(value)
  const name = /^([A-Ga-g])([#♯b♭]?)(\d)$/u.exec(value)
  if (!name?.[1]) return NaN
  const pitch = PITCH_CLASSES[name[1].toUpperCase() as keyof typeof PITCH_CLASSES]
  const accidental = name[2] === '#' || name[2] === '♯' ? 1 : name[2] ? -1 : 0
  return (Number(name[3]) + 1) * 12 + pitch + accidental
}

type ParsedScore = { notes: SingingScoreInput['notes']; duration: number; phrases: SingingScorePhrase[] } | { error: string }

export function parseScoreDraft(text: string, bpm: number): ParsedScore {
  if (!Number.isInteger(bpm) || bpm < 60 || bpm > 180) return { error: '速度须为 60–180 的整数。' }
  const notes: SingingScoreInput['notes'] = []
  let syllables = 0
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    const row = line.trim().split(/\s+/u)
    const [pitch = '', length = '', lyric = ''] = row
    const rest = /^(?:r|休)$/iu.test(pitch)
    const midi = rest ? null : midiNumber(pitch)
    const beats = Number(length)
    const prefix = `第 ${index + 1} 行`
    if (notes.length === MAX_SINGING_SCORE_ROWS) return { error: `曲谱最多 ${MAX_SINGING_SCORE_ROWS} 个音符和休止。` }
    if (midi !== null && !(midi >= 48 && midi <= 84)) return { error: `${prefix}的音高须在 C3–C6（MIDI 48–84）之间。` }
    if (!/^\d+(?:\.\d+)?$/u.test(length) || !Number.isInteger(beats * 4) || beats < 0.25 || beats > 8) {
      return { error: `${prefix}的时值须为 0.25–8 拍，按四分之一拍递增。` }
    }
    if (rest) {
      if (row.length !== 2) return { error: `${prefix}是休止，只需填写时值。` }
      notes.push({ midi, beats })
      continue
    }
    if (row.length !== 3 || !SINGING_SCORE_LYRIC.test(lyric)) {
      return { error: `${prefix}须填写一个汉字，或用 _ 延续上一音节。` }
    }
    if (lyric === '_') {
      const previous = notes.at(-1)
      if (!previous || previous.midi === null) return { error: `${prefix}的延音须紧接有歌词的音符。` }
    } else syllables++
    notes.push({ midi, beats, lyric })
  }
  if (syllables < 2) return { error: '曲谱至少需要两个写有汉字的音符。' }
  const duration = scoreDurationSeconds({ bpm, notes })
  if (duration < MIN_SINGING_SCORE_SECONDS || duration > MAX_SINGING_SCORE_SECONDS) {
    return { error: `当前约 ${duration.toFixed(1)} 秒，请调整到 ${MIN_SINGING_SCORE_SECONDS}–${MAX_SINGING_SCORE_SECONDS} 秒。` }
  }
  const phrases = planSingingScore({ bpm, notes })
  if (!phrases) return { error: '曲谱无法按音节完整分段。每段需 4–24 秒、至多 64 行、至少两个汉字起音。请缩短过长的延音或连续休止。' }
  return { notes, duration, phrases }
}
