import { z } from 'zod'
import { DailyInitiativeAttemptWorld, DailyInitiativeEvidence, DailyInitiativeRecord, type DailyInitiativeSelfNoteSource, type PendingDailyGoal } from '../core/daily-initiative.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, SELF_NOTE_TRAIT_LABELS, type AutonomousJob } from '../core/model.ts'
import { DailyHouseSupplySelection, dailyHouseSupplyOption, verifiedDailyHouseSupply } from '../core/daily-house-project-proof.ts'
import type { CompanionStore } from '../core/store.ts'
import { verifiedDailyReflectionSource } from './daily-reflection-source.ts'
import { recentMinecraftMilestones, verifiedMinecraftMilestone } from './minecraft-milestones.ts'

const RECENT_DAYS = 7
const RECEIPT_LIMIT = 4
type InitiativeStore = Parameters<typeof recentMinecraftMilestones>[0] & Parameters<typeof verifiedDailyReflectionSource>[0] & Pick<CompanionStore, 'selfNotes'>

export function recentDailyInitiativeEvidence(store: InitiativeStore, now: number): {
  evidence: DailyInitiativeEvidence[]; selfNote?: DailyInitiativeSelfNoteSource
} {
  const earliest = now - RECENT_DAYS * 86_400_000
  const useMilestones = store.autonomy.settings().minecraftMilestonesEnabled === true
  const daily = store.autonomy.succeeded('daily.choice', DAILY_AUTONOMY_CONTEXT, RECEIPT_LIMIT * 2)
    .flatMap(job => {
      const supply = verifiedDailyHouseSupply(store, job)
      if (supply) return [{ at: supply.at, text: supply.fact }]
      const entry = verifiedDailyReflectionSource(store, job.id)
      if (!entry) return []
      const text = 'material' in entry && entry.material === 'clip' ? '曾抽样理解一个经核验的 B 站短片段。'
        : entry.experience.kind === 'bilibili' ? '曾阅读过一段经核验的 B 站字幕摘录。' : entry.fact
      return [{ at: entry.at, text }]
    })
  const milestones = useMilestones ? recentMinecraftMilestones(store, earliest) : []
  const facts = new Set<string>()
  const evidence: DailyInitiativeEvidence[] = []
  for (const { at, text } of [...daily, ...milestones.map(entry => ({ at: entry.at, text: entry.fact }))].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!(earliest <= Date.parse(at) && Date.parse(at) <= now)) continue
    const item = DailyInitiativeEvidence.safeParse({ id: `recent-${evidence.length + 1}`, kind: 'experience', text }).data
    if (!item || facts.has(item.text)) continue
    facts.add(item.text)
    evidence.push(item)
    if (evidence.length === RECEIPT_LIMIT) break
  }

  for (const note of store.selfNotes.recallCandidates(DAILY_REFLECTION_CONTEXT)) {
    if (!note.trait || !note.experience || !note.experienceReceipt || !note.evidenceRefs?.length ||
      note.createdBy !== 'companion' || note.status !== 'active' || !note.evidenceRefs.some(ref => ref.role === 'assistant') ||
      !(Date.parse(note.updatedAt) <= now)) continue
    const experience = note.experience
    const proof = 'dailyTaskId' in experience ? verifiedDailyReflectionSource(store, experience.dailyTaskId)
      : useMilestones ? verifiedMinecraftMilestone(store, experience.kind, experience.taskId) : undefined
    if (!proof || !(Date.parse(proof.at) <= now) || proof.at !== note.experienceReceipt.at || proof.fact !== note.experienceReceipt.fact ||
      !Object.entries(proof.experience).every(([key, value]) => Reflect.get(experience, key) === value)) continue
    const [latest] = store.selfNotes.revisions(note.id, 1)
    if (!latest || latest.snapshot.status !== 'active' || latest.snapshot.trait !== note.trait || latest.snapshot.updatedAt !== note.updatedAt) continue
    evidence.push(DailyInitiativeEvidence.parse({ id: 'self-1', kind: 'self-note', text: SELF_NOTE_TRAIT_LABELS[note.trait] }))
    return { evidence, selfNote: { noteId: note.id, revision: latest.revision } }
  }
  return { evidence }
}

