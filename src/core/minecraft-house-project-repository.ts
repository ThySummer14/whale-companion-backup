import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HouseProjectPlan, type MinecraftHouseProject, type MinecraftHouseProjectInput,
  type MinecraftHouseProjectSectionReceipt } from './minecraft-house-project.ts'

type ProjectRow = {
  id: string; name: string; zone_id: string; created_at: string; verification_json: string | null; plan_json: string | null
  place_id: string | null; place_name: string | null
}
type SectionRow = {
  blueprint_json: string; status: MinecraftHouseProject['sections'][number]['status']; receipt_json: string | null; reason: string | null
}

const PLAN_KEY = 'minecraft.house-project.plan:'
const PROJECTS = `SELECT p.*,s.value AS plan_json,l.id AS place_id,l.name AS place_name FROM minecraft_house_project p
  LEFT JOIN state s ON s.key='${PLAN_KEY}' || p.id
  LEFT JOIN minecraft_place l ON l.project_id=p.id`

export class MinecraftHouseProjectRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  private project({ id, name, zone_id, created_at, verification_json, plan_json, place_id, place_name }: ProjectRow): MinecraftHouseProject {
    const rows = this.db.prepare(`SELECT blueprint_json,status,receipt_json,reason FROM minecraft_house_project_section
      WHERE project_id=? ORDER BY section_index`).all(id) as SectionRow[]
    const plan = plan_json ? HouseProjectPlan.safeParse(JSON.parse(plan_json)).data : undefined
    return { id, name, zoneId: zone_id, createdAt: created_at, sections: rows.map(row => ({
      ...JSON.parse(row.blueprint_json), status: row.status,
      ...(row.receipt_json && { receipt: JSON.parse(row.receipt_json) }), ...(row.reason && { reason: row.reason }),
    })), ...(verification_json && { verification: JSON.parse(verification_json) }),
    ...(place_id && place_name && { place: { id: place_id, name: place_name } }), ...(plan && { plan }) }
  }

  list(): MinecraftHouseProject[] {
    const rows = this.db.prepare(`${PROJECTS} ORDER BY p.created_at DESC,p.id DESC LIMIT 40`).all() as ProjectRow[]
    return rows.map(row => this.project(row))
  }

  get(id: string): MinecraftHouseProject | undefined {
    const row = this.db.prepare(`${PROJECTS} WHERE p.id=?`).get(id) as ProjectRow | undefined
    return row && this.project(row)
  }

  create(input: MinecraftHouseProjectInput): MinecraftHouseProject {
    return this.transaction(() => {
      const candidates = this.db.prepare(`${PROJECTS} WHERE p.zone_id=? AND p.name=?`)
        .all(input.zoneId, input.name) as ProjectRow[]
      const blueprint = JSON.stringify(input.sections)
      for (const row of candidates) {
        const project = this.project(row)
        if (JSON.stringify(project.sections.map(({ name, offset, layout }) => ({ name, offset, layout }))) === blueprint) return project
      }
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      this.db.prepare('INSERT INTO minecraft_house_project(id,name,zone_id,created_at) VALUES (?,?,?,?)')
        .run(id, input.name, input.zoneId, createdAt)
      const insert = this.db.prepare('INSERT INTO minecraft_house_project_section(project_id,section_index,blueprint_json) VALUES (?,?,?)')
      input.sections.forEach((section, index) => insert.run(id, index, JSON.stringify(section)))
      return { ...input, id, createdAt, sections: input.sections.map(section => ({ ...section, status: 'pending' })) }
    })
  }

  start(id: string, index: number, taskId: string): boolean {
    const started = this.db.prepare(`UPDATE minecraft_house_project_section SET status='running',reason=NULL,task_id=?
      WHERE project_id=? AND section_index=? AND status IN ('pending','interrupted')`).run(taskId, id, index).changes === 1
    if (started) this.db.prepare('DELETE FROM state WHERE key=?').run(PLAN_KEY + id)
    return started
  }

  recordPlan(id: string, plan: HouseProjectPlan): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(PLAN_KEY + id, JSON.stringify(plan))
  }

  finish(id: string, index: number, taskId: string, result: { receipt: MinecraftHouseProjectSectionReceipt } | { reason: string }): boolean {
    const receipt = 'receipt' in result ? JSON.stringify(result.receipt) : null
    return this.db.prepare(`UPDATE minecraft_house_project_section SET status=?,receipt_json=?,reason=?
      WHERE project_id=? AND section_index=? AND status='running' AND task_id=?`)
      .run(receipt ? 'built' : 'interrupted', receipt, 'reason' in result ? result.reason : null, id, index, taskId).changes === 1
  }

  running(): { project_id: string; section_index: number; task_id: string }[] {
    return this.db.prepare(`SELECT project_id,section_index,task_id FROM minecraft_house_project_section
      WHERE status='running'`).all() as { project_id: string; section_index: number; task_id: string }[]
  }

  sectionReceiptByTask(taskId: string): { projectId: string; zoneId: string; section: number; receipt: MinecraftHouseProjectSectionReceipt } | undefined {
    const rows = this.db.prepare(`SELECT p.id AS projectId,p.zone_id AS zoneId,s.section_index AS section,s.receipt_json
      FROM minecraft_house_project_section s JOIN minecraft_house_project p ON p.id=s.project_id
      WHERE s.task_id=? AND s.status='built' LIMIT 2`).all(taskId) as {
        projectId: string; zoneId: string; section: number; receipt_json: string
      }[]
    if (rows.length !== 1) return
    const { receipt_json, ...result } = rows[0]!
    return { ...result, receipt: JSON.parse(receipt_json) }
  }

  verify(id: string, result: NonNullable<MinecraftHouseProject['verification']>): boolean {
    const first = this.db.prepare('SELECT verified_once FROM minecraft_house_project WHERE id=?').get(id)?.verified_once === 0
    this.db.prepare(`UPDATE minecraft_house_project SET verification_json=?,verified_once=MAX(verified_once,?) WHERE id=?`)
      .run(JSON.stringify(result), Number(result.matched), id)
    return first && result.matched
  }
}
