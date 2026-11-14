import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { CompanionStore } from '../core/store.ts'
import { communitySiteFor, projectCommunity } from '../core/community.ts'
import { projectHome, projectHomeStatus, selectHomeActivity, type HomeActivityInput } from '../core/home.ts'
import { BILIBILI_CONTEXT, BILIBILI_SHARE_CONTEXT, SINGING_CONTEXT, type ActivityInput, type FeedAuthor, type FeedCreateInput, type FeedPost, type JsonValue, type MemoryStatus, type Presence, type SessionBinding } from '../core/model.ts'
import { HOME_JOURNAL_REVISION_MS, type BindContextInput, type CommunityCampReceipt, type HealthView, type MemoryView, type WorkbenchView } from '../protocol/api.ts'
import type { HomeLiveView, VoiceReplyReadyEvent } from '../protocol/events.ts'
import { MAX_SINGING_MIDI_BYTES } from '../protocol/singing-midi.ts'
import { MAX_SINGING_SCORE_SECONDS } from '../protocol/singing.ts'
import { registerMemoryRecall } from './recall.ts'
import { SessionService } from './session.ts'
import { MAX_CHAT_ATTACHMENT_BYTES } from './chat-attachments.ts'
import type { EventHub } from './events.ts'
import { TtsService, type TtsOptions } from './tts.ts'
import { AutonomyService } from './autonomy.ts'
import { MediaService } from './media.ts'
import { AvatarService } from './avatar.ts'
import { RealtimeVoiceService } from './realtime-voice.ts'
import type { RealtimePcmProvider, RealtimePcmStream } from './realtime-pcm.ts'
import { DeviceAuthError } from './devices.ts'
import { DevicePlaybackService } from './device-playback.ts'
import { DEVICE_FEED_IMAGE_PATH, DeviceMediaService, prepareDeviceImage } from './device-media.ts'
import { deviceFeedPostId } from './device-feed.ts'
import type { DeviceFeedPublishInput } from './api-schemas.ts'
import { companionToolPolicy } from './tool-policy.ts'
import { MinecraftService, type MinecraftTransportOptions } from './minecraft.ts'
import { MinecraftVoiceRelay } from './minecraft-voice.ts'
import { MAX_BILIBILI_CLIP_SECONDS } from '../protocol/bilibili.ts'
import { BilibiliService } from './bilibili.ts'
import { QwenWatchService } from './qwen-watch.ts'
import { SingingService, type SingingProvider } from './singing.ts'
import type { SingingCoverProvider } from './singing-cover.ts'
import type { SingingSeparatorProvider } from './singing-separation.ts'
import type { SingingScoreProvider } from './singing-score.ts'
import type { LocalAsrProvider } from './asr.ts'
import type { DeepSeekAsrProvider } from './asr-deepseek.ts'
import { VoicePrefixCache } from './voice-prefix.ts'
import { VoicePrefixAttempt } from './voice-prefix-intent.ts'
import { IdleCompactionService } from './idle-compaction.ts'
import { PresenterService } from './presenter.ts'
import { renderSurveyCard } from './survey-card.ts'
import { createWorldConnectors } from './world-connectors.ts'
import { worldForContext } from './world-manifest.ts'

const VOICE_REPLY_CHECKPOINT_MS = 3000
const MAX_PENDING_VOICE_REPLIES = 4
const VOICE_PREFIX_GRACE_MS = 40

interface VoiceReplyTurn {
  session: Session
  contextId: string
  turn: number
  seq: number
  hasDirectInput: boolean
  step?: number
  voiceReply?: true
  prefixBlocked?: true
  attempt?: VoicePrefixAttempt
  prefixTimer?: NodeJS.Timeout
  userMessageId?: string
  assistantMessageId?: string
  noticeInput?: boolean
  noticeReply?: boolean
}

export class CompanionRuntime {
  readonly sessions: SessionService
  readonly tts: TtsService
  readonly autonomy: AutonomyService
  readonly media: MediaService
  readonly deviceMedia: DeviceMediaService
  readonly devicePlayback = new DevicePlaybackService()
  readonly avatar: AvatarService
  readonly idleCompaction: IdleCompactionService
  readonly presenter: PresenterService
  readonly realtimeVoice: RealtimeVoiceService
  readonly minecraft: MinecraftService
  readonly bilibili: BilibiliService
  readonly qwenWatch: QwenWatchService
  readonly singing: SingingService
  musicPlugins?: import('./music-plugins.ts').MusicPluginService
  readonly worlds: ReturnType<typeof createWorldConnectors>
  private readonly events: EventHub[] = []
  private readonly voiceTurns = new Map<string, VoiceReplyTurn>()
  private readonly voiceDeliveries = new Map<string, Set<AbortController>>()
  private readonly voicePrefixes?: VoicePrefixCache
  private voiceStopped = false

