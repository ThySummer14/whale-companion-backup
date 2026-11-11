import { z } from 'zod'
import type { CommunityCampReceipt, CommunityView, HomeView } from '../protocol/api.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX, MinecraftVisitBuildReceipt, MinecraftVisitSupplyReceipt } from './minecraft-supply.ts'
import { SURVEY_DIRECTIONS, SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_TRAIL_IDS } from './minecraft-survey.ts'
import { isSurveyWindowKey, surveyWindowKey } from './minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, type AutonomousJob, type TaskRecord } from './model.ts'
import type { CompanionStore } from './store.ts'

const RECENT_LIMIT = 4
const CANDIDATE_LIMIT = 32
const sites = {
  offline: null,
  idle: 'home',
  resting: 'home',
  chatting: 'home',
  minecraft: 'camp',
  speaking: 'studio',
  singing: 'studio',
  browsing: 'library',
} as const satisfies Record<HomeView['activity'], CommunityView['activeSite']>

export function communitySiteFor(activity: HomeView['activity']): CommunityView['activeSite'] {
  return sites[activity]
}

const receipt = { expiresAt: z.int().positive(), receiptTaskId: z.uuid() }
const survey = { ...receipt, surveyZoneId: z.uuid().optional(), windowSurveyZoneId: z.uuid().optional(), windowRuleId: z.uuid().optional(),
  goal: z.literal('survey'), surveyOutcome: z.enum(['completed', 'recovered']) }
const CampPayload = z.union([
  z.strictObject({ ...receipt, zoneId: z.uuid(), goal: z.literal('planks'), visitId: z.uuid(), visitSupply: MinecraftVisitSupplyReceipt }),
  z.strictObject({ ...receipt, zoneId: z.uuid(), goal: z.literal('planks').default('planks') }),
  z.strictObject({ ...receipt, campZoneId: z.uuid(), goal: z.literal('camp'), visitId: z.uuid(), visitBuild: MinecraftVisitBuildReceipt })
    .refine(payload => payload.campZoneId === payload.visitBuild.zoneId),
  z.strictObject({ ...receipt, campZoneId: z.uuid(), goal: z.literal('camp') }),
  z.strictObject({ ...receipt, prepareZoneId: z.uuid(), goal: z.literal('prepare'),
    steps: z.array(z.strictObject({ action: z.enum(['craft', 'build']), taskId: z.uuid() })).min(1).max(3) }),
  z.strictObject({ ...survey, direction: z.enum(SURVEY_DIRECTIONS), surveySteps: z.int().min(SURVEY_DISTANCE).max(SURVEY_MAX_DISTANCE) }),
  z.strictObject({ ...survey, surveyTrail: z.enum(SURVEY_TRAIL_IDS), surveyCheckpoints: z.union([z.literal(0), z.literal(1), z.literal(2)]) })
    .refine(payload => (payload.surveyOutcome === 'completed') === (payload.surveyCheckpoints === 2)),
])

const capability = { planks: 'minecraft.craft', camp: 'minecraft.build', prepare: 'minecraft.build', survey: 'minecraft.survey' } as const

