import { validateAudio } from './asr.ts'
import { DeviceAuthError } from './devices.ts'

const ENDPOINT = 'https://api.deepseek.com/v1/tools/asr'
const MAX_RESPONSE_BYTES = 32_768

export interface DeepSeekAsrOptions {
  apiKey: string
  timeoutMs: number
  fetcher?: typeof fetch
}

export class DeepSeekAsrProvider {
  private readonly fetcher: typeof fetch
  private readonly shutdown = new AbortController()
  private active = false

  constructor(private readonly options: DeepSeekAsrOptions) {
    this.fetcher = options.fetcher ?? fetch
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) throw new Error('Invalid Companion ASR timeout')
  }

  configured(): boolean {
    return !!this.options.apiKey.trim()
  }

  async transcribe(readWav: (signal: AbortSignal) => Promise<Buffer>, client: AbortSignal): Promise<{ text: string }> {
    if (!this.configured()) throw new DeviceAuthError(503, 'asr-unconfigured')
    const deadline = AbortSignal.timeout(this.options.timeoutMs)
    const signal = AbortSignal.any([client, this.shutdown.signal, deadline])
    signal.throwIfAborted()
    if (this.active) throw new DeviceAuthError(409, 'asr-busy')
    this.active = true
    try {
      const wav = await readWav(signal)
      signal.throwIfAborted()
      validateAudio(wav)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav).buffer], { type: 'audio/wav' }), 'speech.wav')
      const response = await this.fetcher(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey.trim()}` },
        body: form,
        signal,
      })
      if (response.status === 413) throw new DeviceAuthError(413, 'asr-audio-too-large')
      if (response.status === 429 || response.status === 503) throw new DeviceAuthError(503, 'asr-provider-unavailable')
      if (response.status !== 200) throw new DeviceAuthError(502, 'asr-provider-status')
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > MAX_RESPONSE_BYTES) throw new DeviceAuthError(502, 'asr-provider-response-invalid')
      const payload: unknown = JSON.parse(body.toString('utf8'))
      const text = payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string' ? payload.text.trim() : undefined
      if (text === undefined || text.length > 4000) throw new DeviceAuthError(502, 'asr-provider-response-invalid')
      if (!text) throw new DeviceAuthError(422, 'asr-no-speech')
      return { text }
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
  }
}