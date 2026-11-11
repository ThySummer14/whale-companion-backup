import { z } from 'zod'
import type { MinecraftHouseMaterialNeed } from './minecraft-house.ts'
import { HouseRecoveryCompletionResult } from './minecraft-house-verification.ts'

export const HOUSE_RECOVERY_TTL_MS = 2 * 60 * 60_000
export const HOUSE_AGENT_RECOVERY_EVENT = 'world.house-agent-recovery'
export const HOUSE_AGENT_RECOVERY_PREFIX = 'house-agent-recovery:'
export const HOUSE_CELL_TASK_PREFIX = 'minecraft-house-cell:'
export const HOUSE_CELL_CAPABILITY = 'minecraft.house-cell'
export const HOUSE_CELL_ACTIVITY = 'world.house-cell-placed'
export const HOUSE_CELL_AUDIT_PREFIX = 'house-cell-audit:'
export const HOUSE_CELL_AUDIT_ACTIVITY = 'world.house-cell-audit'
export const HOUSE_RECOVERY_PLACEMENT_LIMITS = {
  single: { attempts: 3, placed: 1 },
  continuous: { attempts: 6, placed: 3 },
} as const
export type HouseRecoveryPlacementMode = keyof typeof HOUSE_RECOVERY_PLACEMENT_LIMITS
export const HOUSE_RECOVERY_PLACEMENT_ATTEMPTS = HOUSE_RECOVERY_PLACEMENT_LIMITS.single.attempts

export interface HouseRecoverySource {
  taskId: string
  at: string
  reason: string
  verification?: 'ready' | 'blocked' | 'unavailable'
}

export interface HouseRecoveryObservation {
  state: 'ready' | 'blocked' | 'unavailable'
  checked?: number
  reason?: string
  materials?: MinecraftHouseMaterialNeed[]
}

export const HouseRecoveryPlan = z.string().trim().min(6).max(240).regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u)

export const HouseRecoveryPlacedCell = z.strictObject({
  index: z.int().min(0).max(124),
  material: z.enum(['oak_planks', 'spruce_planks', 'cobblestone', 'glass']),
})
export type HouseRecoveryPlacedCell = z.infer<typeof HouseRecoveryPlacedCell>
export const HouseRecoveryPlacements = z.array(HouseRecoveryPlacedCell).min(1).max(HOUSE_RECOVERY_PLACEMENT_LIMITS.continuous.placed)
  .refine(placements => new Set(placements.map(({ index }) => index)).size === placements.length)

export const HouseRecoveryAgentDecision = z.strictObject({
  plan: HouseRecoveryPlan.optional(),
  observed: z.enum(['ready', 'blocked', 'unavailable']).optional(),
  placed: HouseRecoveryPlacedCell.optional(),
  placements: HouseRecoveryPlacements.optional(),
  verification: HouseRecoveryCompletionResult.optional(),
  at: z.iso.datetime(),
}).refine(value => !!(value.plan || value.observed || value.placed || value.placements) && !(value.placed && value.placements) &&
  (!value.verification || !!value.placements && (value.verification.outcome === 'incomplete' || value.placements.length === value.verification.placed)))
