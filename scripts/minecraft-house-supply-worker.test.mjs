import assert from 'node:assert/strict'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { MinecraftHouseSupplyPreview, MinecraftHouseSupplyReceipt, MinecraftHouseSupplyRequest } from '../src/core/minecraft-house-supply.ts'

const zone = { id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 6 }
const layout = { width: 2, depth: 2, height: 2, blocks: 'ooosss..' }
const request = { zone, layout, recipe: 'oak_planks', missing: 2 }
const recipeReceipt = (name = 'oak_planks', logsBefore = 3, planksBefore = 1) => ({
  crafted: true, name, count: 4, consumedLogs: 1,
  inventory: { logsBefore, logsAfter: logsBefore - 1, planksBefore, planksAfter: planksBefore + 4 },
})
const signal = () => new AbortController().signal
const home = { x: -11.5, y: 70, z: 29.5 }

function fixture(t) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, campPaused: false, campEpoch: 0, connectionEpoch: 5, botName: 'dafeiyu',
    features: { houseBuilding: true, houseRecovery: true, crafting: true },
  })
  const state = {
    onGround: 1, motion: '[0.0d, -0.0784000015258789d, 0.0d]', position: { ...home },
    inventory: { oak_log: 3, oak_planks: 1, spruce_log: 3, spruce_planks: 1 },
    gameMode: 'survival', dimension: zone.dimension, health: 20, food: 20, oxygen: 300, threat: 'NONE',
  }
  const calls = [], events = []
  t.mock.method(world, 'record', (kind, data) => events.push({ kind, data }))
  t.mock.method(world, 'captureHouseSession', async () => ({ epoch: world.connectionEpoch, dev: 1, ino: 2, offset: 0 }))
  t.mock.method(world, 'verifyHouseSession', async session => {
    if (world.connectionEpoch !== session.epoch) throw new Error('house-ownership-unconfirmed')
  })
  t.mock.method(world, 'readHouseLayout', async (selected, allowMissing, checkedSignal, guard) => {
    assert.deepEqual(selected.zone, zone)
    assert.deepEqual(selected.layout, layout)
    assert.equal(allowMissing, true)
    checkedSignal.throwIfAborted()
    guard()
    return { oak_planks: 3, spruce_planks: 3 }
  })
  t.mock.method(world, 'readHouseInventory', async (checkedSignal, guard) => {
    checkedSignal.throwIfAborted()
    guard()
    return { oak_planks: state.inventory.oak_planks, spruce_planks: state.inventory.spruce_planks }
  })
  t.mock.method(world, 'readHouseStance', async (dimension, checkedSignal, guard) => {
    assert.equal(dimension, zone.dimension)
    checkedSignal.throwIfAborted()
    guard()
    return { ...state.position }
  })
  t.mock.method(world, 'observeInternal', async () => {
    const inventory = Object.entries(state.inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }))
    state.beforeObservation?.(inventory)
    return { online: world.online, ...state, inventory, survival: { threat: state.threat }, action: world.action?.kind }
  })
  t.mock.method(world, 'data', async (player, field, checkedSignal) => {
    assert.equal(player, 'dafeiyu')
    checkedSignal.throwIfAborted()
    assert.ok(['OnGround', 'Motion'].includes(field))
    return field === 'OnGround' ? state.onGround : state.motion
  })
  t.mock.method(world, 'cbi', async (command, sender, _settle, completion, checkedSignal, guard, anchor) => {
    assert.equal(sender, 'dafeiyu')
    if (command.startsWith('homebuild ')) {
      const [, operation, id, ...args] = command.split(' ')
      assert.ok(['preview', 'recover-preview'].includes(operation))
      assert.deepEqual(args, [zone.id, zone.dimension, '-12', '70', '32', '6', '2', '2', '2', layout.blocks])
      checkedSignal.throwIfAborted()
      guard()
      calls.push(operation)
      const lacksMaterials = state.inventory.oak_planks < 3 || state.inventory.spruce_planks < 3
      const progress = state.housePreview ?? (lacksMaterials
        ? 'phase=failed checked=8 placed=0 reason=homebuild-materials' : 'phase=ready checked=8 placed=0 reason=-')
      return `[10:00:01] [Server thread/INFO]: CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] homebuild id=${id} ${progress}"\n`
    }
    if (command.startsWith('set ')) {
      calls.push(command)
      return `[CBI] survivalAutoCraft = ${command.endsWith('true')}`
    }
    assert.ok(['craft oak_planks', 'craft spruce_planks'].includes(command))
    assert.equal(world.action.kind, 'house-supply')
    assert.deepEqual(anchor, { ...zone, x: -12, y: 70, z: 29 })
    state.beforeDispatch?.()
    checkedSignal.throwIfAborted()
    guard()
    calls.push(command)
    const name = command.split(' ')[1]
    const log = name.replace(/_planks$/u, '_log')
    state.inventory[name] += 4
    state.inventory[log]--
    state.afterDispatch?.()
    const receipt = state.receipt ?? `[10:00:01] [Server thread/INFO]: CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] 合成完成 ${name}×4，配方 minecraft:${name}，材料 minecraft:${log}×1"\n`
    if (!completion.test(receipt)) throw new Error('console-receipt-timeout:execute')
    return receipt
  })
  return { world, state, calls, events, preview: (input = request, abort = signal()) =>
    world.withCampAction(() => world.houseSupplyPreview(input, abort)), craft: (input = request, abort = signal()) =>
    world.withCampAction(() => world.houseSupply(input, abort)) }
}

