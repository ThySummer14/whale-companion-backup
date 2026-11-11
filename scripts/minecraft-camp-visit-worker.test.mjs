import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { CAMP_GATHER_MAX_MS, MinecraftCampGatherOffer, MinecraftCampGatherReceipt, MinecraftCampGatherRequest } from '../src/core/minecraft-gather.ts'
import { MinecraftVisitBuildOffer, MinecraftVisitBuildReceipt, MinecraftVisitRevisitReceipt, MinecraftVisitRevisitRequest, MinecraftVisitSupplyOffer, MinecraftVisitSupplyReceipt } from '../src/core/minecraft-supply.ts'
import { CAMP_PATROL_MAX_MS, MinecraftPatrolSegmentReceipt, MinecraftPatrolSegmentRequest } from '../src/core/minecraft-survey.ts'

const INFO = message => '[10:00:01] [Server thread/INFO]: ' + message + '\n'
const zone = { id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 5 }
const center = { x: -11.5, y: 70, z: 32.5 }
const signal = () => new AbortController().signal

function fixture(t) {
  const dir = mkdtempSync('.work/camp-visit-worker-')
  const logPath = join(dir, 'latest.log')
  const visitPath = join(dir, 'camp-visit.json')
  writeFileSync(logPath, INFO('Done (0.4s)! For help, type "help"'))
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: false, closing: false, campPaused: false, campEpoch: 0, botName: 'dafeiyu', visitPath, logPath, visitRetryAt: 0,
  })
  const state = { online: false, loaded: true, air: true, floor: true, pos: center, threat: 'NONE', onGround: 1, survey: true,
    spawnFailure: undefined, beforeDispatch: undefined, afterDispatch: undefined, onStop: undefined, killRefused: false }
  const commands = []
  const events = []
  t.mock.method(world, 'record', (event, data) => events.push({ event, ...data }))
  t.mock.method(world, 'send', async (cmd, accept, _timeout, _settle, abort, dispatch) => {
    world.assertCampAdmission()
    commands.push(cmd)
    if (cmd.includes(' spawn at ')) await state.beforeDispatch?.()
    abort?.throwIfAborted()
    dispatch?.()
    let reply
    if (cmd === 'list') reply = INFO(state.online
      ? 'There are 1 of a max of 20 players online: dafeiyu'
      : 'There are 0 of a max of 20 players online:')
    else if (cmd.includes(' if loaded ')) reply = INFO(state.loaded ? 'Test passed' : 'Test failed')
    else if (cmd.includes(' spawn at ')) {
      if (state.spawnFailure === 'denied') {
        state.online = true
        reply = INFO('Player dafeiyu is already logged on')
      } else if (state.spawnFailure === 'pending') throw new Error('console-receipt-timeout:player')
      else {
        state.online = true
        reply = INFO('dafeiyu[local] logged in with entity id 17 at (-11.5, 70.0, 32.5)')
        appendFileSync(logPath, reply)
        await state.afterDispatch?.()
      }
    } else if (cmd === 'player dafeiyu kill') {
      if (!state.killRefused) state.online = false
      reply = INFO(state.killRefused ? 'Only fake players can be moved or killed' : 'dafeiyu left the game')
      appendFileSync(logPath, reply)
    } else if (state.onCommand) reply = await state.onCommand(cmd)
    else assert.fail('Unexpected command: ' + cmd)
    assert.ok(accept instanceof RegExp ? accept.test(reply) : accept(reply), reply)
    if (state.spawnFailure === 'denied' && cmd.includes(' spawn at ')) appendFileSync(logPath, reply)
    return reply
  })
  t.mock.method(world, 'block', async (pos, expected, dimension) => {
    assert.equal(dimension, zone.dimension)
    if (pos.y === zone.y - 1) return state.floor && expected === 'minecraft:oak_planks'
    return state.air && expected === 'minecraft:air'
  })
  t.mock.method(world, 'observeInternal', async () => {
    world.online = state.online
    return { position: state.pos, dimension: zone.dimension, health: 20, oxygen: 300, food: 20, gameMode: 'survival' }
  })
  t.mock.method(world, 'configure', async () => (world.features = { campSurvey: state.survey, campSurveyRoutes: state.routes ?? false, campGather: state.campGather ?? false }))
  t.mock.method(world, 'survivalStatus', async () => 'threat=' + state.threat + ' avoidance=false')
  t.mock.method(world, 'data', async () => state.onGround)
  t.mock.method(world, 'stop', async () => {
    commands.push('stop confirmed')
    await state.onStop?.()
    return { stopped: true, displacement: 0 }
  })
  t.after(async () => {
    await world.visitStart?.promise?.catch(() => {})
    await world.visitEnd?.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })
  const request = { id: randomUUID(), zone, expiresAt: Date.now() + 120_000 }
  return { world, state, logPath, visitPath, request, commands, events }
}

test('visit refuses malformed/long permits and a genuinely present player without spawn or cleanup', async t => {
  const h = fixture(t)
  for (const input of [{ ...h.request, expiresAt: Date.now() + 301_000 }, { ...h.request, other: 'extra' }, { ...h.request, id: 'fake' }]) {
    assert.throws(() => h.world.startCampVisit(input, signal()), /visit-invalid-request/u)
  }
  h.state.online = true
  await assert.rejects(h.world.startCampVisit(h.request, signal()), /already-online/u)
  assert.throws(() => h.world.endCampVisit({ id: h.request.id }), /not-found/u)
  assert.deepEqual(h.commands, ['list'])
})

test('zone requires a loaded chunk, clear headroom and stable floor before spawning', async t => {
  for (const guard of ['loaded', 'air', 'floor']) await t.test(guard, async t => {
    const h = fixture(t)
    h.state[guard] = false
    await assert.rejects(h.world.startCampVisit(h.request, signal()), /spawn-unsafe/u)
    assert.deepEqual(await h.world.endCampVisit({ id: h.request.id }), { visitId: h.request.id, online: false, confirmed: true })
    assert.equal(h.commands.some(cmd => cmd.includes('player dafeiyu')), false)
  })
})

test('visit persists its identity before the spawn, then rejects ordinary or mismatched controls', async t => {
  const h = fixture(t)
  h.state.afterDispatch = async () => {
    const stored = JSON.parse(readFileSync(h.visitPath, 'utf8'))
    assert.equal(stored.active.id, h.request.id)
    assert.ok(stored.active.dispatch.offset > 0)
  }
  const id = h.request.id
  assert.deepEqual(await h.world.startCampVisit(h.request, signal()), { visitId: id, online: true, atCamp: true })
  assert.ok(h.commands.includes('player dafeiyu spawn at -11.5 70 32.5 facing 0 0 in minecraft:overworld in survival'))
  assert.equal(h.world.activityPresence().campVisitReady, false)
  assert.throws(() => h.world.withCampAction(() => {}), /visit-busy/u)
  assert.throws(() => h.world.withCampAction(() => {}, randomUUID()), /visit-refused/u)
  assert.throws(() => h.world.withCampAction(() => h.world.assertCampVisitZone({ ...zone, radius: 6 }), id), /visit-refused/u)
  assert.doesNotThrow(() => h.world.withCampAction(() => h.world.assertCampVisitZone(zone), id))
  const end = await h.world.endCampVisit({ id })
  assert.deepEqual(end, { visitId: id, online: false, confirmed: true })
  assert.ok(h.commands.indexOf('stop confirmed') < h.commands.indexOf('player dafeiyu kill'))
  h.state.online = true
  assert.deepEqual(await h.world.endCampVisit({ id }), end)
  assert.equal(h.commands.filter(cmd => cmd === 'player dafeiyu kill').length, 1)
  assert.throws(() => h.world.startCampVisit(h.request, signal()), /visit-busy/u)
})

test('unsafe actual arrival, inadequate health signals or incompatible CBI never admit survey', async t => {
  for (const [name, state] of [
    ['misplaced', { pos: { ...center, x: center.x + 1 } }], ['danger', { threat: 'HOSTILE' }],
    ['airborne', { onGround: 0 }], ['legacy', { survey: false }],
  ]) await t.test(name, async t => {
    const h = fixture(t)
    Object.assign(h.state, state)
    await assert.rejects(h.world.startCampVisit(h.request, signal()), /spawn-unsafe/u)
    await h.world.endCampVisit({ id: h.request.id })
    assert.equal(h.state.online, false)
    assert.equal(h.commands.filter(cmd => cmd === 'player dafeiyu kill').length, 1)
    assert.equal(h.commands.some(cmd => /^(?:tp|teleport) /u.test(cmd)), false)
  })
})

