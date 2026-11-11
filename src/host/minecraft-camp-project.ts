import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CAMP_VISIT_GATHER_TASK_PREFIX, MinecraftCampGatherReceipt } from '../core/minecraft-gather.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX, MinecraftVisitBuildReceipt, MinecraftVisitRevisitReceipt, MinecraftVisitSupplyReceipt } from '../core/minecraft-supply.ts'
import { isSurveyWindowKey, surveyWindowKey } from '../core/minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, type AutonomousJob } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { MinecraftCampProjectView, MinecraftSurveyWindowRule } from '../protocol/api.ts'
import { verifiedDailyReflectionSource } from './daily-reflection-source.ts'
import { campGatherProof } from './minecraft-camp-gather.ts'

const VisitDay = z.object({
  windowRuleId: z.uuid(), date: z.string().refine(date => isSurveyWindowKey(surveyWindowKey(date))),
  expiresAt: z.int().positive(), visitExpiresAt: z.int().positive(), visitId: z.uuid(),
  visitJoined: z.literal(true), visitStatus: z.enum(['online', 'offline', 'unconfirmed']),
})
const ProjectDay = z.discriminatedUnion('choice', [
  VisitDay.extend({ choice: z.enum(['supply', 'build', 'revisit']), activityTaskId: z.uuid() }),
  VisitDay.extend({ choice: z.literal('gather'), gatherForProject: z.literal(true), gatherZoneId: z.uuid() }),
]).refine(day => day.visitExpiresAt <= day.expiresAt)

const RevisitPayload = z.strictObject({
  goal: z.literal('revisit'), campZoneId: z.uuid(), visitId: z.uuid(), expiresAt: z.int().positive(),
  constructionTaskId: z.uuid(), receiptTaskId: z.uuid(), visitRevisit: MinecraftVisitRevisitReceipt,
})

const VisitProof = {
  gather: { prefix: CAMP_VISIT_GATHER_TASK_PREFIX, schema: z.strictObject({ receipt: MinecraftCampGatherReceipt }) },
  supply: { prefix: CAMP_VISIT_SUPPLY_TASK_PREFIX, schema: z.strictObject({ receipt: MinecraftVisitSupplyReceipt }) },
  build: { prefix: CAMP_VISIT_BUILD_TASK_PREFIX, schema: z.strictObject({ receipt: MinecraftVisitBuildReceipt }) },
  revisit: { prefix: CAMP_VISIT_REVISIT_TASK_PREFIX, schema: z.strictObject({ receipt: MinecraftVisitRevisitReceipt }) },
}
const OfflineData = z.strictObject({})

export interface CampConstruction {
  taskId: string
  date: string
  material: MinecraftVisitBuildReceipt['material']
  at: string
}

interface CampProjectCompletion {
  taskId: string
  constructionTaskId: string
  receiptTaskId: string
  at: string
  supplyVisits: number
  gatheredLogs: number
}

type ProjectStore = Parameters<typeof verifiedDailyReflectionSource>[0] & Pick<CompanionStore, 'taskByExternalId' | 'activityByEventId'>

function projectDay(job: AutonomousJob, rule: MinecraftSurveyWindowRule) {
  const day = ProjectDay.safeParse(job.payload).data
  if (!day || day.windowRuleId !== rule.id || day.visitId !== job.id || day.expiresAt > rule.expiresAt ||
    job.kind !== 'daily.choice' || job.contextId !== DAILY_AUTONOMY_CONTEXT || job.dedupeKey !== `daily:${day.date}` ||
    job.task.contextId !== DAILY_AUTONOMY_CONTEXT || job.task.capabilityId !== 'core.autonomy' || job.task.id !== job.id ||
    job.task.externalId !== `autonomy:daily.choice:${job.dedupeKey}` || job.task.createdAt !== job.createdAt ||
    !(rule.createdAt <= Date.parse(job.createdAt) && Date.parse(job.createdAt) < day.visitExpiresAt)) return undefined
  return day
}

