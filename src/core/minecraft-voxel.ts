import { z } from 'zod'
import { blockStateNbt, minecraftBlockState } from './minecraft-block-state.ts'
import { byteArray, compound, intArray, integer, intList, list, nbtFile, short, tag } from './nbt-write.ts'

const MINECRAFT_DATA_VERSION = 3955
const SCHEMATIC_CELL_LIMIT = 16 * 1024 * 1024
const AIR = 'minecraft:air'
const Alias = z.string().min(1).max(64).regex(/^[#a-zA-Z0-9_.-]+$/u)
const Side = z.int().min(1).max(65535)
const Coordinate = z.int().nonnegative()
const VoxelBlueprint = z.strictObject({
  version: z.literal(1),
  size: z.tuple([Side, Side, Side]),
  palette: z.record(Alias, z.string().min(1).max(512)),
  voxels: z.array(z.tuple([Coordinate, Coordinate, Coordinate, Alias])).min(1),
})
type EncodedVoxel = { position: [number, number, number]; index: number; material: number }
type VoxelCell = [x: number, y: number, z: number, alias: string]

class VoxelBlueprintError extends Error {
  constructor(readonly code: string) { super(code) }
}

export function compileMinecraftVoxels(raw: unknown) {
  const { size, palette, voxels } = VoxelBlueprint.parse(raw)
  return compileVoxelCells(size, palette, voxels)
}

export function compileVoxelCells(size: [number, number, number], palette: Record<string, string>, voxels: Iterable<VoxelCell>) {
  const aliases = new Map<string, string>()
  for (const [alias, value] of Object.entries(palette)) {
    const block = minecraftBlockState(value)
    if (!block) throw new VoxelBlueprintError('invalid-minecraft-block-state')
    aliases.set(alias, block.state)
  }

  const [width, height, depth] = size
  const volume = width * height * depth
  const materials = [AIR]
  const counts = new Map<string, number>()
  const ids = new Map([[AIR, 0]])
  const entries = new Map<number, EncodedVoxel>()
  for (const [x, y, z, alias] of voxels) {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) throw new VoxelBlueprintError('voxel-out-of-bounds')
    const index = x + (z + y * depth) * width
    if (entries.has(index)) throw new VoxelBlueprintError('duplicate-voxel-coordinate')
    const block = aliases.get(alias)
    if (!block) throw new VoxelBlueprintError('unknown-voxel-material')
    let material = ids.get(block)
    if (material === undefined) {
      material = materials.length
      ids.set(block, material)
      materials.push(block)
    }
    counts.set(block, (counts.get(block) ?? 0) + 1)
    entries.set(index, { position: [x, y, z], index, material })
  }
  const info = {
    minecraftDataVersion: MINECRAFT_DATA_VERSION, size: { x: width, y: height, z: depth },
    totalVolume: volume, declared: entries.size, unlisted: volume - entries.size,
    materials: Object.fromEntries(counts),
  }
  return { info, size, materials, entries: [...entries.values()].sort((a, b) => a.index - b.index) }
}

type Compiled = ReturnType<typeof compileMinecraftVoxels>

export function exportVoxelStructure({ size, materials, entries }: Compiled): Buffer {
  return nbtFile(
    integer('DataVersion', MINECRAFT_DATA_VERSION), intList('size', size),
    list('palette', materials.map(blockStateNbt)),
    list('blocks', entries.map(({ position, material }) => compound(intList('pos', position), integer('state', material)))),
    list('entities'),
  )
}

export function exportVoxelSchematic({ info, size, materials, entries }: Compiled): Buffer {
  if (info.totalVolume > SCHEMATIC_CELL_LIMIT) throw new VoxelBlueprintError('voxel-schematic-volume-too-large')
  let byteLength = info.totalVolume
  for (const { material } of entries) {
    for (let value = material; value >= 128; value >>>= 7) byteLength++
  }
  // Missing cells use the one-byte air index. Write only the listed cells and extra VarInt bytes.
  const data = Buffer.alloc(byteLength)
  let offset = 0
  let cell = 0
  for (const { index, material } of entries) {
    offset += index - cell
    let value = material
    while (value >= 128) {
      data[offset++] = (value & 127) | 128
      value >>>= 7
    }
    data[offset++] = value
    cell = index + 1
  }
  const [width, height, depth] = size
  const palette = Buffer.concat([...materials.map((state, id) => integer(state, id)), Buffer.from([0])])
  return nbtFile(tag(10, 'Schematic', compound(
    integer('Version', 3), integer('DataVersion', MINECRAFT_DATA_VERSION),
    short('Width', width), short('Height', height), short('Length', depth),
    intArray('Offset', [0, 0, 0]),
    tag(10, 'Blocks', compound(
      tag(10, 'Palette', palette),
      byteArray('Data', data),
    )),
  )))
}
