import { createHash } from 'node:crypto'
import { chmodSync, constants, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { SINGING_CONTEXT, type TaskRecord } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { MAX_SINGING_SCORE_SECONDS, MAX_SINGING_WAV_BYTES as MAX_BYTES, MAX_SONG_VOCAL_SAMPLES, scoreDurationSeconds, type DeviceSingingArchive, type DeviceSingingTrack, type SingingInput, type SingingScoreInput, type SingingTaskView, type SingingView } from '../protocol/singing.ts'
import { planSingingScore } from '../protocol/singing-score.ts'
import { SingingInputSchema, SingingScoreInputSchema } from './api-schemas.ts'
import { DeviceAuthError } from './devices.ts'
import type { SingingCoverProvider } from './singing-cover.ts'
import type { SingingSeparatorProvider } from './singing-separation.ts'
import { convertLongScore, MAX_SCORE_TIMING_DRIFT_SECONDS, silenceScoreRests, type SingingScoreProvider } from './singing-score.ts'
import { mixSongWav, parseSongWav, songVocalEnvelope, songVocalSampleCount, validSongGain, type SingingCoverMix, type SongWav } from './song-mix.ts'
import type { WorldHealth } from '../protocol/worlds.ts'

const CAPABILITY = 'media.singing'
const SONGS = 'songs'
const MAX_DURATION_UNDERRUN_SECONDS = 5
const MAX_COVER_TIMING_DRIFT_SECONDS = 0.1
const MAX_RENDER_MS = 300_000
const MAX_LONG_SCORE_RENDER_MS = 900_000
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const OUTPUT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.pending)?\.wav$/u
export const SINGING_CHAT_COVER_ID_PREFIX = 'singing:chat-cover:'
export const SINGING_CHAT_SCORE_ID_PREFIX = 'singing:chat-score:'

export interface SingingProvider {
  generate(input: SingingInput, signal: AbortSignal): Promise<Uint8Array>
  close?(): void
}

interface SongRun {
  task: TaskRecord
  controller: AbortController
  coverPhase?: SingingTaskView['coverPhase']
  scoreProgress?: SingingTaskView['scoreProgress']
  finished?: Promise<void>
}

type CoverGains = Omit<SingingCoverMix, 'accompaniment'>

interface ChatSongOrigin {
  sessionId: string
  messageId: string
}

interface PreparedMix extends Required<CoverGains> {
  backing: SongWav
}

type SongMode = 'generation' | 'cover' | 'source-cover' | 'score'
type SongDuration = { min: number; max?: number }
type SongGenerator = (signal: AbortSignal, run: SongRun) => Promise<{ bytes: Uint8Array; mix?: PreparedMix; score?: SingingScoreInput }>

export class SingingService {
  private readonly directory: string
  private active?: SongRun
  private closing = false
  private shutdown?: Promise<void>

  constructor(private readonly store: CompanionStore, mediaRoot: string, private readonly provider?: SingingProvider,
    private readonly cover?: SingingCoverProvider, private readonly separator?: SingingSeparatorProvider,
    private readonly score?: SingingScoreProvider) {
    if (!isAbsolute(mediaRoot)) throw new Error('Song media root must be absolute')
    this.directory = resolve(mediaRoot, SONGS)
  }

  start(): void {
    const interrupted = this.store.tasks(100, CAPABILITY).filter(task => pending(task))
    for (const task of interrupted) this.fail(task.id, '歌唱服务已重启，请手动重新提交')
    this.cleanInterruptedFiles()
    this.store.updateCapability(CAPABILITY, this.provider || this.cover ? 'ready' : 'planned',
      this.provider || this.cover ? '已配置独立的本地歌唱 Provider，结果以 WAV 回执为准' : '等待配置本地歌唱 Provider')
  }

  view(): SingingView {
    const tasks = this.store.tasks(20, CAPABILITY)
    const cover = this.closing ? undefined : this.cover
    return {
      available: !!this.provider && !this.closing,
      ...(this.scoreAvailable && { scoreAvailable: true, scoreMaxSeconds: MAX_SINGING_SCORE_SECONDS }),
      ...(cover && { coverAvailable: true }),
      ...(cover?.engine && { coverEngine: cover.engine }),
      ...(this.sourceCoverAvailable && { sourceCoverAvailable: true }),
      tasks: tasks.map(task => this.describe(task)),
    }
  }

