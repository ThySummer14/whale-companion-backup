import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { minecraftOvoDimension } from '../src/core/minecraft-ovo.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { registerMinecraftTools } from '../src/host/minecraft-tools.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const signal = () => new AbortController().signal

function fixture(t) {
  const directory = mkdtempSync('.work/minecraft-ovo-')
  const store = new CompanionStore(join(directory, 'companion.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const zone = store.createBuildZone({ name: 'OVO 工作区', dimension: 'minecraft:overworld', x: 112, y: 80, z: 112, radius: 8 })
  const position = { x: zone.x, y: zone.y, z: zone.z }
  const state = { storageAvailable: true, calls: [], phase: 'start' }
  const service = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'fixture-owner' })
  service.ready = true
  service.request = async (path, _method, input) => {
    state.calls.push({ path, input })
    if (path === '') return { online: true, capabilities: { ovoStorage: state.storageAvailable, ovoSmelting: state.storageAvailable } }
    if (path === '/observe') return { online: true, gameMode: 'survival', dimension: 'overworld', position,
      health: 20, food: 20, oxygen: 300 }
    if (path === '/storage') return { zoneId: zone.id, operation: input.operation, itemName: input.itemName, count: input.count,
      position, inventoryDelta: input.operation === 'deposit' ? -input.count : input.count,
      chestDelta: input.operation === 'deposit' ? input.count : -input.count }
    if (path === '/smelt') return { zoneId: zone.id, phase: input.phase, itemName: input.itemName, count: input.count,
      output: 'glass', position, inventoryDelta: input.phase === 'start' ? -input.count : input.count }
    if (path === '/stop') return {}
    assert.fail('unexpected Worker path: ' + path)
  }
  return { store, service, zone, state, position }
}

test('OVO dimension names are normalized across the CBI and Mineflayer boundaries', () => {
  assert.equal(minecraftOvoDimension('minecraft:overworld'), 'overworld')
  assert.equal(minecraftOvoDimension('overworld'), 'overworld')
  assert.equal(minecraftOvoDimension('minecraft:the_nether'), 'the_nether')
})

test('host accepts exact storage receipts and records the actual inventory exchange', async t => {
  const h = fixture(t)
  const { task, result } = await h.service.ovoStorage(h.zone.id, 'deposit', 'oak_planks', 4, signal())
  assert.equal(task.status, 'succeeded')
  assert.equal(task.capabilityId, 'minecraft.storage')
  assert.equal(result.inventoryDelta, -4)
  assert.equal(result.chestDelta, 4)
  assert.match(h.store.memory.list()[0].content, /存入 4 个 oak_planks.*双向核对/u)
  assert.equal(h.state.calls.at(-1).path, '/storage')
  assert.equal(h.state.calls.at(-1).input.zone.dimension, 'minecraft:overworld')
  const withdrawn = await h.service.ovoStorage(h.zone.id, 'withdraw', 'oak_planks', 2, signal())
  assert.equal(withdrawn.result.inventoryDelta, 2)
  assert.equal(withdrawn.result.chestDelta, -2)
})

test('smelting separates input and collection, and rejects an inconsistent receipt', async t => {
  const h = fixture(t)
  const started = await h.service.ovoSmelt(h.zone.id, 'start', 'sand', 1, signal())
  assert.equal(started.result.phase, 'start')
  assert.equal(started.result.inventoryDelta, -1)
  assert.match(h.store.memory.list()[0].content, /投入 1 个 sand.*等待后续取出成品/u)
  const collected = await h.service.ovoSmelt(h.zone.id, 'collect', 'sand', 1, signal())
  assert.equal(collected.result.phase, 'collect')
  assert.equal(collected.result.inventoryDelta, 1)
  assert.match(h.store.memory.list()[0].content, /同一熔炉取出 1 个 glass/u)
  const request = h.service.request
  h.service.request = async (path, method, input) => path === '/storage'
    ? { zoneId: h.zone.id, operation: 'deposit', itemName: 'oak_planks', count: 4,
      position: h.position, inventoryDelta: -3, chestDelta: 3 }
    : request(path, method, input)
  await assert.rejects(h.service.ovoStorage(h.zone.id, 'deposit', 'oak_planks', 4, signal()), { code: 'minecraft-storage-receipt-unconfirmed' })
  assert.equal(h.store.memory.list().length, 2)
  h.state.storageAvailable = false
  await assert.rejects(h.service.ovoStorage(h.zone.id, 'deposit', 'oak_planks', 4, signal()), { code: 'minecraft-ovo-unavailable' })
  await h.service.revokeBuildZone(h.zone.id)
  await assert.rejects(h.service.ovoStorage(h.zone.id, 'deposit', 'oak_planks', 4, signal()), { code: 'minecraft-ovo-unavailable' })
})

test('OVO tools require the live game root and expose only bounded receipts', async t => {
  const h = fixture(t)
  const agent = { id: 'game-root', session: { header: {} } }
  h.store.bindContext({ contextId: 'game.minecraft', sessionId: agent.id, kind: 'game', label: '游戏' })
  const tools = new Map()
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => undefined },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  t.after(registerMinecraftTools(ctx, { store: h.store, minecraft: h.service }))
  assert.ok(companionToolPolicy('game.minecraft', 'game', false).allowed.some(tool => tool.name === 'mc_storage'))
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes('mc_smelt'))
  const execute = (name, args, caller = agent) => tools.get(name).execute(args, { agent: caller, signal: signal() })
  const before = h.state.calls.length
  await assert.rejects(execute('mc_storage', { zoneId: h.zone.id, operation: 'deposit', itemName: 'oak_planks', count: 2 }, null), /require the game.minecraft session/u)
  await assert.rejects(execute('mc_smelt', { zoneId: h.zone.id, phase: 'start', itemName: 'sand', count: 1 }, { ...agent }), /live Minecraft root session/u)
  assert.equal(h.state.calls.length, before)
  const status = JSON.parse(await execute('mc_status', { section: 'overview' }))
  assert.equal(status.ovoStorage, true)
  assert.equal(status.ovoSmelting, true)
  const stored = JSON.parse(await execute('mc_storage', { zoneId: h.zone.id, operation: 'deposit', itemName: 'oak_planks', count: 2 }))
  assert.equal(stored.receipt.inventoryDelta, -2)
  assert.equal(stored.receipt.chestDelta, 2)
  assert.equal(stored.receipt.zoneId, h.zone.id)
  const started = JSON.parse(await execute('mc_smelt', { zoneId: h.zone.id, phase: 'start', itemName: 'sand', count: 1 }))
  assert.equal(started.receipt.phase, 'start')
  const collected = JSON.parse(await execute('mc_smelt', { zoneId: h.zone.id, phase: 'collect', itemName: 'sand', count: 1 }))
  assert.equal(collected.receipt.phase, 'collect')
  assert.equal(collected.receipt.output, 'glass')
  agent.session.header.origin = 'subagent'
  await assert.rejects(execute('mc_smelt', { zoneId: h.zone.id, phase: 'start', itemName: 'sand', count: 1 }), /live Minecraft root session/u)
})
