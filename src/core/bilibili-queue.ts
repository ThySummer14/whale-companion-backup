import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS, MAX_AUTONOMOUS_BILIBILI_CLIP_SECONDS, type BilibiliDiscoveredVideo, type BilibiliQueueItem, type BilibiliQueueView, type BilibiliReadReceipt, type BilibiliSource, type BilibiliSourceInput } from '../protocol/bilibili.ts'
import { parseBilibiliTarget, plainBilibiliText } from './bilibili.ts'
import { isBilibiliSubtitleDigest } from './bilibili-subtitles.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, DAILY_AUTONOMY_CONTEXT } from './model.ts'

const LIMIT = 20
const COOLDOWN = 'bilibili.nextDecisionAt'
const CLIP_COOLDOWN = 'bilibili.nextClipAt'
const DISCOVERY_COOLDOWN = 'bilibili.nextDiscoveryAt'
const SOURCE_LIMIT = 8
const AUTO_QUEUE_LIMIT = 6
const DISCOVERY_BATCH = 3
const HOUR = 60 * 60_000
const DISCOVERY_INTERVAL = 6 * HOUR
const SOURCE_INTERVAL = 24 * HOUR
const SOURCE_FAILURE_INTERVAL = 48 * HOUR
const DISCOVERY_LEASE_MS = 2 * 60_000

type Outcome = { status: 'read'; receipt: BilibiliReadReceipt } | { status: 'skipped' | 'failed'; error?: string }
type DiscoveryOutcome = { items: BilibiliDiscoveredVideo[] } | { error: string }
type Row = {
  id: string; bvid: string; part: number; label: string | null; status: BilibiliQueueItem['status']
  created_at: string; updated_at: string; receipt_json: string | null; error: string | null
  source_id: string | null; source_title: string | null
}
type SourceRow = {
  id: string; mid: string; season_id: string; label: string | null; status: BilibiliSource['status']
  created_at: string; updated_at: string; last_checked_at: number | null
  last_added: number | null; error: string | null
}

function item(row: unknown): BilibiliQueueItem {
  const value = row as Row
  return {
    id: value.id, bvid: value.bvid, part: value.part, status: value.status,
    label: value.label ?? undefined, createdAt: value.created_at, updatedAt: value.updated_at,
    receipt: value.receipt_json ? JSON.parse(value.receipt_json) as BilibiliReadReceipt : undefined,
    error: value.error ?? undefined,
    ...(value.source_id && { sourceId: value.source_id }),
    ...(value.source_title && { sourceTitle: value.source_title }),
  }
}

function source(row: SourceRow): BilibiliSource {
  return {
    id: row.id, mid: row.mid, seasonId: row.season_id, label: row.label ?? undefined, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at === null ? undefined : new Date(row.last_checked_at).toISOString(),
    lastAdded: row.last_added ?? undefined, error: row.error ?? undefined,
  }
}

function sourceIdentity(value: string): boolean {
  return /^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))
}

