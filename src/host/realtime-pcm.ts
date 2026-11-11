import { addAbortListener } from 'node:events'
import { Agent, request, type IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { loopbackHttpEndpoint } from './security.ts'

interface PcmOptions {
  endpoint: string
  sampleRate?: number
  timeoutMs: number
}

export type RealtimePcmOptions = PcmOptions & (
  | { protocol: 'openai'; model: string; voice: string }
  | { protocol: 'voxweft'; voice: string }
  | { protocol: 'gpt-sovits-v2'; referenceAudio: string; referenceText: string; referenceLanguage: string }
)

export class RealtimePcmError extends Error {}

export interface RealtimePcmStream {
  sampleRate: number
  signal: AbortSignal
  body: AsyncGenerator<Buffer>
  source?: 'full' | 'prefetch-complete' | 'prefetch-live'
}

const prefixTimeoutMs = 8000
const handoffTimeoutMs = 750
export const maxPrefixPcmBytes = 1024 * 1024

export interface LiveVoicePrefix {
  owner: AbortSignal
  body: AsyncGenerator<Buffer>
  abort: () => void
}

type PcmInput = string | { text: string; prefixPcm: Buffer | LiveVoicePrefix }
type ResolvePcmInput = string | ((signal: AbortSignal) => Promise<PcmInput>)
type PrefixLease = { controller: AbortController; owner: AbortSignal; released: Promise<void> }

export class RealtimePcmProvider {
  readonly sampleRate: number
  private readonly endpoint: URL
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 })
  private readonly shutdown = new AbortController()
  private foreground = false
  private prefix?: PrefixLease

  constructor(private readonly options: RealtimePcmOptions) {
    this.endpoint = loopbackHttpEndpoint(options.endpoint, 'Companion PCM')
    this.sampleRate = options.sampleRate ?? (options.protocol === 'openai' ? 24_000 : 48_000)
    if (!Number.isInteger(this.sampleRate) || this.sampleRate < 8000 || this.sampleRate > 48_000) throw new Error('Invalid Companion PCM sample rate')
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) throw new Error('Invalid Companion PCM timeout')
    if (options.protocol === 'openai') {
      if (!options.model.trim() || options.model.length > 128 || !options.voice.trim() || options.voice.length > 128) throw new Error('Companion PCM requires a fixed model and voice')
    } else if (options.protocol === 'voxweft') {
      if (this.endpoint.pathname !== '/generate' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(options.voice)) throw new Error('VoxWeft PCM requires /generate and a named voice')
    } else if (!isAbsolute(options.referenceAudio) || !options.referenceText.trim() || !options.referenceLanguage.trim()) {
      throw new Error('Invalid GPT-SoVITS PCM reference voice')
    }
  }

  stream(input: ResolvePcmInput, signal: AbortSignal): RealtimePcmStream {
    const bounded = AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(this.options.timeoutMs)])
    return { sampleRate: this.sampleRate, signal: bounded, body: this.readExclusive(input, bounded) }
  }

  prewarm(input: string, signal: AbortSignal): RealtimePcmStream {
    const controller = new AbortController()
    const bounded = AbortSignal.any([signal, this.shutdown.signal, controller.signal, AbortSignal.timeout(Math.min(this.options.timeoutMs, prefixTimeoutMs))])
    return { sampleRate: this.sampleRate, signal: bounded, body: this.readPrefix(input, signal, controller, bounded) }
  }

  close(): void {
    if (this.shutdown.signal.aborted) return
    this.shutdown.abort(new RealtimePcmError('voice-stream-stopping'))
    this.agent.destroy()
  }

  private async *readExclusive(input: ResolvePcmInput, signal: AbortSignal): AsyncGenerator<Buffer> {
    signal.throwIfAborted()
    if (this.foreground) throw new RealtimePcmError('voice-stream-busy')
    this.foreground = true
    let live: LiveVoicePrefix | undefined
    try {
      const resolved = typeof input === 'string' ? input : await input(signal)
      if (typeof resolved !== 'string' && !Buffer.isBuffer(resolved.prefixPcm)) live = resolved.prefixPcm
      signal.throwIfAborted()
      if (this.prefix && this.prefix.owner !== live?.owner) {
        await this.preempt(this.prefix, signal)
        signal.throwIfAborted()
      }
      if (typeof resolved === 'string') yield* this.synthesize(resolved, signal)
      else if (!Buffer.isBuffer(resolved.prefixPcm)) yield* this.joinLivePrefix(resolved.text, resolved.prefixPcm, signal)
      else yield* this.joinPrefix(resolved.text, resolved.prefixPcm, signal)
    } finally {
      live?.abort()
      this.foreground = false
    }
  }

  private async preempt(prefix: PrefixLease, signal: AbortSignal): Promise<void> {
    prefix.controller.abort(new RealtimePcmError('voice-prefix-preempted'))
    const handoff = AbortSignal.any([signal, AbortSignal.timeout(handoffTimeoutMs)])
    const interrupted = Promise.withResolvers<never>()
    const listener = addAbortListener(handoff, () => interrupted.reject(handoff.reason))
    try {
      await Promise.race([prefix.released, interrupted.promise])
    } catch {
      signal.throwIfAborted()
      throw new RealtimePcmError('voice-stream-busy')
    } finally {
      listener[Symbol.dispose]()
    }
  }

  private async *readPrefix(input: string, owner: AbortSignal, controller: AbortController, signal: AbortSignal): AsyncGenerator<Buffer> {
    signal.throwIfAborted()
    if (this.foreground || this.prefix) throw new RealtimePcmError('voice-stream-busy')
    const released = Promise.withResolvers<void>()
    this.prefix = { controller, owner, released: released.promise }
    try {
      yield* this.synthesize(input, signal)
    } finally {
      this.prefix = undefined
      released.resolve()
    }
  }

  private async *joinLivePrefix(text: string, prefix: LiveVoicePrefix, signal: AbortSignal): AsyncGenerator<Buffer> {
    const listener = addAbortListener(signal, prefix.abort)
    try {
      for await (const chunk of prefix.body) {
        signal.throwIfAborted()
        yield chunk
      }
      signal.throwIfAborted()
      if (text) yield* this.synthesize(text, signal)
    } finally {
      listener[Symbol.dispose]()
    }
  }

  private async *joinPrefix(text: string, prefix: Buffer, signal: AbortSignal): AsyncGenerator<Buffer> {
    if (!prefix.length || prefix.length % 2 || prefix.length > maxPrefixPcmBytes) throw new RealtimePcmError('voice-stream-invalid-format')
    if (!text) {
      yield prefix
      return
    }
    // Start the suffix while the stage drains the cached prefix, including during HTTP backpressure.
    const controller = new AbortController()
    const suffix = this.synthesize(text, AbortSignal.any([signal, controller.signal]))
    const first = suffix.next()
    void first.catch(() => {})
    try {
      yield prefix
      const chunk = await first
      signal.throwIfAborted()
      if (!chunk.done) yield chunk.value
      yield* suffix
    } finally {
      controller.abort()
      await suffix.return(undefined).catch(() => {})
    }
  }

  private async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    try {
      yield* this.read(text, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RealtimePcmError) throw error
      throw new RealtimePcmError('voice-stream-provider-error')
    }
  }

  private request(url: URL, signal: AbortSignal, body?: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: body ? 'POST' : 'GET', agent: this.agent, signal,
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
  }

  private async requireVoxWeftVoice(voice: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(new URL('/voices', this.endpoint), signal)
    try {
      if (response.statusCode !== 200) throw new RealtimePcmError('voice-stream-provider-status')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response) {
        size += chunk.length
        if (size > 32_768) throw new RealtimePcmError('voice-stream-invalid-voices')
        chunks.push(chunk)
      }
      let voices: unknown
      try { voices = JSON.parse(Buffer.concat(chunks).toString()).voices } catch { /* rejected below */ }
      if (!Array.isArray(voices) || !voices.some(item => item?.external_id === voice)) throw new RealtimePcmError('voice-stream-voice-unavailable')
    } finally {
      if (!response.readableEnded) response.destroy()
    }
  }

  private async *read(input: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const options = this.options
    let payload
    switch (options.protocol) {
      case 'openai':
        payload = { model: options.model, voice: options.voice, input, response_format: 'pcm' }
        break
      case 'voxweft':
        await this.requireVoxWeftVoice(options.voice, signal)
        payload = { target_text: input, voice: options.voice, stream: true }
        break
      case 'gpt-sovits-v2':
        payload = { text: input, text_lang: 'zh', ref_audio_path: options.referenceAudio, prompt_text: options.referenceText,
          prompt_lang: options.referenceLanguage, text_split_method: 'cut0', gpt_streaming: true, streaming_mode: 2, batch_size: 1, media_type: 'raw' }
        break
    }
    const response = await this.request(this.endpoint, signal, JSON.stringify(payload))
    const limit = this.sampleRate * 2 * 60
    try {
      if (response.statusCode !== 200) throw new RealtimePcmError('voice-stream-provider-status')
      const [type, ...parameters] = (response.headers['content-type'] ?? '').toLowerCase().split(';').map(field => field.trim())
      if (type !== 'application/octet-stream' && type !== 'audio/pcm' && type !== 'audio/x-pcm' && !(type === 'audio/raw' && options.protocol === 'gpt-sovits-v2')) {
        throw new RealtimePcmError('voice-stream-invalid-format')
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new RealtimePcmError('voice-stream-invalid-format')
      for (const field of parameters) {
        const [key, value] = field.split('=').map(part => part.trim().replace(/^"(.*)"$/u, '$1'))
        if ((key === 'rate' || key === 'sample-rate') && Number(value) !== this.sampleRate || key === 'channels' && Number(value) !== 1 || key === 'format' && value !== 's16le' && value !== 'pcm_s16le') {
          throw new RealtimePcmError('voice-stream-invalid-format')
        }
      }
      const rate = response.headers['x-sample-rate']
      if (rate !== undefined && Number(rate) !== this.sampleRate) throw new RealtimePcmError('voice-stream-invalid-format')
      const length = Number(response.headers['content-length'] ?? 0)
      if (length > limit) throw new RealtimePcmError('voice-stream-too-large')
      if (length % 2) throw new RealtimePcmError('voice-stream-invalid-format')
      let total = 0
      let remainder = Buffer.alloc(0)
      for await (const part of response) {
        signal.throwIfAborted()
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
        const first = total < 12
        total += chunk.length
        if (total > limit) throw new RealtimePcmError('voice-stream-too-large')
        const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
        if (first && data.length < 12) {
          remainder = data
          continue
        }
        if (first && ['RIFF', 'RIFX', 'RF64'].includes(data.toString('ascii', 0, 4)) && data.toString('ascii', 8, 12) === 'WAVE') {
          throw new RealtimePcmError('voice-stream-invalid-format')
        }
        const even = data.length - data.length % 2
        if (even) yield data.subarray(0, even)
        remainder = data.subarray(even)
      }
      signal.throwIfAborted()
      if (!total || total % 2) throw new RealtimePcmError('voice-stream-invalid-format')
      if (remainder.length) yield remainder
    } finally {
      if (!response.readableEnded) response.destroy()
    }
  }
}
