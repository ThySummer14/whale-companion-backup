import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { verifiedCampReceipt } from './community.ts'
import { BILIBILI_AUTONOMY_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, SELF_NOTE_TRAIT_LABELS, milestoneReflectionKey, type ActivityInput, type MemorySourceRef, type SelfNote, type SelfNoteBasis, type SelfNoteCounts, type SelfNoteEvidenceRef, type SelfNoteExperience, type SelfNoteMilestoneExperience, type SelfNoteMilestoneKind, type SelfNoteRevision, type SelfNoteStatus, type SelfNoteTrait } from './model.ts'
import type { AutonomousJob, TaskRecord } from './model.ts'
import { lexicalMatcher } from './memory.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX, MinecraftVisitRevisitReceipt, MinecraftVisitSupplyReceipt } from './minecraft-supply.ts'
import { isSurveyWindowKey, surveyWindowKey } from './minecraft-survey-window.ts'
import { MinecraftHouseDraft, MinecraftHouseRequest, minecraftHouseReceiptMatches } from './minecraft-house.ts'
import { MINECRAFT_HOUSE_CAPABILITY } from './minecraft-house-repository.ts'
import { dailyHouseProjectReflectionFact, verifiedDailyHouseProjectSection, type DailyHouseProjectProofStore } from './daily-house-project-proof.ts'

export const MAX_ACTIVE_SELF_NOTES = 40
export const SelfNoteExperienceReceiptSchema = z.strictObject({
  at: z.iso.datetime(),
  fact: z.string().min(1).max(240).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u).refine(value => !!value.trim()),
})
export type SelfNoteExperienceReceipt = z.infer<typeof SelfNoteExperienceReceiptSchema>
export const SelfNoteRevisionReasonSchema = z.string().trim().min(6).max(120).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u)

export function normalizeSelfNoteObservation(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\u200B-\u200D\u2060\uFEFF]+/gu, '')
    .replace(/[。.!?！？]+$/u, '')
}

type SelfNoteAuthorship = Pick<SelfNote, 'evidenceRefs' | 'trait' | 'supersedes' | 'experience' | 'experienceReceipt' | 'revisionReason'>
type DailyExperience = Exclude<SelfNoteExperience, SelfNoteMilestoneExperience>
const experienceTaskIds = { dailyTaskId: z.uuid(), activityTaskId: z.uuid() }
const Experience = z.discriminatedUnion('kind', [
  z.strictObject({ ...experienceTaskIds, kind: z.literal('survey'), receiptTaskId: z.uuid() }),
  z.strictObject({ ...experienceTaskIds, kind: z.literal('supply'), receiptTaskId: z.uuid() }),
  z.strictObject({ ...experienceTaskIds, kind: z.literal('build'), receiptTaskId: z.uuid() }),
  z.strictObject({ ...experienceTaskIds, kind: z.literal('house-project'), activityId: z.int().positive() }),
  z.strictObject({ ...experienceTaskIds, kind: z.literal('bilibili'), activityId: z.int().positive() }),
  z.strictObject({ kind: z.literal('camp-project'), taskId: z.uuid(), constructionTaskId: z.uuid(), receiptTaskId: z.uuid() }),
  z.strictObject({ kind: z.literal('house'), taskId: z.uuid(), draftId: z.uuid() }),
])
const ReflectionSource = z.strictObject({
  contextId: z.literal(DAILY_REFLECTION_CONTEXT), sessionId: z.string().min(1),
  taskId: z.uuid(), eventSeq: z.int().nonnegative(),
})
const MilestoneJob = z.strictObject({
  milestone: z.strictObject({ kind: z.enum(['camp-project', 'house']), taskId: z.uuid() }),
  expiresAt: z.int().positive(),
  noteId: z.uuid().optional(),
  sourceReceipt: SelfNoteExperienceReceiptSchema.optional(),
})
const MilestoneCampDay = z.object({
  windowRuleId: z.uuid(), date: z.string().refine(value => isSurveyWindowKey(surveyWindowKey(value))),
  choice: z.enum(['build', 'revisit']), activityTaskId: z.uuid(), expiresAt: z.int().positive(),
  visitId: z.uuid(), visitExpiresAt: z.int().positive(), visitJoined: z.literal(true), visitStatus: z.literal('offline'),
}).refine(day => day.visitExpiresAt <= day.expiresAt)
const MilestoneCampRevisit = z.strictObject({
  goal: z.literal('revisit'), campZoneId: z.uuid(), visitId: z.uuid(), expiresAt: z.int().positive(),
  constructionTaskId: z.uuid(), receiptTaskId: z.uuid(), visitRevisit: MinecraftVisitRevisitReceipt,
})

function isMilestoneExperience(experience: SelfNoteExperience | undefined): experience is SelfNoteMilestoneExperience {
  return experience?.kind === 'camp-project' || experience?.kind === 'house'
}

export interface SelfNoteWrite extends SelfNoteAuthorship {
  content: string
  basis: SelfNoteBasis
  confidence?: number
  evidence?: string[]
  counterEvidence?: string[]
  sourceRefs?: MemorySourceRef[]
  createdBy: SelfNote['createdBy']
  actorSessionId?: string
  reason?: string
}

