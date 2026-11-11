import { z } from 'zod'
import { parseBilibiliTarget } from '../core/bilibili.ts'
import { DailyBilibiliClip } from '../core/daily-initiative.ts'
import { dailyHouseProjectReflectionFact, verifiedDailyHouseProjectSection, type DailyHouseProjectProofStore } from '../core/daily-house-project-proof.ts'
import { isBilibiliSubtitleDigest } from '../core/bilibili-subtitles.ts'
import { isSurveyWindowKey, surveyWindowKey } from '../core/minecraft-survey-window.ts'
import { verifiedCampReceipt } from '../core/community.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, DAILY_AUTONOMY_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, type AutonomousJob, type SelfNoteExperience } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { verifiedMinecraftSurveyMoment } from './minecraft-moments.ts'

const DailyChoice = z.object({
  windowRuleId: z.uuid(),
  date: z.string().refine(date => isSurveyWindowKey(surveyWindowKey(date))),
  expiresAt: z.int().positive(),
  choice: z.enum(['survey', 'supply', 'build', 'bilibili', 'house-project']),
  activityTaskId: z.uuid(),
  visitId: z.uuid().optional(),
  visitExpiresAt: z.int().positive().optional(),
  visitJoined: z.literal(true).optional(),
  visitStatus: z.enum(['starting', 'online', 'offline', 'unconfirmed']).optional(),
})

const BilibiliReading = z.object({
  dailyTaskId: z.uuid(),
  candidateId: z.uuid(),
  activityId: z.int().positive(),
  clipRequest: DailyBilibiliClip.extend({ deadline: z.int().positive() }).optional(),
})

export interface DailyReflectionSource {
  experience: Extract<SelfNoteExperience, { dailyTaskId: string }>
  at: string
  fact: string
  material?: 'clip'
}

type ReflectionStore = Pick<CompanionStore, 'autonomy' | 'bilibili' | 'bilibiliSubtitles' | 'activityById'> & DailyHouseProjectProofStore

function completedJob(job: AutonomousJob, kind: AutonomousJob['kind'], context: string, dedupeKey: string): boolean {
  const { task } = job
  return job.kind === kind && job.contextId === context && job.dedupeKey === dedupeKey &&
    task.id === job.id && task.contextId === context && task.capabilityId === 'core.autonomy' && task.status === 'succeeded' &&
    task.externalId === `autonomy:${kind}:${dedupeKey}` && task.createdAt === job.createdAt
}

export function verifiedDailyBilibiliReading(store: ReflectionStore, daily: AutonomousJob, reading: AutonomousJob, deadline: number): DailyReflectionSource | undefined {
  if (!completedJob(reading, 'bilibili.review', BILIBILI_AUTONOMY_CONTEXT, `${daily.dedupeKey}:bilibili`)) return
  const payload = BilibiliReading.safeParse(reading.payload).data
  if (payload?.dailyTaskId !== daily.id) return

  const item = store.bilibili.get(payload.candidateId)
  const receipt = item?.receipt
  if (item?.id !== payload.candidateId || item.status !== 'read' || receipt?.kind !== (payload.clipRequest ? 'video.clip-sampled' : 'video.subtitle-read') ||
    receipt.activityId !== payload.activityId || item.sourceId && !store.bilibili.sourceActive(item.sourceId)) return
  const target = parseBilibiliTarget(item.bvid, item.part)
  if (!target || target.bvid !== item.bvid || target.part !== item.part) return

  const at = Date.parse(receipt.at)
  const finalized = Date.parse(item.updatedAt)
  if (!(Date.parse(item.createdAt) <= at && Date.parse(reading.createdAt) <= at && at < deadline &&
    at <= finalized && finalized <= Date.parse(reading.task.updatedAt))) return

  const activity = store.activityById(receipt.activityId)
  const experience = { kind: 'bilibili' as const, dailyTaskId: daily.id, activityTaskId: reading.id, activityId: receipt.activityId }
  const isClip = receipt.kind === 'video.clip-sampled'
  if (!activity || activity.id !== receipt.activityId || activity.contextId !== (isClip ? BILIBILI_CLIP_CONTEXT : BILIBILI_AUTONOMY_CONTEXT) ||
    activity.source !== 'media.bilibili' || activity.kind !== receipt.kind || activity.status !== 'success' || !activity.sessionId?.trim() ||
    activity.occurredAt !== receipt.at || activity.taskId !== undefined && activity.taskId !== reading.id ||
    activity.data.candidateId !== item.id || activity.data.bvid !== target.bvid || activity.data.part !== target.part) return

  if (isClip) {
    const request = payload.clipRequest
    const clip = receipt.clip
    if (!request || !clip || receipt.provenance || !(at < request.deadline && request.deadline <= deadline) ||
      activity.taskId !== reading.id || clip.start !== request.start || clip.seconds !== request.seconds ||
      typeof clip.visual !== 'boolean' || typeof clip.audio !== 'boolean' || !clip.visual && !clip.audio ||
      request.mode === 'visual' && clip.audio || request.mode === 'audio' && clip.visual ||
      activity.data.start !== clip.start || activity.data.seconds !== clip.seconds ||
      activity.data.visual !== clip.visual || activity.data.audio !== clip.audio) return
    const sampled = clip.visual && clip.audio ? '画面与声音转写' : clip.visual ? '画面' : '声音转写'
    return { experience, at: receipt.at, material: 'clip',
      fact: `在 B 站视频 ${target.bvid} 第 ${target.part} P 从第 ${clip.start} 秒抽样 ${clip.seconds} 秒，取得${sampled}。` }
  }

  if (receipt.provenance) {
    const { kind, sha256 } = receipt.provenance
    if (kind !== 'owner-supplied' || !isBilibiliSubtitleDigest(sha256) ||
      activity.data.subtitleOrigin !== kind || activity.data.subtitleSha256 !== sha256 ||
      store.bilibiliSubtitles.get(target.bvid, target.part)?.sha256 !== sha256) return
  } else if (activity.data.subtitleOrigin !== undefined || activity.data.subtitleSha256 !== undefined) return

  return {
    experience,
    at: receipt.at,
    fact: `阅读了 B 站视频 ${target.bvid} 第 ${target.part} P 的${receipt.provenance ? '主人提供的' : ''}字幕摘录。`,
  }
}

