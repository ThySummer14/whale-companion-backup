import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { MAX_SINGING_WAV_BYTES } from '../protocol/singing.ts'
import { BilibiliClipReaction, bilibiliClipSharePrefix } from './bilibili-clip-share.ts'
import { FEED_REPLY_CONTEXT_PREFIX, FEED_REPLY_WINDOW, FeedReplyDecision, isFeedReplyContext } from './feed-reply.ts'
import type { BilibiliQueueRepository } from './bilibili-queue.ts'
import type { MediaRepository } from './media.ts'
import { MINECRAFT_HOUSE_CAPABILITY } from './minecraft-house-repository.ts'
import { MinecraftMilestoneMoment, matchesMinecraftMilestoneShare } from './minecraft-milestone-share.ts'
import {
  BILIBILI_AUTONOMY_CONTEXT,
  BILIBILI_CLIP_CONTEXT,
  BILIBILI_SHARE_CONTEXT,
  BILIBILI_SHARE_TTL_MS,
  DAILY_AUTONOMY_CONTEXT,
  MINECRAFT_SHARE_ACTIONS,
  MINECRAFT_SHARE_CONTEXT,
  SINGING_CONTEXT,
  type FeedAuthor,
  type FeedCreateInput,
  type FeedList,
  type FeedPost,
  type FeedSongSource,
  type FeedThread,
} from './model.ts'

interface FeedRow {
  id: string
  parent_id: string | null
  author_kind: FeedAuthor
  body: string
  media_id: string | null
  context_id: string | null
  source_session_id: string | null
  source_task_id: string | null
  song_task_id: string | null
  bilibili_share_snapshot: string | null
  reply_count: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const BilibiliShareSnapshot = z.strictObject({
  kind: z.literal('clip').optional(),
  candidateId: z.uuid(),
  bvid: z.string().regex(/^BV[a-zA-Z0-9]{10}$/u),
  part: z.int().min(1).max(1000),
  activityId: z.int().positive(),
  readTaskId: z.uuid(),
  readAt: z.iso.datetime(),
  startSeconds: z.int().min(0).max(604_800),
})

const ReadReceipt = z.strictObject({
  activityId: z.int().positive(),
  at: z.iso.datetime(),
  kind: z.literal('video.subtitle-read'),
  provenance: z.strictObject({
    kind: z.literal('owner-supplied'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).optional(),
})

const ReadJobPayload = z.object({ candidateId: z.uuid(), activityId: z.int().positive() })
const BilibiliClipShareSettings = z.object({ enabled: z.literal(true), feedEnabled: z.literal(true), bilibiliEnabled: z.literal(true),
  bilibiliClipsEnabled: z.literal(true), bilibiliClipShareEnabled: z.literal(true) })
const MinecraftMilestoneShareSettings = z.object({
  enabled: z.literal(true), feedEnabled: z.literal(true), minecraftShareEnabled: z.literal(true), minecraftMilestonesEnabled: z.literal(true),
})

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return
  try { return JSON.parse(value) }
  catch { return undefined }
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown }
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id || value.id.length > 200) throw new Error('Invalid cursor')
    return { createdAt: value.createdAt, id: value.id }
  } catch {
    throw new Error('Invalid feed cursor')
  }
}

