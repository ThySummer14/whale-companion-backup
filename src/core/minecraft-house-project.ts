import { z } from 'zod'
import { MinecraftHouseLayout, MinecraftHousePreview, MinecraftHouseReceipt, MinecraftHouseRequest, type MinecraftHouseSitePreview } from './minecraft-house.ts'
import type { MinecraftAuthorizedZone } from './minecraft-supply.ts'

export const PROJECT_MIN_SECTIONS = 2
export const PROJECT_MAX_SECTIONS = 6
export const PROJECT_SECTION_OFFSET_LIMIT = 8
export const HOUSE_PROJECT_SECTION_CAPABILITY = 'minecraft.house-project.section'
export const HOUSE_PROJECT_SUPPLY_CAPABILITY = 'minecraft.house-project.supply'
export const HOUSE_PROJECT_SUPPLY_EVENT = 'world.house-project-supply'
export const HOUSE_PROJECT_VERIFY_CAPABILITY = 'minecraft.house-project.verify'
export const DAILY_HOUSE_PROJECT_TASK_PREFIX = 'minecraft-house-project-daily:'

export interface DailyHouseProjectOffer {
  section: number
  name: string
  recovery?: true
  supply?: { recipe: 'oak_planks' | 'spruce_planks'; missing: number }
}

const Offset = z.int().min(-PROJECT_SECTION_OFFSET_LIMIT).max(PROJECT_SECTION_OFFSET_LIMIT)
const SectionLayout = z.strictObject({
  name: z.string().trim().min(1).max(80),
  offset: z.strictObject({ x: Offset, y: Offset, z: Offset }),
  layout: MinecraftHouseLayout,
})
const axes = ['x', 'y', 'z'] as const
type Position = Record<(typeof axes)[number], number>

function bounds(center: Position, layout: MinecraftHouseLayout) {
  const min = { x: center.x - Math.floor(layout.width / 2), y: center.y, z: center.z - Math.floor(layout.depth / 2) }
  const max = { x: min.x + layout.width - 1, y: min.y + layout.height - 1, z: min.z + layout.depth - 1 }
  return { min, max }
}

function coversProject(sections: { center: Position; layout: MinecraftHouseLayout }[]) {
  if (sections.length < PROJECT_MIN_SECTIONS || sections.length > PROJECT_MAX_SECTIONS) return false
  if (sections.reduce((total, { layout }) => total + layout.blocks.replaceAll('.', '').length, 0) <= 100) return false
  const boxes = sections.map(({ center, layout }) => bounds(center, layout))
  if (boxes.some((a, i) => boxes.slice(i + 1).some(b => axes.every(k => a.min[k] <= b.max[k] && b.min[k] <= a.max[k])))) return false
  const volume = axes.reduce((product, k) =>
    product * (Math.max(...boxes.map(b => b.max[k])) - Math.min(...boxes.map(b => b.min[k])) + 1), 1)
  return volume === sections.reduce((sum, { layout }) => sum + layout.blocks.length, 0)
}

export const MinecraftHouseProjectInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  zoneId: z.uuid(),
  sections: z.array(SectionLayout).min(PROJECT_MIN_SECTIONS).max(PROJECT_MAX_SECTIONS),
}).refine(({ sections }) => coversProject(sections.map(({ offset, layout }) => ({ center: offset, layout }))),
  'Sections must cover one rectangular volume including air, without overlaps, with more than 100 solid blocks')
export type MinecraftHouseProjectInput = z.infer<typeof MinecraftHouseProjectInput>

export function minecraftHouseProjectSectionRequest(
  { offset, layout }: Pick<z.infer<typeof SectionLayout>, 'offset' | 'layout'>,
  zone: z.infer<typeof MinecraftAuthorizedZone>,
) {
  // The worker uses the child cube for pathing as well as placement.
  const radius = zone.radius - Math.max(...axes.map(k => Math.abs(offset[k])))
  const center = { x: zone.x + offset.x, y: zone.y + offset.y, z: zone.z + offset.z }
  const box = bounds(center, layout)
  if (!axes.every(k => box.min[k] >= center[k] - radius && box.max[k] <= center[k] + radius)) return
  const request = MinecraftHouseRequest.safeParse({ zone: { id: zone.id, dimension: zone.dimension, ...center, radius }, layout })
  return request.success ? request.data : undefined
}

export function minecraftHouseProjectRequests(project: MinecraftHouseProjectInput, zone: z.infer<typeof MinecraftAuthorizedZone>) {
  if (project.zoneId !== zone.id) return
  const requests: MinecraftHouseRequest[] = []
  for (const section of project.sections) {
    const request = minecraftHouseProjectSectionRequest(section, zone)
    if (!request) return
    requests.push(request)
  }
  return requests
}