  worldHealth(): WorldHealth {
    if (this.closing) return 'unavailable'
    if (this.active) return 'busy'
    return this.provider || this.cover ? 'ready' : 'unconfigured'
  }

  get sourceCoverAvailable(): boolean {
    return !!(this.cover && this.separator && !this.closing)
  }

  get scoreAvailable(): boolean {
    return !!(this.score && this.cover && !this.closing)
  }

  sourceCoverForMessage(origin: ChatSongOrigin): SingingTaskView | undefined {
    const task = this.chatSongTask(chatSongExternalId(SINGING_CHAT_COVER_ID_PREFIX, origin), origin.sessionId)
    return task && this.describe(task)
  }

  scoreForMessage(origin: ChatSongOrigin): SingingTaskView | undefined {
    const task = this.chatSongTask(chatSongExternalId(SINGING_CHAT_SCORE_ID_PREFIX, origin), origin.sessionId)
    return task && this.describe(task)
  }

  sessionTask(sessionId: string, id?: string): SingingTaskView | undefined {
    const task = id === undefined
      ? this.store.tasks(100, CAPABILITY).find(item => isSessionSong(item, sessionId))
      : TASK_ID.test(id) ? this.store.taskById(id) : undefined
    return isSessionSong(task, sessionId) ? this.describe(task) : undefined
  }

  submit(input: SingingInput, source?: { sessionId?: string }): SingingTaskView {
    if (this.closing || !this.provider) throw new DeviceAuthError(503, 'singing-unavailable')
    if (this.active) throw new DeviceAuthError(409, 'singing-busy')
    const parsed = SingingInputSchema.safeParse(input)
    if (!parsed.success) throw new DeviceAuthError(400, 'singing-invalid-input')
    const { data } = parsed
    return this.schedule(data.title, { min: data.durationSeconds - MAX_DURATION_UNDERRUN_SECONDS }, 'generation',
      async signal => ({ bytes: await withAbort(signal, () => this.provider!.generate(data, signal)) }), source?.sessionId)
  }

  submitScore(input: unknown, origin?: ChatSongOrigin): SingingTaskView {
    const request = origin && { sessionId: origin.sessionId, externalId: chatSongExternalId(SINGING_CHAT_SCORE_ID_PREFIX, origin) }
    if (request) {
      const existing = this.chatSongTask(request.externalId, request.sessionId)
      if (existing) return this.describe(existing)
    }
    const { score, cover } = this
    if (this.closing || !score || !cover) throw new DeviceAuthError(503, 'singing-score-unavailable')
    if (this.active) throw new DeviceAuthError(409, 'singing-busy')
    const parsed = SingingScoreInputSchema.safeParse(input)
    if (!parsed.success) throw new DeviceAuthError(400, 'singing-score-invalid')
    const phrases = planSingingScore(parsed.data)
    if (!phrases) throw new DeviceAuthError(400, 'singing-score-unsegmentable')
    const long = phrases.length > 1
    const seconds = scoreDurationSeconds(parsed.data)
    const duration = { min: seconds - MAX_SCORE_TIMING_DRIFT_SECONDS, max: seconds + MAX_SCORE_TIMING_DRIFT_SECONDS }
    return this.schedule(parsed.data.title, duration, 'score', async (signal, run) => {
      const vocal = await score.synthesize(parsed.data, signal, long ? phrases : undefined)
      signal.throwIfAborted()
      let guide: SongWav
      try { guide = parseSongWav(Buffer.from(vocal.buffer, vocal.byteOffset, vocal.byteLength), duration.min, duration.max) }
      catch { throw new DeviceAuthError(502, 'singing-score-output-invalid') }
      run.coverPhase = 'converting'
      if (long) {
        const bytes = await convertLongScore(guide, phrases, parsed.data.bpm, cover, signal,
          (completed, total) => { run.scoreProgress = { stage: 'converting', completed, total } })
        return { bytes, score: parsed.data }
      }
      return { bytes: await cover.convert(vocal, signal), score: parsed.data }
    }, request?.sessionId, request?.externalId, long ? MAX_LONG_SCORE_RENDER_MS : MAX_RENDER_MS)
  }