  constructor(
    private readonly ctx: Context,
    readonly store: CompanionStore,
    private readonly pluginVersion: string,
    ttsOptions: TtsOptions,
    mediaRoot: string,
    dataDir: string,
    avatarRoot: string,
    minecraftServerRoot: string,
    minecraftOwner: string,
    private readonly realtimePcm?: RealtimePcmProvider,
    readonly asr?: LocalAsrProvider | DeepSeekAsrProvider,
    singingProvider?: SingingProvider,
    coverProvider?: SingingCoverProvider,
    separatorProvider?: SingingSeparatorProvider,
    scoreProvider?: SingingScoreProvider,
    minecraftWardrobeFile?: string,
    minecraftTransport?: MinecraftTransportOptions,
    bilibiliFfmpeg = 'ffmpeg',
    minecraftOvoRoot = '',
  ) {
    this.sessions = new SessionService(ctx, store, input => this.bindContext(input))
    this.tts = new TtsService(store, this.sessions, ttsOptions)
    this.media = new MediaService(store, mediaRoot)
    this.deviceMedia = new DeviceMediaService(store, mediaRoot)
    this.bilibili = new BilibiliService(store, fetch, { ffmpeg: bilibiliFfmpeg, asr })
    this.qwenWatch = new QwenWatchService(this.bilibili)
    this.singing = new SingingService(store, mediaRoot, singingProvider, coverProvider, separatorProvider, scoreProvider)
    const packageRoot = dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json'))
    this.avatar = new AvatarService(store, avatarRoot, join(packageRoot, 'lib', 'avatar'))
    this.realtimeVoice = new RealtimeVoiceService(store, this.sessions, this.tts, this.avatar, this.media, realtimePcm, this.singing)
    this.presenter = new PresenterService(this.avatar, () => {
      const now = Date.now()
      const playback = {
        singing: this.realtimeVoice.homeSinging(now),
        speaking: this.realtimeVoice.homeSpeaking(now, this.avatar.presenterStageReady(now)),
      }
      const frame = this.avatar.presenterFrame(now, playback.singing || playback.speaking)
      return frame.available ? { ...frame, activity: selectHomeActivity(this.homeObservation(new Date(now), this.store.bindings(), { playback })) } : frame
    })
    if (realtimePcm) this.voicePrefixes = new VoicePrefixCache(realtimePcm)
    const localVoiceDir = join(homedir(), '.local', 'share', 'companion', 'minecraft', 'voice')
    const voiceDir = minecraftTransport?.voiceDir || (existsSync(join(localVoiceDir, 'owner')) ? localVoiceDir : '')
    const minecraftVoice = voiceDir ? new MinecraftVoiceRelay(voiceDir, this.tts) : undefined
    this.minecraft = new MinecraftService(
      store, this.sessions, { dataDir, serverRoot: minecraftServerRoot, owner: minecraftOwner, wardrobeFile: minecraftWardrobeFile, ovoRoot: minecraftOvoRoot, ...minecraftTransport },
      event => this.autonomy.enqueueMinecraft(event),
      moment => { this.autonomy.enqueueMinecraftShare(moment) },
      (zoneId, explicit) => {
        try { if (explicit) this.autonomy.stopMinecraftSurveyWindowForToday(zoneId) }
        finally { this.autonomy.cancelMinecraftSupply(zoneId) }
      },
      () => this.autonomy.cancelMinecraftEventForCampPause(),
      () => this.autonomy.canReceiveMinecraftChat(),
      minecraftVoice && ((taskId, text, stillAllowed) => {
        void minecraftVoice.deliver(taskId, text, stillAllowed).catch(() => {
          ctx.logger('companion').warn('Minecraft voice reply unavailable')
        })
      }),
    )
    this.autonomy = new AutonomyService(
      store, this.sessions, this.avatar,
      {
        campPaused: () => this.minecraft.campControl().pausedAt !== undefined,
        eventPrompt: job => this.minecraft.eventPrompt(job),
        finishEvent: job => this.minecraft.finishEvent(job),
        recoverySources: now => this.minecraft.recoverySources(now),
        recoverySource: taskId => this.minecraft.recoverySource(taskId),
        resurveyRecovery: (taskId, signal) => this.minecraft.resurveyRecovery(taskId, signal),
        recoveryPlacementAvailable: (taskId, signal) => this.minecraft.recoveryPlacementAvailable(taskId, signal),
        recoveryCandidates: (taskId, signal) => this.minecraft.recoveryCandidates(taskId, signal),
        placeRecoveryCell: (taskId, index, signal, mode) => this.minecraft.placeRecoveryCell(taskId, index, signal, mode),
        verifyRecoveryCompletion: (taskId, signal, assertAuthorized) => this.minecraft.verifyRecoveryCompletion(taskId, signal, assertAuthorized),
        recoveryCompletionValid: (taskId, result) => this.minecraft.recoveryCompletionValid(taskId, result),
        inspectSupply: (zoneId, signal) => this.minecraft.inspectSupply(zoneId, signal),
        supply: (zoneId, recipe, signal) => this.minecraft.supply(zoneId, recipe, signal),
        inspectCampBuild: (zoneId, signal) => this.minecraft.inspectCampBuild(zoneId, signal),
        buildAutonomousCamp: (zoneId, material, signal) => this.minecraft.buildAutonomousCamp(zoneId, material, signal),
        inspectCampPreparation: (zoneId, signal) => this.minecraft.inspectCampPreparation(zoneId, signal),
        prepareAutonomousCamp: (zoneId, offer, options) => this.minecraft.prepareAutonomousCamp(zoneId, offer, options),
        inspectCampSurvey: (zoneId, signal, visitId) => this.minecraft.inspectCampSurvey(zoneId, signal, visitId),
        surveyWindowReady: now => this.minecraft.surveyWindowReady(now),
        campVisitReady: now => this.minecraft.campVisitReady(now),
        startCampVisit: (id, zoneId, expiresAt, signal, allowSupply, allowBuild, allowRevisit, mode) =>
          this.minecraft.startCampVisit(id, zoneId, expiresAt, signal, allowSupply, allowBuild, allowRevisit, mode),
        endCampVisit: id => this.minecraft.endCampVisit(id),
        inspectVisitSupply: (zoneId, visitId, signal) => this.minecraft.inspectVisitSupply(zoneId, visitId, signal),
        supplyOnVisit: (zoneId, recipe, visitId, signal) => this.minecraft.supplyOnVisit(zoneId, recipe, visitId, signal),
        inspectVisitBuild: (zoneId, visitId, signal) => this.minecraft.inspectVisitBuild(zoneId, visitId, signal),
        buildOnVisit: (zoneId, material, visitId, signal) => this.minecraft.buildOnVisit(zoneId, material, visitId, signal),
        revisitOnVisit: (zoneId, material, visitId, signal) => this.minecraft.revisitOnVisit(zoneId, material, visitId, signal),
        patrolSegment: (zoneId, direction, steps, index, visitId, signal) =>
          this.minecraft.patrolSegment(zoneId, direction, steps, index, visitId, signal),
        inspectVisitGather: (zoneId, visitId, signal) => this.minecraft.inspectVisitGather(zoneId, visitId, signal),
        gatherOnVisit: (zoneId, offer, visitId, signal) => this.minecraft.gatherOnVisit(zoneId, offer, visitId, signal),
        surveyCamp: (zoneId, direction, signal, steps, visitId) => this.minecraft.surveyCamp(zoneId, direction, signal, steps, visitId),
        surveyTrail: (zoneId, trail, signal, visitId) => this.minecraft.surveyTrail(zoneId, trail, signal, visitId),
        dailyHouseProjectReady: now => this.minecraft.worldHealth(now) === 'ready',
        inspectDailyHouseProject: (projectId, zoneId, signal, allowSupply) => this.minecraft.inspectDailyHouseProject(projectId, zoneId, signal, allowSupply),
        buildDailyHouseProjectSection: (projectId, zoneId, offer, signal, assertPermit, lease) =>
          this.minecraft.buildDailyHouseProjectSection(projectId, zoneId, offer, signal, assertPermit, lease),
        supplyDailyHouseProjectSection: (projectId, zoneId, offer, signal, assertPermit, lease) =>
          this.minecraft.supplyDailyHouseProjectSection(projectId, zoneId, offer, signal, assertPermit, lease),
      },
      input => this.publishPost(input),
      this.bilibili,
      (input, receipt, assertReady) => this.publishSurveyPost(input, receipt, assertReady),
      (ignoreRecoveryPlacement, ownHouseTaskId) => {
        const activity = this.homeActivity(ignoreRecoveryPlacement, ownHouseTaskId)
        return activity !== 'idle' && activity !== 'resting' && activity !== 'offline'
      },
    )
    this.idleCompaction = new IdleCompactionService(store, id => this.ctx.agents.get(SessionId(id)),
      (contextId, sessionId, seq) => this.autonomy.memoryReviewed(contextId, sessionId, seq))
    this.worlds = createWorldConnectors(ctx, this)
  }

