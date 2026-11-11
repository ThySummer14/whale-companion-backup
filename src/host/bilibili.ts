import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { parseBilibiliTarget, plainBilibiliText, subtitleUrl, wbiPlayerQuery } from '../core/bilibili.ts'
import { parseBilibiliSubtitleFile } from '../core/bilibili-subtitle.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CONTEXT } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { MAX_BILIBILI_CLIP_SECONDS, MAX_BILIBILI_SUBTITLE_BYTES, type BilibiliClipInput, type BilibiliDiscoveredVideo, type BilibiliReadInput, type BilibiliReadResult, type BilibiliSourceInput, type BilibiliSubtitle, type BilibiliSubtitleDocument, type BilibiliSubtitleUpload } from '../protocol/bilibili.ts'
import type { LocalAsrProvider } from './asr.ts'
import { decodeBilibiliAudio, decodeBilibiliFrames, readBilibiliFragment, selectBilibiliTrack, type ByteRange } from './bilibili-dash.ts'
import { DeviceAuthError } from './devices.ts'
import type { WorldHealth } from '../protocol/worlds.ts'

const API = 'https://api.bilibili.com'
const PUBLIC_REFERER = 'https://www.bilibili.com/'
const MINUTE = 60_000
const REQUEST_DEADLINE_MS = 8_000
const CLIP_DEADLINE_MS = 25_000
const UPSTREAM_REQUESTS_PER_MINUTE = 16
const MAX_METADATA_BYTES = 512 * 1024
const MAX_SUBTITLE_BYTES = 1024 * 1024
const MAX_EXCERPT_BYTES = 1200
const MAX_EXCERPT_CUES = 12
const DISCOVERY_PAGE_SIZE = 6

const id = z.int().positive()
const seconds = z.number().finite().nonnegative().max(7 * 24 * 3600)
const envelope = z.object({ code: z.int(), data: z.unknown() })
const page = z.object({ cid: id, page: z.int().min(1).max(1000), part: z.string(), duration: seconds })
const metadata = z.object({
  bvid: z.string(), aid: id, title: z.string(), desc: z.string().optional(), duration: seconds,
  owner: z.object({ name: z.string() }), pages: z.array(page).min(1).max(1000),
})
const sourceId = z.string().regex(/^[1-9]\d{0,15}$/u).refine(value => Number.isSafeInteger(Number(value)))
const sourceInput = z.object({ mid: sourceId, seasonId: sourceId })
const collection = z.object({
  meta: z.object({ mid: id, season_id: id }),
  archives: z.array(z.object({ bvid: z.string(), title: z.string(), state: z.int() })).max(DISCOVERY_PAGE_SIZE),
})
const publicWbi = z.object({ isLogin: z.boolean().optional(), wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }) })
const track = z.object({ lan: z.string().optional(), subtitle_url: z.string() })
const player = z.object({
  bvid: z.string().optional(), aid: id.optional(), cid: id.optional(),
  subtitle: z.object({ subtitles: z.array(z.unknown()).max(200).optional() }).optional(),
})
const cue = z.object({ from: seconds, to: seconds, content: z.string() })
const transcript = z.object({ body: z.array(cue).max(25_000) })

type Metadata = z.infer<typeof metadata>
type Page = z.infer<typeof page>
type ClipSample = { status: 'not-requested' } | { status: 'unavailable'; reason: string } | { status: 'sampled' }
export interface BilibiliClipSample {
  title?: string
  picture?: Buffer
  transcript?: string
  visual: ClipSample
  audio: ClipSample
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DeviceAuthError(502, 'bili-upstream-invalid')
  return result.data
}

function upstreamError(code: number): DeviceAuthError {
  return code === -404 || code === 62002 || code === 62004
    ? new DeviceAuthError(404, 'bili-video-unavailable')
    : new DeviceAuthError(502, 'bili-upstream-error')
}

function selectedPage(video: Metadata, part: number): Page {
  const pages = video.pages.filter(page => page.page === part)
  const selected = pages[0]
  if (!selected) throw new DeviceAuthError(404, 'bili-part-unavailable')
  if (pages.length !== 1) throw new DeviceAuthError(502, 'bili-upstream-invalid')
  return selected
}

