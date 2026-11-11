import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { minecraftCampOffer } from '../src/core/minecraft-supply.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

const bounds = { dimension: 'minecraft:the_nether', x: 18, y: 69, z: -23, radius: 4 }
const zone = { ...bounds, id: 'ebaaeb6b-6659-49cb-a15a-dbe75ea78623' }
const inventory = [
  { name: 'cherry_planks', count: 12 },
  { name: 'oak_planks', count: 5 },
  { name: 'crafting_table', count: 1 },
  { name: 'oak_planks', count: 3 },
]
const safe = {
  online: true, gameMode: 'survival', dimension: zone.dimension,
  position: { x: 18.2, y: 70, z: -22.6 }, health: 16, food: 12, survival: { threat: 'NONE' }, inventory,
}
const offer = { material: 'oak_planks', availableFloor: 8, workbenches: 1 }
const center = { x: 18, y: 69, z: -21 }
const success = {
  ...safe,
  inventory: [{ name: 'cherry_planks', count: 12 }],
  survival: { ...safe.survival, build: 'SUCCEEDED', buildZone: zone.id, buildCenter: '18,69,-21', buildFloor: 8, buildTable: 1 },
}
const signal = () => new AbortController().signal

function fakeWorld(t) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, features: { campBuilding: true }, reflexEnabled: false, botName: 'dafeiyu',
  })
  t.mock.method(world, 'record', () => {})
  t.mock.method(world, 'setReflex', () => assert.fail('Authorized construction cannot re-arm reflexes'))
  t.mock.method(world, 'setActionAutoCraft', () => assert.fail('Autocraft was already disabled'))
  return world
}

test('camp offer selects one complete material stack total in the authorized zone', () => {
  assert.deepEqual(minecraftCampOffer(safe, zone), offer)
  for (const patch of [
    { health: 15 }, { food: 11 }, { action: 'follow' }, { survival: { threat: 'MELEE' } },
    { dimension: 'minecraft:overworld' }, { position: { ...safe.position, x: 23 } },
    { inventory: inventory.filter(item => item.name !== 'crafting_table') },
    { inventory: [
      { name: 'oak_planks', count: 4 }, { name: 'birch_planks', count: 4 }, { name: 'crafting_table', count: 1 },
    ] },
  ]) assert.equal(minecraftCampOffer({ ...safe, ...patch }, zone), undefined)
})

test('guarded CBI camp rechecks inventory in its slot and verifies the full footprint in the zone dimension', async t => {
  const world = fakeWorld(t)
  let before = safe
  let started = false
  t.mock.method(world, 'observeInternal', async () => ({
    ...(started ? success : before), action: world.action?.kind,
  }))
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _completion, guarded, onDispatch) => {
    assert.equal(command, `buildcamp ${zone.id} ${zone.dimension} 18 69 -23 4 oak_planks`)
    assert.equal(world.action.kind, 'build-authorized')
    guarded.throwIfAborted()
    onDispatch()
    started = true
    return `开始营地建造，区域 ${zone.id}，中心 18, 69, -21，材料 oak_planks`
  })
  const blocks = t.mock.method(world, 'block', async (_position, _expected, dimension) => {
    assert.equal(dimension, zone.dimension)
    return true
  })
  const result = await world.buildCamp({ zone, material: offer.material }, signal())
  assert.equal(result.placedFloor, 8)
  assert.equal(result.placedTable, 1)
  assert.deepEqual(result.target, center)
  assert.equal(blocks.mock.callCount(), 9)
  assert.deepEqual(blocks.mock.calls.at(-1).arguments, [
    { x: 18, y: 71, z: -21 }, 'minecraft:crafting_table', zone.dimension,
  ])
  assert.equal(world.action, undefined)
  started = false
  before = { ...safe, health: 15 }
  await assert.rejects(world.buildCamp({ zone, material: offer.material }, signal()), /build-preconditions-changed/u)
  assert.equal(cbi.mock.callCount(), 1)
})

test('cancellation queues one stop before a pending build observation finishes and retains the slot until stop settles', async t => {
  const world = fakeWorld(t)
  const polling = Promise.withResolvers()
  const observation = Promise.withResolvers()
  const stopQueued = Promise.withResolvers()
  const stopAck = Promise.withResolvers()
  let started = false
  let stopCalls = 0
  t.mock.method(world, 'observeInternal', async () => {
    if (!started) return { ...safe, action: world.action.kind }
    polling.resolve()
    return observation.promise
  })
  t.mock.method(world, 'cbi', async (command, _sender, _settle, completion, _guarded, onDispatch) => {
    assert.equal(world.action.kind, 'build-authorized')
    if (command === 'stop') {
      assert.match('[CBI] 已停止当前 cbi 任务', completion)
      stopCalls++
      stopQueued.resolve()
      return stopAck.promise
    }
    onDispatch()
    started = true
    return `开始营地建造，区域 ${zone.id}，中心 18, 69, -21，材料 oak_planks`
  })
  const permit = new AbortController()
  const pending = assert.rejects(world.buildCamp({ zone, material: offer.material }, permit.signal), /build-cancelled/u)
  await polling.promise
  permit.abort()
  await stopQueued.promise
  observation.resolve(success)
  assert.equal(world.action.kind, 'build-authorized')
  await assert.rejects(world.buildCamp({ zone, material: offer.material }, signal()), /action-busy/u)
  stopAck.resolve('[CBI] 已停止当前 cbi 任务')
  await pending
  assert.equal(stopCalls, 1)
  assert.equal(world.action, undefined)
})

test('host accepts only one matching complete child receipt, emits a moment, and rejects a revoked zone', async t => {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/minecraft-camp-host-')
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const permit = store.createBuildZone({ ...bounds, name: 'private-camp' })
  const moments = []
  const cancelled = []
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'owner' },
    undefined, moment => moments.push(moment), zoneId => cancelled.push(zoneId))
  let placedFloor = 8
  const requests = t.mock.method(service, 'request', async (path, _method, input) => {
    if (path === '') return { online: true, auth: { mode: 'cbi' }, capabilities: { campBuilding: true } }
    if (path === '/observe') return safe
    assert.equal(path, '/build-authorized')
    assert.deepEqual(input, { material: offer.material, zone: { ...bounds, id: permit.id } })
    return { built: true, zoneId: permit.id, material: offer.material, placedFloor, placedTable: 1 }
  })
  assert.deepEqual(await service.inspectCampBuild(permit.id, signal()), offer)
  await assert.rejects(service.buildAutonomousCamp(permit.id, 'cherry_planks', signal()), /build-preconditions-changed/u)
  assert.equal(requests.mock.calls.some(call => call.arguments[0] === '/build-authorized'), false)
  const { task } = await service.buildAutonomousCamp(permit.id, offer.material, signal())
  assert.equal(task.status, 'succeeded')
  assert.equal(task.capabilityId, 'minecraft.build')
  assert.equal(moments[0].taskId, task.id)
  assert.equal(store.memory.list({ limit: 10 }).length, 0)
  placedFloor = 7
  await assert.rejects(service.buildAutonomousCamp(permit.id, offer.material, signal()), /build-receipt-unconfirmed/u)
  assert.equal(moments.length, 1)
  assert.equal(await service.revokeBuildZone(permit.id), true)
  assert.deepEqual(cancelled, [permit.id])
  assert.equal(await service.inspectCampBuild(permit.id, signal()), undefined)
})