  private readonly toolNames = new Map<string, string>()

  attachEvents(events: EventHub): void {
    this.events.push(events)
  }

  start(): void {
    for (const hub of this.events) hub.start()
    this.ctx.on('session/event', (session, event) => {
      this.idleCompaction.observe(session.id, event)
      const binding = this.store.bindingBySession(session.id)
      if (!binding) {
        this.clearVoiceReply(session.id)
        return
      }
      for (const hub of this.events) hub.assistantMessage(session.id, event)
      this.observeVoiceReply(session, binding, event)
      const activity = this.activityFromSessionEvent(session.id, binding.contextId, event)
      if (activity) this.store.recordActivity(activity)
      this.realtimeVoice.observe(binding, event)
      this.autonomy.observe(binding, event)
    })
    this.ctx.on('agent/assistant-stream', payload => {
      for (const hub of this.events) hub.assistantStream(payload)
      this.observeVoiceStream(payload.agent, payload.frame)
    })
    this.ctx.on('session/disposed', session => {
      this.idleCompaction.cancel(session.id)
      const binding = this.store.bindingBySession(session.id)
      this.clearVoiceReply(session.id, binding?.contextId)
      if (!binding) return
      this.store.recordActivity({ contextId: binding.contextId, sessionId: session.id, source: 'core.workbench', kind: 'session.offline', summary: `场景 ${binding.label} 的会话已离开运行时`, status: 'warning' })
    })
    registerMemoryRecall(this.ctx, this.store)
    this.tts.start()
    this.media.start()
    this.avatar.start()
    this.realtimeVoice.start()
    this.worlds.start()
    this.autonomy.start()
    this.idleCompaction.start()
    this.store.recordActivity({ source: 'core.workbench', kind: 'workbench.started', summary: 'Companion 工作台已启动', status: 'success' })
  }