test('a competing spawn that Carpet refused is never stopped or disconnected', async t => {
  const h = fixture(t)
  h.state.spawnFailure = 'denied'
  await assert.rejects(h.world.startCampVisit(h.request, signal()), /spawn-refused/u)
  await assert.rejects(h.world.endCampVisit({ id: h.request.id }), /ownership-lost/u)
  assert.equal(h.state.online, true)
  assert.equal(h.commands.some(cmd => cmd === 'player dafeiyu kill' || cmd === 'stop confirmed'), false)
})

test('cancellation waiting to dispatch prevents any actual spawn or retry', async t => {
  const h = fixture(t)
  const waiting = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.state.beforeDispatch = async () => { waiting.resolve(); await release.promise }
  const starting = assert.rejects(h.world.startCampVisit(h.request, signal()), /aborted/u)
  await waiting.promise
  const cleanup = h.world.endCampVisit({ id: h.request.id })
  release.resolve()
  await starting
  assert.deepEqual(await cleanup, { visitId: h.request.id, online: false, confirmed: true })
  assert.equal(h.state.online, false)
  assert.equal(h.commands.includes('player dafeiyu kill'), false)
})

test('restart recovery fences new commands and can clean an existing actual Carpet session', async t => {
  const h = fixture(t)
  await h.world.startCampVisit(h.request, signal())
  const journal = JSON.parse(readFileSync(h.visitPath, 'utf8'))
  h.world.visit = journal.active
  h.world.visitEnding = true
  h.world.online = false
  assert.throws(() => h.world.withCampAction(() => {}, h.request.id), /visit-refused/u)
  assert.deepEqual(await h.world.endCampVisit({ id: h.request.id }), { visitId: h.request.id, online: false, confirmed: true })
  assert.equal(h.state.online, false)
})

test('a new same-name session after the original left is never disconnected by its old lease', async t => {
  const h = fixture(t)
  await h.world.startCampVisit(h.request, signal())
  appendFileSync(h.logPath, INFO('dafeiyu left the game') + INFO('dafeiyu[local] logged in with entity id 18 at (-11.5, 70.0, 32.5)'))
  await assert.rejects(h.world.endCampVisit({ id: h.request.id }), /ownership-lost/u)
  assert.equal(h.state.online, true)
  assert.equal(h.commands.includes('player dafeiyu kill'), false)
})

test('server restart invalidates ownership without disconnecting any subsequent player', async t => {
  const h = fixture(t)
  await h.world.startCampVisit(h.request, signal())
  renameSync(h.logPath, h.logPath + '.previous')
  writeFileSync(h.logPath, INFO('Starting minecraft server version 1.21.1') + INFO('Done (0.4s)! For help, type "help"'))
  h.state.online = false
  assert.equal((await h.world.endCampVisit({ id: h.request.id })).confirmed, true)
  assert.equal(h.commands.includes('player dafeiyu kill'), false)
})

test('unresolved asynchronous spawn remains fenced until exact evidence arrives', async t => {
  const h = fixture(t)
  h.state.spawnFailure = 'pending'
  await assert.rejects(h.world.startCampVisit(h.request, signal()), /timeout/u)
  await assert.rejects(h.world.endCampVisit({ id: h.request.id }), /end-unconfirmed/u)
  assert.equal(h.world.activityPresence().campVisitReady, false)
  h.state.online = true
  appendFileSync(h.logPath, INFO('dafeiyu[local] logged in with entity id 22 at (-11.5, 70.0, 32.5)'))
  assert.equal((await h.world.endCampVisit({ id: h.request.id })).confirmed, true)
  assert.equal(h.state.online, false)
})

test('Carpet Only fake players refusal never substitutes for offline evidence', async t => {
  const h = fixture(t)
  await h.world.startCampVisit(h.request, signal())
  h.state.killRefused = true
  await assert.rejects(h.world.endCampVisit({ id: h.request.id }), /end-unconfirmed/u)
  assert.equal(h.state.online, true)
  assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.id, h.request.id)
})

test('worker watchdog aborts expired authorization and gets the same idempotent logout receipt', async t => {
  const h = fixture(t)
  await h.world.startCampVisit(h.request, signal())
  h.world.visit.expiresAt = Date.now() - 1
  assert.throws(() => h.world.withCampAction(() => {}, h.request.id), /visit-refused/u)
  h.world.reapCampVisit()
  const receipt = await h.world.visitEnd
  assert.deepEqual(receipt, { visitId: h.request.id, online: false, confirmed: true })
  assert.deepEqual(await h.world.endCampVisit({ id: h.request.id }), receipt)
})

async function supplyFixture(t, allowSupply = true) {
  const h = fixture(t)
  const { world, request } = h
  await world.startCampVisit({ ...request, ...(allowSupply && { allowSupply: true }) }, signal())
  world.features.crafting = true
  const inventory = { logs: 3, planks: 1, otherPlanks: 0, strippedLogs: 0 }
  const state = { health: 20, food: 20, oxygen: 300, threat: 'NONE', position: center, dimension: zone.dimension,
    logsSpent: 1, planksMade: 4, claimedRecipe: 'minecraft:oak_planks', claimedMaterial: 'minecraft:oak_log×1', output: undefined, onCraft: undefined }
  const crafts = []
  world.observeInternal.mock.mockImplementation(async () => ({
    online: h.state.online, gameMode: 'survival', position: state.position, dimension: state.dimension,
    health: state.health, food: state.food, oxygen: state.oxygen, survival: { threat: state.threat }, action: world.action?.kind,
    inventory: Object.entries({ oak_log: inventory.logs, oak_planks: inventory.planks, birch_planks: inventory.otherPlanks, stripped_oak_log: inventory.strippedLogs })
      .filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
  }))
  t.mock.method(world, 'cbi', async (command, sender, _settle, completion, guarded, onDispatch) => {
    assert.equal(sender, 'dafeiyu')
    assert.ok(guarded instanceof AbortSignal)
    guarded.throwIfAborted()
    onDispatch?.()
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.supplyUsed, true)
    crafts.push(command)
    await state.onCraft?.()
    inventory.logs -= state.logsSpent
    inventory.planks += state.planksMade
    const actual = INFO(`CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] 合成完成 oak_planks×4，配方 ${state.claimedRecipe}，材料 ${state.claimedMaterial}"`)
    assert.match(actual, completion)
    return state.output ?? actual
  })
  const preview = (input = { zone }, id = request.id) => world.withCampAction(() => world.campVisitSupplyPreview(input, signal()), id)
  const craft = (input = { zone, recipe: 'oak_planks' }, abort = signal()) => world.withCampAction(() => world.campVisitSupply(input, abort), request.id)
  return { ...h, safety: state, inventory, crafts, preview, craft }
}

test('visit supply validates only bounded offers and exact paired inventory deltas', () => {
  const offer = { recipe: 'oak_planks', availableLogs: 3, planks: 7 }
  assert.equal(MinecraftVisitSupplyOffer.safeParse(offer).success, true)
  for (const change of [{ recipe: 'stick' }, { availableLogs: 2 }, { planks: 8 }, { inventory: [] }]) {
    assert.equal(MinecraftVisitSupplyOffer.safeParse({ ...offer, ...change }).success, false)
  }
  const receipt = { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
    inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 7, planksAfter: 11 } }
  assert.equal(MinecraftVisitSupplyReceipt.safeParse(receipt).success, true)
  for (const change of [{ logsAfter: 3 }, { logsAfter: 1 }, { planksAfter: 10 }, { planksBefore: 8 }, { health: 20 }]) {
    assert.equal(MinecraftVisitSupplyReceipt.safeParse({ ...receipt, inventory: { ...receipt.inventory, ...change } }).success, false)
  }
  assert.equal(MinecraftVisitSupplyReceipt.safeParse({ ...receipt, observation: {} }).success, false)
})

test('short visit stock stays unavailable without the explicit grant and correct zone and lease', async t => {
  const denied = await supplyFixture(t, false)
  await assert.rejects(denied.preview(), /supply-unavailable/u)
  await assert.rejects(denied.craft(), /supply-unavailable/u)
  assert.deepEqual(denied.crafts, [])
  const allowed = await supplyFixture(t)
  assert.throws(() => allowed.preview({ zone }, randomUUID()), /visit-refused/u)
  await assert.rejects(allowed.preview({ zone: { ...zone, x: zone.x + 1 } }), /visit-refused/u)
  await assert.rejects(allowed.preview({ zone, raw: true }), /visit-invalid-request/u)
  await assert.rejects(allowed.craft({ zone, recipe: 'stick' }), /visit-invalid-request/u)
  assert.deepEqual(allowed.crafts, [])
})

