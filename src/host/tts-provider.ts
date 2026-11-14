import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { wavDurationMs } from './wav.ts'

export interface GptSovitsOptions {
  endpoint: string
  referenceAudio: string
  referenceText: string
  referenceLanguage: string
  timeoutMs: number
}

export class GptSovitsProvider {
  private readonly endpoint: URL

  constructor(private readonly options: GptSovitsOptions) {
    this.endpoint = new URL(options.endpoint)
    if (this.endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(this.endpoint.hostname) || this.endpoint.pathname !== '/' || this.endpoint.search || this.endpoint.hash || this.endpoint.username || this.endpoint.password) {
      throw new Error('GPT-SoVITS endpoint must be a loopback HTTP URL')
    }
    if (!isAbsolute(options.referenceAudio) || !options.referenceText.trim() || !options.referenceLanguage.trim()) throw new Error('Invalid GPT-SoVITS reference voice')
  }

  configured(): boolean {
    return existsSync(this.options.referenceAudio)
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    if (!this.configured()) return false
    const request = linkedSignal(signal, 3000)
    try {
      const response = await fetch(new URL('companion-health', this.endpoint), { signal: request.signal, cache: 'no-store' })
      if (!response.ok) return false
      const value = await response.json() as { ok?: unknown }
      return value.ok === true
    } catch {
      return false
    } finally {
      request.clear()
    }
  }

  async synthesize(text: string, output: string, signal: AbortSignal): Promise<{ durationMs: number; bytes: number }> {
    const request = linkedSignal(signal, this.options.timeoutMs)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refer_wav_path: this.options.referenceAudio,
          prompt_text: this.options.referenceText,
          prompt_language: this.options.referenceLanguage,
          text,
          text_language: 'zh',
          speed: 1,
          top_k: 15,
          top_p: 1,
          temperature: 1,
          if_sr: false,
        }),
        signal: request.signal,
      })
      if (!response.ok) throw new Error(`GPT-SoVITS returned ${response.status}`)
      const declaredBytes = Number(response.headers.get('content-length') ?? 0)
      if (declaredBytes > 52_428_800) throw new Error('GPT-SoVITS audio exceeds size limit')
      const audio = Buffer.from(await response.arrayBuffer())
      if (audio.length > 52_428_800) throw new Error('GPT-SoVITS audio exceeds size limit')
      const durationMs = wavDurationMs(audio)
      await writeFile(output, audio, { mode: 0o600, flag: 'wx' })
      return { durationMs, bytes: audio.length }
    } finally {
      request.clear()
    }
  }
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  }
}
