import { minecraftBlockState } from './minecraft-block-state.ts'
import { compileVoxelCells } from './minecraft-voxel.ts'

// Average texture colors of stable vanilla 1.21.1 full blocks, including the concrete and terracotta sets.
const TEXTURE_COLORS: Readonly<Record<string, string>> = {
  white_concrete: 'cfd5d6', light_gray_concrete: '7d7d73', gray_concrete: '373a3e', black_concrete: '080a0f',
  brown_concrete: '603c20', red_concrete: '8e2121', orange_concrete: 'e06101', yellow_concrete: 'f1af15',
  lime_concrete: '5ea918', green_concrete: '495b24', cyan_concrete: '157788', light_blue_concrete: '2489c7',
  blue_concrete: '2d2f8f', purple_concrete: '64209c', magenta_concrete: 'a9309f', pink_concrete: 'd6658f',
  white_terracotta: 'd2b2a1', light_gray_terracotta: '876b62', gray_terracotta: '3a2a24', black_terracotta: '251710',
  brown_terracotta: '4d3324', red_terracotta: '8f3d2f', orange_terracotta: 'a25426', yellow_terracotta: 'ba8523',
  lime_terracotta: '687635', green_terracotta: '4c532a', cyan_terracotta: '575b5b', light_blue_terracotta: '716d8a',
  blue_terracotta: '4a3c5b', purple_terracotta: '764656', magenta_terracotta: '96586d', pink_terracotta: 'a24e4f',
  andesite: '888889', bricks: '976253', calcite: 'dfe0dd', cherry_planks: 'e3b3ad', cobblestone: '807f80',
  dark_oak_planks: '432b14', deepslate_tiles: '373737', diorite: 'bdbcbd', granite: '956756', gray_wool: '3f4448',
  light_blue_wool: '3aafd9', moss_block: '596e2d', mud_bricks: '89684f', mushroom_stem: 'cbc5ba',
  oak_planks: 'a2834f', terracotta: '985e44',
}
const PREVIEW_COLORS: Readonly<Record<string, string>> = {
  ...TEXTURE_COLORS,
  sandstone: 'd8cb9b', smooth_sandstone: 'e1d3a2', tuff: '6c6d66', tuff_bricks: '666960',
  waxed_weathered_cut_copper: '6c9b82', waxed_oxidized_cut_copper: '50a88d', packed_mud: '8e694f',
  stripped_acacia_wood: 'ad5c35', ochre_froglight: 'ede3b1', pearlescent_froglight: 'ebcddd', glowstone: 'a98354',
  cyan_stained_glass: '2e8087', light_blue_stained_glass: '559eae', spruce_planks: '725437',
}

export function voxelPreviewColor(state: string): number {
  return Number.parseInt(PREVIEW_COLORS[state.replace(/^minecraft:/u, '').split('[', 1)[0]!] ?? '939a9f', 16)
}
type RGB = [number, number, number]

class MagicaVoxelError extends Error {
  constructor(readonly code: string) { super(code) }
}

function blockColor(red: number, green: number, blue: number) {
  return (red << 16 | green << 8 | blue).toString(16).padStart(6, '0')
}

function defaultPalette() {
  const ramp = [255, 204, 153, 102, 51, 0]
  const colors = ramp.flatMap(red => ramp.flatMap(green => ramp.map(blue => blockColor(red, green, blue))))
  colors.pop()
  const shades = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17]
  return colors.concat(shades.map(n => blockColor(n, 0, 0)), shades.map(n => blockColor(0, n, 0)),
    shades.map(n => blockColor(0, 0, n)), shades.map(n => blockColor(n, n, n)))
}

function rgb(hex: string): RGB {
  const value = Number.parseInt(hex, 16)
  return [value >>> 16, value >>> 8 & 255, value & 255]
}

const TEXTURES = Object.entries(TEXTURE_COLORS).map(([name, hex]) => ({ state: `minecraft:${name}`, color: rgb(hex) }))

function nearestBlock(hex: string) {
  const [r, g, b] = rgb(hex)
  let best = TEXTURES[0]!.state
  let distance = Infinity
  for (const { state, color: [red, green, blue] } of TEXTURES) {
    // Redmean distance weights RGB according to the midpoint of the red channel.
    const meanRed = (r + red) / 512
    const score = (2 + meanRed) * (red - r) ** 2 + 4 * (green - g) ** 2 + (3 - meanRed) * (blue - b) ** 2
    if (score >= distance) continue
    best = state
    distance = score
  }
  return best
}