test('read-only supply preview returns no offer for low stock, full supply or unsafe camp', async t => {
  for (const scenario of [
    { name: 'two remaining logs', inventory: { logs: 2 } },
    { name: 'planks already sufficient across woods', inventory: { otherPlanks: 7 } },
    { name: 'an alternative vanilla ingredient is present', inventory: { strippedLogs: 1 } },
    { name: 'nearby threat', safety: { threat: 'HOSTILE' } },
    { name: 'health too low', safety: { health: 15 } },
    { name: 'off center', safety: { position: { ...center, x: center.x + 0.5 } } },
    { name: 'not grounded', actor: { onGround: 0 } },
  ]) await t.test(scenario.name, async t => {
    const h = await supplyFixture(t)
    Object.assign(h.inventory, scenario.inventory)
    Object.assign(h.safety, scenario.safety)
    Object.assign(h.state, scenario.actor)
    assert.equal(await h.preview(), null)
    await assert.rejects(h.craft(), /preconditions-changed/u)
    assert.deepEqual(h.crafts, [])
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.supplyUsed, undefined)
  })
})

test('actual craft claims its one action before dispatch, spends one log and excludes any survey', async t => {
  const h = await supplyFixture(t)
  assert.deepEqual(await h.preview(), { recipe: 'oak_planks', availableLogs: 3, planks: 1 })
  assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.supplyUsed, undefined)
  assert.deepEqual(await h.craft(), { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
    inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 1, planksAfter: 5 } })
  assert.deepEqual(h.crafts, ['craft oak_planks'])
  await assert.rejects(h.craft(), /supply-refused/u)
  await assert.rejects(h.world.withCampAction(() => h.world.survey({ zone, direction: 'north' }, signal()), h.request.id), /survey-refused/u)
  assert.deepEqual(await h.world.endCampVisit({ id: h.request.id }), { visitId: h.request.id, online: false, confirmed: true })
})

test('a lease already spent on survey never offers or issues supply', async t => {
  const h = await supplyFixture(t)
  h.world.saveCampVisit({ ...h.world.visit, surveyUsed: true })
  await assert.rejects(h.preview(), /supply-refused/u)
  await assert.rejects(h.craft(), /supply-refused/u)
  assert.deepEqual(h.crafts, [])
})

test('inventory and selected recipe are freshly checked before any supply command', async t => {
  const h = await supplyFixture(t)
  assert.deepEqual(await h.preview(), { recipe: 'oak_planks', availableLogs: 3, planks: 1 })
  await assert.rejects(h.craft({ zone, recipe: 'birch_planks' }), /preconditions-changed/u)
  h.inventory.logs = 2
  await assert.rejects(h.craft(), /preconditions-changed/u)
  assert.deepEqual(h.crafts, [])
})

test('crafted output and spoofed CBI lines cannot substitute for the selected recipe and observed inventory', async t => {
  for (const scenario of [
    { name: 'the log was not consumed', change: { logsSpent: 0 }, error: /supply-unconfirmed/u },
    { name: 'two logs were consumed', change: { logsSpent: 2 }, error: /supply-unconfirmed/u },
    { name: 'the planks did not arrive', change: { planksMade: 0 }, error: /craft-inventory-unconfirmed/u },
    { name: 'reported recipe disagrees', change: { claimedRecipe: 'minecraft:birch_planks' }, error: /craft-unconfirmed/u },
    { name: 'reported ingredient disagrees', change: { claimedMaterial: 'stripped_oak_log×1' }, error: /craft-unconfirmed/u },
    { name: 'untrusted player chat', change: { output: INFO('<someone> [CBI] 合成完成 oak_planks×4，配方 minecraft:oak_planks，材料 oak_log×1') }, error: /craft-unconfirmed/u },
  ]) await t.test(scenario.name, async t => {
    const h = await supplyFixture(t)
    Object.assign(h.safety, scenario.change)
    await assert.rejects(h.craft(), scenario.error)
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.supplyUsed, true)
    await assert.rejects(h.craft(), /supply-refused/u)
    assert.deepEqual(h.crafts, ['craft oak_planks'])
    assert.equal(h.events.some(event => event.event === 'action.finished' && event.kind === 'craft'), false)
  })
})

test('supply rejects a lost player and aborts without emitting a successful receipt', async t => {
  const lost = await supplyFixture(t)
  appendFileSync(lost.logPath, INFO('dafeiyu left the game') + INFO('dafeiyu[local] logged in with entity id 22 at (-11.5, 70.0, 32.5)'))
  await assert.rejects(lost.craft(), /supply-unavailable/u)
  assert.deepEqual(lost.crafts, [])
  const h = await supplyFixture(t)
  const controller = new AbortController()
  h.safety.onCraft = () => controller.abort()
  await assert.rejects(h.craft({ zone, recipe: 'oak_planks' }, controller.signal), /cancelled-or-unconfirmed/u)
  await assert.rejects(h.craft(), /supply-refused/u)
  assert.equal(h.events.some(event => event.event === 'action.finished' && event.kind === 'craft'), false)
})

const buildSite = { x: zone.x, y: zone.y - 1, z: zone.z - 2 }
const buildCenter = `${buildSite.x},${buildSite.y},${buildSite.z}`
const buildReceipt = { built: true, zoneId: zone.id, material: 'oak_planks', placedFloor: 8, placedTable: 1,
  inventory: { floorBefore: 12, floorAfter: 4, tablesBefore: 2, tablesAfter: 1 } }

async function buildFixture(t, allowBuild = true) {
  const h = fixture(t)
  const { world, request } = h
  await world.startCampVisit({ ...request, allowSupply: true, ...(allowBuild && { allowBuild: true }) }, signal())
  world.features.campBuilding = true
  world.features.crafting = true
  const inventory = { oak_planks: 12, birch_planks: 0, crafting_table: 2 }
  const safety = { health: 20, food: 20, oxygen: 300, threat: 'NONE', position: center,
    clear: true, caveAir: false, entities: false, badGround: '', badResult: '', spentFloor: 8, spentTable: 1,
    resultCenter: buildCenter, buildDispatched: false, onBuild: undefined }
  const checks = []
  const builds = []
  world.observeInternal.mock.mockImplementation(async () => ({
    online: h.state.online, gameMode: 'survival', position: safety.position, dimension: zone.dimension,
    health: safety.health, food: safety.food, oxygen: safety.oxygen, action: world.action?.kind,
    survival: { threat: safety.threat, ...(safety.buildDispatched && {
      build: 'SUCCEEDED', buildZone: zone.id, buildCenter, buildFloor: 8, buildTable: 1,
    }) },
    inventory: Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
  }))
  world.block.mock.mockImplementation(async (pos, expected, dimension) => {
    assert.equal(dimension, zone.dimension)
    const key = `${pos.x},${pos.y},${pos.z}`
    checks.push({ key, expected, result: safety.buildDispatched })
    if (!safety.buildDispatched) {
      if (pos.y > buildSite.y) return safety.clear && expected === (safety.caveAir ? 'minecraft:cave_air' : 'minecraft:air')
      return key !== safety.badGround && expected === 'minecraft:grass_block'
    }
    return key !== safety.badResult && (pos.y === zone.y ? expected === 'minecraft:oak_planks' : expected === 'minecraft:crafting_table')
  })
  h.state.onCommand = async command => {
    if (command.startsWith('execute in ') && command.includes('unless entity')) {
      return INFO(safety.entities ? 'Test failed' : 'Test passed')
    }
    if (command.includes('cbi buildcamp ')) {
      builds.push(command)
      const journal = JSON.parse(readFileSync(h.visitPath, 'utf8'))
      assert.equal(journal.active.buildUsed, true)
      assert.equal(journal.active.allowBuild, true)
      safety.buildDispatched = true
      inventory.oak_planks -= safety.spentFloor
      inventory.crafting_table -= safety.spentTable
      await safety.onBuild?.()
      return INFO(`CBI feedback sender=dafeiyu target=dafeiyu message="[CBI] 开始营地建造，区域 ${zone.id}，中心 ${safety.resultCenter.replaceAll(',', ', ')}，材料 oak_planks"`)
    }
    if (command.endsWith('cbi stop')) return INFO('[CBI] 已停止当前 cbi 任务')
    assert.fail('Unexpected command: ' + command)
  }
  const preview = (input = { zone }, id = request.id) => world.withCampAction(() => world.campVisitBuildPreview(input, signal()), id)
  const build = (input = { zone, material: 'oak_planks' }, abort = signal()) => world.withCampAction(() => world.campVisitBuild(input, abort), request.id)
  return { ...h, inventory, safety, checks, builds, preview, build }
}