  private observeVoiceReply(session: Session, binding: SessionBinding, event: SessionEvent): void {
    if (this.voiceStopped) return
    const state = this.voiceTurns.get(session.id)
    if (state?.session === session && event.seq <= state.seq) return
    if (event.type === 'turn/start') {
      if (state) this.cancelVoicePrefix(state)
      this.voiceTurns.set(session.id, { session, contextId: binding.contextId, turn: event.data.turn, seq: event.seq, hasDirectInput: false })
      return
    }
    if (!state || state.session !== session || state.contextId !== binding.contextId) return
    state.seq = event.seq
    if (event.surfaceOp && event.surfaceOp !== 'append' || event.type === 'assistant/attempt' || event.type === 'tool/call' || event.type === 'tool/result') this.cancelVoicePrefix(state)
    if (event.type === 'step/start' && event.data.turn === state.turn) {
      if (state.step !== undefined) this.cancelVoicePrefix(state)
      state.step = event.data.step
    } else if (event.type === 'user/message') {
      if (state.attempt) this.cancelVoicePrefix(state)
      const source = event.data.source
      if (source.kind !== 'companion-mobile' && source.kind !== 'user') return
      state.userMessageId = !state.hasDirectInput && source.kind === 'companion-mobile' && source.form === 'relay' ? String(event.data.id) : undefined
      state.noticeInput = !!state.userMessageId && event.surfaceOp === 'append'
      state.voiceReply = !state.prefixBlocked && state.userMessageId && source.kind === 'companion-mobile'
        && source.voiceReply === true && event.surfaceOp === 'append' ? true : undefined
      state.hasDirectInput = true
    } else if (event.type === 'assistant/message' && event.data.turn === state.turn) {
      clearTimeout(state.prefixTimer)
      const { message, interrupted } = event.data
      state.assistantMessageId = !interrupted && !message.content.some(block => block.type === 'tool-call')
        && message.content.some(block => block.type === 'text' && block.text.trim()) ? String(message.id) : undefined
      state.noticeReply = !!state.assistantMessageId && event.surfaceOp === 'append'
      if (state.attempt) {
        const finalText = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (!state.assistantMessageId || state.step !== event.data.step || !state.attempt.matchFinal(finalText, event.seq)) this.cancelVoicePrefix(state)
      }
    } else if (event.type === 'turn/end' && event.data.turn === state.turn) {
      clearTimeout(state.prefixTimer)
      this.voiceTurns.delete(session.id)
      if (event.data.reason.kind !== 'completed' || !state.userMessageId || !state.assistantMessageId) {
        this.cancelVoicePrefix(state)
        return
      }
      const ready: VoiceReplyReadyEvent = {
        eventId: `voice-reply:${session.id}:${event.seq}`, schemaVersion: 1, type: 'voice.reply.ready',
        occurredAt: new Date(event.time).toISOString(), contextId: binding.contextId, sessionId: session.id, cursor: null,
        payload: { userMessageId: state.userMessageId, assistantMessageId: state.assistantMessageId },
      }
      const deliver = this.events.map(hub => hub.captureVoiceReply(ready)).filter(delivery => delivery !== undefined)
      const notify = binding.contextId === 'chat.mobile' && state.noticeInput === true && state.noticeReply === true
      if (!deliver.length || !state.attempt?.settled) this.cancelVoicePrefix(state)
      if (deliver.length || notify) this.flushVoiceReply(session, ready, deliver, notify, state.attempt?.key)
    }
  }

  private observeVoiceStream(agent: Agent, frame: AssistantStreamFrame): void {
    const state = this.voiceTurns.get(agent.id)
    if (!this.voicePrefixes || !state?.voiceReply || state.session !== agent.session) return
    if (frame.type === 'start') {
      if (state.attempt || state.turn !== frame.turn || state.step !== frame.step) this.cancelVoicePrefix(state)
      else state.attempt = new VoicePrefixAttempt(frame)
      return
    }
    const attempt = state.attempt
    const previous = attempt?.prefix
    if (!attempt?.observe(frame)) this.cancelVoicePrefix(state)
    else if (!previous && attempt.prefix) {
      const prefix = attempt.prefix
      state.prefixTimer = setTimeout(() => {
        state.prefixTimer = undefined
        this.voicePrefixes?.begin(attempt.key, prefix)
      }, VOICE_PREFIX_GRACE_MS).unref()
    }
  }

  private cancelVoicePrefix(state: VoiceReplyTurn): void {
    clearTimeout(state.prefixTimer)
    state.prefixTimer = undefined
    if (state.attempt?.prefix) this.voicePrefixes?.cancel(state.attempt.key)
    state.attempt = undefined
    state.voiceReply = undefined
    state.prefixBlocked = true
  }

  private flushVoiceReply(session: Session, ready: VoiceReplyReadyEvent, deliver: (() => void)[], notify: boolean, attemptKey?: string): void {
    const pending = this.voiceDeliveries.get(session.id) ?? new Set<AbortController>()
    if (pending.size >= MAX_PENDING_VOICE_REPLIES) {
      if (attemptKey) this.voicePrefixes?.cancel(attemptKey)
      return
    }
    const delivery = new AbortController()
    pending.add(delivery)
    this.voiceDeliveries.set(session.id, pending)
    const { signal } = delivery
    let confirmed = false
    // Let the synchronous session/event fanout enqueue the final turn event before flushing its writer.
    void Promise.resolve().then(async () => {
      if (signal.aborted) return
      const durable = await Promise.race([
        this.ctx.sessions.flush(session),
        delay(VOICE_REPLY_CHECKPOINT_MS, false, { signal, ref: false }),
      ])
      if (!durable || signal.aborted) return
      if (this.store.bindingByContext(ready.contextId)?.sessionId !== session.id) return
      if (notify) {
        try { this.store.notices.add({ kind: 'chat-reply' }, `chat:${ready.eventId}`) }
        catch { /* A notification failure must not delay a live chat or voice reply. */ }
      }
      if (attemptKey) {
        this.voicePrefixes?.confirm(attemptKey, ready.contextId, ready.payload.assistantMessageId)
        confirmed = true
      }
      for (const send of deliver) send()
    }).catch(() => {
      // A failed durability checkpoint leaves this optional announcement unready.
    }).finally(() => {
      delivery.abort()
      if (attemptKey && !confirmed) this.voicePrefixes?.cancel(attemptKey)
      pending.delete(delivery)
      if (!pending.size && this.voiceDeliveries.get(session.id) === pending) this.voiceDeliveries.delete(session.id)
    })
  }

