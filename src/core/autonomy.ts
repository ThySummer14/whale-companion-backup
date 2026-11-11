import type { DatabaseSync } from 'node:sqlite'
import type { MinecraftSurveyWindowRule } from '../protocol/api.ts'
import { MinecraftSurveyWindowRuleSchema } from './minecraft-survey-window.ts'
import type { AutonomousJob, AutonomousJobKind, AutonomySettings, JsonValue, TaskRecord } from './model.ts'
import { DAILY_AUTONOMY_CONTEXT, DEFAULT_AUTONOMY_SETTINGS } from './model.ts'

const SURVEY_WINDOW_STATE = 'autonomy.minecraftSurveyWindow'

interface AutonomyStoreHooks {
  createTask: (input: Pick<TaskRecord, 'capabilityId' | 'title' | 'contextId' | 'externalId'>, beforeActivity?: (task: TaskRecord) => void) => TaskRecord
  taskFromRow: (row: unknown) => TaskRecord
  transaction: <T>(operation: () => T) => T
}

export class AutonomyRepository {
  constructor(private readonly db: DatabaseSync, private readonly hooks: AutonomyStoreHooks) {}

  settings(): AutonomySettings {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get('autonomy.settings')
    const stored = row ? JSON.parse(String(row.value)) as Partial<AutonomySettings> | null : undefined
    return { ...DEFAULT_AUTONOMY_SETTINGS, ...stored, dailyInitiativeEnabled: stored?.dailyInitiativeEnabled === true,
      bilibiliClipsEnabled: stored?.bilibiliClipsEnabled === true,
      bilibiliClipShareEnabled: stored?.bilibiliClipShareEnabled === true,
      minecraftMilestonesEnabled: stored?.minecraftMilestonesEnabled === true,
      minecraftRecoveryEnabled: stored?.minecraftRecoveryEnabled === true,
      minecraftRecoveryPlacementEnabled: stored?.minecraftRecoveryPlacementEnabled === true,
      minecraftRecoveryContinuousEnabled: stored?.minecraftRecoveryContinuousEnabled === true }
  }

