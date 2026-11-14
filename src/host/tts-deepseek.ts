import { writeFile } from 'node:fs/promises'
import { wavDurationMs } from './wav.ts'

const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
const MAX_AUDIO_BYTES = 52_428_800
const PLACEHOLDER = 0xFFFFFFFF

// Streamed WAV arrives with unknown RIFF/data sizes; rewrite them before validation.
function finalizeStreamWav(audio: Buffer): Buffer {
  if (audio.length < 44 || audio.toString('latin1', 0, 4) !== 'RIFF') return audio
  const out = Buffer.from(audio)
  if (out.readUInt32LE(4) === PLACEHOLDER) out.writeUInt32LE(out.length - 8, 4)
  let offset = 12
  while (offset + 8 <= out.length) {
    const size = out.readUInt32LE(offset + 4)
    if (size === PLACEHOLDER) {
      out.writeUInt32LE(out.length - offset - 8, offset + 4)
      break
    }
    offset += 8 + size + (size % 2)
  }
  return out
}

export interface DeepSeekTtsOptions {
  apiKey: string
  timeoutMs: number
  fetcher?: typeof fetch
}

export class DeepSeekTtsProvider {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: DeepSeekTtsOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  configured(): boolean {
    return !!this.options.apiKey.trim()
  }

  async health(): Promise<boolean> {
    return this.configured()
  }

  async synthesize(text: string, output: string, signal: AbortSignal): Promise<{ durationMs: number; bytes: number }> {
    if (!this.configured()) throw new Error('DeepSeek TTS API key is not configured')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(abort, this.options.timeoutMs)
    try {
      const response = await this.fetcher(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey.trim()}` },
        body: JSON.stringify({ text, voice_id: 'stella', format: 'wav' }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`DeepSeek TTS returned ${response.status}`)
      const declaredBytes = Number(response.headers.get('content-length') ?? 0)
      if (declaredBytes > MAX_AUDIO_BYTES) throw new Error('DeepSeek TTS audio exceeds size limit')
      const audio = finalizeStreamWav(Buffer.from(await response.arrayBuffer()))
      if (audio.length > MAX_AUDIO_BYTES) throw new Error('DeepSeek TTS audio exceeds size limit')
      const durationMs = wavDurationMs(audio)
      await writeFile(output, audio, { mode: 0o600, flag: 'wx' })
      return { durationMs, bytes: audio.length }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}