import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MinecraftPlace, minecraftPlaceKey } from './minecraft-place.ts'

type PlaceRow = {
  id: string; project_id: string; memory_id: string; name: string
  dimension: string; x: number; y: number; z: number
  verified_at: string; created_at: string; updated_at: string
}

function fromRow(row: PlaceRow): MinecraftPlace {
  return MinecraftPlace.parse({
    id: row.id, projectId: row.project_id, memoryId: row.memory_id, name: row.name,
    dimension: row.dimension, x: row.x, y: row.y, z: row.z,
    verifiedAt: row.verified_at, createdAt: row.created_at, updatedAt: row.updated_at,
  })
}

export class MinecraftPlaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  byProject(projectId: string): MinecraftPlace | undefined {
    const row = this.db.prepare('SELECT * FROM minecraft_place WHERE project_id=?').get(projectId) as PlaceRow | undefined
    return row && fromRow(row)
  }

  byName(name: string): MinecraftPlace | undefined {
    const row = this.db.prepare('SELECT * FROM minecraft_place WHERE name_key=?').get(minecraftPlaceKey(name)) as PlaceRow | undefined
    return row && fromRow(row)
  }

  list(): MinecraftPlace[] {
    const rows = this.db.prepare(`SELECT l.* FROM minecraft_place l
      JOIN minecraft_house_project p ON p.id=l.project_id
      JOIN minecraft_build_zone z ON z.id=p.zone_id AND z.revoked_at IS NULL
      JOIN memory m ON m.id=l.memory_id AND m.status IN ('active','candidate')
      ORDER BY l.updated_at DESC,l.id DESC LIMIT 64`).all() as PlaceRow[]
    return rows.map(fromRow)
  }

  save(projectId: string, name: string, memoryId: string,
    location: Pick<MinecraftPlace, 'dimension' | 'x' | 'y' | 'z' | 'verifiedAt'>): { place: MinecraftPlace; changed: boolean } {
    const previous = this.byProject(projectId)
    if (previous?.name === name) return { place: previous, changed: false }
    const now = new Date().toISOString()
    const id = previous?.id ?? randomUUID()
    const createdAt = previous?.createdAt ?? now
    this.db.prepare(`INSERT INTO minecraft_place
      (id,project_id,name_key,name,memory_id,dimension,x,y,z,verified_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET name_key=excluded.name_key,name=excluded.name,memory_id=excluded.memory_id,
      dimension=excluded.dimension,x=excluded.x,y=excluded.y,z=excluded.z,verified_at=excluded.verified_at,updated_at=excluded.updated_at`)
      .run(id, projectId, minecraftPlaceKey(name), name, memoryId, location.dimension, location.x, location.y, location.z,
        location.verifiedAt, createdAt, now)
    return { place: this.byProject(projectId)!, changed: true }
  }
}
