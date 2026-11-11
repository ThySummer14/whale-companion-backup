import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { compileMinecraftHouseFacade, MinecraftHouseDraft, MinecraftHouseLayout, MinecraftHousePreview, MinecraftHouseReceipt,
  MinecraftHouseRequest, MinecraftHouseRevisionInput, minecraftHouseCells, minecraftHouseMaterials, minecraftHouseReceiptMatches } from '../src/core/minecraft-house.ts'
import { CompanionStore } from '../src/core/store.ts'

const layout = { width: 2, height: 2, depth: 2, blocks: 'oscg..o.' }
const zone = { id: randomUUID(), dimension: 'minecraft:overworld', x: 1, y: 70, z: 3, radius: 4 }

test('a blueprint is a strict bounded y,z,x volume with one to 100 solid blocks', () => {
  assert.deepEqual(MinecraftHouseLayout.parse(layout), layout)
  assert.equal(MinecraftHouseLayout.safeParse({ width: 5, height: 5, depth: 5, blocks: 'o'.repeat(100) + '.'.repeat(25) }).success, true)
  for (const change of [{ width: 0 }, { depth: 6 }, { height: 1.5 }, { blocks: '........' }, { blocks: 'oscg..o' },
    { blocks: 'oscg...\n' }, { blocks: 'oscg..oX' }, { filename: 'reference.png' },
    { width: 5, height: 5, depth: 5, blocks: 'o'.repeat(101) + '.'.repeat(24) }]) {
    assert.equal(MinecraftHouseLayout.safeParse({ ...layout, ...change }).success, false, JSON.stringify(change))
  }
  assert.equal(MinecraftHouseRequest.safeParse({ zone: { ...zone, radius: 0 }, layout }).success, false)
})

test('all cells, including declared air, retain exact positions and map to short material names', () => {
  assert.deepEqual(minecraftHouseCells(layout).map(({ x, y, z, block }) => [x, y, z, block]), [
    [0, 0, 0, 'oak_planks'], [1, 0, 0, 'spruce_planks'], [0, 0, 1, 'cobblestone'], [1, 0, 1, 'glass'],
    [0, 1, 0, 'air'], [1, 1, 0, 'air'], [0, 1, 1, 'oak_planks'], [1, 1, 1, 'air'],
  ])
  assert.deepEqual(minecraftHouseMaterials(layout), { oak_planks: 2, spruce_planks: 1, cobblestone: 1, glass: 1 })
})

test('facade compiles exact visible features into a connected shell and retains the full bounded volume', () => {
  const dimensions = { width: 5, height: 5, depth: 5 }
  const facade = { floor: 'c', wall: 'o', roof: 's', doorX: 2, trim: 's', frontTrimColumns: [1], leftTrimColumns: [3],
    frontWindows: [{ x: 1, y: 2 }, { x: 3, y: 1 }], leftWindows: [{ z: 2, y: 3 }] }
  const compiled = MinecraftHouseLayout.parse({ ...dimensions, ...compileMinecraftHouseFacade(dimensions, facade) })
  const cells = minecraftHouseCells(compiled)
  const symbol = (x, y, z) => cells.find(cell => cell.x === x && cell.y === y && cell.z === z).symbol
  assert.equal(cells.length, 125)
  for (const y of [0, 1, 2]) assert.equal(symbol(2, y, 0), '.')
  assert.equal(symbol(2, 3, 0), 'o')
  assert.equal(symbol(1, 1, 0), 's')
  assert.equal(symbol(1, 2, 0), 'g')
  assert.equal(symbol(3, 1, 0), 'g')
  assert.equal(symbol(0, 1, 3), 's')
  assert.equal(symbol(0, 3, 2), 'g')
  assert.equal(symbol(2, 2, 2), '.')
  assert.equal(symbol(2, 0, 2), 'c')
  assert.equal(symbol(2, 4, 2), 's')
  assert.deepEqual(minecraftHouseMaterials(compiled), { cobblestone: 24, oak_planks: 38, spruce_planks: 30, glass: 3 })
  const defaultCorners = compileMinecraftHouseFacade(dimensions, { floor: 'c', wall: 'o', roof: 'o', doorX: 3, trim: 's' })
  assert.equal(defaultCorners.blocks.slice(25, 30), 'soo.s')
})