  submitCover(title: string, guide: Buffer, options?: SingingCoverMix): SingingTaskView {
    if (this.closing || !this.cover) throw new DeviceAuthError(503, 'singing-cover-unavailable')
    if (this.active) throw new DeviceAuthError(409, 'singing-busy')
    if (!title.trim() || title.trim().length > 80 || guide.byteLength > MAX_BYTES) throw new DeviceAuthError(400, 'singing-invalid-guide')
    let duration: number
    try { duration = parseSongWav(guide).durationSeconds }
    catch { throw new DeviceAuthError(400, 'singing-invalid-guide') }
    if (duration < 3 || duration > 60) throw new DeviceAuthError(400, 'singing-invalid-guide')
    let mix: PreparedMix | undefined
    if (options) {
      const gains = coverGains(options)
      let backing: SongWav
      try { backing = parseSongWav(options.accompaniment, 0, Infinity) }
      catch { throw new DeviceAuthError(400, 'singing-invalid-accompaniment') }
      mix = { backing, ...gains }
    }
    return this.schedule(title.trim(), { min: Math.max(1, duration - 1) }, 'cover',
      async signal => ({ bytes: await this.cover!.convert(guide, signal), mix }))
  }

  submitSourceCover(title: string, source: Buffer, options?: CoverGains, origin?: ChatSongOrigin): SingingTaskView {
    const request = origin && { sessionId: origin.sessionId, externalId: chatSongExternalId(SINGING_CHAT_COVER_ID_PREFIX, origin) }
    if (request) {
      const existing = this.chatSongTask(request.externalId, request.sessionId)
      if (existing) return this.describe(existing)
    }
    const { cover, separator } = this
    if (this.closing || !cover || !separator) throw new DeviceAuthError(503, 'singing-source-cover-unavailable')
    if (this.active) throw new DeviceAuthError(409, 'singing-busy')
    title = title.trim()
    if (!title || title.length > 80) throw new DeviceAuthError(400, 'singing-invalid-source')
    let sourceDuration: number
    try { sourceDuration = parseSongWav(source, 3, 60).durationSeconds }
    catch { throw new DeviceAuthError(400, 'singing-invalid-source') }
    const gains = coverGains(options)
    const duration = { min: sourceDuration - MAX_COVER_TIMING_DRIFT_SECONDS, max: sourceDuration + MAX_COVER_TIMING_DRIFT_SECONDS }
    return this.schedule(title, duration, 'source-cover', async (signal, run) => {
      const { vocal, accompaniment } = await separator.separate(source, signal)
      signal.throwIfAborted()
      let backing: SongWav
      try {
        const guide = parseSongWav(Buffer.from(vocal.buffer, vocal.byteOffset, vocal.byteLength), duration.min, duration.max)
        backing = parseSongWav(Buffer.from(accompaniment.buffer, accompaniment.byteOffset, accompaniment.byteLength), duration.min, duration.max)
        if (Math.abs(guide.durationSeconds - backing.durationSeconds) > MAX_COVER_TIMING_DRIFT_SECONDS) throw new Error('Stems drift apart')
      } catch { throw new DeviceAuthError(502, 'singing-invalid-stems') }
      run.coverPhase = 'converting'
      const bytes = await cover.convert(vocal, signal)
      return { bytes, mix: { backing, ...gains } }
    }, request?.sessionId, request?.externalId)
  }

