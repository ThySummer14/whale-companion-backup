import { z } from 'zod'

export const CAMP_VISIT_SUPPLY_TASK_PREFIX = 'minecraft-visit-supply:'
export const CAMP_VISIT_BUILD_TASK_PREFIX = 'minecraft-visit-build:'
export const CAMP_VISIT_REVISIT_TASK_PREFIX = 'minecraft-visit-revisit:'

export const CAMP_WOODS = [
  { log: 'oak_log', planks: 'oak_planks' },
  { log: 'spruce_log', planks: 'spruce_planks' },
  { log: 'birch_log', planks: 'birch_planks' },
  { log: 'jungle_log', planks: 'jungle_planks' },
  { log: 'acacia_log', planks: 'acacia_planks' },
  { log: 'dark_oak_log', planks: 'dark_oak_planks' },
  { log: 'mangrove_log', planks: 'mangrove_planks' },
  { log: 'cherry_log', planks: 'cherry_planks' },
] as const

export const MinecraftAuthorizedZone = z.strictObject({
  id: z.uuid(),
  dimension: z.string().regex(/^[a-z0-9_:.-]{1,64}$/u),
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2048).max(2032),
  z: z.number().int().min(-30_000_000).max(30_000_000),
  radius: z.number().int().min(2).max(8),
})

export const MinecraftSupplyRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  recipe: z.enum(CAMP_WOODS.map(wood => wood.planks)),
})

export const MinecraftVisitSupplyOffer = z.strictObject({
  recipe: MinecraftSupplyRequest.shape.recipe,
  availableLogs: z.int().min(3),
  planks: z.int().min(0).max(7),
})

export const MinecraftVisitSupplyReceipt = z.strictObject({
  crafted: z.literal(true),
  name: MinecraftSupplyRequest.shape.recipe,
  count: z.literal(4),
  consumedLogs: z.literal(1),
  inventory: z.strictObject({
    logsBefore: z.int().min(3),
    logsAfter: z.int().min(2),
    planksBefore: z.int().min(0).max(7),
    planksAfter: z.int().min(4).max(11),
  }).refine(({ logsBefore, logsAfter, planksBefore, planksAfter }) => logsBefore - logsAfter === 1 && planksAfter - planksBefore === 4),
})
export type MinecraftVisitSupplyReceipt = z.infer<typeof MinecraftVisitSupplyReceipt>

export const MinecraftVisitBuildOffer = z.strictObject({
  material: MinecraftSupplyRequest.shape.recipe,
  availableFloor: z.int().min(8),
  workbenches: z.int().min(1),
})
export type MinecraftVisitBuildOffer = z.infer<typeof MinecraftVisitBuildOffer>

export const MinecraftVisitBuildRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  material: MinecraftVisitBuildOffer.shape.material,
})

export const MinecraftVisitRevisitRequest = MinecraftVisitBuildRequest

export const MinecraftVisitRevisitReceipt = z.strictObject({
  zoneId: z.uuid(),
  material: MinecraftVisitBuildRequest.shape.material,
  checkedBlocks: z.literal(9),
  matchedBlocks: z.int().min(0).max(9),
})
export type MinecraftVisitRevisitReceipt = z.infer<typeof MinecraftVisitRevisitReceipt>

export const MinecraftVisitBuildReceipt = z.strictObject({
  built: z.literal(true),
  zoneId: z.uuid(),
  material: MinecraftVisitBuildOffer.shape.material,
  placedFloor: z.literal(8),
  placedTable: z.literal(1),
  inventory: z.strictObject({
    floorBefore: z.int().min(8),
    floorAfter: z.int().nonnegative(),
    tablesBefore: z.int().min(1),
    tablesAfter: z.int().nonnegative(),
  }).refine(({ floorBefore, floorAfter, tablesBefore, tablesAfter }) => floorBefore - floorAfter === 8 && tablesBefore - tablesAfter === 1),
})
export type MinecraftVisitBuildReceipt = z.infer<typeof MinecraftVisitBuildReceipt>

export const MinecraftAuthorizedCampRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  material: MinecraftSupplyRequest.shape.recipe,
  prepare: z.literal(true).optional(),
})

type SupplyZone = z.infer<typeof MinecraftAuthorizedZone>

export interface MinecraftSupplyOffer {
  recipe: string
  availableLogs: number
  planks: number
}

export interface MinecraftCampOffer {
  material: string
  availableFloor: number
  workbenches: number
}

export interface MinecraftPrepareOffer {
  material: string
  batches: number
  availableFloor: number
}