interface SelfNoteRow {
  id: string
  content: string
  basis: SelfNoteBasis
  status: SelfNoteStatus
  confidence: number
  evidence_json: string
  counter_evidence_json: string
  source_refs_json: string
  authorship_json: string
  created_by: SelfNote['createdBy']
  created_at: string
  updated_at: string
  archived_at: string | null
}

function strings(values: string[] | undefined, label: string): string[] {
  const result = (values ?? []).map(value => value.trim()).filter(Boolean)
  if (result.length > 3 || result.some(value => value.length > 500)) throw new Error(`${label} must contain at most 3 entries of 500 characters`)
  return [...new Set(result)]
}

function sourceContext(refs: readonly MemorySourceRef[]): string | undefined {
  const context = refs[0]?.contextId
  if (context && refs.every(ref => ref.contextId === context)) return context
}

function verifiedEvidence(note: Pick<SelfNote, 'basis' | 'createdBy' | 'evidence' | 'sourceRefs'>, refs: readonly SelfNoteEvidenceRef[]): boolean {
  const sessionId = note.sourceRefs[0]?.sessionId
  return note.createdBy === 'companion' && note.basis === 'inference' && note.sourceRefs.length === 1 &&
    !!sourceContext(note.sourceRefs) && typeof sessionId === 'string' && !!sessionId.trim() &&
    note.evidence.every(quote => quote.length >= 6 && quote.length <= 180) &&
    Array.isArray(refs) && refs.length === note.evidence.length && refs.length > 0 && refs.length <= 3 &&
    refs.some(ref => ref?.role === 'assistant') && new Set(refs.map(ref => ref?.quoteIndex)).size === refs.length && refs.every(ref =>
      ref && Number.isInteger(ref.quoteIndex) && ref.quoteIndex >= 0 && ref.quoteIndex < note.evidence.length &&
      (ref.role === 'assistant' || ref.role === 'user') && typeof ref.messageId === 'string' && /^[^\s\p{Cc}]{1,200}$/u.test(ref.messageId))
}

function verifiedJournalEvidence(note: SelfNote, reason: string): boolean {
  const observation = note.evidenceRefs?.find(ref => ref.quoteIndex === 0)
  const explanation = note.evidenceRefs?.find(ref => ref.quoteIndex === 1)
  const normalized = normalizeSelfNoteObservation(note.content)
  const normalizedReason = normalizeSelfNoteObservation(reason)
  return !!note.supersedes && note.evidence.length === 2 && note.evidence[0] === note.content && note.evidence[1] === reason &&
    observation?.role === 'assistant' && explanation?.role === 'assistant' && observation.messageId === explanation.messageId &&
    !!normalized && !!normalizedReason && normalized !== normalizedReason
}

function isTrait(value: unknown): value is SelfNoteTrait {
  return typeof value === 'string' && Object.hasOwn(SELF_NOTE_TRAIT_LABELS, value)
}

function authorship({ evidenceRefs, trait, supersedes, experience, experienceReceipt, revisionReason }: SelfNoteAuthorship): SelfNoteAuthorship {
  return { evidenceRefs, trait, supersedes, experience, experienceReceipt, revisionReason }
}