const DEFERRED_GOAL_TTL_MS = 7 * 86_400_000
const PENDING_GOAL_LIMIT = 3

function unconfirmedAttempt(job: AutonomousJob, option: string): PendingDailyGoal['lastUnconfirmedWorld'] {
  if (job.task.status !== 'failed' && job.task.status !== 'cancelled') return
  const { initiativeAttempt, activityTaskId, choice, visitId, visitStatus } = job.payload
  const world = DailyInitiativeAttemptWorld.safeParse(initiativeAttempt).data
  if (world === 'bilibili' && (option.startsWith('read:') || option.startsWith('clip:')) &&
      choice === 'bilibili' && visitId === undefined && z.uuid().safeParse(activityTaskId).success) return world
  if (world !== 'minecraft') return
  if ((option.startsWith('survey:') || option.startsWith('trail:')) && choice === 'survey' &&
      visitId === undefined && z.uuid().safeParse(activityTaskId).success) return world
  const section = z.object({ projectId: z.uuid(), section: z.int().min(0).max(5) }).safeParse(job.payload.houseSection).data
  if (section && option === `house:${section.section + 1}` && choice === 'house-project' &&
      visitId === undefined && z.uuid().safeParse(activityTaskId).success) return world
  const supply = DailyHouseSupplySelection.safeParse(job.payload.houseSupply).data
  if (supply && option === dailyHouseSupplyOption(supply.section, supply.recipe) && choice === 'house-project-supply' &&
      visitId === undefined && z.uuid().safeParse(activityTaskId).success) return world
  if (visitId === job.id && ['starting', 'online', 'offline', 'unconfirmed'].includes(String(visitStatus)) &&
      (option === 'visit' && ['survey', 'supply', 'build', 'revisit', 'gather'].includes(String(choice)) ||
        (option === 'patrol' || option === 'gather') && option === choice)) return world
}

type PendingGoalStore = Pick<CompanionStore, 'taskById' | 'activityByTask'> & {
  autonomy: Pick<CompanionStore['autonomy'], 'recentInitiativeJobs'>
}

export function pendingDailyGoals(store: PendingGoalStore, date: string, now: number): PendingDailyGoal[] {
  const pending = new Map<string, PendingDailyGoal>()
  const jobs = store.autonomy.recentInitiativeJobs(date, new Date(now - DEFERRED_GOAL_TTL_MS).toISOString(), new Date(now).toISOString())
  for (const job of jobs) {
    const record = DailyInitiativeRecord.safeParse(job.payload.initiative).data
    if (!record) continue
    const deferred = record.option === 'defer' && job.task.status === 'cancelled'
    const abandoned = record.option === 'abandon' && job.task.status === 'cancelled'
    const supplied = job.task.status === 'succeeded' && record.option.startsWith('house-supply:') && !!verifiedDailyHouseSupply(store, job)
    const executed = record.option !== 'defer' && record.option !== 'abandon' &&
      !record.option.startsWith('house-supply:') && job.task.status === 'succeeded'
    const lastUnconfirmedWorld = unconfirmedAttempt(job, record.option)
    if (!deferred && !abandoned && !executed && !supplied && !lastUnconfirmedWorld) continue
    const previous = record.previous
    const original = previous && pending.get(previous.taskId)
    if (previous && (!original || original.goal !== previous.goal || original.expiresAt !== previous.expiresAt ||
        abandoned && record.goal !== original.goal)) continue
    if (original) pending.delete(original.taskId)
    if (lastUnconfirmedWorld && original) {
      pending.set(original.taskId, { ...original, lastUnconfirmedWorld })
    } else if (deferred || supplied || lastUnconfirmedWorld) {
      const expiresAt = original?.expiresAt ?? Date.parse(job.task.createdAt) + DEFERRED_GOAL_TTL_MS
      const unconfirmedWorld = supplied ? undefined : lastUnconfirmedWorld ?? original?.lastUnconfirmedWorld
      if (expiresAt > now) pending.set(job.id, { taskId: job.id, goal: record.goal, expiresAt,
        ...(unconfirmedWorld && { lastUnconfirmedWorld: unconfirmedWorld }) })
    }
  }
  return Array.from(pending.values()).reverse().slice(0, PENDING_GOAL_LIMIT)
}
