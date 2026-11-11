import { z } from 'zod'
import { MINECRAFT_HOUSE_MAX_BLOCKS, MINECRAFT_HOUSE_MAX_SIDE, MINECRAFT_HOUSE_SYMBOLS,
  type MinecraftHouseSymbol } from './minecraft-house.ts'
import { MinecraftHouseProjectInput, PROJECT_MAX_SECTIONS, PROJECT_SECTION_OFFSET_LIMIT,
  minecraftHouseProjectSectionRequest } from './minecraft-house-project.ts'
import type { MinecraftAuthorizedZone } from './minecraft-supply.ts'

const MAX_CELLS = MINECRAFT_HOUSE_MAX_SIDE ** 3 * PROJECT_MAX_SECTIONS
const MAX_SOLIDS = MINECRAFT_HOUSE_MAX_BLOCKS * PROJECT_MAX_SECTIONS
const Side = z.int().min(1).max(2 * PROJECT_SECTION_OFFSET_LIMIT + 1)
const WholeLayout = z.strictObject({
  width: Side,
  height: Side,
  depth: Side,
  blocks: z.string().min(1).max(MAX_CELLS).regex(MINECRAFT_HOUSE_SYMBOLS),
}).refine(({ width, height, depth, blocks }) => {
  if (blocks.length !== width * height * depth) return false
  const solid = blocks.replaceAll('.', '').length
  return solid > MINECRAFT_HOUSE_MAX_BLOCKS && solid <= MAX_SOLIDS
}, 'Layout must cover its full volume with 101–600 solid blocks')

export const MinecraftHouseProjectImportInput = z.strictObject({
  name: MinecraftHouseProjectInput.shape.name,
  zoneId: MinecraftHouseProjectInput.shape.zoneId,
  layout: WholeLayout,
})
export type MinecraftHouseProjectImportInput = z.infer<typeof MinecraftHouseProjectImportInput>

export interface MinecraftHouseProjectImportPreview {
  project: MinecraftHouseProjectInput
  materials: Partial<Record<MinecraftHouseSymbol, number>>
  checked: number
  placed: number
}

type ImportZone = z.infer<typeof MinecraftAuthorizedZone>
type WholeLayout = z.infer<typeof WholeLayout>
type Section = MinecraftHouseProjectInput['sections'][number]
type Point = { x: number; y: number; z: number }
interface Box { start: Point; end: Point }
const axes = ['x', 'z', 'y'] as const

// A summed volume lets the splitter reject empty or over-dense boxes without rescanning cells.
function countSolidIn(layout: WholeLayout) {
  const { width, height, depth, blocks } = layout
  const stride = width + 1
  const layer = stride * (depth + 1)
  const sums = new Uint16Array(layer * (height + 1))
  const at = (x: number, y: number, z: number) => sums[y * layer + z * stride + x]!
  for (let y = 1; y <= height; y++) {
    for (let z = 1; z <= depth; z++) {
      let row = 0
      for (let x = 1; x <= width; x++) {
        row += blocks[((y - 1) * depth + z - 1) * width + x - 1] === '.' ? 0 : 1
        sums[y * layer + z * stride + x] = row + at(x, y - 1, z) + at(x, y, z - 1) - at(x, y - 1, z - 1)
      }
    }
  }
  return ({ start: a, end: b }: Box) =>
    at(b.x, b.y, b.z) - at(a.x, b.y, b.z) - at(b.x, a.y, b.z) - at(b.x, b.y, a.z) +
    at(a.x, a.y, b.z) + at(a.x, b.y, a.z) + at(b.x, a.y, a.z) - at(a.x, a.y, a.z)
}

function sectionLayout({ start, end }: Box, full: WholeLayout) {
  const width = end.x - start.x, height = end.y - start.y, depth = end.z - start.z
  const offset = { x: start.x + Math.floor(width / 2) - Math.floor(full.width / 2),
    y: start.y, z: start.z + Math.floor(depth / 2) - Math.floor(full.depth / 2) }
  const rows: string[] = []
  for (let y = start.y; y < end.y; y++) {
    for (let z = start.z; z < end.z; z++) {
      const rowStart = (y * full.depth + z) * full.width + start.x
      rows.push(full.blocks.slice(rowStart, rowStart + width))
    }
  }
  return { offset, layout: { width, height, depth, blocks: rows.join('') } }
}

