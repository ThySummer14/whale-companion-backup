import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { minecraftHouseCells } from '../src/core/minecraft-house.ts'
import { MinecraftHouseCellCandidates, MinecraftHouseCellReceipt, MinecraftHouseCellRequest, minecraftHouseCandidatesMatch, minecraftHouseCellMatches } from '../src/core/minecraft-house-cell.ts'
import { HouseRecoveryCompletionResult, MinecraftHouseVerification, minecraftHouseVerificationMatches } from '../src/core/minecraft-house-verification.ts'

const zone = { id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 6 }
const layout = { width: 2, height: 2, depth: 2, blocks: 'oc..sg..' }
const request = { zone, layout }
const signal = () => new AbortController().signal
const feedback = (id, phase, checked, placed, reason = '-', player = 'dafeiyu') =>
  `[10:00:01] [Server thread/INFO]: CBI feedback sender=${player} target=dafeiyu message="[CBI] homebuild id=${id} phase=${phase} checked=${checked} placed=${placed} reason=${reason}"\n`
const points = minecraftHouseCells(layout).map(({ x, y, z, block }) => ({ key: [zone.x - 1 + x, zone.y + y, zone.z - 1 + z].join(','), block }))

function fixture(t, expectedLayout = layout) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, campPaused: false, campEpoch: 0, connectionEpoch: 5, botName: 'dafeiyu', features: { houseBuilding: true, houseCellPlacement: true }, avoidTargets: new Set(),
  })
  const events = []
  const blocks = new Map()
  const inventory = { oak_planks: 5, spruce_planks: 5, cobblestone: 5, glass: 5 }
  const behavior = { operations: [], checked: expectedLayout.blocks.length, preview: 'ready', previewReason: 'site-obstructed', blockReads: 0, inventoryReads: 0,
    stance: '-11.5d, 70.0d, 29.5d', stanceReads: 0 }
  t.mock.method(world, 'record', (event, data) => events.push({ event, ...data }))
  t.mock.method(world, 'captureHouseSession', async () => ({ epoch: world.connectionEpoch, dev: 1, ino: 2, offset: 0 }))
  t.mock.method(world, 'verifyHouseSession', async session => {
    if (world.connectionEpoch !== session.epoch) throw new Error('house-ownership-unconfirmed')
  })
  t.mock.method(world, 'block', async ({ x, y, z }, expected, dimension, _signal, guard) => {
    assert.equal(dimension, zone.dimension)
    guard?.()
    behavior.blockReads++
    await behavior.afterBlockRead?.()
    return `minecraft:${blocks.get([x, y, z].join(',')) ?? 'air'}` === expected
  })
  t.mock.method(world, 'send', async (command, _completion, _timeout, _settle, _signal, guard) => {
    if (command.endsWith(' run data get entity dafeiyu UUID')) {
      guard?.()
      await behavior.beforeHouseSnapshot?.()
      const [header, ...conditions] = command.split(' if block ')
      const origin = header.match(/^execute in minecraft:overworld positioned (-?\d+) (-?\d+) (-?\d+)$/u)?.slice(1).map(Number)
      assert.ok(origin)
      assert.equal(conditions.length, expectedLayout.blocks.length)
      behavior.snapshotCommand = command
      for (const condition of conditions) {
        const [x, y, z, material] = condition.split(' ')
        const pos = [x, y, z].map((coordinate, index) => origin[index] + Number(coordinate.slice(1)))
        if ((blocks.get(pos.join(',')) ?? 'air') !== material) throw new Error('console-receipt-timeout:execute')
      }
      return behavior.houseSnapshotReceipt ?? '[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [I; -1, 2, 3, 4]\n'
    }
    if (command === 'execute as dafeiyu at @s if dimension minecraft:overworld run data get entity @s Pos') {
      guard?.()
      behavior.stanceReads++
      if (behavior.stanceReadMissing) throw new Error('console-receipt-timeout:execute')
      return (behavior.interleavedReads ? '[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: []\n' : '') +
        `[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [${behavior.stance}]\n`
    }
    assert.equal(command, 'data get entity dafeiyu Inventory')
    guard?.()
    behavior.inventoryReads++
    await behavior.afterInventoryRead?.()
    if (behavior.inventoryLine) return behavior.inventoryLine
    const values = Object.entries(inventory).filter(([, count]) => count > 0).map(([material, count]) => `{id: "minecraft:${material}", count: ${count}}`)
    return (behavior.interleavedReads ? '[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [-11.5d, 70.0d, 29.5d]\n' : '') +
      `[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [${values.join(', ')}]\n`
  })
  let expectedId, selectedIndex
  t.mock.method(world, 'cbi', async (command, sender, _settle, _completion, requestSignal, guard) => {
    assert.equal(sender, 'dafeiyu')
    requestSignal?.throwIfAborted()
    guard?.()
    const [name, operation, id, ...rest] = command.split(' ')
    assert.equal(name, 'homebuild')
    assert.match(id, /^[0-9a-f]{24}$/u)
    const preview = operation === 'preview' || operation === 'recover-preview'
    const fullRun = operation === 'run' || operation === 'recover'
    if (preview || operation === 'runone') {
      expectedId = id
      selectedIndex = operation === 'runone' ? Number(rest.at(-1)) : undefined
    }
    assert.equal(id, expectedId)
    behavior.operations.push({ operation, id })
    if (preview || fullRun || operation === 'runone') {
      assert.deepEqual(rest, [zone.id, zone.dimension, '-12', '70', '32', '6', String(expectedLayout.width), String(expectedLayout.height), String(expectedLayout.depth), expectedLayout.blocks,
        ...(selectedIndex === undefined ? [] : [String(selectedIndex)])])
    }
    if (preview) return behavior.previewLine?.(id) ?? feedback(id, behavior.preview, behavior.checked, 0,
      behavior.preview === 'ready' ? '-' : behavior.previewReason)
    if (fullRun) return feedback(id, 'building', layout.blocks.length, 0)
    if (operation === 'runone') return behavior.startCell?.(id, selectedIndex) ?? feedback(id, 'building', 1, 0)
    if (operation === 'cancel') return feedback(id, 'cancelled', layout.blocks.length, 0, 'house-cancelled')
    if (behavior.status) return behavior.status(id)
    let placed = 0
    for (const point of selectedIndex === undefined ? points : [points[selectedIndex]]) {
      if (point.block === 'air' || blocks.get(point.key) === point.block) continue
      blocks.set(point.key, point.block)
      inventory[point.block]--
      placed++
    }
    behavior.afterBuild?.()
    return feedback(id, 'succeeded', behavior.completeChecked ?? (selectedIndex === undefined ? layout.blocks.length : 1), behavior.completePlaced ?? placed)
  })
  return { world, blocks, inventory, behavior, events }
}