export function verifiedDailyReflectionSource(store: ReflectionStore, dailyTaskId: string): DailyReflectionSource | undefined {
  const daily = store.autonomy.get(dailyTaskId)
  const permit = DailyChoice.safeParse(daily?.payload).data
  if (!daily || daily.id !== dailyTaskId || !permit || !completedJob(daily, 'daily.choice', DAILY_AUTONOMY_CONTEXT, `daily:${permit.date}`)) return
  if (permit.choice === 'house-project') {
    const proof = verifiedDailyHouseProjectSection(store, daily)
    const confirmed = Date.parse(daily.task.updatedAt)
    if (!proof || !proof.receipt.placed || !(Date.parse(proof.at) <= confirmed && confirmed <= Date.now())) return
    return {
      experience: { kind: 'house-project', dailyTaskId, activityTaskId: permit.activityTaskId, activityId: proof.activityId },
      at: proof.at,
      fact: dailyHouseProjectReflectionFact(proof),
    }
  }

  const child = store.autonomy.get(permit.activityTaskId)
  if (!child || child.id !== permit.activityTaskId) return
  const created = Date.parse(daily.createdAt)
  const started = Date.parse(child.createdAt)
  const finished = Date.parse(child.task.updatedAt)
  const confirmed = Date.parse(daily.task.updatedAt)
  if (!(created <= started && started < permit.expiresAt && started <= finished && finished <= confirmed && confirmed <= Date.now())) return

  if (permit.choice === 'bilibili') return verifiedDailyBilibiliReading(store, daily, child, permit.expiresAt)

  if (permit.choice === 'supply' || permit.choice === 'build') {
    if (permit.visitId !== daily.id || permit.visitJoined !== true || permit.visitStatus !== 'offline' ||
      permit.visitExpiresAt === undefined || permit.visitExpiresAt > permit.expiresAt ||
      child.payload.expiresAt !== permit.visitExpiresAt ||
      !completedJob(child, 'minecraft.supply', MINECRAFT_SUPPLY_CONTEXT, `visit-${permit.choice}:${daily.id}`)) return
    const proof = verifiedCampReceipt(child, id => store.taskById(id))
    const visit = permit.choice === 'build' ? proof?.visitBuild : proof?.visitSupply
    if (proof?.item.kind !== permit.choice || visit?.visitId !== daily.id || Date.parse(proof.item.at) >= permit.visitExpiresAt) return
    return {
      experience: { kind: permit.choice, dailyTaskId, activityTaskId: child.id, receiptTaskId: proof.childId },
      at: proof.item.at,
      fact: permit.choice === 'build' ? '在 Minecraft 的营地短访中选择搭建，游戏确认放置 8 块木板和 1 个工作台，核对背包扣料后已下线。'
        : '在 Minecraft 的营地短访中选择补给，游戏确认消耗 1 根原木、增加 4 块木板、至少保留 2 根原木，并已下线。',
    }
  }

  if (!completedJob(child, 'minecraft.supply', MINECRAFT_SUPPLY_CONTEXT, surveyWindowKey(permit.date)) ||
    child.payload.windowRuleId !== permit.windowRuleId) return
  const proof = verifiedMinecraftSurveyMoment(child.id, store)
  if (!proof || !(Date.parse(proof.receipt.at) < permit.expiresAt)) return

  return {
    experience: { kind: 'survey', dailyTaskId, activityTaskId: child.id, receiptTaskId: proof.moment.taskId },
    at: proof.receipt.at,
    fact: `在 Minecraft ${proof.moment.summary}`,
  }
}
