import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, isAppendSurfaceEvent, SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { CompanionStore } from '../core/store.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT, MINECRAFT_SHARE_CONTEXT } from '../core/model.ts'
import type { BindContextInput } from '../protocol/api.ts'
import { isCompanionDecisionContext, restrictCompanionTools } from './tool-policy.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'
import type { ChatHistoryMessage, ChatHistoryView, CreateSessionInput, SendMessageReceipt, SessionLifecycleView } from '../protocol/chat.ts'
import { admitChatAttachments, describeChatAttachment, isChatAttachment, readChatAttachment, type ChatAttachmentInput } from './chat-attachments.ts'
import { DeviceAuthError } from './devices.ts'
import { worldForContext } from './world-manifest.ts'

const VOICE_HISTORY_EVENTS = 4096
const VOICE_HISTORY_BYTES = 16 * 1024 * 1024
const CHAT_HISTORY_EVENT_BATCH = 256

interface DeviceChatSubmission {
  items?: readonly ChatAttachmentInput[]
  requestKey?: string
  expectedSessionId?: string
  assertAuthorized: () => void
}

function mobileRequestKey(message: Message): string | undefined {
  return message.role === 'user' && message.source.kind === 'companion-mobile'
    ? message.source.attachmentRequestKey?.toLowerCase() : undefined
}

function mobileRequestHash(text: string, voiceReply: boolean, items: readonly ChatAttachmentInput[] | undefined): string {
  const hash = createHash('sha256').update(JSON.stringify([text, voiceReply]))
  for (const { name, dataBase64 } of items ?? []) {
    hash.update(JSON.stringify([name, dataBase64.length])).update(dataBase64)
  }
  return hash.digest('hex')
}

function isVisibleChatMessage(message: Message): message is Extract<Message, { role: 'assistant' | 'user' }> {
  return message.role === 'assistant' || message.role === 'user' &&
    (message.source.kind === 'user' || message.source.kind === 'companion-mobile' || message.source.kind === 'companion-world')
}

function attachmentMetadata(message: Message) {
  const attachments = message.content.filter(isChatAttachment).map(describeChatAttachment)
  return attachments.length ? { attachments } : {}
}

function* originalChatMessages(session: Session, end = Number(session.seq), start = 0, settledAssistantOnly = false) {
  // Model-surface replacements hide older nodes from the model. The original
  // append events still own the human transcript and its attachment references.
  for (let cursor = end; cursor > start;) {
    const offset = Math.max(start, cursor - CHAT_HISTORY_EVENT_BATCH)
    const events = session.snapshotEvents(SessionLogOffset(offset), SessionLogOffset(cursor))
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!
      if (event.type !== 'user/message' && event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
      if (settledAssistantOnly && event.type === 'assistant/message' &&
        (event.data.interrupted || event.data.message.content.some(block => block.type === 'tool-call'))) continue
      const message = deriveEventMessage(event)
      if (message && isVisibleChatMessage(message)) yield message
    }
    cursor = offset
  }
}

function historyMessages(session: Session, limit: number, end?: number, start?: number, settledAssistantOnly = false): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = []
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50
  for (const message of originalChatMessages(session, end, start, settledAssistantOnly)) {
    messages.push({
      id: String(message.id), role: message.role,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      ...attachmentMetadata(message),
    })
    if (messages.length >= count) break
  }
  return messages.reverse()
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'companion-mobile': {
      kind: 'companion-mobile'
      form: 'relay'
      voiceReply?: true
      attachmentRequestKey?: string
      deviceRequestHash?: string
    }
    'companion-world': { kind: 'companion-world'; form: 'minecraft-event' }
  }
}

export class SessionService {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly mobileRequests = new WeakMap<Session, { through: number; messages: Map<string, UserMessage> }>()

  constructor(
    private readonly ctx: Context,
    private readonly store: CompanionStore,
    private readonly bindContext: (input: BindContextInput) => void,
  ) {}

