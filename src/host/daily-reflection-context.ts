import { lexicalMatcher } from '../core/memory.ts'
import { SELF_NOTE_TRAIT_LABELS, type SelfNote, type SelfNoteExperience } from '../core/model.ts'
import type { DailyReflectionSource } from './daily-reflection-source.ts'

export function reflectionPromptFact(kind: SelfNoteExperience['kind'] | undefined, fact: string): string {
  if (kind === 'bilibili') return fact.replace(/视频 BV[A-Za-z0-9]{10} 第 \d+ P /u, '视频')
  if (kind === 'house') return '在 Minecraft 按蓝图完成了一座小屋。宿主核对了蓝图位置，并验证了本次放置结果。'
  return fact
}

export function restoreLegacyReflectionReceipt(note: SelfNote, lookup: (dailyTaskId: string) => DailyReflectionSource | undefined): SelfNote {
  const experience = note.experience
  if (note.experienceReceipt || !experience || !('dailyTaskId' in experience) || experience.kind === 'house-project') return note
  const source = lookup(experience.dailyTaskId)
  if (!source || !Number.isFinite(Date.parse(source.at))) return note
  const confirmed = source.experience
  if (confirmed.dailyTaskId !== experience.dailyTaskId || confirmed.activityTaskId !== experience.activityTaskId ||
      confirmed.kind !== experience.kind) return note
  if (experience.kind === 'bilibili' ? confirmed.kind !== 'bilibili' || confirmed.activityId !== experience.activityId
    : !('receiptTaskId' in confirmed) || confirmed.receiptTaskId !== experience.receiptTaskId) return note
  return { ...note, experienceReceipt: { at: source.at, fact: source.fact } }
}

export function reflectionPredecessors(notes: readonly SelfNote[], source: { experience: SelfNoteExperience; at: string; fact: string }): SelfNote[] {
  const match = lexicalMatcher(source.fact)
  const currentIsReading = source.experience.kind === 'bilibili'
  const at = Date.parse(source.at)
  if (!Number.isFinite(at)) return []
  const candidates = notes.filter(note => note.experience && (!note.experienceReceipt || Date.parse(note.experienceReceipt.at) < at))
    .map(note => ({ note, sameWorld: (note.experience?.kind === 'bilibili') === currentIsReading,
      similarity: match(`${note.experienceReceipt?.fact ?? ''} ${note.content} ${note.trait ? SELF_NOTE_TRAIT_LABELS[note.trait] : ''}`) }))
  const sameWorld = candidates.filter(candidate => candidate.sameWorld).slice(0, 3)
  const related = candidates.filter(({ sameWorld, similarity, note }) => !sameWorld &&
    (similarity > 0.05 || !!(note.trait && note.experienceReceipt && note.evidenceRefs?.some(ref => ref.role === 'assistant'))))
    .sort((a, b) => b.similarity - a.similarity).slice(0, 1)
  return [...sameWorld, ...related].map(candidate => candidate.note)
}
