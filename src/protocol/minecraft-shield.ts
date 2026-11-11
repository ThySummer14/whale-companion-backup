import { z } from 'zod'

export const MinecraftShieldRequest = z.strictObject({ seconds: z.int().min(1).max(5).default(2) })
export type MinecraftShieldRequest = z.infer<typeof MinecraftShieldRequest>

export const MinecraftShieldReceipt = z.strictObject({
  raised: z.literal(true),
  released: z.literal(true),
  requestedTicks: z.int().min(20).max(100).multipleOf(20),
  blockingTicks: z.int().min(14).max(100),
}).refine(({ requestedTicks, blockingTicks }) => blockingTicks >= requestedTicks - 6 && blockingTicks <= requestedTicks)
export type MinecraftShieldReceipt = z.infer<typeof MinecraftShieldReceipt>