test('visit build schemas reject raw fields, non-planks and inconsistent inventory receipt deltas', () => {
  const offer = { material: 'oak_planks', availableFloor: 8, workbenches: 1 }
  assert.equal(MinecraftVisitBuildOffer.safeParse(offer).success, true)
  for (const extra of [{ material: 'dirt' }, { availableFloor: 7 }, { workbenches: 0 }, { target: buildSite }]) {
    assert.equal(MinecraftVisitBuildOffer.safeParse({ ...offer, ...extra }).success, false)
  }
  assert.equal(MinecraftVisitBuildReceipt.safeParse(buildReceipt).success, true)
  for (const extra of [{ zoneId: 'invalid' }, { placedFloor: 7 }, { placedTable: 2 }, { target: buildSite }]) {
    assert.equal(MinecraftVisitBuildReceipt.safeParse({ ...buildReceipt, ...extra }).success, false)
  }
  for (const extra of [{ floorAfter: 5 }, { tablesAfter: 2 }, { health: 20 }]) {
    assert.equal(MinecraftVisitBuildReceipt.safeParse({ ...buildReceipt, inventory: { ...buildReceipt.inventory, ...extra } }).success, false)
  }
})

test('visit build is independently gated and rejects a mismatched zone, lease and additional request fields', async t => {
  const denied = await buildFixture(t, false)
  await assert.rejects(denied.preview(), /build-unavailable/u)
  await assert.rejects(denied.build(), /build-unavailable/u)
  const h = await buildFixture(t)
  assert.throws(() => h.preview({ zone }, randomUUID()), /visit-refused/u)
  await assert.rejects(h.preview({ zone: { ...zone, x: zone.x + 1 } }), /visit-refused/u)
  await assert.rejects(h.preview({ zone, target: buildSite }), /visit-invalid-request/u)
  await assert.rejects(h.build({ zone, material: 'oak_planks', prepare: true }), /visit-invalid-request/u)
  await assert.rejects(h.build({ zone, material: 'dirt' }), /visit-invalid-request/u)
  assert.deepEqual(denied.builds, [])
  assert.deepEqual(h.builds, [])
})

test('visit requires a safe real footprint and already held materials and rechecks both before dispatch', async t => {
  for (const scenario of [
    { name: 'mixed planks', inventory: { oak_planks: 7, birch_planks: 7 } },
    { name: 'missing table', inventory: { crafting_table: 0 } },
    { name: 'unloaded foundation', actor: { loaded: false } },
    { name: 'obstructed air', safety: { clear: false } },
    { name: 'occupying entity', safety: { entities: true } },
    { name: 'unsupported foundation corner', safety: { badGround: `${buildSite.x + 1},${buildSite.y},${buildSite.z + 1}` } },
    { name: 'too far from camp center', safety: { position: { ...center, z: center.z - 0.4 } } },
    { name: 'unsafe survival state', safety: { oxygen: 199 } },
    { name: 'airborne', actor: { onGround: 0 } },
  ]) await t.test(scenario.name, async t => {
    const h = await buildFixture(t)
    assert.ok(await h.preview())
    Object.assign(h.inventory, scenario.inventory)
    Object.assign(h.safety, scenario.safety)
    Object.assign(h.state, scenario.actor)
    assert.equal(await h.preview(), null)
    await assert.rejects(h.build(), /build-preconditions-changed/u)
    assert.deepEqual(h.builds, [])
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.buildUsed, undefined)
  })
})

test('visit build dispatch is fenced to the preview site, verifies nine placements and shares the persisted action allowance', async t => {
  const h = await buildFixture(t)
  assert.deepEqual(await h.preview(), { material: 'oak_planks', availableFloor: 12, workbenches: 2 })
  assert.equal(h.checks.filter(check => check.expected === 'minecraft:grass_block').length, 9)
  assert.equal(h.checks.filter(check => check.expected === 'minecraft:air').length, 27)
  assert.ok(h.commands.some(command => command.endsWith(`unless entity @e[x=${buildSite.x - 1},y=${zone.y},z=${buildSite.z - 1},dx=2,dy=2,dz=2]`)))
  assert.ok(h.commands.includes(`execute in ${zone.dimension} if loaded ${buildSite.x - 1} ${buildSite.y} ${buildSite.z - 1}`))
  assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.buildUsed, undefined)
  assert.deepEqual(await h.build(), buildReceipt)
  assert.deepEqual(h.builds, [`execute as dafeiyu at @s if dimension ${zone.dimension} positioned ${center.x} ${center.y} ${center.z} if entity @s[distance=..0.35] run tell dafeiyu cbi buildcamp ${zone.id} ${zone.dimension} ${zone.x} ${zone.y} ${buildSite.z} 2 oak_planks`])
  const placed = h.checks.filter(check => check.result)
  assert.equal(placed.length, 9)
  assert.equal(new Set(placed.map(check => check.key)).size, 9)
  assert.deepEqual(placed.filter(check => check.expected === 'minecraft:crafting_table'), [{ key: `${zone.x},${zone.y + 1},${buildSite.z}`, expected: 'minecraft:crafting_table', result: true }])
  await assert.rejects(h.build(), /build-refused/u)
  await assert.rejects(h.world.withCampAction(() => h.world.campVisitSupplyPreview({ zone }, signal()), h.request.id), /supply-refused/u)
  await assert.rejects(h.world.withCampAction(() => h.world.survey({ zone, direction: 'north' }, signal()), h.request.id), /survey-refused/u)
  assert.deepEqual(await h.world.endCampVisit({ id: h.request.id }), { visitId: h.request.id, online: false, confirmed: true })
})

test('earlier survey/supply use and lost player ownership both block visit construction', async t => {
  for (const action of ['survey', 'supply']) await t.test(action, async t => {
    const h = await buildFixture(t)
    h.world.saveCampVisit({ ...h.world.visit, [`${action}Used`]: true })
    await assert.rejects(h.preview(), /build-refused/u)
    await assert.rejects(h.build(), /build-refused/u)
    assert.deepEqual(h.builds, [])
  })
  const h = await buildFixture(t)
  appendFileSync(h.logPath, INFO('dafeiyu left the game') + INFO('dafeiyu[local] logged in with entity id 22 at (-11.5, 70.0, 32.5)'))
  await assert.rejects(h.build(), /build-unavailable/u)
  assert.deepEqual(h.builds, [])
})

test('changed build result, inventory or connection cannot become a success or permit another attempt', async t => {
  for (const scenario of [
    { name: 'reported center moved', change: { resultCenter: `${zone.x + 1},${buildSite.y},${buildSite.z}` }, error: /build-zone-unconfirmed/u },
    { name: 'unplaced floor block', change: { badResult: `${zone.x + 1},${zone.y},${buildSite.z}` }, error: /build-world-unconfirmed/u },
    { name: 'wrong table delta', change: { spentTable: 0 }, error: /build-inventory-unconfirmed/u },
    { name: 'lost ownership after dispatch', lost: true, error: /build-ownership-unconfirmed/u },
    { name: 'cancelled after dispatch', cancelled: true, error: /build-cancelled/u },
  ]) await t.test(scenario.name, async t => {
    const h = await buildFixture(t)
    const abort = new AbortController()
    Object.assign(h.safety, scenario.change)
    if (scenario.cancelled) h.safety.onBuild = () => abort.abort()
    if (scenario.lost) h.safety.onBuild = () => appendFileSync(h.logPath, INFO('dafeiyu left the game'))
    await assert.rejects(h.build(undefined, abort.signal), scenario.error)
    await assert.rejects(h.build(), /build-refused/u)
    assert.equal(h.builds.length, 1)
    if (scenario.lost) assert.equal(h.commands.some(command => command.endsWith('cbi stop')), false)
    assert.equal(h.events.some(event => event.event === 'action.finished' && event.kind === 'build'), false)
  })
})