export function verifiedCampReceipt(job: AutonomousJob, findTask: (id: string) => TaskRecord | undefined): {
  childId: string
  item: CommunityCampReceipt
  visitSupply?: { visitId: string; receipt: z.infer<typeof MinecraftVisitSupplyReceipt> }
  visitBuild?: { visitId: string; receipt: z.infer<typeof MinecraftVisitBuildReceipt> }
} | undefined {
  const parent = job.task
  if (job.kind !== 'minecraft.supply' || job.contextId !== MINECRAFT_SUPPLY_CONTEXT || parent.id !== job.id ||
    parent.contextId !== MINECRAFT_SUPPLY_CONTEXT || parent.status !== 'succeeded' || parent.capabilityId !== 'core.autonomy' ||
    parent.externalId !== `autonomy:minecraft.supply:${job.dedupeKey}` || job.createdAt !== parent.createdAt) return undefined
  // Only the autonomy workflow can bind a verified worker task into this payload.
  // A generic activity record or successful Minecraft task alone proves no permit.
  const parsed = CampPayload.safeParse(job.payload)
  if (!parsed.success) return undefined
  const payload = parsed.data
  const visitSupply = 'visitSupply' in payload ? { visitId: payload.visitId, receipt: payload.visitSupply } : undefined
  const visitBuild = 'visitBuild' in payload ? { visitId: payload.visitId, receipt: payload.visitBuild } : undefined
  const visit = visitSupply ?? visitBuild
  if (visit) {
    const daily = findTask(visit.visitId)
    const dailyPrefix = 'autonomy:daily.choice:daily:'
    if (job.dedupeKey !== `visit-${visitBuild ? 'build' : 'supply'}:${visit.visitId}` ||
      daily?.id !== visit.visitId || daily.contextId !== DAILY_AUTONOMY_CONTEXT || daily.capabilityId !== 'core.autonomy' ||
      !daily.externalId?.startsWith(dailyPrefix) || !isSurveyWindowKey(surveyWindowKey(daily.externalId.slice(dailyPrefix.length))) ||
      !(Date.parse(daily.createdAt) <= Date.parse(parent.createdAt))) return undefined
  } else if (job.dedupeKey.startsWith('visit-supply:') || job.dedupeKey.startsWith('visit-build:')) return undefined
  if (payload.goal === 'survey') {
    const authority = isSurveyWindowKey(job.dedupeKey)
      ? !!payload.windowSurveyZoneId && !!payload.windowRuleId && !payload.surveyZoneId
      : !!payload.surveyZoneId && !payload.windowSurveyZoneId && !payload.windowRuleId
    if (!authority) return undefined
  }
  const childId = payload.receiptTaskId
  const created = Date.parse(parent.createdAt)
  const finished = Math.min(Date.parse(parent.updatedAt), payload.expiresAt)
  if (!(created <= finished)) return undefined

  const gameReceipt = (id: string, expected: string, earliest = created, externalId?: string) => {
    const task = findTask(id)
    if (task?.id !== id || task.status !== 'succeeded' || task.contextId !== 'game.minecraft' || task.capabilityId !== expected ||
      externalId !== undefined && task.externalId !== externalId) return undefined
    const start = Date.parse(task.createdAt)
    const end = Date.parse(task.updatedAt)
    return earliest <= start && start <= end && end <= finished ? end : undefined
  }

  const externalId = visit && `${visitBuild ? CAMP_VISIT_BUILD_TASK_PREFIX : CAMP_VISIT_SUPPLY_TASK_PREFIX}${visit.visitId}`
  const timestamp = gameReceipt(childId, capability[payload.goal], created, externalId)
  if (timestamp === undefined || visitBuild && timestamp >= payload.expiresAt) return undefined
  const at = new Date(timestamp).toISOString()
  switch (payload.goal) {
    case 'planks': return { childId, item: { kind: 'supply', at }, ...(visitSupply && { visitSupply }) }
    case 'camp': return { childId, item: { kind: 'build', at }, ...(visitBuild && { visitBuild }) }
    case 'prepare': {
      const crafts = payload.steps.slice(0, -1)
      const build = payload.steps.at(-1)
      if (build?.action !== 'build' || build.taskId !== childId || new Set(payload.steps.map(step => step.taskId)).size !== payload.steps.length) return undefined
      let earliest = created
      for (const craft of crafts) {
        const completion = craft.action === 'craft' ? gameReceipt(craft.taskId, 'minecraft.craft', earliest) : undefined
        if (completion === undefined) return undefined
        earliest = completion
      }
      if (gameReceipt(childId, 'minecraft.build', earliest) === undefined) return undefined
      return { childId, item: { kind: 'prepare', at } }
    }
    case 'survey': return { childId, item: {
      kind: 'survey', at, outcome: payload.surveyOutcome,
      route: 'surveyTrail' in payload
        ? { kind: 'trail', trail: payload.surveyTrail, checkpoints: payload.surveyCheckpoints }
        : { kind: 'straight', direction: payload.direction, steps: payload.surveySteps },
    } }
  }
}

export function projectCommunity(activity: HomeView['activity'], store: Pick<CompanionStore, 'autonomy' | 'taskById'>): CommunityView {
  const candidates = store.autonomy.succeeded('minecraft.supply', MINECRAFT_SUPPLY_CONTEXT, CANDIDATE_LIMIT)
    .flatMap(job => verifiedCampReceipt(job, id => store.taskById(id)) ?? [])
    .sort((a, b) => b.item.at.localeCompare(a.item.at))
  const seen = new Set<string>()
  const recentCamp: CommunityView['recentCamp'] = []
  for (const { childId, item } of candidates) {
    if (seen.has(childId)) continue
    seen.add(childId)
    recentCamp.push(item)
    if (recentCamp.length === RECENT_LIMIT) break
  }
  return { version: 1, activeSite: communitySiteFor(activity), recentCamp }
}