test('whole-house verification requires two anchored CBI previews around independently matched blocks and reserved air', async t => {
  const { world, blocks, inventory, behavior, events } = fixture(t)
  for (const point of points) blocks.set(point.key, point.block === 'air' ? 'cave_air' : point.block)
  const oldBlocks = new Map(blocks)
  const result = await world.withCampAction(() => world.verifyHouse(request, signal()))
  assert.deepEqual(result, { checked: 8, matched: 8, missing: 0, blocked: 0, issues: [] })
  assert.equal(minecraftHouseVerificationMatches(result, request), true)
  assert.deepEqual(behavior.operations.map(({ operation }) => operation), ['preview', 'preview'])
  assert.equal(new Set(behavior.operations.map(({ id }) => id)).size, 2)
  assert.equal(behavior.blockReads, 12)
  assert.ok(behavior.snapshotCommand.includes(' if block ~ ~ ~1 cave_air '))
  assert.equal(behavior.inventoryReads, 0)
  assert.deepEqual(blocks, oldBlocks)
  assert.deepEqual(inventory, { oak_planks: 5, spruce_planks: 5, cobblestone: 5, glass: 5 })
  assert.deepEqual(events, [])
})

test('whole-house verification distinguishes missing blocks, wrong material and occupied reserved air', async t => {
  const { world, blocks, behavior } = fixture(t)
  blocks.set(points[1].key, 'stone')
  blocks.set(points[2].key, 'glass')
  blocks.set(points[4].key, 'spruce_planks')
  behavior.preview = 'failed'
  behavior.previewReason = 'homebuild-obstructed'
  behavior.checked = 2
  const result = await world.withCampAction(() => world.verifyHouse(request, signal()))
  assert.deepEqual(result, { checked: 8, matched: 4, missing: 2, blocked: 2, issues: [
    { index: 0, reason: 'missing' }, { index: 1, reason: 'blocked' }, { index: 2, reason: 'blocked' }, { index: 5, reason: 'missing' },
  ] })
  assert.equal(minecraftHouseVerificationMatches(result, request), true)
  assert.deepEqual(behavior.operations.map(({ operation }) => operation), ['preview'])
  assert.deepEqual([...blocks.values()], ['stone', 'glass', 'spruce_planks'])
})

test('verification checks all 125 cells even when its issue list reaches the 12-cell cap', async t => {
  const maxLayout = { width: 5, height: 5, depth: 5, blocks: 'o'.repeat(100) + '.'.repeat(25) }
  const { world, blocks, behavior } = fixture(t, maxLayout)
  blocks.set([zone.x + 2, zone.y + 4, zone.z + 2].join(','), 'stone')
  behavior.preview = 'failed'
  behavior.previewReason = 'homebuild-materials'
  const result = await world.withCampAction(() => world.verifyHouse({ zone, layout: maxLayout }, signal()))
  assert.deepEqual(result, { checked: 125, matched: 24, missing: 100, blocked: 1,
    issues: Array.from({ length: 12 }, (_, index) => ({ index, reason: 'missing' })) })
  assert.ok(behavior.blockReads > 125)
  assert.equal(minecraftHouseVerificationMatches(result, { zone, layout: maxLayout }), true)
})

test('all 125 exact block predicates fit in a compact completion command', async t => {
  const maxLayout = { width: 5, height: 5, depth: 5, blocks: 's'.repeat(100) + '.'.repeat(25) }
  const { world, blocks, behavior } = fixture(t, maxLayout)
  for (const { x, y, z, block } of minecraftHouseCells(maxLayout)) {
    blocks.set([zone.x - 2 + x, zone.y + y, zone.z - 2 + z].join(','), block === 'air' ? 'cave_air' : block)
  }
  const result = await world.withCampAction(() => world.verifyHouse({ zone, layout: maxLayout }, signal()))
  assert.deepEqual(result, { checked: 125, matched: 125, missing: 0, blocked: 0, issues: [] })
  assert.equal((behavior.snapshotCommand.match(/ if block /gu) ?? []).length, 125)
  assert.ok(Buffer.byteLength(behavior.snapshotCommand) < 4096)
})