  private schedule(title: string, duration: SongDuration, mode: SongMode, generate: SongGenerator, sessionId?: string, externalId?: string, timeoutMs = MAX_RENDER_MS): SingingTaskView {
    this.prepareDirectory()
    let created = false
    const task = this.store.createTask({ capabilityId: CAPABILITY, contextId: SINGING_CONTEXT, sessionId, title, externalId }, () => { created = true })
    if (externalId && !created) {
      if (!isSessionSong(task, sessionId)) throw new DeviceAuthError(409, 'singing-cover-message-conflict')
      return this.describe(task)
    }
    const run: SongRun = { task, controller: new AbortController(), coverPhase: mode === 'score' ? 'synthesizing' : mode === 'source-cover' ? 'separating' : undefined }
    this.active = run
    run.finished = Promise.resolve().then(() => this.render(run, duration, mode, generate, timeoutMs)).finally(() => { this.active = undefined })
    return this.describe(task)
  }

  cancel(id: string): SingingTaskView {
    const task = this.task(id)
    if (!pending(task)) return this.describe(task)
    if (this.active?.task.id === id) this.active.controller.abort()
    return this.describe(this.store.transitionTask(id, 'cancelled', '已停止本地歌唱任务'))
  }

  archive(): DeviceSingingArchive {
    const items: DeviceSingingTrack[] = []
    for (const entry of this.store.media.list({ kind: 'song', limit: 100 })) {
      const task = entry.source === 'singing' ? this.store.taskById(entry.id) : undefined
      const asset = task?.capabilityId === CAPABILITY ? this.asset(task) : undefined
      if (task && asset) {
        const durationSeconds = this.store.media.songDuration(asset.id, asset.hash!)
        items.push({ id: task.id, title: task.title, createdAt: task.createdAt, bytes: asset.bytes, mimeType: 'audio/wav', durationSeconds })
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { version: 1, items: items.slice(0, 20) }
  }

  async audio(id: string, signal?: AbortSignal, includeVocalEnvelope = false): Promise<{ filePath: string; bytes: number; mimeType: 'audio/wav'; data: Uint8Array; vocalEnvelope?: Uint8Array }> {
    signal?.throwIfAborted()
    const task = this.task(id)
    const asset = this.asset(task)
    if (!asset) throw new DeviceAuthError(404, 'singing-audio-not-found')
    const filePath = this.file(id)
    let data: Buffer
    try {
      if (!lstatSync(this.directory).isDirectory()) throw new Error('Invalid song directory')
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        signal?.throwIfAborted()
        const info = await file.stat()
        if (!info.isFile() || info.size !== asset.bytes) throw new Error('Invalid song file')
        const contents = Buffer.alloc(info.size)
        let offset = 0
        while (offset < contents.length) {
          signal?.throwIfAborted()
          const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        if (offset !== contents.length || (await file.stat()).size !== contents.length || checksum(contents) !== asset.hash) {
          throw new Error('Invalid song content')
        }
        data = contents
      } finally { await file.close() }
    } catch {
      signal?.throwIfAborted()
      throw new DeviceAuthError(404, 'singing-audio-not-found')
    }
    signal?.throwIfAborted()
    let vocalEnvelope: Uint8Array | undefined
    if (includeVocalEnvelope && asset.hash) {
      const levels = this.store.media.songVocalEnvelope(asset.id, asset.hash)
      if (levels?.length && levels.length <= MAX_SONG_VOCAL_SAMPLES) {
        try {
          if (levels.length === songVocalSampleCount(parseSongWav(data))) vocalEnvelope = levels
        } catch { /* Playback may still use its ordinary analyser without the optional envelope. */ }
      }
    }
    this.store.media.touch(asset.path, new Date().toISOString())
    return { filePath, bytes: asset.bytes, mimeType: 'audio/wav', data, ...(vocalEnvelope && { vocalEnvelope }) }
  }

  close(): Promise<void> {
    this.closing = true
    return this.shutdown ??= this.stop()
  }

  private async stop(): Promise<void> {
    const active = this.active
    try {
      if (!active) return
      this.cancel(active.task.id)
      await active.finished
    } finally { this.provider?.close?.() }
  }

  private task(id: string): TaskRecord {
    const task = TASK_ID.test(id) ? this.store.taskById(id) : undefined
    if (task?.capabilityId !== CAPABILITY) throw new DeviceAuthError(404, 'singing-task-not-found')
    return task
  }

  private chatSongTask(externalId: string, sessionId: string): TaskRecord | undefined {
    const task = this.store.taskByExternalId(externalId)
    if (task && !isSessionSong(task, sessionId)) throw new DeviceAuthError(409, 'singing-cover-message-conflict')
    return task
  }

  private asset(task: TaskRecord) {
    if (task.status !== 'succeeded') return
    const asset = this.store.media.get(task.id)
    if (asset?.source !== 'singing' || asset.sourceRef !== task.id || asset.kind !== 'song' || asset.path !== this.archivePath(task.id) ||
      asset.missingAt || asset.deletedAt || !asset.hash || asset.bytes < 44 || asset.bytes > MAX_BYTES || asset.mimeType !== 'audio/wav') return
    return asset
  }

  private describe(task: TaskRecord): SingingTaskView {
    const asset = this.asset(task)
    const coverPhase = pending(task) && this.active?.task.id === task.id ? this.active.coverPhase : undefined
    const scoreProgress = coverPhase === 'converting' ? this.active?.scoreProgress : undefined
    const coverEngine = asset?.hash && this.store.media.songCoverEngine(asset.id, asset.hash)
    const durationSeconds = asset?.hash ? this.store.media.songDuration(asset.id, asset.hash) : undefined
    return { task, ...(asset && { audio: { id: asset.id, bytes: asset.bytes, mimeType: 'audio/wav', durationSeconds } }),
      ...(coverPhase && { coverPhase }), ...(scoreProgress && { scoreProgress }), ...(coverEngine && { coverEngine }) }
  }

  private prepareDirectory(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (!lstatSync(this.directory).isDirectory()) throw new Error('Invalid song directory')
      chmodSync(this.directory, 0o700)
    } catch { throw new DeviceAuthError(503, 'singing-archive-unavailable') }
  }

  private archivePath(id: string): string { return `${SONGS}/${id}.wav` }
  private file(id: string, temporary = false): string { return join(this.directory, `${id}${temporary ? '.pending' : ''}.wav`) }

  private cleanInterruptedFiles(): void {
    const info = lstatSync(this.directory, { throwIfNoEntry: false })
    if (!info?.isDirectory()) return
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const match = OUTPUT_FILE.exec(entry.name)
      const id = match?.[1]
      if (!id || !entry.isFile()) continue
      const task = this.store.taskById(id)
      if (task?.capabilityId === CAPABILITY && (match[2] || task.status !== 'succeeded')) {
        try { unlinkSync(join(this.directory, entry.name)) } catch { /* The artifact remains inaccessible and can be recovered on the next start. */ }
      }
    }
  }