  private clearVoiceReply(sessionId: string, contextId?: string): void {
    const active = this.voiceTurns.get(sessionId)
    if (active) this.cancelVoicePrefix(active)
    this.voiceTurns.delete(sessionId)
    for (const delivery of this.voiceDeliveries.get(sessionId) ?? []) delivery.abort()
    this.voiceDeliveries.delete(sessionId)
    if (contextId) this.voicePrefixes?.clearContext(contextId)
  }

  private activityFromSessionEvent(sessionId: string, contextId: string, event: SessionEvent): ActivityInput | undefined {
    const base = {
      eventId: `${sessionId}:${event.seq}`,
      contextId,
      sessionId,
      source: 'core.session',
      occurredAt: new Date(event.time).toISOString(),
      data: { seq: event.seq },
    }
    switch (event.type) {
      case 'turn/start':
        return { ...base, kind: 'turn.started', summary: `第 ${event.data.turn} 轮开始`, data: { ...base.data, turn: event.data.turn } }
      case 'turn/end': {
        const reason = event.data.reason
        const status = reason.kind === 'completed' ? 'success' : reason.kind === 'aborted' || reason.kind === 'interrupted' ? 'warning' : reason.kind === 'error' ? 'error' : 'info'
        const data: Record<string, JsonValue> = { ...base.data, turn: event.data.turn, reason: reason.kind }
        if (reason.kind === 'error') data.errorCode = reason.error.code
        return { ...base, kind: `turn.${reason.kind}`, summary: `第 ${event.data.turn} 轮结束：${reason.kind}`, status, data }
      }
      case 'tool/call': {
        this.toolNames.set(`${sessionId}:${event.data.callId}`, event.data.name)
        return {
          ...base,
          kind: 'tool.called',
          summary: `调用工具 ${event.data.name}`,
          data: { ...base.data, turn: event.data.turn, step: event.data.step, callId: event.data.callId, toolName: event.data.name },
        }
      }
      case 'tool/result': {
        const key = `${sessionId}:${event.data.message.toolCallId}`
        const toolName = this.toolNames.get(key)
        this.toolNames.delete(key)
        const failed = event.data.message.isError === true
        return {
          ...base,
          kind: failed ? 'tool.failed' : 'tool.completed',
          summary: `${toolName ?? '工具'}${failed ? '调用失败' : '调用完成'}`,
          status: failed ? 'error' : 'success',
          data: {
            ...base.data,
            turn: event.data.turn,
            step: event.data.step,
            callId: event.data.message.toolCallId,
            toolName: toolName ?? null,
            errorCode: event.data.error?.code ?? null,
          },
        }
      }
      case 'assistant/message':
        return {
          ...base,
          kind: 'assistant.completed',
          summary: event.data.interrupted ? '助手回复已中断' : '助手回复已完成',
          status: event.data.interrupted ? 'warning' : 'success',
          data: {
            ...base.data,
            turn: event.data.turn,
            step: event.data.step,
            interrupted: event.data.interrupted === true,
            usageReported: event.data.usage !== undefined,
            inputTokens: event.data.usage?.inputTokens ?? 0,
            outputTokens: event.data.usage?.outputTokens ?? 0,
            totalTokens: event.data.usage?.totalTokens ?? null,
            cacheReadTokens: event.data.usage?.cacheReadTokens ?? null,
            cacheWriteTokens: event.data.usage?.cacheWriteTokens ?? null,
            reasoningTokens: event.data.usage?.reasoningTokens ?? null,
          },
        }
      default:
        return undefined
    }
  }

  presence(): Presence {
    return this.boundSessions(this.store.bindings()).presence
  }

  private boundSessions(bindings: SessionBinding[]): { presence: Presence; runningSessions: Set<string> } {
    const runningSessions = new Set<string>()
    let hasAgent = false
    for (const binding of bindings) {
      const agent = this.ctx.agents.get(SessionId(binding.sessionId))
      if (agent) hasAgent = true
      if (agent?.status === 'running') runningSessions.add(binding.sessionId)
    }
    const presence = runningSessions.size ? 'running' : hasAgent ? 'idle' : bindings.length ? 'offline' : 'unconfigured'
    return { presence, runningSessions }
  }

