import { z } from 'zod'
import { MinecraftPatrolSegmentRequest, MinecraftSurveyPreviewRequest } from './minecraft-survey.ts'
export { minecraftProjectGatherEligible } from './minecraft-supply.ts'

export const CAMP_VISIT_GATHER_TASK_PREFIX = 'minecraft-visit-gather:'
export const CAMP_GATHER_MAX_MS = 15 * 60_000

const Route = {
  direction: MinecraftPatrolSegmentRequest.shape.direction,
  steps: MinecraftPatrolSegmentRequest.shape.steps,
}
const OakLog = z.literal('oak_log')

export const MinecraftCampGatherRequest = MinecraftSurveyPreviewRequest.extend(Route)
  .refine(({ zone, steps }) => steps < zone.radius)
export type MinecraftCampGatherRequest = z.infer<typeof MinecraftCampGatherRequest>

export const MinecraftCampGatherOffer = z.strictObject({ ...Route, log: OakLog })
export type MinecraftCampGatherOffer = z.infer<typeof MinecraftCampGatherOffer>

export const MinecraftCampGatherReceipt = z.strictObject({
  zoneId: z.uuid(),
  ...Route,
  log: OakLog,
  collected: z.literal(1),
  returned: z.literal(true),
  inventoryBefore: z.int().nonnegative(),
  inventoryAfter: z.int().positive(),
}).refine(({ inventoryBefore, inventoryAfter }) => inventoryAfter - inventoryBefore === 1)
export type MinecraftCampGatherReceipt = z.infer<typeof MinecraftCampGatherReceipt>