test('whole-house verification refuses missing authority, stale identity and inconsistent preflight', async t => {
  for (const [name, prepare, code, read] of [
    ['unsafe stance', ({ behavior }) => { behavior.preview = 'failed'; behavior.previewReason = 'homebuild-unsafe-stance' }, 'homebuild-unsafe-stance', false],
    ['unknown receipt reason', ({ behavior }) => { behavior.preview = 'failed'; behavior.previewReason = 'homebuild-unavailable-cell' }, 'homebuild-unavailable-cell', false],
    ['partial material receipt', ({ behavior }) => { behavior.preview = 'failed'; behavior.previewReason = 'homebuild-materials'; behavior.checked = 7 }, 'homebuild-materials', false],
    ['short ready receipt', ({ behavior }) => { behavior.checked = 7 }, 'house-preview-unconfirmed', false],
    ['wrong CBI sender', ({ behavior }) => { behavior.previewLine = id => feedback(id, 'ready', 8, 0, '-', 'other') }, 'house-receipt-unconfirmed', false],
    ['reconnect during read', ({ behavior, world }) => { behavior.afterBlockRead = () => { world.connectionEpoch++ } }, 'house-unavailable', true],
    ['paused during read', ({ behavior, world }) => { behavior.afterBlockRead = () => { world.campEpoch++ } }, 'minecraft-camp-paused', true],
    ['preflight contradicts an otherwise complete scan', ({ behavior }) => { behavior.preview = 'failed'; behavior.previewReason = 'homebuild-materials' }, 'house-verification-unconfirmed', true],
    ['preflight becomes unsafe after the scan', ({ behavior }) => {
      behavior.previewLine = id => behavior.operations.length === 1 ? feedback(id, 'ready', 8, 0) : feedback(id, 'failed', 0, 0, 'homebuild-unsafe-stance')
    }, 'house-verification-unconfirmed', true],
    ['an earlier block changes after a repairable second preview', ({ behavior, blocks }) => {
      behavior.beforeHouseSnapshot = () => blocks.delete(points[0].key)
    }, 'house-verification-unconfirmed', true],
    ['atomic proof emits a different player identity', ({ behavior }) => {
      behavior.houseSnapshotReceipt = '[10:00:01] [Server thread/INFO]: other has the following entity data: [I; -1, 2, 3, 4]\n'
    }, 'house-verification-unconfirmed', true],
  ]) await t.test(name, async child => {
    const h = fixture(child)
    for (const point of points) h.blocks.set(point.key, point.block)
    prepare(h)
    await assert.rejects(h.world.withCampAction(() => h.world.verifyHouse(request, signal())), { message: code })
    assert.equal(h.behavior.blockReads > 0, read)
    assert.ok(h.behavior.operations.every(({ operation }) => operation === 'preview'))
    assert.deepEqual(h.events, [])
  })
})

test('whole-house verification rejects false arithmetic, missing reports on air and fake completion', () => {
  const valid = { checked: 8, matched: 7, missing: 1, blocked: 0, issues: [{ index: 1, reason: 'missing' }] }
  assert.equal(MinecraftHouseVerification.safeParse(valid).success, true)
  for (const malformed of [
    { ...valid, checked: 0 }, { ...valid, matched: 8 }, { ...valid, checked: 9 }, { ...valid, issues: [] },
    { ...valid, issues: [{ index: 8, reason: 'missing' }] }, { ...valid, issues: [{ index: 1, reason: 'blocked' }] },
    { ...valid, missing: 2, matched: 6, issues: [...valid.issues, ...valid.issues] }, { ...valid, zoneId: zone.id },
  ]) assert.equal(MinecraftHouseVerification.safeParse(malformed).success, false)
  assert.equal(minecraftHouseVerificationMatches({ ...valid, issues: [{ index: 2, reason: 'missing' }] }, request), false)
  assert.equal(minecraftHouseVerificationMatches({ ...valid, issues: [{ index: 8, reason: 'blocked' }] }, request), false)
  assert.equal(HouseRecoveryCompletionResult.safeParse({ outcome: 'completed', verification: valid, placed: 1 }).success, false)
  const complete = { checked: 8, matched: 8, missing: 0, blocked: 0, issues: [] }
  assert.equal(HouseRecoveryCompletionResult.safeParse({ outcome: 'incomplete', verification: complete }).success, false)
  assert.equal(HouseRecoveryCompletionResult.safeParse({ outcome: 'completed', verification: complete, placed: 0 }).success, false)
  assert.equal(HouseRecoveryCompletionResult.safeParse({ outcome: 'completed', verification: complete, placed: 3 }).success, true)
})

test('house support requires live survival and the exact homebuild command', async t => {
  const { world } = fixture(t)
  let commands = 'goto, buildcamp'
  let survival = true
  world.features = undefined
  t.mock.method(world, 'survivalStatus', async () => survival ? 'threat=NONE' : undefined)
  t.mock.method(world, 'cbi', async command => command === 'help'
    ? `CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] 导航: ${commands}\n` : `[CBI] ${command.split(' ')[1]} =`)
  assert.equal(world.view().capabilities.houseBuilding, false)
  for (const [available, inSurvival, expected] of [
    ['goto, homebuilds', true, false], ['goto, homebuild', false, false], ['goto, homebuild', true, true],
  ]) {
    world.features = undefined
    commands = available
    survival = inSurvival
    await world.configure()
    assert.equal(world.view().capabilities.houseBuilding, expected)
  }
})

test('whole-house recovery requires an online survival worker with the exact CBI recovery marker', async t => {
  const { world, behavior } = fixture(t)
  let commands, survival
  t.mock.method(world, 'survivalStatus', async () => survival ? 'threat=NONE' : undefined)
  t.mock.method(world, 'cbi', async command => command === 'help'
    ? `CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] 导航: ${commands}\n` : `[CBI] ${command.split(' ')[1]} =`)
  for (const [available, inSurvival, expected] of [
    ['homebuild', true, false],
    ['homebuild, homebuildone', true, false],
    ['homebuild, homebuildrecovery', true, false],
    ['homebuildrecover', true, false],
    ['homebuild, homebuildrecover', false, false],
    ['homebuild, homebuildrecover', true, true],
  ]) {
    commands = available
    survival = inSurvival
    world.features = undefined
    await world.configure()
    assert.equal(world.view().capabilities.houseRecovery, expected)
  }
  world.online = false
  assert.equal(world.view().capabilities.houseRecovery, false)
  world.online = true
  world.features.houseRecovery = false
  await assert.rejects(world.withCampAction(() => world.previewHouse(request, signal(), true)), /house-recovery-unavailable/u)
  await assert.rejects(world.withCampAction(() => world.buildHouse(request, signal(), true)), /house-recovery-unavailable/u)
  assert.deepEqual(behavior.operations, [])
})

