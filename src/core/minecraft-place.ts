import { z } from 'zod'

export const MINECRAFT_PLACE_CAPABILITY = 'minecraft.place.name'
export const MINECRAFT_PLACE_EVENT = 'world.place-named'

export const MinecraftPlaceName = z.string().trim().min(1).max(40)
  .regex(/^[^\u0000-\u001f\u007f]+$/u).transform(name => name.normalize('NFKC'))

export const MinecraftPlace = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  memoryId: z.uuid(),
  name: z.string().min(1).max(40),
  dimension: z.string().min(1).max(100),
  x: z.int(),
  y: z.int(),
  z: z.int(),
  verifiedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type MinecraftPlace = z.infer<typeof MinecraftPlace>

export function minecraftPlaceKey(name: string): string {
  return MinecraftPlaceName.parse(name).toLocaleLowerCase('zh-CN')
}

export function minecraftPlaceFact(place: Pick<MinecraftPlace, 'name' | 'dimension' | 'x' | 'y' | 'z'>): string {
  return `Minecraft 建筑地点「${place.name}」位于 ${place.dimension} 的 (${place.x}, ${place.y}, ${place.z})，这是已验收工程在验收时的授权区中心，不是入口或当前站位。`
}
