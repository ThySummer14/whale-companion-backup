import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { SingingScoreInput } from '../protocol/singing.ts'
import type { SingingScorePhrase } from '../protocol/singing-score.ts'
import { DeviceAuthError } from './devices.ts'
import type { SingingCoverProvider } from './singing-cover.ts'
import { readSingingWorkerWav, runSingingWorker } from './singing-worker.ts'
import { allocateSongWav, parseSongWav, type SongWav } from './song-mix.ts'

const MAX_CONVERSION_SECONDS = 45
const SOULX_HOP_MS = 20
export const MAX_SCORE_TIMING_DRIFT_SECONDS = 0.15

export interface SingingScoreProvider {
  synthesize(score: SingingScoreInput, signal: AbortSignal, phrases?: readonly SingingScorePhrase[]): Promise<Uint8Array>
}

function guideBoundary(beats: number, bpm: number, rate: number): number {
  // Match SoulX's globally quantized Python boundaries, including half-hop ties.
  const numerator = beats * 4 * 60_000
  const denominator = 4 * bpm * SOULX_HOP_MS
  const whole = Math.floor(numerator / denominator)
  const twiceRemainder = (numerator % denominator) * 2
  const hops = whole + Number(twiceRemainder > denominator || twiceRemainder === denominator && whole % 2 === 1)
  return Math.round(hops * SOULX_HOP_MS * rate / 1000)
}

export async function convertLongScore(guide: SongWav, phrases: readonly SingingScorePhrase[], bpm: number, cover: SingingCoverProvider,
  signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<Buffer> {
  const secondsPerBeat = 60 / bpm
  const ends: number[] = []
  let startBeats = 0
  for (const phrase of phrases) {
    if ((phrase.endBeats - startBeats) * secondsPerBeat > MAX_CONVERSION_SECONDS) {
      ends.push(phrase.startBeats)
      startBeats = phrase.startBeats
    }
  }
  ends.push(phrases.at(-1)!.endBeats)
  startBeats = 0
  let guideStart = 0
  let targetStart = 0
  let rate = 0
  let output: Buffer | undefined
  progress(0, ends.length)
  for (const [index, endBeats] of ends.entries()) {
    signal.throwIfAborted()
    const endSeconds = endBeats * secondsPerBeat
    const guideEnd = index === ends.length - 1 ? guide.frames : guideBoundary(endBeats, bpm, guide.rate)
    const frameBytes = guide.channels * 2
    const input = allocateSongWav(guide.rate, guide.channels, guideEnd - guideStart)
    guide.pcm.copy(input, 44, guideStart * frameBytes, guideEnd * frameBytes)
    const converted = await cover.convert(input, signal)
    signal.throwIfAborted()
    const expected = (endBeats - startBeats) * secondsPerBeat
    let wav: SongWav
    try { wav = parseSongWav(Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength),
      expected - MAX_SCORE_TIMING_DRIFT_SECONDS, expected + MAX_SCORE_TIMING_DRIFT_SECONDS) }
    catch { throw new DeviceAuthError(502, 'singing-invalid-audio') }
    // Long scores use a mono archive at the converter's native rate, capped at 48 kHz to fit the existing 24 MiB limit.
    if (!output) {
      rate = Math.min(48_000, wav.rate)
      output = allocateSongWav(rate, 1, Math.round(ends.at(-1)! * secondsPerBeat * rate))
    }
    const targetEnd = Math.round(endSeconds * rate)
    const frames = Math.min(targetEnd - targetStart, Math.floor(wav.frames * rate / wav.rate))
    const fade = Math.min(Math.round(rate * 0.006), Math.floor(frames / 2))
    for (let frame = 0; frame < frames; frame++) {
      if (frame % 16_384 === 0) await setImmediate(undefined, { signal })
      const sample = Math.floor(frame * wav.rate / rate) * wav.channels * 2
      const value = wav.channels === 1 ? wav.pcm.readInt16LE(sample)
        : (wav.pcm.readInt16LE(sample) + wav.pcm.readInt16LE(sample + 2)) / 2
      const gain = index > 0 && frame < fade ? frame / fade
        : index < ends.length - 1 && frame >= frames - fade ? (frames - 1 - frame) / fade : 1
      output.writeInt16LE(Math.round(value * gain), 44 + (targetStart + frame) * 2)
    }
    guideStart = guideEnd
    targetStart = targetEnd
    startBeats = endBeats
    progress(index + 1, ends.length)
  }
  return output!
}

