import { z } from 'zod'
import { minecraftHouseReceiptMatches } from '../core/minecraft-house.ts'
import { MINECRAFT_HOUSE_CAPABILITY, MINECRAFT_HOUSE_EVENT, minecraftHouseBuildSummary } from '../core/minecraft-house-repository.ts'
import type { CompanionStore } from '../core/store.ts'
import { campProject } from './minecraft-camp-project.ts'

export interface MinecraftMilestoneSource {
  experience: { kind: 'camp-project'; taskId: string; constructionTaskId: string; receiptTaskId: string }
    | { kind: 'house'; taskId: string; draftId: string }
  at: string
  fact: string
}

type MilestoneKind = MinecraftMilestoneSource['experience']['kind']
type MilestoneStore = Parameters<typeof campProject>[0] & Pick<CompanionStore, 'activityByTask' | 'buildZoneById' | 'minecraftHouses'>
const TaskId = z.uuid()
const EmptyData = z.strictObject({})

function campMilestone(store: MilestoneStore): MinecraftMilestoneSource | undefined {
  const rule = store.autonomy.surveyWindow()
  if (!rule?.allowMinecraftProject) return
  const zone = store.buildZoneById(rule.zoneId)
  if (!zone || !(Date.parse(zone.createdAt) <= rule.createdAt)) return
  const result = campProject(store, rule).completion
  if (!result) return
  const { taskId, constructionTaskId, receiptTaskId, at, supplyVisits, gatheredLogs } = result
  return { experience: { kind: 'camp-project', taskId, constructionTaskId, receiptTaskId }, at,
    fact: `在 Minecraft 的营地项目中，确认采集 ${gatheredLogs} 根原木、补给 ${supplyVisits} 次并搭建营地。之后复访确认 9 处方块完好，已下线。` }
}

function houseMilestone(store: MilestoneStore, taskId: string): MinecraftMilestoneSource | undefined {
  const task = store.taskById(taskId)
  if (task?.contextId !== 'game.minecraft' || task.capabilityId !== MINECRAFT_HOUSE_CAPABILITY || task.status !== 'succeeded') return
  const draft = store.minecraftHouses.byBuildTask(taskId)
  const receipt = draft?.receipt
  const zone = draft?.zoneId && store.buildZoneById(draft.zoneId)
  if (!draft || !receipt?.placed || !zone || !minecraftHouseReceiptMatches(receipt, { zone, layout: draft.layout })) return
  const activity = store.activityByTask(taskId, MINECRAFT_HOUSE_EVENT, 'game.minecraft')
  if (activity?.contextId !== 'game.minecraft' || activity.source !== 'game.minecraft' || activity.status !== 'success' ||
    activity.sessionId !== task.sessionId || activity.summary !== minecraftHouseBuildSummary(receipt) || !EmptyData.safeParse(activity.data).success) return
  const started = Date.parse(task.createdAt)
  const finished = Date.parse(task.updatedAt)
  const recorded = Date.parse(activity.occurredAt)
  if (!(Date.parse(draft.createdAt) <= started && Date.parse(zone.createdAt) <= started && started <= finished &&
    finished <= recorded && recorded <= Date.now())) return
  const { checked, placed } = receipt
  return { experience: { kind: 'house', taskId, draftId: draft.id }, at: new Date(finished).toISOString(),
    fact: `在 Minecraft 按蓝图完成一座小屋，核验 ${checked} 处位置，本次放置 ${placed} 块。` }
}

function readMilestone(read: () => MinecraftMilestoneSource | undefined): MinecraftMilestoneSource | undefined {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error
  }
}

export function verifiedMinecraftMilestone(store: MilestoneStore, kind: MilestoneKind, taskId: string): MinecraftMilestoneSource | undefined {
  if (!TaskId.safeParse(taskId).success) return
  if (kind === 'house') return readMilestone(() => houseMilestone(store, taskId))
  if (kind !== 'camp-project') return
  const result = readMilestone(() => campMilestone(store))
  return result?.experience.taskId === taskId ? result : undefined
}

export function recentMinecraftMilestones(store: MilestoneStore, since: number): MinecraftMilestoneSource[] {
  if (!Number.isFinite(new Date(since).getTime())) return []
  const camp = readMilestone(() => campMilestone(store))
  const houses = store.minecraftHouses.recentBuildTasks(new Date(since).toISOString())
  return [...(camp ? [camp] : []), ...houses.flatMap(taskId => verifiedMinecraftMilestone(store, 'house', taskId) ?? [])]
    .filter(source => Date.parse(source.at) >= since).sort((a, b) => b.at.localeCompare(a.at))
}