  bindContext(input: BindContextInput): void {
    const world = worldForContext(input.contextId)
    if (world && world.kind !== input.kind) throw new DeviceAuthError(409, 'world-session-kind')
    if (!this.ctx.agents.get(SessionId(input.sessionId))) throw new Error('Session is not live in this DSH profile')
    const duplicate = this.store.bindingBySession(input.sessionId)
    if (duplicate && duplicate.contextId !== input.contextId) throw new Error(`Session is already bound to context ${duplicate.contextId}`)
    const previous = this.store.bindingByContext(input.contextId)
    this.store.bindContext(input)
    if (previous && previous.sessionId !== input.sessionId) {
      this.clearVoiceReply(previous.sessionId, input.contextId)
      this.idleCompaction.cancel(previous.sessionId)
    }
    this.store.recordActivity({
      contextId: input.contextId,
      sessionId: input.sessionId,
      source: 'core.workbench',
      kind: 'session.bound',
      summary: `场景 ${input.label} 绑定会话 ${input.sessionId}`,
      status: 'success',
      data: { previousSessionId: previous?.sessionId ?? null, kind: input.kind },
    })
  }

  async bind(sessionId: string | null): Promise<void> {
    if (sessionId) this.bindContext({ contextId: 'chat.main', sessionId, kind: 'chat', label: '主聊天' })
    else await this.unbindContext('chat.main')
  }

  async unbindContext(contextId: string): Promise<void> {
    const previous = this.store.bindingByContext(contextId)
    if (!previous) throw new Error('Context binding not found')
    this.idleCompaction.cancel(previous.sessionId)
    this.store.unbindContext(contextId)
    this.clearVoiceReply(previous.sessionId, contextId)
    this.store.recordActivity({
      contextId,
      sessionId: previous.sessionId,
      source: 'core.workbench',
      kind: 'session.unbound',
      summary: `场景 ${previous.label} 解除会话绑定`,
      data: { previousSessionId: previous.sessionId },
    })
    await this.sessions.release(previous.sessionId)
  }

  updateCapability(id: string, status: 'ready' | 'planned' | 'unavailable' | 'error', detail: string): void {
    if (!this.store.capabilities().some(capability => capability.id === id)) throw new Error('Capability not found')
    this.store.updateCapability(id, status, detail)
    this.store.recordActivity({ source: id, kind: 'capability.status', summary: detail, status: status === 'error' ? 'error' : status === 'ready' ? 'success' : 'info' })
  }

  publishPost(input: FeedCreateInput): FeedPost {
    return this.announcePost(this.store.transaction(() => this.persistPost(input)))
  }

  async publishDevicePost(input: DeviceFeedPublishInput, deviceId: string, assertCurrent: () => void): Promise<{ post: FeedPost; created: boolean }> {
    const { body, contextId, parentId } = input
    const id = deviceFeedPostId(deviceId, input.requestId.toLowerCase())
    assertCurrent()
    const image = input.image && prepareDeviceImage(input.image)
    const reconcile = () => {
      assertCurrent()
      const post = this.store.feed.byId(id)
      if (!post) return
      const asset = image && post.mediaId ? this.store.media.get(post.mediaId) : undefined
      const matchingImage = image ? asset && DEVICE_FEED_IMAGE_PATH.test(asset.path) &&
        asset.hash === image.hash && asset.mimeType === image.mime && asset.bytes === image.bytes.length : post.mediaId === undefined
      if (post.author !== 'user' || post.body !== body || post.contextId !== contextId || post.parentId !== parentId || !matchingImage) {
        throw new DeviceAuthError(409, 'feed-request-conflict')
      }
      if (post.deletedAt || parentId && this.store.feed.byId(parentId)?.deletedAt) throw new DeviceAuthError(410, 'feed-request-gone')
      return { post, created: false }
    }
    const previous = reconcile()
    if (previous) return previous
    const persist = (mediaId?: string) => ({ post: this.persistPost({ author: 'user', body, contextId, parentId, mediaId }, id), created: true })
    const result = image
      ? await this.deviceMedia.attachDevicePostImage(image, id, reconcile, persist)
      : this.store.transaction(() => reconcile() ?? persist())
    if (result.created) this.announcePost(result.post)
    return result
  }

  async changeSongShare(input: {
    operation: 'share' | 'withdraw'; selector: string; sessionId: string; caption?: string;
    signal: AbortSignal; assertCurrent: () => void;
  }): Promise<{ status: 'shared' | 'already-shared' | 'withdrawn'; postId: string; title: string }> {
    const { operation, selector, sessionId, signal, assertCurrent } = input
    assertCurrent()
    const matches = z.uuid().safeParse(selector).success ? [selector] : this.store.feed.completedSongIdsByTitle(sessionId, selector)
    if (matches.length > 1) throw new DeviceAuthError(409, 'singing-share-title-ambiguous')
    const selected = matches[0]
    const task = selected && this.singing.sessionTask(sessionId, selected)?.task
    if (!task || task.status !== 'succeeded') throw new DeviceAuthError(404, 'singing-share-not-found')
    const { id, title } = task
    if (operation === 'withdraw') {
      const post = this.store.feed.bySongTask(id)
      if (!post) throw new DeviceAuthError(404, 'singing-share-not-found')
      if (!post.deletedAt) this.deletePost(post.id, 'companion')
      return { status: 'withdrawn', postId: post.id, title }
    }
    const body = input.caption?.trim() ?? ''
    if (!body || body.length > 280 || /[\p{Cc}\p{Cf}]/u.test(body)) throw new DeviceAuthError(400, 'singing-share-invalid-caption')
    const existing = () => {
      const post = this.store.feed.bySongTask(id)
      if (post?.deletedAt) throw new DeviceAuthError(409, 'singing-share-withdrawn')
      return post
    }
    const previous = existing()
    if (previous) return { status: 'already-shared', postId: previous.id, title }
    await this.singing.audio(id, signal)
    assertCurrent()
    const accepted = existing()
    if (accepted) return { status: 'already-shared', postId: accepted.id, title }
    const post = this.publishPost({ author: 'companion', contextId: SINGING_CONTEXT, sourceSessionId: sessionId, body, songTaskId: id })
    return { status: 'shared', postId: post.id, title }
  }