export class FeedRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly media: Pick<MediaRepository, 'songDuration'>,
    private readonly bilibili: Pick<BilibiliQueueRepository, 'verifiedCompletedClip'>,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  private archivedSong(id: string, sessionId: string): FeedSongSource | undefined {
    const row = this.db.prepare(`SELECT t.title, m.bytes, m.hash
      FROM task t JOIN media_asset m ON m.id=t.id AND m.source_ref=t.id
      WHERE t.id=? AND t.session_id=? AND t.context_id=? AND t.capability_id='media.singing' AND t.status='succeeded'
        AND m.kind='song' AND m.source='singing' AND m.mime_type='audio/wav' AND m.retention='keep'
        AND m.path='songs/' || t.id || '.wav' AND m.bytes BETWEEN 44 AND ? AND typeof(m.bytes)='integer'
        AND m.missing_at IS NULL AND m.deleted_at IS NULL`).get(id, sessionId, SINGING_CONTEXT, MAX_SINGING_WAV_BYTES)
    if (typeof row?.title !== 'string' || !row.title.trim() || row.title.length > 80 ||
      typeof row.hash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.hash)) return
    const durationSeconds = this.media.songDuration(id, row.hash)
    return { id, title: row.title, bytes: Number(row.bytes), ...(durationSeconds !== undefined && { durationSeconds }) }
  }

  private fromRow(row: unknown): FeedPost {
    const value = row as FeedRow
    const snapshot = value.bilibili_share_snapshot
      ? BilibiliShareSnapshot.safeParse(parseJson(value.bilibili_share_snapshot))
      : undefined
    const song = value.song_task_id && value.source_session_id && !value.deleted_at
      ? this.archivedSong(value.song_task_id, value.source_session_id)
      : undefined
    return {
      id: value.id,
      parentId: value.parent_id ?? undefined,
      author: value.author_kind,
      body: value.body,
      mediaId: value.media_id ?? undefined,
      contextId: value.context_id ?? undefined,
      sourceSessionId: value.song_task_id ? undefined : value.source_session_id ?? undefined,
      sourceTaskId: value.source_task_id ?? undefined,
      ...(snapshot?.success && {
        bilibiliSource: { bvid: snapshot.data.bvid, part: snapshot.data.part, startSeconds: snapshot.data.startSeconds },
      }),
      ...(song && { song }),
      replyCount: Number(value.reply_count),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      deletedAt: value.deleted_at ?? undefined,
    }
  }

  private select(where: string) {
    return `SELECT post.*,
      (SELECT COUNT(*) FROM post AS replies WHERE replies.parent_id=post.id AND replies.deleted_at IS NULL) AS reply_count,
      (SELECT j.payload_json FROM autonomous_job AS j
        WHERE post.context_id='${BILIBILI_SHARE_CONTEXT}' AND post.parent_id IS NULL
        AND post.author_kind='companion' AND j.task_id=post.source_task_id
        AND j.kind='bilibili.share' AND j.context_id=post.context_id) AS bilibili_share_snapshot
      FROM post ${where}`
  }

  private verifyBilibiliShare(input: FeedCreateInput, body: string): void {
    if (!input.sourceTaskId || !input.sourceSessionId || input.author !== 'companion' ||
      input.parentId !== undefined || input.mediaId !== undefined) {
      throw new Error('Bilibili share requires an authorized top-level text post')
    }
    const job = this.db.prepare(`SELECT j.dedupe_key, j.payload_json FROM autonomous_job j
      JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      JOIN session_binding b ON b.context_id=CASE WHEN json_extract(j.payload_json,'$.kind')='clip' THEN ? ELSE j.context_id END
      WHERE j.task_id=? AND j.kind='bilibili.share' AND j.context_id=? AND t.status='running'
      AND t.capability_id='core.autonomy' AND b.session_id=? AND b.kind='system'`)
      .get(BILIBILI_CLIP_CONTEXT, input.sourceTaskId, BILIBILI_SHARE_CONTEXT, input.sourceSessionId)
    const snapshot = BilibiliShareSnapshot.safeParse(parseJson(job?.payload_json))
    if (!snapshot.success) throw new Error('Bilibili share source job is missing or invalid')
    const { bvid, part, candidateId, readTaskId, activityId, readAt } = snapshot.data
    const age = Date.now() - Date.parse(readAt)
    if (job?.dedupe_key !== `bili-share:${bvid}:${part}` || age < 0 || age >= BILIBILI_SHARE_TTL_MS) {
      throw new Error('Bilibili share source job is missing or invalid')
    }
    if (this.bySourceTask(input.sourceTaskId)) throw new Error('Bilibili source task already shared')
    if (snapshot.data.kind === 'clip') {
      const settings = this.db.prepare("SELECT value FROM state WHERE key='autonomy.settings'").get()
      const proof = this.bilibili.verifiedCompletedClip(candidateId, readTaskId, activityId)
      if (!BilibiliClipShareSettings.safeParse(parseJson(settings?.value)).success || !proof || proof.sessionId !== input.sourceSessionId ||
          proof.receipt.at !== readAt || proof.receipt.clip.start !== snapshot.data.startSeconds ||
          !this.db.prepare('SELECT 1 FROM bilibili_candidate WHERE id=? AND bvid=? AND part=?').get(candidateId, bvid, part)) {
        throw new Error('Bilibili share lacks an eligible short clip receipt')
      }
      const prefix = bilibiliClipSharePrefix(proof.receipt.clip)
      const reaction = body.slice(prefix.length)
      if (!body.startsWith(prefix) || BilibiliClipReaction.safeParse(reaction).data !== reaction) {
        throw new Error('Bilibili clip share must contain a bounded reaction and its actual modalities')
      }
      return
    }
    const source = this.db.prepare(`SELECT c.receipt_json, r.payload_json,
      (SELECT sha256 FROM bilibili_subtitle_attachment a WHERE a.bvid=c.bvid AND a.part=c.part) AS attachment_sha256
      FROM bilibili_candidate c
      JOIN autonomous_job r ON r.task_id=? AND r.kind='bilibili.review' AND r.context_id=?
      JOIN task t ON t.id=r.task_id AND t.context_id=r.context_id
      WHERE c.id=? AND c.bvid=? AND c.part=? AND c.status='read'
      AND t.status='succeeded' AND t.capability_id='core.autonomy'
      AND (c.source_id IS NULL OR EXISTS(
        SELECT 1 FROM bilibili_source s WHERE s.id=c.source_id AND s.revoked_at IS NULL))`)
      .get(readTaskId, BILIBILI_AUTONOMY_CONTEXT, candidateId, bvid, part)
    const receipt = ReadReceipt.safeParse(parseJson(source?.receipt_json))
    const payload = ReadJobPayload.safeParse(parseJson(source?.payload_json))
    if (!receipt.success || receipt.data.activityId !== activityId || receipt.data.at !== readAt ||
      !payload.success || payload.data.candidateId !== candidateId || payload.data.activityId !== activityId ||
      (receipt.data.provenance && receipt.data.provenance.sha256 !== source?.attachment_sha256)) {
      throw new Error('Bilibili share lacks an eligible subtitle reading receipt')
    }
  }

  private verifySongShare(input: FeedCreateInput, body: string, taskId: string): void {
    if (input.author !== 'companion' || input.contextId !== SINGING_CONTEXT || !input.sourceSessionId ||
      input.parentId !== undefined || input.mediaId !== undefined || input.sourceTaskId !== undefined ||
      !body || body.length > 280) throw new Error('Song share requires an authorized top-level singing post')
    const binding = this.db.prepare("SELECT 1 FROM session_binding WHERE context_id=? AND session_id=? AND kind='topic'")
      .get(SINGING_CONTEXT, input.sourceSessionId)
    if (!binding || !z.uuid().safeParse(taskId).success || !this.archivedSong(taskId, input.sourceSessionId)) {
      throw new Error('Song share requires the current singing session’s verified archive')
    }
    if (this.bySongTask(taskId)) throw new Error('Song archive already shared')
  }

  private verifyMinecraftMilestoneShare(input: FeedCreateInput, body: string, source: Record<string, unknown> | undefined): void {
    if (!input.sourceTaskId || !input.sourceSessionId || input.mediaId !== undefined || source?.status !== 'succeeded') {
      throw new Error('Minecraft milestone share requires a completed source and authorized text review')
    }
    const job = this.db.prepare(`SELECT j.payload_json FROM autonomous_job j
      JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      JOIN session_binding b ON b.context_id=j.context_id
      WHERE t.external_id=? AND j.dedupe_key=? AND j.kind='minecraft.share' AND j.context_id=?
      AND t.status='running' AND t.capability_id='core.autonomy' AND j.attempts=1 AND j.lease_until>?
      AND b.session_id=? AND b.kind='system'`)
      .get(`autonomy:minecraft.share:${input.sourceTaskId}`, input.sourceTaskId, MINECRAFT_SHARE_CONTEXT, Date.now(), input.sourceSessionId)
    const snapshot = MinecraftMilestoneMoment.safeParse(parseJson(job?.payload_json)).data
    const settings = this.db.prepare("SELECT value FROM state WHERE key='autonomy.settings'").get()
    if (!snapshot || snapshot.taskId !== input.sourceTaskId || !matchesMinecraftMilestoneShare(body, snapshot.summary) ||
      !MinecraftMilestoneShareSettings.safeParse(parseJson(settings?.value)).success) {
      throw new Error('Minecraft milestone share source job is missing or invalid')
    }
    const eligible = snapshot.kind === 'house'
      ? source.context_id === 'game.minecraft' && source.capability_id === MINECRAFT_HOUSE_CAPABILITY && this.db.prepare(
        "SELECT 1 FROM minecraft_house WHERE attempt_task_id=? AND status='built' AND receipt_json IS NOT NULL",
      ).get(input.sourceTaskId)
      : source.context_id === DAILY_AUTONOMY_CONTEXT && source.capability_id === 'core.autonomy' && this.db.prepare(
        "SELECT 1 FROM autonomous_job WHERE task_id=? AND kind='daily.choice' AND context_id=? AND json_extract(payload_json,'$.visitStatus')='offline'",
      ).get(input.sourceTaskId, DAILY_AUTONOMY_CONTEXT)
    if (!eligible) throw new Error('Minecraft milestone source task is not an eligible completed action')
  }

  create(input: FeedCreateInput, id: string = randomUUID()): FeedPost {
    const body = input.body.trim()
    if (body.length > 4000 || (!body && !input.mediaId)) throw new Error('Post must contain text up to 4000 characters or an image')
    if (input.contextId && !/^[a-z][a-z0-9._-]{0,63}$/.test(input.contextId)) throw new Error('Invalid context id')
    if (input.sourceSessionId && input.sourceSessionId.length > 200) throw new Error('Invalid source session id')
    if (input.contextId === MINECRAFT_SHARE_CONTEXT && !input.sourceTaskId) throw new Error('Minecraft share requires a source task')
    const now = new Date().toISOString()
    return this.transaction(() => {
      let survey = false
      if (input.songTaskId !== undefined) {
        this.verifySongShare(input, body, input.songTaskId)
      } else if (input.contextId === BILIBILI_SHARE_CONTEXT) {
        this.verifyBilibiliShare(input, body)
      } else if (isFeedReplyContext(input.contextId)) {
        this.verifyReactiveReply(input, body)
      } else if (input.sourceTaskId !== undefined) {
        if (input.author !== 'companion' || input.parentId !== undefined || input.contextId !== MINECRAFT_SHARE_CONTEXT) {
          throw new Error('Only an autonomous Minecraft post can cite a source task')
        }
        const task = this.db.prepare('SELECT context_id, capability_id, status FROM task WHERE id=?').get(input.sourceTaskId)
        const ordinary = task?.context_id === 'game.minecraft' && task.status === 'succeeded' &&
          MINECRAFT_SHARE_ACTIONS.some(action => task.capability_id === `minecraft.${action}`)
        if (!ordinary) {
          const milestone = task?.context_id === 'game.minecraft' && task.capability_id === MINECRAFT_HOUSE_CAPABILITY ||
            task?.context_id === DAILY_AUTONOMY_CONTEXT && task.capability_id === 'core.autonomy'
          if (!milestone) throw new Error('Minecraft source task is not an eligible completed action')
          this.verifyMinecraftMilestoneShare(input, body, task)
        }
        if (this.bySourceTask(input.sourceTaskId)) throw new Error('Minecraft source task already shared')
        survey = task?.capability_id === 'minecraft.survey'
      }
      if (input.parentId) {
        const parent = this.db.prepare('SELECT id, parent_id FROM post WHERE id=? AND deleted_at IS NULL').get(input.parentId) as { id: string; parent_id: string | null } | undefined
        if (!parent) throw new Error('Parent post not found')
        if (parent.parent_id) throw new Error('Replies can only be added to a top-level post')
      }
      if (input.mediaId) {
        const media = this.db.prepare('SELECT kind, source, source_ref FROM media_asset WHERE id=? AND deleted_at IS NULL AND missing_at IS NULL').get(input.mediaId)
        if (!media || media.kind !== 'image') throw new Error('Media not found')
        const surveyCard = media.source === 'minecraft-survey-card'
        if (survey !== surveyCard || surveyCard && media.source_ref !== input.sourceTaskId) {
          throw new Error('Survey image requires its matching Minecraft task')
        }
      }
      this.db.prepare(`INSERT INTO post
        (id, parent_id, author_kind, body, media_id, context_id, source_session_id, source_task_id, song_task_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.parentId ?? null, input.author, body, input.mediaId ?? null, input.contextId ?? null, input.sourceSessionId ?? null, input.sourceTaskId ?? null, input.songTaskId ?? null, now, now,
      )
      return this.fromRow(this.db.prepare(this.select('WHERE id=?')).get(id))
    })
  }

  byId(id: string): FeedPost | undefined {
    const row = this.db.prepare(this.select('WHERE id=?')).get(id)
    return row ? this.fromRow(row) : undefined
  }

  usesMedia(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM post WHERE media_id=? LIMIT 1').get(id) !== undefined
  }

  private verifyReactiveReply(input: FeedCreateInput, body: string): void {
    const { contextId, sourceTaskId, sourceSessionId, parentId } = input
    if (input.author !== 'companion' || !parentId || contextId !== FEED_REPLY_CONTEXT_PREFIX + parentId ||
      !sourceTaskId || !sourceSessionId || input.mediaId || !FeedReplyDecision.safeParse({ decision: 'reply', body }).success) {
      throw new Error('Reactive reply requires an authorized text decision')
    }
    const active = this.db.prepare(`SELECT j.payload_json FROM autonomous_job j
      JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      JOIN session_binding b ON b.context_id=j.context_id
      WHERE j.task_id=? AND j.kind='feed.reply' AND j.context_id=? AND j.lease_until>?
      AND t.status='running' AND t.capability_id='core.autonomy' AND b.session_id=? AND b.kind='system'`)
      .get(sourceTaskId, contextId, Date.now(), sourceSessionId)
    const payload = parseJson(active?.payload_json)
    const parsed = z.object({ postId: z.uuid(), triggerPostId: z.uuid() }).safeParse(payload)
    const settings = parseJson(this.db.prepare("SELECT value FROM state WHERE key='autonomy.settings'").get()?.value) as
      { enabled?: boolean; feedRepliesEnabled?: boolean } | undefined
    if (!parsed.success || parsed.data.postId !== parentId || settings?.enabled === false ||
      settings?.feedRepliesEnabled === false || this.bySourceTask(sourceTaskId)) throw new Error('Reactive reply decision is no longer authorized')
    const thread = this.replySnapshot(parentId)
    const target = thread.replies.at(-1) ?? thread
    if (target.author !== 'user' || target.id !== parsed.data.triggerPostId) throw new Error('Reactive reply source has changed')
  }

  replySnapshot(id: string): FeedThread {
    const row = this.db.prepare(this.select('WHERE id=? AND parent_id IS NULL AND deleted_at IS NULL')).get(id)
    if (!row) throw new Error('Post not found')
    const replies = this.db.prepare(this.select('WHERE parent_id=? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?'))
      .all(id, FEED_REPLY_WINDOW).reverse().map(item => this.fromRow(item))
    return { ...this.fromRow(row), replies }
  }

  latestReactiveReplyAt(parentId: string): number {
    const row = this.db.prepare(`SELECT created_at FROM post WHERE parent_id=? AND author_kind='companion'
      AND context_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(parentId, FEED_REPLY_CONTEXT_PREFIX + parentId)
    return row ? Date.parse(String(row.created_at)) : 0
  }

  bySourceTask(taskId: string): FeedPost | undefined {
    const row = this.db.prepare(this.select('WHERE source_task_id=?')).get(taskId)
    return row ? this.fromRow(row) : undefined
  }

  bySongTask(taskId: string): FeedPost | undefined {
    const row = this.db.prepare(this.select('WHERE song_task_id=?')).get(taskId)
    return row ? this.fromRow(row) : undefined
  }

  completedSongIdsByTitle(sessionId: string, title: string): string[] {
    return this.db.prepare(`SELECT id FROM task WHERE session_id=? AND title=?
      AND context_id='${SINGING_CONTEXT}' AND capability_id='media.singing' AND status='succeeded' LIMIT 2`)
      .all(sessionId, title).map(row => String(row.id))
  }

  latestAutonomousPostAt(contextIds: readonly string[]): string | undefined {
    if (!contextIds.length) return undefined
    const placeholders = contextIds.map(() => '?').join(',')
    const row = this.db.prepare(`SELECT created_at FROM post WHERE parent_id IS NULL AND author_kind='companion'
      AND context_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`).get(...contextIds)
    return row?.created_at as string | undefined
  }

  list(options: { cursor?: string; limit?: number } = {}): FeedList {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)))
    const before = options.cursor ? decodeCursor(options.cursor) : undefined
    const rows = before
      ? this.db.prepare(this.select('WHERE parent_id IS NULL AND deleted_at IS NULL AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC, id DESC LIMIT ?')).all(before.createdAt, before.createdAt, before.id, limit)
      : this.db.prepare(this.select('WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?')).all(limit)
    const items = rows.map(row => this.fromRow(row))
    const last = items.at(-1)
    return {
      items,
      nextCursor: items.length === limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : undefined,
    }
  }

  get(id: string): FeedThread {
    const row = this.db.prepare(this.select('WHERE id=? AND parent_id IS NULL AND deleted_at IS NULL')).get(id)
    if (!row) throw new Error('Post not found')
    const replies = this.db.prepare(this.select('WHERE parent_id=? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC')).all(id).map(item => this.fromRow(item))
    return { ...this.fromRow(row), replies }
  }

  delete(id: string, author: FeedAuthor): FeedPost {
    return this.transaction(() => {
      const row = this.db.prepare(this.select('WHERE id=? AND parent_id IS NULL AND deleted_at IS NULL')).get(id)
      if (!row) throw new Error('Post not found')
      const current = this.fromRow(row)
      if (current.author !== author) throw new Error('Only the author can delete this post')
      const deletedAt = new Date().toISOString()
      this.db.prepare('UPDATE post SET deleted_at=?, updated_at=? WHERE id=?').run(deletedAt, deletedAt, id)
      return this.fromRow({ ...row, updated_at: deletedAt, deleted_at: deletedAt })
    })
  }
}