function excerpt(body: unknown, language: string, duration: number): BilibiliSubtitle {
  const { body: items } = parse(transcript, body)
  const cues: { from: number; to: number; text: string }[] = []
  let bytes = MAX_EXCERPT_BYTES
  let truncated = false
  let previous = -1
  for (const item of items) {
    if (item.from < previous || item.from >= item.to || item.to > duration + 2) throw new DeviceAuthError(502, 'bili-subtitle-timeline')
    previous = item.from
    const full = plainBilibiliText(item.content, MAX_SUBTITLE_BYTES)
    if (!full) continue
    if (cues.length === MAX_EXCERPT_CUES || bytes === 0) { truncated = true; continue }
    const text = plainBilibiliText(full, bytes)
    if (text) cues.push({ from: item.from, to: item.to, text })
    bytes -= Buffer.byteLength(text)
    if (text !== full) { bytes = 0; truncated = true }
  }
  return cues.length ? { status: 'excerpt', language, cues, truncated } : { status: 'unavailable' }
}

export class BilibiliService {
  private readonly cached = new Map<string, { expires: number; video: Metadata }>()
  private readonly shutdown = new AbortController()
  private attempts: number[] = []
  private pausedUntil = 0
  private busy = false
  private companionReading = false
  private observation?: { at: number; status: 'ready' | 'unavailable' }

  constructor(private readonly store: Pick<CompanionStore, 'recordActivity'> & Partial<Pick<CompanionStore, 'bilibiliSubtitles'>>,
    private readonly request: typeof fetch = fetch, private readonly media?: { ffmpeg: string; asr?: Pick<LocalAsrProvider, 'transcribe'> }) {}

  close(): void {
    this.shutdown.abort()
    this.companionReading = false
    this.cached.clear()
  }

  homeActive(): boolean {
    return this.companionReading
  }

  isIdle(): boolean {
    return !this.busy && !this.shutdown.signal.aborted
  }

  worldHealth(now = Date.now()): WorldHealth {
    if (this.shutdown.signal.aborted) return 'unavailable'
    if (now < this.pausedUntil) return 'paused'
    if (this.busy) return 'busy'
    const observation = this.observation
    return observation && now >= observation.at && now - observation.at < 2 * MINUTE ? observation.status : 'standby'
  }

  get clipAudioAvailable(): boolean {
    return this.media?.asr !== undefined
  }

  async attachSubtitle(input: BilibiliSubtitleUpload, signal?: AbortSignal): Promise<BilibiliSubtitleDocument> {
    const target = parseBilibiliTarget(input.video, input.part)
    if (!target) throw new DeviceAuthError(400, 'bili-invalid-video')
    if (Buffer.byteLength(input.content) > MAX_BILIBILI_SUBTITLE_BYTES) throw new DeviceAuthError(413, 'bili-subtitle-too-large')
    const cues = parseBilibiliSubtitleFile(input.format, input.content)
    if (!cues?.length) throw new DeviceAuthError(400, 'bili-invalid-subtitle-file')
    const repository = this.store.bilibiliSubtitles
    if (!repository) throw new DeviceAuthError(503, 'bili-subtitle-store-unavailable')
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    return this.exclusive(signal, async bounded => {
      const selected = selectedPage(await this.video(target.bvid, bounded, true), target.part)
      if (cues.some(cue => cue.to > selected.duration + 2)) throw new DeviceAuthError(422, 'bili-subtitle-timeline')
      const clipped = excerpt({ body: cues.map(({ from, to, text }) => ({ from, to, content: text })) }, 'und', selected.duration)
      if (clipped.status !== 'excerpt') throw new DeviceAuthError(400, 'bili-invalid-subtitle-file')
      bounded.throwIfAborted()
      const saved = repository.save({
        ...target, cid: selected.cid, format: input.format, sha256, cueCount: cues.length,
        excerpt: { ...clipped, provenance: { kind: 'owner-supplied', sha256 } },
      })
      if (!saved) throw new DeviceAuthError(409, 'bili-subtitle-limit')
      return saved
    })
  }