async function revisitFixture(t, allowRevisit = true) {
  const h = fixture(t)
  const { world, request, state } = h
  await world.startCampVisit({ ...request, allowBuild: true, ...(allowRevisit && { allowRevisit: true }) }, signal())
  world.features.campBuilding = true
  world.features.crafting = true
  world.block.mock.restore()
  const reads = []
  const footprint = new Map()
  for (const x of [zone.x - 1, zone.x, zone.x + 1]) for (const z of [zone.z - 3, zone.z - 2, zone.z - 1]) {
    if (x !== zone.x || z !== zone.z - 2) footprint.set(`${x} ${zone.y} ${z}`, 'minecraft:oak_planks')
  }
  footprint.set(`${zone.x} ${zone.y + 1} ${zone.z - 2}`, 'minecraft:crafting_table')
  const matching = new Set(footprint.keys())
  world.observeInternal.mock.mockImplementation(async () => ({
    online: state.online, gameMode: 'survival', position: state.pos, dimension: zone.dimension,
    health: 20, food: 20, oxygen: 300, action: world.action?.kind, survival: { threat: state.threat }, inventory: [],
  }))
  state.onCommand = async command => {
    const check = /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) (minecraft:[a-z_]+)$/u.exec(command)
    assert.ok(check, command)
    const [, point, material] = check
    assert.equal(material, footprint.get(point), command)
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.revisitUsed, true)
    reads.push(point)
    return await state.onRevisitRead?.(point) ?? INFO(matching.has(point) ? 'Test passed' : 'Test failed')
  }
  const revisit = (input = { zone, material: 'oak_planks' }, id = request.id, abort = signal()) =>
    world.withCampAction(() => world.campVisitRevisit(input, abort), id)
  return { ...h, reads, footprint, matching, revisit }
}

test('revisit schemas restrict result to nine tested blocks and no internal fields', () => {
  assert.ok(MinecraftVisitRevisitRequest.safeParse({ zone, material: 'birch_planks' }).success)
  for (const change of [{ target: buildSite }, { material: 'stone' }, { prepare: true }]) {
    assert.equal(MinecraftVisitRevisitRequest.safeParse({ zone, material: 'oak_planks', ...change }).success, false)
  }
  const receipt = { zoneId: zone.id, material: 'oak_planks', checkedBlocks: 9, matchedBlocks: 0 }
  assert.ok(MinecraftVisitRevisitReceipt.safeParse(receipt).success)
  assert.ok(MinecraftVisitRevisitReceipt.safeParse({ ...receipt, matchedBlocks: 9 }).success)
  for (const change of [{ matchedBlocks: -1 }, { matchedBlocks: 10 }, { matchedBlocks: 3.5 }, { checkedBlocks: 8 }, { position: center }]) {
    assert.equal(MinecraftVisitRevisitReceipt.safeParse({ ...receipt, ...change }).success, false)
  }
})

test('revisit must be separately permitted and fenced to the same lease and zone without construction or supply', async t => {
  const invalid = fixture(t)
  for (const grant of [{ allowRevisit: true }, { allowRevisit: true, allowBuild: true, allowSupply: true }, { allowRevisit: false, allowBuild: true }]) {
    assert.throws(() => invalid.world.startCampVisit({ ...invalid.request, ...grant }, signal()), /visit-invalid-request/u)
  }
  const denied = await revisitFixture(t, false)
  await assert.rejects(denied.revisit(), /revisit-unavailable/u)
  const h = await revisitFixture(t)
  assert.throws(() => h.revisit(undefined, randomUUID()), /visit-refused/u)
  await assert.rejects(h.revisit({ zone: { ...zone, z: zone.z - 1 }, material: 'oak_planks' }), /visit-refused/u)
  await assert.rejects(h.revisit({ zone, material: 'oak_planks', target: buildSite }), /visit-invalid-request/u)
  await assert.rejects(h.world.withCampAction(() => h.world.campVisitBuildPreview({ zone }, signal()), h.request.id), /build-unavailable/u)
  await assert.rejects(h.world.withCampAction(() => h.world.campVisitBuild({ zone, material: 'oak_planks' }, signal()), h.request.id), /build-unavailable/u)
  await assert.rejects(h.world.withCampAction(() => h.world.campVisitSupply({ zone, recipe: 'oak_planks' }, signal()), h.request.id), /supply-unavailable/u)
  assert.deepEqual(h.reads, [])
  assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.revisitUsed, undefined)
})

test('revisit distinguishes intact, damaged and missing camps using all nine actual block checks and no writes', async t => {
  for (const matched of [9, 7, 0]) await t.test(`${matched}/9 matched`, async t => {
    const h = await revisitFixture(t)
    if (matched === 7) {
      h.matching.delete(`${zone.x - 1} ${zone.y} ${zone.z - 3}`)
      h.matching.delete(`${zone.x} ${zone.y + 1} ${zone.z - 2}`)
    } else if (matched === 0) h.matching.clear()
    const firstAction = h.commands.length
    assert.deepEqual(await h.revisit(), { zoneId: zone.id, material: 'oak_planks', checkedBlocks: 9, matchedBlocks: matched })
    assert.deepEqual(new Set(h.reads), new Set(h.footprint.keys()))
    assert.equal(h.reads.length, 9)
    assert.ok(h.commands.slice(firstAction).every(command => /\bif (?:loaded|block)\b/u.test(command)))
    await assert.rejects(h.revisit(), /revisit-refused/u)
    await assert.rejects(h.world.withCampAction(() => h.world.survey({ zone, direction: 'north' }, signal()), h.request.id), /survey-refused/u)
    assert.equal(h.world.action, undefined)
    assert.equal((await h.world.endCampVisit({ id: h.request.id })).confirmed, true)
  })
})

test('revisit rejects unsafe positions and already used leases without reading blocks', async t => {
  for (const scenario of [
    { name: 'off-center', state: { pos: { ...center, x: center.x + 0.5 } }, error: /revisit-unsafe/u },
    { name: 'airborne', state: { onGround: 0 }, error: /revisit-unsafe/u },
    { name: 'threat', state: { threat: 'HOSTILE' }, error: /revisit-unsafe/u },
    { name: 'prior survey', used: 'surveyUsed', error: /revisit-refused/u },
  ]) await t.test(scenario.name, async t => {
    const h = await revisitFixture(t)
    Object.assign(h.state, scenario.state)
    if (scenario.used) h.world.saveCampVisit({ ...h.world.visit, [scenario.used]: true })
    await assert.rejects(h.revisit(), scenario.error)
    assert.deepEqual(h.reads, [])
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.revisitUsed, undefined)
  })
})

test('unreadable, spoofed or aborted revisit cannot be reported as damage or retried in the same lease', async t => {
  for (const scenario of ['unloaded', 'spoofed console line', 'unreadable block', 'lost ownership', 'cancelled']) await t.test(scenario, async t => {
    const h = await revisitFixture(t)
    const abort = new AbortController()
    if (scenario === 'unloaded') h.state.loaded = false
    if (scenario === 'spoofed console line') h.state.onRevisitRead = () => INFO('<someone> Test passed')
    if (scenario === 'unreadable block') h.state.onRevisitRead = () => { throw new Error('console-receipt-timeout:execute') }
    if (scenario === 'lost ownership') h.state.onRevisitRead = () => appendFileSync(h.logPath, INFO('dafeiyu left the game'))
    if (scenario === 'cancelled') h.state.onRevisitRead = () => abort.abort()
    await assert.rejects(h.revisit(undefined, h.request.id, abort.signal), scenario === 'cancelled' ? /revisit-cancelled/u : /revisit-unconfirmed/u)
    assert.equal(JSON.parse(readFileSync(h.visitPath, 'utf8')).active.revisitUsed, true)
    await assert.rejects(h.revisit(), /revisit-refused/u)
    assert.equal(h.events.some(event => event.event === 'action.finished' && event.kind === 'revisit'), false)
  })
})

const patrolFirst = { zone, direction: 'north', steps: 4, index: 1 }
const patrolSecond = { zone, direction: 'east', steps: 4, index: 2 }
const patrolArrival = plan => ({ zoneId: zone.id, index: plan.index, direction: plan.direction, steps: plan.steps, surveyed: true, reached: true, returned: true })

