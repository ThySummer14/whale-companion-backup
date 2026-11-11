import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SURVEY_WINDOW_KEY_PREFIX, type MinecraftSurveyWindowInput, type MinecraftSurveyWindowRule } from '../protocol/api.ts'

const HOUR_MS = 60 * 60 * 1000
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_RULE_AGE_MS = 8 * 26 * HOUR_MS
const LocalTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
const Epoch = z.int().min(0).max(MAX_DATE_MS)
const windowFields = {
  zoneId: z.uuid(), start: LocalTime, end: LocalTime, days: z.int().min(1).max(7),
  allowBilibili: z.literal(true).optional(),
  allowMinecraftLogin: z.literal(true).optional(),
  allowMinecraftSupply: z.literal(true).optional(),
  allowMinecraftBuild: z.literal(true).optional(),
  allowMinecraftProject: z.literal(true).optional(),
  allowMinecraftPatrol: z.literal(true).optional(),
  allowMinecraftGather: z.literal(true).optional(),
  allowMinecraftProjectGather: z.literal(true).optional(),
  houseProjectId: z.uuid().optional(),
  allowHouseProjectSupply: z.literal(true).optional(),
}

function minutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
}

function supportedDuration({ start, end }: Pick<MinecraftSurveyWindowInput, 'start' | 'end'>): boolean {
  const duration = minutes(end) - minutes(start)
  return duration >= 30 && duration <= 180
}

function supportedSupply({ allowMinecraftSupply, allowMinecraftLogin }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftSupply !== true || allowMinecraftLogin === true
}

function supportedBuild({ allowMinecraftBuild, allowMinecraftLogin }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftBuild !== true || allowMinecraftLogin === true
}

function supportedProject({ allowMinecraftProject, allowMinecraftLogin, allowMinecraftSupply, allowMinecraftBuild }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftProject !== true || allowMinecraftLogin === true && allowMinecraftSupply === true && allowMinecraftBuild === true
}

function supportedPatrol({ allowMinecraftPatrol, allowMinecraftLogin }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftPatrol !== true || allowMinecraftLogin === true
}

function supportedGather({ allowMinecraftGather, allowMinecraftLogin }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftGather !== true || allowMinecraftLogin === true
}

function supportedProjectGather({ allowMinecraftProjectGather, allowMinecraftProject, allowMinecraftGather }: MinecraftSurveyWindowInput): boolean {
  return allowMinecraftProjectGather !== true || allowMinecraftProject === true && allowMinecraftGather === true
}

function supportedHouseSupply({ allowHouseProjectSupply, houseProjectId }: MinecraftSurveyWindowInput): boolean {
  return allowHouseProjectSupply !== true || houseProjectId !== undefined
}

export const MinecraftSurveyWindowInputSchema = z.strictObject(windowFields)
  .refine(supportedDuration, 'Choose a same-day survey window lasting 30 to 180 minutes')
  .refine(supportedSupply, 'Short-visit supply requires Minecraft login authorization')
  .refine(supportedBuild, 'Short-visit building requires Minecraft login authorization')
  .refine(supportedProject, 'A camp project requires Minecraft login, supply and build authorization')
  .refine(supportedPatrol, 'Camp patrol requires Minecraft login authorization')
  .refine(supportedGather, 'Camp gathering requires Minecraft login authorization')
  .refine(supportedProjectGather, 'Project gathering requires camp project and gathering authorization')
  .refine(supportedHouseSupply, 'Building supply requires a specified building project')

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

function localDate(day: Date): string {
  const year = String(day.getFullYear()).padStart(4, '0')
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

function localTime(day: Date, value: string): number | undefined {
  const hour = Number(value.slice(0, 2))
  const minute = Number(value.slice(3, 5))
  const at = new Date(day)
  at.setHours(hour, minute, 0, 0)
  // A clock gap can move a requested time forward. Do not extend consent through it.
  if (at.getHours() === hour && at.getMinutes() === minute && localDate(at) === localDate(day)) return at.getTime()
}

function expiry(input: MinecraftSurveyWindowInput, now: number): number | undefined {
  const day = new Date(now)
  const closesToday = localTime(day, input.end)
  const minutesNow = day.getHours() * 60 + day.getMinutes()
  const startsTomorrow = closesToday === undefined ? minutesNow >= minutes(input.end) : now >= closesToday
  day.setHours(12, 0, 0, 0)
  day.setDate(day.getDate() + input.days - (startsTomorrow ? 0 : 1))
  return localTime(day, input.end)
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch { return false }
}

export const MinecraftSurveyWindowRuleSchema = z.strictObject({
  ...windowFields,
  id: z.uuid(),
  timeZone: z.string().min(1).max(100).refine(validTimeZone),
  createdAt: Epoch,
  expiresAt: Epoch,
  suppressedDate: z.string().refine(isLocalDate).optional(),
}).refine(rule => supportedSupply(rule) && supportedBuild(rule) && supportedProject(rule) && supportedPatrol(rule) && supportedGather(rule) &&
  supportedProjectGather(rule) && supportedHouseSupply(rule) && supportedDuration(rule) &&
  rule.expiresAt > rule.createdAt && rule.expiresAt - rule.createdAt <= MAX_RULE_AGE_MS &&
  (rule.timeZone !== hostTimeZone() || expiry(rule, rule.createdAt) === rule.expiresAt))

export function createSurveyWindow(input: MinecraftSurveyWindowInput, now: number): MinecraftSurveyWindowRule {
  const request = MinecraftSurveyWindowInputSchema.parse(input)
  const createdAt = Epoch.parse(now)
  const expiresAt = expiry(request, createdAt)
  if (expiresAt === undefined) throw new z.ZodError([{ code: 'custom', path: ['end'], message: 'survey-window-invalid-local-time' }])
  return { ...request, id: randomUUID(), timeZone: hostTimeZone(), createdAt, expiresAt }
}

export function surveyWindowDay(rule: MinecraftSurveyWindowRule, now: number): { date: string; opensAt: number; closesAt: number } | undefined {
  if (rule.timeZone !== hostTimeZone() || !Epoch.safeParse(now).success) return undefined
  const day = new Date(now)
  const opensAt = localTime(day, rule.start)
  const closesAt = localTime(day, rule.end)
  if (opensAt !== undefined && closesAt !== undefined && opensAt < closesAt) return { date: localDate(day), opensAt, closesAt }
}

export function surveyWindowKey(date: string): string {
  return `${SURVEY_WINDOW_KEY_PREFIX}${date}`
}

export function isSurveyWindowKey(key: string): boolean {
  return key.startsWith(SURVEY_WINDOW_KEY_PREFIX) && isLocalDate(key.slice(SURVEY_WINDOW_KEY_PREFIX.length))
}