  async read(input: BilibiliReadInput, context?: { contextId?: string; sessionId?: string; candidateId?: string }, signal?: AbortSignal): Promise<BilibiliReadResult> {
    const target = parseBilibiliTarget(input.video, input.part)
    if (!target) throw new DeviceAuthError(400, 'bili-invalid-video')
    const { contextId, sessionId, candidateId } = context ?? {}
    return this.exclusive(signal, async bounded => {
      this.companionReading = !!sessionId && (contextId === BILIBILI_CONTEXT || contextId === BILIBILI_AUTONOMY_CONTEXT)
      const repository = this.store.bilibiliSubtitles
      const hasAttachment = input.subtitles && repository?.get(target.bvid, target.part) !== undefined
      const video = await this.video(target.bvid, bounded, hasAttachment)
      const selected = selectedPage(video, target.part)
      const attached = input.subtitles ? repository?.get(target.bvid, target.part) : undefined
      const local = attached?.cid === selected.cid && attached.excerpt.cues.every(cue => cue.to <= selected.duration + 2) ? attached.excerpt : undefined
      const subtitle = input.subtitles
        ? local ?? await this.subtitles(video, selected, bounded)
        : { status: 'not-requested' as const }
      bounded.throwIfAborted()
      const provenance = subtitle.status === 'excerpt' ? subtitle.provenance : undefined
      const receipt = {
        at: new Date().toISOString(),
        kind: subtitle.status === 'excerpt' ? 'video.subtitle-read' as const : 'video.inspected' as const,
        ...(provenance && { provenance }),
      }
      const activityId = this.store.recordActivity({
        contextId, sessionId, source: 'media.bilibili', kind: receipt.kind, status: 'success', occurredAt: receipt.at,
        summary: provenance ? '读取主人提供的字幕摘录' : subtitle.status === 'excerpt' ? '读取 B 站字幕摘录' : '读取 B 站视频资料',
        data: { bvid: target.bvid, part: target.part, ...(candidateId && { candidateId }),
          ...(provenance && { subtitleOrigin: provenance.kind, subtitleSha256: provenance.sha256 }) },
      })
      return {
        bvid: target.bvid, url: `${PUBLIC_REFERER}video/${target.bvid}/${target.part > 1 ? `?p=${target.part}` : ''}`,
        title: plainBilibiliText(video.title, 240), owner: plainBilibiliText(video.owner.name, 96),
        description: plainBilibiliText(video.desc ?? '', 480), durationSeconds: video.duration,
        part: target.part, parts: video.pages.length, partTitle: plainBilibiliText(selected.part, 160), partDurationSeconds: selected.duration,
        subtitle, receipt: { ...receipt, activityId },
      }
    })
  }

  async discover(input: Pick<BilibiliSourceInput, 'mid' | 'seasonId'>, signal: AbortSignal): Promise<BilibiliDiscoveredVideo[]> {
    const target = sourceInput.safeParse(input)
    if (!target.success) throw new DeviceAuthError(400, 'bili-invalid-source')
    const { mid, seasonId } = target.data
    return this.exclusive(signal, async bounded => {
      const response = await this.api('/x/polymer/web-space/seasons_archives_list', new URLSearchParams({
        mid, season_id: seasonId, page_num: '1', page_size: String(DISCOVERY_PAGE_SIZE),
      }), bounded)
      bounded.throwIfAborted()
      if ([-101, -404, 62002, 62004].includes(response.code)) throw new DeviceAuthError(404, 'bili-source-unavailable')
      if (response.code !== 0) throw new DeviceAuthError(502, 'bili-upstream-error')
      const data = parse(collection, response.data)
      if (String(data.meta.mid) !== mid || String(data.meta.season_id) !== seasonId) throw new DeviceAuthError(502, 'bili-source-identity')
      const videos = new Map<string, BilibiliDiscoveredVideo>()
      for (const archive of data.archives) {
        if (archive.state !== 0 || videos.has(archive.bvid)) continue
        const video = parseBilibiliTarget(archive.bvid)
        const title = plainBilibiliText(archive.title, 240)
        if (!video || video.bvid !== archive.bvid || !title) throw new DeviceAuthError(502, 'bili-upstream-invalid')
        videos.set(video.bvid, { bvid: video.bvid, title })
      }
      return [...videos.values()]
    })
  }

