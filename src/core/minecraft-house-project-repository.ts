import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HOUSE_PROJECT_VERIFICATION_EVENT, HOUSE_PROJECT_VERIFY_CAPABILITY, HouseProjectPlan, MinecraftHouseProjectVerification, PROJECT_MIN_SECTIONS,
  type MinecraftHouseProject, type MinecraftHouseProjectInput, type MinecraftHouseProjectProgress,
  type MinecraftHouseProjectSectionReceipt } from './minecraft-house-project.ts'

type ProjectRow = {
  id: string; name: string; zone_id: string; created_at: string; verification_json: string | null; plan_json: string | null
  place_id: string | null; place_name: string | null; renovate: number
}
type SectionRow = {
  blueprint_json: string; status: MinecraftHouseProject['sections'][number]['status']; receipt_json: string | null; reason: string | null
}

const PLAN_KEY = 'minecraft.house-project.plan:'
const PROJECT_LIST_LIMIT = 40
const SECTION_PAGE_SIZE = 32
const CompletionActivity = MinecraftHouseProjectVerification.safeExtend({ projectId: z.uuid(), projectName: z.string().optional() })
const StoredVerification = MinecraftHouseProjectVerification.safeExtend({ checkedAt: z.iso.datetime() })
const PROJECTS = `SELECT p.*,s.value AS plan_json,l.id AS place_id,l.name AS place_name FROM minecraft_house_project p
  LEFT JOIN state s ON s.key='${PLAN_KEY}' || p.id
  LEFT JOIN minecraft_place l ON l.project_id=p.id`