test('recovery preflight checks only its own mode and preserves exact shortage reporting', async t => {
  const { world, behavior, inventory, blocks, events } = fixture(t)
  world.features.houseRecovery = true
  const preview = () => world.withCampAction(() => world.previewHouse(request, signal(), true))
  const build = () => world.withCampAction(() => world.buildHouse(request, signal(), true))
  assert.deepEqual(await preview(), { ready: true, checked: 8 })
  blocks.set(points[0].key, 'oak_planks')
  inventory.glass = 0
  behavior.preview = 'failed'
  behavior.previewReason = 'homebuild-materials'
  const stockBefore = { ...inventory }
  const blocksBefore = new Map(blocks)
  const result = await preview()
  assert.equal(result.reason, 'homebuild-materials')
  assert.deepEqual(result.materials.find(item => item.material === 'glass'), { material: 'glass', needed: 1, carried: 0, missing: 1 })
  assert.ok(result.materials.every(item => item.material !== 'oak_planks'))
  assert.deepEqual(inventory, stockBefore)
  assert.deepEqual(blocks, blocksBefore)
  assert.deepEqual(behavior.operations.map(({ operation }) => operation), ['recover-preview', 'recover-preview'])
  assert.equal(behavior.stanceReads, 0)
  await assert.rejects(build(), /homebuild-materials/u)
  assert.equal(behavior.operations.at(-1).operation, 'recover-preview')
  assert.ok(events.every(event => event.event !== 'action.finished'))
})

test('preview only accepts an anchored matching CBI reply with an exact count', async t => {
  const { world, behavior, blocks } = fixture(t)
  assert.deepEqual(await world.withCampAction(() => world.previewHouse(request, signal())), { ready: true, checked: 8 })
  behavior.preview = 'failed'
  behavior.checked = 3
  assert.deepEqual(await world.withCampAction(() => world.previewHouse(request, signal())), { ready: false, checked: 3, reason: 'site-obstructed' })
  for (const invalid of [
    id => feedback(id, 'ready', 7, 0),
    id => feedback(id, 'ready', 8, 1),
    id => feedback(id, 'ready', 8, 0, '-', 'other'),
    id => feedback(id, 'ready', 8, 0).replace('CBI feedback', '<other> CBI feedback'),
    id => feedback(id, 'ready', 8, 0, 'unsafe'),
    () => feedback('f'.repeat(24), 'ready', 8, 0),
  ]) {
    behavior.previewLine = invalid
    await assert.rejects(world.withCampAction(() => world.previewHouse(request, signal())), /house-(?:preview|receipt)-unconfirmed/u)
  }
  assert.equal(blocks.size, 0)
  assert.ok(behavior.operations.every(({ operation }) => operation === 'preview'))
})

test('full-volume shortage independently reports only blocks still needed, with capped carried stock', async t => {
  const { world, behavior, blocks, inventory, events } = fixture(t)
  behavior.preview = 'failed'
  behavior.previewReason = 'homebuild-materials'
  blocks.set(points[0].key, 'oak_planks')
  blocks.set(points[4].key, 'cave_air')
  inventory.glass = 0
  inventory.diamond = 13
  assert.deepEqual(await world.withCampAction(() => world.previewHouse(request, signal())), {
    ready: false, checked: 8, reason: 'homebuild-materials', materials: [
      { material: 'spruce_planks', needed: 1, carried: 1, missing: 0 },
      { material: 'cobblestone', needed: 1, carried: 1, missing: 0 },
      { material: 'glass', needed: 1, carried: 0, missing: 1 },
    ],
  })
  assert.ok(behavior.blockReads > 8)
  assert.equal(behavior.inventoryReads, 1)
  assert.deepEqual(behavior.operations.map(({ operation }) => operation), ['preview'])
  assert.deepEqual([...blocks], [[points[0].key, 'oak_planks'], [points[4].key, 'cave_air']])
  assert.deepEqual(inventory, { oak_planks: 5, spruce_planks: 5, cobblestone: 5, glass: 0, diamond: 13 })
  assert.deepEqual(events, [])
})

test('ready and unrelated or partial failures perform no extra cell or inventory reads', async t => {
  const { world, behavior } = fixture(t)
  const preview = () => world.withCampAction(() => world.previewHouse(request, signal()))
  assert.deepEqual(await preview(), { ready: true, checked: 8 })
  behavior.preview = 'failed'
  behavior.previewReason = 'homebuild-obstructed'
  assert.deepEqual(await preview(), { ready: false, checked: 8, reason: 'homebuild-obstructed' })
  behavior.previewReason = 'homebuild-materials'
  behavior.checked = 7
  assert.deepEqual(await preview(), { ready: false, checked: 7, reason: 'homebuild-materials' })
  assert.equal(behavior.blockReads, 0)
  assert.equal(behavior.inventoryReads, 0)
})