  async sampleClip(input: BilibiliClipInput, vision: boolean, signal: AbortSignal): Promise<BilibiliClipSample> {
    if (parseBilibiliTarget(input.bvid, input.part)?.bvid !== input.bvid || !Number.isSafeInteger(input.start) || input.start < 0 ||
        !Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > MAX_BILIBILI_CLIP_SECONDS ||
        !['visual', 'audio', 'both'].includes(input.mode)) throw new DeviceAuthError(400, 'bili-invalid-clip')
    const media = this.media
    const result: BilibiliClipSample = {
      visual: input.mode === 'audio' ? { status: 'not-requested' } : { status: 'unavailable', reason: vision ? 'bili-clip-decoder-unavailable' : 'bili-clip-vision-unavailable' },
      audio: input.mode === 'visual' ? { status: 'not-requested' } : { status: 'unavailable', reason: 'bili-clip-asr-unavailable' },
    }
    const wantVideo = vision && input.mode !== 'audio'
    const wantAudio = input.mode === 'visual' ? undefined : media?.asr
    signal.throwIfAborted()
    if (!media || !wantVideo && !wantAudio) return result
    return this.exclusive(signal, async bounded => {
      this.companionReading = true
      const video = await this.video(input.bvid, bounded)
      const selected = selectedPage(video, input.part)
      if (input.start + input.seconds > selected.duration) throw new DeviceAuthError(422, 'bili-clip-outside-part')
      result.title = plainBilibiliText(video.title, 240)
      const query = await this.signedQuery(video.bvid, selected.cid, bounded, true)
      if (!query) throw new DeviceAuthError(422, 'bili-clip-stream-unavailable')
      const response = await this.api('/x/player/wbi/playurl', query, bounded)
      if (response.code !== 0) throw upstreamError(response.code)
      const read = (url: URL, range: ByteRange) => this.clipRange(url, range, bounded)
      const sample = async (kind: 'audio' | 'video', consume: (clip: { data: Buffer; skip: number }) => Promise<void>): Promise<ClipSample> => {
        const track = selectBilibiliTrack(response.data, kind, selected.cid)
        if (!track) return { status: 'unavailable', reason: 'bili-clip-stream-unavailable' }
        try {
          await consume(await readBilibiliFragment(track, kind, input.start, input.seconds, read))
          return { status: 'sampled' }
        } catch (error) {
          bounded.throwIfAborted()
          if (error instanceof DeviceAuthError && error.code === 'bili-upstream-paused') throw error
          return { status: 'unavailable', reason: error instanceof DeviceAuthError ? error.code : 'bili-clip-decode-failed' }
        }
      }
      if (wantVideo) result.visual = await sample('video', async clip => {
        result.picture = await decodeBilibiliFrames(media.ffmpeg, clip, input.seconds, bounded)
      })
      if (wantAudio) result.audio = await sample('audio', async clip => {
        const { text } = await wantAudio.transcribe(current => decodeBilibiliAudio(media.ffmpeg, clip, input.seconds, current), bounded)
        const transcript = plainBilibiliText(text, 900)
        if (!transcript) throw new DeviceAuthError(422, 'asr-no-speech')
        result.transcript = transcript
      })
      bounded.throwIfAborted()
      return result
    }, CLIP_DEADLINE_MS)
  }

