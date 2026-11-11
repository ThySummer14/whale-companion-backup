import { maxPrefixPcmBytes, RealtimePcmError, type LiveVoicePrefix, type RealtimePcmProvider } from './realtime-pcm.ts'

const ttlMs = 15_000
const maxPrefixChars = 180
const liveLeadMs = 80

interface Candidate {
  attemptKey: string
  prefix: string
  controller: AbortController
  expiresAt: number
  timer: NodeJS.Timeout
  confirmed?: { contextId: string; messageId: string }
  pcm?: Buffer
  bytes: number
  finished?: { error?: unknown }
  changed?: PromiseWithResolvers<void>
}

export class VoicePrefixCache {
  private candidate?: Candidate
  private collecting = false
  private closed = false

  constructor(private readonly provider: RealtimePcmProvider) {}

  begin(attemptKey: string, prefix: string): void {
    if (this.closed) return
    if (this.candidate?.attemptKey === attemptKey && this.candidate.prefix === prefix) return
    this.drop()
    if (!prefix.trim() || prefix.length > maxPrefixChars) return
    const candidate: Candidate = {
      attemptKey, prefix, controller: new AbortController(), expiresAt: Date.now() + ttlMs, bytes: 0,
      timer: setTimeout(() => this.drop(candidate), ttlMs).unref(),
    }
    this.candidate = candidate
    this.collectLatest()
  }

  cancel(attemptKey: string): void {
    if (this.candidate?.attemptKey === attemptKey) this.drop()
  }

  confirm(attemptKey: string, contextId: string, messageId: string): void {
    const candidate = this.candidate
    if (candidate?.attemptKey !== attemptKey) return
    if (candidate.confirmed && (candidate.confirmed.contextId !== contextId || candidate.confirmed.messageId !== messageId)) {
      this.drop(candidate)
      return
    }
    candidate.confirmed = { contextId, messageId }
  }

  clearContext(contextId: string): void {
    if (this.candidate?.confirmed?.contextId === contextId) this.drop()
  }

  take(contextId: string, messageId: string, finalText: string): { prefix: string; pcm: Buffer | LiveVoicePrefix } | undefined {
    const candidate = this.candidate
    if (candidate?.confirmed?.contextId !== contextId || candidate.confirmed.messageId !== messageId) return
    const { pcm, prefix, expiresAt, bytes, finished, controller } = candidate
    this.detach(candidate)
    if (pcm && !finished?.error && expiresAt > Date.now() && finalText.startsWith(prefix)) {
      if (finished) return { prefix, pcm: pcm.subarray(0, bytes) }
      if (bytes * 1000 >= this.provider.sampleRate * 2 * liveLeadMs) {
        return { prefix, pcm: { owner: controller.signal, body: this.readLive(candidate), abort: () => controller.abort() } }
      }
    }
    controller.abort()
  }

  close(): void {
    this.closed = true
    this.drop()
  }

  private drop(candidate = this.candidate): void {
    if (!candidate || this.candidate !== candidate) return
    this.detach(candidate)
    candidate.controller.abort()
  }

  private detach(candidate: Candidate): void {
    this.candidate = undefined
    clearTimeout(candidate.timer)
  }

  private notify(candidate: Candidate): void {
    candidate.changed?.resolve()
    candidate.changed = undefined
  }

  private async *readLive(candidate: Candidate): AsyncGenerator<Buffer> {
    let offset = 0
    for (;;) {
      candidate.controller.signal.throwIfAborted()
      const { bytes, finished, pcm } = candidate
      if (finished?.error) throw finished.error
      if (pcm && offset < bytes) {
        const chunk = pcm.subarray(offset, bytes)
        offset = bytes
        yield chunk
      } else if (finished) {
        return
      } else {
        candidate.changed ??= Promise.withResolvers()
        await candidate.changed.promise
      }
    }
  }

  private collectLatest(): void {
    const candidate = this.candidate
    if (this.collecting || !candidate) return
    this.collecting = true
    void this.collect(candidate).finally(() => {
      this.collecting = false
      if (this.candidate !== candidate) this.collectLatest()
    })
  }

  private async collect(candidate: Candidate): Promise<void> {
    try {
      const stream = this.provider.prewarm(candidate.prefix, candidate.controller.signal)
      const limit = Math.min(maxPrefixPcmBytes, stream.sampleRate * 2 * 8)
      for await (const chunk of stream.body) {
        stream.signal.throwIfAborted()
        if (candidate.bytes + chunk.length > limit) throw new RealtimePcmError('voice-stream-too-large')
        candidate.pcm ??= Buffer.allocUnsafe(limit)
        chunk.copy(candidate.pcm, candidate.bytes)
        candidate.bytes += chunk.length
        this.notify(candidate)
      }
      stream.signal.throwIfAborted()
      candidate.finished = {}
    } catch (error) {
      candidate.finished = { error }
      this.drop(candidate)
    } finally {
      this.notify(candidate)
    }
  }
}
