import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_DEVICE_NOTICE_LIMIT, MAX_DEVICE_NOTICE_LIMIT, type DeviceNotice, type DeviceNoticeSummary, type DeviceNoticeTarget, type DeviceNoticeView } from '../protocol/notices.ts'
import { verifiedCampReceipt } from './community.ts'
import { SINGING_CONTEXT, type AutonomousJob, type TaskRecord } from './model.ts'

const RETAINED_NOTICES = 200
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u

const device = `FROM device d LEFT JOIN device_notice_cursor c ON c.device_id=d.id`
const activeDevice = `d.id=? AND d.revoked_at IS NULL`
const visible = `n.id>COALESCE(c.baseline_id,0)
  AND (n.post_id IS NULL OR EXISTS (SELECT 1 FROM post p
    WHERE p.id=n.post_id AND p.parent_id IS NULL AND p.deleted_at IS NULL
    AND (n.kind='feed-reply' OR p.author_kind='companion')))
  AND (n.reply_id IS NULL OR EXISTS (SELECT 1 FROM post p
    WHERE p.id=n.reply_id AND p.parent_id=n.post_id AND p.author_kind='companion' AND p.deleted_at IS NULL))`
const read = `(n.id<=COALESCE(c.read_through_id,0) OR EXISTS (SELECT 1 FROM device_notice_read r
  WHERE r.device_id=d.id AND r.notice_id=n.id))`

interface NoticeRow {
  id: number
  kind: DeviceNoticeTarget['kind']
  occurred_at: string
  is_read: number
  post_id: string | null
  reply_id: string | null
  task_id: string | null
}

function fromRow(row: NoticeRow): DeviceNotice {
  const { id, kind, occurred_at: occurredAt, is_read, post_id, reply_id, task_id } = row
  const base = { id, occurredAt, read: is_read === 1 }
  if (kind === 'chat-reply') return { ...base, kind }
  if (kind === 'feed-post') return { ...base, kind, postId: post_id! }
  if (kind === 'feed-reply') return { ...base, kind, postId: post_id!, replyId: reply_id! }
  return { ...base, kind, taskId: task_id! }
}