  private async exclusive<T>(signal: AbortSignal | undefined, run: (bounded: AbortSignal) => Promise<T>, deadlineMs = REQUEST_DEADLINE_MS): Promise<T> {
    if (this.shutdown.signal.aborted) throw new DeviceAuthError(503, 'bili-stopping')
    if (this.busy) throw new DeviceAuthError(409, 'bili-busy')
    const deadline = AbortSignal.timeout(deadlineMs)
    const bounded = AbortSignal.any([this.shutdown.signal, deadline, ...(signal ? [signal] : [])])
    this.busy = true
    try {
      bounded.throwIfAborted()
      const result = await run(bounded)
      this.observation = { at: Date.now(), status: 'ready' }
      return result
    } catch (error) {
      if (bounded.aborted) {
        if (deadline.aborted && bounded.reason === deadline.reason) {
          this.observation = { at: Date.now(), status: 'unavailable' }
          throw new DeviceAuthError(504, 'bili-timeout')
        }
        if (this.shutdown.signal.aborted) throw new DeviceAuthError(503, 'bili-stopping')
        throw new DeviceAuthError(499, 'bili-cancelled')
      }
      if (error instanceof DeviceAuthError && error.status >= 500) {
        this.observation = { at: Date.now(), status: 'unavailable' }
      }
      throw error
    } finally {
      this.busy = false
      this.companionReading = false
    }
  }

  private async video(bvid: string, signal: AbortSignal, fresh = false): Promise<Metadata> {
    const existing = this.cached.get(bvid)
    if (!fresh && existing && existing.expires > Date.now()) return existing.video
    const result = await this.api('/x/web-interface/view', new URLSearchParams({ bvid }), signal)
    signal.throwIfAborted()
    if (result.code !== 0) throw upstreamError(result.code)
    const video = parse(metadata, result.data)
    if (video.bvid !== bvid || !plainBilibiliText(video.title, 240)) throw new DeviceAuthError(502, 'bili-upstream-invalid')
    this.cached.delete(bvid)
    if (this.cached.size === 32) this.cached.delete(this.cached.keys().next().value!)
    this.cached.set(bvid, { expires: Date.now() + 2 * MINUTE, video })
    return video
  }

  private async signedQuery(bvid: string, cid: number, signal: AbortSignal, dash = false): Promise<URLSearchParams | undefined> {
    const nav = await this.api('/x/web-interface/nav', new URLSearchParams(), signal)
    if (nav.code !== 0 && nav.code !== -101) throw upstreamError(nav.code)
    const keys = publicWbi.safeParse(nav.data)
    if (!keys.success || nav.code === -101 && keys.data.isLogin !== false) return
    const { img_url, sub_url } = keys.data.wbi_img
    return wbiPlayerQuery({ bvid, cid }, img_url, sub_url, Math.floor(Date.now() / 1000), dash)
  }

  private async subtitles(video: Metadata, selected: Page, signal: AbortSignal): Promise<BilibiliSubtitle> {
    const query = await this.signedQuery(video.bvid, selected.cid, signal)
    if (!query) return { status: 'unavailable' }
    const response = await this.api('/x/player/wbi/v2', query, signal)
    if (response.code === -101 || response.code === -404) return { status: 'unavailable' }
    if (response.code !== 0) throw upstreamError(response.code)
    const data = parse(player, response.data)
    if ((data.bvid !== undefined && data.bvid !== video.bvid) || (data.aid !== undefined && data.aid !== video.aid) ||
        (data.cid !== undefined && data.cid !== selected.cid)) throw new DeviceAuthError(502, 'bili-subtitle-identity')
    if (data.cid === undefined && (video.pages.length > 1 || (data.bvid === undefined && data.aid === undefined))) return { status: 'unavailable' }
    const tracks = (data.subtitle?.subtitles ?? []).flatMap(item => {
      const parsed = track.safeParse(item)
      return parsed.success && parsed.data.subtitle_url.trim() ? [parsed.data] : []
    })
    const choice = tracks.find(item => /^(?:ai-)?zh(?:-|$)/iu.test(item.lan ?? '')) ?? tracks[0]
    if (!choice) return { status: 'unavailable' }
    const url = subtitleUrl(choice.subtitle_url.trim())
    if (!url) throw new DeviceAuthError(502, 'bili-subtitle-url-denied')
    return excerpt(await this.json(url, MAX_SUBTITLE_BYTES, signal), plainBilibiliText(choice.lan ?? '', 32) || 'und', selected.duration)
  }

