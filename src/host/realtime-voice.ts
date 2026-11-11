import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SINGING_CONTEXT, type RealtimeVoiceSession, type RealtimeVoiceView, type SessionBinding, type TaskRecord, type TtsAsset } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { SessionService } from './session.ts'
import type { TtsService } from './tts.ts'
import type { AvatarService } from './avatar.ts'
import { DeviceAuthError } from './devices.ts'
import { RealtimePcmError, type RealtimePcmProvider, type RealtimePcmStream } from './realtime-pcm.ts'
import type { SingingService } from './singing.ts'
import { parseSongWav } from './song-mix.ts'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const canPlay = (session: RealtimeVoiceSession) => session.status === 'preparing' || session.status === 'playing'
const canAutoRead = (binding: SessionBinding) => binding.kind === 'chat' || binding.kind === 'game'
const AUTO_READ_LEASE_MS = 5000
const PCM_DISCONNECT_GRACE_MS = 1000
const PCM_RECEIPT_GRACE_MS = 5000
const SONG_START_GRACE_MS = 25_000
const SONG_END_GRACE_MS = 8_000
const SONG_END_TOLERANCE_MS = 1_000

type StageAudio = Pick<TtsAsset, 'filePath' | 'bytes' | 'mimeType'> & {
  data?: Uint8Array
  vocalEnvelope?: Uint8Array
  onDelivered?: () => void
}
type SongAudio = Awaited<ReturnType<SingingService['audio']>>

interface SongPlayback {
  stageId: string
  audio?: SongAudio
  deadline: number
  delivered?: true
  startedAt?: number
}

interface PcmSegment {
  index: number
  controller: AbortController
  started?: boolean
  ended?: boolean
}

interface AutoReadReply {
  turn: number
  messageId: string
  text: string
}

interface AutoReadLease {
  stageId: string
  contextId: string
  sessionId: string
  expiresAt: number
  lastSeq: number
  candidate?: AutoReadReply
  pending?: AutoReadReply
}

export function segmentSpeech(text: string, maxLength = 180, maxSegments = 6): string[] {
  const segments: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1)
    let cut = -1
    for (let index = maxLength; index >= Math.floor(maxLength * 0.45); index--) {
      if (/[。！？!?；;\n]/u.test(window[index] ?? '')) {
        cut = index + 1
        break
      }
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ')
      cut = space >= Math.floor(maxLength * 0.45) ? space : maxLength
    }
    segments.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) segments.push(remaining)
  if (!segments.length || segments.length > maxSegments || segments.some(segment => segment.length > 240)) {
    throw new DeviceAuthError(400, 'voice-segmentation-failed')
  }
  return segments
}

export class RealtimeVoiceService {
  private session?: RealtimeVoiceSession
  private playbackStageId?: string
  private pcmPlayback?: { stageId?: string; segment?: PcmSegment; deadline?: number }
  private songPlayback?: SongPlayback
  private songVerification?: AbortController
  private songTimer?: ReturnType<typeof setInterval>
  private autoRead?: AutoReadLease
  private pumping = false
  private closed = false

  constructor(
    private readonly store: CompanionStore,
    private readonly sessions: SessionService,
    private readonly tts: TtsService,
    private readonly avatar: AvatarService,
    private readonly media?: { touch: (filePath: string) => Promise<unknown> },
    private readonly pcm?: RealtimePcmProvider,
    private readonly singing?: Pick<SingingService, 'audio'>,
  ) {}

  start(): void {
    for (const task of this.store.tasks(100, 'media.realtime').filter(task => task.capabilityId === 'media.realtime' && ['accepted', 'running'].includes(task.status))) {
      this.store.transitionTask(task.id, 'cancelled', '实时语音服务重启，旧播放无法继续核验')
    }
  }

