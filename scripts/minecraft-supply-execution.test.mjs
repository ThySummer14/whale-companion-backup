import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { minecraftSupplyOffer } from '../src/core/minecraft-supply.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

const bounds = { dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 4 }
const zone = { ...bounds, id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f' }
const inventory = [
  { name: 'cherry_log', count: 10 },
  { name: 'oak_log', count: 3 },
  { name: 'oak_planks', count: 2 },
]
const safe = {
  online: true, gameMode: 'survival', dimension: zone.dimension,
  position: { x: -11.4, y: 70, z: 32 }, health: 16, food: 12, survival: { threat: 'NONE' }, inventory,
}
const offer = { recipe: 'oak_planks', availableLogs: 3, planks: 2 }

test('supply offers only one deterministic plank recipe from an authorized safe position and real stock', () => {
  assert.deepEqual(minecraftSupplyOffer(safe, zone), offer)
  for (const patch of [
    { online: false }, { gameMode: 'creative' }, { health: 15.9 }, { food: 11 },
    { survival: { threat: 'HOSTILE' } }, { dimension: 'minecraft:the_nether' },
    { position: { ...safe.position, x: -16.001 } }, { position: { ...safe.position, y: 73 } },
    { action: 'follow' }, { inventory: [{ name: 'oak_log', count: 2 }, { name: 'cherry_log', count: 2 }] },
    { inventory: [...inventory, { name: 'birch_planks', count: 6 }] },
  ]) assert.equal(minecraftSupplyOffer({ ...safe, ...patch }, zone), undefined)
})

test('CBI supply uses its action slot, confirms four planks and checks cancellation inside the console queue', async t => {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/minecraft-supply-worker-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fifo = join(dir, 'console.in')
  const logPath = join(dir, 'latest.log')
  writeFileSync(fifo, '')
  writeFileSync(logPath, '')
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, features: { crafting: true }, reflexEnabled: false, botName: 'dafeiyu',
    fifo, logPath, commandQueue: Promise.resolve(),
  })
  t.mock.method(world, 'record', () => {})
  t.mock.method(world, 'setReflex', () => assert.fail('Supply cannot re-arm reflexes'))
  let crafted = false
  let current = safe
  t.mock.method(world, 'observeInternal', async () => ({
    ...current,
    action: world.action?.kind,
    inventory: crafted
      ? [{ name: 'oak_log', count: 2 }, { name: 'oak_planks', count: 6 }]
      : current.inventory,
  }))
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _receipt, signal) => {
    assert.equal(world.action.kind, 'supply')
    assert.equal(command, 'craft oak_planks')
    assert.ok(signal)
    signal.throwIfAborted()
    crafted = true
    return '合成完成 oak_planks×4，配方 minecraft:oak_planks，材料 oak_log×1'
  })
  assert.equal((await world.supply({ zone, recipe: offer.recipe }, new AbortController().signal)).count, 4)
  assert.equal(world.action, undefined)
  crafted = false
  current = { ...safe, health: 15 }
  await assert.rejects(world.supply({ zone, recipe: offer.recipe }, new AbortController().signal), /supply-preconditions-changed/u)
  assert.equal(cbi.mock.callCount(), 1)
  const held = Promise.withResolvers()
  world.commandQueue = held.promise
  const cancel = new AbortController()
  const pending = world.send('craft oak_planks', /ok/u, 6000, 0, cancel.signal)
  cancel.abort()
  held.resolve()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(readFileSync(fifo, 'utf8'), '')
})

test('the host rechecks its permit, records verified craft evidence and stops supply authorization on revocation', async t => {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/minecraft-supply-host-')
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const permit = store.createBuildZone({ ...bounds, name: 'private-base' })
  const moments = []
  const cancelled = []
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'owner' },
    undefined, moment => moments.push(moment), zoneId => cancelled.push(zoneId))
  let count = 4
  const calls = t.mock.method(service, 'request', async (path, _method, input) => {
    if (path === '') return { online: true, auth: { mode: 'cbi' }, capabilities: { crafting: true } }
    if (path === '/observe') return safe
    assert.equal(path, '/supply')
    assert.equal(input.zone.id, permit.id)
    assert.equal(input.recipe, 'oak_planks')
    return { crafted: true, name: input.recipe, count }
  })
  const signal = new AbortController().signal
  assert.deepEqual(await service.inspectSupply(permit.id, signal), offer)
  await assert.rejects(service.supply(permit.id, 'cherry_planks', signal), /supply-preconditions-changed/u)
  assert.equal(calls.mock.calls.some(call => call.arguments[0] === '/supply'), false)
  const { task } = await service.supply(permit.id, offer.recipe, signal)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.capabilityId, 'minecraft.craft')
  assert.equal(moments[0].taskId, task.id)
  assert.equal(store.memory.list({ limit: 10 }).length, 0)
  count = 3
  await assert.rejects(service.supply(permit.id, offer.recipe, signal), /supply-receipt-unconfirmed/u)
  assert.equal(moments.length, 1)
  assert.equal(await service.revokeBuildZone(permit.id), true)
  assert.deepEqual(cancelled, [permit.id])
  assert.equal(await service.inspectSupply(permit.id, signal), undefined)
})
