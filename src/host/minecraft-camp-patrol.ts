import { z } from 'zod'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, type AutonomousJob } from '../core/model.ts'
import { isSurveyWindowKey, surveyWindowKey } from '../core/minecraft-survey-window.ts'
import { CAMP_VISIT_PATROL_TASK_PREFIX, MinecraftPatrolSegmentReceipt } from '../core/minecraft-survey.ts'
import type { CompanionStore } from '../core/store.ts'
import type { MinecraftCampPatrolView } from '../protocol/api.ts'

const PatrolPermit = z.object({
  choice: z.literal('patrol'), date: z.string().refine(date => isSurveyWindowKey(surveyWindowKey(date))),
  visitId: z.uuid(), patrolZoneId: z.uuid(), visitExpiresAt: z.int().positive(), expiresAt: z.int().positive(),
  visitJoined: z.literal(true).optional(), visitStatus: z.enum(['starting', 'online', 'offline', 'unconfirmed']),
}).refine(permit => permit.visitExpiresAt <= permit.expiresAt)

const SavedPatrolLeg = z.strictObject({ taskId: z.uuid(), receipt: MinecraftPatrolSegmentReceipt })
export type PatrolLeg = z.infer<typeof SavedPatrolLeg> & { activityId?: number }
type PatrolStore = Pick<CompanionStore, 'taskByExternalId' | 'activityByEventId'>

function patrolPermit(job: AutonomousJob) {
  const permit = PatrolPermit.safeParse(job.payload).data
  if (!permit || job.id !== permit.visitId || job.kind !== 'daily.choice' || job.contextId !== DAILY_AUTONOMY_CONTEXT ||
    job.dedupeKey !== `daily:${permit.date}` || job.task.id !== job.id || job.task.contextId !== job.contextId ||
    job.task.externalId !== `autonomy:daily.choice:${job.dedupeKey}` || job.task.capabilityId !== 'core.autonomy' ||
    job.task.createdAt !== job.createdAt) return
  return permit
}

export function campPatrolLegs(store: PatrolStore, job: AutonomousJob): PatrolLeg[] {
  const permit = patrolPermit(job)
  if (!permit?.visitJoined) return []
  const saved = z.array(SavedPatrolLeg).max(2).safeParse(job.payload.patrolChecks).data ?? []
  const legs: PatrolLeg[] = []
  let earliest = Date.parse(job.createdAt)
  for (const index of [1, 2] as const) {
    const key = `${CAMP_VISIT_PATROL_TASK_PREFIX}${job.id}:${index}`
    const task = store.taskByExternalId(key)
    if (task?.capabilityId !== 'minecraft.survey' || task.contextId !== 'game.minecraft' || task.status !== 'succeeded') break
    const started = Date.parse(task.createdAt)
    const finished = Date.parse(task.updatedAt)
    if (!(earliest <= started && started <= finished && finished < permit.visitExpiresAt)) break
    const activity = store.activityByEventId(`${key}:receipt`)
    const snapshot = saved[index - 1]
    if (activity && (activity.contextId !== DAILY_VISIT_CONTEXT || activity.source !== 'game.minecraft' || activity.kind !== 'world.patrol-segment' ||
      activity.status !== 'success' || activity.taskId !== task.id || activity.sessionId !== undefined ||
      !(started <= Date.parse(activity.occurredAt) && Date.parse(activity.occurredAt) < permit.visitExpiresAt))) break
    const receipt = activity ? MinecraftPatrolSegmentReceipt.safeParse(activity.data.receipt).data
      : snapshot?.taskId === task.id ? snapshot.receipt : undefined
    if (!receipt || receipt.index !== index || receipt.zoneId !== permit.patrolZoneId ||
      legs[0] && (!legs[0].receipt.surveyed || legs[0].receipt.direction === receipt.direction)) break
    legs.push({ taskId: task.id, receipt, ...(activity && { activityId: activity.id }) })
    earliest = finished
  }
  return legs
}

export function campPatrolView(store: PatrolStore, job: AutonomousJob | undefined): MinecraftCampPatrolView | undefined {
  const permit = job && patrolPermit(job)
  if (!job || !permit) return
  const completedSegments = campPatrolLegs(store, job).filter(leg => leg.receipt.surveyed).length
  const status = job.task.status === 'running' ? 'running' : job.task.status === 'cancelled' ? 'cancelled'
    : job.task.status === 'succeeded' && completedSegments === 2 && permit.visitStatus === 'offline' ? 'completed'
      : completedSegments > 0 ? 'partial' : 'failed'
  return { status, completedSegments, totalSegments: 2, visitStatus: permit.visitStatus }
}
