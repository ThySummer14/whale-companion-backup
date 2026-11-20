import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { compileMagicaVoxel } from '../src/core/minecraft-magica-voxel.ts'
import { compileMinecraftVoxels, exportVoxelSchematic, exportVoxelStructure } from '../src/core/minecraft-voxel.ts'
import { exportLitematica } from '../src/core/litematica.ts'
import { VoxelWorldInput, VoxelWorldReceipt, voxelSiteOrigin, voxelWorldReceiptMatches } from '../src/core/minecraft-blueprint-build.ts'

const palette = { brass: 'minecraft:gold_block', '#80C5D6': 'minecraft:cyan_stained_glass', gap: 'minecraft:air' }
const input = { version: 1, size: [3, 2, 4], palette, voxels: [[2, 1, 3, 'brass'], [0, 0, 1, '#80C5D6'], [1, 1, 1, 'gap']] }

test('bulk construction requires the approved extent and an exact verified world receipt', () => {
  const zone = { dimension: 'minecraft:overworld', x: 119, y: -60, z: 99, radius: 124 }
  const size = { x: 239, y: 124, z: 199 }
  const origin = voxelSiteOrigin(zone, size)
  assert.deepEqual(origin, { x: 0, y: -60, z: 0 })
  assert.equal(voxelSiteOrigin({ ...zone, radius: 122 }, size), undefined)
  const request = VoxelWorldInput.parse({ operationId: 'd10c0085-7924-45e6-8fa3-5ca66e7d1b03', sha256: 'a'.repeat(64),
    dimension: zone.dimension, origin, size, solids: 749430 })
  const receipt = VoxelWorldReceipt.parse({ operationId: request.operationId, sha256: request.sha256, phase: 'built', total: 5897564,
    solids: 749430, checked: 5897564, matched: 749430, placed: 738995, restored: true })
  assert.equal(voxelWorldReceiptMatches(receipt, request, 'build'), true)
  for (const change of [{ sha256: 'b'.repeat(64) }, { operationId: 'e942b838-1176-4fce-8c84-88277882a87f' },
    { checked: 5897563 }, { matched: 749429 }, { restored: false }]) {
    assert.equal(voxelWorldReceiptMatches({ ...receipt, ...change }, request, 'build'), false)
  }
})

test('voxel coordinates retain their position and distinguish unlisted cells from explicit air', () => {
  const compiled = compileMinecraftVoxels(input)
  assert.deepEqual(compiled.entries.map(({ index, position }) => [index, position]), [
    [3, [0, 0, 1]], [16, [1, 1, 1]], [23, [2, 1, 3]],
  ])
  assert.equal(compiled.info.unlisted, 21)
  assert.deepEqual(compiled.info.materials, { 'minecraft:gold_block': 1, 'minecraft:cyan_stained_glass': 1, 'minecraft:air': 1 })
  assert.ok(gunzipSync(exportVoxelStructure(compiled)).includes(Buffer.from('minecraft:cyan_stained_glass')))
  for (const [voxels, code] of [
    [[[3, 1, 3, 'brass']], 'voxel-out-of-bounds'],
    [[[0, 1, 3, 'undeclared']], 'unknown-voxel-material'],
    [[[0, 1, 3, 'brass'], [0, 1, 3, 'gap']], 'duplicate-voxel-coordinate'],
  ]) {
    assert.throws(() => compileMinecraftVoxels({ ...input, voxels }), { code })
  }
  assert.throws(() => compileMinecraftVoxels({ ...input, palette: { ...palette, gap: 'minecraft:oak_log[axis=x,axis=y]' } }),
    { code: 'invalid-minecraft-block-state' })
})

test('Sponge data keeps sparse ordering across VarInt palette boundaries', () => {
  const palette = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`m${i}`, `qa:state_${i}`]))
  const voxels = Object.keys(palette).map((key, i) => [i + 2, 0, 0, key])
  const encoded = gunzipSync(exportVoxelSchematic(compileMinecraftVoxels({ version: 1, size: [133, 1, 1], palette, voxels })))
  const dataTag = Buffer.from([7, 0, 4, 68, 97, 116, 97])
  const offset = encoded.indexOf(dataTag) + dataTag.length
  assert.ok(offset >= dataTag.length)
  const data = encoded.subarray(offset + 4, offset + 4 + encoded.readInt32BE(offset))
  assert.deepEqual([...data.subarray(0, 4)], [0, 0, 1, 2])
  assert.deepEqual([...data.subarray(128)], [127, 128, 1, 129, 1, 130, 1, 0])
})

test('legacy Litematica stores directional states as NBT properties', () => {
  const file = gunzipSync(exportLitematica({ width: 1, height: 1, depth: 1, blocks: 'J' }, 'Stair'))
  assert.ok(file.includes(Buffer.from('minecraft:oak_stairs')))
  assert.ok(file.includes(Buffer.from('Properties')))
  assert.ok(file.includes(Buffer.from('facing')))
  assert.ok(file.includes(Buffer.from('east')))
  assert.equal(file.includes(Buffer.from('oak_stairs[')), false)
})

function uints(...values) {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4))
  return bytes
}

function voxChunk(type, content, children = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from(type), uints(content.length, children.length), content, children])
}

function voxFile(...chunks) {
  return Buffer.concat([Buffer.from('VOX '), uints(150), voxChunk('MAIN', Buffer.alloc(0), Buffer.concat(chunks))])
}

const voxSize = voxChunk('SIZE', uints(2, 3, 4))
const voxCells = voxChunk('XYZI', Buffer.concat([uints(2), Buffer.from([1, 2, 3, 1, 0, 0, 1, 255])]))

test('MagicaVoxel coordinates and one-based RGBA indexes map into the schematic palette', () => {
  const rgba = Buffer.alloc(1024)
  rgba.set([10, 20, 30, 255])
  rgba.set([190, 200, 210, 255], 4 * 254)
  const file = voxFile(voxSize, voxCells, voxChunk('RGBA', rgba))
  const palette = { '#0A141E': 'minecraft:deepslate_tiles', '#bec8d2': 'minecraft:calcite' }
  const { source, blueprint } = compileMagicaVoxel(file, { palette })
  assert.deepEqual(blueprint.size, [2, 4, 3])
  assert.deepEqual(source.colorsToBlocks, { '#0a141e': 'minecraft:deepslate_tiles', '#bec8d2': 'minecraft:calcite' })
  assert.deepEqual(blueprint.entries.map(({ position }) => position), [[0, 1, 2], [1, 3, 0]])
  const positiveZ = compileMagicaVoxel(file, { depthAsZ: true })
  assert.deepEqual(positiveZ.blueprint.entries.map(({ position }) => position), [[0, 1, 0], [1, 3, 2]])
  const defaultColors = compileMagicaVoxel(voxFile(voxSize, voxCells)).source.colorsToBlocks
  assert.deepEqual(Object.keys(defaultColors), ['#111111', '#ffffff'])
  assert.throws(() => compileMagicaVoxel(file, { palette: { '#0a141e': 'minecraft:void_air' } }), { code: 'invalid-vox-palette' })
  assert.throws(() => compileMagicaVoxel(file.subarray(0, -1)), { code: 'invalid-vox-chunks' })
  assert.throws(() => compileMagicaVoxel(voxFile(voxChunk('PACK', uints(2)), voxSize, voxCells)), { code: 'unsupported-vox-scene' })
})