function overrides(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MagicaVoxelError('invalid-vox-palette')
  const palette = new Map<string, string>()
  for (const [key, state] of Object.entries(input)) {
    const color = key.toLowerCase()
    const block = typeof state === 'string' && state.length <= 512 ? minecraftBlockState(state) : undefined
    if (!/^#[0-9a-f]{6}$/u.test(color) || palette.has(color) || !block || /^minecraft:(?:cave_|void_)?air$/u.test(block.name)) {
      throw new MagicaVoxelError('invalid-vox-palette')
    }
    palette.set(color, block.state)
  }
  return palette
}

function readModel(bytes: Buffer) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'VOX ') throw new MagicaVoxelError('invalid-vox-header')
  const version = bytes.readUInt32LE(4)
  if (version !== 150 && version !== 200) throw new MagicaVoxelError('unsupported-vox-version')
  if (bytes.toString('ascii', 8, 12) !== 'MAIN' || bytes.readUInt32LE(12) !== 0 || bytes.readUInt32LE(16) !== bytes.length - 20) {
    throw new MagicaVoxelError('invalid-vox-chunks')
  }
  const chunks = new Map<string, Buffer>()
  for (let start = 20; start < bytes.length;) {
    if (start + 12 > bytes.length) throw new MagicaVoxelError('invalid-vox-chunks')
    const id = bytes.toString('ascii', start, start + 4)
    const end = start + 12 + bytes.readUInt32LE(start + 4)
    if (end > bytes.length || bytes.readUInt32LE(start + 8) !== 0) throw new MagicaVoxelError('invalid-vox-chunks')
    if (['nTRN', 'nGRP', 'nSHP', 'IMAP'].includes(id)) throw new MagicaVoxelError('unsupported-vox-scene')
    if (['PACK', 'SIZE', 'XYZI', 'RGBA'].includes(id)) {
      if (chunks.has(id)) throw new MagicaVoxelError('unsupported-vox-scene')
      chunks.set(id, bytes.subarray(start + 12, end))
    }
    start = end
  }
  const pack = chunks.get('PACK')
  if (pack && (pack.length !== 4 || pack.readUInt32LE() !== 1)) throw new MagicaVoxelError('unsupported-vox-scene')
  const size = chunks.get('SIZE')
  const cells = chunks.get('XYZI')
  const rgba = chunks.get('RGBA')
  if (size?.length !== 12 || !cells || cells.length < 8 || (rgba && rgba.length !== 1024)) throw new MagicaVoxelError('invalid-vox-model')
  const [width, depth, height] = [size.readUInt32LE(0), size.readUInt32LE(4), size.readUInt32LE(8)]
  const count = cells.readUInt32LE()
  if ([width, depth, height].some(side => side < 1 || side > 256) || count > width * height * depth || cells.length !== 4 + count * 4) {
    throw new MagicaVoxelError('invalid-vox-model')
  }
  const colors = rgba ? Array.from({ length: 255 }, (_, index) => rgba.toString('hex', 4 * index, 4 * index + 3)) : defaultPalette()
  return { version, cells, colors, width, height, depth }
}

export function compileMagicaVoxel(bytes: Buffer, { palette = {}, depthAsZ = false }: { palette?: unknown; depthAsZ?: boolean } = {}) {
  const { version, cells, colors, width, height, depth } = readModel(bytes)
  const custom = overrides(palette)
  const aliases = colors.map(hex => `#${hex}`)
  const used = new Set<string>()
  for (let offset = 7; offset < cells.length; offset += 4) {
    const color = aliases[cells[offset]! - 1]
    if (!color) throw new MagicaVoxelError('invalid-vox-color-index')
    used.add(color)
  }
  const colorsToBlocks = Object.fromEntries([...used].sort().map(color => [color, custom.get(color) ?? nearestBlock(color.slice(1))]))
  function* mappedCells(): Generator<[number, number, number, string]> {
    for (let offset = 4; offset < cells.length; offset += 4) {
      const depthIndex = cells[offset + 1]!
      if (depthIndex >= depth) throw new MagicaVoxelError('voxel-out-of-bounds')
      yield [cells[offset]!, cells[offset + 2]!, depthAsZ ? depthIndex : depth - 1 - depthIndex, aliases[cells[offset + 3]! - 1]!]
    }
  }
  const blueprint = compileVoxelCells([width, height, depth], colorsToBlocks, mappedCells())
  return { blueprint, source: { format: 'magica-voxel', version, depthAsZ, colorsToBlocks } }
}
