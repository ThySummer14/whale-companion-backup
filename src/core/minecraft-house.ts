import { z } from 'zod'
import { HouseRecoveryAgentDecision } from './minecraft-recovery.ts'
import { MinecraftAuthorizedZone } from './minecraft-supply.ts'

export const MINECRAFT_HOUSE_BLOCKS = {
  '.': 'air',
  o: 'oak_planks',
  s: 'spruce_planks',
  c: 'cobblestone',
  g: 'glass',
} as const

export type MinecraftHouseSymbol = keyof typeof MINECRAFT_HOUSE_BLOCKS
export type MinecraftHouseMaterial = (typeof MINECRAFT_HOUSE_BLOCKS)[Exclude<MinecraftHouseSymbol, '.'>]
const Material = z.enum(Object.values(MINECRAFT_HOUSE_BLOCKS).filter((block): block is MinecraftHouseMaterial => block !== 'air'))
export const MINECRAFT_HOUSE_MAX_SIDE = 5
export const MINECRAFT_HOUSE_MAX_BLOCKS = 100
export const MINECRAFT_HOUSE_SYMBOLS = /^[.oscg]+$/u
const Side = z.int().min(1).max(MINECRAFT_HOUSE_MAX_SIDE)
const Volume = z.int().min(0).max(MINECRAFT_HOUSE_MAX_SIDE ** 3)
const Count = z.int().min(0).max(MINECRAFT_HOUSE_MAX_BLOCKS)

export const MinecraftHouseLayout = z.strictObject({
  width: Side,
  height: Side,
  depth: Side,
  blocks: z.string().min(1).max(MINECRAFT_HOUSE_MAX_SIDE ** 3).regex(MINECRAFT_HOUSE_SYMBOLS),
}).refine(({ width, height, depth, blocks }) => {
  const placed = blocks.replaceAll('.', '').length
  return blocks.length === width * height * depth && placed >= 1 && placed <= MINECRAFT_HOUSE_MAX_BLOCKS
}, 'Layout must use its full volume with one to 100 solid blocks')
export type MinecraftHouseLayout = z.infer<typeof MinecraftHouseLayout>

export const MINECRAFT_HOUSE_FACADE_MATERIALS = ['o', 's', 'c'] as const satisfies readonly MinecraftHouseSymbol[]
type FacadeMaterial = (typeof MINECRAFT_HOUSE_FACADE_MATERIALS)[number]

interface MinecraftHouseFacade {
  floor: FacadeMaterial
  wall: FacadeMaterial
  roof: FacadeMaterial
  roofProfile?: { axis: 'x' | 'z'; heights: number[] }
  doorX: number
  frontWindows?: { x: number; y: number }[]
  leftWindows?: { z: number; y: number }[]
  trim?: FacadeMaterial
  frontTrimColumns?: number[]
  leftTrimColumns?: number[]
}

