import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DailyInitiativeRecord, DailyInitiativeSelectionReceipt } from './daily-initiative.ts'
import { MinecraftHouseReceipt } from './minecraft-house.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY, HOUSE_PROJECT_SUPPLY_CAPABILITY, HOUSE_PROJECT_SUPPLY_EVENT,
  type MinecraftHouseProjectSectionReceipt } from './minecraft-house-project.ts'
import { MinecraftHouseSupplyReceipt, MinecraftHouseSupplyRequest } from './minecraft-house-supply.ts'
import type { MinecraftHouseProjectRepository } from './minecraft-house-project-repository.ts'
import { isSurveyWindowKey, surveyWindowKey } from './minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT, type ActivityRecord, type AutonomousJob, type TaskRecord } from './model.ts'

export const DAILY_HOUSE_PROJECT_LIMIT_MS = 7 * 60_000

const Id = z.uuid()
export const DailyHouseSelection = z.strictObject({
  projectId: Id, zoneId: Id, section: z.int().min(0).max(5),
  recovery: z.literal(true).optional(), deadline: z.int().positive(),
})

export const DailyHouseSupplySelection = z.strictObject({
  projectId: Id, zoneId: Id, section: DailyHouseSelection.shape.section,
  recipe: MinecraftHouseSupplyRequest.shape.recipe, missing: MinecraftHouseSupplyRequest.shape.missing,
  deadline: DailyHouseSelection.shape.deadline,
})
type DailyHouseSupplySelection = z.infer<typeof DailyHouseSupplySelection>

const DailyHouseAction = z.object({
  windowRuleId: Id,
  date: z.string().refine(date => isSurveyWindowKey(surveyWindowKey(date))),
  expiresAt: z.int().positive(),
  activityTaskId: Id,
  initiative: DailyInitiativeRecord,
  initiativeReceipt: DailyInitiativeSelectionReceipt,
  visitId: z.never().optional(),
  visitExpiresAt: z.never().optional(),
  visitJoined: z.never().optional(),
  visitStatus: z.never().optional(),
})
const DailyHousePermit = DailyHouseAction.extend({ choice: z.literal('house-project'), houseSection: DailyHouseSelection,
  houseSupply: z.never().optional() })
const DailyHouseSupplyPermit = DailyHouseAction.extend({ choice: z.literal('house-project-supply'), houseSupply: DailyHouseSupplySelection,
  houseSection: z.never().optional() })
const SectionReceipt = MinecraftHouseReceipt.safeExtend({ recovery: z.literal(true).optional() })
const SectionEvent = SectionReceipt.safeExtend({ projectId: Id, index: DailyHouseSelection.shape.section, dailyTaskId: Id })
const SupplyEvent = MinecraftHouseSupplyReceipt.safeExtend({ projectId: Id, zoneId: Id, index: DailyHouseSelection.shape.section,
  dailyTaskId: Id, missing: DailyHouseSupplySelection.shape.missing })
const ActivityTime = z.iso.datetime()
const SECTION_ACTIVITY = 'world.house-project-section'
const GAME_CONTEXT = 'game.minecraft'

export interface DailyHouseProjectProofStore {
  taskById(id: string): TaskRecord | undefined
  activityByTask(taskId: string, kind: string, contextId: string): ActivityRecord | undefined
  minecraftHouseProjects: Pick<MinecraftHouseProjectRepository, 'sectionReceiptByTask'>
}

export interface DailyHouseProjectProof {
  projectId: string
  zoneId: string
  section: number
  receipt: MinecraftHouseProjectSectionReceipt
  activityId: number
  at: string
}

function authorizedDailyChild(store: Pick<DailyHouseProjectProofStore, 'taskById'>, job: AutonomousJob,
  permit: z.infer<typeof DailyHouseAction>, deadline: number, option: string, capability: string) {
  const { task } = job
  if (!Id.safeParse(job.id).success || job.kind !== 'daily.choice' || job.contextId !== DAILY_AUTONOMY_CONTEXT ||
    job.dedupeKey !== `daily:${permit.date}` || task.id !== job.id || task.contextId !== job.contextId ||
    task.capabilityId !== 'core.autonomy' || task.externalId !== `autonomy:daily.choice:${job.dedupeKey}` ||
    task.createdAt !== job.createdAt || (task.status !== 'running' && task.status !== 'succeeded') ||
    permit.initiative.option !== option || deadline > permit.expiresAt) return
  const child = store.taskById(permit.activityTaskId)
  if (child?.id === permit.activityTaskId && child.status === 'succeeded' && child.capabilityId === capability &&
    child.contextId === GAME_CONTEXT && child.externalId === `${DAILY_HOUSE_PROJECT_TASK_PREFIX}${job.id}`) return child
}