export function verifiedCampRevisit(store: ProjectStore, rule: MinecraftSurveyWindowRule, daily: AutonomousJob,
  construction: CampConstruction): { matchedBlocks: number; at: string; taskId: string; confirmedAt: string; receipt: MinecraftVisitRevisitReceipt } | undefined {
  const day = projectDay(daily, rule)
  if (day?.choice !== 'revisit' || day.visitStatus !== 'offline' || day.date <= construction.date) return
  const child = store.autonomy.get(day.activityTaskId)
  const payload = RevisitPayload.safeParse(child?.payload).data
  const dedupeKey = `visit-revisit:${daily.id}`
  if (!child || !payload || child.kind !== 'minecraft.supply' || child.contextId !== MINECRAFT_SUPPLY_CONTEXT || child.dedupeKey !== dedupeKey ||
    child.task.id !== child.id || child.task.contextId !== MINECRAFT_SUPPLY_CONTEXT || child.task.capabilityId !== 'core.autonomy' ||
    child.task.externalId !== `autonomy:minecraft.supply:${dedupeKey}` || child.task.status !== 'succeeded' ||
    payload.visitId !== daily.id || payload.expiresAt !== day.visitExpiresAt || payload.campZoneId !== rule.zoneId ||
    payload.constructionTaskId !== construction.taskId || payload.visitRevisit.zoneId !== rule.zoneId ||
    payload.visitRevisit.material !== construction.material) return
  const receipt = store.taskById(payload.receiptTaskId)
  if (receipt?.contextId !== 'game.minecraft' || receipt.capabilityId !== 'minecraft.survey' || receipt.status !== 'succeeded' ||
    receipt.externalId !== `${CAMP_VISIT_REVISIT_TASK_PREFIX}${daily.id}`) return
  const start = Date.parse(receipt.createdAt)
  const at = Date.parse(receipt.updatedAt)
  if (!(Date.parse(construction.at) <= Date.parse(daily.createdAt) && Date.parse(daily.createdAt) <= Date.parse(child.createdAt) &&
    Date.parse(child.createdAt) <= start && start <= at && at < day.visitExpiresAt && at <= Date.parse(child.task.updatedAt) &&
    (daily.task.status === 'running' || Date.parse(child.task.updatedAt) <= Date.parse(daily.task.updatedAt)))) return
  return { matchedBlocks: payload.visitRevisit.matchedBlocks, at: receipt.updatedAt, taskId: receipt.id,
    confirmedAt: child.task.updatedAt, receipt: payload.visitRevisit }
}

interface ProjectVisitEvidence {
  job: AutonomousJob
  day: z.infer<typeof ProjectDay>
  taskId: string
  receipt: unknown
  confirmedAt?: string
}

function verifiedProjectVisit(store: ProjectStore, localDate: Intl.DateTimeFormat, evidence: ProjectVisitEvidence): string | undefined {
  const { job, day, taskId, receipt } = evidence
  const { choice } = day
  const { prefix, schema } = VisitProof[choice]
  const externalId = `${prefix}${job.id}`
  const game = store.taskById(taskId)
  const action = store.activityByEventId(`${externalId}:receipt`)
  const offline = store.activityByEventId(`minecraft-visit:${job.id}:offline`)
  const found = schema.safeParse(action?.data).data?.receipt
  if (game?.externalId !== externalId || action?.contextId !== DAILY_VISIT_CONTEXT || action.source !== 'game.minecraft' ||
    action.kind !== `world.visit-${choice}` || action.status !== 'success' || action.taskId !== taskId || action.sessionId !== undefined ||
    !found || !isDeepStrictEqual(found, receipt) || offline?.contextId !== 'game.minecraft' || offline.source !== 'game.minecraft' ||
    offline.kind !== 'world.visit-offline' || offline.status !== 'success' || offline.taskId !== job.id || offline.sessionId !== undefined ||
    !OfflineData.safeParse(offline.data).success) return
  const created = Date.parse(job.createdAt)
  const readback = Date.parse(action.occurredAt)
  const disconnected = Date.parse(offline.occurredAt)
  const finalized = Date.parse(job.task.updatedAt)
  const confirmed = evidence.confirmedAt === undefined ? disconnected : Date.parse(evidence.confirmedAt)
  if (!(created <= Date.parse(game.createdAt) && Date.parse(game.updatedAt) <= readback && readback < day.visitExpiresAt &&
    readback <= confirmed && confirmed <= disconnected && disconnected <= finalized && finalized <= Date.now()) || action.id >= offline.id ||
    localDate.format(created) !== day.date || localDate.format(readback) !== day.date) return
  return new Date(disconnected).toISOString()
}