  private async render(run: SongRun, duration: SongDuration, mode: SongMode, generate: SongGenerator, timeoutMs: number): Promise<void> {
    const { id } = run.task
    const coverEngine = mode === 'generation' ? undefined : this.cover?.engine
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(timeoutMs)])
    const temp = this.file(id, true)
    const output = this.file(id)
    let ownsTemp = false
    let linked = false
    let committed = false
    try {
      signal.throwIfAborted()
      this.store.transitionTask(id, 'running')
      const { bytes, mix, score } = await generate(signal, run)
      signal.throwIfAborted()
      if (bytes.byteLength > MAX_BYTES) throw new DeviceAuthError(502, 'singing-invalid-audio')
      const vocal = Buffer.from(bytes)
      let wav: SongWav
      try { wav = parseSongWav(vocal, 1, mode === 'score' ? duration.max : undefined) }
      catch { throw new DeviceAuthError(502, 'singing-invalid-audio') }
      const { durationSeconds } = wav
      if (durationSeconds < duration.min || durationSeconds > (duration.max ?? Infinity)) throw new DeviceAuthError(502, 'singing-invalid-audio')
      if (score) {
        silenceScoreRests(wav, score)
        if (!wav.pcm.some(sampleByte => sampleByte !== 0)) throw new DeviceAuthError(502, 'singing-invalid-audio')
      }
      if (mode === 'source-cover') run.coverPhase = 'mixing'
      const vocalEnvelope = mix ? await songVocalEnvelope(wav, signal) : undefined
      const contents = mix ? await mixSongWav(wav, mix.backing, mix.vocalGainDb, mix.backingGainDb, signal) : vocal
      signal.throwIfAborted()
      if (mode === 'source-cover' || mode === 'score') run.coverPhase = 'archiving'
      const file = await open(temp, 'wx', 0o600)
      ownsTemp = true
      try {
        await file.writeFile(contents, { signal })
        await file.sync()
      } finally { await file.close() }
      signal.throwIfAborted()
      await link(temp, output)
      linked = true
      signal.throwIfAborted()
      const hash = checksum(contents)
      let archived = false
      this.store.transitionTask(id, 'succeeded', undefined, task => {
        this.store.media.upsert({
          id, kind: 'song', path: this.archivePath(id), hash, bytes: contents.length, mimeType: 'audio/wav', source: 'singing',
          sourceRef: id, retention: 'keep', createdAt: task.updatedAt, lastUsedAt: task.updatedAt, lastVerifiedAt: task.updatedAt,
        })
        if (vocalEnvelope) this.store.media.saveSongVocalEnvelope(id, hash, vocalEnvelope)
        if (coverEngine) this.store.media.saveSongCoverEngine(id, hash, coverEngine)
        this.store.media.saveSongDuration(id, hash, durationSeconds)
        this.store.notices.add({ kind: 'song-ready', taskId: id }, `song:${id}`)
        this.store.recordActivity({
          taskId: id, contextId: SINGING_CONTEXT, sessionId: task.sessionId, source: CAPABILITY, kind: 'song.archived', status: 'success',
          summary: '已核验并归档歌唱 WAV', data: { assetId: id, bytes: contents.length, durationSeconds,
            mode: mode === 'source-cover' ? 'cover' : mode, ...(mix && { backingMixed: true }),
            ...(mode === 'source-cover' && { sourceSeparated: true }),
            ...(coverEngine && { coverEngine }), ...(run.scoreProgress && { conversionBlocks: run.scoreProgress.total }),
            ...(vocalEnvelope && { vocalEnvelopeSamples: vocalEnvelope.length }) },
        })
        archived = true
      })
      committed = archived
    } catch (error) {
      const current = this.store.taskById(id)
      if (current && pending(current)) {
        if (run.controller.signal.aborted) this.store.transitionTask(id, 'cancelled', '已停止本地歌唱任务')
        else this.fail(id, signal.aborted ? 'singing-timeout' : providerError(error))
      }
    } finally {
      if (linked && !committed) await unlink(output).catch(() => {})
      if (ownsTemp) await unlink(temp).catch(() => {})
    }
  }

  private fail(id: string, code: string): void {
    this.store.transitionTask(id, 'failed', code, () => {
      this.store.notices.add({ kind: 'song-failed', taskId: id }, `song:${id}`)
    })
  }
}

function coverGains({ vocalGainDb = -2, backingGainDb = -10 }: CoverGains = {}): Required<CoverGains> {
  if (!validSongGain(vocalGainDb) || !validSongGain(backingGainDb)) throw new DeviceAuthError(400, 'singing-invalid-gain')
  return { vocalGainDb, backingGainDb }
}

function pending(task: TaskRecord): boolean { return task.status === 'accepted' || task.status === 'running' }
function checksum(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function chatSongExternalId(prefix: string, { sessionId, messageId }: ChatSongOrigin): string {
  const digest = createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex')
  return `${prefix}${digest}`
}

function isSessionSong(task: TaskRecord | undefined, sessionId: string | undefined): task is TaskRecord {
  return !!sessionId && task?.capabilityId === CAPABILITY && task.contextId === SINGING_CONTEXT && task.sessionId === sessionId
}

function providerError(error: unknown): string {
  return error instanceof DeviceAuthError && /^singing-[a-z-]{1,45}$/u.test(error.code) ? error.code : 'singing-generation-failed'
}

async function withAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run() }), stopped])
  }
  finally { if (abort) signal.removeEventListener('abort', abort) }
}