test('a missing or contradictory readback does not manufacture a deficit report', async t => {
  for (const [label, change] of [
    ['stock now covers the blueprint', () => {}],
    ['target has become obstructed', ({ blocks }) => blocks.set(points[0].key, 'stone')],
    ['unknown inventory payload', ({ behavior }) => { behavior.inventoryLine = '[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [{id: "minecraft:glass", count: -1}]\n' }],
    ['forged inventory payload', ({ behavior }) => { behavior.inventoryLine = '[10:00:01] [Server thread/INFO]: <other> dafeiyu has the following entity data: []\n' }],
    ['unconfirmed target check', ({ behavior }) => { behavior.afterBlockRead = () => { throw new Error('block-check-unconfirmed') } }],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    h.behavior.preview = 'failed'
    h.behavior.previewReason = 'homebuild-materials'
    change(h)
    assert.deepEqual(await h.world.withCampAction(() => h.world.previewHouse(request, signal())), {
      ready: false, checked: 8, reason: 'homebuild-materials',
    })
    assert.deepEqual(h.behavior.operations.map(({ operation }) => operation), ['preview'])
  })
})

test('shortage reporting remains fenced by disconnection, pause and abort during added reads', async t => {
  for (const [label, change, error] of [
    ['disconnection at inventory readback', ({ world, behavior }) => {
      behavior.afterInventoryRead = () => { world.connectionEpoch++ }
    }, /house-ownership-unconfirmed/u],
    ['pause while reading the world', ({ world, behavior }) => {
      behavior.afterBlockRead = () => { world.campPaused = true }
    }, /minecraft-camp-paused/u],
    ['caller abort during inventory readback', ({ behavior }, controller) => {
      behavior.afterInventoryRead = () => { controller.abort() }
    }, { name: 'AbortError' }],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    const controller = new AbortController()
    h.behavior.preview = 'failed'
    h.behavior.previewReason = 'homebuild-materials'
    h.inventory.glass = 0
    change(h, controller)
    await assert.rejects(h.world.withCampAction(() => h.world.previewHouse(request, controller.signal)), error)
    assert.deepEqual(h.behavior.operations.map(({ operation }) => operation), ['preview'])
  })
})

test('house dispatch is unavailable to visits, paused camps, busy Workers and invalid requests', async t => {
  const { world, behavior } = fixture(t)
  const call = () => world.previewHouse(request, signal())
  await assert.rejects(world.buildHouse({ ...request, injected: 'setblock' }, signal()), /minecraft-house-invalid-request/u)
  await assert.rejects(world.previewHouse({ ...request, layout: { ...layout, blocks: 'oc\n.sg..' } }, signal()), /minecraft-house-invalid-request/u)
  world.visit = { id: 'visit', expiresAt: Date.now() + 50000 }
  assert.throws(() => world.withCampAction(call), /minecraft-camp-visit-busy/u)
  await assert.rejects(world.withCampAction(call, 'visit'), /minecraft-camp-visit-busy/u)
  world.visit = undefined
  world.campPaused = true
  assert.throws(() => world.withCampAction(call), /minecraft-camp-paused/u)
  world.campPaused = false
  world.action = { kind: 'survey' }
  await assert.rejects(world.withCampAction(call), /action-busy/u)
  world.action = { kind: 'house-build' }
  assert.throws(() => world.withCampAction(() => assert.fail('Concurrent ordinary actions must stay out')), /action-busy/u)
  world.action = { kind: 'house-cell' }
  assert.throws(() => world.withCampAction(() => assert.fail('Concurrent ordinary actions must stay out of a cell placement')), /action-busy/u)
  world.action = undefined
  world.features.houseBuilding = false
  await assert.rejects(world.withCampAction(call), /house-unavailable/u)
  assert.deepEqual(behavior.operations, [])
})

test('only missing cells debit their own materials and retry places zero', async t => {
  const { world, behavior, blocks, inventory, events } = fixture(t)
  blocks.set(points[0].key, 'oak_planks')
  blocks.set(points[2].key, 'cave_air')
  const build = () => world.withCampAction(() => world.buildHouse(request, signal()))
  assert.deepEqual(await build(), { built: true, zoneId: zone.id, checked: 8, placed: 3, consumed: { cobblestone: 1, spruce_planks: 1, glass: 1 } })
  assert.deepEqual(inventory, { oak_planks: 5, spruce_planks: 4, cobblestone: 4, glass: 4 })
  assert.deepEqual(await build(), { built: true, zoneId: zone.id, checked: 8, placed: 0, consumed: {} })
  assert.deepEqual(behavior.operations.map(({ operation }) => operation), ['preview', 'run', 'status', 'preview', 'run', 'status'])
  assert.equal(behavior.stanceReads, 4)
  assert.equal(events.filter(event => event.event === 'action.finished' && event.kind === 'house-build').length, 2)
})

test('recovery verifies the actual return, exact new debit and full final footprint independently', async t => {
  const { world, behavior, blocks, inventory, events } = fixture(t)
  world.features.houseRecovery = true
  behavior.interleavedReads = true
  blocks.set(points[0].key, 'oak_planks')
  blocks.set(points[2].key, 'cave_air')
  behavior.afterBuild = () => { behavior.stance = '-11.6d, 70.0d, 29.6d' }
  const build = () => world.withCampAction(() => world.buildHouse(request, signal(), true))
  assert.deepEqual(await build(), { built: true, zoneId: zone.id, checked: 8, placed: 3, consumed: { cobblestone: 1, spruce_planks: 1, glass: 1 } })
  assert.deepEqual(inventory, { oak_planks: 5, spruce_planks: 4, cobblestone: 4, glass: 4 })
  assert.equal(blocks.get(points[2].key), 'cave_air')
  assert.equal(behavior.stanceReads, 2)
  assert.deepEqual(await build(), { built: true, zoneId: zone.id, checked: 8, placed: 0, consumed: {} })
  assert.equal(behavior.stanceReads, 4)
  assert.deepEqual(behavior.operations.map(({ operation }) => operation),
    ['recover-preview', 'recover', 'status', 'recover-preview', 'recover', 'status'])
  assert.equal(events.filter(event => event.event === 'action.finished' && event.kind === 'house-build').length, 2)
})