  private async publishSurveyPost(
    input: FeedCreateInput,
    receipt: Extract<CommunityCampReceipt, { kind: 'survey' }>,
    assertReady: () => void,
  ): Promise<FeedPost> {
    if (!input.sourceTaskId) throw new Error('Survey image requires a source task')
    assertReady()
    const post = await this.deviceMedia.attachGeneratedSurveyCard(
      renderSurveyCard(receipt), input.sourceTaskId, assertReady,
      mediaId => this.persistPost({ ...input, mediaId }),
    )
    return this.announcePost(post)
  }

  private persistPost(input: FeedCreateInput, id?: string): FeedPost {
    // The reserved Bilibili feed accepts the current subtitle or clip session, as checked by the repository.
    if (input.contextId && input.contextId !== BILIBILI_SHARE_CONTEXT && !this.store.bindingByContext(input.contextId)) throw new Error('Context binding not found')
    const post = this.store.feed.create(input, id)
    if (post.author === 'companion') {
      this.store.notices.add(post.parentId ? { kind: 'feed-reply', postId: post.parentId, replyId: post.id }
        : { kind: 'feed-post', postId: post.id }, `feed:${post.id}`)
    }
    this.store.recordActivity({
      contextId: post.contextId,
      sessionId: input.sourceSessionId,
      taskId: post.sourceTaskId ?? input.songTaskId,
      source: 'core.feed',
      kind: post.parentId ? 'post.replied' : 'post.created',
      summary: post.parentId ? '回复了一条动态' : '发布了一条动态',
      status: 'success',
      data: { postId: post.id, parentId: post.parentId ?? null, author: post.author, ...(post.mediaId && { mediaId: post.mediaId }),
        ...(input.songTaskId && { songTaskId: input.songTaskId }) },
    })
    return post
  }

  private announcePost(post: FeedPost): FeedPost {
    for (const hub of this.events) hub.postChanged('post.created', post)
    this.autonomy.observePost(post)
    return post
  }

  deletePost(id: string, author: FeedAuthor): FeedPost {
    const post = this.store.feed.delete(id, author)
    this.store.recordActivity({
      contextId: post.contextId,
      sessionId: post.sourceSessionId,
      source: 'core.feed',
      kind: 'post.deleted',
      summary: '删除了一条动态',
      status: 'success',
      data: { postId: post.id, parentId: post.parentId ?? null, author: post.author },
    })
    for (const hub of this.events) hub.postChanged('post.deleted', post)
    return post
  }

  memoryView(status: MemoryStatus | 'all' = 'all', query?: string): MemoryView {
    const items = query ? this.store.memory.find(query, { status, limit: 20 }) : this.store.memory.list({ status, limit: 200 })
    return { items, counts: this.store.memory.counts() }
  }

  async audio(taskId: string): ReturnType<TtsService['audio']> {
    const asset = await this.tts.audio(taskId)
    await this.media.touch(asset.filePath)
    return asset
  }

  streamDeviceVoice(contextId: string, messageId: string, signal: AbortSignal): RealtimePcmStream {
    const provider = this.realtimePcm
    if (!provider) throw new DeviceAuthError(404, 'voice-stream-unavailable')
    let source: RealtimePcmStream['source']
    const stream = provider.stream(async readSignal => {
      const text = await this.sessions.persistedAssistantText(contextId, messageId, readSignal)
      readSignal.throwIfAborted()
      const cached = this.voicePrefixes?.take(contextId, messageId, text)
      if (!cached) {
        source = 'full'
        return text.trim()
      }
      source = Buffer.isBuffer(cached.pcm) ? 'prefetch-complete' : 'prefetch-live'
      const suffix = text.slice(cached.prefix.length)
      return { text: suffix.trim() ? suffix : '', prefixPcm: cached.pcm }
    }, signal)
    return { ...stream, get source() { return source } }
  }

  toolPolicy(contextId: string): ReturnType<typeof companionToolPolicy> {
    const binding = this.store.bindingByContext(contextId)
    if (!binding) throw new Error('Context binding not found')
    return companionToolPolicy(binding.contextId, binding.kind, this.minecraft.wardrobeConfigured,
      this.autonomy.recoveryPlacementToolsActive(binding.sessionId), this.autonomy.recoveryCompletionToolsActive(binding.sessionId),
      this.autonomy.dailyInitiativeToolsActive(binding.sessionId))
  }

  private homeObservation(now: Date, bindings: SessionBinding[], options: {
    playback?: { speaking: boolean; singing: boolean }; reflectionAt?: string; ignoreRecoveryPlacement?: boolean; ignoreHouseProjectTaskId?: string
  } = {}): HomeActivityInput {
    const { presence, runningSessions } = this.boundSessions(bindings)
    const timestamp = now.getTime()
    const minecraft = this.minecraft.homeActive(timestamp, options.ignoreRecoveryPlacement, options.ignoreHouseProjectTaskId)
    const device = this.devicePlayback.activity(timestamp)
    return {
      presence, bindings, runningSessions, minecraft,
      speaking: !minecraft && (device.speaking || (options.playback?.speaking ?? this.realtimeVoice.homeSpeaking(timestamp))),
      singing: !minecraft && (device.singing || (options.playback?.singing ?? this.realtimeVoice.homeSinging(timestamp))),
      browsing: this.bilibili.homeActive() || this.autonomy.homeClipActive(), quiet: this.autonomy.isQuietTime(now),
      reflectionAt: options.reflectionAt,
    }
  }