test('facade rejects out-of-range coordinates, duplicate placements and conflicting features', () => {
  const dimensions = { width: 4, height: 4, depth: 3 }
  const facade = { floor: 'c', wall: 'o', roof: 's', doorX: 1 }
  assert.match(compileMinecraftHouseFacade({ ...dimensions, height: 3 }, facade).error, /height must be 4–5/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, doorX: 0 }).error, /doorX/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, frontTrimColumns: [2] }).error, /require a trim material/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, trim: 'c', frontTrimColumns: [1] }).error, /excluding the door/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, trim: 'c', leftTrimColumns: [1, 1] }).error, /distinct left columns/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, frontWindows: [{ x: 1, y: 2 }] }).error, /window overlaps the door/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, frontWindows: [{ x: 2, y: 3 }] }).error, /y from 1 to 2/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, leftWindows: [{ z: 3, y: 1 }] }).error, /column from 0 to 2/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, leftWindows: [{ z: 2, y: 1 }, { z: 2, y: 1 }] }).error, /window repeats/u)
  const corner = { ...facade, frontWindows: [{ x: 0, y: 2 }], leftWindows: [{ z: 0, y: 2 }] }
  const layout = MinecraftHouseLayout.parse({ ...dimensions, ...compileMinecraftHouseFacade(dimensions, corner) })
  assert.equal(minecraftHouseMaterials(layout).glass, 1)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...corner, leftWindows: [{ z: 0, y: 2 }, { z: 0, y: 2 }] }).error, /on this face/u)
})

test('the stepped facade retains exact roof silhouette, supporting ceiling and usable walls', () => {
  const dimensions = { width: 5, height: 5, depth: 4 }
  const facade = { floor: 'c', wall: 'o', roof: 's', doorX: 2,
    frontWindows: [{ x: 1, y: 2 }], leftWindows: [{ z: 2, y: 1 }] }
  for (const roofProfile of [{ axis: 'x', heights: [3, 3, 4, 3, 3] }, { axis: 'z', heights: [3, 3, 4, 4] }]) {
    const compiled = compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile })
    const layout = MinecraftHouseLayout.parse({ ...dimensions, ...compiled })
    const cells = minecraftHouseCells(layout)
    const at = (x, y, z) => cells[(y * dimensions.depth + z) * dimensions.width + x].symbol
    for (let z = 0; z < dimensions.depth; z++) for (let x = 0; x < dimensions.width; x++) {
      assert.equal(at(x, 3, z), 's')
      assert.equal(at(x, 4, z), roofProfile.heights[roofProfile.axis === 'x' ? x : z] === 4 ? 's' : '.')
    }
    for (let y = 0; y <= 2; y++) assert.equal(at(2, y, 0), '.')
    assert.equal(at(1, 2, 0), 'g')
    assert.equal(at(0, 1, 2), 'g')
    assert.equal(at(2, 1, 2), '.')
    assert.equal(at(2, 2, 2), '.')
    assert.equal(at(2, 0, 2), 'c')
    assert.equal(minecraftHouseMaterials(layout).spruce_planks, roofProfile.axis === 'x' ? 24 : 30)
    assert.equal(minecraftHouseMaterials(layout).glass, 2)
  }
})

test('stepped facades reject unsupported height patterns and windows in roof cells', () => {
  const dimensions = { width: 5, height: 5, depth: 4 }
  const facade = { floor: 'c', wall: 'o', roof: 's', doorX: 2 }
  const roofProfile = { axis: 'x', heights: [3, 3, 4, 3, 3] }
  for (const heights of [[3, 4], [3, 4, 5, 3, 3], [3, 3, 3, 3, 3], [4, 4, 4, 4, 4], [3, 3.5, 4, 3, 3]]) {
    assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile: { ...roofProfile, heights } }).error, /exactly 5/u)
  }
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile: { ...roofProfile, axis: 'z' } }).error, /exactly 4/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile: { ...roofProfile, axis: 'y' } }).error, /choose x or z/u)
  assert.match(compileMinecraftHouseFacade({ ...dimensions, height: 4 }, { ...facade, roofProfile }).error, /height=5/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile, frontWindows: [{ x: 1, y: 3 }] }).error, /y from 1 to 2/u)
  assert.match(compileMinecraftHouseFacade(dimensions, { ...facade, roofProfile, leftWindows: [{ z: 1, y: 3 }] }).error, /y from 1 to 2/u)
})