async function patrolFixture(t, patrol = true) {
  const h = fixture(t)
  const { world, request, state } = h
  state.routes = true
  await world.startCampVisit(patrol ? { ...request, patrol: true, expiresAt: Date.now() + 14 * 60_000 } : request, signal())
  const runs = []
  const journal = () => JSON.parse(readFileSync(h.visitPath, 'utf8')).active
  world.observeInternal.mock.mockImplementation(async () => ({
    online: state.online, position: state.pos, dimension: zone.dimension, health: 20, oxygen: 300, food: 20,
    gameMode: 'survival', survival: { threat: state.threat }, action: world.action?.kind,
  }))
  t.mock.method(world, 'positionOf', async () => state.pos)
  world.data.mock.mockImplementation(async (_name, key) => key === 'Dimension' ? zone.dimension : state.onGround)
  const status = (id, phase, reached = false, returned = false, reason = '-') =>
    INFO(`CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] surveyroute id=${id} phase=${phase} reached=${reached} returned=${returned} reason=${reason} steps=4`)
  state.onCommand = async command => {
    const prefix = 'execute as dafeiyu run tell dafeiyu cbi surveyroute '
    assert.ok(command.startsWith(prefix), command)
    const [operation, id, dimension, x, y, z, radius, direction, steps] = command.slice(prefix.length).split(' ')
    if (operation === 'preview') return INFO('CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] surveyroute preview routes=north:4,east:4')
    if (operation === 'run') {
      runs.push(id)
      assert.deepEqual([dimension, Number(x), Number(y), Number(z), Number(radius), Number(steps)], [zone.dimension, zone.x, zone.y, zone.z, zone.radius, 4])
      assert.deepEqual(journal().patrolSegment, { index: runs.length, direction, state: 'dispatched' })
      assert.equal(world.activityPresence().action, 'patrol')
      await state.onPatrolDispatch?.()
      return status(id, 'outbound')
    }
    assert.ok(runs.includes(id), command)
    if (operation === 'cancel') return status(id, 'cancelled')
    assert.equal(operation, 'status')
    if (state.patrolResult === 'failed') return status(id, 'failed', false, false, 'survey-blocked')
    if (state.patrolResult === 'recovered') return status(id, 'recovered', false, true, 'survey-terrain-changed')
    return status(id, 'succeeded', true, true)
  }
  const segment = (plan, id = request.id, abort = signal()) => world.withCampAction(() => world.campVisitPatrolSegment(plan, abort), id)
  const preview = () => world.withCampAction(() => world.surveyPreview({ zone }, signal()), request.id)
  return { ...h, journal, runs, segment, preview }
}

test('patrol accepts only one bounded straight leg with its sequence number and validates truthful receipts', () => {
  assert.ok(MinecraftPatrolSegmentRequest.safeParse(patrolFirst).success)
  for (const change of [{ steps: 3 }, { steps: 5 }, { steps: undefined }, { index: 0 }, { index: 3 }, { trail: 'east-south' }, { direction: 'up' }]) {
    assert.equal(MinecraftPatrolSegmentRequest.safeParse({ ...patrolFirst, ...change }).success, false)
  }
  assert.ok(MinecraftPatrolSegmentReceipt.safeParse(patrolArrival(patrolFirst)).success)
  assert.ok(MinecraftPatrolSegmentReceipt.safeParse({ ...patrolArrival(patrolFirst), surveyed: false, reached: false, reason: 'survey-terrain-changed' }).success)
  for (const change of [{ returned: false }, { reached: false }, { reason: 'survey-terrain-changed' }, { target: center }, { index: 3 }]) {
    assert.equal(MinecraftPatrolSegmentReceipt.safeParse({ ...patrolArrival(patrolFirst), ...change }).success, false)
  }
})

test('only patrol may run for 15 minutes and incompatible grant flags or legacy CBI do not admit it', async t => {
  const h = fixture(t)
  for (const invalid of [
    { expiresAt: Date.now() + 6 * 60_000 }, { patrol: true, expiresAt: Date.now() + CAMP_PATROL_MAX_MS + 5000 },
    { patrol: false }, { patrol: true, allowBuild: true }, { patrol: true, allowSupply: true }, { patrol: true, allowBuild: true, allowRevisit: true },
  ]) assert.throws(() => h.world.startCampVisit({ ...h.request, ...invalid }, signal()), /visit-invalid-request/u)
  assert.deepEqual(h.commands, [])
  await assert.rejects(h.world.startCampVisit({ ...h.request, patrol: true }, signal()), /spawn-unsafe/u)
  await h.world.endCampVisit({ id: h.request.id })
  const legacy = await patrolFixture(t, false)
  await assert.rejects(legacy.segment(patrolFirst), /patrol-refused/u)
  assert.deepEqual(legacy.runs, [])
  const valid = await patrolFixture(t)
  assert.equal(valid.journal().patrol, true)
  assert.ok(valid.journal().expiresAt - Date.now() > 5 * 60_000)
})

test('patrol takes two different verified legs under the exact lease and preserves read-only previews', async t => {
  const h = await patrolFixture(t)
  assert.throws(() => h.segment(patrolFirst, randomUUID()), /visit-refused/u)
  await assert.rejects(h.segment({ ...patrolFirst, zone: { ...zone, x: zone.x - 1 } }), /visit-refused/u)
  await assert.rejects(h.segment(patrolSecond), /patrol-refused/u)
  assert.deepEqual(await h.preview(), { directions: ['north', 'east'], routes: [{ direction: 'north', steps: 4 }, { direction: 'east', steps: 4 }] })
  assert.equal(h.journal().patrolSegment, undefined)
  for (const [request, code] of [
    [() => h.world.survey({ zone, direction: 'north', steps: 4 }, signal()), /survey-refused/u],
    [() => h.world.campVisitSupplyPreview({ zone }, signal()), /supply-refused/u],
    [() => h.world.campVisitBuildPreview({ zone }, signal()), /build-refused/u],
    [() => h.world.campVisitRevisit({ zone, material: 'oak_planks' }, signal()), /revisit-refused/u],
  ]) await assert.rejects(h.world.withCampAction(request, h.request.id), code)
  assert.deepEqual(await h.segment(patrolFirst), patrolArrival(patrolFirst))
  assert.deepEqual(h.journal().patrolSegment, { index: 1, direction: 'north', state: 'completed' })
  await assert.rejects(h.segment(patrolFirst), /patrol-refused/u)
  await assert.rejects(h.segment({ ...patrolSecond, direction: 'north' }), /patrol-refused/u)
  assert.deepEqual((await h.preview()).directions, ['north', 'east'])
  assert.deepEqual(await h.segment(patrolSecond), patrolArrival(patrolSecond))
  assert.deepEqual(h.journal().patrolSegment, { index: 2, direction: 'east', state: 'completed' })
  assert.equal(new Set(h.runs).size, 2)
  await assert.rejects(h.segment(patrolSecond), /patrol-refused/u)
  assert.deepEqual(h.events.filter(event => event.event === 'action.finished' && event.kind === 'patrol').map(event => event.index), [1, 2])
  assert.equal((await h.world.endCampVisit({ id: h.request.id })).confirmed, true)
})

test('patrol recovery, failed return and cancellation never authorize a subsequent leg', async t => {
  for (const scenario of ['recovered', 'failed', 'off-center', 'airborne', 'lost ownership', 'cancelled']) await t.test(scenario, async t => {
    const h = await patrolFixture(t)
    const abort = new AbortController()
    h.state.patrolResult = scenario
    if (scenario === 'off-center') h.state.onPatrolDispatch = () => { h.state.pos = { ...center, x: center.x + 0.3 } }
    if (scenario === 'airborne') h.state.onPatrolDispatch = () => { h.state.onGround = 0 }
    if (scenario === 'lost ownership') h.state.onPatrolDispatch = () => appendFileSync(h.logPath, INFO('dafeiyu left the game'))
    if (scenario === 'cancelled') h.state.onPatrolDispatch = () => abort.abort()
    if (scenario === 'recovered') {
      assert.deepEqual(await h.segment(patrolFirst), { ...patrolArrival(patrolFirst), surveyed: false, reached: false, reason: 'survey-terrain-changed' })
      assert.equal(h.journal().patrolSegment.state, 'recovered')
    } else {
      const error = scenario === 'failed' ? /survey-blocked/u : scenario === 'cancelled' ? /survey-cancelled/u : /survey-return-unconfirmed/u
      await assert.rejects(h.segment(patrolFirst, h.request.id, abort.signal), error)
      assert.equal(h.journal().patrolSegment.state, 'dispatched')
    }
    await assert.rejects(h.segment(patrolFirst), /patrol-refused/u)
    await assert.rejects(h.segment(patrolSecond), /patrol-refused/u)
    assert.equal(h.runs.length, 1)
  })
})

