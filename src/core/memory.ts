import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ActivityInput, MemoryCounts, MemoryKind, MemoryRecord, MemoryRevision, MemoryScope, MemorySourceRef, MemoryStatus } from './model.ts'

export interface MemoryWrite {
  kind: MemoryKind
  content: string
  scope?: MemoryScope
  contextId?: string
  status?: MemoryStatus
  importance?: number
  confidence?: number
  pinned?: boolean
  sourceRefs?: MemorySourceRef[]
  actorSessionId?: string
  reason?: string
}

export interface MemoryListOptions {
  status?: MemoryStatus | 'active+candidate' | 'all'
  kind?: MemoryKind
  contextId?: string
  pinned?: boolean
  limit?: number
}

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '怎么', '什么', '可以', '一下', '现在', '还是', '就是', '知道', '告诉', '记得', '今天', '明天', '昨天',
  '我想', '我要', '你说', '问我', '帮我', '陪着', '一起', '然后', '因为', '所以', '如果', '已经', '正在', '不是', '没有', '一个', '一些', '觉得',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'my', 'me', 'you', 'your', 'what', 'how', 'please', 'remember',
])

function score(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.min(1, value ?? fallback))
}

function tokens(text: string): string[] {
  const normalized = text.toLowerCase()
  const values = new Set<string>()
  for (const match of normalized.match(/[a-z0-9_][a-z0-9_.-]{1,}/g) ?? []) {
    if (!STOP_WORDS.has(match)) values.add(match)
  }
  for (const match of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (match.length <= 4 && !STOP_WORDS.has(match)) values.add(match)
    for (let index = 0; index < match.length - 1; index++) {
      const token = match.slice(index, index + 2)
      if (!STOP_WORDS.has(token)) values.add(token)
    }
  }
  return [...values].filter(token => token.length >= 2)
}

export function lexicalMatcher(query: string): (content: string) => number {
  const normalized = query.trim().normalize('NFKC').toLowerCase()
  const needle = normalized.length <= 1600 ? normalized : `${normalized.slice(0, 800)}\n${normalized.slice(-799)}`
  if (!needle) return () => 0
  const terms = tokens(needle).map(token => ({ token, weight: token.length >= 4 ? 1 : token.length === 3 ? 0.8 : 0.6 }))
  const total = terms.reduce((sum, term) => sum + term.weight, 0)
  return content => {
    const haystack = content.normalize('NFKC').toLowerCase()
    const exact = needle.length >= 2 && haystack.includes(needle) ? 1 : 0
    let matched = 0
    for (const { token, weight } of terms) if (haystack.includes(token)) matched += weight
    return Math.min(1.5, exact + (total ? matched / total : 0))
  }
}

const MEMORY_ORDER = 'pinned DESC, importance DESC, updated_at DESC, id DESC'
const DAY_MS = 86_400_000
const ARCHIVE_AGE_MS = 60 * DAY_MS
const ARCHIVE_LIMIT = 50
const ARCHIVE_RETENTION_LIMIT = 0.35
const ARCHIVE_POLICY_REASON = '低重要度，且长期未修订或召回'

type ArchiveCandidate = { id: string; updatedAt: string }
type ArchivePreview = ArchiveCandidate & Pick<MemoryRecord, 'scope' | 'contextId'> & { retention: number; excerpt: string }
type ArchivableMemory = MemoryRecord & { status: 'active' | 'candidate'; retention: number }

function elapsedMs(now: number, ...dates: (string | undefined)[]): number {
  return Math.max(0, now - Math.max(0, ...dates.map(value => value ? Date.parse(value) || 0 : 0)))
}

function retention(now: number, count: number, createdAt: string, lastReinforcedAt?: string): number {
  const repetition = 1 - Math.exp(-count / 4)
  const halfLifeDays = 35 + 55 * repetition
  const days = elapsedMs(now, createdAt, lastReinforcedAt) / DAY_MS
  return (0.6 + 0.4 * repetition) * 2 ** (-days / halfLifeDays)
}

