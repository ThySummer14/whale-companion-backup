export const DEFAULT_DEVICE_NOTICE_LIMIT = 30
export const MAX_DEVICE_NOTICE_LIMIT = 50

export type DeviceNoticeTarget =
  | { kind: 'chat-reply' }
  | { kind: 'feed-post'; postId: string }
  | { kind: 'feed-reply'; postId: string; replyId: string }
  | { kind: 'song-ready' | 'song-failed' | 'camp-completed' | 'camp-returned'; taskId: string }

export type DeviceNotice = DeviceNoticeTarget & { id: number; occurredAt: string; read: boolean }

export interface DeviceNoticeSummary {
  version: 1
  unread: number
}

export interface DeviceNoticeView extends DeviceNoticeSummary {
  items: DeviceNotice[]
  nextBefore?: number
}
