import { z } from 'zod'

const MomentFact = {
  taskId: z.uuid(),
  summary: z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u),
}
export const MinecraftMilestoneMoment = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['camp-project', 'house']), ...MomentFact }),
  z.strictObject({ kind: z.literal('house-project'), projectId: z.uuid(), ...MomentFact }),
])
export type MinecraftMilestoneMoment = z.infer<typeof MinecraftMilestoneMoment>

export const MINECRAFT_SHARE_TTL_MS = 24 * 60 * 60_000

export function minecraftShareDedupeKey(moment: Pick<MinecraftMilestoneMoment, 'taskId'> | MinecraftMilestoneMoment): string {
  return 'projectId' in moment ? `house-project:${moment.projectId}` : moment.taskId
}

export function minecraftHouseProjectShareMoment(taskId: string, proof: { projectId: string; sections: number; checked: number }) {
  return { kind: 'house-project' as const, taskId, projectId: proof.projectId,
    summary: `在 Minecraft 完成了一项建筑工程。整栋验收核对了 ${proof.sections} 个分区的 ${proof.checked} 处方块和留空。` }
}

export const MinecraftMilestoneReflection = z.string().trim().min(2).max(50)
  .regex(/^我[\p{Script=Han}，。！？、…]+$/u)
  .refine(text => /\p{Script=Han}/u.test(text.slice(1)) && !/(?:坐标|经纬|标题|原图|原文|链接|地址|玩家名|私聊)/u.test(text))

export function matchesMinecraftMilestoneShare(body: string, fact: string): boolean {
  if (!body.startsWith(fact)) return false
  const reflection = body.slice(fact.length)
  return MinecraftMilestoneReflection.safeParse(reflection).data === reflection
}
