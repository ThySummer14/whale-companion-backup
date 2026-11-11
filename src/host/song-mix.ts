import { setImmediate } from 'node:timers/promises'
import { MAX_SINGING_WAV_BYTES, MAX_SONG_VOCAL_SAMPLES, SONG_VOCAL_STEP_MS } from '../protocol/singing.ts'
import { wavChunks } from './wav.ts'

const MAX_WAV_OVERHEAD = 64 * 1024
const CHUNK_FRAMES = 16_384
const HEADROOM_PEAK = 0.98 * 32_767

export interface SongWav {
  pcm: Buffer
  rate: number
  channels: number
  frames: number
  durationSeconds: number
}

export interface SingingCoverMix {
  accompaniment: Buffer
  vocalGainDb?: number
  backingGainDb?: number
}

export function parseSongWav(contents: Buffer, minSeconds = 1, maxSeconds = 65): SongWav {
  const invalid = () => new Error('Invalid PCM16 WAV')
  if (contents.length < 44 || contents.length > MAX_SINGING_WAV_BYTES || contents.readUInt32LE(4) !== contents.length - 8) throw invalid()
  let rate = 0
  let channels = 0
  let pcm: Buffer | undefined
  let end = 12
  for (const { kind, start, size } of wavChunks(contents)) {
    end = start + size + size % 2
    if (kind === 'fmt ') {
      if (rate || !(size === 16 || size === 18 && contents.readUInt16LE(start + 16) === 0)) throw invalid()
      rate = contents.readUInt32LE(start + 4)
      channels = contents.readUInt16LE(start + 2)
      if (contents.readUInt16LE(start) !== 1 || ![1, 2].includes(channels) || rate < 16_000 || rate > 96_000 ||
        contents.readUInt32LE(start + 8) !== rate * channels * 2 || contents.readUInt16LE(start + 12) !== channels * 2 ||
        contents.readUInt16LE(start + 14) !== 16) throw invalid()
    } else if (kind === 'data') {
      if (!rate || pcm || size % (channels * 2) !== 0) throw invalid()
      pcm = contents.subarray(start, start + size)
    }
  }
  if (!pcm || end !== contents.length || contents.length - pcm.length > MAX_WAV_OVERHEAD) throw invalid()
  const frames = pcm.length / (channels * 2)
  const durationSeconds = frames / rate
  if (durationSeconds < minSeconds || durationSeconds > maxSeconds || !pcm.some(byte => byte !== 0)) throw invalid()
  return { pcm, rate, channels, frames, durationSeconds }
}

export function validSongGain(value: number): boolean {
  return Number.isFinite(value) && value >= -30 && value <= 6
}

export function songVocalSampleCount(wav: SongWav): number {
  return Math.ceil(wav.frames * 1000 / (wav.rate * SONG_VOCAL_STEP_MS))
}

export async function songVocalEnvelope(wav: SongWav, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const count = songVocalSampleCount(wav)
  if (count < 1 || count > MAX_SONG_VOCAL_SAMPLES) throw new Error('Invalid song vocal envelope length')
  const levels = new Uint8Array(count)
  const framesPerBucket = wav.rate * SONG_VOCAL_STEP_MS / 1000
  const bucketsPerYield = Math.floor(CHUNK_FRAMES / framesPerBucket)
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.ceil(bucket * framesPerBucket)
    const end = Math.min(wav.frames, Math.ceil((bucket + 1) * framesPerBucket))
    let sum = 0
    for (let offset = start * wav.channels * 2; offset < end * wav.channels * 2; offset += 2) {
      const sample = wav.pcm.readInt16LE(offset)
      sum += sample * sample
    }
    if (end > start) {
      const rms = Math.sqrt(sum / ((end - start) * wav.channels)) / 32_768
      levels[bucket] = Math.round(Math.min(1, rms * 5) * 255)
    }
    if ((bucket + 1) % bucketsPerYield === 0) await setImmediate(undefined, { signal })
  }
  signal.throwIfAborted()
  return levels
}

export function allocateSongWav(rate: number, channels: number, frames: number): Buffer {
  const bytes = frames * channels * 2
  const wav = Buffer.alloc(44 + bytes)
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
  wav.writeUInt32LE(bytes, 40)
  return wav
}

export async function mixSongWav(vocal: SongWav, backing: SongWav, vocalGainDb: number, backingGainDb: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const channels = Math.max(vocal.channels, backing.channels)
  const vocalGain = 10 ** (vocalGainDb / 20)
  const backingGain = 10 ** (backingGainDb / 20)
  const ratio = backing.rate / vocal.rate
  let peak = 0
  const sample = (frame: number, channel: number) => {
    const voice = vocal.pcm.readInt16LE((frame * vocal.channels + channel % vocal.channels) * 2) * vocalGain
    const position = frame * ratio
    const before = Math.floor(position)
    if (before >= backing.frames) return voice
    const offset = (before * backing.channels + channel % backing.channels) * 2
    const first = backing.pcm.readInt16LE(offset)
    const second = before + 1 < backing.frames ? backing.pcm.readInt16LE(offset + backing.channels * 2) : 0
    return voice + (first + (second - first) * (position - before)) * backingGain
  }
  // Apply a single peak adjustment to both channels so their balance is unchanged.
  for (let start = 0; start < vocal.frames; start += CHUNK_FRAMES) {
    signal.throwIfAborted()
    const end = Math.min(vocal.frames, start + CHUNK_FRAMES)
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) peak = Math.max(peak, Math.abs(sample(frame, channel)))
    }
    await setImmediate(undefined, { signal })
  }
  if (peak < 1) throw new Error('Mix contains no audible PCM samples')
  const output = allocateSongWav(vocal.rate, channels, vocal.frames)
  const scale = Math.min(1, HEADROOM_PEAK / peak)
  for (let start = 0; start < vocal.frames; start += CHUNK_FRAMES) {
    signal.throwIfAborted()
    const end = Math.min(vocal.frames, start + CHUNK_FRAMES)
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        output.writeInt16LE(Math.round(sample(frame, channel) * scale), 44 + (frame * channels + channel) * 2)
      }
    }
    await setImmediate(undefined, { signal })
  }
  return output
}
