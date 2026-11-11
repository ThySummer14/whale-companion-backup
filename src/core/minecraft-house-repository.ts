import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MinecraftHouseDraft, MinecraftHouseLayout, type MinecraftHouseDraftInput, type MinecraftHouseReceipt,
  type MinecraftHouseRevisionHistory, type MinecraftHouseRevisionInput } from './minecraft-house.ts'
import { HOUSE_CELL_CAPABILITY, HOUSE_CELL_TASK_PREFIX, type HouseRecoveryPlacedCell, type HouseRecoveryPlacementMode } from './minecraft-recovery.ts'
import { MINECRAFT_RECOVERY_CONTEXT } from './model.ts'

export const MINECRAFT_HOUSE_CAPABILITY = 'minecraft.house'
export const MINECRAFT_HOUSE_EVENT = 'world.house-built'
export const MINECRAFT_HOUSE_RECOVERY_EVENT = 'world.house-recovery'
export const MINECRAFT_HOUSE_RECOVERY_PREFIX = 'minecraft-house-recovery:'

export function minecraftHouseBuildSummary(receipt: MinecraftHouseReceipt): string {
  return `在主人授权地块按蓝图搭完小屋，核对 ${receipt.checked} 处位置，本次放置 ${receipt.placed} 块。`
}

type Draft = ReturnType<typeof MinecraftHouseDraft.parse>
type DraftRow = {
  id: string; zone_id: string | null; payload_json: string; created_at: string; status: Draft['status']; receipt_json: string | null;
  layout_revision: number; source_session_id: string
}
type RevisionRow = { revision: number; blocks: string; created_at: string }
type RecoveryOutcome = 'started' | 'placed' | 'blocked' | 'already-present' | 'unconfirmed'
type RecoveryCell = HouseRecoveryPlacedCell & { taskId: string; mode: HouseRecoveryPlacementMode; outcome: RecoveryOutcome; settledAt: string | null }

const CURRENT_REVISION = 'COALESCE((SELECT MAX(revision) FROM minecraft_house_revision WHERE house_id=minecraft_house.id),0)'
const SELECT_DRAFTS = `SELECT minecraft_house.*, ${CURRENT_REVISION} AS layout_revision FROM minecraft_house`

