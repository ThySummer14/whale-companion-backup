import { z } from 'zod'
import { MINECRAFT_HOUSE_BLOCKS, MinecraftHouseRequest, minecraftHouseCells, type MinecraftHouseLayout } from './minecraft-house.ts'

export const MINECRAFT_HOUSE_CANDIDATE_LIMIT = 12
export const MinecraftHouseCellIndex = z.int().min(0).max(124)
const Coordinate = z.int().min(0).max(4)
const Material = z.enum(['oak_planks', 'spruce_planks', 'cobblestone', 'glass', 'cherry_planks', 'pink_concrete', 'smooth_sandstone', 'dark_oak_planks', 'lantern', 'cherry_leaves'])
const Cell = z.strictObject({ index: MinecraftHouseCellIndex, x: Coordinate, y: Coordinate, z: Coordinate, material: Material })

export function minecraftHouseCellTarget(layout: MinecraftHouseLayout, index: number): z.infer<typeof Cell> | undefined {
  const cell = minecraftHouseCells(layout)[index]
  if (cell && cell.block !== 'air') return { index, x: cell.x, y: cell.y, z: cell.z, material: cell.block }
}

export const MinecraftHouseCellRequest = MinecraftHouseRequest.extend({ index: MinecraftHouseCellIndex })
  .refine(({ layout, index }) => !!minecraftHouseCellTarget(layout, index))
export type MinecraftHouseCellRequest = z.infer<typeof MinecraftHouseCellRequest>

export const MinecraftHouseCellCandidates = z.strictObject({
  checked: z.int().min(1).max(100), blocked: z.int().min(0).max(100),
  candidates: z.array(Cell).max(MINECRAFT_HOUSE_CANDIDATE_LIMIT),
  stock: z.partialRecord(Material, z.int().min(0).max(4096)).optional(),
}).refine(({ checked, blocked, candidates }) => blocked + candidates.length <= checked && new Set(candidates.map(cell => cell.index)).size === candidates.length)
export type MinecraftHouseCellCandidates = z.infer<typeof MinecraftHouseCellCandidates>

const ReceiptTarget = { index: MinecraftHouseCellIndex, material: Material }
export const MinecraftHouseCellBlockedReason = z.enum([
  'homebuild-obstructed', 'homebuild-materials', 'homebuild-unsupported', 'homebuild-unavailable-cell',
  'homebuild-unreachable-placement', 'homebuild-visibility-changed',
])
export const MinecraftHouseCellReceipt = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('placed'), ...ReceiptTarget, consumed: z.literal(1) }),
  z.strictObject({ outcome: z.literal('already-present'), ...ReceiptTarget, consumed: z.literal(0) }),
  z.strictObject({ outcome: z.literal('blocked'), ...ReceiptTarget, consumed: z.literal(0), reason: MinecraftHouseCellBlockedReason }),
])
export type MinecraftHouseCellReceipt = z.infer<typeof MinecraftHouseCellReceipt>

export function minecraftHouseCellMatches(receipt: MinecraftHouseCellReceipt, request: MinecraftHouseCellRequest): boolean {
  return receipt.index === request.index && receipt.material === minecraftHouseCellTarget(request.layout, request.index)?.material
}

export function minecraftHouseCandidatesMatch(result: MinecraftHouseCellCandidates, request: MinecraftHouseRequest): boolean {
  return result.checked === request.layout.blocks.replaceAll('.', '').length &&
    Object.keys(result.stock ?? {}).every(material => result.candidates.some(cell => cell.material === material)) && result.candidates.every(cell => {
    const target = minecraftHouseCellTarget(request.layout, cell.index)
    return target?.x === cell.x && target.y === cell.y && target.z === cell.z && target.material === cell.material
  })
}