export function compileMinecraftHouseFacade(
  { width, height, depth }: Omit<MinecraftHouseLayout, 'blocks'>,
  facade: MinecraftHouseFacade,
): { blocks: string } | { error: string } {
  if (![width, height, depth].every(side => Side.safeParse(side).success) || width < 3 || depth < 3 || height < 4) {
    return { error: 'facade: width and depth must be 3–5, height must be 4–5' }
  }
  const { doorX, floor, wall, roof, roofProfile, trim, frontTrimColumns, leftTrimColumns } = facade
  if (!Number.isInteger(doorX) || doorX < 1 || doorX > width - 2) {
    return { error: `facade.doorX: choose an interior front column from 1 to ${width - 2}` }
  }
  if (roofProfile) {
    if (height !== 5) return { error: 'facade.roofProfile: stepped roofs require height=5' }
    if (roofProfile.axis !== 'x' && roofProfile.axis !== 'z') return { error: 'facade.roofProfile.axis: choose x or z' }
    const length = roofProfile.axis === 'x' ? width : depth
    if (roofProfile.heights.length !== length || !roofProfile.heights.every(y => y === 3 || y === 4) ||
      !roofProfile.heights.includes(3) || !roofProfile.heights.includes(4)) {
      return { error: `facade.roofProfile.heights: use exactly ${length} roof heights with both 3 and 4` }
    }
  }
  const explicitTrim = frontTrimColumns !== undefined || leftTrimColumns !== undefined
  if (explicitTrim && (!trim || !(frontTrimColumns?.length || leftTrimColumns?.length))) {
    return { error: 'facade.trim: explicit trim columns require a trim material and at least one column' }
  }
  const frontTrim = frontTrimColumns ?? (explicitTrim ? [] : [0, width - 1])
  const leftTrim = leftTrimColumns ?? (explicitTrim ? [] : [0, depth - 1])
  const validColumns = (columns: number[], length: number) => new Set(columns).size === columns.length &&
    columns.every(column => Number.isInteger(column) && column >= 0 && column < length)
  if (!validColumns(frontTrim, width) || frontTrim.includes(doorX)) {
    return { error: 'facade.frontTrimColumns: choose distinct front columns inside the width, excluding the door' }
  }
  if (!validColumns(leftTrim, depth)) return { error: 'facade.leftTrimColumns: choose distinct left columns inside the depth' }

  const ceiling = roofProfile ? 3 : height - 1
  const blocks: MinecraftHouseSymbol[] = []
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        if (z === 0 && x === doorX && y <= 2) blocks.push('.')
        else if (y === 0) blocks.push(floor)
        else if (y === ceiling) blocks.push(roof)
        else if (y > ceiling) blocks.push(roofProfile?.heights[roofProfile.axis === 'x' ? x : z] === y ? roof : '.')
        else if (trim && (z === 0 && frontTrim.includes(x) || x === 0 && leftTrim.includes(z))) blocks.push(trim)
        else if (x === 0 || x === width - 1 || z === 0 || z === depth - 1) blocks.push(wall)
        else blocks.push('.')
      }
    }
  }
  const windows = [
    ...facade.frontWindows?.map(({ x, y }, i) => ({ x, y, z: 0, face: 'front', label: `facade.frontWindows[${i}]`, column: x, length: width })) ?? [],
    ...facade.leftWindows?.map(({ z, y }, i) => ({ x: 0, y, z, face: 'left', label: `facade.leftWindows[${i}]`, column: z, length: depth })) ?? [],
  ]
  const seenWindows = new Set<string>()
  for (const { x, y, z, face, label, column, length } of windows) {
    if (!Number.isInteger(column) || column < 0 || column >= length || !Number.isInteger(y) || y < 1 || y >= ceiling) {
      return { error: `${label}: use a wall column from 0 to ${length - 1} and y from 1 to ${ceiling - 1}` }
    }
    const index = (y * depth + z) * width + x
    if (blocks[index] === '.') return { error: `${label}: window overlaps the door` }
    const faceCell = `${face}:${index}`
    if (seenWindows.has(faceCell)) return { error: `${label}: window repeats an existing cell on this face` }
    seenWindows.add(faceCell)
    blocks[index] = 'g'
  }
  return { blocks: blocks.join('') }
}

export const MinecraftHouseRequest = z.strictObject({ zone: MinecraftAuthorizedZone, layout: MinecraftHouseLayout })
export type MinecraftHouseRequest = z.infer<typeof MinecraftHouseRequest>

const MinecraftHouseMaterialNeed = z.strictObject({
  material: Material,
  needed: Count.min(1),
  carried: Count,
  missing: Count,
}).refine(({ needed, carried, missing }) => carried + missing === needed)
export type MinecraftHouseMaterialNeed = z.infer<typeof MinecraftHouseMaterialNeed>

export const MinecraftHousePreview = z.strictObject({
  ready: z.boolean(),
  reason: z.string().regex(/^[a-z0-9-]{1,64}$/u).optional(),
  checked: Volume,
  materials: z.array(MinecraftHouseMaterialNeed).min(1).max(4).optional(),
}).refine(({ ready, reason, checked, materials }) => (!ready || checked > 0 && reason === undefined) &&
  (!materials || !ready && reason === 'homebuild-materials' && materials.some(row => row.missing > 0) &&
    new Set(materials.map(row => row.material)).size === materials.length &&
    materials.reduce((total, row) => total + row.needed, 0) <= checked))
export type MinecraftHousePreview = z.infer<typeof MinecraftHousePreview>

export const MinecraftHouseReceipt = z.strictObject({
  built: z.literal(true),
  zoneId: z.uuid(),
  checked: Volume.min(1),
  placed: Count,
  consumed: z.partialRecord(Material, Count.min(1)),
}).refine(receipt => receipt.placed <= receipt.checked &&
  Object.values(receipt.consumed).reduce((total, count) => total + count, 0) === receipt.placed)
export type MinecraftHouseReceipt = z.infer<typeof MinecraftHouseReceipt>