export const MinecraftHouseProjectVerifyRequest = z.strictObject({
  sections: z.array(MinecraftHouseRequest).min(PROJECT_MIN_SECTIONS).max(PROJECT_MAX_SECTIONS),
}).refine(({ sections }) => {
  const first = sections[0]?.zone
  if (!first) return false
  return sections.every(({ zone, layout }) => {
    const box = bounds(zone, layout)
    return zone.id === first.id && zone.dimension === first.dimension &&
      axes.every(k => box.min[k] >= zone[k] - zone.radius && box.max[k] <= zone[k] + zone.radius)
  }) && coversProject(sections.map(({ zone, layout }) => ({ center: zone, layout })))
})

const SectionIndex = z.int().min(0).max(PROJECT_MAX_SECTIONS - 1)
export const MinecraftHouseProjectVerification = z.strictObject({
  matched: z.boolean(),
  checked: z.int().min(101).max(125 * PROJECT_MAX_SECTIONS),
  unmatchedSections: z.array(SectionIndex).max(PROJECT_MAX_SECTIONS),
}).refine(result => result.matched === (result.unmatchedSections.length === 0) &&
  result.unmatchedSections.every((index, i, indices) => i === 0 || index > indices[i - 1]!))
export type MinecraftHouseProjectVerification = z.infer<typeof MinecraftHouseProjectVerification>

const RECOVERABLE_STANCE_ERRORS: ReadonlySet<string> = new Set([
  'homebuild-unreachable-placement', 'homebuild-visibility-changed', 'homebuild-walk-obstructed',
  'homebuild-off-course', 'homebuild-retreat-unconfirmed', 'homebuild-unsafe-stance', 'homebuild-no-recovery-route',
  'house-stance-unconfirmed',
])

export function houseProjectCanRecover(section: { status: string; reason?: string }): boolean {
  return section.status === 'interrupted' && section.reason !== undefined && RECOVERABLE_STANCE_ERRORS.has(section.reason)
}

export type MinecraftHouseProjectSitePreview = MinecraftHouseSitePreview & { recovery?: true }
export type MinecraftHouseProjectSectionReceipt = MinecraftHouseReceipt & { recovery?: true }

const HouseProjectPlanOption = z.strictObject({
  section: SectionIndex,
  name: SectionLayout.shape.name,
  status: z.enum(['pending', 'interrupted']),
  ready: MinecraftHousePreview.shape.ready,
  reason: MinecraftHousePreview.shape.reason,
  materials: MinecraftHousePreview.shape.materials,
  previousReason: MinecraftHousePreview.shape.reason,
  recovery: z.literal(true).optional(),
}).refine(option => (!option.ready || !option.reason && !option.materials) &&
  (!option.recovery || houseProjectCanRecover({ status: option.status, reason: option.previousReason })))
export type HouseProjectPlanOption = z.infer<typeof HouseProjectPlanOption>

export const HouseProjectPlanInput = z.strictObject({
  action: z.enum(['build', 'prepare', 'wait']),
  section: SectionIndex.optional(),
  reason: z.string().trim().min(6).max(240).regex(/^[^\u0000-\u001f\u007f]+$/u),
}).refine(input => input.action === 'wait' || input.section !== undefined, 'Build or prepare must select a section')
export type HouseProjectPlanInput = z.infer<typeof HouseProjectPlanInput>

export function houseProjectCanPrepare(option: HouseProjectPlanOption | undefined) {
  return option?.reason === 'homebuild-materials' && !!option.materials?.some(material => material.missing > 0)
}

export function houseProjectPlanMatches(input: HouseProjectPlanInput, options: readonly HouseProjectPlanOption[]) {
  const option = options.find(item => item.section === input.section)
  if (input.section !== undefined && !option) return false
  return input.action === 'wait' || (input.action === 'build' ? option?.ready === true : houseProjectCanPrepare(option))
}

export const HouseProjectPlan = HouseProjectPlanInput.safeExtend({
  observedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  options: z.array(HouseProjectPlanOption).min(1).max(PROJECT_MAX_SECTIONS),
}).refine(plan => plan.observedAt <= plan.recordedAt && plan.options.every((item, index, options) =>
  index === 0 || item.section > options[index - 1]!.section) && houseProjectPlanMatches(plan, plan.options))
export type HouseProjectPlan = z.infer<typeof HouseProjectPlan>

export interface HouseProjectPlanObservation {
  projectName: string
  observedAt: string
  options: HouseProjectPlanOption[]
}

export type HouseProjectPlanObservationResult = { status: 'observed'; observation: HouseProjectPlanObservation }
  | { status: 'choose-project'; projects: string[] }
  | { status: 'no-project' }

export type MinecraftHouseProject = Omit<MinecraftHouseProjectInput, 'sections'> & {
  id: string
  createdAt: string
  sections: (z.infer<typeof SectionLayout> & {
    status: 'pending' | 'running' | 'interrupted' | 'built'
    receipt?: MinecraftHouseProjectSectionReceipt
    reason?: string
  })[]
  verification?: MinecraftHouseProjectVerification & { checkedAt: string }
  place?: { id: string; name: string }
  plan?: HouseProjectPlan
}

export interface MinecraftHouseProjectsView {
  available: boolean
  projects: MinecraftHouseProject[]
}
