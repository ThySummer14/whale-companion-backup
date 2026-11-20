import { z } from 'zod'
import { MINECRAFT_HOUSE_BLOCKS } from './minecraft-house.ts'
import { MinecraftAuthorizedZone } from './minecraft-supply.ts'

const Position = z.strictObject({ x: z.int(), y: z.int(), z: z.int() })
const Material = z.enum(Object.values(MINECRAFT_HOUSE_BLOCKS).filter(block => block !== 'air'))

export const MinecraftHouseSupportRequest = z.strictObject({
  zone: MinecraftAuthorizedZone,
  positions: z.array(Position).min(1).max(125),
  material: Material,
}).superRefine(({ zone, positions }, ctx) => {
  for (const [index, position] of positions.entries()) {
    if (position.y !== zone.y - 1 || Math.abs(position.x - zone.x) > zone.radius || Math.abs(position.z - zone.z) > zone.radius) {
      ctx.addIssue({ code: 'custom', message: `Support position ${index} must be one block below the blueprint and inside its zone` })
    }
  }
})
export type MinecraftHouseSupportRequest = z.infer<typeof MinecraftHouseSupportRequest>
