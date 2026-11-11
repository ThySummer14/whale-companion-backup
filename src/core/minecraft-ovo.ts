import { z } from 'zod'
import { MinecraftAuthorizedZone } from './minecraft-supply.ts'

export function minecraftOvoDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/u, '')
}

export const MinecraftOvoStorageRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  operation: z.enum(['deposit', 'withdraw']),
  itemName: z.enum(['oak_log', 'spruce_log', 'oak_planks', 'spruce_planks', 'cobblestone', 'sand', 'raw_iron', 'iron_ingot', 'coal', 'charcoal', 'glass']),
  count: z.int().min(1).max(16),
})
export type MinecraftOvoStorageRequest = z.infer<typeof MinecraftOvoStorageRequest>

export const MinecraftOvoSmeltRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  phase: z.enum(['start', 'collect']),
  itemName: z.enum(['sand', 'raw_iron', 'beef', 'cobblestone']),
  count: z.int().min(1).max(4),
})
export type MinecraftOvoSmeltRequest = z.infer<typeof MinecraftOvoSmeltRequest>

export const MinecraftOvoPosition = z.strictObject({ x: z.int(), y: z.int(), z: z.int() })

export const MinecraftOvoStorageReceipt = z.strictObject({
  zoneId: z.uuid(),
  operation: MinecraftOvoStorageRequest.shape.operation,
  itemName: MinecraftOvoStorageRequest.shape.itemName,
  count: MinecraftOvoStorageRequest.shape.count,
  position: MinecraftOvoPosition,
  inventoryDelta: z.int(),
  chestDelta: z.int(),
})
export type MinecraftOvoStorageReceipt = z.infer<typeof MinecraftOvoStorageReceipt>

export const MinecraftOvoSmeltReceipt = z.strictObject({
  zoneId: z.uuid(),
  phase: MinecraftOvoSmeltRequest.shape.phase,
  itemName: MinecraftOvoSmeltRequest.shape.itemName,
  output: z.enum(['glass', 'iron_ingot', 'cooked_beef', 'stone']),
  count: MinecraftOvoSmeltRequest.shape.count,
  position: MinecraftOvoPosition,
  inventoryDelta: z.int(),
})
export type MinecraftOvoSmeltReceipt = z.infer<typeof MinecraftOvoSmeltReceipt>

export const MINECRAFT_OVO_SMELT_RESULTS = {
  sand: 'glass', raw_iron: 'iron_ingot', beef: 'cooked_beef', cobblestone: 'stone',
} as const satisfies Record<MinecraftOvoSmeltRequest['itemName'], MinecraftOvoSmeltReceipt['output']>