  view(): RealtimeVoiceView {
    this.reconcileStage()
    return {
      session: this.session,
      ...(this.pcm && !this.closed ? { streamingAvailable: true } : {}),
      playbackStageId: this.playbackStageId,
      streamStageId: this.pcmPlayback?.stageId,
      ...(this.songPlayback && { songStageId: this.songPlayback.stageId }),
      tasks: this.store.tasks(5, 'media.realtime').filter(task => task.capabilityId === 'media.realtime').slice(0, 5),
    }
  }

  private reconcileStage(): void {
    const session = this.session
    if (!session || !canPlay(session) && session.status !== 'cancelling') return
    const song = this.songPlayback
    if (song) {
      const alive = !!this.avatar.songStage(song.stageId)
      if (!alive || Date.now() >= song.deadline) {
        const error = session.status === 'cancelling' ? 'song-stop-unconfirmed' : alive ? 'song-playback-receipt-timeout' : 'song-stage-offline'
        this.fail(error)
      }
      return
    }
    const autoStageGone = canPlay(session) && this.playbackStageId && this.activeAutoRead()?.stageId !== this.playbackStageId
    const deadline = this.pcmPlayback?.deadline
    const timedOut = deadline !== undefined && Date.now() >= deadline
    if (autoStageGone || !this.stageReady() || timedOut) {
      const error = session.status === 'cancelling' ? 'voice-stop-unconfirmed' : timedOut ? 'voice-stream-receipt-timeout' : 'voice-stage-offline'
      this.fail(error)
    }
  }

  private activeAutoRead(): AutoReadLease | undefined {
    const auto = this.autoRead
    if (auto && auto.expiresAt > Date.now()) {
      const binding = this.store.bindingByContext(auto.contextId)
      if (binding?.sessionId === auto.sessionId && canAutoRead(binding)) return auto
    }
    this.autoRead = undefined
    return undefined
  }

  autoReadScenes(): { contextId: string; label: string }[] {
    return this.store.bindings().filter(canAutoRead).map(({ contextId, label }) => ({ contextId, label }))
  }

  enableAutoRead(contextId: string, stageId: string): { enabled: true; contextId: string } {
    if (this.closed) throw new DeviceAuthError(503, 'voice-stopping')
    if (!this.stageReady()) throw new DeviceAuthError(409, 'voice-stage-offline')
    const binding = this.store.bindingByContext(contextId)
    if (!binding || !canAutoRead(binding)) throw new DeviceAuthError(404, 'voice-auto-scene-not-found')
    const current = this.activeAutoRead()
    if (current && current.stageId !== stageId) throw new DeviceAuthError(409, 'voice-auto-stage-busy')
    if (current && current.contextId !== contextId) throw new DeviceAuthError(409, 'voice-auto-disable-first')
    this.autoRead = current ?? { stageId, contextId, sessionId: binding.sessionId, lastSeq: -1, expiresAt: Date.now() + AUTO_READ_LEASE_MS }
    this.autoRead.expiresAt = Date.now() + AUTO_READ_LEASE_MS
    return { enabled: true, contextId }
  }

  disableAutoRead(stageId: string): { enabled: false } {
    if (this.autoRead?.stageId === stageId) {
      this.autoRead = undefined
      if (this.playbackStageId === stageId && this.session && canPlay(this.session)) this.cancel(this.session.id)
    }
    return { enabled: false }
  }

  observe(binding: SessionBinding, event: SessionEvent): void {
    const auto = this.autoRead
    if (!auto || auto.expiresAt <= Date.now() || auto.contextId !== binding.contextId || auto.sessionId !== binding.sessionId || !canAutoRead(binding) || event.seq <= auto.lastSeq) return
    auto.lastSeq = event.seq
    if (event.type === 'assistant/message') {
      const { message, interrupted, turn } = event.data
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      auto.candidate = !interrupted && text && text.length <= 900 && !message.content.some(block => block.type === 'tool-call')
        ? { turn, text, messageId: String(message.id) }
        : undefined
    } else if (event.type === 'turn/end') {
      const reply = auto.candidate
      auto.candidate = undefined
      if (event.data.reason.kind === 'completed' && reply?.turn === event.data.turn) auto.pending = reply
    }
  }