export class MinecraftHouseProjectRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  private project({ id, name, zone_id, created_at, verification_json, plan_json, place_id, place_name, renovate }: ProjectRow): MinecraftHouseProject {
    const rows = this.db.prepare(`SELECT blueprint_json,status,receipt_json,reason FROM minecraft_house_project_section
      WHERE project_id=? ORDER BY section_index`).all(id) as SectionRow[]
    const plan = plan_json ? HouseProjectPlan.safeParse(JSON.parse(plan_json)).data : undefined
    return { id, name, zoneId: zone_id, createdAt: created_at, sections: rows.map(row => ({
      ...JSON.parse(row.blueprint_json), status: row.status,
      ...(row.receipt_json && { receipt: JSON.parse(row.receipt_json) }), ...(row.reason && { reason: row.reason }),
    })), ...(verification_json && { verification: JSON.parse(verification_json) }),
    ...(place_id && place_name && { place: { id: place_id, name: place_name } }), ...(plan && { plan }),
    ...(renovate === 1 && { renovate: true as const }) }
  }

  list(): MinecraftHouseProject[] {
    const rows = this.db.prepare(`${PROJECTS} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).all(PROJECT_LIST_LIMIT) as ProjectRow[]
    return rows.map(row => this.project(row))
  }

  progress(): MinecraftHouseProjectProgress[] {
    const rows = this.db.prepare(`WITH recent AS (
      SELECT p.id,p.name,p.created_at,CASE WHEN json_valid(p.verification_json) THEN p.verification_json END AS verification_json
      FROM minecraft_house_project p
      JOIN minecraft_build_zone z ON z.id=p.zone_id AND z.revoked_at IS NULL
      ORDER BY p.created_at DESC,p.id DESC LIMIT ?
    ) SELECT p.id,p.name,p.verification_json,COUNT(*) AS totalSections,
      SUM(s.status='built') AS verifiedSections,SUM(s.status='running') AS runningSections,
      SUM(s.status='interrupted') AS interruptedSections
    FROM recent p JOIN minecraft_house_project_section s ON s.project_id=p.id
    GROUP BY p.id ORDER BY p.created_at DESC,p.id DESC`).all(PROJECT_LIST_LIMIT) as (
      Omit<MinecraftHouseProjectProgress, 'lastVerification'> & { verification_json: string | null }
    )[]
    return rows.map(({ verification_json, ...project }) => {
      if (!verification_json) return project
      const { checkedAt, matched, checked, unmatchedSections } = JSON.parse(verification_json) ?? {}
      const result = MinecraftHouseProjectVerification.safeParse({ matched, checked, unmatchedSections }).data
      if (!result || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) return project
      return { ...project, lastVerification: { matched: result.matched, checked: result.checked,
        unmatchedSections: result.unmatchedSections.length, checkedAt } }
    })
  }

  progressSections(id: string, after: number) {
    type Section = { index: number; name: string; status: SectionRow['status']; checked: number | null; placed: number | null }
    const rows = this.db.prepare(`SELECT s.section_index AS "index",json_extract(s.blueprint_json,'$.name') AS name,
      s.status,json_extract(s.receipt_json,'$.checked') AS checked,json_extract(s.receipt_json,'$.placed') AS placed
    FROM minecraft_house_project p JOIN minecraft_build_zone z ON z.id=p.zone_id AND z.revoked_at IS NULL
    LEFT JOIN (SELECT section_index, blueprint_json, status, receipt_json FROM minecraft_house_project_section
      WHERE project_id=? AND section_index>? ORDER BY section_index LIMIT ?) s ON TRUE
    WHERE p.id=? ORDER BY s.section_index`).all(id, after, SECTION_PAGE_SIZE + 1, id) as (Section | { index: null })[]
    if (!rows.length) return
    const items = rows.slice(0, SECTION_PAGE_SIZE).filter((row): row is Section => row.index !== null)
      .map(({ checked, placed, ...section }) => ({ ...section, ...(section.status === 'built' && checked !== null && placed !== null && { checked, placed }) }))
    return { items, ...(rows.length > SECTION_PAGE_SIZE && { nextAfter: items.at(-1)!.index }) }
  }

  recentVerificationTasks(since: string): string[] {
    return this.db.prepare(`SELECT id FROM task WHERE context_id='game.minecraft' AND capability_id=?
      AND status='succeeded' AND updated_at>=? ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .all(HOUSE_PROJECT_VERIFY_CAPABILITY, since, PROJECT_LIST_LIMIT).map(row => String(row.id))
  }

  verifiedCompletion(taskId: string) {
    const rows = this.db.prepare(`SELECT p.created_at AS project_at,z.created_at AS authorized_at,
      p.verification_json,a.data_json,a.occurred_at,t.created_at,t.updated_at
      FROM task t JOIN activity a ON a.task_id=t.id AND a.context_id=t.context_id AND a.session_id IS t.session_id
      JOIN minecraft_house_project p ON p.id=CASE WHEN json_valid(a.data_json) THEN json_extract(a.data_json,'$.projectId') END
      JOIN minecraft_build_zone z ON z.id=p.zone_id AND z.revoked_at IS NULL
      WHERE t.id=? AND t.context_id='game.minecraft' AND t.capability_id=? AND t.status='succeeded'
      AND a.kind=? AND a.source='game.minecraft' AND a.status='success'
      AND p.verified_once=1 AND json_valid(p.verification_json)
      LIMIT 2`).all(taskId, HOUSE_PROJECT_VERIFY_CAPABILITY, HOUSE_PROJECT_VERIFICATION_EVENT)
    if (rows.length !== 1) return
    const row = rows[0]!
    const source = CompletionActivity.safeParse(JSON.parse(String(row.data_json))).data
    const latest = StoredVerification.safeParse(JSON.parse(String(row.verification_json))).data
    if (!source?.matched || !latest?.matched || latest.checked !== source.checked) return
    const started = Date.parse(String(row.created_at))
    const finished = Date.parse(String(row.updated_at))
    const recorded = Date.parse(String(row.occurred_at))
    const latestAt = Date.parse(latest.checkedAt)
    const now = Date.now()
    if (!(Date.parse(String(row.project_at)) <= started && Date.parse(String(row.authorized_at)) <= started &&
      started <= finished && finished <= recorded && recorded <= now && started <= latestAt && latestAt <= now)) return

    const totals = this.db.prepare(`SELECT COUNT(*) AS sections,COUNT(checked) AS verified,TOTAL(checked) AS checked FROM (
      SELECT CASE WHEN s.status='built' AND child.status='succeeded' AND child.updated_at<=? AND json_valid(s.receipt_json)
        THEN CASE WHEN json_type(s.receipt_json,'$.checked')='integer' AND json_extract(s.receipt_json,'$.checked')>0
          THEN json_extract(s.receipt_json,'$.checked') END
        END AS checked
      FROM minecraft_house_project_section s LEFT JOIN task child ON child.id=s.task_id WHERE s.project_id=?
    )`).get(latest.checkedAt, source.projectId)!
    const sections = Number(totals.sections)
    if (sections < PROJECT_MIN_SECTIONS || totals.verified !== sections || totals.checked !== source.checked) return
    return { projectId: source.projectId, sections, checked: source.checked, at: new Date(finished).toISOString() }
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
        if (Boolean(project.renovate) === Boolean(input.renovate) &&
          JSON.stringify(project.sections.map(({ name, offset, layout }) => ({ name, offset, layout }))) === blueprint) return project
      }
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      this.db.prepare('INSERT INTO minecraft_house_project(id,name,zone_id,created_at,renovate) VALUES (?,?,?,?,?)')
        .run(id, input.name, input.zoneId, createdAt, Number(input.renovate === true))
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

  invalidateUnmatched(id: string, indices: readonly number[]): number {
    return this.transaction(() => {
      const statement = this.db.prepare(`UPDATE minecraft_house_project_section SET status='interrupted',receipt_json=NULL,reason='house-project-verification-mismatch'
        WHERE project_id=? AND section_index=? AND status='built'`)
      return [...new Set(indices)].reduce((count, index) => count + Number(statement.run(id, index).changes === 1), 0)
    })
  }

  verify(id: string, result: NonNullable<MinecraftHouseProject['verification']>): boolean {
    const first = this.db.prepare('SELECT verified_once FROM minecraft_house_project WHERE id=?').get(id)?.verified_once === 0
    this.db.prepare(`UPDATE minecraft_house_project SET verification_json=?,verified_once=MAX(verified_once,?) WHERE id=?`)
      .run(JSON.stringify(result), Number(result.matched), id)
    return first && result.matched
  }
}
