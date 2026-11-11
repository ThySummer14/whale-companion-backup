import { verifiedCampReceipt } from '../core/community.ts'
import type { MinecraftMilestoneMoment } from '../core/minecraft-milestone-share.ts'
import { SURVEY_TRAIL_LEG, type SurveyDirection } from '../core/minecraft-survey.ts'
import type { MINECRAFT_SHARE_ACTIONS, TaskRecord } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { CommunityCampReceipt } from '../protocol/api.ts'

interface MomentFact {
  taskId: string
  summary: string
}

export type MinecraftSurveyMoment = MomentFact & { kind: 'survey'; surveyParentTaskId: string }
export type MinecraftMoment = (MomentFact & { kind: Exclude<(typeof MINECRAFT_SHARE_ACTIONS)[number], 'survey'> }) | MinecraftSurveyMoment | MinecraftMilestoneMoment
export type VerifiedSurveyReceipt = Extract<CommunityCampReceipt, { kind: 'survey' }>

export const SURVEY_LABELS: Record<SurveyDirection, string> = { north: '北', east: '东', south: '南', west: '西' }

export function trailDirections(trail: Extract<VerifiedSurveyReceipt['route'], { kind: 'trail' }>['trail']): string {
  const [first, second] = trail.split('-') as [SurveyDirection, SurveyDirection]
  return `先向${SURVEY_LABELS[first]}、再向${SURVEY_LABELS[second]}`
}

export function verifiedMinecraftSurveyMoment(surveyParentTaskId: string, store: Pick<CompanionStore, 'autonomy' | 'taskById'>):
  { moment: MinecraftSurveyMoment; receipt: VerifiedSurveyReceipt } | undefined {
  const parent = store.autonomy.get(surveyParentTaskId)
  const proof = parent && verifiedCampReceipt(parent, id => store.taskById(id))
  if (proof?.item.kind !== 'survey') return
  const { route, outcome } = proof.item
  const summary = route.kind === 'straight'
    ? outcome === 'completed'
      ? `从营地向${SURVEY_LABELS[route.direction]}步行 ${route.steps} 格探索，然后沿原路安全返回。`
      : `尝试从营地向${SURVEY_LABELS[route.direction]}探索，提前折返并安全回到营地。`
    : outcome === 'completed'
      ? `从营地${trailDirections(route.trail)}各走 ${SURVEY_TRAIL_LEG} 格，确认两个检查点后沿原路返回。`
      : `选择${trailDirections(route.trail)}的路线勘察，确认 ${route.checkpoints} 个检查点后提前折返并安全回到营地。`
  return { moment: { kind: 'survey', taskId: proof.childId, surveyParentTaskId, summary }, receipt: proof.item }
}

const WOOD_NAMES = new Map([
  ['oak', '橡木'],
  ['spruce', '云杉木'],
  ['birch', '白桦木'],
  ['jungle', '丛林木'],
  ['acacia', '金合欢木'],
  ['dark_oak', '深色橡木'],
  ['mangrove', '红树木'],
  ['cherry', '樱花木'],
])

const CRAFT_ITEMS = new Map([
  ['stick', { name: '木棍', count: 4 }],
  ['crafting_table', { name: '工作台', count: 1 }],
  ['wooden_pickaxe', { name: '木镐', count: 1 }],
  ['stone_pickaxe', { name: '石镐', count: 1 }],
  ['shield', { name: '盾牌', count: 1 }],
  ...[...WOOD_NAMES].map(([id, name]) => [`${id}_planks`, { name: `${name}木板`, count: 4 }] as const),
])

const FLOOR_MATERIALS = new Map([
  ['cobblestone', '圆石'],
  ['dirt', '泥土'],
  ['stone', '石头'],
  ...[...WOOD_NAMES].map(([id, name]) => [`${id}_planks`, `${name}木板`] as const),
])

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function campMaterial(result: Record<string, unknown> | undefined): string | undefined {
  if (result?.built !== true || result.placedFloor !== 8 || result.placedTable !== 1 || typeof result.material !== 'string') return undefined
  return FLOOR_MATERIALS.get(result.material)
}

/** Project a successful game receipt into a fact with no names, locations, or free-form input. */
export function minecraftMoment(task: Pick<TaskRecord, 'id' | 'contextId' | 'capabilityId' | 'status'>, value: unknown): MinecraftMoment | undefined {
  if (task.contextId !== 'game.minecraft' || task.status !== 'succeeded') return undefined
  const receipt = object(value)
  if (!receipt) return undefined
  const taskId = task.id
  switch (task.capabilityId) {
    case 'minecraft.dig': {
      if (receipt.changed !== true || receipt.pickedUp !== true || typeof receipt.block !== 'string' ||
        !receipt.block.endsWith('_log') || !boundedInteger(receipt.inventoryDelta, 1, 64)) return undefined
      const wood = WOOD_NAMES.get(receipt.block.slice(0, -4))
      if (wood) return { taskId, kind: 'dig', summary: `采集并拾取了自然生长的${wood}原木，背包增加了 ${receipt.inventoryDelta} 根。` }
      return undefined
    }
    case 'minecraft.craft': {
      const item = typeof receipt.name === 'string' ? CRAFT_ITEMS.get(receipt.name) : undefined
      if (receipt.crafted === true && item && receipt.count === item.count) {
        return { taskId, kind: 'craft', summary: `合成了${item.name} ×${item.count}，并核对了背包。` }
      }
      return undefined
    }
    case 'minecraft.return':
      if (receipt.returned === true && boundedInteger(receipt.placedBlocks, 0, 16)) {
        return { taskId, kind: 'return', summary: `从短竖井安全回到出口，实际放置 ${receipt.placedBlocks} 块垫脚方块。` }
      }
      return undefined
    case 'minecraft.build': {
      const material = campMaterial(receipt)
      if (material) return { taskId, kind: 'build', summary: `完成了一处小营地，核对了 8 块${material}地板和 1 个工作台。` }
      return undefined
    }
    case 'minecraft.prepare': {
      const material = campMaterial(object(receipt.build))
      if (receipt.prepared === true && material && boundedInteger(receipt.gathered, 0, 6) && boundedInteger(receipt.crafted, 0, 5)) {
        return { taskId, kind: 'prepare', summary: `完成了${material}小营地的备料和建造。途中采集 ${receipt.gathered} 次、合成 ${receipt.crafted} 次。` }
      }
      return undefined
    }
    default: return undefined
  }
}
