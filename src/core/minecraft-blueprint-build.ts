import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { VoxelBlueprintHash } from './minecraft-voxel-blueprints.ts'
import type { ActivityRecord, MemoryRecord, MinecraftBuildZone } from './model.ts'
import type { CompanionStore } from './store.ts'

export const VOXEL_BUILD_CAPABILITY = 'minecraft.blueprint.build'
export const VOXEL_BUILD_EVENT = 'world.blueprint-built'
const Side = z.int().min(1).max(256)
const Size = z.strictObject({ x: Side, y: Side, z: Side })
const Position = z.strictObject({ x: z.int(), y: z.int(), z: z.int() })
const Dimension = z.string().max(64).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u)
const Count = z.int().min(0).max(256 ** 3)
const Reason = z.string().regex(/^blueprint-[a-z-]{1,60}$/u)

export const VoxelSiteInput = z.strictObject({ sha256: VoxelBlueprintHash, zoneId: z.uuid() })
export const VoxelBuildInput = VoxelSiteInput.extend({ previewId: z.uuid() })
export const VoxelWorldInput = z.strictObject({
  operationId: z.uuid(), sha256: VoxelBlueprintHash,
  dimension: Dimension,
  origin: Position, size: Size, solids: Count.positive(),
}).refine(({ size, solids }) => solids <= size.x * size.y * size.z)
export type VoxelWorldInput = z.infer<typeof VoxelWorldInput>
export type VoxelWorldMode = 'preview' | 'build'

export const VoxelWorldReceipt = z.strictObject({
  operationId: z.uuid(), sha256: VoxelBlueprintHash, phase: z.enum(['ready', 'built', 'failed', 'cancelled']),
  total: Count, solids: Count, checked: Count, matched: Count, placed: Count, restored: z.boolean(), reason: Reason.optional(),
}).refine(receipt => receipt.solids <= receipt.total && receipt.checked <= receipt.total && receipt.matched <= receipt.solids &&
  receipt.placed <= receipt.solids && (receipt.phase === 'failed' || receipt.phase === 'cancelled' ? !!receipt.reason : !receipt.reason))
export type VoxelWorldReceipt = z.infer<typeof VoxelWorldReceipt>

export function voxelWorldReceiptMatches(receipt: VoxelWorldReceipt, input: VoxelWorldInput, mode: VoxelWorldMode): boolean {
  if (receipt.operationId !== input.operationId || receipt.sha256 !== input.sha256) return false
  if (receipt.phase === 'failed' || receipt.phase === 'cancelled') return !receipt.total ||
    receipt.total === input.size.x * input.size.y * input.size.z && receipt.solids === input.solids
  const checked = input.size.x * input.size.y * input.size.z
  return receipt.total === checked && receipt.solids === input.solids && receipt.checked === checked && receipt.restored &&
    (mode === 'preview' ? receipt.phase === 'ready' && !receipt.placed : receipt.phase === 'built' && receipt.matched === input.solids)
}

export function voxelSiteOrigin(zone: MinecraftBuildZone, size: z.infer<typeof Size>) {
  const origin = { x: zone.x - Math.floor(size.x / 2), y: zone.y, z: zone.z - Math.floor(size.z / 2) }
  const max = { x: origin.x + size.x - 1, y: origin.y + size.y - 1, z: origin.z + size.z - 1 }
  return (['x', 'y', 'z'] as const).every(axis => origin[axis] >= zone[axis] - zone.radius && max[axis] <= zone[axis] + zone.radius)
    ? origin : undefined
}

const VoxelCompletionData = z.object({
  ...VoxelSiteInput.shape, ...Position.shape, blueprintId: z.uuid(), dimension: Dimension,
  checked: Count.positive(), matched: Count.positive(), placed: Count, restored: z.literal(true),
})
type VoxelBuildHistory = Pick<CompanionStore, 'voxelBuilds' | 'voxelBlueprints' | 'taskById'>