test('house supply schemas bind the material and missing quantity to the exact section, and verify exact deltas', () => {
  assert.equal(MinecraftHouseSupplyRequest.safeParse(request).success, true)
  assert.equal(MinecraftHouseSupplyRequest.safeParse({ ...request, recovery: true }).success, true)
  for (const invalid of [{ missing: 0 }, { missing: 4 }, { recipe: 'birch_planks' }, { recipe: 'glass' }, { count: 8 }, { recovery: false }]) {
    assert.equal(MinecraftHouseSupplyRequest.safeParse({ ...request, ...invalid }).success, false)
  }
  assert.equal(MinecraftHouseSupplyPreview.safeParse({ ready: true }).success, true)
  assert.equal(MinecraftHouseSupplyPreview.safeParse({ ready: true, inventory: [] }).success, false)
  assert.equal(MinecraftHouseSupplyReceipt.safeParse(recipeReceipt()).success, true)
  assert.equal(MinecraftHouseSupplyReceipt.safeParse(recipeReceipt('spruce_planks', 7, 99)).success, true)
  assert.equal(MinecraftHouseSupplyReceipt.safeParse(recipeReceipt('oak_planks', 2)).success, false)
  assert.equal(MinecraftHouseSupplyReceipt.safeParse({ ...recipeReceipt(), count: 8 }).success, false)
  assert.equal(MinecraftHouseSupplyReceipt.safeParse({
    ...recipeReceipt(), inventory: { ...recipeReceipt().inventory, logsAfter: 1 },
  }).success, false)
})

test('house supply preview is read only and does not publish stocks or reserve an action', async t => {
  const h = fixture(t)
  assert.deepEqual(await h.preview(), { ready: true })
  assert.deepEqual(await h.preview({ ...request, recipe: 'spruce_planks', recovery: true }), { ready: true })
  assert.deepEqual(h.calls, ['preview', 'recover-preview'])
  assert.deepEqual(h.events, [])
  assert.equal(h.world.action, undefined)
})

test('a fresh house supply preflight refuses mismatches and unsafe conditions before crafting', async t => {
  for (const [name, edit] of [
    ['selected shortage is different', h => { h.state.inventory.oak_planks = 2 }],
    ['carried stock changed after the shortage read', h => { h.state.beforeObservation = inventory => { inventory.find(item => item.name === 'oak_planks').count = 2 } }],
    ['only two exact logs remain', h => { h.state.inventory.oak_log = 2 }],
    ['other species do not fill the log reserve', h => { h.state.inventory.oak_log = 0; h.state.inventory.spruce_log = 99 }],
    ['same-species wood is a competing ingredient', h => { h.state.inventory.oak_wood = 1 }],
    ['stripped log is a competing ingredient', h => { h.state.inventory.stripped_oak_log = 1 }],
    ['stripped wood is a competing ingredient', h => { h.state.inventory.stripped_oak_wood = 1 }],
    ['wrong dimension', h => { h.state.dimension = 'minecraft:the_nether' }],
    ['creative mode', h => { h.state.gameMode = 'creative' }],
    ['low health', h => { h.state.health = 15 }],
    ['low food', h => { h.state.food = 11 }],
    ['low oxygen', h => { h.state.oxygen = 199 }],
    ['active threat', h => { h.state.threat = 'HOSTILE' }],
    ['not grounded', h => { h.state.onGround = 0 }],
    ['moving', h => { h.state.motion = '[0.03d,0d,0d]' }],
    ['off center', h => { h.state.position.x += 0.23 }],
    ['outside the child zone', h => { h.state.position.z -= 4 }],
    ['blocked site', h => { h.state.housePreview = 'phase=failed checked=6 placed=0 reason=homebuild-obstructed' }],
    ['no verified shortage', h => { h.state.housePreview = 'phase=ready checked=8 placed=0 reason=-' }],
  ]) await t.test(name, async child => {
    const h = fixture(child)
    edit(h)
    assert.deepEqual(await h.preview(), { ready: false })
    await assert.rejects(h.craft(), /house-supply-preconditions-changed/u)
    assert.ok(!h.calls.some(call => call.startsWith('craft ')))
    assert.ok(!h.events.some(event => event.kind === 'action.finished'))
    assert.equal(h.world.action, undefined)
  })
})

