import { createHash } from 'node:crypto'
import { BILIBILI_SHARE_CONTEXT, MINECRAFT_SHARE_CONTEXT, type FeedPost } from '../core/model.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'

export function deviceFeedPostId(deviceId: string, requestId: string): string {
  const digest = createHash('sha256').update(`companion:device-feed:v1\0${deviceId}\0${requestId}`).digest()
  // Use a UUIDv8 layout for a stable, device-scoped post identity.
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.toString('hex', 0, 16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function deviceFeedPost(post: FeedPost): FeedPost {
  if (isFeedReplyContext(post.contextId)) {
    const { contextId: _context, sourceSessionId: _session, sourceTaskId: _task, ...visible } = post
    return visible
  }
  if (post.contextId !== MINECRAFT_SHARE_CONTEXT && post.contextId !== BILIBILI_SHARE_CONTEXT) return post
  const { sourceSessionId: _session, sourceTaskId: _task, ...visible } = post
  return visible
}