test('a recovery cannot confirm while displaced, disconnected, on a false receipt or during abort', async t => {
  for (const [label, edit, code] of [
    ['crossed a horizontal cell boundary', ({ behavior }) => { behavior.stance = '-11.5d, 70.0d, 30.0d' }, 'house-stance-unconfirmed'],
    ['changed height', ({ behavior }) => { behavior.stance = '-11.5d, 71.0d, 29.5d' }, 'house-stance-unconfirmed'],
    ['requested dimension cannot confirm the position', ({ behavior }) => { behavior.stanceReadMissing = true }, 'house-stance-unconfirmed'],
    ['position read is malformed', ({ behavior }) => { behavior.stance = 'not-a-position' }, 'house-stance-unconfirmed'],
    ['world readback disagrees', ({ blocks }) => { blocks.set(points[2].key, 'stone') }, 'house-world-unconfirmed'],
    ['stock did not decrease', ({ inventory }) => { inventory.glass++ }, 'house-inventory-unconfirmed'],
    ['connection epoch changes', ({ world }) => { world.connectionEpoch++ }, 'house-unavailable'],
    ['caller aborts', (_h, controller) => { controller.abort() }, 'house-cancelled'],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    h.world.features.houseRecovery = true
    const controller = new AbortController()
    h.behavior.afterBuild = () => edit(h, controller)
    await assert.rejects(h.world.withCampAction(() => h.world.buildHouse(request, controller.signal, true)), { message: code })
    assert.ok(h.events.every(event => event.event !== 'action.finished'))
    assert.equal(h.world.action, undefined)
    const run = h.behavior.operations.find(item => item.operation === 'recover')
    assert.equal(h.behavior.operations[0].operation, 'recover-preview')
    assert.ok(run)
    assert.deepEqual(h.behavior.operations.filter(item => item.operation === 'cancel'),
      label === 'caller aborts' ? [{ operation: 'cancel', id: run.id }] : [])
  })
})

test('live world and inventory verification are independent of Java success', async t => {
  for (const [label, change, expected, dispatch] of [
    ['solid obstruction', ({ blocks }) => blocks.set(points[0].key, 'stone'), /house-preconditions-changed/u, false],
    ['occupied blueprint air', ({ blocks }) => blocks.set(points[2].key, 'stone'), /house-preconditions-changed/u, false],
    ['inventory shortage', ({ inventory }) => { inventory.glass = 0 }, /house-preconditions-changed/u, false],
    ['spoofed inventory', ({ behavior }) => { behavior.inventoryLine = '[10:00:01] [Server thread/INFO]: <other> dafeiyu has the following entity data: []\n' }, /house-inventory-unconfirmed/u, false],
    ['different placed count', ({ behavior }) => { behavior.completePlaced = 3 }, /house-receipt-unconfirmed/u, true],
    ['different checked count', ({ behavior }) => { behavior.completeChecked = 7 }, /house-receipt-unconfirmed/u, true],
    ['wrong final block', ({ behavior, blocks }) => { behavior.afterBuild = () => blocks.set(points[1].key, 'dirt') }, /house-world-unconfirmed/u, true],
    ['changed final air', ({ behavior, blocks }) => { behavior.afterBuild = () => blocks.set(points[2].key, 'dirt') }, /house-world-unconfirmed/u, true],
    ['debit not proven', ({ behavior, inventory }) => { behavior.afterBuild = () => { inventory.glass++ } }, /house-inventory-unconfirmed/u, true],
    ['unrelated material debit', ({ behavior, inventory }) => { behavior.afterBuild = () => { inventory.glass-- } }, /house-inventory-unconfirmed/u, true],
    ['starting stance cannot be independently read', ({ behavior }) => { behavior.stanceReadMissing = true }, /house-stance-unconfirmed/u, false],
    ['return stance is in a different cell', ({ behavior }) => { behavior.afterBuild = () => { behavior.stance = '-11.5d, 70.0d, 30.0d' } }, /house-stance-unconfirmed/u, true],
    ['return stance is on a different floor', ({ behavior }) => { behavior.afterBuild = () => { behavior.stance = '-11.5d, 71.0d, 29.5d' } }, /house-stance-unconfirmed/u, true],
    ['return position cannot be read in the authorized dimension', ({ behavior }) => { behavior.afterBuild = () => { behavior.stanceReadMissing = true } }, /house-stance-unconfirmed/u, true],
  ]) {
    await t.test(label, async child => {
      const h = fixture(child)
      change(h)
      await assert.rejects(h.world.withCampAction(() => h.world.buildHouse(request, signal())), expected)
      assert.equal(h.behavior.operations.some(({ operation }) => operation === 'run'), dispatch)
      assert.ok(h.events.every(event => event.event !== 'action.finished'))
      assert.equal(h.world.action, undefined)
    })
  }
})

test('an abort cancels only the issued house ID and never returns success', async t => {
  const { world, behavior, events } = fixture(t)
  const checking = Promise.withResolvers()
  const released = Promise.withResolvers()
  behavior.status = id => {
    checking.resolve()
    return released.promise.then(() => feedback(id, 'succeeded', 8, 4))
  }
  const controller = new AbortController()
  const pending = world.withCampAction(() => world.buildHouse(request, controller.signal))
  const denied = assert.rejects(pending, /house-cancelled/u)
  await checking.promise
  controller.abort()
  released.resolve()
  await denied
  const run = behavior.operations.find(({ operation }) => operation === 'run')
  assert.deepEqual(behavior.operations.filter(({ operation }) => operation === 'cancel'), [{ operation: 'cancel', id: run.id }])
  assert.ok(events.every(event => event.event !== 'action.finished'))
})