  pollAutoRead(stageId: string): { enabled: boolean; pending?: boolean; started?: true } {
    this.reconcileStage()
    const auto = this.activeAutoRead()
    if (!auto || auto.stageId !== stageId) return { enabled: false }
    auto.expiresAt = Date.now() + AUTO_READ_LEASE_MS
    if (auto.pending && this.stageReady() && !this.busy()) {
      const reply = auto.pending
      auto.pending = undefined
      if (this.session?.contextId !== auto.contextId || this.session.messageId !== reply.messageId) {
        this.launch(auto.contextId, auto.sessionId, reply.messageId, segmentSpeech(reply.text), stageId)
        if (this.pcmPlayback) return { enabled: true, pending: false, started: true }
      }
    }
    return { enabled: true, pending: !!auto.pending }
  }

  async startSession(contextId: string, messageId?: string, streaming = true): Promise<RealtimeVoiceView> {
    this.assertStartable()
    const history = await this.sessions.history(contextId, 200)
    const message = messageId
      ? history.messages.find(item => item.id === messageId)
      : [...history.messages].reverse().find(item => item.role === 'assistant' && item.text.trim())
    if (!message || message.role !== 'assistant' || !message.text.trim()) throw new DeviceAuthError(404, 'assistant-message-not-found')
    if (message.text.length > 900) throw new DeviceAuthError(400, 'message-too-long-for-realtime')
    const segments = segmentSpeech(message.text)
    this.assertStartable()
    this.launch(contextId, history.sessionId, message.id, segments, undefined, streaming)
    return this.view()
  }