test('material shortage reports are bounded to distinct real blueprint materials and complete arithmetic', () => {
  const valid = { ready: false, checked: 12, reason: 'homebuild-materials', materials: [
    { material: 'oak_planks', needed: 5, carried: 2, missing: 3 },
    { material: 'glass', needed: 2, carried: 2, missing: 0 },
  ] }
  assert.deepEqual(MinecraftHousePreview.parse(valid), valid)
  const [oak, glass] = valid.materials
  for (const candidate of [
    { ...valid, ready: true },
    { ...valid, reason: 'homebuild-obstructed' },
    { ...valid, checked: 6 },
    { ...valid, materials: [] },
    { ...valid, materials: [oak, oak] },
    { ...valid, materials: [glass] },
    { ...valid, materials: [{ ...oak, material: 'oak_log' }] },
    { ...valid, materials: [{ ...oak, carried: 6 }] },
    { ...valid, materials: [{ ...oak, missing: 2 }] },
    { ...valid, materials: [{ ...oak, needed: 0, carried: 0, missing: 0 }] },
    { ...valid, materials: [{ ...oak, needed: 1.5 }] },
    { ...valid, materials: [{ ...oak, rawInventory: ['minecraft:diamond'] }] },
  ]) assert.equal(MinecraftHousePreview.safeParse(candidate).success, false, JSON.stringify(candidate))
  const { materials, ...legacy } = valid
  assert.deepEqual(MinecraftHousePreview.parse(legacy), legacy)
})

test('preview and receipts preserve readback and material proofs, including a no-op retry', () => {
  assert.equal(MinecraftHousePreview.safeParse({ ready: true, checked: 8 }).success, true)
  assert.equal(MinecraftHousePreview.safeParse({ ready: false, checked: 2, reason: 'homebuild-obstructed' }).success, true)
  for (const invalid of [{ ready: true, checked: 0 }, { ready: true, checked: 8, reason: 'homebuild-obstructed' },
    { ready: false, checked: 1, reason: 'untrusted world location' }, { ready: false, checked: 126 }]) {
    assert.equal(MinecraftHousePreview.safeParse(invalid).success, false)
  }
  const receipt = { built: true, zoneId: zone.id, checked: 8, placed: 2, consumed: { oak_planks: 1, spruce_planks: 1 } }
  const request = MinecraftHouseRequest.parse({ zone, layout })
  for (const candidate of [receipt, { ...receipt, placed: 0, consumed: {} }]) {
    assert.equal(minecraftHouseReceiptMatches(MinecraftHouseReceipt.parse(candidate), request), true)
  }
  for (const candidate of [{ ...receipt, zoneId: randomUUID() }, { ...receipt, checked: 7 },
    { ...receipt, consumed: { spruce_planks: 2 } }]) {
    assert.equal(minecraftHouseReceiptMatches(MinecraftHouseReceipt.parse(candidate), request), false)
  }
  for (const candidate of [{ ...receipt, placed: 3 }, { ...receipt, consumed: { diamond: 2 } }, { ...receipt, checked: 1 }]) {
    assert.equal(MinecraftHouseReceipt.safeParse(candidate).success, false)
  }
})

test('a draft keeps opaque image references and rejects injected paths or receipts', () => {
  const draft = { id: randomUUID(), name: '云杉小屋', layout, createdAt: new Date().toISOString(), status: 'draft',
    reference: { contextId: 'chat.mobile', messageId: 'ref-msg', attachmentId: 'ref-image' } }
  assert.deepEqual(MinecraftHouseDraft.parse(draft), draft)
  assert.equal(MinecraftHouseDraft.safeParse({ ...draft, reference: { ...draft.reference, path: '/private/reference.png' } }).success, false)
  assert.equal(MinecraftHouseDraft.safeParse({ ...draft, receipt: { built: true, checked: 8 } }).success, false)
})

const ownerSource = { sessionId: 'chat-source', messageId: 'owner-message',
  reference: { contextId: 'chat.mobile', messageId: 'owner-message', attachmentId: 'reference-image' } }

function houseStorePath(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'minecraft-house-revision-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'companion.db')
}

test('the revision input accepts only existing palette blocks and a safe expected revision', () => {
  assert.deepEqual(MinecraftHouseRevisionInput.parse({ expectedRevision: 0, blocks: layout.blocks }),
    { expectedRevision: 0, blocks: layout.blocks })
  for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { blocks: 'x' }, { blocks: '' }, { blocks: 'o'.repeat(126) }, { width: 3 }, { attachmentId: 'another-image' }]) {
    assert.equal(MinecraftHouseRevisionInput.safeParse({ expectedRevision: 0, blocks: layout.blocks, ...patch }).success, false)
  }
})

