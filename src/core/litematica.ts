import { MINECRAFT_HOUSE_BLOCKS, MinecraftHouseLayout, minecraftHouseMaterials, type MinecraftHouseSymbol } from './minecraft-house.ts'
import { blockStateNbt } from './minecraft-block-state.ts'
import { compound, integer, list, nbtFile, number, string, tag, vector } from './nbt-write.ts'

export function inspectLitematica(raw: unknown) {
  const layout = MinecraftHouseLayout.parse(raw)
  const materials = minecraftHouseMaterials(layout)
  return {
    format: 'litematic', version: 7, subVersion: 1, minecraftDataVersion: 3955,
    size: { x: layout.width, y: layout.height, z: layout.depth },
    totalVolume: layout.blocks.length,
    totalBlocks: Object.values(materials).reduce((total, count) => total + count, 0),
    materials,
  }
}

export function exportLitematica(raw: unknown, name: string): Buffer {
  const layout = MinecraftHouseLayout.parse(raw)
  const info = inspectLitematica(layout)
  // Java NBT strings use modified UTF-8. Keep metadata inside the BMP and omit NUL.
  const title = Array.from(name).filter(char => char.length === 1 && char.charCodeAt(0) > 0 &&
    (char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff)).slice(0, 80).join('') || 'Companion'
  const palette = [...new Set<MinecraftHouseSymbol>(['.', ...layout.blocks as Iterable<MinecraftHouseSymbol>])]
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
  const packed = Buffer.alloc(Math.ceil(info.totalVolume * bits / 64) * 8)
  let states = 0n
  for (const [index, block] of [...layout.blocks].entries()) {
    states |= BigInt(palette.indexOf(block as MinecraftHouseSymbol)) << BigInt(index * bits)
  }
  for (let offset = 0; offset < packed.length; offset += 8) {
    packed.writeBigUInt64BE(BigInt.asUintN(64, states), offset)
    states >>= 64n
  }

  const { x, y, z } = info.size
  const metadata = compound(
    string('Name', title), string('Author', 'Companion'), string('Description', 'Companion Minecraft blueprint'),
    integer('RegionCount', 1), integer('TotalBlocks', info.totalBlocks), integer('TotalVolume', info.totalVolume),
    tag(4, 'TimeCreated', number(0, true)), tag(4, 'TimeModified', number(0, true)), vector('EnclosingSize', x, y, z),
  )
  const region = compound(
    vector('Position', 0, 0, 0), vector('Size', x, y, z),
    list('BlockStatePalette', palette.map(block => blockStateNbt('minecraft:' + MINECRAFT_HOUSE_BLOCKS[block]))),
    tag(12, 'BlockStates', Buffer.concat([number(packed.length / 8), packed])),
    list('Entities'), list('TileEntities'), list('PendingBlockTicks'), list('PendingFluidTicks'),
  )
  return nbtFile(
    integer('Version', info.version), integer('SubVersion', info.subVersion), integer('MinecraftDataVersion', info.minecraftDataVersion),
    tag(10, 'Metadata', metadata), tag(10, 'Regions', compound(tag(10, 'House', region))),
  )
}