  async startSong(songTaskId: string, stageId?: string): Promise<RealtimeVoiceView> {
    if (!this.singing) throw new DeviceAuthError(503, 'song-archive-unavailable')
    this.assertSlot()
    const target = this.avatar.songStage(stageId)
    if (!target) throw new DeviceAuthError(409, 'song-stage-not-ready')
    const song = this.store.taskById(songTaskId)
    if (song?.capabilityId !== 'media.singing' || song.status !== 'succeeded') throw new DeviceAuthError(404, 'singing-audio-not-found')

    const verification = new AbortController()
    this.songVerification = verification
    const signal = AbortSignal.any([verification.signal, AbortSignal.timeout(SONG_START_GRACE_MS)])
    try {
      const audio = await this.singing.audio(songTaskId, signal, true)
      if (this.closed) throw new DeviceAuthError(503, 'voice-stopping')
      if (!this.avatar.songStage(target)) throw new DeviceAuthError(409, 'song-stage-not-ready')
      let songDurationMs: number
      try {
        songDurationMs = Math.round(parseSongWav(Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength)).durationSeconds * 1000)
      } catch { throw new DeviceAuthError(404, 'singing-audio-not-found') }
      const task = this.store.createTask({ capabilityId: 'media.realtime', contextId: SINGING_CONTEXT, title: `舞台播放：${song.title}` })
      const now = new Date().toISOString()
      this.playbackStageId = undefined
      this.pcmPlayback = undefined
      this.songPlayback = { stageId: target, audio, deadline: Date.now() + SONG_START_GRACE_MS }
      this.session = {
        id: randomUUID(), taskId: task.id, contextId: SINGING_CONTEXT, messageId: songTaskId,
        kind: 'song', title: song.title, songDurationMs, status: 'preparing',
        segments: [{ index: 0, taskId: songTaskId, text: '', status: 'ready' }], createdAt: now, updatedAt: now,
      }
      this.songTimer = setInterval(() => {
        // Retain the live state and retry if persistence is briefly unavailable.
        try { this.reconcileStage() } catch {}
      }, 1000)
      this.songTimer.unref()
      return this.view()
    } catch (error) {
      if (this.closed) throw new DeviceAuthError(503, 'voice-stopping')
      if (signal.aborted) throw new DeviceAuthError(503, 'song-archive-timeout')
      throw error
    } finally { this.songVerification = undefined }
  }

  private launch(contextId: string, sessionId: string, messageId: string, segments: string[], stageId?: string, streaming = true): void {
    const task = this.store.createTask({ capabilityId: 'media.realtime', contextId, sessionId, title: '分段语音与 Live2D 口型' })
    const now = new Date().toISOString()
    this.playbackStageId = stageId
    this.songPlayback = undefined
    this.pcmPlayback = streaming && this.pcm ? { stageId } : undefined
    this.session = {
      id: randomUUID(), taskId: task.id, contextId, messageId,
      ...(this.pcmPlayback ? { streaming: true } : {}),
      status: 'preparing', segments: segments.map((text, index) => ({
        index, text, status: this.pcmPlayback ? 'ready' : 'pending',
      })), createdAt: now, updatedAt: now,
    }
    if (!this.pcmPlayback) void this.pump(this.session.id)
  }

  private stageReady(): boolean {
    return this.avatar.view().presentation?.ready === true
  }

  homeSpeaking(now: number, stageReady?: boolean): boolean {
    if (this.closed || this.session?.kind === 'song' || this.session?.status !== 'playing' || !this.session.segments.some(segment => segment.status === 'playing')) return false
    if (this.playbackStageId && (this.autoRead?.stageId !== this.playbackStageId || this.autoRead.expiresAt <= now)) return false
    if (this.pcmPlayback?.deadline !== undefined && this.pcmPlayback.deadline <= now) return false
    return stageReady ?? this.stageReady()
  }

  homeSinging(now: number): boolean {
    const song = this.songPlayback
    return !this.closed && this.session?.kind === 'song' && this.session.status === 'playing' && !!song && song.deadline > now &&
      this.avatar.songStage(song.stageId, now) === song.stageId
  }

  private busy(): boolean {
    const session = this.session
    return this.pumping || !!this.songVerification || !!session && (canPlay(session) || session.status === 'cancelling')
  }

  private assertSlot(): void {
    if (this.closed) throw new DeviceAuthError(503, 'voice-stopping')
    this.reconcileStage()
    if (this.busy()) throw new DeviceAuthError(409, 'voice-session-busy')
  }

  private assertStartable(): void {
    this.assertSlot()
    if (!this.stageReady()) throw new DeviceAuthError(409, 'voice-stage-offline')
  }

  private async pump(sessionId: string): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const session = this.session
      if (!session || session.id !== sessionId) return
      for (const segment of session.segments) {
        if (!canPlay(session)) return
        const task = await this.tts.synthesizeClip(session.contextId, session.messageId, segment.text)
        if (!canPlay(session)) {
          if (this.store.taskById(task.id)?.status === 'accepted') this.store.transitionTask(task.id, 'cancelled', '分段语音已停止')
          return
        }
        segment.taskId = task.id
        segment.status = 'synthesizing'
        this.touch()
        const settled = await this.waitForClip(task.id, session)
        this.reconcileStage()
        if (!settled || !canPlay(session)) return
        if (settled.status !== 'succeeded') throw new Error(settled.error ?? 'voice-synthesis-failed')
        segment.status = 'ready'
        this.touch()
      }
    } catch (error) {
      if (this.session?.id === sessionId && canPlay(this.session)) {
        this.fail(error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300))
      }
    } finally {
      this.pumping = false
    }
  }

  private async waitForClip(taskId: string, session: RealtimeVoiceSession): Promise<TaskRecord | undefined> {
    const deadline = Date.now() + 65_000
    while (Date.now() < deadline) {
      if (!canPlay(session)) return
      const task = this.store.taskById(taskId)
      if (!task) throw new Error('voice-clip-not-found')
      if (!['accepted', 'running'].includes(task.status)) return task
      await delay(100)
    }
    throw new Error('voice-synthesis-timeout')
  }

  receipt(input: { sessionId: string; stageId?: string; segmentIndex: number; status: 'playing' | 'completed' | 'cancelled' | 'error'; positionMs?: number; energy?: number; error?: string }): RealtimeVoiceView {
    const session = this.session
    if (!session || session.id !== input.sessionId) throw new DeviceAuthError(404, 'voice-session-not-found')
    const song = this.songPlayback
    if (song && song.stageId !== input.stageId) throw new DeviceAuthError(409, 'song-stage-mismatch')
    if (this.playbackStageId && this.playbackStageId !== input.stageId) throw new DeviceAuthError(409, 'voice-auto-stage-mismatch')
    if (this.pcmPlayback?.stageId && this.pcmPlayback.stageId !== input.stageId) throw new DeviceAuthError(409, 'voice-stream-stage-mismatch')
    if (song || this.playbackStageId || this.pcmPlayback) this.reconcileStage()
    const segment = session.segments[input.segmentIndex]
    if (!segment) throw new DeviceAuthError(404, 'voice-segment-not-found')
    if (input.status === 'completed' && segment.status === 'completed' || input.status === 'cancelled' && session.status === 'cancelled') return this.view()
    if (!canPlay(session) && session.status !== 'cancelling') throw new DeviceAuthError(409, 'voice-already-settled')
    if (this.pcmPlayback && session.status === 'cancelling' && input.status === 'error') throw new DeviceAuthError(409, 'voice-not-playing')
    const status = input.status === 'completed' && session.status === 'cancelling' && segment.status === 'playing' ? 'cancelled' : input.status
    if (status === 'playing') {
      if (!canPlay(session)) throw new DeviceAuthError(409, 'voice-cannot-play')
      if (segment.status !== 'ready' && segment.status !== 'playing') throw new DeviceAuthError(409, 'voice-segment-not-ready')
      if (session.segments.find(item => item.status !== 'completed') !== segment) throw new DeviceAuthError(409, 'voice-segment-out-of-order')
      if (this.pcmPlayback && (this.pcmPlayback.segment?.index !== segment.index || !this.pcmPlayback.segment.started)) throw new DeviceAuthError(409, 'voice-stream-not-started')
      const task = this.store.taskById(session.taskId)
      if (song) {
        if (!song.delivered) throw new DeviceAuthError(409, 'song-audio-not-delivered')
        if (task?.status !== 'accepted' && task?.status !== 'running') throw new DeviceAuthError(409, 'song-task-not-active')
      }
      if (task?.status === 'accepted') this.store.transitionTask(session.taskId, 'running')
      if (song) {
        if (song.startedAt === undefined) {
          song.startedAt = Date.now()
          song.deadline = song.startedAt + session.songDurationMs! + SONG_END_GRACE_MS
        }
      }
      segment.status = 'playing'
      session.status = 'playing'
    } else if (status === 'completed') {
      if (segment.status !== 'playing') throw new DeviceAuthError(409, 'voice-segment-not-playing')
      if (this.pcmPlayback && !this.pcmPlayback.segment?.ended) throw new DeviceAuthError(409, 'voice-stream-not-ended')
      if (song) {
        const duration = session.songDurationMs!
        if (song.startedAt === undefined || input.positionMs === undefined || !Number.isFinite(input.positionMs) ||
            Date.now() - song.startedAt < duration - SONG_END_TOLERANCE_MS || Math.abs(input.positionMs - duration) > SONG_END_TOLERANCE_MS) {
          throw new DeviceAuthError(409, 'song-playback-incomplete')
        }
        this.settleParent('succeeded')
      }
      segment.status = 'completed'
      segment.positionMs = input.positionMs
      segment.energy = input.energy
      if (session.segments.every(item => item.status === 'completed')) {
        session.status = 'succeeded'
        if (!song) this.settleParent('succeeded')
      } else if (this.pcmPlayback) {
        this.pcmPlayback.deadline = Date.now() + PCM_RECEIPT_GRACE_MS
      }
    } else if (status === 'cancelled') {
      if (session.status !== 'cancelling') throw new DeviceAuthError(409, 'voice-not-cancelling')
      if (song) this.settleParent('cancelled', '舞台已停止歌曲播放')
      session.status = 'cancelled'
      for (const item of session.segments) {
        if (item.status !== 'completed') item.status = 'cancelled'
        if (item.taskId) {
          const task = this.store.taskById(item.taskId)
          if (task?.status === 'accepted') this.store.transitionTask(task.id, 'cancelled', '主人停止了分段语音')
        }
      }
      if (!song) this.settleParent('cancelled', '舞台已停止分段语音')
    } else {
      this.fail(input.error?.slice(0, 300) ?? 'voice-playback-failed')
    }
    this.touch()
    return this.view()
  }

  cancel(sessionId?: string): RealtimeVoiceView {
    const session = this.session
    if (!session || sessionId && session.id !== sessionId) throw new DeviceAuthError(404, 'voice-session-not-found')
    if (['succeeded', 'failed', 'cancelled'].includes(session.status)) return this.view()
    if (!this.songPlayback) this.autoRead = undefined
    if (this.pcmPlayback && session.status !== 'cancelling') this.pcmPlayback.deadline = Date.now() + PCM_RECEIPT_GRACE_MS
    if (this.songPlayback && session.status !== 'cancelling') this.songPlayback.deadline = Date.now() + PCM_RECEIPT_GRACE_MS
    session.status = 'cancelling'
    this.pcmPlayback?.segment?.controller.abort()
    this.touch()
    return this.view()
  }

  async audio(taskId: string, stageId?: string): Promise<StageAudio> {
    this.reconcileStage()
    const session = this.session
    const song = this.songPlayback
    if (song) {
      if (!song.audio || !session || !canPlay(session) || song.stageId !== stageId || session.messageId !== taskId) {
        throw new DeviceAuthError(404, 'voice-audio-not-ready')
      }
      return { ...song.audio, onDelivered: () => {
        if (this.session === session && this.songPlayback === song && canPlay(session)) song.delivered = true
      } }
    }
    if (this.playbackStageId && this.playbackStageId !== stageId) throw new DeviceAuthError(404, 'voice-audio-not-ready')
    const segment = session && (canPlay(session) || session.status === 'succeeded') && session.segments.find(item => item.taskId === taskId)
    if (!segment || !['ready', 'playing', 'completed'].includes(segment.status)) throw new DeviceAuthError(404, 'voice-audio-not-ready')
    const asset = await this.tts.audio(taskId)
    await this.media?.touch(asset.filePath)
    return asset
  }

  stream(sessionId: string, index: number, stageId: string, clientSignal: AbortSignal): RealtimePcmStream {
    this.reconcileStage()
    const { session, pcmPlayback, pcm } = this
    if (!session || session.id !== sessionId || !pcmPlayback || !pcm) throw new DeviceAuthError(404, 'voice-stream-not-found')
    if (pcmPlayback.stageId && pcmPlayback.stageId !== stageId) throw new DeviceAuthError(409, 'voice-stream-stage-mismatch')
    const segment = session.segments[index]
    if (!segment) throw new DeviceAuthError(404, 'voice-segment-not-found')
    if (!canPlay(session) || segment.status !== 'ready' || pcmPlayback.segment?.index === index) throw new DeviceAuthError(409, 'voice-stream-not-ready')
    if (session.segments.find(item => item.status !== 'completed') !== segment) throw new DeviceAuthError(409, 'voice-segment-out-of-order')
    const state = { index, controller: new AbortController() }
    pcmPlayback.stageId = stageId
    pcmPlayback.segment = state
    pcmPlayback.deadline = undefined
    this.touch()
    const upstream = pcm.stream(segment.text, AbortSignal.any([clientSignal, state.controller.signal]))
    return { ...upstream, body: this.relayPcm(session, state, upstream, clientSignal) }
  }

  private async *relayPcm(session: RealtimeVoiceSession, state: PcmSegment, upstream: RealtimePcmStream, clientSignal: AbortSignal): AsyncGenerator<Buffer> {
    let failure = 'voice-stream-provider-error'
    let bytes = 0
    try {
      for await (const chunk of upstream.body) {
        this.reconcileStage()
        upstream.signal.throwIfAborted()
        state.started = true
        bytes += chunk.length
        yield chunk
      }
      state.ended = true
      if (this.session === session && canPlay(session) && this.pcmPlayback && this.pcm) {
        this.pcmPlayback.deadline = Date.now() + Math.ceil(bytes * 500 / this.pcm.sampleRate) + PCM_RECEIPT_GRACE_MS
      }
    } catch (error) {
      if (error instanceof RealtimePcmError) failure = error.message
      if (upstream.signal.reason?.name === 'TimeoutError') failure = 'voice-stream-timeout'
      throw new DeviceAuthError(failure === 'voice-stream-busy' ? 409 : 502, failure)
    } finally {
      if (!state.ended && this.session === session && canPlay(session)) {
        if (clientSignal.aborted) {
          // A deliberate browser interrupt closes the audio transport before its cancel POST arrives.
          setTimeout(() => {
            if (this.session === session && canPlay(session)) this.fail('voice-stream-disconnected')
          }, PCM_DISCONNECT_GRACE_MS).unref()
        } else {
          this.fail(upstream.signal.reason?.name === 'TimeoutError' ? 'voice-stream-timeout' : failure)
        }
      }
    }
  }

  private fail(error: string): void {
    if (!this.session) return
    const song = this.session.kind === 'song'
    if (song) this.settleParent('failed', error)
    this.session.status = 'failed'
    this.session.error = error
    this.pcmPlayback?.segment?.controller.abort()
    if (!song) this.settleParent('failed', error)
    this.touch()
  }

  private settleParent(status: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    const session = this.session
    if (!session) return
    const task = this.store.taskById(session.taskId)
    const songFinished = session.kind === 'song' && status === 'succeeded'
    if (songFinished && task?.status !== 'running') throw new DeviceAuthError(409, 'song-task-not-active')
    if (task && ['accepted', 'running'].includes(task.status)) this.store.transitionTask(task.id, status, error,
      songFinished ? () => {
        this.store.recordActivity({
          source: 'media.realtime', kind: 'song.played', status: 'success', taskId: task.id, contextId: SINGING_CONTEXT,
          summary: 'Live2D 舞台已完成歌曲播放', data: { songTaskId: session.messageId, durationMs: session.songDurationMs ?? 0 },
        })
      } : undefined)
    if (this.songPlayback) this.songPlayback.audio = undefined
    if (this.songTimer) clearInterval(this.songTimer)
    this.songTimer = undefined
  }

  private touch(): void {
    if (this.session) this.session.updatedAt = new Date().toISOString()
  }

  async close(): Promise<void> {
    this.closed = true
    this.songVerification?.abort()
    this.autoRead = undefined
    const session = this.session
    if (session && !['succeeded', 'failed', 'cancelled'].includes(session.status)) {
      session.status = 'cancelled'
      this.settleParent('cancelled', '实时语音服务已停止')
    }
    this.pcmPlayback?.segment?.controller.abort()
    this.pcm?.close()
    for (const segment of session?.segments ?? []) {
      if (segment.taskId && this.store.taskById(segment.taskId)?.status === 'accepted') this.store.transitionTask(segment.taskId, 'cancelled', '实时语音服务已停止')
    }
    this.session = undefined
    this.songPlayback = undefined
  }
}
