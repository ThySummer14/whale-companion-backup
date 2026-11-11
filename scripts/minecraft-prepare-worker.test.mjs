import assert from 'node:assert/strict'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { MinecraftAuthorizedCampRequest, MinecraftSupplyRequest, minecraftPrepareOffer } from '../src/core/minecraft-supply.ts'

const zone = {
  id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 4,
}
const stock = (name, count) => ({ name, count })
const table = stock('crafting_table', 1)
const observation = inventory => ({
  online: true, gameMode: 'survival', dimension: zone.dimension, position: { x: -11.5, y: 70, z: 32 },
  health: 16, food: 12, survival: { threat: 'NONE' }, inventory,
})

function fakeWorld(t, features) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, features, reflexEnabled: false, botName: 'dafeiyu',
  })
  t.mock.method(world, 'record', () => {})
  t.mock.method(world, 'setReflex', () => assert.fail('Authorized preparation cannot re-arm reflexes'))
  return world
}

test('preparation picks the fewest plank batches while preserving the selected species reserve', () => {
  const mixed = observation([table, stock('oak_planks', 3), stock('oak_log', 4), stock('cherry_planks', 4), stock('cherry_log', 3)])
  assert.deepEqual(minecraftPrepareOffer(mixed, zone), { material: 'cherry_planks', batches: 1, availableFloor: 4 })
  assert.deepEqual(minecraftPrepareOffer(mixed, zone, 'oak_planks'), { material: 'oak_planks', batches: 2, availableFloor: 3 })
  assert.deepEqual(minecraftPrepareOffer(observation([table, stock('oak_planks', 8)]), zone), { material: 'oak_planks', batches: 0, availableFloor: 8 })
  assert.equal(minecraftPrepareOffer(observation([table, stock('oak_planks', 3), stock('oak_log', 3)]), zone), undefined)
  assert.equal(minecraftPrepareOffer(observation([stock('oak_planks', 8)]), zone), undefined)
  assert.equal(minecraftPrepareOffer({ ...mixed, action: 'follow' }, zone), undefined)
  assert.equal(minecraftPrepareOffer({ ...mixed, dimension: 'minecraft:the_nether' }, zone), undefined)
  assert.equal(minecraftPrepareOffer(mixed, zone, 'stone'), undefined)
})

test('worker camp supply checks the locked species and verifies exactly four planks and one log', async t => {
  const world = fakeWorld(t, { crafting: true })
  let crafted = false
  let logsAfter = 3
  let planksBefore = 2
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _receipt, signal) => {
    assert.equal(world.action.kind, 'supply')
    assert.equal(command, 'craft cherry_planks')
    signal.throwIfAborted()
    crafted = true
    return '合成完成 cherry_planks×4，配方 minecraft:cherry_planks，材料 cherry_log×1'
  })
  t.mock.method(world, 'observeInternal', async () => ({
    ...observation([
      table, stock('oak_planks', 12), stock('cherry_planks', planksBefore + (crafted ? 4 : 0)),
      stock('cherry_log', crafted ? logsAfter : 4),
    ]),
    action: world.action.kind,
  }))
  const input = { zone, recipe: 'cherry_planks' }
  const signal = new AbortController().signal
  await assert.rejects(world.supply(input, signal), /supply-preconditions-changed/u)
  assert.equal(cbi.mock.callCount(), 0)
  const receipt = await world.supply(input, signal, true)
  assert.equal(receipt.crafted, true)
  assert.equal(receipt.name, input.recipe)
  assert.equal(receipt.count, 4)
  assert.equal(receipt.consumedLogs, 1)
  assert.equal(world.action, undefined)

  crafted = false
  logsAfter = 4
  await assert.rejects(world.supply(input, signal, true), /craft-log-inventory-unconfirmed/u)
  assert.equal(world.action, undefined)
  crafted = false
  planksBefore = 8
  await assert.rejects(world.supply(input, signal, true), /supply-preconditions-changed/u)
  assert.equal(cbi.mock.callCount(), 2)
  assert.equal(MinecraftSupplyRequest.safeParse({ ...input, prepare: true }).success, false)
})

test('prepared camp construction respects the locked material even when an earlier wood is also ready', async t => {
  const world = fakeWorld(t, { campBuilding: true })
  let started = false
  const safe = observation([table, stock('oak_planks', 12), stock('cherry_planks', 8)])
  t.mock.method(world, 'observeInternal', async () => ({
    ...safe,
    action: world.action.kind,
    ...(started && {
      inventory: [stock('oak_planks', 12)],
      survival: { threat: 'NONE', build: 'SUCCEEDED', buildZone: zone.id, buildCenter: '-12,70,32', buildFloor: 8, buildTable: 1 },
    }),
  }))
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _receipt, _signal, onDispatch) => {
    assert.match(command, / cherry_planks$/u)
    onDispatch()
    started = true
    return `开始营地建造，区域 ${zone.id}，中心 -12, 70, 32，材料 cherry_planks`
  })
  const blocks = t.mock.method(world, 'block', async (_position, expected, dimension) => {
    assert.equal(dimension, zone.dimension)
    assert.ok(['minecraft:cherry_planks', 'minecraft:crafting_table'].includes(expected))
    return true
  })
  const input = { zone, material: 'cherry_planks' }
  const signal = new AbortController().signal
  assert.equal(MinecraftAuthorizedCampRequest.safeParse({ ...input, prepare: false }).success, false)
  await assert.rejects(world.buildCamp(input, signal), /build-preconditions-changed/u)
  assert.equal(cbi.mock.callCount(), 0)
  const receipt = await world.buildCamp({ ...input, prepare: true }, signal)
  assert.equal(receipt.placedFloor, 8)
  assert.equal(receipt.placedTable, 1)
  assert.equal(blocks.mock.callCount(), 9)
  assert.equal(world.action, undefined)
})
