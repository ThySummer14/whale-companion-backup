import { z } from 'zod'
import type { MinecraftHouseRequest } from './minecraft-house.ts'

export const HOUSE_COMPLETION_TASK_PREFIX = 'minecraft-house-recovery-completion:'
export const HOUSE_VERIFICATION_ISSUE_LIMIT = 12

const HouseVerificationIssue = z.strictObject({
  index: z.int().min(0).max(124),
  reason: z.enum(['missing', 'blocked']),
})
const CellCount = z.int().min(0).max(125)

export const MinecraftHouseVerification = z.strictObject({
  checked: CellCount.min(1),
  matched: CellCount,
  missing: CellCount.max(100),
  blocked: CellCount,
  issues: z.array(HouseVerificationIssue).max(HOUSE_VERIFICATION_ISSUE_LIMIT),
}).refine(({ checked, matched, missing, blocked, issues }) => {
  const reportedMissing = issues.filter(issue => issue.reason === 'missing').length
  return matched + missing + blocked === checked && issues.length === Math.min(HOUSE_VERIFICATION_ISSUE_LIMIT, missing + blocked) &&
    reportedMissing <= missing && issues.length - reportedMissing <= blocked &&
    issues.every(({ index }, i) => index < checked && (i === 0 || index > issues[i - 1]!.index))
})
export type MinecraftHouseVerification = z.infer<typeof MinecraftHouseVerification>

export const HouseRecoveryCompletionResult = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('incomplete'), verification: MinecraftHouseVerification }),
  z.strictObject({ outcome: z.literal('completed'), verification: MinecraftHouseVerification, placed: z.int().min(1).max(3) }),
]).refine(result => result.outcome === 'completed'
  ? result.verification.matched === result.verification.checked && result.placed <= result.verification.checked
  : result.verification.matched < result.verification.checked)
export type HouseRecoveryCompletionResult = z.infer<typeof HouseRecoveryCompletionResult>

export function minecraftHouseVerificationMatches(result: MinecraftHouseVerification, { layout }: Pick<MinecraftHouseRequest, 'layout'>): boolean {
  return result.checked === layout.blocks.length && result.missing <= layout.blocks.replaceAll('.', '').length &&
    result.issues.every(({ index, reason }) => index >= 0 && index < layout.blocks.length && (reason !== 'missing' || layout.blocks[index] !== '.'))
}
