import { z } from 'zod'
import { CAMP_VISIT_GATHER_TASK_PREFIX, MinecraftCampGatherOffer, MinecraftCampGatherReceipt } from '../core/minecraft-gather.ts'
import { isSurveyWindowKey, surveyWindowKey } from '../core/minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, type AutonomousJob } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { MinecraftCampGatherView } from '../protocol/api.ts'

const GatherPermit = z.object({
  choice: z.literal('gather'), date: z.string().refine(date => isSurveyWindowKey(surveyWindowKey(date))),
  visitId: z.uuid(), gatherZoneId: z.uuid(), expiresAt: z.int().positive(), visitExpiresAt: z.int().positive(),
  visitJoined: z.literal(true).optional(), visitStatus: z.enum(['starting', 'online', 'offline', 'unconfirmed']),
  gatherOffer: MinecraftCampGatherOffer.optional(),
  gatherForProject: z.literal(true).optional(),
}).refine(permit => permit.visitExpiresAt <= permit.expiresAt)

const SavedGather = z.strictObject({ taskId: z.uuid(), receipt: MinecraftCampGatherReceipt })
type GatherProof = z.infer<typeof SavedGather> & { activityId?: number }
type GatherStore = Pick<CompanionStore, 'taskByExternalId' | 'activityByEventId'>

function gatherPermit(job: AutonomousJob) {
  const permit = GatherPermit.safeParse(job.payload).data
  if (!permit || permit.visitId !== job.id || job.kind !== 'daily.choice' || job.contextId !== DAILY_AUTONOMY_CONTEXT ||
    job.dedupeKey !== `daily:${permit.date}` || job.task.id !== job.id || job.task.contextId !== job.contextId ||
    job.task.externalId !== `autonomy:daily.choice:${job.dedupeKey}` || job.task.capabilityId !== 'core.autonomy' || job.task.createdAt !== job.createdAt) return
  return permit
}

export function campGatherProof(store: GatherStore, job: AutonomousJob): GatherProof | undefined {
  const permit = gatherPermit(job)
  if (!permit?.visitJoined || !permit.gatherOffer) return
  const key = `${CAMP_VISIT_GATHER_TASK_PREFIX}${job.id}`
  const task = store.taskByExternalId(key)
  if (task?.status !== 'succeeded' || task.contextId !== 'game.minecraft' || task.capabilityId !== 'minecraft.dig') return
  const started = Date.parse(task.createdAt)
  const finished = Date.parse(task.updatedAt)
  if (!(Date.parse(job.createdAt) <= started && started <= finished && finished < permit.visitExpiresAt)) return
  const activity = store.activityByEventId(`${key}:receipt`)
  if (activity && (activity.contextId !== DAILY_VISIT_CONTEXT || activity.source !== 'game.minecraft' || activity.kind !== 'world.visit-gather' ||
    activity.status !== 'success' || activity.taskId !== task.id || activity.sessionId !== undefined ||
    !(started <= Date.parse(activity.occurredAt) && Date.parse(activity.occurredAt) < permit.visitExpiresAt))) return
  const snapshot = SavedGather.safeParse(job.payload.gatherCheck).data
  const receipt = activity ? MinecraftCampGatherReceipt.safeParse(activity.data.receipt).data
    : snapshot?.taskId === task.id ? snapshot.receipt : undefined
  if (!receipt || receipt.zoneId !== permit.gatherZoneId || receipt.direction !== permit.gatherOffer.direction ||
    receipt.steps !== permit.gatherOffer.steps || receipt.log !== permit.gatherOffer.log ||
    permit.gatherForProject && receipt.inventoryBefore >= 3) return
  return { taskId: task.id, receipt, ...(activity && { activityId: activity.id }) }
}

export function campGatherView(store: GatherStore, job: AutonomousJob | undefined): MinecraftCampGatherView | undefined {
  const permit = job && gatherPermit(job)
  if (!job || !permit) return
  const collected = campGatherProof(store, job)?.receipt.collected ?? 0
  const status = job.task.status === 'running' ? 'running' : job.task.status === 'cancelled' ? 'cancelled'
    : job.task.status === 'succeeded' && collected === 1 && permit.visitStatus === 'offline' ? 'completed' : 'failed'
  return { status, collected, visitStatus: permit.visitStatus }
}