function canArchiveByAge(memory: MemoryRecord, now: number): memory is ArchivableMemory {
  const { createdAt, updatedAt, lastUsedAt, lastReinforcedAt } = memory
  const dates = [createdAt, updatedAt, lastUsedAt, ...(lastReinforcedAt === undefined ? [] : [lastReinforcedAt])]
  return (memory.status === 'active' || memory.status === 'candidate') && !memory.pinned && memory.importance < 0.4 &&
    dates.every(value => Number.isFinite(Date.parse(value))) && elapsedMs(now, ...dates) >= ARCHIVE_AGE_MS &&
    memory.retention !== undefined && memory.retention < ARCHIVE_RETENTION_LIMIT &&
    !(memory.confidence >= 0.8 && memory.sourceRefs.some(ref => ref.eventSeq !== undefined || ref.activityId !== undefined || ref.taskId))
}

export class MemoryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly recordActivity: (input: ActivityInput) => number,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  private fromRow(row: unknown, now = Date.now()): MemoryRecord {
    const value = row as {
      id: string; kind: MemoryKind; content: string; scope: MemoryScope; context_id: string | null; status: MemoryStatus
      importance: number; confidence: number; pinned: number; recall_count: number; source_refs: string
      created_at: string; updated_at: string; last_used_at: string; forget_reason: string | null
      reinforcement_count: number; last_reinforced_at: string | null; archived_from: 'active' | 'candidate' | null; archive_reason: string | null
    }
    return {
      id: value.id,
      kind: value.kind,
      content: value.content,
      scope: value.scope,
      contextId: value.context_id ?? undefined,
      status: value.status,
      importance: Number(value.importance),
      confidence: Number(value.confidence),
      pinned: value.pinned === 1,
      recallCount: Number(value.recall_count),
      reinforcementCount: Number(value.reinforcement_count),
      lastReinforcedAt: value.last_reinforced_at ?? undefined,
      retention: retention(now, Number(value.reinforcement_count), value.created_at, value.last_reinforced_at ?? undefined),
      sourceRefs: JSON.parse(value.source_refs) as MemorySourceRef[],
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      lastUsedAt: value.last_used_at,
      forgetReason: value.forget_reason ?? undefined,
      archivedFrom: value.archived_from ?? undefined,
      archiveReason: value.archive_reason ?? undefined,
    }
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memory WHERE id=?').get(id)
    return row ? this.fromRow(row) : undefined
  }

  contextMemoryForTask(contextId: string, taskId: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memory WHERE context_id=? AND scope='context'
      AND EXISTS (SELECT 1 FROM json_each(memory.source_refs) WHERE json_extract(value,'$.taskId')=?) LIMIT 1`).get(contextId, taskId)
    return row ? this.fromRow(row) : undefined
  }

  private filter(options: MemoryListOptions): { where: string; parameters: (string | number)[] } {
    const conditions: string[] = []
    const parameters: (string | number)[] = []
    const status = options.status ?? 'active'
    if (status === 'active+candidate') {
      conditions.push("status IN ('active','candidate')")
    } else if (status !== 'all') {
      conditions.push('status=?')
      parameters.push(status)
    }
    if (options.kind) {
      conditions.push('kind=?')
      parameters.push(options.kind)
    }
    if (options.contextId) {
      conditions.push("(scope='shared' OR context_id=?)")
      parameters.push(options.contextId)
    }
    if (options.pinned !== undefined) {
      conditions.push('pinned=?')
      parameters.push(options.pinned ? 1 : 0)
    }
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', parameters }
  }

  list(options: MemoryListOptions = {}): MemoryRecord[] {
    const { where, parameters } = this.filter(options)
    const limit = Math.max(1, Math.min(500, options.limit ?? 200))
    return this.db.prepare(`SELECT * FROM memory ${where} ORDER BY ${MEMORY_ORDER} LIMIT ?`)
      .all(...parameters, limit).map(row => this.fromRow(row))
  }

  find(query: string, options: MemoryListOptions = {}): MemoryRecord[] {
    if (!query.trim()) return []
    const { where, parameters } = this.filter(options)
    const requested = options.limit ?? 6
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.trunc(requested))) : 6
    const match = lexicalMatcher(query)
    const now = Date.now()
    const ranked: { id: string; rank: number }[] = []
    const rows = this.db.prepare(`SELECT id, content, importance, confidence, created_at, updated_at, last_used_at,
      reinforcement_count, last_reinforced_at FROM memory ${where} ORDER BY ${MEMORY_ORDER}`)
      .iterate(...parameters) as Iterable<{
        id: string; content: string; importance: number; confidence: number; created_at: string; updated_at: string
        last_used_at: string; reinforcement_count: number; last_reinforced_at: string | null
      }>
    for (const row of rows) {
      const lexical = match(row.content)
      if (lexical <= 0.05) continue
      const usageRecency = Math.exp(-elapsedMs(now, row.updated_at, row.last_used_at) / (30 * DAY_MS))
      const strength = retention(now, row.reinforcement_count, row.created_at, row.last_reinforced_at ?? undefined)
      const rank = lexical * 0.65 + row.importance * 0.14 + row.confidence * 0.1 + usageRecency * 0.03 + strength * 0.08
      const index = ranked.findIndex(item => item.rank < rank)
      if (index >= 0) ranked.splice(index, 0, { id: row.id, rank })
      else if (ranked.length < limit) ranked.push({ id: row.id, rank })
      if (ranked.length > limit) ranked.pop()
    }
    return ranked.map(({ id }) => this.get(id)!)
  }

  search(query: string, options: MemoryListOptions = {}): MemoryRecord[] {
    return this.recordRecall(this.find(query, options))
  }

  recordRecall(memories: readonly MemoryRecord[]): MemoryRecord[] {
    if (!memories.length) return []
    const lastUsedAt = new Date().toISOString()
    const unique = new Map(memories.map(memory => [memory.id, memory]))
    return this.transaction(() => {
      const update = this.db.prepare(`UPDATE memory SET recall_count=recall_count+1, last_used_at=?
        WHERE id=? AND scope=? AND context_id IS ? AND status IN ('active','candidate') RETURNING *`)
      const recalled: MemoryRecord[] = []
      for (const { id, scope, contextId } of unique.values()) {
        const row = update.get(lastUsedAt, id, scope, contextId ?? null)
        if (row) recalled.push(this.fromRow(row))
      }
      return recalled
    })
  }

  reinforce(memories: readonly MemoryRecord[], query: string, now = new Date()): void {
    if (!memories.length || !query.trim()) return
    const match = lexicalMatcher(query)
    const timestamp = now.toISOString()
    const dayStart = `${timestamp.slice(0, 10)}T00:00:00.000Z`
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE memory SET reinforcement_count=reinforcement_count+1, last_reinforced_at=?
        WHERE id=? AND status='active' AND (last_reinforced_at IS NULL OR last_reinforced_at<?)`)
      for (const { id, scope, contextId } of memories) {
        const current = this.get(id)
        if (current?.status === 'active' && current.scope === scope && current.contextId === contextId && match(current.content) >= 0.65) {
          update.run(timestamp, id, dayStart)
        }
      }
    })
  }

  create(input: MemoryWrite): MemoryRecord {
    if (input.status === 'archived') throw new Error('memory-archive-state')
    const duplicate = this.db.prepare('SELECT id FROM memory WHERE lower(trim(content))=lower(trim(?)) AND scope=? AND context_id IS ? LIMIT 1')
      .get(input.content, input.scope ?? 'context', input.contextId ?? null)
    if (duplicate) return this.get(String(duplicate.id))!
    const now = new Date().toISOString()
    const confidence = score(input.confidence, 0.7)
    const memory: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content.trim(),
      scope: input.scope ?? 'context',
      contextId: input.contextId,
      status: input.status ?? (confidence >= 0.8 ? 'active' : 'candidate'),
      importance: score(input.importance, 0.5),
      confidence,
      pinned: input.pinned === true,
      recallCount: 0,
      reinforcementCount: 0,
      retention: 0.6,
      sourceRefs: input.sourceRefs ?? [],
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO memory
        (id, kind, content, scope, context_id, status, importance, confidence, pinned, recall_count, source_refs, created_at, updated_at, last_used_at, forget_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        memory.id, memory.kind, memory.content, memory.scope, memory.contextId ?? null, memory.status,
        memory.importance, memory.confidence, memory.pinned ? 1 : 0, 0, JSON.stringify(memory.sourceRefs), now, now, now, null,
      )
      this.addRevision(memory, input.actorSessionId, input.reason ?? 'create')
      this.recordActivity({
        contextId: memory.contextId,
        sessionId: input.actorSessionId,
        source: 'core.memory',
        kind: 'memory.created',
        summary: `新增${memory.kind}记忆（${memory.status}）`,
        data: { memoryId: memory.id, status: memory.status, scope: memory.scope },
      })
    })
    return memory
  }

  update(id: string, input: Partial<MemoryWrite>): MemoryRecord {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Memory not found')
      if ((input.status === 'archived' && current.status !== 'archived') ||
        (current.status === 'archived' && (input.pinned === true || input.status !== undefined && input.status !== 'archived'))) {
        throw new Error('memory-archive-state')
      }
      return this.updateRecord(current, input)
    })
  }

  private updateRecord(current: MemoryRecord, input: Partial<MemoryWrite>, archivedFrom?: 'active' | 'candidate'): MemoryRecord {
    const confidence = score(input.confidence, current.confidence)
    const status = input.status ?? (confidence < 0.8 && current.status === 'active' && !current.pinned ? 'candidate' : current.status)
    const sourceRefs = input.sourceRefs
      ? [...new Map([...current.sourceRefs, ...input.sourceRefs].map(ref => [JSON.stringify(ref), ref])).values()].slice(-20)
      : current.sourceRefs
    const now = new Date().toISOString()
    const next: MemoryRecord = {
      ...current,
      kind: input.kind ?? current.kind,
      content: input.content?.trim() || current.content,
      scope: input.scope ?? current.scope,
      contextId: input.contextId === undefined ? current.contextId : input.contextId,
      status,
      importance: score(input.importance, current.importance),
      confidence,
      pinned: input.pinned ?? current.pinned,
      sourceRefs,
      updatedAt: now,
      retention: retention(Date.parse(now), current.reinforcementCount ?? 0, current.createdAt, current.lastReinforcedAt),
      forgetReason: status === 'forgotten' ? input.reason ?? current.forgetReason : undefined,
      archivedFrom: status === 'archived' ? archivedFrom ?? current.archivedFrom : undefined,
      archiveReason: status === 'archived' ? archivedFrom ? input.reason : current.archiveReason : undefined,
    }
    this.db.prepare(`UPDATE memory SET kind=?, content=?, scope=?, context_id=?, status=?, importance=?, confidence=?, pinned=?,
      source_refs=?, updated_at=?, forget_reason=?, archived_from=?, archive_reason=? WHERE id=?`).run(
      next.kind, next.content, next.scope, next.contextId ?? null, next.status, next.importance, next.confidence,
      next.pinned ? 1 : 0, JSON.stringify(next.sourceRefs), next.updatedAt, next.forgetReason ?? null,
      next.archivedFrom ?? null, next.archiveReason ?? null, next.id,
    )
    this.addRevision(next, input.actorSessionId, input.reason ?? 'update')
    const transition = status === 'forgotten' ? 'forgotten'
      : archivedFrom ? 'archived'
      : status !== current.status && (current.status === 'archived' || current.status === 'forgotten') ? 'restored'
      : current.status === 'candidate' && status === 'active' ? 'confirmed' : 'updated'
    this.recordActivity({
      contextId: next.contextId,
      sessionId: input.actorSessionId,
      source: 'core.memory',
      kind: `memory.${transition}`,
      summary: `修订记忆 ${next.id}（${current.status} → ${status}）`,
      status: status === 'forgotten' ? 'warning' : 'success',
      data: { memoryId: next.id, previousStatus: current.status, status },
    })
    return next
  }

  archive(id: string, reason = '手动归档'): MemoryRecord {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Memory not found')
      if (current.pinned) throw new Error('memory-archive-protected')
      if (current.status !== 'active' && current.status !== 'candidate') throw new Error('memory-archive-state')
      return this.updateRecord(current, { status: 'archived', reason }, current.status)
    })
  }

  restore(id: string, reason = '手动恢复'): MemoryRecord {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Memory not found')
      const status = current.status === 'archived' ? current.archivedFrom
        : current.status === 'forgotten' ? current.confidence >= 0.8 ? 'active' : 'candidate' : undefined
      if (!status) throw new Error('memory-archive-state')
      return this.updateRecord(current, { status, reason })
    })
  }

  previewArchive(now = new Date()): ArchivePreview[] {
    const timestamp = now.getTime()
    const cutoff = new Date(timestamp - ARCHIVE_AGE_MS).toISOString()
    const rows = this.db.prepare(`SELECT * FROM memory WHERE status IN ('active','candidate') AND pinned=0 AND importance<0.4
      AND created_at<=? AND updated_at<=? AND last_used_at<=? AND (last_reinforced_at IS NULL OR last_reinforced_at<=?)
      ORDER BY updated_at, id`).iterate(cutoff, cutoff, cutoff, cutoff)
    const preview: ArchivePreview[] = []
    for (const row of rows) {
      const memory = this.fromRow(row, timestamp)
      if (!canArchiveByAge(memory, timestamp)) continue
      const { id, updatedAt, scope, contextId, retention } = memory
      preview.push({ id, updatedAt, scope, contextId, retention, excerpt: Array.from(memory.content).slice(0, 120).join('') })
      if (preview.length === ARCHIVE_LIMIT) break
    }
    return preview
  }

  archiveStale(entries: readonly ArchiveCandidate[], now = new Date()): { archived: number; skipped: number } {
    const timestamp = now.getTime()
    return this.transaction(() => {
      const lookup = this.db.prepare('SELECT * FROM memory WHERE id=? AND updated_at=?')
      let archived = 0
      for (const { id, updatedAt } of entries.slice(0, ARCHIVE_LIMIT)) {
        const row = lookup.get(id, updatedAt)
        if (!row) continue
        const current = this.fromRow(row, timestamp)
        if (!canArchiveByAge(current, timestamp)) continue
        this.updateRecord(current, { status: 'archived', reason: ARCHIVE_POLICY_REASON }, current.status)
        archived++
      }
      return { archived, skipped: entries.length - archived }
    })
  }

  private addRevision(memory: MemoryRecord, actorSessionId: string | undefined, reason: string): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM memory_revision WHERE memory_id=?').get(memory.id) as { revision: number }
    this.db.prepare('INSERT INTO memory_revision (memory_id, revision, snapshot, actor_session_id, reason, created_at) VALUES (?,?,?,?,?,?)')
      .run(memory.id, row.revision, JSON.stringify(memory), actorSessionId ?? null, reason, new Date().toISOString())
  }

  revisions(memoryId: string, limit = 50): MemoryRevision[] {
    return this.db.prepare('SELECT * FROM memory_revision WHERE memory_id=? ORDER BY revision DESC LIMIT ?').all(memoryId, limit).map(row => {
      const value = row as { id: number; memory_id: string; revision: number; snapshot: string; actor_session_id: string | null; reason: string; created_at: string }
      return {
        id: Number(value.id),
        memoryId: value.memory_id,
        revision: Number(value.revision),
        snapshot: JSON.parse(value.snapshot) as MemoryRecord,
        actorSessionId: value.actor_session_id ?? undefined,
        reason: value.reason,
        createdAt: value.created_at,
      }
    })
  }

  counts(): MemoryCounts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM memory GROUP BY status').all() as { status: MemoryStatus; count: number }[]
    return {
      active: Number(rows.find(row => row.status === 'active')?.count ?? 0),
      candidate: Number(rows.find(row => row.status === 'candidate')?.count ?? 0),
      forgotten: Number(rows.find(row => row.status === 'forgotten')?.count ?? 0),
      archived: Number(rows.find(row => row.status === 'archived')?.count ?? 0),
    }
  }

  maintain(now = new Date()): number {
    const cutoff = new Date(now.getTime() - 60 * 86_400_000).toISOString()
    const candidates = this.db.prepare(`SELECT id FROM memory
      WHERE pinned=0 AND status IN ('active','candidate') AND importance<0.4 AND recall_count=0 AND updated_at<?
      ORDER BY updated_at, id LIMIT 500`).all(cutoff) as { id: string }[]
    for (const { id } of candidates) this.update(id, { status: 'forgotten', reason: '低重要度且 60 天未召回' })
    return candidates.length
  }
}