export function voxelBuildCompletion(store: VoxelBuildHistory, activity: ActivityRecord) {
  if (activity.kind !== VOXEL_BUILD_EVENT || activity.source !== 'game.minecraft' || activity.contextId !== 'game.minecraft' ||
      activity.status !== 'success' || !activity.taskId) return
  const event = VoxelCompletionData.safeParse(activity.data).data
  if (!event) return
  const { blueprintId, zoneId, dimension, x, y, z, checked, matched, placed, sha256 } = event
  const build = store.voxelBuilds.get(blueprintId)
  const receipt = build?.receipt
  if (build?.status !== 'built' || build.taskId !== activity.taskId || build.zoneId !== zoneId ||
      receipt?.phase !== 'built' || !receipt.restored || receipt.sha256 !== sha256 || receipt.total !== checked ||
      receipt.checked !== checked || receipt.solids !== matched || receipt.matched !== matched || receipt.placed !== placed) return
  const task = store.taskById(build.taskId)
  if (task?.status !== 'succeeded' || task.capabilityId !== VOXEL_BUILD_CAPABILITY || task.contextId !== 'game.minecraft' ||
      task.sessionId !== activity.sessionId) return
  const blueprint = store.voxelBlueprints.get(blueprintId)
  if (!blueprint) return
  return { blueprintId, name: blueprint.name, zoneName: build.zoneName, dimension, x, y, z, checked, matched }
}

export function voxelBuildMemoryContent(summary: string, site: z.infer<typeof Position> & { dimension: string }, activityId: number) {
  return `${summary}蓝图起点 X=${site.x}、Y=${site.y}、Z=${site.z}（${site.dimension}）。来源为 Minecraft 完工回执 #${activityId}。`
}

export function legacyVoxelBuildMemory(store: VoxelBuildHistory & Pick<CompanionStore, 'activityById'>, memory: MemoryRecord) {
  if (memory.kind !== 'experience' || memory.contextId !== 'game.minecraft') return
  for (const ref of memory.sourceRefs) {
    if (ref.contextId !== 'game.minecraft' || !ref.activityId || !ref.taskId) continue
    const activity = store.activityById(ref.activityId)
    if (!activity || activity.taskId !== ref.taskId || activity.summary !== memory.content) continue
    const completion = voxelBuildCompletion(store, activity)
    if (completion) return voxelBuildMemoryContent(memory.content, completion, activity.id)
  }
}

export interface VoxelBuildRecord {
  blueprintId: string
  zoneId: string
  zoneName: string
  taskId: string
  status: 'running' | 'interrupted' | 'built'
  updatedAt: string
  receipt?: VoxelWorldReceipt
  reason?: string
}

type Row = { blueprint_id: string; zone_id: string; zone_name: string; task_id: string; status: VoxelBuildRecord['status'];
  updated_at: string; receipt_json: string | null; reason: string | null }

function read(row: Row): VoxelBuildRecord {
  return { blueprintId: row.blueprint_id, zoneId: row.zone_id, zoneName: row.zone_name, taskId: row.task_id, status: row.status,
    updatedAt: row.updated_at, ...(row.receipt_json && { receipt: VoxelWorldReceipt.parse(JSON.parse(row.receipt_json)) }),
    ...(row.reason && { reason: row.reason }) }
}

export class VoxelBuildRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): VoxelBuildRecord | undefined {
    const row = this.db.prepare('SELECT * FROM minecraft_voxel_build WHERE blueprint_id=?').get(id) as Row | undefined
    return row && read(row)
  }

  running(): VoxelBuildRecord[] {
    return (this.db.prepare("SELECT * FROM minecraft_voxel_build WHERE status='running'").all() as Row[]).map(read)
  }

  start(blueprintId: string, zone: Pick<MinecraftBuildZone, 'id' | 'name'>, taskId: string): boolean {
    return this.db.prepare(`INSERT INTO minecraft_voxel_build (blueprint_id, zone_id, zone_name, task_id, status, updated_at)
      VALUES (?,?,?,?,'running',?) ON CONFLICT(blueprint_id) DO UPDATE SET task_id=excluded.task_id, status='running',
      updated_at=excluded.updated_at, receipt_json=NULL, reason=NULL
      WHERE status='interrupted' AND zone_id=excluded.zone_id`).run(blueprintId, zone.id, zone.name, taskId, new Date().toISOString()).changes === 1
  }

  finish(blueprintId: string, taskId: string, outcome: { receipt?: VoxelWorldReceipt; reason?: string }): boolean {
    const built = outcome.receipt?.phase === 'built'
    return this.db.prepare(`UPDATE minecraft_voxel_build SET status=?,updated_at=?,receipt_json=?,reason=?
      WHERE blueprint_id=? AND task_id=? AND status='running'`).run(built ? 'built' : 'interrupted', new Date().toISOString(),
      outcome.receipt ? JSON.stringify(outcome.receipt) : null, outcome.reason ?? null, blueprintId, taskId).changes === 1
  }
}
