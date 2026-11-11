import { z } from 'zod'
import { MAX_AUTONOMOUS_BILIBILI_CLIP_SECONDS } from '../protocol/bilibili.ts'

const EvidenceId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u)
const Option = z.string().regex(/^(?:visit|patrol|gather|defer|(?:survey|trail):[a-z][a-z0-9-]{0,23}|(?:read|clip):[1-9]\d?|house:[1-6]|house-supply:[1-6]:(?:oak|spruce))$/u)
const PlainText = z.string().trim().regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u)
const Goal = PlainText.min(8).max(120)

export const DailyInitiativeEvidence = z.strictObject({
  id: EvidenceId,
  kind: z.enum(['current', 'experience', 'self-note']),
  text: PlainText.min(2).max(180),
})
export type DailyInitiativeEvidence = z.infer<typeof DailyInitiativeEvidence>

const PreviousId = z.string().regex(/^goal-[1-3]$/u)
const PreviousGoal = z.strictObject({ taskId: z.uuid(), goal: Goal, expiresAt: z.int().positive() })
export type PreviousDailyGoal = z.infer<typeof PreviousGoal>
export const DailyInitiativeAttemptWorld = z.enum(['minecraft', 'bilibili'])
export type PendingDailyGoal = PreviousDailyGoal & { lastUnconfirmedWorld?: z.infer<typeof DailyInitiativeAttemptWorld> }
export const DailyBilibiliClip = z.strictObject({ start: z.int().min(0).max(7 * 86_400),
  seconds: z.int().min(1).max(MAX_AUTONOMOUS_BILIBILI_CLIP_SECONDS), mode: z.enum(['visual', 'audio', 'both']) })
const matchesClipOption = ({ option, clip }: { option: string; clip?: z.infer<typeof DailyBilibiliClip> }): boolean =>
  option.startsWith('clip:') === (clip !== undefined)

export const DailyInitiativeProposal = z.union([
  z.strictObject({ goal: Goal.optional(), evidenceId: EvidenceId, option: Option, previousId: PreviousId.optional(), clip: DailyBilibiliClip.optional() })
    .refine(matchesClipOption).refine(input => input.goal !== undefined || input.previousId !== undefined),
  z.strictObject({ option: z.literal('abandon'), previousId: PreviousId }),
])
export type DailyInitiativeProposal = z.infer<typeof DailyInitiativeProposal>

export const DailyInitiativeRecord = z.union([
  z.strictObject({ goal: Goal, evidence: DailyInitiativeEvidence, option: Option, previous: PreviousGoal.optional(), clip: DailyBilibiliClip.optional() }).refine(matchesClipOption),
  z.strictObject({ option: z.literal('abandon'), goal: Goal, previous: PreviousGoal }),
])
export type DailyInitiativeRecord = z.infer<typeof DailyInitiativeRecord>

export const DAILY_INITIATIVE_PROPOSE_TOOL = 'daily_initiative_propose'
export const DAILY_INITIATIVE_ACK = { accepted: true, state: 'proposed' } as const
export const DailyInitiativeSelfNoteSource = z.strictObject({ noteId: z.uuid(), revision: z.int().positive() })
export type DailyInitiativeSelfNoteSource = z.infer<typeof DailyInitiativeSelfNoteSource>
export const DailyInitiativeSelectionReceipt = z.strictObject({
  sessionId: z.string().min(1).max(200),
  eventSeq: z.int().positive(),
  optionLabel: PlainText.min(2).max(180),
  selfNote: DailyInitiativeSelfNoteSource.optional(),
})
