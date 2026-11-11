import { z } from 'zod'
import { MinecraftAuthorizedZone } from './minecraft-supply.ts'
import { SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_MIN_RADIUS, SURVEY_TRAIL_IDS } from '../protocol/api.ts'

export { SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_MIN_RADIUS, SURVEY_TRAIL_IDS, SURVEY_TRAIL_LEG, type SurveyTrailId } from '../protocol/api.ts'

export const SURVEY_DIRECTIONS = ['north', 'east', 'south', 'west'] as const
export const CAMP_VISIT_SURVEY_TASK_PREFIX = 'minecraft-visit-survey:'
export const CAMP_VISIT_PATROL_TASK_PREFIX = 'minecraft-visit-patrol:'
export const CAMP_PATROL_MAX_MS = 15 * 60_000
export type SurveyDirection = (typeof SURVEY_DIRECTIONS)[number]
const Direction = z.enum(SURVEY_DIRECTIONS)
const Trail = z.enum(SURVEY_TRAIL_IDS)
const SurveyDistance = z.int().min(SURVEY_DISTANCE).max(SURVEY_MAX_DISTANCE)
const PatrolSegmentIndex = z.union([z.literal(1), z.literal(2)])
const SurveyZone = MinecraftAuthorizedZone.extend({ radius: z.int().min(SURVEY_MIN_RADIUS).max(SURVEY_MAX_DISTANCE + 1) })

export const MinecraftSurveyPreviewRequest = z.strictObject({ zone: SurveyZone })
const StraightSurvey = MinecraftSurveyPreviewRequest.extend({ direction: Direction, steps: SurveyDistance.optional() })
  .refine(({ steps, zone }) => steps === undefined || steps < zone.radius)
export const MinecraftPatrolSegmentRequest = StraightSurvey.safeExtend({ steps: SurveyDistance, index: PatrolSegmentIndex })
export type MinecraftPatrolSegmentRequest = z.infer<typeof MinecraftPatrolSegmentRequest>
const TrailSurvey = MinecraftSurveyPreviewRequest.extend({ trail: Trail })
export const MinecraftSurveyRequest = z.union([StraightSurvey, TrailSurvey])
export const MinecraftSurveyPreview = z.strictObject({
  directions: z.array(Direction).max(SURVEY_DIRECTIONS.length).refine(items => new Set(items).size === items.length),
  routes: z.array(z.strictObject({ direction: Direction, steps: SurveyDistance })).max(SURVEY_DIRECTIONS.length).optional(),
  trails: z.array(Trail).max(SURVEY_TRAIL_IDS.length).refine(items => new Set(items).size === items.length).optional(),
}).refine(({ directions, routes }) => !routes || (routes.length === directions.length &&
  directions.every(direction => routes.some(route => route.direction === direction))))
export type MinecraftSurveyOffer = z.infer<typeof MinecraftSurveyPreview>

const SurveyReturn = z.strictObject({
  zoneId: z.uuid(),
  direction: Direction,
  steps: SurveyDistance,
  returned: z.literal(true),
})
const SurveyCompleted = SurveyReturn.extend({ surveyed: z.literal(true), reached: z.literal(true) })
const SurveyRecovered = SurveyReturn.extend({ surveyed: z.literal(false), reached: z.literal(false), reason: z.literal('survey-terrain-changed') })
export const MinecraftSurveyReceipt = z.discriminatedUnion('surveyed', [SurveyCompleted, SurveyRecovered])
export const MinecraftPatrolSegmentReceipt = z.discriminatedUnion('surveyed', [
  SurveyCompleted.extend({ index: PatrolSegmentIndex }),
  SurveyRecovered.extend({ index: PatrolSegmentIndex }),
])
export type MinecraftPatrolSegmentReceipt = z.infer<typeof MinecraftPatrolSegmentReceipt>

const TrailReturn = z.strictObject({ zoneId: z.uuid(), trail: Trail, returned: z.literal(true) })
export const MinecraftTrailReceipt = z.discriminatedUnion('outcome', [
  TrailReturn.extend({ outcome: z.literal('completed'), checkpoints: z.literal(2) }),
  TrailReturn.extend({ outcome: z.literal('recovered'), checkpoints: z.union([z.literal(0), z.literal(1)]), reason: z.literal('survey-terrain-changed') }),
])
