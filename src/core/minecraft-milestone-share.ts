import { z } from 'zod'

export const MinecraftMilestoneMoment = z.strictObject({
  kind: z.enum(['camp-project', 'house']),
  taskId: z.uuid(),
  summary: z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u),
})
export type MinecraftMilestoneMoment = z.infer<typeof MinecraftMilestoneMoment>

export const MinecraftMilestoneReflection = z.string().trim().min(2).max(50)
  .regex(/^我[\p{Script=Han}，。！？、…]+$/u)
  .refine(text => /\p{Script=Han}/u.test(text.slice(1)) && !/(?:坐标|经纬|标题|原图|原文|链接|地址|玩家名|私聊)/u.test(text))

export function matchesMinecraftMilestoneShare(body: string, fact: string): boolean {
  if (!body.startsWith(fact)) return false
  const reflection = body.slice(fact.length)
  return MinecraftMilestoneReflection.safeParse(reflection).data === reflection
}
