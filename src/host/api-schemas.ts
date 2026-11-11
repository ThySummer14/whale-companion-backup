import { z } from 'zod'
import { BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT } from '../core/model.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'
import { MAX_SINGING_SCORE_ROWS } from '../protocol/singing.ts'
import { isValidSingingScore, SINGING_SCORE_LYRIC } from '../protocol/singing-score.ts'
import { EXPRESSIVE_TTS_STYLES } from '../protocol/api.ts'
import { MAX_DEVICE_IMAGE_BASE64 } from './device-media.ts'

export const identifier = z.string().trim().min(1).max(200)
export const capabilityId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
export const SessionCreateInput = z.object({
  contextId: capabilityId,
  sessionId: z.string().trim().max(200).optional(),
  resume: z.boolean().default(false),
  kind: z.enum(['chat', 'game', 'task', 'topic', 'system']),
  label: z.string().trim().min(1).max(80),
})
export const MessageInput = z.object({ contextId: capabilityId, text: z.string().trim().min(1).max(16_000) })
export const ContextInput = z.object({ contextId: capabilityId })
export const TtsInput = ContextInput.extend({ messageId: identifier })
export const TtsRenderInput = TtsInput.extend({ style: z.enum(EXPRESSIVE_TTS_STYLES).optional() }).strict()
export const FeedPostInput = z.object({
  body: z.string().trim().min(1).max(4000),
  contextId: capabilityId.refine(id => !isFeedReplyContext(id) && id !== BILIBILI_SHARE_CONTEXT && id !== DAILY_AUTONOMY_CONTEXT && id !== DAILY_REFLECTION_CONTEXT && id !== DAILY_VISIT_CONTEXT).optional(),
  author: z.enum(['companion', 'user']).default('user'),
})
export const FeedReplyInput = FeedPostInput.omit({ author: true })
export const DeviceFeedPublishInput = FeedReplyInput.extend({
  requestId: z.uuidv4(),
  parentId: z.uuid().optional(),
  body: z.string().trim().max(4000).default(''),
  image: z.strictObject({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataBase64: z.string().max(MAX_DEVICE_IMAGE_BASE64),
  }).optional(),
}).strict().refine(input => !!(input.body || input.image))
export type DeviceFeedPublishInput = z.infer<typeof DeviceFeedPublishInput>

export const SingingInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  lyrics: z.string().trim().min(1).max(1200),
  style: z.string().trim().min(1).max(200),
  durationSeconds: z.number().int().min(10).max(60),
})

export const SingingScoreInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  bpm: z.int().min(60).max(180),
  notes: z.array(z.strictObject({
    midi: z.int().min(48).max(84).nullable(),
    beats: z.number().min(0.25).max(8).multipleOf(0.25),
    lyric: z.string().regex(SINGING_SCORE_LYRIC).optional(),
  })).min(2).max(MAX_SINGING_SCORE_ROWS),
}).refine(isValidSingingScore)
