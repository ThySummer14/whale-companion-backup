import type { JsonValue } from '../core/model.ts'
import type { CommunitySite, HomeView } from './api.ts'

export type CompanionEventType = 'stream.ready' | 'stream.replay.complete' | 'activity' | 'message.delta' | 'message.completed' | 'message.failed' | 'voice.reply.ready' | 'home.live' | 'ping' | 'post.created' | 'post.deleted'

export type HomeLiveView = Omit<HomeView, 'recent'> & { activeSite: CommunitySite | null }

export interface CompanionEvent {
  eventId: string
  schemaVersion: 1
  type: CompanionEventType
  occurredAt: string
  contextId?: string
  sessionId?: string
  cursor: string | null
  payload: Record<string, JsonValue>
}

export interface VoiceReplyReadyEvent extends CompanionEvent {
  type: 'voice.reply.ready'
  contextId: string
  sessionId: string
  cursor: null
  payload: { userMessageId: string; assistantMessageId: string }
}
