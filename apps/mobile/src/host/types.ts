export type ContextKind = 'chat' | 'game' | 'task' | 'topic' | 'system'
export type Presence = 'unconfigured' | 'offline' | 'idle' | 'running'

export interface SessionBinding {
  contextId: string
  sessionId: string
  kind: ContextKind
  label: string
  createdAt: string
  updatedAt: string
}

export interface Persona {
  name: string
  tagline: string
  description: string
  updatedAt: string
}

export interface MemoryCounts {
  active: number
  candidate: number
  forgotten: number
}

export interface WorkbenchView {
  schemaVersion: number
  pluginVersion: string
  persona: Persona
  presence: Presence
  bindings: SessionBinding[]
  sessions: { id: string; status: 'idle' | 'running' }[]
  memory: MemoryCounts
}

export interface PairResult {
  credential: string
  device: { id: string; name: string }
  hostName: string
  routes: string[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface CompanionEvent {
  eventId: string
  schemaVersion: number
  type: 'stream.ready' | 'stream.replay.complete' | 'activity' | 'message.delta' | 'message.completed' | 'message.failed' | 'ping' | 'post.created' | 'post.deleted'
  occurredAt: string
  contextId?: string
  sessionId?: string
  cursor: string | null
  payload: Record<string, unknown> & {
    phase?: 'start' | 'chunk' | 'end'
    attemptId?: string
    revision?: number
    index?: number
    text?: string
    messageId?: string
    kind?: string
    post?: FeedPost
  }
}

export type FeedAuthor = 'companion' | 'user'

export interface FeedPost {
  id: string
  parentId?: string
  author: FeedAuthor
  body: string
  mediaId?: string
  contextId?: string
  sourceSessionId?: string
  replyCount: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface FeedList {
  items: FeedPost[]
  nextCursor?: string
}

export interface FeedThread extends FeedPost {
  replies: FeedPost[]
}

export interface TtsTask {
  id: string
  contextId?: string
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  audio?: { id: string; mimeType: 'audio/wav'; bytes: number; durationMs: number }
}