test('a verified Java construction refusal preserves its bounded reason without producing a receipt', async t => {
  const { world, behavior, events } = fixture(t)
  behavior.status = id => feedback(id, 'failed', 8, 1, 'homebuild-unreachable-placement')
  await assert.rejects(world.withCampAction(() => world.buildHouse(request, signal())), { message: 'homebuild-unreachable-placement' })
  assert.ok(events.every(event => event.event !== 'action.finished'))
})

test('house session ownership rejects the same name rejoining before receipts settle', async t => {
  const directory = await mkdtemp(resolve('.work/house-ownership-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logPath = join(directory, 'latest.log')
  await writeFile(logPath, '[10:00:01] [Server thread/INFO]: dafeiyu[local] logged in with entity id 1 at (1, 2, 3)\n')
  const world = Object.assign(Object.create(CbiWorld.prototype), { logPath, botName: 'dafeiyu', online: true, connectionEpoch: 1 })
  const same = await world.captureHouseSession()
  await appendFile(logPath, '[10:00:01] [Server thread/INFO]: <other> dafeiyu left the game\n')
  await world.verifyHouseSession(same)
  await appendFile(logPath, '[10:00:01] [Server thread/INFO]: dafeiyu left the game\n')
  await appendFile(logPath, '[10:00:02] [Server thread/INFO]: dafeiyu[local] logged in with entity id 2 at (1, 2, 3)\n')
  await assert.rejects(world.verifyHouseSession(same), /house-ownership-unconfirmed/u)
})

test('single-cell support requires exact CBI marker, base homebuild, and survival', async t => {
  const { world } = fixture(t)
  let commands, survival
  t.mock.method(world, 'survivalStatus', async () => survival ? 'threat=NONE' : undefined)
  t.mock.method(world, 'cbi', async command => command === 'help'
    ? `CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] 导航: ${commands}\n` : `[CBI] ${command.split(' ')[1]} =`)
  for ([commands, survival] of [['homebuild', true], ['homebuild, homebuildones', true], ['homebuildone', true], ['homebuild, homebuildone', false]]) {
    world.features = undefined
    await world.configure()
    assert.equal(world.view().capabilities.houseCellPlacement, false)
    await assert.rejects(world.houseCandidates(request, signal()), /house-(?:cell-)?unavailable/u)
  }
  world.features = undefined
  commands = 'homebuild, homebuildone'
  survival = true
  await world.configure()
  assert.equal(world.view().capabilities.houseCellPlacement, true)
})

test('single-cell requests and receipts bind an exact solid blueprint index and debit', () => {
  const valid = { ...request, index: 1 }
  assert.equal(MinecraftHouseCellRequest.safeParse(valid).success, true)
  for (const index of [-1, 1.5, 2, 8, 125, '1']) assert.equal(MinecraftHouseCellRequest.safeParse({ ...request, index }).success, false)
  assert.equal(MinecraftHouseCellRequest.safeParse({ ...valid, material: 'glass' }).success, false)
  const receipt = { outcome: 'placed', index: 1, material: 'cobblestone', consumed: 1 }
  assert.equal(MinecraftHouseCellReceipt.safeParse(receipt).success, true)
  assert.equal(MinecraftHouseCellReceipt.safeParse({ ...receipt, consumed: 0 }).success, false)
  assert.equal(MinecraftHouseCellReceipt.safeParse({ ...receipt, outcome: 'already-present' }).success, false)
  assert.equal(MinecraftHouseCellReceipt.safeParse({ ...receipt, outcome: 'blocked', consumed: 0, reason: 'arbitrary' }).success, false)
  assert.equal(minecraftHouseCellMatches(receipt, valid), true)
  assert.equal(minecraftHouseCellMatches({ ...receipt, index: 0 }, valid), false)
  assert.equal(minecraftHouseCellMatches({ ...receipt, material: 'glass' }, valid), false)
})

test('candidates report observed empty solid targets only, keep conflicts separate, and bound the list', async t => {
  const h = fixture(t)
  h.blocks.set(points[0].key, 'oak_planks')
  h.blocks.set(points[1].key, 'stone')
  h.blocks.set(points[2].key, 'glass')
  h.blocks.set(points[4].key, 'cave_air')
  const read = input => h.world.withCampAction(() => h.world.houseCandidates(input, signal()))
  const output = await read(request)
  assert.deepEqual(output, { checked: 4, blocked: 1, candidates: [
    { index: 4, x: 0, y: 1, z: 0, material: 'spruce_planks' }, { index: 5, x: 1, y: 1, z: 0, material: 'glass' },
  ], stock: { spruce_planks: 5, glass: 5 } })
  assert.equal(minecraftHouseCandidatesMatch(output, request), true)
  assert.equal(minecraftHouseCandidatesMatch({ ...output, checked: 3 }, request), false)
  assert.equal(minecraftHouseCandidatesMatch({ ...output, candidates: [{ ...output.candidates[0], z: 1 }] }, request), false)
  assert.equal(minecraftHouseCandidatesMatch({ ...output, stock: { cobblestone: 9 } }, request), false)
  assert.equal(MinecraftHouseCellCandidates.safeParse({ ...output, candidates: [output.candidates[0], output.candidates[0]] }).success, false)
  assert.equal(MinecraftHouseCellCandidates.safeParse({ ...output, blocked: 3 }).success, false)
  h.blocks.clear()
  const expanded = await read({ zone, layout: { width: 5, height: 5, depth: 5, blocks: 'o'.repeat(100) + '.'.repeat(25) } })
  assert.equal(expanded.checked, 100)
  assert.deepEqual(expanded.candidates.map(cell => cell.index), Array.from({ length: 12 }, (_, index) => index))
  assert.deepEqual(h.behavior.operations, [])
  assert.equal(h.behavior.inventoryReads, 2)
})

test('an obstructed stale choice leaves the object and inventory intact, then another choice places exactly one', async t => {
  const h = fixture(t)
  const read = () => h.world.withCampAction(() => h.world.houseCandidates(request, signal()))
  const place = index => h.world.withCampAction(() => h.world.placeHouseCell({ ...request, index }, signal()))
  const offered = await read()
  assert.deepEqual(offered.candidates.map(cell => cell.index), [0, 1, 4, 5])
  h.blocks.set(points[0].key, 'stone')
  assert.deepEqual(await place(0), { outcome: 'blocked', index: 0, material: 'oak_planks', consumed: 0, reason: 'homebuild-obstructed' })
  assert.deepEqual(h.behavior.operations, [])
  assert.equal(h.behavior.inventoryReads, 1)
  assert.deepEqual(await place(1), { outcome: 'placed', index: 1, material: 'cobblestone', consumed: 1 })
  assert.deepEqual(await place(1), { outcome: 'already-present', index: 1, material: 'cobblestone', consumed: 0 })
  assert.deepEqual(h.behavior.operations.map(({ operation }) => operation), ['runone', 'status'])
  assert.equal(h.events.filter(event => event.event === 'action.finished' && event.kind === 'house-cell').length, 1)
  assert.deepEqual(h.inventory, { oak_planks: 5, spruce_planks: 5, cobblestone: 4, glass: 5 })
  assert.deepEqual([...h.blocks], [[points[0].key, 'stone'], [points[1].key, 'cobblestone']])
  h.inventory.glass = 0
  assert.deepEqual(await place(5), { outcome: 'blocked', index: 5, material: 'glass', consumed: 0, reason: 'homebuild-materials' })
  assert.equal(h.behavior.operations.length, 2)
})

test('candidate refresh distinguishes real zero stock from an unconfirmed inventory reading', async t => {
  const { world, behavior, inventory } = fixture(t)
  const read = () => world.withCampAction(() => world.houseCandidates(request, signal()))
  inventory.cobblestone = 0
  inventory.diamond = 12
  assert.deepEqual((await read()).stock, { oak_planks: 5, cobblestone: 0, spruce_planks: 5, glass: 5 })
  behavior.inventoryLine = '[10:00:01] [Server thread/INFO]: dafeiyu has the following entity data: [{id: "minecraft:glass", count: -1}]\n'
  assert.equal(Object.hasOwn(await read(), 'stock'), false)
  assert.equal(behavior.inventoryReads, 2)
  assert.deepEqual(behavior.operations, [])
})

test('a CBI refusal is retryable only when the receipt, target, debit and return stance agree', async t => {
  for (const [label, edit, code] of [
    ['returned with no change', () => {}, undefined],
    ['reported a partial placement', (h, id) => feedback(id, 'failed', 1, 1, 'homebuild-unreachable-placement'), 'house-cell-unconfirmed'],
    ['reported an unsafe exit', (h, id) => feedback(id, 'failed', 1, 0, 'homebuild-unsafe-stance'), 'house-cell-unconfirmed'],
    ['left the original stance', ({ behavior }) => { behavior.stance = '-11.5d, 70.0d, 30.5d' }, 'house-stance-unconfirmed'],
    ['target now matches despite refusal', ({ blocks }) => { blocks.set(points[1].key, 'cobblestone') }, 'house-world-unconfirmed'],
    ['debit occurred despite refusal', ({ inventory }) => { inventory.cobblestone-- }, 'house-inventory-unconfirmed'],
    ['checked count disagrees', (h, id) => feedback(id, 'failed', 0, 0, 'homebuild-unreachable-placement'), 'house-receipt-unconfirmed'],
    ['sender disagrees', (h, id) => feedback(id, 'failed', 1, 0, 'homebuild-unreachable-placement', 'other'), 'house-receipt-unconfirmed'],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    h.behavior.startCell = id => edit(h, id) ?? feedback(id, 'failed', 1, 0, 'homebuild-unreachable-placement')
    const operation = h.world.withCampAction(() => h.world.placeHouseCell({ ...request, index: 1 }, signal()))
    if (code) await assert.rejects(operation, { message: code })
    else assert.deepEqual(await operation, { outcome: 'blocked', index: 1, material: 'cobblestone', consumed: 0, reason: 'homebuild-unreachable-placement' })
    assert.equal(h.world.action, undefined)
    assert.equal(h.events.some(event => event.event === 'action.finished'), !code)
  })
})

test('an interrupted or displaced single-cell run cannot confirm placement', async t => {
  for (const [label, edit, code] of [
    ['wrong block', ({ blocks }) => { blocks.set(points[1].key, 'glass') }, 'house-world-unconfirmed'],
    ['selected debit not proven', ({ inventory }) => { inventory.cobblestone++ }, 'house-inventory-unconfirmed'],
    ['unrelated material debit', ({ inventory }) => { inventory.glass-- }, 'house-inventory-unconfirmed'],
    ['displaced after writing', ({ behavior }) => { behavior.stance = '-11.5d, 70.0d, 30.5d' }, 'house-stance-unconfirmed'],
    ['connection changes', ({ world }) => { world.connectionEpoch++ }, 'house-unavailable'],
    ['caller aborts', (_h, controller) => { controller.abort() }, 'house-cancelled'],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    const controller = new AbortController()
    h.behavior.afterBuild = () => edit(h, controller)
    await assert.rejects(h.world.withCampAction(() => h.world.placeHouseCell({ ...request, index: 1 }, controller.signal)), { message: code })
    assert.ok(h.events.every(event => event.event !== 'action.finished'))
    assert.equal(h.world.action, undefined)
    if (label === 'caller aborts') {
      const run = h.behavior.operations.find(item => item.operation === 'runone')
      assert.deepEqual(h.behavior.operations.filter(item => item.operation === 'cancel'), [{ operation: 'cancel', id: run.id }])
    }
  })
})
