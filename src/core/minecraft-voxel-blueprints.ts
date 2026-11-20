import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const VOXEL_PREPARE_CAPABILITY = 'minecraft.blueprint.prepare'
export const VoxelBlueprintHash = z.string().regex(/^[0-9a-f]{64}$/u)
const Side = z.int().min(1).max(256)
export const VoxelBlueprintInfo = z.object({
  size: z.strictObject({ x: Side, y: Side, z: Side }),
  declared: z.int().positive(),
  materials: z.record(z.string().min(3).max(512), z.int().positive()),
  depthAsZ: z.boolean(),
}).refine(({ size, declared, materials }) => declared <= size.x * size.y * size.z &&
  Object.values(materials).reduce((sum, count) => sum + count, 0) === declared)
export type VoxelBlueprintInfo = z.infer<typeof VoxelBlueprintInfo>

export interface VoxelBlueprintSource {
  contextId: string
  sessionId: string
  messageId: string
  attachmentId: string
  paletteAttachmentId?: string
  filename: string
  sha256: string
  paletteSha256?: string
}

export interface VoxelBlueprintRecord {
  id: string
  name: string
  info: VoxelBlueprintInfo
  source: VoxelBlueprintSource
  schematicId: string
  previewId: string
  createdAt: string
  approvedAt?: string
}

type Row = { id: string; name: string; info_json: string; source_json: string; schematic_id: string;
  preview_id: string; created_at: string; approved_at: string | null }

function fromRow(row: Row): VoxelBlueprintRecord {
  return { id: row.id, name: row.name, info: VoxelBlueprintInfo.parse(JSON.parse(row.info_json)),
    source: JSON.parse(row.source_json) as VoxelBlueprintSource, schematicId: row.schematic_id, previewId: row.preview_id,
    createdAt: row.created_at, approvedAt: row.approved_at ?? undefined }
}

export class VoxelBlueprintRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): VoxelBlueprintRecord | undefined {
    const row = this.db.prepare('SELECT * FROM minecraft_voxel_blueprint WHERE id=?').get(id) as Row | undefined
    return row && fromRow(row)
  }

  list(): VoxelBlueprintRecord[] {
    return (this.db.prepare('SELECT * FROM minecraft_voxel_blueprint ORDER BY created_at DESC, rowid DESC LIMIT 24').all() as Row[]).map(fromRow)
  }

  save(blueprint: VoxelBlueprintRecord): void {
    this.db.prepare(`INSERT INTO minecraft_voxel_blueprint (id,name,info_json,source_json,schematic_id,preview_id,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(blueprint.id, blueprint.name, JSON.stringify(blueprint.info), JSON.stringify(blueprint.source),
      blueprint.schematicId, blueprint.previewId, blueprint.createdAt)
  }

  review(id: string, approvedAt: string | null): boolean {
    const result = this.db.prepare('UPDATE minecraft_voxel_blueprint SET approved_at=? WHERE id=? AND (approved_at IS NULL)=?')
      .run(approvedAt, id, approvedAt === null ? 0 : 1)
    return result.changes === 1
  }
}