function confirmedDailyHouseActivity(activity: ActivityRecord | undefined, job: AutonomousJob, child: TaskRecord, kind: string,
  deadline: number): activity is ActivityRecord {
  if (!activity || !Number.isSafeInteger(activity.id) || activity.id <= 0 || activity.taskId !== child.id ||
    activity.contextId !== GAME_CONTEXT || activity.kind !== kind || activity.source !== GAME_CONTEXT ||
    activity.status !== 'success' || !ActivityTime.safeParse(activity.occurredAt).success) return false
  const created = Date.parse(job.createdAt)
  const started = Date.parse(child.createdAt)
  const finished = Date.parse(child.updatedAt)
  const at = Date.parse(activity.occurredAt)
  const parentUpdated = Date.parse(job.task.updatedAt)
  return created <= started && started <= finished && finished <= at && at < deadline &&
    deadline - started <= DAILY_HOUSE_PROJECT_LIMIT_MS && created <= parentUpdated &&
    (job.task.status === 'running' || at <= parentUpdated)
}

export function verifiedDailyHouseProjectSection(store: DailyHouseProjectProofStore, job: AutonomousJob): DailyHouseProjectProof | undefined {
  const permit = DailyHousePermit.safeParse(job.payload).data
  if (!permit) return
  const selected = permit.houseSection
  const child = authorizedDailyChild(store, job, permit, selected.deadline, `house:${selected.section + 1}`, HOUSE_PROJECT_SECTION_CAPABILITY)
  if (!child) return

  let proof: ReturnType<DailyHouseProjectProofStore['minecraftHouseProjects']['sectionReceiptByTask']>
  let activity: ActivityRecord | undefined
  try {
    proof = store.minecraftHouseProjects.sectionReceiptByTask(child.id)
    activity = store.activityByTask(child.id, SECTION_ACTIVITY, GAME_CONTEXT)
  } catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
  const saved = SectionReceipt.safeParse(proof?.receipt).data
  if (!proof || !saved || proof.projectId !== selected.projectId || proof.zoneId !== selected.zoneId || proof.section !== selected.section ||
    saved.zoneId !== selected.zoneId || saved.recovery !== selected.recovery) return

  if (!confirmedDailyHouseActivity(activity, job, child, SECTION_ACTIVITY, selected.deadline)) return
  const event = SectionEvent.safeParse(activity.data).data
  if (!event) return
  const { projectId, index, dailyTaskId, ...workerReceipt } = event
  if (projectId !== selected.projectId || index !== selected.section || dailyTaskId !== job.id ||
    !isDeepStrictEqual(workerReceipt, saved)) return
  return { projectId: proof.projectId, zoneId: proof.zoneId, section: proof.section, receipt: saved, activityId: activity.id, at: activity.occurredAt }
}

export function dailyHouseProjectReflectionFact({ section, receipt }: Pick<DailyHouseProjectProof, 'section' | 'receipt'>): string {
  const action = receipt.recovery ? '通过站位恢复流程续建' : '自主施工'
  return `在 Minecraft ${action}第 ${section + 1} 个分区，核对 ${receipt.checked} 处位置，实际放置 ${receipt.placed} 块。`
}

export function dailyHouseSupplyOption(section: number, recipe: DailyHouseSupplySelection['recipe']): string {
  return `house-supply:${section + 1}:${recipe === 'oak_planks' ? 'oak' : 'spruce'}`
}

export function dailyHouseSupplyFact(section: number, recipe: DailyHouseSupplySelection['recipe']): string {
  const wood = recipe === 'oak_planks' ? '橡木' : '云杉'
  return `在 Minecraft 为建筑工程第 ${section + 1} 段备料，消耗 1 根${wood}原木并合成 4 块${wood}木板。`
}

export function verifiedDailyHouseSupply(store: Pick<DailyHouseProjectProofStore, 'taskById' | 'activityByTask'>, job: AutonomousJob) {
  const permit = DailyHouseSupplyPermit.safeParse(job.payload).data
  if (!permit) return
  const selection = permit.houseSupply
  const { section, recipe, deadline } = selection
  const child = authorizedDailyChild(store, job, permit, deadline, dailyHouseSupplyOption(section, recipe), HOUSE_PROJECT_SUPPLY_CAPABILITY)
  if (!child) return
  let activity
  try { activity = store.activityByTask(child.id, HOUSE_PROJECT_SUPPLY_EVENT, GAME_CONTEXT) }
  catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
  if (!confirmedDailyHouseActivity(activity, job, child, HOUSE_PROJECT_SUPPLY_EVENT, deadline)) return
  const event = SupplyEvent.safeParse(activity.data).data
  if (!event || event.projectId !== selection.projectId || event.zoneId !== selection.zoneId || event.index !== section ||
    event.dailyTaskId !== job.id || event.missing !== selection.missing || event.name !== recipe) return
  return { ...selection, at: activity.occurredAt, fact: dailyHouseSupplyFact(section, recipe) }
}