export class SelfNoteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly recordActivity: (input: ActivityInput) => number,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly findJob: (id: string) => AutonomousJob | undefined,
    private readonly findTask: (id: string) => TaskRecord | undefined,
    private readonly houseProjectProofStore: DailyHouseProjectProofStore,
  ) {}

  private fromRow(row: unknown): SelfNote {
    const value = row as SelfNoteRow
    const note: SelfNote = {
      id: value.id,
      content: value.content,
      basis: value.basis,
      status: value.status,
      confidence: Number(value.confidence),
      evidence: JSON.parse(value.evidence_json) as string[],
      counterEvidence: JSON.parse(value.counter_evidence_json) as string[],
      sourceRefs: JSON.parse(value.source_refs_json) as MemorySourceRef[],
      createdBy: value.created_by,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      archivedAt: value.archived_at ?? undefined,
    }
    const metadata = JSON.parse(value.authorship_json) as SelfNoteAuthorship
    if (metadata.evidenceRefs && verifiedEvidence(note, metadata.evidenceRefs)) {
      note.evidenceRefs = metadata.evidenceRefs
      if (isTrait(metadata.trait)) note.trait = metadata.trait
      if (typeof metadata.supersedes === 'string') note.supersedes = metadata.supersedes
      if (sourceContext(note.sourceRefs) === DAILY_REFLECTION_CONTEXT) {
        const experience = Experience.safeParse(metadata.experience)
        if (experience.success) {
          note.experience = experience.data
          const receipt = SelfNoteExperienceReceiptSchema.safeParse(metadata.experienceReceipt).data
          if (receipt) {
            note.experienceReceipt = receipt
            const reason = SelfNoteRevisionReasonSchema.safeParse(metadata.revisionReason).data
            if (reason && verifiedJournalEvidence(note, reason)) note.revisionReason = reason
          }
        }
      }
    }
    return note
  }

  get(id: string): SelfNote | undefined {
    const row = this.db.prepare('SELECT * FROM self_note WHERE id=?').get(id)
    return row ? this.fromRow(row) : undefined
  }

  byDailyExperience(dailyTaskId: string): SelfNote | undefined {
    const row = this.db.prepare(`SELECT * FROM self_note WHERE created_by='companion'
      AND json_extract(source_refs_json,'$[0].contextId')=?
      AND json_extract(authorship_json,'$.experience.dailyTaskId')=?
      ORDER BY created_at,rowid LIMIT 1`).get(DAILY_REFLECTION_CONTEXT, dailyTaskId)
    const note = row ? this.fromRow(row) : undefined
    if (note?.experience && !isMilestoneExperience(note.experience) && note.experience.dailyTaskId === dailyTaskId) return note
  }

  byMilestoneExperience(kind: SelfNoteMilestoneKind, taskId: string): SelfNote | undefined {
    const row = this.db.prepare(`SELECT * FROM self_note WHERE created_by='companion'
      AND json_extract(source_refs_json,'$[0].contextId')=?
      AND json_extract(authorship_json,'$.experience.kind')=?
      AND json_extract(authorship_json,'$.experience.taskId')=?
      ORDER BY created_at,rowid LIMIT 1`).get(DAILY_REFLECTION_CONTEXT, kind, taskId)
    const note = row ? this.fromRow(row) : undefined
    if (note?.experience && isMilestoneExperience(note.experience) && note.experience.kind === kind && note.experience.taskId === taskId) return note
  }

  private verifiesHouseProjectExperience(source: MemorySourceRef, experience: Extract<DailyExperience, { kind: 'house-project' }>,
    submitted: SelfNoteExperienceReceipt | undefined): boolean {
    const ref = ReflectionSource.safeParse(source).data
    const reflection = ref && this.findJob(ref.taskId)
    const key = `daily-reflection:${experience.dailyTaskId}`
    if (!submitted || !ref || reflection?.id !== ref.taskId || reflection.kind !== 'daily.reflect' ||
      reflection.contextId !== ref.contextId || reflection.dedupeKey !== key || reflection.payload.dailyTaskId !== experience.dailyTaskId ||
      reflection.task.id !== reflection.id || reflection.task.contextId !== ref.contextId || reflection.task.capabilityId !== 'core.autonomy' ||
      reflection.task.externalId !== `autonomy:daily.reflect:${key}` || reflection.task.status !== 'running' || reflection.task.createdAt !== reflection.createdAt ||
      !this.db.prepare("SELECT 1 FROM session_binding WHERE context_id=? AND kind='system' AND session_id=?").get(ref.contextId, ref.sessionId)) return false
    const daily = this.findJob(experience.dailyTaskId)
    if (daily?.id !== experience.dailyTaskId || daily.task.status !== 'succeeded' || daily.payload.activityTaskId !== experience.activityTaskId ||
      !(Date.parse(daily.task.updatedAt) <= Date.parse(reflection.createdAt))) return false
    const proof = verifiedDailyHouseProjectSection(this.houseProjectProofStore, daily)
    return !!proof && proof.receipt.placed > 0 && proof.activityId === experience.activityId && proof.at === submitted.at &&
      dailyHouseProjectReflectionFact(proof) === submitted.fact
  }

  private verifiesDailyExperience(source: MemorySourceRef, experience: DailyExperience, submitted: SelfNoteExperienceReceipt | undefined): boolean {
    if (experience.kind === 'house-project') return this.verifiesHouseProjectExperience(source, experience, submitted)
    if (source.contextId !== DAILY_REFLECTION_CONTEXT || !source.sessionId || !source.taskId ||
      typeof source.eventSeq !== 'number' || !Number.isSafeInteger(source.eventSeq) || source.eventSeq < 0) return false
    const minecraft = experience.kind !== 'bilibili'
    const row = this.db.prepare(`SELECT json_extract(c.payload_json,'$.visitSupply') AS visit_supply FROM autonomous_job r
      JOIN task rt ON rt.id=r.task_id AND rt.context_id=r.context_id
      JOIN session_binding b ON b.context_id=r.context_id AND b.kind='system'
      JOIN autonomous_job d ON d.task_id=json_extract(r.payload_json,'$.dailyTaskId')
      JOIN task dt ON dt.id=d.task_id AND dt.context_id=d.context_id
      JOIN autonomous_job c ON c.task_id=json_extract(d.payload_json,'$.activityTaskId')
      JOIN task ct ON ct.id=c.task_id AND ct.context_id=c.context_id
      WHERE r.task_id=? AND r.context_id=? AND r.kind='daily.reflect' AND rt.capability_id='core.autonomy' AND rt.status='running'
      AND b.session_id=? AND d.task_id=? AND d.context_id=? AND d.kind='daily.choice'
      AND dt.capability_id='core.autonomy' AND dt.status='succeeded'
      AND json_extract(d.payload_json,'$.choice')=? AND c.task_id=? AND c.context_id=? AND c.kind=?
      AND ct.capability_id='core.autonomy' AND ct.status='succeeded' AND json_extract(c.payload_json,?)=?
      AND (? NOT IN ('supply','build') OR (
        json_extract(d.payload_json,'$.visitId')=d.task_id
        AND json_extract(c.payload_json,'$.visitId')=d.task_id
        AND json_type(d.payload_json,'$.visitJoined')='true'
        AND json_extract(d.payload_json,'$.visitStatus')='offline'))
      AND (?<>'supply' OR (
        c.dedupe_key='visit-supply:' || d.task_id
        AND json_extract(c.payload_json,'$.goal')='planks'
        AND json_type(c.payload_json,'$.visitSupply')='object'
        AND EXISTS (SELECT 1 FROM task g WHERE g.id=json_extract(c.payload_json,'$.receiptTaskId')
          AND g.capability_id='minecraft.craft' AND g.context_id='game.minecraft' AND g.status='succeeded'
          AND g.external_id=? || d.task_id)))`)
      .get(source.taskId, DAILY_REFLECTION_CONTEXT, source.sessionId, experience.dailyTaskId, DAILY_AUTONOMY_CONTEXT,
        experience.kind, experience.activityTaskId, minecraft ? MINECRAFT_SUPPLY_CONTEXT : BILIBILI_AUTONOMY_CONTEXT,
        minecraft ? 'minecraft.supply' : 'bilibili.review', minecraft ? '$.receiptTaskId' : '$.activityId',
        minecraft ? experience.receiptTaskId : experience.activityId, experience.kind, experience.kind, CAMP_VISIT_SUPPLY_TASK_PREFIX)
    if (!row) return false
    if (experience.kind === 'supply') return MinecraftVisitSupplyReceipt.safeParse(JSON.parse(String(row.visit_supply))).success
    if (experience.kind !== 'build') return true

    const daily = this.findJob(experience.dailyTaskId)
    const activity = this.findJob(experience.activityTaskId)
    if (!daily || !activity) return false
    const { expiresAt, visitExpiresAt } = daily.payload
    if (typeof visitExpiresAt !== 'number' || !Number.isSafeInteger(visitExpiresAt) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
      visitExpiresAt > expiresAt || activity.payload.expiresAt !== visitExpiresAt ||
      !(Date.parse(activity.task.updatedAt) <= Date.parse(daily.task.updatedAt))) return false
    const proof = verifiedCampReceipt(activity, this.findTask)
    return proof?.visitBuild?.visitId === daily.id && proof.childId === experience.receiptTaskId
  }

  private verifiesMilestoneExperience(source: MemorySourceRef, experience: SelfNoteMilestoneExperience): boolean {
    const ref = ReflectionSource.safeParse(source).data
    if (!ref) return false
    const row = this.db.prepare(`SELECT r.payload_json FROM autonomous_job r
      JOIN task t ON t.id=r.task_id AND t.context_id=r.context_id
      JOIN session_binding b ON b.context_id=r.context_id AND b.kind='system'
      WHERE r.task_id=? AND r.context_id=? AND r.kind='daily.reflect' AND r.dedupe_key=?
      AND t.capability_id='core.autonomy' AND t.status='running'
      AND t.external_id='autonomy:daily.reflect:' || r.dedupe_key AND b.session_id=? AND json_valid(r.payload_json)`)
      .get(ref.taskId, ref.contextId, milestoneReflectionKey(experience.kind, experience.taskId), ref.sessionId)
    if (!row) return false
    const job = MilestoneJob.safeParse(JSON.parse(String(row.payload_json))).data
    if (!job || job.expiresAt <= Date.now() || job.milestone.kind !== experience.kind || job.milestone.taskId !== experience.taskId) return false
    return experience.kind === 'house' ? this.verifiesHouseMilestone(experience) : this.verifiesCampMilestone(experience)
  }

  private verifiesSourceReceipt(source: MemorySourceRef, submitted: SelfNoteExperienceReceipt | undefined): boolean {
    const job = source.taskId ? this.findJob(source.taskId) : undefined
    const expected = job?.payload.sourceReceipt
    if (expected === undefined) return submitted === undefined
    const receipt = SelfNoteExperienceReceiptSchema.safeParse(expected).data
    const expiresAt = job?.payload.expiresAt
    const now = Date.now()
    return !!receipt && !!submitted && receipt.at === submitted.at && receipt.fact === submitted.fact &&
      typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > now && Date.parse(receipt.at) <= now
  }

  private verifiesHouseMilestone(experience: Extract<SelfNoteMilestoneExperience, { kind: 'house' }>): boolean {
    const row = this.db.prepare(`SELECT h.payload_json,h.receipt_json,h.zone_id,h.created_at,z.dimension,z.x,z.y,z.z,z.radius,
      t.created_at AS started_at,t.updated_at AS completed_at FROM minecraft_house h
      JOIN task t ON t.id=h.attempt_task_id JOIN minecraft_build_zone z ON z.id=h.zone_id
      WHERE h.id=? AND h.attempt_task_id=? AND h.status='built'
      AND t.context_id='game.minecraft' AND t.capability_id=? AND t.status='succeeded'
      AND json_valid(h.payload_json) AND json_valid(h.receipt_json)`).get(experience.draftId, experience.taskId, MINECRAFT_HOUSE_CAPABILITY)
    if (!row) return false
    const createdAt = String(row.created_at)
    const started = Date.parse(String(row.started_at))
    const completed = Date.parse(String(row.completed_at))
    if (!(Date.parse(createdAt) <= started && started <= completed && completed <= Date.now())) return false
    const draft = MinecraftHouseDraft.safeParse({ ...JSON.parse(String(row.payload_json)), id: experience.draftId,
      createdAt, status: 'built', zoneId: row.zone_id, receipt: JSON.parse(String(row.receipt_json)) }).data
    const request = draft && MinecraftHouseRequest.safeParse({
      zone: { id: row.zone_id, dimension: row.dimension, x: row.x, y: row.y, z: row.z, radius: row.radius },
      layout: draft.layout,
    }).data
    return !!draft?.receipt?.placed && !!request && minecraftHouseReceiptMatches(draft.receipt, request)
  }

  private milestoneCampVisit(id: string, choice: 'build' | 'revisit') {
    const daily = this.findJob(id)
    const day = MilestoneCampDay.safeParse(daily?.payload).data
    if (!daily || !day || day.choice !== choice || day.visitId !== id || daily.id !== id || daily.kind !== 'daily.choice' ||
      daily.contextId !== DAILY_AUTONOMY_CONTEXT || daily.dedupeKey !== `daily:${day.date}` || daily.task.id !== id ||
      daily.task.contextId !== DAILY_AUTONOMY_CONTEXT || daily.task.capabilityId !== 'core.autonomy' || daily.task.status !== 'succeeded' ||
      daily.task.externalId !== `autonomy:daily.choice:${daily.dedupeKey}` || daily.task.createdAt !== daily.createdAt) return
    const child = this.findJob(day.activityTaskId)
    const dedupeKey = `visit-${choice}:${daily.id}`
    if (!child || child.id !== day.activityTaskId || child.kind !== 'minecraft.supply' || child.contextId !== MINECRAFT_SUPPLY_CONTEXT ||
      child.dedupeKey !== dedupeKey || child.task.id !== child.id || child.task.contextId !== MINECRAFT_SUPPLY_CONTEXT ||
      child.task.capabilityId !== 'core.autonomy' || child.task.externalId !== `autonomy:minecraft.supply:${dedupeKey}` ||
      child.task.status !== 'succeeded' || child.task.createdAt !== child.createdAt ||
      child.payload.visitId !== id || child.payload.expiresAt !== day.visitExpiresAt) return
    const started = Date.parse(child.createdAt)
    const completed = Date.parse(child.task.updatedAt)
    const closed = Date.parse(daily.task.updatedAt)
    if (!(Date.parse(daily.createdAt) <= started && started < day.visitExpiresAt && started <= completed &&
      completed <= closed && closed <= Date.now())) return
    return { daily, day, child, closed }
  }

  private verifiesCampMilestone(experience: Extract<SelfNoteMilestoneExperience, { kind: 'camp-project' }>): boolean {
    const revisit = this.milestoneCampVisit(experience.taskId, 'revisit')
    const construction = this.findTask(experience.constructionTaskId)
    const buildVisitId = construction?.externalId?.startsWith(CAMP_VISIT_BUILD_TASK_PREFIX)
      ? construction.externalId.slice(CAMP_VISIT_BUILD_TASK_PREFIX.length) : undefined
    const build = buildVisitId && this.milestoneCampVisit(buildVisitId, 'build')
    if (!revisit || !build || build.day.windowRuleId !== revisit.day.windowRuleId || build.day.date >= revisit.day.date ||
      !(build.closed <= Date.parse(revisit.daily.createdAt))) return false
    const constructionProof = verifiedCampReceipt(build.child, this.findTask)
    const placed = constructionProof?.visitBuild
    const checked = MilestoneCampRevisit.safeParse(revisit.child.payload).data
    if (!constructionProof || !placed || placed.visitId !== build.daily.id || constructionProof.childId !== experience.constructionTaskId ||
      !(Date.parse(constructionProof.item.at) < build.day.visitExpiresAt) || !checked ||
      checked.constructionTaskId !== experience.constructionTaskId || checked.receiptTaskId !== experience.receiptTaskId ||
      checked.campZoneId !== placed.receipt.zoneId || checked.visitRevisit.zoneId !== checked.campZoneId ||
      checked.visitRevisit.material !== placed.receipt.material || checked.visitRevisit.matchedBlocks !== 9) return false
    const receipt = this.findTask(experience.receiptTaskId)
    if (receipt?.id !== experience.receiptTaskId || receipt.contextId !== 'game.minecraft' ||
      receipt.capabilityId !== 'minecraft.survey' || receipt.status !== 'succeeded' ||
      receipt.externalId !== `${CAMP_VISIT_REVISIT_TASK_PREFIX}${revisit.daily.id}`) return false
    const start = Date.parse(receipt.createdAt)
    const end = Date.parse(receipt.updatedAt)
    return Date.parse(revisit.child.createdAt) <= start && start <= end && end < revisit.day.visitExpiresAt &&
      end <= Date.parse(revisit.child.task.updatedAt)
  }

  list(options: { status?: SelfNoteStatus | 'all'; limit?: number } = {}): SelfNote[] {
    const status = options.status ?? 'active'
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
    const rows = status === 'all'
      ? this.db.prepare('SELECT * FROM self_note ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM self_note WHERE status=? ORDER BY updated_at DESC, id DESC LIMIT ?').all(status, limit)
    return rows.map(row => this.fromRow(row))
  }

  search(query: string, limit = 2): SelfNote[] {
    if (!query.trim()) return []
    const match = lexicalMatcher(query)
    const now = Date.now()
    return this.list({ limit: MAX_ACTIVE_SELF_NOTES * 2 }).map(note => {
      const lexical = match(note.content)
      const rank = lexical * 0.85 + note.confidence * 0.1 + Math.exp(-Math.max(0, now - Date.parse(note.updatedAt)) / (30 * 86_400_000)) * 0.05
      return { note, lexical, rank }
    }).filter(item => item.lexical > 0.05).sort((a, b) => b.rank - a.rank).slice(0, Math.max(1, Math.min(4, limit))).map(item => item.note)
  }

  recallCandidates(contextId: string): SelfNote[] {
    const notes = this.db.prepare(`SELECT * FROM self_note WHERE created_by='companion' AND status='active'
      ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(MAX_ACTIVE_SELF_NOTES).map(row => this.fromRow(row))
    return notes.flatMap(note => {
      if (note.evidenceRefs) return note.trait || sourceContext(note.sourceRefs) === contextId ? [note] : []
      // Old versions allowed editing an observation after it was written. The first revision
      // preserves the character's own words without rewriting the user's stored history.
      const first = this.db.prepare('SELECT snapshot FROM self_note_revision WHERE note_id=? AND revision=1').get(note.id)
      if (!first) return []
      const original = JSON.parse(String(first.snapshot)) as SelfNote
      if (original.createdBy !== 'companion' || sourceContext(original.sourceRefs) !== contextId || !original.evidence.length) return []
      return [{ ...original, status: note.status, updatedAt: note.updatedAt, archivedAt: note.archivedAt }]
    })
  }

  counts(): SelfNoteCounts {
    const rows = this.db.prepare('SELECT status, created_by, COUNT(*) AS count FROM self_note GROUP BY status, created_by').all() as
      { status: SelfNoteStatus; created_by: SelfNote['createdBy']; count: number }[]
    const active = (author: SelfNote['createdBy']) => Number(rows.find(row => row.status === 'active' && row.created_by === author)?.count ?? 0)
    const companionActive = active('companion')
    const ownerActive = active('owner')
    const archived = rows.filter(row => row.status === 'archived').reduce((sum, row) => sum + Number(row.count), 0)
    return { active: companionActive + ownerActive, archived, companionActive, ownerActive }
  }

  create(input: SelfNoteWrite): SelfNote {
    const content = input.content.trim()
    if (!content || content.length > 500) throw new Error('Self note content must contain 1 to 500 characters')
    const now = new Date().toISOString()
    const note: SelfNote = {
      id: randomUUID(), content, basis: input.basis, status: 'active',
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.6)),
      evidence: strings(input.evidence, 'evidence'), counterEvidence: strings(input.counterEvidence, 'counterEvidence'),
      sourceRefs: (input.sourceRefs ?? []).slice(-20), createdBy: input.createdBy,
      createdAt: now, updatedAt: now,
    }
    const metadata = authorship(input)
    if (Object.values(metadata).some(value => value !== undefined)) {
      if (input.createdBy !== 'companion') throw new Error('self-note-author-protected')
      if (!metadata.evidenceRefs || !verifiedEvidence(note, metadata.evidenceRefs) || metadata.trait !== undefined && !isTrait(metadata.trait)) {
        throw new Error('self-note-invalid-evidence')
      }
      note.evidenceRefs = metadata.evidenceRefs.map(({ quoteIndex, messageId, role }) => ({ quoteIndex, messageId, role }))
      if (metadata.trait !== undefined) note.trait = metadata.trait
      if (metadata.supersedes !== undefined) note.supersedes = metadata.supersedes
    }
    const fromReflection = note.sourceRefs.some(ref => ref.contextId === DAILY_REFLECTION_CONTEXT)
    if (fromReflection || metadata.experience !== undefined || metadata.experienceReceipt !== undefined || metadata.revisionReason !== undefined) {
      const experience = Experience.safeParse(metadata.experience)
      if (!fromReflection || !experience.success || !note.evidenceRefs || note.evidenceRefs.some(ref => ref.role !== 'assistant') ||
        input.actorSessionId !== undefined && input.actorSessionId !== note.sourceRefs[0]?.sessionId) {
        throw new Error('self-note-invalid-evidence')
      }
      note.experience = experience.data
      if (isMilestoneExperience(note.experience) && input.actorSessionId !== note.sourceRefs[0]?.sessionId) throw new Error('self-note-invalid-evidence')
      if (metadata.experienceReceipt !== undefined) {
        const receipt = SelfNoteExperienceReceiptSchema.safeParse(metadata.experienceReceipt).data
        const source = ReflectionSource.safeParse(note.sourceRefs[0]).data
        if (!receipt || !source || input.actorSessionId !== source.sessionId) throw new Error('self-note-invalid-evidence')
        note.experienceReceipt = receipt
      }
      if (metadata.revisionReason !== undefined || note.experienceReceipt && note.supersedes !== undefined) {
        const reason = SelfNoteRevisionReasonSchema.safeParse(metadata.revisionReason).data
        if (!note.experienceReceipt || !reason || !verifiedJournalEvidence(note, reason)) throw new Error('self-note-invalid-evidence')
        note.revisionReason = reason
      }
    }
    return this.transaction(() => {
      if (note.experience) {
        const experience = note.experience
        const source = note.sourceRefs[0]!
        const milestone = isMilestoneExperience(experience)
        const verified = milestone ? this.verifiesMilestoneExperience(source, experience)
          : this.verifiesDailyExperience(source, experience, note.experienceReceipt)
        if (!verified || !this.verifiesSourceReceipt(source, note.experienceReceipt)) throw new Error('self-note-invalid-evidence')
        const existing = milestone ? this.byMilestoneExperience(experience.kind, experience.taskId) : this.byDailyExperience(experience.dailyTaskId)
        if (existing) return existing
      }
      const context = sourceContext(note.sourceRefs)
      const matching = this.db.prepare(`SELECT * FROM self_note WHERE created_by=? AND lower(trim(content))=lower(trim(?))
        ORDER BY status='active' DESC, updated_at DESC, rowid DESC`).all(note.createdBy, note.content)
      const duplicate = isMilestoneExperience(note.experience) || note.revisionReason ? undefined : matching.map(row => this.fromRow(row))
        .find(candidate => note.createdBy === 'owner' || !isMilestoneExperience(candidate.experience) && sourceContext(candidate.sourceRefs) === context)
      let predecessor: SelfNote | undefined
      if (note.supersedes !== undefined) {
        if (duplicate?.supersedes === note.supersedes) return duplicate
        predecessor = this.get(note.supersedes)
        if (predecessor?.createdBy !== 'companion' || predecessor.status !== 'active' || sourceContext(predecessor.sourceRefs) !== context) {
          throw new Error('self-note-invalid-supersession')
        }
        const currentReceipt = note.experienceReceipt
        const previousReceipt = predecessor.experienceReceipt
        if (previousReceipt && (!currentReceipt || !(Date.parse(currentReceipt.at) > Date.parse(previousReceipt.at))) ||
          currentReceipt && normalizeSelfNoteObservation(note.content) === normalizeSelfNoteObservation(predecessor.content)) {
          throw new Error('self-note-invalid-supersession')
        }
        const previousEvidence = new Set(predecessor.evidenceRefs?.filter(ref => ref.role === 'assistant').map(ref => ref.messageId))
        if (!note.evidenceRefs?.some(ref => ref.role === 'assistant' && !previousEvidence.has(ref.messageId))) {
          throw new Error('self-note-invalid-supersession')
        }
      }
      if (duplicate) return duplicate
      this.insert(note)
      this.addRevision(note, input.actorSessionId, input.reason ?? 'create')
      if (predecessor) this.update(predecessor.id, { status: 'archived', actorSessionId: input.actorSessionId, reason: `companion-superseded:${note.id}` })
      this.recordActivity({
        contextId: note.sourceRefs[0]?.contextId, sessionId: input.actorSessionId, source: 'core.self-note', kind: 'self-note.created',
        summary: note.createdBy === 'companion' ? '新增一条自我观察' : '新增一条主人反馈', status: 'success',
        data: { noteId: note.id, basis: note.basis, confidence: note.confidence,
          ...(note.supersedes && { supersedes: note.supersedes }), ...(note.trait && { trait: note.trait }),
          ...(predecessor && note.revisionReason && { journalRevision: true }) },
      })
      this.enforceLimit(note, input.actorSessionId)
      return this.get(note.id)!
    })
  }

  update(id: string, input: Partial<Omit<SelfNoteWrite, 'createdBy' | 'basis' | 'sourceRefs' | keyof SelfNoteAuthorship>> & { status?: SelfNoteStatus }): SelfNote {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Self note not found')
      if (current.createdBy === 'companion' && (input.content !== undefined || input.confidence !== undefined ||
        input.evidence !== undefined || input.counterEvidence !== undefined || input.status === undefined)) throw new Error('self-note-author-protected')
      if (current.createdBy === 'companion' && current.status === 'archived' && input.status === 'active' &&
        this.db.prepare("SELECT 1 FROM self_note WHERE created_by='companion' AND json_extract(authorship_json, '$.supersedes')=? LIMIT 1").get(id)) {
        throw new Error('self-note-superseded')
      }
      if (input.content !== undefined && (!input.content.trim() || input.content.trim().length > 500)) throw new Error('Self note content must contain 1 to 500 characters')
      const now = new Date().toISOString()
      const status = input.status ?? current.status
      const next: SelfNote = {
        ...current,
        content: input.content?.trim() ?? current.content,
        confidence: Math.max(0, Math.min(1, input.confidence ?? current.confidence)),
        evidence: input.evidence === undefined ? current.evidence : strings(input.evidence, 'evidence'),
        counterEvidence: input.counterEvidence === undefined ? current.counterEvidence : strings(input.counterEvidence, 'counterEvidence'),
        status,
        updatedAt: now,
        archivedAt: status === 'archived' ? current.archivedAt ?? now : undefined,
      }
      this.save(next)
      this.addRevision(next, input.actorSessionId, input.reason ?? 'update')
      this.recordActivity({
        contextId: current.sourceRefs[0]?.contextId, sessionId: input.actorSessionId, source: 'core.self-note',
        kind: status !== current.status ? `self-note.${status}` : 'self-note.updated', summary: status === 'archived' ? '归档一条自我观察' : '修订一条自我观察',
        status: status === 'archived' ? 'warning' : 'success', data: { noteId: id, previousStatus: current.status, status },
      })
      if (status === 'active') this.enforceLimit(next, input.actorSessionId)
      return this.get(id)!
    })
  }

  rollback(id: string, revision: number, reason: string): SelfNote {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Self note not found')
      if (current.createdBy === 'companion') throw new Error('self-note-author-protected')
      const target = this.revisions(id).find(item => item.revision === revision)
      if (!target) throw new Error('Self note revision not found')
      const next: SelfNote = { ...target.snapshot, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
      this.save(next)
      this.addRevision(next, undefined, `rollback:${revision}:${reason}`)
      this.recordActivity({ contextId: current.sourceRefs[0]?.contextId, source: 'core.self-note', kind: 'self-note.rolled-back', summary: '回滚一条自我观察', data: { noteId: id, revision } })
      if (next.status === 'active') this.enforceLimit(next)
      return this.get(id)!
    })
  }

  revisions(noteId: string, limit = 100): SelfNoteRevision[] {
    return this.db.prepare('SELECT * FROM self_note_revision WHERE note_id=? ORDER BY revision DESC LIMIT ?')
      .all(noteId, Math.floor(Math.max(1, Math.min(500, limit)))).map(row => this.revisionFromRow(row))
  }

  revision(noteId: string, revision: number): SelfNoteRevision | undefined {
    const row = this.db.prepare('SELECT * FROM self_note_revision WHERE note_id=? AND revision=?').get(noteId, revision)
    return row && this.revisionFromRow(row)
  }

  private revisionFromRow(row: unknown): SelfNoteRevision {
    const value = row as { id: number; note_id: string; revision: number; snapshot: string; actor_session_id: string | null; reason: string; created_at: string }
    return { id: Number(value.id), noteId: value.note_id, revision: Number(value.revision), snapshot: JSON.parse(value.snapshot) as SelfNote,
      actorSessionId: value.actor_session_id ?? undefined, reason: value.reason, createdAt: value.created_at }
  }

  private insert(note: SelfNote): void {
    this.db.prepare(`INSERT INTO self_note
      (id,content,basis,status,confidence,evidence_json,counter_evidence_json,source_refs_json,authorship_json,created_by,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(note.id, note.content, note.basis, note.status, note.confidence, JSON.stringify(note.evidence), JSON.stringify(note.counterEvidence), JSON.stringify(note.sourceRefs), JSON.stringify(authorship(note)), note.createdBy, note.createdAt, note.updatedAt, note.archivedAt ?? null)
  }

  private save(note: SelfNote): void {
    this.db.prepare(`UPDATE self_note SET content=?,basis=?,status=?,confidence=?,evidence_json=?,counter_evidence_json=?,source_refs_json=?,authorship_json=?,created_by=?,updated_at=?,archived_at=? WHERE id=?`)
      .run(note.content, note.basis, note.status, note.confidence, JSON.stringify(note.evidence), JSON.stringify(note.counterEvidence), JSON.stringify(note.sourceRefs), JSON.stringify(authorship(note)), note.createdBy, note.updatedAt, note.archivedAt ?? null, note.id)
  }

  private addRevision(note: SelfNote, actorSessionId: string | undefined, reason: string): void {
    const revision = Number((this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM self_note_revision WHERE note_id=?').get(note.id) as { revision: number }).revision)
    this.db.prepare('INSERT INTO self_note_revision (note_id,revision,snapshot,actor_session_id,reason,created_at) VALUES (?,?,?,?,?,?)')
      .run(note.id, revision, JSON.stringify(note), actorSessionId ?? null, reason, new Date().toISOString())
  }

  private enforceLimit(protectedNote: SelfNote, actorSessionId?: string): void {
    const row = this.db.prepare(`SELECT * FROM self_note WHERE status='active' AND created_by=? AND id<>?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1 OFFSET ?`).get(protectedNote.createdBy, protectedNote.id, MAX_ACTIVE_SELF_NOTES - 1)
    if (!row) return
    const oldest = this.fromRow(row)
    const now = new Date().toISOString()
    const archived = { ...oldest, status: 'archived' as const, updatedAt: now, archivedAt: now }
    this.save(archived)
    this.addRevision(archived, actorSessionId, 'active-limit:40')
    this.recordActivity({ contextId: oldest.sourceRefs[0]?.contextId, sessionId: actorSessionId, source: 'core.self-note', kind: 'self-note.archived',
      summary: `${oldest.createdBy === 'companion' ? '自我观察' : '主人反馈'}超过 40 条，最旧有效项已归档`, status: 'warning', data: { noteId: oldest.id } })
  }
}