function verifiedProjectCompletion(store: ProjectStore, rule: MinecraftSurveyWindowRule, construction: ProjectVisitEvidence,
  revisit: ProjectVisitEvidence, preparation: ProjectVisitEvidence[]): CampProjectCompletion | undefined {
  try {
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: rule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const constructionOffline = verifiedProjectVisit(store, localDate, construction)
    const at = verifiedProjectVisit(store, localDate, revisit)
    if (!constructionOffline || !at || Date.parse(constructionOffline) > Date.parse(revisit.job.createdAt)) return
    const confirmed = preparation.filter(evidence => verifiedProjectVisit(store, localDate, evidence))
    return { taskId: revisit.job.id, constructionTaskId: construction.taskId, receiptTaskId: revisit.taskId, at,
      supplyVisits: confirmed.filter(evidence => evidence.day.choice === 'supply').length,
      gatheredLogs: confirmed.filter(evidence => evidence.day.choice === 'gather').length }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
}

export function campProject(store: ProjectStore, rule: MinecraftSurveyWindowRule, beforeDate?: string): {
  view: MinecraftCampProjectView; construction?: CampConstruction; completion?: CampProjectCompletion
} {
  let supplyVisits = 0
  let gatheredLogs = 0
  const counts = () => ({ supplyVisits, ...(rule.allowMinecraftProjectGather && { gatheredLogs }) })
  let construction: CampConstruction | undefined
  let constructionEvidence: ProjectVisitEvidence | undefined
  const preparation: ProjectVisitEvidence[] = []
  for (const job of store.autonomy.campProjectDays(rule.id)) {
    const day = projectDay(job, rule)
    if (!day || beforeDate !== undefined && day.date >= beforeDate) continue
    const closed = job.task.status === 'succeeded' && day.visitStatus === 'offline'
    if (construction) {
      const checked = closed && verifiedCampRevisit(store, rule, job, construction)
      if (checked) {
        const complete = checked.matchedBlocks === 9
        const completion = complete && constructionEvidence && verifiedProjectCompletion(store, rule, constructionEvidence,
          { job, day, taskId: checked.taskId, confirmedAt: checked.confirmedAt, receipt: checked.receipt }, preparation)
        return { construction, ...(completion && { completion }), view: { stage: complete ? 'complete' : 'needs-review',
          ...counts(), builtAt: construction.at, revisitedAt: checked.at } }
      }
      continue
    }
    if (day.choice === 'gather') {
      if (closed && rule.allowMinecraftProjectGather && day.gatherZoneId === rule.zoneId) {
        const proof = campGatherProof(store, job)
        if (proof) {
          gatheredLogs += proof.receipt.collected
          preparation.push({ job, day, taskId: proof.taskId, receipt: proof.receipt })
        }
      }
      continue
    }
    if (day.choice === 'revisit') continue
    const proof = closed && verifiedDailyReflectionSource(store, job.id)
    const child = proof ? store.autonomy.get(day.activityTaskId) : undefined
    if (day.choice === 'supply') {
      if (proof && proof.experience.kind === 'supply' && child?.payload.zoneId === rule.zoneId) {
        supplyVisits++
        const receipt = MinecraftVisitSupplyReceipt.safeParse(child.payload.visitSupply).data
        if (receipt) preparation.push({ job, day, taskId: proof.experience.receiptTaskId, confirmedAt: child.task.updatedAt, receipt })
      }
      continue
    }
    const receipt = MinecraftVisitBuildReceipt.safeParse(child?.payload.visitBuild).data
    if (receipt?.zoneId === rule.zoneId && proof && proof.experience.kind === 'build' && child) {
      construction = { taskId: proof.experience.receiptTaskId, date: day.date, material: receipt.material, at: proof.at }
      constructionEvidence = { job, day, taskId: construction.taskId, confirmedAt: child.task.updatedAt, receipt }
      continue
    }
    const game = store.taskByExternalId(`${CAMP_VISIT_BUILD_TASK_PREFIX}${job.id}`)
    if (game?.contextId === 'game.minecraft' && game.capabilityId === 'minecraft.build' && game.status !== 'accepted') {
      return { view: { stage: 'needs-review', ...counts() } }
    }
  }
  return { construction, view: construction ? { stage: 'revisit', ...counts(), builtAt: construction.at } : { stage: 'gathering', ...counts() } }
}
