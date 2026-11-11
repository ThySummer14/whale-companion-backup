import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

const bounds = { dimension: 'minecraft:overworld', x: 18, y: 69, z: -23, radius: 4 }

function fixture(t, items) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/minecraft-camp-preparation-host-')
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const permit = store.createBuildZone({ ...bounds, name: 'test-base' })
  const zone = { ...bounds, id: permit.id }
  const inventory = new Map(Object.entries(items))
  const moments = []
  const steps = []
  const operations = []
  const craftReceipt = { crafted: true, count: 4, consumedLogs: 1 }
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'owner' },
    undefined, moment => moments.push(moment))
  const options = {
    signal: new AbortController().signal,
    checkPermit: () => {},
    onStep(step) {
      assert.equal(store.taskById(step.taskId)?.status, 'succeeded')
      steps.push(step)
    },
  }
  t.mock.method(service, 'request', async (path, method, input) => {
    if (path === '') {
      return { online: true, auth: { mode: 'cbi' }, capabilities: { crafting: true, campBuilding: true } }
    }
    operations.push(path)
    if (path === '/observe') {
      return {
        online: true, gameMode: 'survival', dimension: bounds.dimension, position: bounds,
        health: 20, food: 20, survival: { threat: 'NONE' },
        inventory: [...inventory].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
      }
    }
    assert.equal(method, 'POST')
    assert.deepEqual(input.zone, zone)
    if (path === '/camp-supply') {
      const log = input.recipe.replace(/_planks$/u, '_log')
      inventory.set(log, inventory.get(log) - 1)
      inventory.set(input.recipe, (inventory.get(input.recipe) ?? 0) + 4)
      return { ...craftReceipt, name: input.recipe }
    }
    assert.equal(path, '/build-authorized')
    assert.equal(input.prepare, true)
    assert.ok(inventory.get(input.material) >= 8)
    assert.ok(inventory.get('crafting_table') >= 1)
    return { built: true, zoneId: zone.id, material: input.material, placedFloor: 8, placedTable: 1 }
  })
  const inspect = () => service.inspectCampPreparation(zone.id, options.signal)
  const run = offer => service.prepareAutonomousCamp(zone.id, offer, options)
  return { store, zone, inventory, moments, steps, operations, craftReceipt, options, inspect, run }
}

test('an authorized plan confirms two plank batches and one build from fresh stock', async t => {
  const h = fixture(t, { oak_log: 4, cherry_planks: 4, crafting_table: 1 })
  const offer = await h.inspect()
  assert.deepEqual(offer, { material: 'oak_planks', batches: 2, availableFloor: 0 })
  h.operations.length = 0
  const receipt = await h.run(offer)
  assert.equal(receipt.task.status, 'succeeded')
  assert.equal(receipt.result.material, 'oak_planks')
  assert.equal(h.inventory.get('oak_log'), 2)
  assert.deepEqual(h.operations, ['/observe', '/camp-supply', '/observe', '/camp-supply', '/observe', '/build-authorized'])
  assert.deepEqual(h.steps.map(step => step.action), ['craft', 'craft', 'build'])
  assert.deepEqual(h.moments.map(moment => moment.taskId), [receipt.task.id])
  assert.deepEqual(h.store.memory.list({ limit: 10 }), [])
})

test('a fully stocked plan goes straight to construction and keeps the offered wood', async t => {
  const h = fixture(t, { cherry_planks: 8, crafting_table: 1 })
  const offer = await h.inspect()
  assert.deepEqual(offer, { material: 'cherry_planks', batches: 0, availableFloor: 8 })
  h.inventory.set('oak_planks', 16)
  h.operations.length = 0
  const receipt = await h.run(offer)
  assert.equal(receipt.result.material, 'cherry_planks')
  assert.deepEqual(h.operations, ['/observe', '/build-authorized'])
  assert.deepEqual(h.steps, [{ action: 'build', taskId: receipt.task.id }])
})

test('a stock change cannot expand the approved budget or discard confirmed progress', async t => {
  const h = fixture(t, { oak_log: 5, oak_planks: 4, crafting_table: 1 })
  const offer = await h.inspect()
  assert.equal(offer.batches, 1)
  const persist = h.options.onStep
  h.options.onStep = step => {
    persist(step)
    h.inventory.set('oak_planks', 4)
  }
  h.operations.length = 0
  await assert.rejects(h.run(offer), /prepare-preconditions-changed/u)
  assert.deepEqual(h.operations, ['/observe', '/camp-supply', '/observe'])
  assert.deepEqual(h.steps.map(step => step.action), ['craft'])
  assert.equal(h.moments.length, 0)
})

test('a permit change after the observation prevents the next console action', async t => {
  const h = fixture(t, { oak_planks: 8, crafting_table: 1 })
  const offer = await h.inspect()
  h.operations.length = 0
  h.options.checkPermit = () => {
    if (h.operations.length) throw new Error('permit-revoked')
  }
  await assert.rejects(h.run(offer), /permit-revoked/u)
  assert.deepEqual(h.operations, ['/observe'])
  assert.deepEqual(h.steps, [])
})

test('an unconfirmed log debit does not become a successful step or trigger construction', async t => {
  const h = fixture(t, { oak_log: 4, crafting_table: 1 })
  const offer = await h.inspect()
  h.craftReceipt.consumedLogs = 0
  h.operations.length = 0
  await assert.rejects(h.run(offer), /supply-receipt-unconfirmed/u)
  assert.deepEqual(h.operations, ['/observe', '/camp-supply'])
  assert.deepEqual(h.steps, [])
  assert.equal(h.store.tasks().find(task => task.capabilityId === 'minecraft.craft')?.status, 'failed')
})
