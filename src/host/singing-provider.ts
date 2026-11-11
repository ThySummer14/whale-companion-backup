import { Agent, request, type IncomingMessage } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { SingingInput } from '../protocol/singing.ts'
import { DeviceAuthError } from './devices.ts'

const DEFAULT_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000
const MAX_POLLS = 300
const MAX_METADATA_BYTES = 65_536
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const AMBIGUOUS_SUBMIT_GRACE_MS = 30_000
const CONTROL_TIMEOUT_MS = 10_000

const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)
const responseEnvelope = z.object({ code: z.literal(200), error: z.null().optional(), data: z.unknown() })
const submitted = z.object({ task_id: taskId, status: z.literal('queued') })
const resultItem = z.object({ task_id: taskId, status: z.literal([0, 1, 2]), result: z.string() })
const queryResult = z.tuple([resultItem])
const audioResult = z.tuple([z.object({ file: z.string().min(1).max(4096), status: z.literal(1) })])

function invalid(): DeviceAuthError {
  return new DeviceAuthError(502, 'singing-provider-response-invalid')
}

function readJSON(input: string): unknown {
  try { return JSON.parse(input) }
  catch { throw invalid() }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw invalid()
  return result.data
}

function generatedAudioURL(file: string, origin: URL): URL {
  if (!file.startsWith('/v1/audio?path=') || /[\\\s]/u.test(file)) throw invalid()
  const url = new URL(file, origin)
  const params = [...url.searchParams]
  const path = params[0]?.[1]
  // ACE-Step generates this UUID filename itself under its api_audio directory.
  if (url.origin !== origin.origin || url.pathname !== '/v1/audio' || url.hash || params.length !== 1 || params[0]?.[0] !== 'path' ||
      !path || !/^\/(?:[^/\\\p{Cc}]+\/)*api_audio\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.wav$/u.test(path) ||
      path.split('/').some(segment => segment === '.' || segment === '..')) throw invalid()
  const target = new URL('/v1/audio', origin)
  target.searchParams.set('path', path)
  return target
}

function language(lyrics: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(lyrics)) return 'ja'
  return /\p{Script=Han}/u.test(lyrics) ? 'zh' : 'en'
}

export class AceStepSingingProvider {
  private readonly origin: URL
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 })
  private readonly shutdown = new AbortController()
  private active = false
  private pendingTask?: string
  private ambiguousUntil = 0

  constructor(origin: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/u.exec(origin)
    if (!match || Number(match[1]) > 65_535) throw new Error('Companion singing origin must be an exact loopback HTTP URL with an explicit port')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('Invalid Companion singing timeout')
    this.origin = new URL(origin)
  }

  close(): void {
    this.shutdown.abort(new DeviceAuthError(503, 'singing-provider-stopping'))
    this.agent.destroy()
  }

  async generate(input: SingingInput, client: AbortSignal): Promise<Uint8Array> {
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const signal = AbortSignal.any([client, this.shutdown.signal, deadline])
    signal.throwIfAborted()
    if (this.active || Date.now() < this.ambiguousUntil) throw new DeviceAuthError(409, 'singing-provider-busy')
    this.active = true
    try {
      if (this.pendingTask) {
        const previous = await this.query(this.pendingTask, signal)
        if (previous.status === 0 && previous.result !== '[]') throw new DeviceAuthError(409, 'singing-provider-busy')
        this.pendingTask = undefined
      }
      const start = await this.submit(input, signal)
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        const result = await this.query(start, signal)
        if (result.status === 0) {
          if (result.result === '[]') {
            this.pendingTask = undefined
            throw new DeviceAuthError(502, 'singing-provider-failed')
          }
          await delay(POLL_INTERVAL_MS, undefined, { signal })
          continue
        }
        this.pendingTask = undefined
        if (result.status === 2) throw new DeviceAuthError(502, 'singing-provider-failed')
        const [audio] = parse(audioResult, readJSON(result.result))
        const bytes = await this.read(generatedAudioURL(audio.file, this.origin), 'audio/wav', MAX_AUDIO_BYTES, signal)
        if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
            bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid()
        return bytes
      }
      throw new DeviceAuthError(503, 'singing-provider-timeout')
    } catch (error) {
      if (deadline.aborted && signal.reason === deadline.reason) throw new DeviceAuthError(503, 'singing-provider-timeout')
      signal.throwIfAborted()
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'singing-provider-failed')
    } finally {
      this.active = false
    }
  }

  private async submit(input: SingingInput, signal: AbortSignal): Promise<string> {
    // A disconnected submit may have enqueued work before it lost its response.
    this.ambiguousUntil = Date.now() + this.timeoutMs + AMBIGUOUS_SUBMIT_GRACE_MS
    let data: unknown
    try {
      data = await this.json('/release_task', {
        task_type: 'text2music', prompt: `Sung vocals. ${input.style}\nTitle: ${input.title}`, lyrics: input.lyrics,
        vocal_language: language(input.lyrics), audio_duration: input.durationSeconds, audio_format: 'wav', batch_size: 1,
        thinking: false, use_format: false, use_cot_caption: false, use_cot_language: false,
      }, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error
      this.ambiguousUntil = 0
      throw new DeviceAuthError(503, 'singing-provider-unavailable')
    }
    const { task_id: id } = parse(submitted, data)
    this.pendingTask = id
    this.ambiguousUntil = 0
    return id
  }

  private async query(id: string, signal: AbortSignal): Promise<z.infer<typeof resultItem>> {
    const [result] = parse(queryResult, await this.json('/query_result', { task_id_list: [id] }, signal))
    if (result.task_id !== id) throw invalid()
    return result
  }

  private async json(path: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)])
    const bytes = await this.read(new URL(path, this.origin), 'application/json', MAX_METADATA_BYTES, requestSignal, JSON.stringify(input))
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw invalid() }
    return parse(responseEnvelope, readJSON(text)).data
  }

  private async read(url: URL, accept: 'application/json' | 'audio/wav', limit: number, signal: AbortSignal, body?: string): Promise<Buffer> {
    signal.throwIfAborted()
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, {
        method: body === undefined ? 'GET' : 'POST', agent: this.agent, signal,
        headers: { accept, ...(body !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    try {
      if ([429, 503].includes(response.statusCode ?? 0)) throw new DeviceAuthError(503, 'singing-provider-unavailable')
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== accept ||
          Number(response.headers['content-length'] ?? 0) > limit) throw invalid()
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response) {
        signal.throwIfAborted()
        size += chunk.length
        if (size > limit) throw invalid()
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      return Buffer.concat(chunks, size)
    } finally {
      if (!response.readableEnded) response.destroy()
    }
  }
}