test('the Worker crafts one natural same-species log and validates output, inventory and return', async t => {
  for (const name of ['oak_planks', 'spruce_planks']) await t.test(name, async child => {
    const h = fixture(child)
    const input = { ...request, recipe: name }
    h.world.reflexEnabled = true
    assert.deepEqual(await h.craft(input), recipeReceipt(name))
    assert.deepEqual(h.calls, ['set survivalAutoCraft false', 'preview', `craft ${name}`, 'set survivalAutoCraft true'])
    assert.deepEqual(h.events.find(event => event.kind === 'action.finished')?.data, { kind: 'house-supply', name, count: 4 })
    assert.equal(h.world.action, undefined)
    await assert.rejects(h.craft(input), /house-supply-preconditions-changed/u)
    assert.equal(h.calls.filter(call => call.startsWith('craft ')).length, 1)
  })
})

test('only an anchored craft and matching post-craft evidence can confirm a receipt', async t => {
  for (const [name, edit, error] of [
    ['unattributed console echo', h => { h.state.receipt = '合成完成 oak_planks×4，配方 minecraft:oak_planks，材料 oak_log×1' }],
    ['different player feedback', h => { h.state.receipt = '[10:00:01] [Server thread/INFO]: CBI feedback sender=other target=dafeiyu message="[CBI] 合成完成 oak_planks×4，配方 minecraft:oak_planks，材料 oak_log×1"\n' }],
    ['incorrect recipe', h => { h.state.receipt = '[10:00:01] [Server thread/INFO]: CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] 合成完成 oak_planks×4，配方 minecraft:spruce_planks，材料 oak_log×1"\n' }],
    ['incorrect ingredient', h => { h.state.receipt = '[10:00:01] [Server thread/INFO]: CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] 合成完成 oak_planks×4，配方 minecraft:oak_planks，材料 stripped_oak_log×1"\n' }],
    ['unconfirmed output', h => { h.state.afterDispatch = () => h.state.inventory.oak_planks-- }],
    ['unconfirmed natural log debit', h => { h.state.afterDispatch = () => h.state.inventory.oak_log++ }],
    ['left the original stance', h => { h.state.afterDispatch = () => h.state.position.z++ }, /house-stance-unconfirmed/u],
    ['role changed session before confirmation', h => { h.state.afterDispatch = () => h.world.connectionEpoch++ }, /house-ownership-unconfirmed/u],
  ]) await t.test(name, async child => {
    const h = fixture(child)
    edit(h)
    await assert.rejects(h.craft(), error ?? /house-supply-receipt-unconfirmed/u)
    assert.equal(h.calls.filter(call => call.startsWith('craft ')).length, 1)
    assert.ok(!h.events.some(event => event.kind === 'action.finished'))
    assert.equal(h.world.action, undefined)
  })
})

test('house supply is unavailable during another action, a camp visit, pause, or CBI without crafting', async t => {
  for (const [name, edit, expected] of [
    ['another action', h => { h.world.action = { kind: 'move' } }, /action-busy/u],
    ['short visit', h => { h.world.visit = {} }, /visit-busy/u],
    ['paused', h => { h.world.campPaused = true }, /camp-paused/u],
    ['without crafting', h => { h.world.features.crafting = false }, /house-supply-unavailable/u],
  ]) await t.test(name, async child => {
    const h = fixture(child)
    edit(h)
    await assert.rejects(async () => h.craft(), expected)
    assert.deepEqual(h.calls, [])
  })
})

test('cancel before dispatch keeps inventory and cancel after dispatch cannot claim success', async t => {
  for (const dispatched of [false, true]) await t.test(dispatched ? 'after' : 'before', async child => {
    const h = fixture(child)
    const controller = new AbortController()
    h.state[dispatched ? 'afterDispatch' : 'beforeDispatch'] = () => controller.abort()
    await assert.rejects(h.craft(request, controller.signal), /house-supply-cancelled/u)
    assert.equal(h.calls.filter(call => call.startsWith('craft ')).length, dispatched ? 1 : 0)
    assert.equal(h.state.inventory.oak_log, dispatched ? 2 : 3)
    assert.ok(!h.events.some(event => event.kind === 'action.finished'))
    assert.equal(h.world.action, undefined)
  })
})