/** Preserve explicit rests in the final PCM even if a model generates residual sound. */
export function silenceScoreRests(wav: SongWav, score: SingingScoreInput): void {
  const frameBytes = wav.channels * 2
  const framesPerBeat = wav.rate * 60 / score.bpm
  const fadeFrames = Math.round(wav.rate * 0.012)
  const attenuate = (frame: number, gain: number) => {
    const offset = frame * frameBytes
    for (let channel = 0; channel < wav.channels; channel++) {
      const sample = offset + channel * 2
      wav.pcm.writeInt16LE(Math.round(wav.pcm.readInt16LE(sample) * gain), sample)
    }
  }
  const silence = (start: number, end: number) => {
    const fade = Math.min(fadeFrames, Math.floor((end - start) / 2))
    const fadeOut = start === 0 ? 0 : fade
    const fadeIn = end === wav.frames ? 0 : fade
    for (let index = 0; index < fadeOut; index++) attenuate(start + index, 1 - index / fadeOut)
    wav.pcm.fill(0, (start + fadeOut) * frameBytes, (end - fadeIn) * frameBytes)
    for (let index = 0; index < fadeIn; index++) attenuate(end - 1 - index, 1 - index / fadeIn)
  }
  let beats = 0
  let restStart: number | undefined
  for (const note of score.notes) {
    const frame = Math.min(wav.frames, Math.round(beats * framesPerBeat))
    if (note.midi === null) restStart ??= frame
    else if (restStart !== undefined) {
      silence(restStart, frame)
      restStart = undefined
    }
    beats += note.beats
  }
  if (restStart !== undefined) silence(restStart, wav.frames)
}

interface SoulXOptions {
  pythonPath: string
  repoDir: string
  modelPath: string
  promptAudio: string
  promptMetadata: string
  scratchRoot: string
  device: 'mps' | 'cpu'
  timeoutMs: number
}

export class SoulXScoreProvider implements SingingScoreProvider {
  private readonly worker = join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'scripts', 'run-soulx-score.py')

  constructor(private readonly options: SoulXOptions) {
    const { pythonPath, repoDir, modelPath, promptAudio, promptMetadata, scratchRoot, timeoutMs } = options
    if (![pythonPath, repoDir, modelPath, promptAudio, promptMetadata, scratchRoot].every(isAbsolute)) {
      throw new Error('SoulX-Singer paths must be absolute')
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 15_000 || timeoutMs > 300_000) throw new Error('Invalid SoulX-Singer timeout')
  }

  async synthesize(score: SingingScoreInput, client: AbortSignal, phrases?: readonly SingingScorePhrase[]): Promise<Uint8Array> {
    const { pythonPath, repoDir, modelPath, promptAudio, promptMetadata, scratchRoot, device, timeoutMs } = this.options
    const budget = phrases ? Math.min(720_000, timeoutMs * phrases.length) : timeoutMs
    const signal = AbortSignal.any([client, AbortSignal.timeout(budget)])
    signal.throwIfAborted()
    const assets = await Promise.all([join(repoDir, 'cli', 'inference.py'), modelPath, promptAudio, promptMetadata]
      .map(path => stat(path).catch(() => undefined)))
    signal.throwIfAborted()
    if (assets.some(asset => !asset?.isFile() || !asset.size)) throw new DeviceAuthError(503, 'singing-score-assets-unavailable')

    await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(scratchRoot, 'score-'))
    try {
      const input = join(directory, 'score.json')
      await writeFile(input, JSON.stringify(phrases ? { ...score, phrases } : score), { mode: 0o600, flag: 'wx', signal })
      await runSingingWorker(pythonPath, repoDir,
        [this.worker, repoDir, modelPath, promptAudio, promptMetadata, input, directory, device],
        signal, 'singing-score-failed', {
          MPLCONFIGDIR: directory, PYTORCH_ENABLE_MPS_FALLBACK: '1', TRANSFORMERS_OFFLINE: '1',
          TORCH_FORCE_WEIGHTS_ONLY_LOAD: '1',
        })
      return await readSingingWorkerWav(join(directory, 'generated.wav'), signal, 'singing-score-output-invalid')
    } catch (error) {
      client.throwIfAborted()
      if (signal.aborted) throw new DeviceAuthError(503, 'singing-score-timeout')
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'singing-score-failed')
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }
}
