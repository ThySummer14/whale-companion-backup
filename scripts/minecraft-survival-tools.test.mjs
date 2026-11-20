import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { DeviceAuthError } from '../src/host/devices.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

test('an exact log request still requires nearby natural leaves and confirms the selected block', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-exact-log-'))
  const previous = process.env.COMPANION_MC_DATA_DIR
  process.env.COMPANION_MC_DATA_DIR = dir
  const world = new CbiWorld()
  if (previous === undefined) delete process.env.COMPANION_MC_DATA_DIR
  else process.env.COMPANION_MC_DATA_DIR = previous
  t.after(async () => {
    world.online = false
    await world.close()
    await rm(dir, { recursive: true, force: true })
  })
  world.online = true
  world.positionOf = async () => ({ x: 3, y: 64, z: 7 })
  const target = { x: 4, y: 64, z: 8 }
  let hasLeaves = false
  let broken = false
  const actions = []
  world.cachedPositions = async blocks => {
    assert.ok(blocks.includes('oak_leaves'))
    return hasLeaves ? [{ x: 4, y: 66, z: 8 }] : []
  }
  world.block = async (position, id) => {
    if (id === 'minecraft:oak_leaves[persistent=false]') return hasLeaves
    assert.deepEqual(position, target)
    return id === 'minecraft:oak_log' ? !broken : broken
  }
  world.observe = async () => ({ health: 20, inventory: broken ? [{ name: 'oak_log', count: 1 }] : [] })
  world.startAction = async () => ({ kind: 'dig', controller: new AbortController() })
  world.data = async (_name, path) => path === 'Air' ? 300 : 20
  world.cbi = async command => {
    actions.push(command)
    if (command === 'break 4 64 8') {
      broken = true
      return '[CBI] 开始破坏 4 64 8'
    }
    return ''
  }
  await assert.rejects(world.dig('oak_log', target), /safe-natural-log-not-found/)
  assert.deepEqual(actions, [])
  hasLeaves = true
  const receipt = await world.dig('oak_log', target)
  assert.deepEqual(receipt.target, target)
  assert.equal(receipt.inventoryDelta, 1)
  assert.deepEqual(actions, ['break 4 64 8', 'pickup oak_log', 'stop'])

  const high = { x: 3, y: 70, z: 7 }
  const close = { x: 4, y: 65, z: 7 }
  const stale = { x: 3, y: 64, z: 7 }
  const low = { x: 5, y: 64, z: 7 }
  world.cachedPositions = async () => [high, low, stale, close]
  world.block = async position => position !== stale
  assert.deepEqual((await world.findWood('oak_log', new AbortController().signal, 2)).found, [close, low])
})

test('batch crafting returns only completed recipes when the next recipe runs out of logs', async () => {
  let called = 0
  const service = {
    async action(kind, input) {
      assert.equal(kind, 'craft')
      assert.deepEqual(input, { name: 'oak_planks' })
      if (++called === 3) throw new DeviceAuthError(409, 'craft-insufficient-materials')
      return { task: { id: String(called) }, result: { crafted: true, name: 'oak_planks', count: 4 } }
    },
  }
  const craft = MinecraftService.prototype.modelCraft.bind(service)
  const signal = new AbortController().signal
  await assert.rejects(craft('shield', 2, signal), /craft-batches-planks-only/)
  assert.deepEqual(await craft('oak_planks', 4, signal), {
    name: 'oak_planks', requested: 4, completed: 2, produced: 8, tasks: ['1', '2'], reason: 'craft-insufficient-materials',
  })
  assert.equal(called, 3)
})