  saveSettings(settings: AutonomySettings): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      'autonomy.settings', JSON.stringify({ ...settings, dailyInitiativeEnabled: settings.dailyInitiativeEnabled === true,
        bilibiliClipsEnabled: settings.bilibiliClipsEnabled === true,
        bilibiliClipShareEnabled: settings.bilibiliClipShareEnabled === true,
        minecraftMilestonesEnabled: settings.minecraftMilestonesEnabled === true,
        minecraftRecoveryEnabled: settings.minecraftRecoveryEnabled === true,
        minecraftRecoveryPlacementEnabled: settings.minecraftRecoveryPlacementEnabled === true,
        minecraftRecoveryContinuousEnabled: settings.minecraftRecoveryContinuousEnabled === true }))
  }

  surveyWindow(): MinecraftSurveyWindowRule | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(SURVEY_WINDOW_STATE)
    if (!row) return undefined
    try {
      const parsed = MinecraftSurveyWindowRuleSchema.safeParse(JSON.parse(String(row.value)))
      if (parsed.success) return parsed.data
    } catch { /* Invalid persisted data cannot grant a window. */ }
  }

  saveSurveyWindow(rule: MinecraftSurveyWindowRule | null): void {
    const checked = rule === null ? null : MinecraftSurveyWindowRuleSchema.parse(rule)
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SURVEY_WINDOW_STATE, JSON.stringify(checked))
  }

  lastMemoryArchiveAt(): number | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get('autonomy.lastMemoryArchiveAt')
    const at = Number(row?.value)
    return Number.isSafeInteger(at) && at > 0 ? at : undefined
  }

  recordMemoryArchiveAt(at: number): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('autonomy.lastMemoryArchiveAt', String(at))
  }

  decision(value: string): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('autonomy.lastDecision', value)
  }

  lastDecision(): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get('autonomy.lastDecision')
    return row ? String(row.value) : undefined
  }

  memoryReviewCheckpoint(contextId: string): { sessionId: string; turnSeq: number } | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(`autonomy.memoryReviewed:${contextId}`)
    return row ? JSON.parse(String(row.value)) as { sessionId: string; turnSeq: number } : undefined
  }

  recordMemoryReviewCheckpoint(contextId: string, sessionId: string, turnSeq: number): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`autonomy.memoryReviewed:${contextId}`, JSON.stringify({ sessionId, turnSeq }))
  }

  create(input: { kind: AutonomousJobKind; contextId: string; dedupeKey: string; runAfter: number; payload?: Record<string, JsonValue>; maxAttempts?: number }): AutonomousJob {
    const title = {
      'memory.review': '整理场景长期记忆',
      'feed.review': '评估是否发布自主动态',
      'feed.reply': '评估是否回应用户动态',
      'minecraft.event': '处理 Minecraft 世界事件',
      'minecraft.share': '评估是否分享 Minecraft 经历',
      'minecraft.supply': input.payload?.goal === 'survey' ? '评估是否执行营地往返探索'
        : input.payload?.goal === 'prepare' ? '评估是否备料并搭建营地'
          : input.payload?.goal === 'camp' ? '评估是否自主搭建一次营地' : '评估是否执行一次营地补给',
      'minecraft.recovery': '判断小屋施工中断后的下一步',
      'bilibili.review': '评估是否自主阅读 B 站视频',
      'bilibili.reflect': '整理有出处的 B 站阅读反思',
      'bilibili.share': '评估是否分享 B 站阅读感想',
      'daily.choice': '选择今日的自主活动',
      'daily.reflect': '回看有回执的自主经历',
    }[input.kind]
    const task = this.hooks.createTask({
      capabilityId: 'core.autonomy',
      title,
      contextId: input.contextId,
      externalId: `autonomy:${input.kind}:${input.dedupeKey}`,
    }, current => {
      this.db.prepare(`INSERT INTO autonomous_job
        (task_id,kind,context_id,dedupe_key,run_after,payload_json,attempts,max_attempts,lease_until,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        current.id, input.kind, input.contextId, input.dedupeKey, input.runAfter,
        JSON.stringify(input.payload ?? {}), 0, input.maxAttempts ?? 3, null, null,
        current.createdAt, current.updatedAt,
      )
    })
    return this.get(task.id)!
  }

  get(taskId: string): AutonomousJob | undefined {
    const row = this.db.prepare('SELECT * FROM autonomous_job WHERE task_id=?').get(taskId)
    return row ? this.fromRow(row) : undefined
  }

  due(now: number): AutonomousJob | undefined {
    const row = this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id
      WHERE t.status='accepted' AND j.run_after<=? ORDER BY j.run_after,j.created_at LIMIT 1`).get(now)
    return row ? this.fromRow(row) : undefined
  }

  pending(kind: AutonomousJobKind, contextId: string): AutonomousJob | undefined {
    const row = this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id
      WHERE j.kind=? AND j.context_id=? AND t.status IN ('accepted','running') ORDER BY j.run_after DESC LIMIT 1`).get(kind, contextId)
    return row ? this.fromRow(row) : undefined
  }

  open(kind: AutonomousJobKind, contextId?: string): AutonomousJob[] {
    return this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id
      WHERE j.kind=? AND t.status IN ('accepted','running') ${contextId === undefined ? '' : 'AND j.context_id=?'}
      ORDER BY j.run_after,j.created_at`).all(kind, ...(contextId === undefined ? [] : [contextId])).map(row => this.fromRow(row))
  }

  list(limit = 50): AutonomousJob[] {
    return this.db.prepare('SELECT * FROM autonomous_job ORDER BY updated_at DESC, created_at DESC LIMIT ?').all(limit).map(row => this.fromRow(row))
  }

  latestCampVisit(): AutonomousJob | undefined {
    const row = this.db.prepare(`SELECT * FROM autonomous_job WHERE kind='daily.choice'
      AND json_type(payload_json, '$.visitId')='text' ORDER BY created_at DESC LIMIT 1`).get()
    return row ? this.fromRow(row) : undefined
  }

  latestCampPatrol(): AutonomousJob | undefined {
    return this.latestCampActivity('patrol')
  }

  latestCampGather(): AutonomousJob | undefined {
    return this.latestCampActivity('gather')
  }

  private latestCampActivity(choice: 'patrol' | 'gather'): AutonomousJob | undefined {
    const row = this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      WHERE j.kind='daily.choice' AND j.context_id=? AND t.capability_id='core.autonomy'
      AND t.external_id='autonomy:daily.choice:' || j.dedupe_key
      AND j.dedupe_key='daily:' || json_extract(j.payload_json,'$.date')
      AND json_extract(j.payload_json,'$.choice')=?
      AND json_extract(j.payload_json,'$.visitId')=j.task_id
      AND json_type(j.payload_json,'$.visitExpiresAt')='integer' AND json_extract(j.payload_json,'$.visitExpiresAt')>0
      AND json_extract(j.payload_json,'$.visitStatus') IN ('starting','online','offline','unconfirmed')
      ORDER BY j.created_at DESC,j.task_id DESC LIMIT 1`).get(DAILY_AUTONOMY_CONTEXT, choice)
    return row ? this.fromRow(row) : undefined
  }

  unsettledCampVisit(since: number): AutonomousJob | undefined {
    const row = this.db.prepare(`SELECT * FROM autonomous_job WHERE kind='daily.choice'
      AND json_extract(payload_json, '$.visitStatus') IN ('starting','online','unconfirmed')
      AND json_type(payload_json, '$.visitExpiresAt')='integer' AND json_extract(payload_json, '$.visitExpiresAt')>=?
      ORDER BY created_at DESC LIMIT 1`).get(since)
    return row ? this.fromRow(row) : undefined
  }

  recentInitiativeJobs(beforeDate: string, since: string, through: string): AutonomousJob[] {
    return this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      WHERE j.kind='daily.choice' AND j.context_id=? AND t.capability_id='core.autonomy'
        AND t.external_id='autonomy:daily.choice:' || j.dedupe_key
        AND j.dedupe_key='daily:' || json_extract(j.payload_json,'$.date')
        AND json_extract(j.payload_json,'$.date')<?
        AND json_type(j.payload_json,'$.initiativeRequested')='true'
        AND json_type(j.payload_json,'$.initiative')='object'
        AND j.created_at>=? AND t.updated_at<=?
        AND (t.status='succeeded' OR t.status='cancelled' AND json_extract(j.payload_json,'$.choice')='skip'
          AND json_type(j.payload_json,'$.activityTaskId') IS NULL AND json_type(j.payload_json,'$.visitId') IS NULL
          OR t.status IN ('failed','cancelled') AND json_extract(j.payload_json,'$.initiativeAttempt') IN ('minecraft','bilibili'))
      ORDER BY j.created_at ASC,j.task_id ASC LIMIT 16`).all(DAILY_AUTONOMY_CONTEXT, beforeDate, since, through)
      .map(row => this.fromRow(row))
  }

  succeeded(kind: AutonomousJobKind, contextId: string, limit: number): AutonomousJob[] {
    return this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id
      WHERE j.kind=? AND j.context_id=? AND t.status='succeeded'
      ORDER BY t.updated_at DESC, j.task_id DESC LIMIT ?`).all(kind, contextId, limit).map(row => this.fromRow(row))
  }

  campProjectDays(ruleId: string): AutonomousJob[] {
    return this.db.prepare(`SELECT j.* FROM autonomous_job j JOIN task t ON t.id=j.task_id AND t.context_id=j.context_id
      WHERE j.kind='daily.choice' AND j.context_id=? AND t.status IN ('succeeded','failed','cancelled') AND t.capability_id='core.autonomy'
      AND json_extract(j.payload_json,'$.windowRuleId')=?
      AND j.dedupe_key='daily:' || json_extract(j.payload_json,'$.date')
      ORDER BY j.created_at ASC,j.task_id ASC LIMIT 7`).all(DAILY_AUTONOMY_CONTEXT, ruleId).map(row => this.fromRow(row))
  }

  update(taskId: string, patch: { runAfter?: number; payload?: Record<string, JsonValue>; attempts?: number; leaseUntil?: number | null; lastError?: string | null }): void {
    const values = new Map<string, string | number | null>()
    if (patch.runAfter !== undefined) values.set('run_after', patch.runAfter)
    if (patch.payload !== undefined) values.set('payload_json', JSON.stringify(patch.payload))
    if (patch.attempts !== undefined) values.set('attempts', patch.attempts)
    if (patch.leaseUntil !== undefined) values.set('lease_until', patch.leaseUntil)
    if (patch.lastError !== undefined) values.set('last_error', patch.lastError)
    if (!values.size) return
    values.set('updated_at', new Date().toISOString())
    const assignments = [...values.keys()].map(key => `${key}=?`).join(',')
    this.db.prepare(`UPDATE autonomous_job SET ${assignments} WHERE task_id=?`).run(...values.values(), taskId)
  }

  private fromRow(row: unknown): AutonomousJob {
    const value = row as {
      task_id: string; kind: AutonomousJobKind; context_id: string; dedupe_key: string; run_after: number; payload_json: string
      attempts: number; max_attempts: number; lease_until: number | null; last_error: string | null; created_at: string; updated_at: string
    }
    return {
      id: value.task_id,
      kind: value.kind,
      contextId: value.context_id,
      dedupeKey: value.dedupe_key,
      runAfter: Number(value.run_after),
      payload: JSON.parse(value.payload_json) as Record<string, JsonValue>,
      attempts: Number(value.attempts),
      maxAttempts: Number(value.max_attempts),
      leaseUntil: value.lease_until ?? undefined,
      lastError: value.last_error ?? undefined,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      task: this.hooks.taskFromRow(this.db.prepare('SELECT * FROM task WHERE id=?').get(value.task_id)),
    }
  }
}