test('a restarted worker loads the patrol journal but fences even a previously completed leg pending cleanup', async t => {
  const h = await patrolFixture(t)
  await h.segment(patrolFirst)
  const env = { COMPANION_MC_DATA_DIR: dirname(h.visitPath), COMPANION_MC_SERVER_ROOT: dirname(h.logPath), COMPANION_MC_BOT_NAME: 'dafeiyu', COMPANION_MC_OWNER: 'thyysummer' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  let restarted
  try {
    Object.assign(process.env, env)
    restarted = new CbiWorld()
    clearInterval(restarted.timer)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assert.deepEqual(restarted.visit.patrolSegment, h.journal().patrolSegment)
  assert.equal(restarted.view().capabilities.campVisitPatrol, true)
  assert.throws(() => restarted.withCampAction(() => restarted.campVisitPatrolSegment(patrolSecond, signal()), h.request.id), /visit-refused/u)
  assert.equal(restarted.activityPresence().campVisitReady, false)
})

const gatherRequest = { zone, direction: 'north', steps: 4 }
const gatherOffer = { direction: 'north', steps: 4, log: 'oak_log' }
const gatherReceipt = { ...gatherOffer, zoneId: zone.id, collected: 1, returned: true, inventoryBefore: 3, inventoryAfter: 4 }

async function gatherFixture(t, allowGather = true, projectGather = false) {
  const h = fixture(t)
  const { world, request, state } = h
  state.campGather = true
  const project = projectGather ? { projectGather: true, allowBuild: true, allowSupply: true } : {}
  await world.startCampVisit(allowGather ? { ...request, ...project, gather: true, expiresAt: Date.now() + 14 * 60_000 } : request, signal())
  world.features.crafting = true
  world.features.campBuilding = true
  state.gatherRoutes = 'north:4,east:4'
  const otherStock = projectGather ? [{ id: 'minecraft:crafting_table', count: 1 }, { id: 'minecraft:oak_planks', count: 4 }]
    : [{ id: 'minecraft:oak_planks', count: 63 }, { id: 'minecraft:spruce_log', count: 12 }]
  state.inventoryBefore = [...otherStock, { id: 'minecraft:oak_log', count: 1 }, { id: 'minecraft:oak_log', count: projectGather ? 1 : 2 }]
  state.inventoryAfter = [...otherStock, { id: 'minecraft:oak_log', count: 2 }, { id: 'minecraft:oak_log', count: projectGather ? 1 : 2 }]
  const runs = []
  const journal = () => JSON.parse(readFileSync(h.visitPath, 'utf8')).active
  world.observeInternal.mock.mockImplementation(async () => ({
    online: state.online, position: state.pos, dimension: zone.dimension, health: 20, oxygen: 300, food: 20,
    gameMode: 'survival', survival: { threat: state.threat }, action: world.action?.kind,
    inventory: state.inventoryBefore?.map(({ id, count }) => ({ name: id.replace(/^minecraft:/u, ''), count })),
  }))
  t.mock.method(world, 'positionOf', async () => state.pos)
  world.data.mock.mockImplementation(async (_name, key) => {
    if (key === 'Inventory') return runs.length ? state.inventoryAfter : state.inventoryBefore
    if (key === 'Dimension') return state.returnDimension ?? zone.dimension
    return state.onGround
  })
  const status = (id, phase, changed = false, picked = false, returned = false, reason = '-') =>
    INFO(`CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] campgather id=${id} phase=${phase} changed=${changed} picked=${picked} returned=${returned} reason=${reason}`)
  let polls = 0
  state.onCommand = async command => {
    if (command.startsWith('execute in minecraft:overworld unless entity ')) return INFO('Test passed')
    const prefix = 'execute as dafeiyu run tell dafeiyu cbi campgather '
    assert.ok(command.startsWith(prefix), command)
    const [operation, id, ...rest] = command.slice(prefix.length).split(' ')
    if (operation === 'preview') {
      assert.deepEqual([id, ...rest], [zone.dimension, zone.x, zone.y, zone.z, zone.radius].map(String))
      await state.onGatherPreview?.()
      return INFO(`CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] campgather preview routes=${state.gatherRoutes}`)
    }
    if (operation === 'run') {
      runs.push(id)
      assert.deepEqual(rest, [zone.dimension, zone.x, zone.y, zone.z, zone.radius, gatherRequest.direction, gatherRequest.steps].map(String))
      assert.equal(journal().gatherUsed, true)
      assert.equal(world.activityPresence().action, 'gather')
      await state.onGatherDispatch?.()
      return status(id, 'outbound')
    }
    assert.ok(runs.includes(id), command)
    if (operation === 'cancel') return status(id, 'cancelled', false, false, false, 'gather-cancelled')
    assert.equal(operation, 'status')
    if (state.gatherResult === 'failed') return status(id, 'failed', true, true, false, 'gather-return-blocked')
    if (state.gatherResult === 'recovered') return status(id, 'recovered', true, false, true, 'gather-no-pickup')
    if (state.gatherResult === 'false-success') return status(id, 'succeeded', true, false, true)
    if (state.gatherResult === 'spoof') return INFO('<someone> [CBI] campgather succeeded')
    if (state.gatherResult === 'regression') return ++polls === 1 ? status(id, 'returning', true, true) : status(id, 'gathering')
    return status(id, 'succeeded', true, true, true)
  }
  const gather = (plan = gatherRequest, id = request.id, abort = signal()) => world.withCampAction(() => world.campVisitGather(plan, abort), id)
  const preview = (plan = { zone }, id = request.id) => world.withCampAction(() => world.campVisitGatherPreview(plan, signal()), id)
  return { ...h, journal, runs, gather, preview }
}

test('camp gather schemas allow only a bounded oak route and one verified collected item', () => {
  assert.ok(MinecraftCampGatherRequest.safeParse(gatherRequest).success)
  assert.ok(MinecraftCampGatherOffer.safeParse(gatherOffer).success)
  assert.ok(MinecraftCampGatherReceipt.safeParse(gatherReceipt).success)
  for (const change of [{ steps: 3 }, { steps: 5 }, { direction: 'up' }, { target: center }, { log: 'oak_log' }]) {
    assert.equal(MinecraftCampGatherRequest.safeParse({ ...gatherRequest, ...change }).success, false)
  }
  for (const change of [{ log: 'birch_log' }, { collected: 2 }, { returned: false }, { inventoryBefore: -1 }, { inventoryAfter: 3 }, { inventoryAfter: 5 }, { target: center }]) {
    assert.equal(MinecraftCampGatherReceipt.safeParse({ ...gatherReceipt, ...change }).success, false)
  }
})

test('gather lease requires its own capability and excludes all other autonomous Minecraft actions', async t => {
  const h = fixture(t)
  for (const invalid of [
    { gather: false }, { gather: true, patrol: true }, { gather: true, allowSupply: true }, { gather: true, allowBuild: true },
    { gather: true, allowBuild: true, allowRevisit: true }, { gather: true, expiresAt: Date.now() + CAMP_GATHER_MAX_MS + 5000 },
  ]) assert.throws(() => h.world.startCampVisit({ ...h.request, ...invalid }, signal()), /visit-invalid-request/u)
  assert.deepEqual(h.commands, [])
  await assert.rejects(h.world.startCampVisit({ ...h.request, gather: true }, signal()), /gather-unavailable/u)
  await h.world.endCampVisit({ id: h.request.id })
  const legacy = await gatherFixture(t, false)
  await assert.rejects(legacy.preview(), /gather-refused/u)
  await assert.rejects(legacy.gather(), /gather-refused/u)
  const valid = await gatherFixture(t)
  assert.ok(valid.journal().expiresAt - Date.now() > 5 * 60_000)
  for (const [action, expected] of [
    [() => valid.world.surveyPreview({ zone }, signal()), /survey-refused/u],
    [() => valid.world.survey({ zone, direction: 'north' }, signal()), /survey-refused/u],
    [() => valid.world.campVisitSupplyPreview({ zone }, signal()), /supply-refused/u],
    [() => valid.world.campVisitBuildPreview({ zone }, signal()), /build-refused/u],
    [() => valid.world.campVisitRevisit({ zone, material: 'oak_planks' }, signal()), /revisit-refused/u],
    [() => valid.world.campVisitPatrolSegment(patrolFirst, signal()), /patrol-refused/u],
  ]) await assert.rejects(valid.world.withCampAction(action, valid.request.id), expected)
  assert.deepEqual(valid.runs, [])
})

test('gather preview matches the exact lease, discloses one current route and does not claim the action', async t => {
  const h = await gatherFixture(t)
  assert.throws(() => h.preview(undefined, randomUUID()), /visit-refused/u)
  await assert.rejects(h.preview({ zone: { ...zone, z: zone.z - 1 } }), /visit-refused/u)
  await assert.rejects(h.preview({ zone, direction: 'north' }), /visit-invalid-request/u)
  assert.deepEqual(await h.preview(), gatherOffer)
  h.state.gatherRoutes = '-'
  assert.equal(await h.preview(), null)
  h.state.gatherRoutes = 'north:4,north:4'
  await assert.rejects(h.preview(), /gather-preview-unconfirmed/u)
  h.state.gatherRoutes = 'north:5'
  await assert.rejects(h.preview(), /gather-preview-unconfirmed/u)
  h.state.gatherRoutes = 'east:4'
  await assert.rejects(h.gather(), /gather-preconditions-changed/u)
  assert.equal(h.journal().gatherUsed, undefined)
  assert.deepEqual(h.runs, [])
})

test('gather durably claims before dispatch, checks live inventory and returns to the exact camp once', async t => {
  const h = await gatherFixture(t)
  assert.deepEqual(await h.preview(), gatherOffer)
  assert.deepEqual(await h.gather(), gatherReceipt)
  assert.equal(h.runs.length, 1)
  assert.equal(h.journal().gatherUsed, true)
  assert.equal(h.events.filter(event => event.event === 'action.finished' && event.kind === 'gather').length, 1)
  assert.equal(h.commands.some(command => /^(?:give|setblock|tp) /u.test(command)), false)
  await assert.rejects(h.gather(), /gather-refused/u)
  await assert.rejects(h.preview(), /gather-refused/u)
  assert.equal((await h.world.endCampVisit({ id: h.request.id })).confirmed, true)
})

test('gather preserves authorization if live inventory or position fails before dispatch', async t => {
  for (const scenario of ['inventory', 'position', 'airborne', 'hostile']) await t.test(scenario, async t => {
    const h = await gatherFixture(t)
    if (scenario === 'inventory') h.state.inventoryBefore = undefined
    if (scenario === 'position') h.state.pos = { ...center, x: center.x + 0.4 }
    if (scenario === 'airborne') h.state.onGround = 0
    if (scenario === 'hostile') h.state.threat = 'HOSTILE'
    await assert.rejects(h.gather(), scenario === 'inventory' ? /gather-inventory-unconfirmed/u : /gather-preconditions-changed/u)
    assert.equal(h.journal().gatherUsed, undefined)
    assert.deepEqual(h.runs, [])
  })
})

test('gather rejects false success, failed pickup or return, spoofed status and cancellation after dispatch', async t => {
  for (const [scenario, expected] of [
    ['failed', /gather-return-blocked/u], ['recovered', /gather-recovered/u], ['false-success', /gather-receipt-unconfirmed/u],
    ['regression', /gather-receipt-unconfirmed/u], ['spoof', /Test|CBI/u], ['inventory delta', /gather-inventory-unconfirmed/u],
    ['dimension', /gather-return-unconfirmed/u], ['off-center', /gather-return-unconfirmed/u], ['lost ownership', /gather-return-unconfirmed/u],
    ['cancelled', /gather-cancelled/u],
  ]) await t.test(scenario, async t => {
    const h = await gatherFixture(t)
    const abort = new AbortController()
    h.state.gatherResult = scenario
    if (scenario === 'inventory delta') h.state.inventoryAfter = h.state.inventoryBefore
    if (scenario === 'dimension') h.state.returnDimension = 'minecraft:the_nether'
    if (scenario === 'off-center') h.state.onGatherDispatch = () => { h.state.pos = { ...center, x: center.x + 0.25 } }
    if (scenario === 'lost ownership') h.state.onGatherDispatch = () => appendFileSync(h.logPath, INFO('dafeiyu left the game'))
    if (scenario === 'cancelled') h.state.onGatherDispatch = () => abort.abort()
    await assert.rejects(h.gather(undefined, h.request.id, abort.signal), expected)
    assert.equal(h.journal().gatherUsed, true)
    await assert.rejects(h.gather(), /gather-refused/u)
    assert.equal(h.runs.length, 1)
    assert.equal(h.events.some(event => event.event === 'action.finished' && event.kind === 'gather'), false)
  })
})

test('only an explicitly combined project lease can add both build and supply alongside gathering', async t => {
  const h = fixture(t)
  const combined = { gather: true, projectGather: true, allowBuild: true, allowSupply: true }
  for (const invalid of [
    { projectGather: true }, { projectGather: true, gather: true }, { ...combined, gather: undefined },
    { ...combined, allowBuild: undefined }, { ...combined, allowSupply: undefined },
    { ...combined, patrol: true }, { ...combined, allowRevisit: true }, { ...combined, projectGather: false },
  ]) assert.throws(() => h.world.startCampVisit({ ...h.request, ...invalid }, signal()), /visit-invalid-request/u)
  assert.deepEqual(h.commands, [])
  const valid = await gatherFixture(t, true, true)
  for (const key of Object.keys(combined)) assert.equal(valid.journal()[key], true)
  assert.deepEqual(await valid.preview(), gatherOffer)
  assert.equal(valid.journal().gatherUsed, undefined)
})

test('project gathering is skipped when the actual workbench, plank count, oak reserve or precise recipe disqualifies it', async t => {
  for (const [name, change] of [
    ['workbench missing', inventory => inventory.filter(item => item.id !== 'minecraft:crafting_table')],
    ['mixed planks meet target', inventory => [...inventory, { id: 'minecraft:spruce_planks', count: 4 }]],
    ['three oak logs even with ambiguous variant', inventory => [...inventory, { id: 'minecraft:oak_log', count: 1 }, { id: 'minecraft:oak_wood', count: 1 }]],
    ['exact recipe from another wood', inventory => [...inventory, { id: 'minecraft:spruce_log', count: 3 }]],
  ]) await t.test(name, async t => {
    const h = await gatherFixture(t, true, true)
    h.state.inventoryBefore = change(h.state.inventoryBefore)
    const prior = h.commands.length
    assert.equal(await h.preview(), null)
    assert.equal(h.commands.length, prior)
    await assert.rejects(h.gather(), /gather-preconditions-changed/u)
    assert.deepEqual(h.runs, [])
    assert.equal(h.journal().gatherUsed, undefined)
  })
})

test('project can gather only one oak log when other wood variants prevent an exact craft', async t => {
  const h = await gatherFixture(t, true, true)
  h.state.inventoryBefore.push({ id: 'minecraft:spruce_log', count: 3 }, { id: 'minecraft:stripped_spruce_log', count: 1 })
  assert.deepEqual(await h.preview(), gatherOffer)
  assert.deepEqual(await h.gather(), { ...gatherReceipt, inventoryBefore: 2, inventoryAfter: 3 })
  assert.equal(h.journal().gatherUsed, true)
  await assert.rejects(h.gather(), /gather-refused/u)
  for (const [action, expected] of [
    [() => h.world.campVisitSupply({ zone, recipe: 'oak_planks' }, signal()), /supply-refused/u],
    [() => h.world.campVisitBuild({ zone, material: 'oak_planks' }, signal()), /build-refused/u],
    [() => h.world.survey({ zone, direction: 'north' }, signal()), /survey-refused/u],
  ]) await assert.rejects(h.world.withCampAction(action, h.request.id), expected)
})

test('project gathering rechecks raw inventory after the fresh route check before claiming', async t => {
  const h = await gatherFixture(t, true, true)
  assert.deepEqual(await h.preview(), gatherOffer)
  h.state.onGatherPreview = () => { h.state.inventoryBefore.push({ id: 'minecraft:birch_log', count: 3 }) }
  await assert.rejects(h.gather(), /gather-preconditions-changed/u)
  assert.deepEqual(h.runs, [])
  assert.equal(h.journal().gatherUsed, undefined)
})

test('project lease can choose live craft or construction instead and prior actions exclude gather', async t => {
  const h = await gatherFixture(t, true, true)
  h.state.inventoryBefore.push({ id: 'minecraft:spruce_log', count: 3 })
  assert.deepEqual(await h.world.withCampAction(() => h.world.campVisitSupplyPreview({ zone }, signal()), h.request.id),
    { recipe: 'spruce_planks', availableLogs: 3, planks: 4 })
  assert.equal(await h.preview(), null)
  h.state.inventoryBefore.push({ id: 'minecraft:oak_planks', count: 4 })
  assert.deepEqual(await h.world.withCampAction(() => h.world.campVisitBuildPreview({ zone }, signal()), h.request.id),
    { material: 'oak_planks', availableFloor: 8, workbenches: 1 })
  for (const spent of ['surveyUsed', 'supplyUsed', 'buildUsed']) {
    const untouched = await gatherFixture(t, true, true)
    untouched.world.saveCampVisit({ ...untouched.world.visit, [spent]: true })
    await assert.rejects(untouched.preview(), /gather-refused/u)
    await assert.rejects(untouched.gather(), /gather-refused/u)
  }
})
