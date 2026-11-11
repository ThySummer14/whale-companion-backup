import type { ContextKind, SessionBinding } from '../core/model.ts'

export interface CreateSessionInput {
  contextId: string
  sessionId?: string
  resume?: boolean
  kind: ContextKind
  label: string
}

export interface SendMessageInput {
  contextId: string
  text: string
}

export interface ChatAttachment {
  id: string
  name: string
  bytes: number
  mimeType: string
}

export interface SendMessageReceipt {
  accepted: true
  contextId: string
  sessionId: string
  messageId: string
  attachments?: ChatAttachment[]
  replayed?: true
}

export interface ChatHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: ChatAttachment[]
}

export interface ChatHistoryView {
  contextId: string
  sessionId: string
  messages: ChatHistoryMessage[]
}

export interface SessionLifecycleView {
  binding: SessionBinding
  resumed: boolean
}