const SupplyObservation = z.object({
  online: z.literal(true),
  gameMode: z.literal('survival'),
  dimension: z.string(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  health: z.number().min(16),
  food: z.number().min(12),
  action: z.string().optional(),
  survival: z.object({ threat: z.literal('NONE') }),
  inventory: z.array(z.object({ name: z.string(), count: z.number().int().positive().max(2_147_483_647) })).max(256),
})

type SupplyInventory = z.infer<typeof SupplyObservation>['inventory']

export function authorizedInventory(observation: unknown, zone: SupplyZone, action?: 'supply' | 'build-authorized' | 'gather' | 'house-supply') {
  const parsed = SupplyObservation.safeParse(observation)
  if (!parsed.success) return undefined
  const state = parsed.data
  const { x, y, z } = state.position
  if (state.action !== action || state.dimension !== zone.dimension ||
    Math.abs(Math.floor(x) - zone.x) > zone.radius || Math.abs(Math.floor(z) - zone.z) > zone.radius ||
    Math.abs(Math.floor(y) - zone.y) > 2) return undefined
  return state.inventory
}

export function minecraftSupplyOffer(observation: unknown, zone: SupplyZone, action?: 'supply'): MinecraftSupplyOffer | undefined {
  return supplyOffer(observation, zone, action, false)
}

export function minecraftVisitSupplyOffer(observation: unknown, zone: SupplyZone, action?: 'supply'): MinecraftSupplyOffer | undefined {
  return supplyOffer(observation, zone, action, true)
}

function supplyOffer(observation: unknown, zone: SupplyZone, action: 'supply' | undefined, exactLog: boolean): MinecraftSupplyOffer | undefined {
  const inventory = authorizedInventory(observation, zone, action)
  return inventory && inventorySupplyOffer(inventory, countPlanks(inventory), exactLog)
}

function countPlanks(inventory: SupplyInventory): number {
  return inventory.filter(item => item.name.endsWith('_planks')).reduce((sum, item) => sum + item.count, 0)
}

function inventorySupplyOffer(inventory: SupplyInventory, planks: number, exactLog: boolean): MinecraftSupplyOffer | undefined {
  if (planks >= 8) return undefined
  for (const wood of CAMP_WOODS) {
    const woodBlock = wood.log.replace(/_log$/u, '_wood')
    // Vanilla plank recipes also accept these variants. CBI chooses a matching slot itself.
    if (exactLog && inventory.some(({ name }) => name === woodBlock || name === `stripped_${wood.log}` || name === `stripped_${woodBlock}`)) continue
    const availableLogs = inventory.filter(item => item.name === wood.log).reduce((sum, item) => sum + item.count, 0)
    if (availableLogs >= 3) return { recipe: wood.planks, availableLogs, planks }
  }
}

export function minecraftProjectGatherEligible(observation: unknown, zone: SupplyZone, action?: 'gather'): boolean {
  const inventory = authorizedInventory(observation, zone, action)
  if (!inventory?.some(item => item.name === 'crafting_table')) return false
  const planks = countPlanks(inventory)
  const oakLogs = inventory.filter(item => item.name === 'oak_log').reduce((sum, item) => sum + item.count, 0)
  return planks < 8 && oakLogs < 3 && !inventorySupplyOffer(inventory, planks, true)
}

export function minecraftCampOffer(observation: unknown, zone: SupplyZone, action?: 'build-authorized'): MinecraftCampOffer | undefined {
  const inventory = authorizedInventory(observation, zone, action)
  if (!inventory) return undefined
  const workbenches = inventory.filter(item => item.name === 'crafting_table').reduce((sum, item) => sum + item.count, 0)
  if (!workbenches) return undefined
  for (const { planks: material } of CAMP_WOODS) {
    const availableFloor = inventory.filter(item => item.name === material).reduce((sum, item) => sum + item.count, 0)
    if (availableFloor >= 8) return { material, availableFloor, workbenches }
  }
}

export function minecraftPrepareOffer(
  observation: unknown, zone: SupplyZone, material?: string, action?: 'supply' | 'build-authorized',
): MinecraftPrepareOffer | undefined {
  const inventory = authorizedInventory(observation, zone, action)
  if (!inventory?.some(item => item.name === 'crafting_table')) return undefined
  const count = (name: string) => inventory.reduce((sum, item) => sum + (item.name === name ? item.count : 0), 0)
  let best: MinecraftPrepareOffer | undefined
  for (const wood of CAMP_WOODS) {
    if (material !== undefined && wood.planks !== material) continue
    const availableFloor = count(wood.planks)
    const batches = Math.ceil(Math.max(0, 8 - availableFloor) / 4)
    if (batches > 0 && count(wood.log) < batches + 2) continue
    if (!best || batches < best.batches) best = { material: wood.planks, batches, availableFloor }
    if (batches === 0) break
  }
  return best
}