function partition(layout: WholeLayout, solidIn: ReturnType<typeof countSolidIn>, zone?: ImportZone) {
  const memo = new Map<string, Box[] | null>()
  const lowerBound = (box: Box, solid: number) => Math.max(
    Math.ceil(solid / MINECRAFT_HOUSE_MAX_BLOCKS),
    axes.reduce((count, axis) => count * Math.ceil((box.end[axis] - box.start[axis]) / MINECRAFT_HOUSE_MAX_SIDE), 1),
  )
  function find(box: Box): Box[] | null {
    const { start, end } = box
    const key = `${start.x},${start.y},${start.z}:${end.x},${end.y},${end.z}`
    if (memo.has(key)) return memo.get(key)!
    const result = findBest(box)
    memo.set(key, result)
    return result
  }

  function findBest(box: Box): Box[] | null {
    const solid = solidIn(box)
    const minimum = lowerBound(box, solid)
    if (!solid || minimum > PROJECT_MAX_SECTIONS) return null
    const sectionLimit = Math.min(PROJECT_MAX_SECTIONS, solid)
    if (minimum === 1) {
      const candidate = sectionLayout(box, layout)
      if (axes.every(axis => Math.abs(candidate.offset[axis]) <= PROJECT_SECTION_OFFSET_LIMIT) &&
        (!zone || minecraftHouseProjectSectionRequest(candidate, zone))) return [box]
    }

    let best: Box[] | null = null
    const target = Math.max(2, minimum)
    // Prefer balanced cuts along horizontal axes before splitting floors when the section count ties.
    for (const axis of axes) {
      const { start, end } = box
      const cuts = Array.from({ length: end[axis] - start[axis] - 1 }, (_, index) => start[axis] + index + 1)
      cuts.sort((a, b) => Math.abs(2 * a - start[axis] - end[axis]) - Math.abs(2 * b - start[axis] - end[axis]))
      for (const at of cuts) {
        const first = { start, end: { ...end, [axis]: at } }
        const second = { start: { ...start, [axis]: at }, end }
        const left = solidIn(first), right = solid - left
        if (!left || !right) continue
        const limit = best ? best.length - 1 : sectionLimit
        if (lowerBound(first, left) + lowerBound(second, right) > limit) continue
        const a = find(first)
        if (!a || a.length + lowerBound(second, right) > limit) continue
        const b = find(second)
        if (!b || a.length + b.length > limit) continue
        best = [...a, ...b]
        if (best.length === target) return best
      }
    }
    return best
  }

  return find({ start: { x: 0, y: 0, z: 0 }, end: { x: layout.width, y: layout.height, z: layout.depth } })
}

export function planMinecraftHouseProjectImport(
  { name, zoneId, layout }: MinecraftHouseProjectImportInput,
  zone: ImportZone,
): MinecraftHouseProjectImportPreview | 'minecraft-house-project-zone-invalid' | 'minecraft-house-project-import-unsplittable' {
  if (zoneId !== zone.id) return 'minecraft-house-project-zone-invalid'
  const solidIn = countSolidIn(layout)
  const boxes = partition(layout, solidIn, zone)
  if (!boxes) return partition(layout, solidIn) ? 'minecraft-house-project-zone-invalid' : 'minecraft-house-project-import-unsplittable'
  boxes.sort((a, b) => a.start.y - b.start.y || a.start.z - b.start.z || a.start.x - b.start.x)
  const sections: Section[] = boxes.map((box, i) => ({ name: `第 ${i + 1} 段`, ...sectionLayout(box, layout) }))
  const project = MinecraftHouseProjectInput.parse({ name, zoneId, sections })
  const materials: MinecraftHouseProjectImportPreview['materials'] = {}
  let placed = 0
  for (const symbol of layout.blocks as Iterable<MinecraftHouseSymbol>) {
    if (symbol === '.') continue
    materials[symbol] = (materials[symbol] ?? 0) + 1
    placed++
  }
  return { project, materials, checked: layout.blocks.length, placed }
}