  private async api(path: string, query: URLSearchParams, signal: AbortSignal): Promise<z.infer<typeof envelope>> {
    const url = new URL(path, API)
    url.search = query.toString()
    const result = parse(envelope, await this.json(url, MAX_METADATA_BYTES, signal))
    if ([-352, -403, -412, -429, -509].includes(result.code)) this.pause()
    return result
  }

  private pause(): never {
    this.pausedUntil = Date.now() + MINUTE
    throw new DeviceAuthError(503, 'bili-upstream-paused')
  }

  private async json(url: URL, limit: number, signal: AbortSignal): Promise<unknown> {
    const bytes = await this.publicBytes(url, limit, signal)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new DeviceAuthError(502, 'bili-upstream-invalid') }
  }

  private async clipRange(url: URL, range: ByteRange, signal: AbortSignal): Promise<Buffer> {
    const limit = range.last - range.first + 1
    const firstDeadline = AbortSignal.timeout(4000)
    try {
      return await this.publicBytes(url, limit, AbortSignal.any([signal, firstDeadline]), range)
    } catch (error) {
      signal.throwIfAborted()
      if (!firstDeadline.aborted && (!(error instanceof DeviceAuthError) || error.code !== 'bili-network-error')) throw error
    }
    await delay(120, undefined, { signal })
    const retryDeadline = AbortSignal.timeout(4000)
    try {
      return await this.publicBytes(url, limit, AbortSignal.any([signal, retryDeadline]), range)
    } catch (error) {
      signal.throwIfAborted()
      if (retryDeadline.aborted) throw new DeviceAuthError(504, 'bili-clip-range-timeout')
      throw error
    }
  }

  private async publicBytes(url: URL, limit: number, signal: AbortSignal, range?: ByteRange): Promise<Buffer> {
    signal.throwIfAborted()
    const now = Date.now()
    if (now < this.pausedUntil) throw new DeviceAuthError(503, 'bili-upstream-paused')
    this.attempts = this.attempts.filter(at => now - at < MINUTE)
    if (this.attempts.length >= UPSTREAM_REQUESTS_PER_MINUTE) throw new DeviceAuthError(429, 'bili-budget-exhausted')
    this.attempts.push(now)
    let response: Response
    try {
      response = await this.request(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal,
        headers: { accept: range ? 'video/mp4, audio/mp4, application/octet-stream' : 'application/json',
          referer: PUBLIC_REFERER, 'user-agent': 'DSH-Companion/BilibiliRead', ...(range && { range: `bytes=${range.first}-${range.last}`, 'accept-encoding': 'identity' }) },
      })
    } catch {
      signal.throwIfAborted()
      throw new DeviceAuthError(502, 'bili-network-error')
    }
    const reader = response.body?.getReader()
    try {
      if ([401, 403, 412, 429].includes(response.status)) this.pause()
      if (!response.ok || response.redirected || !reader) throw new DeviceAuthError(502, 'bili-upstream-error')
      if (range) {
        const sent = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
        if (response.status !== 206 || !sent || Number(sent[1]) !== range.first || Number(sent[2]) !== range.last ||
            !Number.isSafeInteger(Number(sent[3])) || Number(sent[3]) <= range.last) throw new DeviceAuthError(422, 'bili-clip-range-unavailable')
      }
      if (Number(response.headers.get('content-length')) > limit) throw new DeviceAuthError(502, 'bili-upstream-too-large')
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > limit) throw new DeviceAuthError(502, 'bili-upstream-too-large')
        chunks.push(chunk.value)
      }
      if (range && bytes !== limit) throw new DeviceAuthError(422, 'bili-clip-range-unavailable')
      return Buffer.concat(chunks, bytes)
    } catch (error) {
      if (error instanceof DeviceAuthError) throw error
      signal.throwIfAborted()
      throw new DeviceAuthError(502, 'bili-upstream-invalid')
    } finally {
      void reader?.cancel().catch(() => {})
    }
  }
}