  private async resume(sessionId: string, policy?: { contextId: string; kind: CreateSessionInput['kind'] }): Promise<Agent> {
    const existing = this.ctx.agents.get(SessionId(sessionId))
    if (existing) return existing
    const binding = policy ?? this.store.bindingBySession(sessionId)
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.ctx.agentDefaultModel.currentSelection(),
      setup: agentCtx => { if (binding) restrictCompanionTools(agentCtx, binding.contextId, binding.kind) },
    })
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  async create(input: CreateSessionInput, replaceReview = false, assertAuthorized?: () => void, recoveryPlacement = false, recoveryCompletion = false, dailyInitiative = false): Promise<SessionLifecycleView> {
    const world = worldForContext(input.contextId)
    if (world && world.kind !== input.kind) throw new DeviceAuthError(409, 'world-session-kind')
    const current = this.store.bindingByContext(input.contextId)
    const legacyMinecraftReview = input.contextId === MINECRAFT_SHARE_CONTEXT && current?.kind === 'topic'
    const reactiveReply = isFeedReplyContext(input.contextId)
    if (reactiveReply && (!replaceReview || !assertAuthorized)) throw new DeviceAuthError(403, 'feed-reply-session-managed')
    if (input.contextId === MINECRAFT_RECOVERY_CONTEXT && (!replaceReview || !assertAuthorized)) {
      throw new DeviceAuthError(403, 'minecraft-house-recovery-managed')
    }
    if (input.contextId === BILIBILI_CLIP_CONTEXT && (!replaceReview || !assertAuthorized)) {
      throw new DeviceAuthError(403, 'bili-clip-session-managed')
    }
    if (dailyInitiative && (input.contextId !== DAILY_AUTONOMY_CONTEXT || !replaceReview || !assertAuthorized)) {
      throw new DeviceAuthError(403, 'daily-initiative-managed')
    }
    if (replaceReview && (!reactiveReply && !['memory.curator', BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SHARE_CONTEXT, MINECRAFT_RECOVERY_CONTEXT].includes(input.contextId) ||
      input.kind !== 'system' || input.resume || input.sessionId || current && current.kind !== 'system' && !(legacyMinecraftReview || reactiveReply && current.kind === 'topic'))) {
      throw new DeviceAuthError(409, 'curator-binding-conflict')
    }
    if (current && !input.resume && !replaceReview) throw new Error('Context already has a bound session; use resume to reopen it')
    if (input.resume && !input.sessionId) throw new Error('sessionId is required when resume is true')
    assertAuthorized?.()
    const sessionId = input.sessionId?.trim() || `session-${randomUUID()}`
    const duplicate = this.store.bindingBySession(sessionId)
    if (duplicate && duplicate.contextId !== input.contextId) throw new Error(`Session is already bound to context ${duplicate.contextId}`)
    if (input.resume) {
      await this.resume(sessionId, input)
    } else {
      if (this.ctx.agents.get(SessionId(sessionId))) throw new Error('Session is already live')
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: this.ctx.agentDefaultModel.currentSelection(),
        setup: agentCtx => { restrictCompanionTools(agentCtx, input.contextId, input.kind, recoveryPlacement, recoveryCompletion, dailyInitiative) },
      })
      try {
        assertAuthorized?.()
        if (replaceReview) {
          const latest = this.store.bindingByContext(input.contextId)
          if (latest?.sessionId !== current?.sessionId || latest?.updatedAt !== current?.updatedAt) {
            throw new DeviceAuthError(409, 'curator-binding-conflict')
          }
        }
      } catch (error) {
        await handle.dispose()
        throw error
      }
      this.handles.set(sessionId, handle)
    }
    const binding = { contextId: input.contextId, sessionId, kind: input.kind, label: input.label }
    try { this.bindContext(binding) } catch (error) {
      if (replaceReview) await this.release(sessionId).catch(() => {})
      throw error
    }
    const bound = this.store.bindingByContext(input.contextId)!
    this.store.recordActivity({
      contextId: input.contextId,
      sessionId,
      source: 'core.chat',
      kind: input.resume ? 'session.resumed' : 'session.created',
      summary: `${input.resume ? '恢复' : '创建'}场景 ${input.label} 的 Session`,
      status: 'success',
    })
    if (replaceReview && current) await this.release(current.sessionId).catch(() => {})
    return { binding: bound, resumed: input.resume === true }
  }

  get chatAttachmentsAvailable(): boolean {
    return !!this.ctx.get('attachments')
  }

  private biliClipAgent(sessionId: string): Agent {
    const binding = this.store.bindingByContext(BILIBILI_CLIP_CONTEXT)
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (binding?.sessionId !== sessionId || binding.kind !== 'system' || !agent ||
        agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
      throw new DeviceAuthError(409, 'bili-clip-session-changed')
    }
    return agent
  }

  async bilibiliClipVision(sessionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const agent = this.biliClipAgent(sessionId)
    const { provider, model } = agent.options
    if (!this.chatAttachmentsAvailable || !provider || !model) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
    signal.throwIfAborted()
    if (this.biliClipAgent(sessionId) !== agent) throw new DeviceAuthError(409, 'bili-clip-session-changed')
    return info?.inputModalities?.includes('image') === true
  }

  async sendBilibiliClip(sessionId: string, text: string, picture: Buffer | undefined, assertAuthorized: () => void): Promise<SendMessageReceipt> {
    const agent = this.biliClipAgent(sessionId)
    const check = () => {
      assertAuthorized()
      if (this.biliClipAgent(sessionId) !== agent) throw new DeviceAuthError(409, 'bili-clip-session-changed')
    }
    check()
    const content: UserMessage['content'][number][] = [{ type: 'text', text }]
    if (picture) {
      const storage = this.ctx.get('attachments')
      if (!storage) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
      const [attachment] = await storage.saveImages([{ name: 'bilibili-clip.jpg', data: picture, mediaType: 'image/jpeg' }])
      if (!attachment) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
      content.push({ type: 'image', attachment })
    }
    check()
    const titles = this.ctx.get?.('sessionTitle')
    if (titles && titles.get(agent.session)?.source.kind !== 'user') titles.rename(agent.session, 'B 站自主片段理解')
    const message = createUserMessage({ content, source: { kind: 'companion-bili-clip', form: 'autonomous' } })
    agent.followup(message)
    return { accepted: true, contextId: BILIBILI_CLIP_CONTEXT, sessionId, messageId: String(message.id), ...attachmentMetadata(message) }
  }

  private mobileRequest(agent: Agent, key: string): UserMessage | undefined {
    const matches = (message: Message): message is UserMessage => mobileRequestKey(message) === key
    const queued = agent.inbox.nextTurn.find(matches) ?? agent.inbox.nextStep.find(matches)
    if (queued) return queued
    const { session } = agent
    let indexed = this.mobileRequests.get(session)
    if (!indexed) {
      indexed = { through: Number(session.inheritedEventCount), messages: new Map() }
      this.mobileRequests.set(session, indexed)
    }
    const end = Number(session.seq)
    for (const message of originalChatMessages(session, end, indexed.through)) {
      const requestKey = mobileRequestKey(message)
      if (message.role === 'user' && requestKey && !indexed.messages.has(requestKey)) indexed.messages.set(requestKey, message)
    }
    indexed.through = end
    return indexed.messages.get(key)
  }

  async send(contextId: string, text: string, origin: 'user' | 'device' | 'world' = 'user', voiceReply = false,
    submission?: DeviceChatSubmission, assertAuthorized?: () => void): Promise<SendMessageReceipt> {
    if (contextId === BILIBILI_CLIP_CONTEXT) throw new DeviceAuthError(403, 'bili-clip-session-managed')
    const reactiveReply = isFeedReplyContext(contextId)
    if (reactiveReply && (!assertAuthorized || submission || origin !== 'user' || voiceReply)) {
      throw new DeviceAuthError(403, 'feed-reply-session-managed')
    }
    if (contextId === MINECRAFT_RECOVERY_CONTEXT && (!assertAuthorized || submission || origin !== 'user')) {
      throw new DeviceAuthError(403, 'minecraft-house-recovery-managed')
    }
    const binding = this.store.bindingByContext(contextId)
    submission?.assertAuthorized()
    if (submission?.expectedSessionId && binding?.sessionId !== submission.expectedSessionId) {
      throw new DeviceAuthError(409, 'chat-session-changed')
    }
    if (!binding) throw new Error('Context binding not found')
    const agent = await this.resume(binding.sessionId)
    if ((reactiveReply || ['memory.curator', BILIBILI_AUTONOMY_CONTEXT, BILIBILI_REFLECTION_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SHARE_CONTEXT, MINECRAFT_RECOVERY_CONTEXT].includes(contextId) ||
      contextId === DAILY_AUTONOMY_CONTEXT && assertAuthorized !== undefined) &&
      (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId || this.ctx.agents.get(agent.id) !== agent)) {
      throw new DeviceAuthError(409, 'curator-binding-conflict')
    }
    const receipt = (message: UserMessage, replayed = false): SendMessageReceipt => ({
      accepted: true, contextId, sessionId: binding.sessionId, messageId: String(message.id), ...attachmentMetadata(message),
      ...(replayed && submission?.expectedSessionId && { replayed: true }),
    })
    const content: UserMessage['content'][number][] = text ? [{ type: 'text', text }] : []
    const assertCurrent = () => {
      if (!submission) return
      submission.assertAuthorized()
      if (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId || this.ctx.agents.get(agent.id) !== agent) {
        throw new DeviceAuthError(409, submission.expectedSessionId ? 'chat-session-changed' : 'binding-conflict')
      }
    }
    assertCurrent()
    const requestKey = submission?.requestKey
    const items = submission?.items
    const requestHash = requestKey ? mobileRequestHash(text, voiceReply, items) : undefined
    const existing = () => {
      if (!requestKey) return undefined
      const message = this.mobileRequest(agent, requestKey)
      if (!message || message.source.kind !== 'companion-mobile') return undefined
      const previousHash = message.source.deviceRequestHash
      // Older releases only tagged attachment requests. Their original images may already be normalized.
      const conflict = previousHash ? previousHash !== requestHash :
        !items?.length || submission?.expectedSessionId !== undefined
      if (conflict) throw new DeviceAuthError(409, 'chat-request-conflict')
      return receipt(message, true)
    }
    const previous = existing()
    if (previous) return previous
    if (items?.length) {
      const storage = this.ctx.get('attachments')
      if (!storage) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
      content.push(...await admitChatAttachments(storage, items, assertCurrent))
      assertCurrent()
      const acceptedWhileUploading = existing()
      if (acceptedWhileUploading) return acceptedWhileUploading
    }
    const message = createUserMessage({
      content,
      source: origin === 'device' ? {
        kind: 'companion-mobile', form: 'relay', ...(voiceReply && { voiceReply: true as const }),
        ...(requestKey && { attachmentRequestKey: requestKey, deviceRequestHash: requestHash }),
      } : origin === 'world' ? { kind: 'companion-world', form: 'minecraft-event' } : { kind: 'user' },
    })
    assertAuthorized?.()
    const newBilibiliTopic = contextId === BILIBILI_CONTEXT && binding.kind === 'topic' && origin !== 'world' && !agent.session.surface.nodes.length
    const newMinecraftWorld = contextId === 'game.minecraft' && binding.kind === 'game' && origin === 'world' && !agent.session.surface?.nodes.length
    if (newBilibiliTopic || newMinecraftWorld || origin === 'user' && (binding.kind === 'system' && (contextId === 'memory.curator' || isCompanionDecisionContext(contextId)) ||
        binding.kind === 'topic' && contextId === 'autonomy.feed')) {
      // These sessions already have a meaningful host label. Pin it before the
      // first input so DSH never schedules a separate automatic title request.
      const titles = this.ctx.get?.('sessionTitle')
      if (titles && titles.get(agent.session)?.source.kind !== 'user') titles.rename(agent.session, binding.label)
    }
    agent.followup(message)
    // DSH can claim the inbox entry before it appends the original user event.
    if (requestKey) this.mobileRequests.get(agent.session)?.messages.set(requestKey, message)
    const messageId = String(message.id)
    this.store.recordActivity({
      contextId,
      sessionId: binding.sessionId,
      source: 'core.chat',
      kind: 'message.accepted',
      summary: '消息已接受到 Agent 队列',
      data: { messageId, chars: text.length },
    })
    return receipt(message)
  }

  async cancel(contextId: string): Promise<void> {
    const binding = this.store.bindingByContext(contextId)
    if (!binding) throw new Error('Context binding not found')
    const agent = await this.resume(binding.sessionId)
    agent.cancel({ kind: 'user' })
    this.store.recordActivity({ contextId, sessionId: binding.sessionId, source: 'core.chat', kind: 'message.cancel.requested', summary: '已请求取消当前轮次', status: 'warning' })
  }

  async history(contextId: string, limit = 50): Promise<ChatHistoryView> {
    const binding = this.store.bindingByContext(contextId)
    if (!binding) throw new Error('Context binding not found')
    const agent = await this.resume(binding.sessionId)
    if (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    return { contextId, sessionId: binding.sessionId, messages: historyMessages(agent.session, limit) }
  }

  async reviewSnapshot(contextId: string, sessionId: string, throughSeq?: number, limit = 6, afterSeq?: number): Promise<ChatHistoryView> {
    if (this.store.bindingByContext(contextId)?.sessionId !== sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    const { session } = await this.resume(sessionId)
    if (this.store.bindingByContext(contextId)?.sessionId !== sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    let start = Number(session.inheritedEventCount)
    let end = Number(session.seq)
    if (throughSeq !== undefined) {
      if (!Number.isSafeInteger(throughSeq) || throughSeq < start || throughSeq >= end) {
        throw new DeviceAuthError(409, 'review-source-turn-unavailable')
      }
      end = throughSeq + 1
      const [boundary] = session.snapshotEvents(SessionLogOffset(throughSeq), SessionLogOffset(end))
      if (boundary?.type !== 'turn/end' || boundary.data.reason.kind !== 'completed') {
        throw new DeviceAuthError(409, 'review-source-turn-unavailable')
      }
      if (afterSeq !== undefined && Number.isSafeInteger(afterSeq) && afterSeq >= start && afterSeq < throughSeq) {
        const [prior] = session.snapshotEvents(SessionLogOffset(afterSeq), SessionLogOffset(afterSeq + 1))
        if (prior?.type === 'turn/end' && prior.data.reason.kind === 'completed') start = afterSeq + 1
      }
    }
    return { contextId, sessionId, messages: historyMessages(session, limit, end, start, true) }
  }

  async chatAttachment(contextId: string, messageId: string, attachmentId: string, signal: AbortSignal) {
    const storage = this.ctx.get('attachments')
    if (!storage) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
    const binding = this.store.bindingByContext(contextId)
    if (!binding) throw new DeviceAuthError(404, 'chat-attachment-not-found')
    const agent = await this.resume(binding.sessionId)
    signal.throwIfAborted()
    const ownsMessage = (item: Message) => String(item.id) === messageId && isVisibleChatMessage(item)
    if (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    let message: Message | undefined = agent.inbox.nextTurn.find(ownsMessage) ?? agent.inbox.nextStep.find(ownsMessage)
    if (!message) {
      for (const original of originalChatMessages(agent.session)) {
        if (ownsMessage(original)) { message = original; break }
      }
    }
    const block = message?.content.filter(isChatAttachment).find(item => String(item.attachment.attachmentId) === attachmentId)
    if (!block) throw new DeviceAuthError(404, 'chat-attachment-not-found')
    const data = await readChatAttachment(storage, block, signal)
    signal.throwIfAborted()
    if (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    return { attachment: describeChatAttachment(block), data }
  }

  async houseReferenceAttachment(sourceSessionId: string, messageId: string, attachmentId: string, signal: AbortSignal) {
    const storage = this.ctx.get('attachments')
    if (!storage) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
    signal.throwIfAborted()
    const sessionId = SessionId(sourceSessionId)
    const ownerMessage = (message: Message) => message.role === 'user' && String(message.id) === messageId &&
      (message.source.kind === 'user' || message.source.kind === 'companion-mobile' && message.source.form === 'relay')
    let message: Message | undefined
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      for (const original of originalChatMessages(live.session)) {
        if (ownerMessage(original)) { message = original; break }
      }
    }
    if (!message) {
      // A workbench image read should not resume an agent or wake its background tasks.
      try {
        const handle = await this.ctx.sessionPersistence.open(sessionId, 'read', { signal })
        try {
          const { events } = await handle.read(undefined, undefined, { signal })
          const original = events.findLast(event => event.type === 'user/message' && isAppendSurfaceEvent(event) && ownerMessage(event.data))
          if (original?.type === 'user/message') message = original.data
        } finally { await handle.close() }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof SessionPersistenceNotFoundError) throw new DeviceAuthError(404, 'chat-attachment-not-found')
        throw new DeviceAuthError(503, 'chat-attachments-unavailable')
      }
    }
    const block = message?.content.find(item => item.type === 'image' && String(item.attachment.attachmentId) === attachmentId)
    if (block?.type !== 'image') throw new DeviceAuthError(404, 'chat-attachment-not-found')
    const data = await readChatAttachment(storage, block, signal)
    signal.throwIfAborted()
    return { attachment: describeChatAttachment(block), data }
  }

  async persistedAssistantText(contextId: string, messageId: string, signal: AbortSignal): Promise<string> {
    const binding = this.store.bindingByContext(contextId)
    if (!binding) throw new DeviceAuthError(404, 'assistant-message-not-found')
    const sessionId = SessionId(binding.sessionId)
    let text: string | undefined
    try {
      const persistence = this.ctx.sessionPersistence
      const snapshot = await persistence.stat(sessionId, { signal })
      if (!snapshot) throw new DeviceAuthError(404, 'assistant-message-not-found')
      if ((snapshot.sizeBytes ?? 0) > VOICE_HISTORY_BYTES) throw new DeviceAuthError(503, 'voice-stream-history-too-large')
      const handle = await persistence.open(sessionId, 'read', { signal })
      try {
        // The JSONL backend reports physical size and omits eventCount.
        const eventCount = snapshot.eventCount
        const offset = Math.max(0, (eventCount ?? 0) - VOICE_HISTORY_EVENTS)
        const { events } = await handle.read(offset, eventCount === undefined ? undefined : VOICE_HISTORY_EVENTS, { signal })
        const reply = events.findLast(event => event.type === 'assistant/message' && String(event.data.message.id) === messageId)
        if (reply?.type === 'assistant/message') {
          text = reply.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DeviceAuthError) throw error
      if (error instanceof SessionPersistenceNotFoundError) throw new DeviceAuthError(404, 'assistant-message-not-found')
      throw new DeviceAuthError(503, 'voice-stream-history-unavailable')
    }
    signal.throwIfAborted()
    if (this.store.bindingByContext(contextId)?.sessionId !== binding.sessionId) throw new DeviceAuthError(409, 'binding-conflict')
    if (!text?.trim()) throw new DeviceAuthError(404, 'assistant-message-not-found')
    if (text.trim().length > 240) throw new DeviceAuthError(422, 'message-too-long-for-stream')
    return text
  }

  async release(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) return
    this.handles.delete(sessionId)
    await handle.dispose()
  }

  async close(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}
