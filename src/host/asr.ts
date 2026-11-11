import { Agent, request, type IncomingMessage } from 'node:http'
import { DeviceAuthError } from './devices.ts'
import { loopbackHttpEndpoint } from './security.ts'
import { wavChunks } from './wav.ts'

const MAX_SECONDS = 15
const WAV_OVERHEAD = 4096
const ASR_RATES = [16_000, 44_100, 48_000]
export const MAX_ASR_WAV_BYTES = MAX_SECONDS * 48_000 * 2 + WAV_OVERHEAD
const MAX_RESPONSE_BYTES = 32_768

function validateAudio(wav: Buffer): void {
  const invalid = () => new DeviceAuthError(400, 'asr-invalid-wav')
  if (wav.length < 44 || wav.readUInt32LE(4) !== wav.length - 8) throw invalid()
  if (wav.length > MAX_ASR_WAV_BYTES) throw new DeviceAuthError(413, 'asr-audio-too-large')
  let rate = 0
  let pcm: Buffer | undefined
  let end = 12
  try {
    for (const { kind, start, size } of wavChunks(wav)) {
      end = start + size + (size % 2)
      if (kind === 'fmt ') {
        if (rate || !(size === 16 || size === 18 && wav.readUInt16LE(start + 16) === 0)) throw invalid()
        rate = wav.readUInt32LE(start + 4)
        if (!ASR_RATES.includes(rate) || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
          || wav.readUInt32LE(start + 8) !== rate * 2 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw invalid()
      } else if (kind === 'data') {
        if (!rate || pcm || size % 2) throw invalid()
        pcm = wav.subarray(start, start + size)
      }
    }
  } catch {
    throw invalid()
  }
  if (!pcm || end !== wav.length || wav.length - pcm.length > WAV_OVERHEAD) throw invalid()
  if (pcm.length > MAX_SECONDS * rate * 2) throw new DeviceAuthError(413, 'asr-audio-too-long')
  if (!pcm.some(byte => byte !== 0)) throw new DeviceAuthError(422, 'asr-no-speech')
}

export class LocalAsrProvider {
  private readonly endpoint: URL
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 })
  private readonly shutdown = new AbortController()
  private active = false

  constructor(endpoint: string, private readonly timeoutMs: number) {
    this.endpoint = loopbackHttpEndpoint(endpoint, 'Companion ASR')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new Error('Invalid Companion ASR timeout')
  }

  async transcribe(readWav: (signal: AbortSignal) => Promise<Buffer>, client: AbortSignal): Promise<{ text: string }> {
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const signal = AbortSignal.any([client, this.shutdown.signal, deadline])
    signal.throwIfAborted()
    if (this.active) throw new DeviceAuthError(409, 'asr-busy')
    this.active = true
    try {
      const wav = await readWav(signal)
      signal.throwIfAborted()
      validateAudio(wav)
      return await this.recognize(wav, signal)
    } catch (error) {
      if (deadline.aborted && signal.reason === deadline.reason) throw new DeviceAuthError(503, 'asr-timeout')
      signal.throwIfAborted()
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'asr-provider-failed')
    } finally {
      this.active = false
    }
  }

  close(): void {
    if (this.shutdown.signal.aborted) return
    this.shutdown.abort(new DeviceAuthError(503, 'asr-stopping'))
    this.agent.destroy()
  }

  private async recognize(wav: Buffer, signal: AbortSignal): Promise<{ text: string }> {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(this.endpoint, {
        method: 'POST', agent: this.agent, signal,
        headers: { 'content-type': 'audio/wav', 'content-length': wav.length, accept: 'application/json' },
      }, resolve)
      req.on('error', reject)
      req.end(wav)
    })
    try {
      if (response.statusCode === 409) throw new DeviceAuthError(409, 'asr-busy')
      if (response.statusCode === 429 || response.statusCode === 503) throw new DeviceAuthError(503, 'asr-provider-unavailable')
      if (response.statusCode !== 200) throw new DeviceAuthError(502, 'asr-provider-status')
      const type = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (type !== 'application/json' || Number(response.headers['content-length'] ?? 0) > MAX_RESPONSE_BYTES) throw new DeviceAuthError(502, 'asr-provider-response-invalid')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response) {
        signal.throwIfAborted()
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) throw new DeviceAuthError(502, 'asr-provider-response-invalid')
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const text = payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string' ? payload.text.trim() : undefined
      if (text === undefined || text.length > 4000) throw new DeviceAuthError(502, 'asr-provider-response-invalid')
      if (!text) throw new DeviceAuthError(422, 'asr-no-speech')
      return { text }
    } finally {
      if (!response.readableEnded) response.destroy()
    }
  }
}
