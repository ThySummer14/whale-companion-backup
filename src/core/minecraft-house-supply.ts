import { z } from 'zod'
import { MINECRAFT_HOUSE_MAX_BLOCKS, MinecraftHouseRequest, minecraftHouseMaterials } from './minecraft-house.ts'

export const MinecraftHouseSupplyRecipe = z.enum(['oak_planks', 'spruce_planks'])
export type MinecraftHouseSupplyRecipe = z.infer<typeof MinecraftHouseSupplyRecipe>

export const MinecraftHouseSupplyRequest = MinecraftHouseRequest.extend({
  recipe: MinecraftHouseSupplyRecipe,
  missing: z.int().min(1).max(MINECRAFT_HOUSE_MAX_BLOCKS),
  recovery: z.literal(true).optional(),
}).refine(({ layout, recipe, missing }) => missing <= (minecraftHouseMaterials(layout)[recipe] ?? 0),
  'The missing material and count must belong to this section')
export type MinecraftHouseSupplyRequest = z.infer<typeof MinecraftHouseSupplyRequest>

export const MinecraftHouseSupplyPreview = z.strictObject({ ready: z.boolean() })
export type MinecraftHouseSupplyPreview = z.infer<typeof MinecraftHouseSupplyPreview>

export const MinecraftHouseSupplyReceipt = z.strictObject({
  crafted: z.literal(true),
  name: MinecraftHouseSupplyRecipe,
  count: z.literal(4),
  consumedLogs: z.literal(1),
  inventory: z.strictObject({
    logsBefore: z.int().min(3),
    logsAfter: z.int().min(2),
    planksBefore: z.int().min(0).max(MINECRAFT_HOUSE_MAX_BLOCKS - 1),
    planksAfter: z.int().min(4).max(MINECRAFT_HOUSE_MAX_BLOCKS + 3),
  }).refine(({ logsBefore, logsAfter, planksBefore, planksAfter }) => logsBefore - logsAfter === 1 && planksAfter - planksBefore === 4),
})
export type MinecraftHouseSupplyReceipt = z.infer<typeof MinecraftHouseSupplyReceipt>