export class MinecraftHouseRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  private draft(row: unknown): Draft | undefined {
    if (!row) return
    const value = row as DraftRow
    return MinecraftHouseDraft.parse({ ...JSON.parse(value.payload_json), id: value.id, createdAt: value.created_at, status: value.status,
      revision: value.layout_revision,
      ...(value.zone_id && { zoneId: value.zone_id }), ...(value.receipt_json && { receipt: JSON.parse(value.receipt_json) }) })
  }

  list(): Draft[] {
    return this.db.prepare(`${SELECT_DRAFTS} ORDER BY created_at DESC, id DESC LIMIT 40`).all().map(row => this.draft(row)!)
  }

  get(id: string): Draft | undefined {
    return this.draft(this.db.prepare(`${SELECT_DRAFTS} WHERE id=?`).get(id))
  }

  latestAttempt(id: string): string | undefined {
    const row = this.db.prepare('SELECT attempt_task_id FROM minecraft_house WHERE id=?').get(id)
    return typeof row?.attempt_task_id === 'string' ? row.attempt_task_id : undefined
  }

  interruptedByAttempt(taskId: string): Draft | undefined {
    const rows = this.db.prepare(`${SELECT_DRAFTS} WHERE attempt_task_id=? AND status='interrupted' LIMIT 2`).all(taskId)
    return rows.length === 1 ? this.draft(rows[0]) : undefined
  }

  recentInterruptedAttempts(since: string): string[] {
    return this.db.prepare(`SELECT t.id FROM task t JOIN minecraft_house h ON h.attempt_task_id=t.id
      WHERE h.status='interrupted' AND t.capability_id=? AND t.status='failed' AND t.updated_at>=?
      ORDER BY t.updated_at DESC,t.id DESC LIMIT 16`).all(MINECRAFT_HOUSE_CAPABILITY, since).map(row => String(row.id))
  }

  recoveryCells(sourceTaskId: string): RecoveryCell[] {
    return this.db.prepare(`SELECT cell_index AS "index", material, task_id AS taskId, mode, outcome, settled_at AS settledAt
      FROM minecraft_house_recovery_cell WHERE source_task_id=? ORDER BY rowid`).all(sourceTaskId) as RecoveryCell[]
  }

  hasUnjournaledRecoveryCell(sourceTaskId: string): boolean {
    const prefix = `${HOUSE_CELL_TASK_PREFIX}${sourceTaskId}:`
    return !!this.db.prepare(`SELECT 1 FROM task t WHERE t.external_id>=? AND t.external_id<? AND t.capability_id=? AND t.context_id=?
      AND NOT EXISTS (SELECT 1 FROM minecraft_house_recovery_cell c WHERE c.task_id=t.id) LIMIT 1`)
      .get(prefix, `${prefix}\uffff`, HOUSE_CELL_CAPABILITY, MINECRAFT_RECOVERY_CONTEXT)
  }

  startRecoveryCell(sourceTaskId: string, taskId: string, cell: HouseRecoveryPlacedCell, mode: HouseRecoveryPlacementMode): void {
    this.db.prepare(`INSERT INTO minecraft_house_recovery_cell(source_task_id,cell_index,task_id,material,mode,outcome)
      VALUES (?,?,?,?,?,'started')`).run(sourceTaskId, cell.index, taskId, cell.material, mode)
  }

  settleRecoveryCell(taskId: string, outcome: Exclude<RecoveryOutcome, 'started'>): boolean {
    return this.db.prepare(`UPDATE minecraft_house_recovery_cell SET outcome=?, settled_at=? WHERE task_id=? AND outcome='started'`)
      .run(outcome, new Date().toISOString(), taskId).changes === 1
  }

  markStartedRecoveryCellsUnconfirmed(): void {
    this.db.prepare(`UPDATE minecraft_house_recovery_cell SET outcome='unconfirmed', settled_at=? WHERE outcome='started'`).run(new Date().toISOString())
  }

  referenceSource(id: string) {
    const row = this.db.prepare(`${SELECT_DRAFTS} WHERE id=?`).get(id) as DraftRow | undefined
    if (!row) return
    const reference = this.draft(row)?.reference
    if (reference) return { sessionId: row.source_session_id, reference }
  }

  byBuildTask(taskId: string): Draft | undefined {
    const rows = this.db.prepare(`${SELECT_DRAFTS} WHERE attempt_task_id=? AND status='built' LIMIT 2`).all(taskId)
    return rows.length === 1 ? this.draft(rows[0]) : undefined
  }

  recentBuildTasks(since: string): string[] {
    return this.db.prepare(`SELECT DISTINCT t.id FROM task t JOIN minecraft_house h ON h.attempt_task_id=t.id
      WHERE h.status='built' AND t.context_id='game.minecraft' AND t.capability_id=? AND t.status='succeeded' AND t.updated_at>=?
      ORDER BY t.updated_at DESC,t.id DESC LIMIT 40`).all(MINECRAFT_HOUSE_CAPABILITY, since).map(row => String(row.id))
  }

  create(input: MinecraftHouseDraftInput, source: { sessionId: string; messageId: string; reference?: Draft['reference'] }): Draft {
    const { zoneId, ...payload } = input
    const query = this.db.prepare(`${SELECT_DRAFTS} WHERE source_session_id=? AND source_message_id=?`)
    this.db.prepare(`INSERT INTO minecraft_house(id,source_session_id,source_message_id,zone_id,payload_json,created_at,status)
      VALUES (?,?,?,?,?,?,'draft') ON CONFLICT(source_session_id,source_message_id) DO NOTHING`).run(
      randomUUID(), source.sessionId, source.messageId, zoneId ?? null,
      JSON.stringify({ ...payload, ...(source.reference && { reference: source.reference }) }), new Date().toISOString(),
    )
    return this.draft(query.get(source.sessionId, source.messageId))!
  }

  revise(id: string, input: MinecraftHouseRevisionInput): Draft | undefined {
    return this.transaction(() => {
      const draft = this.get(id)
      if (!draft || draft.status !== 'draft' || draft.revision !== input.expectedRevision) return
      if (!MinecraftHouseLayout.safeParse({ ...draft.layout, blocks: input.blocks }).success) return
      if (draft.layout.blocks === input.blocks) return draft

      const updated = this.db.prepare(`UPDATE minecraft_house SET payload_json=json_set(payload_json,'$.layout.blocks',?)
        WHERE id=? AND status='draft' AND ${CURRENT_REVISION}=?`).run(input.blocks, id, input.expectedRevision)
      if (updated.changes !== 1) return
      const save = this.db.prepare('INSERT INTO minecraft_house_revision (house_id,revision,blocks,created_at) VALUES (?,?,?,?)')
      if (input.expectedRevision === 0) save.run(id, 0, draft.layout.blocks, draft.createdAt)
      save.run(id, input.expectedRevision + 1, input.blocks, new Date().toISOString())
      return this.get(id)
    })
  }

  history(id: string): MinecraftHouseRevisionHistory | undefined {
    const rows = this.db.prepare(`SELECT revision,blocks,created_at FROM minecraft_house_revision WHERE house_id=?
      UNION ALL SELECT 0,json_extract(payload_json,'$.layout.blocks'),created_at FROM minecraft_house
      WHERE id=? AND ${CURRENT_REVISION}=0 ORDER BY revision DESC`).all(id, id) as RevisionRow[]
    if (rows.length) return { revisions: rows.map(({ revision, blocks, created_at }) => ({ revision, blocks, createdAt: created_at })) }
  }

  start(id: string, zoneId: string, taskId: string, expectedRevision?: number): boolean {
    return this.db.prepare(`UPDATE minecraft_house SET status='running', zone_id=?, attempt_task_id=?
      WHERE id=? AND status IN ('draft','interrupted') AND (zone_id IS NULL OR zone_id=?) AND (? IS NULL OR ${CURRENT_REVISION}=?)`)
      .run(zoneId, taskId, id, zoneId, expectedRevision ?? null, expectedRevision ?? null).changes === 1
  }

  finish(id: string, taskId: string, receipt?: MinecraftHouseReceipt): boolean {
    return this.db.prepare(`UPDATE minecraft_house SET status=?, receipt_json=? WHERE id=? AND attempt_task_id=? AND status='running'`)
      .run(receipt ? 'built' : 'interrupted', receipt ? JSON.stringify(receipt) : null, id, taskId).changes === 1
  }

  completeRecovery(id: string, zoneId: string, sourceTaskId: string, completedTaskId: string, revision: number, receipt: MinecraftHouseReceipt): boolean {
    return this.db.prepare(`UPDATE minecraft_house SET status='built', attempt_task_id=?, receipt_json=?
      WHERE id=? AND zone_id=? AND attempt_task_id=? AND status='interrupted' AND ${CURRENT_REVISION}=?`)
      .run(completedTaskId, JSON.stringify(receipt), id, zoneId, sourceTaskId, revision).changes === 1
  }

  running(): { id: string; attempt_task_id: string }[] {
    return this.db.prepare("SELECT id,attempt_task_id FROM minecraft_house WHERE status='running'").all() as { id: string; attempt_task_id: string }[]
  }
}