export const MinecraftHouseDraftInput = z.strictObject({
  zoneId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u),
  layout: MinecraftHouseLayout,
  assumptions: z.string().trim().min(1).max(800).optional(),
})
export type MinecraftHouseDraftInput = z.infer<typeof MinecraftHouseDraftInput>

export const MinecraftHouseRecovery = z.strictObject({
  reason: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  next: z.enum(['check-materials', 'recheck-site', 'replan-route', 'check-safety']),
  at: z.iso.datetime(),
  verification: z.enum(['ready', 'blocked', 'unavailable']).optional(),
  agentDecision: HouseRecoveryAgentDecision.optional(),
})
export type MinecraftHouseRecovery = z.infer<typeof MinecraftHouseRecovery>

export function minecraftHouseRecoveryDecision(code: string | undefined): Pick<MinecraftHouseRecovery, 'reason' | 'next'> {
  switch (code) {
    case 'homebuild-materials':
      return { reason: code, next: 'check-materials' }
    case 'homebuild-unreachable-placement': case 'homebuild-visibility-changed': case 'homebuild-walk-obstructed':
    case 'homebuild-off-course': case 'homebuild-retreat-unconfirmed':
      return { reason: code, next: 'replan-route' }
    case 'homebuild-obstructed': case 'homebuild-unsupported': case 'homebuild-unavailable-cell':
    case 'house-preconditions-changed': case 'house-world-unconfirmed':
      return { reason: code, next: 'recheck-site' }
    case 'homebuild-unsafe-stance': case 'homebuild-unsafe-player': case 'homebuild-cancelled': case 'house-cancelled':
    case 'minecraft-house-cancelled': case 'minecraft-camp-paused': case 'house-ownership-unconfirmed':
      return { reason: code, next: 'check-safety' }
    default:
      return { reason: 'house-result-unconfirmed', next: 'recheck-site' }
  }
}

const ReferenceId = z.string().min(1).max(256)
const HouseRevision = z.int().nonnegative()
export const MinecraftHouseDraft = z.strictObject({
  ...MinecraftHouseDraftInput.shape,
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  reference: z.strictObject({ contextId: ReferenceId, messageId: ReferenceId, attachmentId: ReferenceId }).optional(),
  status: z.enum(['draft', 'running', 'built', 'interrupted']),
  receipt: MinecraftHouseReceipt.optional(),
  revision: HouseRevision.optional(),
  recovery: MinecraftHouseRecovery.optional(),
})
export type MinecraftHouseDraft = z.infer<typeof MinecraftHouseDraft>

export const MinecraftHouseRevisionInput = z.strictObject({
  expectedRevision: HouseRevision,
  blocks: MinecraftHouseLayout.shape.blocks,
})
export type MinecraftHouseRevisionInput = z.infer<typeof MinecraftHouseRevisionInput>

export interface MinecraftHouseRevisionHistory {
  revisions: { revision: number; blocks: string; createdAt: string }[]
}

export interface MinecraftHousesView {
  drafts: MinecraftHouseDraft[]
  available: boolean
  revisionsAvailable?: boolean
}

export type MinecraftHouseSitePreview = MinecraftHousePreview & { previewId?: string }

export function minecraftHouseCells(layout: MinecraftHouseLayout) {
  return [...layout.blocks].map((value, index) => {
    const symbol = value as MinecraftHouseSymbol
    return {
      x: index % layout.width,
      y: Math.floor(index / (layout.width * layout.depth)),
      z: Math.floor(index / layout.width) % layout.depth,
      symbol,
      block: MINECRAFT_HOUSE_BLOCKS[symbol],
    }
  })
}

export function minecraftHouseMaterials(layout: MinecraftHouseLayout): Partial<Record<MinecraftHouseMaterial, number>> {
  const materials: Partial<Record<MinecraftHouseMaterial, number>> = {}
  for (const { block } of minecraftHouseCells(layout)) {
    if (block !== 'air') materials[block] = (materials[block] ?? 0) + 1
  }
  return materials
}

export function minecraftHouseReceiptMatches(receipt: MinecraftHouseReceipt, request: MinecraftHouseRequest): boolean {
  const materials = minecraftHouseMaterials(request.layout)
  return receipt.zoneId === request.zone.id && receipt.checked === request.layout.blocks.length &&
    Object.entries(receipt.consumed).every(([material, count]) => count <= (materials[material as MinecraftHouseMaterial] ?? 0))
}