function noticeId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export class DeviceNoticeRepository {
  constructor(private readonly db: DatabaseSync, private readonly hooks: {
    transaction: <T>(operation: () => T) => T
    findJob: (id: string) => AutonomousJob | undefined
    findTask: (id: string) => TaskRecord | undefined
  }) {}

  registerDevice(deviceId: string): void {
    this.db.prepare(`INSERT INTO device_notice_cursor (device_id,baseline_id,read_through_id)
      SELECT ?,COALESCE(MAX(id),0),COALESCE(MAX(id),0) FROM device_notice`).run(deviceId)
  }

  add(target: DeviceNoticeTarget, dedupeKey: string): boolean {
    const postId = 'postId' in target ? target.postId : null
    const replyId = 'replyId' in target ? target.replyId : null
    const taskId = 'taskId' in target ? target.taskId : null
    if (!dedupeKey || dedupeKey.length > 300 || dedupeKey.trim() !== dedupeKey || /[\p{Cc}\p{Cf}]/u.test(dedupeKey) ||
      [postId, replyId, taskId].some(id => id !== null && !UUID.test(id))) throw new Error('Invalid device notice reference')
    return this.hooks.transaction(() => {
      if (postId !== null) {
        if (!this.db.prepare(`SELECT 1 FROM post WHERE id=? AND parent_id IS NULL AND deleted_at IS NULL
          AND (? IS NOT NULL OR author_kind='companion')`).get(postId, replyId)) return false
        if (replyId !== null && !this.db.prepare(`SELECT 1 FROM post WHERE id=? AND parent_id=?
          AND author_kind='companion' AND deleted_at IS NULL`).get(replyId, postId)) return false
      }
      if (target.kind === 'song-ready' || target.kind === 'song-failed') {
        const task = this.hooks.findTask(target.taskId)
        if (task?.capabilityId !== 'media.singing' || task.contextId !== SINGING_CONTEXT ||
          task.status !== (target.kind === 'song-ready' ? 'succeeded' : 'failed')) return false
      }
      if (target.kind === 'camp-completed' || target.kind === 'camp-returned') {
        const job = this.hooks.findJob(target.taskId)
        const item = job && verifiedCampReceipt(job, this.hooks.findTask)?.item
        if (!item || (target.kind === 'camp-returned') !== (item.kind === 'survey' && item.outcome === 'recovered')) return false
      }
      const inserted = this.db.prepare(`INSERT INTO device_notice (kind,dedupe_key,occurred_at,post_id,reply_id,task_id)
        VALUES (?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
        .run(target.kind, dedupeKey, new Date().toISOString(), postId, replyId, taskId)
      if (!inserted.changes) return false
      this.db.prepare(`DELETE FROM device_notice WHERE id<(SELECT id FROM device_notice
        ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(RETAINED_NOTICES - 1)
      return true
    })
  }

  summary(deviceId: string): DeviceNoticeSummary | undefined {
    const row = this.db.prepare(`SELECT COUNT(n.id) AS unread ${device}
      LEFT JOIN device_notice n ON ${visible} AND NOT ${read}
      WHERE ${activeDevice} GROUP BY d.id`).get(deviceId)
    return row && { version: 1, unread: Number(row.unread) }
  }

  list(deviceId: string, { before, limit = DEFAULT_DEVICE_NOTICE_LIMIT }: { before?: number; limit?: number } = {}): DeviceNoticeView | undefined {
    if ((before !== undefined && !noticeId(before)) || !Number.isInteger(limit) || limit < 1 || limit > MAX_DEVICE_NOTICE_LIMIT) return
    const rows = this.db.prepare(`WITH visible_notices AS (
      SELECT n.id,n.kind,n.occurred_at,n.post_id,n.reply_id,n.task_id,${read} AS is_read
      ${device} JOIN device_notice n ON ${visible} WHERE ${activeDevice}
    ), notice_page AS (
      SELECT * FROM visible_notices WHERE (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?
    ), notice_total AS (
      SELECT COUNT(*) AS unread FROM visible_notices WHERE NOT is_read
    )
    SELECT p.*,t.unread FROM notice_total t LEFT JOIN notice_page p ON 1
      WHERE EXISTS (SELECT 1 FROM device WHERE id=? AND revoked_at IS NULL) ORDER BY p.id DESC`)
      .all(deviceId, before ?? null, before ?? null, limit + 1, deviceId) as unknown as
      ((NoticeRow | { id: null }) & { unread: number })[]
    const first = rows[0]
    if (!first) return
    const items = rows.slice(0, limit).filter(row => row.id !== null).map(fromRow)
    return { version: 1, unread: first.unread, items, ...(rows.length > limit && { nextBefore: items.at(-1)!.id }) }
  }

  markRead(deviceId: string, input: { id: number } | { through: number }): DeviceNoticeSummary | undefined {
    const id = 'id' in input ? input.id : input.through
    if (!noticeId(id)) return
    return this.hooks.transaction(() => {
      if (!this.db.prepare(`SELECT 1 ${device} JOIN device_notice n ON ${visible}
        WHERE ${activeDevice} AND n.id=?`).get(deviceId, id)) return
      if ('id' in input) {
        this.db.prepare(`INSERT INTO device_notice_read (device_id,notice_id)
          SELECT ?,? WHERE ?>COALESCE((SELECT read_through_id FROM device_notice_cursor WHERE device_id=?),0)
          ON CONFLICT(device_id,notice_id) DO NOTHING`).run(deviceId, id, id, deviceId)
      } else {
        this.db.prepare(`INSERT INTO device_notice_cursor (device_id,baseline_id,read_through_id) VALUES (?,0,?)
          ON CONFLICT(device_id) DO UPDATE SET read_through_id=MAX(read_through_id,excluded.read_through_id)`).run(deviceId, id)
        this.db.prepare('DELETE FROM device_notice_read WHERE device_id=? AND notice_id<=?').run(deviceId, id)
      }
      return this.summary(deviceId)
    })
  }
}