  homeActivity(ignoreRecoveryPlacement = false, ignoreHouseProjectTaskId?: string): ReturnType<typeof selectHomeActivity> {
    return selectHomeActivity(this.homeObservation(new Date(), this.store.bindings(), { ignoreRecoveryPlacement, ignoreHouseProjectTaskId }))
  }

  homeLive(): HomeLiveView {
    const now = new Date()
    const status = projectHomeStatus({ ...this.homeObservation(now, this.store.bindings(), { reflectionAt: this.autonomy.homeReflection() }), now })
    return { ...status, activeSite: communitySiteFor(status.activity) }
  }

  view(options: { management?: boolean } = {}): WorkbenchView {
    const now = new Date()
    const bindings = this.store.bindings()
    const observation = this.homeObservation(now, bindings, { reflectionAt: this.autonomy.homeReflection() })
    const activities = this.store.activities()
    const journalRevisionAt = this.store.latestHomeJournalRevision(new Date(now.getTime() - HOME_JOURNAL_REVISION_MS).toISOString(), now.toISOString())
    const home = projectHome({ ...observation, now, activities, journalRevisionAt })
    const community = projectCommunity(home.activity, this.store)
    const campProject = this.autonomy.campProjectSummary(now.getTime())
    const scoreAvailable = this.singing.scoreAvailable
    const sourceCoverAvailable = this.singing.sourceCoverAvailable
    const attachments = (scoreAvailable || sourceCoverAvailable) && this.sessions.chatAttachmentsAvailable
    const midiAvailable = scoreAvailable && attachments
    const wavAvailable = sourceCoverAvailable && attachments
    const singingTopic = bindings.some(binding => binding.contextId === SINGING_CONTEXT && binding.kind === 'topic')
    const expressiveTts = this.tts.expressiveCapability()
    return {
      schemaVersion: 2,
      pluginVersion: this.pluginVersion,
      generatedAt: now.toISOString(),
      persona: this.store.persona(),
      presence: observation.presence,
      sessionId: this.store.binding(),
      bindings,
      sessions: this.ctx.agents.roots().map(agent => ({ id: agent.id, status: agent.status })),
      stats: this.store.stats(),
      memory: this.store.memory.counts(),
      capabilities: this.store.capabilities(),
      activities,
      tasks: this.store.tasks(),
      autonomy: this.autonomy.view(),
      worlds: this.worlds.view(),
      ...(expressiveTts && { expressiveTts }),
      minecraftCamp: { version: 1 },
      bilibiliConversation: { version: 1, contextId: BILIBILI_CONTEXT, maxClipSeconds: MAX_BILIBILI_CLIP_SECONDS },
      ...(options.management && { bilibiliQueue: this.store.bilibili.view(), bilibiliSubtitles: this.store.bilibiliSubtitles.view(), singing: this.singing.view() }),
      ...((scoreAvailable || wavAvailable || singingTopic) && {
        singingConversation: {
          contextId: SINGING_CONTEXT,
          maxTotalBytes: MAX_CHAT_ATTACHMENT_BYTES,
          shareAvailable: true as const,
          ...(midiAvailable && { midiMaxBytes: MAX_SINGING_MIDI_BYTES }),
          ...(!wavAvailable && { wavAvailable: false as const }),
          ...(this.singing.scoreAvailable && { scoreMaxSeconds: MAX_SINGING_SCORE_SECONDS }),
        },
      }),
      home, homeLive: { version: 1 },
      community: { ...community, ...(campProject && { campProject }) },
    }
  }

  health(): HealthView {
    const stats = this.store.stats()
    return {
      ok: true,
      schemaVersion: 2,
      pluginVersion: this.pluginVersion,
      presence: this.presence(),
      sessionId: this.store.binding(),
      bindings: this.store.bindings().length,
      activities: stats.activities,
      runningTasks: stats.runningTasks,
    }
  }

  async close(): Promise<void> {
    this.voiceStopped = true
    this.qwenWatch.close()
    this.worlds.beginStop()
    this.devicePlayback.close()
    await this.presenter.stop()
    for (const turn of this.voiceTurns.values()) this.cancelVoicePrefix(turn)
    this.voicePrefixes?.close()
    this.voiceTurns.clear()
    for (const sessionId of this.voiceDeliveries.keys()) this.clearVoiceReply(sessionId)
    this.asr?.close()
    this.realtimePcm?.close()
    for (const hub of this.events) hub.close()
    this.store.recordActivity({ source: 'core.workbench', kind: 'workbench.stopped', summary: 'Companion 工作台已停止' })
    this.toolNames.clear()
    await this.idleCompaction.close()
    await this.autonomy.close()
    await this.worlds.close()
    await this.realtimeVoice.close()
    await this.tts.close()
    await this.media.close()
    await this.avatar.close()
    await this.sessions.close()
    this.store.close()
  }
}