export class BilibiliQueueRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(run: () => T) => T) {}

  get(id: string): BilibiliQueueItem | undefined {
    const row = this.db.prepare('SELECT * FROM bilibili_candidate WHERE id=?').get(id)
    return row ? item(row) : undefined
  }

  sourceActive(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bilibili_source WHERE id=? AND revoked_at IS NULL').get(id)
  }

  view(): BilibiliQueueView {
    const active = this.db.prepare(`SELECT * FROM bilibili_candidate WHERE status IN ('queued','reading')
      ORDER BY status='reading' DESC,source_id IS NOT NULL,rowid LIMIT ?`).all(LIMIT)
    const recent = this.db.prepare("SELECT * FROM bilibili_candidate WHERE status NOT IN ('queued','reading') ORDER BY updated_at DESC,rowid DESC LIMIT 30").all()
    const deferred = this.deadline(COOLDOWN)
    const clip = this.deadline(CLIP_COOLDOWN)
    const sources = this.db.prepare('SELECT * FROM bilibili_source WHERE revoked_at IS NULL ORDER BY rowid').all() as unknown as SourceRow[]
    const earliestSource = Math.min(...sources.map(row => row.last_checked_at === null ? 0 : row.last_checked_at +
      (row.status === 'unavailable' ? SOURCE_FAILURE_INTERVAL : SOURCE_INTERVAL)))
    const next = Math.max(this.deadline(DISCOVERY_COOLDOWN), earliestSource)
    return {
      items: [...active, ...recent].map(item),
      nextDecisionAt: deferred > 0 ? new Date(deferred).toISOString() : undefined,
      ...(clip > 0 && { nextClipAt: new Date(clip).toISOString() }),
      sources: sources.map(source),
      nextDiscoveryAt: sources.length && next > 0 ? new Date(next).toISOString() : undefined,
    }
  }

  add(target: { bvid: string; part: number }, label?: string): BilibiliQueueItem | undefined {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM bilibili_candidate WHERE bvid=? AND part=? AND status IN ('queued','reading')").get(target.bvid, target.part)
      if (existing) {
        const previous = item(existing)
        if (!previous.sourceId || previous.status !== 'queued') return previous
        const promoted = this.db.prepare(`UPDATE bilibili_candidate SET source_id=NULL,source_title=NULL,label=?,updated_at=?
          WHERE id=? AND status='queued' RETURNING *`).get(label ?? null, new Date().toISOString(), previous.id)
        return promoted ? item(promoted) : previous
      }
      const count = Number(this.db.prepare("SELECT count(*) AS n FROM bilibili_candidate WHERE status IN ('queued','reading')").get()?.n)
      if (count >= LIMIT) return
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare("INSERT INTO bilibili_candidate (id,bvid,part,label,status,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?)")
        .run(id, target.bvid, target.part, label ?? null, now, now)
      return { id, ...target, label, status: 'queued', createdAt: now, updatedAt: now }
    })
  }

  addSource(input: BilibiliSourceInput): BilibiliSource | undefined {
    if (!sourceIdentity(input.mid) || !sourceIdentity(input.seasonId)) return
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM bilibili_source WHERE mid=? AND season_id=? AND revoked_at IS NULL')
        .get(input.mid, input.seasonId)
      if (existing) return source(existing as unknown as SourceRow)
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM bilibili_source WHERE revoked_at IS NULL').get()?.n)
      if (count >= SOURCE_LIMIT) return
      const now = new Date().toISOString()
      const label = input.label === undefined ? '' : plainBilibiliText(input.label, 240)
      const row = this.db.prepare(`INSERT INTO bilibili_source (id,mid,season_id,label,status,created_at,updated_at)
        VALUES (?,?,?,?,'waiting',?,?) RETURNING *`).get(randomUUID(), input.mid, input.seasonId, label || null, now, now)
      return source(row as unknown as SourceRow)
    })
  }

  revokeSource(id: string): { candidateIds: string[] } | undefined {
    return this.transaction(() => {
      const now = new Date().toISOString()
      const changed = this.db.prepare('UPDATE bilibili_source SET revoked_at=?,updated_at=?,claim_at=NULL WHERE id=? AND revoked_at IS NULL')
        .run(now, now, id)
      if (!changed.changes) return
      const cancelled = this.db.prepare(`UPDATE bilibili_candidate SET status='cancelled',updated_at=?
        WHERE source_id=? AND status IN ('queued','reading') RETURNING id`).all(now, id)
      return { candidateIds: cancelled.map(row => String(row.id)) }
    })
  }

  claimDiscovery(now: number): BilibiliSource | undefined {
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - SOURCE_FAILURE_INTERVAL) return
    return this.transaction(() => {
      if (this.deadline(DISCOVERY_COOLDOWN) > now || this.discoveryCapacity() === 0) return
      const checked = this.db.prepare(`SELECT id FROM bilibili_source WHERE revoked_at IS NULL AND
        (last_checked_at IS NULL OR last_checked_at <= ? - CASE WHEN status='unavailable' THEN ? ELSE ? END)
        ORDER BY last_checked_at,rowid LIMIT 1`).get(now, SOURCE_FAILURE_INTERVAL, SOURCE_INTERVAL)
      if (!checked) return
      const row = this.db.prepare(`UPDATE bilibili_source SET last_checked_at=?,claim_at=?,updated_at=?,status='waiting',
        last_added=NULL,error=NULL WHERE id=? RETURNING *`).get(now, now, new Date(now).toISOString(), String(checked.id))
      this.setDeadline(DISCOVERY_COOLDOWN, now + DISCOVERY_INTERVAL)
      return source(row as unknown as SourceRow)
    })
  }

  finishDiscovery(id: string, at: number, outcome: DiscoveryOutcome): number | undefined {
    const now = Date.now()
    if (!Number.isSafeInteger(at) || at < 0 || now < at || now - at >= DISCOVERY_LEASE_MS) return
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM bilibili_source WHERE id=? AND revoked_at IS NULL AND claim_at=?').get(id, at)) return
      const updatedAt = new Date(now).toISOString()
      if ('error' in outcome) {
        const code = /^bili-[a-z0-9-]{1,64}$/u.test(outcome.error) ? outcome.error : 'bili-discovery-failed'
        this.db.prepare(`UPDATE bilibili_source SET status='unavailable',updated_at=?,claim_at=NULL,error=? WHERE id=?`)
          .run(updatedAt, code, id)
        return 0
      }
      const capacity = this.discoveryCapacity()
      const seen = this.db.prepare('SELECT 1 FROM bilibili_candidate WHERE bvid=? AND part=1 LIMIT 1')
      const insert = this.db.prepare(`INSERT INTO bilibili_candidate (id,bvid,part,status,created_at,updated_at,source_id,source_title)
        VALUES (?,?,1,'queued',?,?,?,?)`)
      let added = 0
      for (const entry of outcome.items) {
        if (added === capacity) break
        if (parseBilibiliTarget(entry.bvid)?.bvid !== entry.bvid || seen.get(entry.bvid)) continue
        const title = plainBilibiliText(entry.title, 240)
        if (!title) continue
        insert.run(randomUUID(), entry.bvid, updatedAt, updatedAt, id, title)
        added++
      }
      this.db.prepare(`UPDATE bilibili_source SET status=?,updated_at=?,claim_at=NULL,last_added=? WHERE id=?`)
        .run(added ? 'added' : 'unchanged', updatedAt, added, id)
      return added
    })
  }

  private discoveryCapacity(): number {
    const row = this.db.prepare(`SELECT count(*) AS total, count(source_id) AS sourced FROM bilibili_candidate
      WHERE status IN ('queued','reading')`).get()
    return Math.max(0, Math.min(DISCOVERY_BATCH, LIMIT - Number(row?.total), AUTO_QUEUE_LIMIT - Number(row?.sourced)))
  }

  private deadline(key: string): number {
    return Number(this.db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value ?? 0)
  }

  private setDeadline(key: string, until: number): void {
    this.db.prepare(`INSERT INTO state (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<CAST(excluded.value AS INTEGER)`).run(key, String(until))
  }

  defer(until: number): void {
    this.setDeadline(COOLDOWN, until)
  }

  begin(id: string, nextDecisionAt?: number): boolean {
    return this.transaction(() => {
      const deferred = this.deadline(COOLDOWN)
      if (deferred > Date.now()) return false
      const started = this.db.prepare(`UPDATE bilibili_candidate SET status='reading',updated_at=?
        WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM bilibili_candidate WHERE status='reading')`)
        .run(new Date().toISOString(), id)
      if (!started.changes) return false
      if (nextDecisionAt !== undefined) this.defer(nextDecisionAt)
      return true
    })
  }

  canBeginClip(now = Date.now()): boolean {
    return this.deadline(CLIP_COOLDOWN) <= now
  }

  beginClip(id: string, nextDecisionAt: number): boolean {
    return this.transaction(() => {
      const now = Date.now()
      if (!this.canBeginClip(now) || !this.begin(id, nextDecisionAt)) return false
      this.setDeadline(CLIP_COOLDOWN, now + AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS)
      return true
    })
  }

  cancel(id: string): boolean {
    const changed = this.db.prepare("UPDATE bilibili_candidate SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','reading')")
      .run(new Date().toISOString(), id)
    return !!changed.changes || !!this.db.prepare("SELECT 1 FROM bilibili_candidate WHERE id=? AND status='cancelled'").get(id)
  }

  finish(id: string, outcome: Outcome): boolean {
    return this.transaction(() => {
      const previous = outcome.status === 'skipped' ? 'queued' : 'reading'
      let receipt: string | null = null
      if (outcome.status === 'read') {
        const evidence = this.evidence(id, outcome.receipt.activityId)
        if (!evidence || evidence.at !== outcome.receipt.at || evidence.kind !== outcome.receipt.kind) return false
        if (!isDeepStrictEqual(evidence.clip, outcome.receipt.clip)) return false
        const actual = evidence.provenance
        const claimed = outcome.receipt.provenance
        if (actual ? claimed?.kind !== actual.kind || claimed.sha256 !== actual.sha256 : claimed !== undefined) return false
        receipt = JSON.stringify(evidence)
      }
      return !!this.db.prepare('UPDATE bilibili_candidate SET status=?,updated_at=?,receipt_json=?,error=? WHERE id=? AND status=?')
        .run(outcome.status, new Date().toISOString(), receipt, outcome.status === 'read' ? null : outcome.error ?? null, id, previous).changes
    })
  }

  recover(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM bilibili_candidate WHERE status='reading'").all()
      const update = this.db.prepare("UPDATE bilibili_candidate SET status=?,updated_at=?,receipt_json=?,error=? WHERE id=? AND status='reading'")
      for (const row of rows) {
        const id = String(row.id)
        const receipt = this.evidence(id)
        update.run(receipt ? 'read' : 'failed', new Date().toISOString(), receipt ? JSON.stringify(receipt) : null, receipt ? null : 'bili-interrupted', id)
      }
    })
  }

  verifiedCompletedClip(candidateId: string, readTaskId: string, activityId: number):
    { receipt: BilibiliReadReceipt & { clip: NonNullable<BilibiliReadReceipt['clip']> }; sessionId: string } | undefined {
    const candidate = this.get(candidateId)
    const recorded = candidate?.receipt
    if (candidate?.status !== 'read' || recorded?.kind !== 'video.clip-sampled' || recorded.activityId !== activityId ||
        candidate.sourceId && !this.sourceActive(candidate.sourceId)) return
    const receipt = this.evidence(candidateId, activityId, readTaskId)
    if (!receipt?.clip || !isDeepStrictEqual(receipt, recorded)) return
    const row = this.db.prepare(`SELECT a.session_id FROM activity a
      JOIN task t ON t.id=a.task_id AND t.context_id=? AND t.capability_id='core.autonomy' AND t.status='succeeded'
      JOIN autonomous_job j ON j.task_id=t.id AND j.context_id=t.context_id AND j.kind='bilibili.review'
      WHERE a.id=? AND a.task_id=? AND a.occurred_at>=t.created_at AND a.occurred_at<=? AND ?<=t.updated_at
      AND json_extract(j.payload_json,'$.candidateId')=? AND json_extract(j.payload_json,'$.activityId')=a.id
      AND (json_extract(j.payload_json,'$.dailyTaskId') IS NULL OR EXISTS (
        SELECT 1 FROM task p WHERE p.id=json_extract(j.payload_json,'$.dailyTaskId') AND p.context_id=?
        AND p.capability_id='core.autonomy' AND p.status='succeeded'))`)
      .get(BILIBILI_AUTONOMY_CONTEXT, activityId, readTaskId, candidate.updatedAt, candidate.updatedAt, candidateId, DAILY_AUTONOMY_CONTEXT)
    if (typeof row?.session_id !== 'string' || !row.session_id.trim()) return
    return { receipt: { ...receipt, clip: receipt.clip }, sessionId: row.session_id }
  }

  private evidence(id: string, activityId?: number, settledClipTask?: string): BilibiliReadReceipt | undefined {
    const row = this.db.prepare(`SELECT a.id, a.kind, a.occurred_at,
      json_extract(a.data_json,'$.subtitleOrigin') AS subtitle_origin, json_extract(a.data_json,'$.subtitleSha256') AS subtitle_sha256,
      json_extract(a.data_json,'$.start') AS clip_start, json_extract(a.data_json,'$.seconds') AS clip_seconds,
      json_type(a.data_json,'$.visual') AS clip_visual, json_type(a.data_json,'$.audio') AS clip_audio
      FROM activity a JOIN bilibili_candidate b
      ON b.id=? AND json_extract(a.data_json,'$.candidateId')=b.id
      WHERE a.source='media.bilibili' AND a.status='success' AND a.session_id IS NOT NULL
      AND ((a.context_id=? AND a.kind IN ('video.inspected','video.subtitle-read')) OR
           (a.context_id=? AND a.kind='video.clip-sampled' AND EXISTS (
             SELECT 1 FROM autonomous_job j WHERE j.task_id=a.task_id AND j.kind='bilibili.review' AND j.context_id=?
             AND json_extract(j.payload_json,'$.candidateId')=b.id
             AND (json_extract(j.payload_json,'$.dailyTaskId') IS NULL OR EXISTS (
               SELECT 1 FROM autonomous_job d WHERE d.task_id=json_extract(j.payload_json,'$.dailyTaskId')
               AND d.kind='daily.choice' AND d.context_id=? AND j.dedupe_key=d.dedupe_key || ':bilibili'
               AND json_extract(d.payload_json,'$.choice')='bilibili' AND json_extract(d.payload_json,'$.activityTaskId')=j.task_id
               AND json_extract(j.payload_json,'$.clipRequest.start')=json_extract(a.data_json,'$.start')
               AND json_extract(j.payload_json,'$.clipRequest.seconds')=json_extract(a.data_json,'$.seconds')
               AND (json_extract(j.payload_json,'$.clipRequest.mode')='both' OR
                    (json_extract(j.payload_json,'$.clipRequest.mode')='visual' AND json_type(a.data_json,'$.audio')='false') OR
                    (json_extract(j.payload_json,'$.clipRequest.mode')='audio' AND json_type(a.data_json,'$.visual')='false'))
             ))
           ))) AND (? IS NULL OR a.id=?)
      AND ((? IS NULL AND a.occurred_at>=b.updated_at) OR
           (a.task_id=? AND a.kind='video.clip-sampled' AND b.status='read' AND a.occurred_at>=b.created_at AND a.occurred_at<=b.updated_at))
      AND json_extract(a.data_json,'$.bvid')=b.bvid AND json_extract(a.data_json,'$.part')=b.part
      ORDER BY a.id DESC LIMIT 1`).get(id, BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_AUTONOMY_CONTEXT,
        DAILY_AUTONOMY_CONTEXT, activityId ?? null, activityId ?? null, settledClipTask ?? null, settledClipTask ?? null)
    if (!row) return
    const receipt = { activityId: Number(row.id), at: String(row.occurred_at), kind: row.kind as BilibiliReadReceipt['kind'] }
    if (receipt.kind === 'video.clip-sampled') {
      const start = Number(row.clip_start)
      const seconds = Number(row.clip_seconds)
      if (typeof row.clip_start !== 'number' || !Number.isSafeInteger(start) || start < 0 ||
          typeof row.clip_seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_AUTONOMOUS_BILIBILI_CLIP_SECONDS ||
          !['true', 'false'].includes(String(row.clip_visual)) || !['true', 'false'].includes(String(row.clip_audio)) ||
          row.clip_visual !== 'true' && row.clip_audio !== 'true' || row.subtitle_origin !== null || row.subtitle_sha256 !== null) return
      return { ...receipt, clip: { start, seconds, visual: row.clip_visual === 'true', audio: row.clip_audio === 'true' } }
    }
    if (row.subtitle_origin === null && row.subtitle_sha256 === null) return receipt
    if (receipt.kind !== 'video.subtitle-read' || row.subtitle_origin !== 'owner-supplied' || !isBilibiliSubtitleDigest(row.subtitle_sha256)) return
    return { ...receipt, provenance: { kind: 'owner-supplied', sha256: row.subtitle_sha256 } }
  }
}