test('revisions preserve the original proposal and reject stale, invalid and interrupted edits', t => {
  const path = houseStorePath(t)
  const store = new CompanionStore(path)
  let draft, revised, restored
  try {
    draft = store.minecraftHouses.create({ name: '旧草案', layout, assumptions: '保留模型原来的说明。' }, ownerSource)
    const { id, createdAt } = draft
    assert.equal(draft.revision, 0)
    assert.deepEqual(store.minecraftHouses.history(id), { revisions: [{ revision: 0, blocks: layout.blocks, createdAt }] })
    assert.equal(store.minecraftHouses.history(randomUUID()), undefined)
    assert.deepEqual(store.minecraftHouses.revise(id, { expectedRevision: 0, blocks: layout.blocks }), draft)
    for (const blocks of ['........', 'oscg..o', 'oscg..oX']) {
      assert.equal(store.minecraftHouses.revise(id, { expectedRevision: 0, blocks }), undefined)
    }

    revised = store.minecraftHouses.revise(id, { expectedRevision: 0, blocks: 'oscg..og' })
    assert.deepEqual(revised, { ...draft, layout: { ...layout, blocks: 'oscg..og' }, revision: 1 })
    assert.deepEqual(store.minecraftHouses.create({ name: '不能覆盖', layout }, ownerSource), revised)
    const other = new CompanionStore(path)
    try {
      assert.equal(other.minecraftHouses.revise(id, { expectedRevision: 0, blocks: revised.layout.blocks }), undefined)
      assert.throws(() => other.transaction(() => {
        assert.equal(other.minecraftHouses.revise(id, { expectedRevision: 1, blocks: 'oscg..oo' }).revision, 2)
        throw new Error('rollback')
      }), /rollback/u)
      assert.deepEqual(store.minecraftHouses.get(id), revised)
      assert.deepEqual(store.minecraftHouses.history(id).revisions.map(value => value.revision), [1, 0])
      restored = other.minecraftHouses.revise(id, { expectedRevision: 1, blocks: layout.blocks })
      assert.equal(restored.revision, 2)
    } finally { other.close() }

    const target = store.createBuildZone({ name: '授权地块', dimension: zone.dimension, x: zone.x, y: zone.y, z: zone.z, radius: zone.radius })
    const task = store.createTask({ capabilityId: 'minecraft.house', title: '第一轮施工' })
    assert.equal(store.minecraftHouses.start(id, target.id, task.id, 0), false)
    assert.equal(store.minecraftHouses.start(id, target.id, task.id, 2), true)
    assert.equal(store.minecraftHouses.revise(id, { expectedRevision: 2, blocks: revised.layout.blocks }), undefined)
    assert.equal(store.minecraftHouses.finish(id, task.id), true)
    assert.equal(store.minecraftHouses.revise(id, { expectedRevision: 2, blocks: revised.layout.blocks }), undefined)
    assert.equal(store.minecraftHouses.get(id).status, 'interrupted')
    const retry = store.createTask({ capabilityId: 'minecraft.house', title: '恢复施工' })
    assert.equal(store.minecraftHouses.start(id, target.id, retry.id, 1), false)
    assert.equal(store.minecraftHouses.start(id, target.id, retry.id, 2), true)
    const receipt = { built: true, zoneId: target.id, checked: 8, placed: 0, consumed: {} }
    assert.equal(store.minecraftHouses.finish(id, retry.id, receipt), true)
    assert.equal(store.minecraftHouses.revise(id, { expectedRevision: 2, blocks: revised.layout.blocks }), undefined)
    assert.deepEqual(store.minecraftHouses.byBuildTask(retry.id), { ...restored, zoneId: target.id, status: 'built', receipt })
  } finally { store.close() }

  const reopened = new CompanionStore(path)
  try {
    assert.deepEqual(reopened.minecraftHouses.history(draft.id).revisions.map(({ revision, blocks }) => [revision, blocks]),
      [[2, layout.blocks], [1, revised.layout.blocks], [0, layout.blocks]])
    assert.equal(reopened.minecraftHouses.get(draft.id).revision, restored.revision)
  } finally { reopened.close() }
})

test('v36 drafts migrate without rewriting their original payload, source or build status', t => {
  const path = houseStorePath(t)
  const store = new CompanionStore(path)
  const draft = store.minecraftHouses.create({ name: '旧数据库草案', layout }, ownerSource)
  store.close()

  const prior = new DatabaseSync(path)
  let snapshot
  try {
    // Move the empty table aside to represent the v36 schema without deleting any fixture data.
    prior.exec('ALTER TABLE minecraft_house_revision RENAME TO fixture_empty_history; PRAGMA user_version=36;')
    snapshot = prior.prepare('SELECT * FROM minecraft_house WHERE id=?').get(draft.id)
  } finally { prior.close() }

  const upgraded = new CompanionStore(path)
  try {
    assert.deepEqual(upgraded.minecraftHouses.get(draft.id), draft)
    assert.deepEqual(upgraded.minecraftHouses.history(draft.id), { revisions: [{ revision: 0, blocks: layout.blocks, createdAt: draft.createdAt }] })
  } finally { upgraded.close() }

  const after = new DatabaseSync(path, { readOnly: true })
  try {
    assert.deepEqual(after.prepare('SELECT * FROM minecraft_house WHERE id=?').get(draft.id), snapshot)
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM minecraft_house_revision').get().count, 0)
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 44)
    assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { after.close() }
})
