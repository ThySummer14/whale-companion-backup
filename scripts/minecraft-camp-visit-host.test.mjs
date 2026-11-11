import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

async function fixture(t, radius = 8) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-camp-visit-host-')
  const store = new CompanionStore(join(directory, 'companion.sqlite'))
  const visitId = randomUUID()
  const { id, dimension, x, y, z } = store.createBuildZone({ name: '测试营地', dimension: 'minecraft:overworld', x: 6, y: 80, z: -8, radius })
  const zone = { id, dimension, x, y, z, radius }
  const calls = []
  const state = {
    presence: { online: false, campVisitReady: true },
    status: { online: false, auth: { mode: 'cbi' }, capabilities: { campSurvey: true, campVisitGather: true } },
    start: () => ({ visitId, online: true, atCamp: true }),
    end: () => ({ visitId, online: false, confirmed: true }),
    supplyOffer: () => ({ recipe: 'oak_planks', availableLogs: 3, planks: 0 }),
    supplyReceipt: () => ({ crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
      inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 0, planksAfter: 4 } }),
    buildOffer: () => ({ material: 'oak_planks', availableFloor: 8, workbenches: 1 }),
    buildReceipt: () => ({ built: true, zoneId: id, material: 'oak_planks', placedFloor: 8, placedTable: 1,
      inventory: { floorBefore: 8, floorAfter: 0, tablesBefore: 1, tablesAfter: 0 } }),
    revisitReceipt: () => ({ zoneId: id, material: 'oak_planks', checkedBlocks: 9, matchedBlocks: 9 }),
    patrolReceipt: ({ index, direction, steps }) => ({ zoneId: id, index, direction, steps, surveyed: true, reached: true, returned: true }),
    gatherOffer: () => ({ direction: 'north', steps: 4, log: 'oak_log' }),
    gatherReceipt: ({ direction, steps }) => ({ zoneId: id, direction, steps, log: 'oak_log', collected: 1, returned: true, inventoryBefore: 2, inventoryAfter: 3 }),
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const path = new URL(request.url, 'http://localhost').pathname.slice('/api'.length)
      const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
      calls.push({ path, data, method: request.method, auth: request.headers.authorization, lease: request.headers['x-companion-camp-visit'] })
      const finish = value => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(value))
      }
      if (path === '/events') finish({ items: [], presence: state.presence })
      else if (path === '') finish(state.status)
      else if (path === '/camp/visit/start') finish(await state.start())
      else if (path === '/camp/visit/end') finish(await state.end())
      else if (path === '/camp/visit/supply-preview') finish(await state.supplyOffer())
      else if (path === '/camp/visit/supply') finish(await state.supplyReceipt())
      else if (path === '/camp/visit/build-preview') finish(await state.buildOffer())
      else if (path === '/camp/visit/build') finish(await state.buildReceipt())
      else if (path === '/camp/visit/revisit') finish(await state.revisitReceipt())
      else if (path === '/camp/visit/patrol-segment') finish(await state.patrolReceipt(data))
      else if (path === '/camp/visit/gather-preview') finish(await state.gatherOffer())
      else if (path === '/camp/visit/gather') finish(await state.gatherReceipt(data))
      else if (path === '/survey-preview') finish({ directions: ['east'], routes: [{ direction: 'east', steps: 5 }], trails: ['east-south'] })
      else if (path === '/survey') finish(data.trail
        ? { zoneId: id, trail: data.trail, checkpoints: 2, outcome: 'completed', returned: true }
        : { zoneId: id, direction: data.direction, steps: data.steps, surveyed: true, reached: true, returned: true })
      else if (path === '/connect' || path === '/disconnect' || path === '/stop') finish({})
      else { response.statusCode = 404; finish({ error: 'unexpected-path' }) }
    } catch {
      response.statusCode = 500
      response.end('{"error":"fixture-failed"}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const sessions = { async create(input) { store.bindContext({ ...input, sessionId: 'test-game-session' }) } }
  const service = new MinecraftService(store, sessions, { dataDir: directory, serverRoot: directory, owner: 'owner', workerPort: server.address().port })
  service.ready = true
  service.token = 'local-fixture'
  const abort = new AbortController()
  const expiresAt = Date.now() + 90_000
  await service.refreshEvents()
  return { calls, state, service, store, zone, visitId, expiresAt, abort,
    start: (allowSupply, allowBuild, allowRevisit, mode) => service.startCampVisit(visitId, id, expiresAt, abort.signal, allowSupply, allowBuild, allowRevisit, mode),
    end: () => service.endCampVisit(visitId),
    inspectSupply: () => service.inspectVisitSupply(id, visitId, abort.signal),
    supply: (recipe = 'oak_planks') => service.supplyOnVisit(id, recipe, visitId, abort.signal),
    inspectBuild: () => service.inspectVisitBuild(id, visitId, abort.signal),
    build: (material = 'oak_planks') => service.buildOnVisit(id, material, visitId, abort.signal),
    revisit: (material = 'oak_planks') => service.revisitOnVisit(id, material, visitId, abort.signal),
    patrol: (direction, steps, index) => service.patrolSegment(id, direction, steps, index, visitId, abort.signal),
    inspectGather: () => service.inspectVisitGather(id, visitId, abort.signal),
    gather: (offer = { direction: 'north', steps: 4, log: 'oak_log' }) => service.gatherOnVisit(id, offer, visitId, abort.signal) }
}

test('camp visit dispatch sends the exact authorized zone and lease and binds the game on a real start receipt', async t => {
  const h = await fixture(t)
  assert.equal(h.service.campVisitReady(Date.now()), true)
  assert.deepEqual(await h.start(), { visitId: h.visitId, online: true, atCamp: true })
  assert.equal(h.service.campVisitReady(Date.now()), false)
  assert.equal(h.store.bindingByContext('game.minecraft').sessionId, 'test-game-session')
  assert.deepEqual(h.calls.slice(1), [{ path: '/camp/visit/start', method: 'POST', auth: 'Bearer local-fixture', lease: undefined,
    data: { id: h.visitId, zone: h.zone, expiresAt: h.expiresAt } }])
})

test('stale presence, an online player, old worker and pending normal action cannot authorize a short visit', async t => {
  const h = await fixture(t)
  const observedAt = h.service.campVisitReadyAt
  assert.equal(h.service.campVisitReady(observedAt - 1), false)
  assert.equal(h.service.campVisitReady(observedAt + 4_999), true)
  assert.equal(h.service.campVisitReady(observedAt + 5_000), false)
  for (const presence of [{ online: true, campVisitReady: true }, { online: false }, { online: false, campVisitReady: true, action: 'follow' }]) {
    h.state.presence = presence
    await h.service.refreshEvents()
    await assert.rejects(h.start(), { code: 'minecraft-camp-visit-unavailable' })
  }
  h.state.presence = { online: false, campVisitReady: true }
  await h.service.refreshEvents()
  const task = h.store.createTask({ capabilityId: 'minecraft.follow', contextId: 'game.minecraft', title: '手动跟随' })
  h.store.transitionTask(task.id, 'running')
  await assert.rejects(h.start(), { code: 'minecraft-camp-visit-unavailable' })
  assert.ok(h.calls.every(item => item.path === '/events'))
})

test('invalid permit, revoked zone and malformed positive start receipts do not create a game session', async t => {
  const h = await fixture(t)
  const start = (id, time) => h.service.startCampVisit(id, h.zone.id, time, h.abort.signal)
  await assert.rejects(start('unverified', h.expiresAt), { code: 'minecraft-camp-visit-invalid-permit' })
  await assert.rejects(start(h.visitId, Date.now() - 1), { code: 'minecraft-camp-visit-invalid-permit' })
  await assert.rejects(start(h.visitId, Date.now() + 360_000), { code: 'minecraft-camp-visit-invalid-permit' })
  for (const receipt of [{ visitId: randomUUID(), online: true, atCamp: true }, { visitId: h.visitId, online: true }]) {
    h.state.start = () => receipt
    await h.service.refreshEvents()
    await assert.rejects(h.start(), { code: 'minecraft-camp-visit-start-unconfirmed' })
  }
  assert.equal(h.store.bindingByContext('game.minecraft'), undefined)
  await h.service.refreshEvents()
  h.store.revokeBuildZone(h.zone.id)
  await assert.rejects(h.start(), { code: 'minecraft-camp-visit-unavailable' })
  assert.equal(h.calls.filter(item => item.path === '/camp/visit/start').length, 2)
})

test('a late valid join response cannot override pause or revocation, and exact lease cleanup still works', async t => {
  const h = await fixture(t)
  const before = Promise.withResolvers()
  const joined = Promise.withResolvers()
  h.state.start = () => { before.resolve(); return joined.promise }
  const start = h.start()
  await before.promise
  h.store.revokeBuildZone(h.zone.id)
  h.store.saveMinecraftCampControl({ pairedPauseEnabled: true, pausedAt: new Date().toISOString() })
  joined.resolve({ visitId: h.visitId, online: true, atCamp: true })
  await assert.rejects(start, { code: 'minecraft-camp-paused' })
  assert.equal(h.store.bindingByContext('game.minecraft'), undefined)
  await assert.rejects(h.start(), { code: 'minecraft-camp-paused' })
  assert.deepEqual(await h.end(), { visitId: h.visitId, online: false, confirmed: true })
  assert.deepEqual(h.calls.at(-1), { path: '/camp/visit/end', method: 'POST', auth: 'Bearer local-fixture', lease: undefined,
    data: { id: h.visitId } })
})

test('an offline view, wrong lease or ambiguous cleanup is never a confirmed logout', async t => {
  const h = await fixture(t)
  for (const response of [{ online: false }, { visitId: randomUUID(), online: false, confirmed: true },
    { visitId: h.visitId, online: true, confirmed: true }, { visitId: h.visitId, online: false, confirmed: false }]) {
    h.state.end = () => response
    await assert.rejects(h.end(), { code: 'minecraft-camp-visit-end-unconfirmed' })
  }
  await assert.rejects(h.service.endCampVisit('bad-id'), { code: 'minecraft-camp-visit-invalid-permit' })
  h.service.homeActiveAt = Date.now()
  h.state.end = () => ({ visitId: h.visitId, online: false, confirmed: true })
  await h.end()
  await h.end()
  assert.equal(h.service.homeActive(Date.now()), true, 'replaying a historical lease must not mark a later manual session offline')
})

test('only actual survey routes receive the visit credential and manual survey keeps its original request', async t => {
  const h = await fixture(t)
  h.state.status.online = true
  const controller = new AbortController()
  await h.service.inspectCampSurvey(h.zone.id, controller.signal, h.visitId)
  const { task } = await h.service.surveyCamp(h.zone.id, 'east', controller.signal, 5, h.visitId)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.externalId, 'minecraft-visit-survey:' + h.visitId)
  assert.equal(h.store.taskByExternalId(task.externalId).id, task.id)
  await assert.rejects(h.service.surveyCamp(h.zone.id, 'east', controller.signal, 5, h.visitId), { code: 'minecraft-camp-visit-survey-used' })
  assert.equal(h.calls.filter(call => call.path === '/survey').length, 1)
  for (const call of h.calls.slice(1)) assert.equal(call.lease, call.path.startsWith('/survey') ? h.visitId : undefined)
  const nextVisit = randomUUID()
  const { result } = await h.service.surveyTrail(h.zone.id, 'east-south', controller.signal, nextVisit)
  assert.equal(result.checkpoints, 2)
  assert.equal(h.calls.at(-1).lease, nextVisit)
  const begin = h.calls.length
  await h.service.surveyCamp(h.zone.id, 'east', controller.signal, 5)
  assert.ok(h.calls.slice(begin).every(item => item.lease === undefined))
})

test('opted-in supply persists the exact real recipe and inventory receipt atomically under its visit', async t => {
  const h = await fixture(t)
  await h.start(true)
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: h.expiresAt, allowSupply: true })
  assert.equal(h.calls.at(-1).lease, undefined)
  assert.deepEqual(await h.inspectSupply(), h.state.supplyOffer())
  const { task, result } = await h.supply()
  assert.equal(task.status, 'succeeded')
  assert.equal(task.capabilityId, 'minecraft.craft')
  assert.equal(task.externalId, `minecraft-visit-supply:${h.visitId}`)
  assert.deepEqual(result, h.state.supplyReceipt())
  assert.deepEqual(h.calls.at(-1), { path: '/camp/visit/supply', method: 'POST', auth: 'Bearer local-fixture', lease: h.visitId,
    data: { zone: h.zone, recipe: 'oak_planks' } })
  assert.equal(h.calls.filter(call => call.path === '/camp/visit/supply-preview').length, 2)
  assert.ok(h.calls.filter(call => call.path === '/camp/visit/supply-preview').every(call => call.lease === h.visitId))
  const activity = h.store.activities().find(item => item.kind === 'world.visit-supply')
  assert.equal(activity.eventId, `${task.externalId}:receipt`)
  assert.equal(activity.contextId, 'autonomy.daily-visit')
  assert.equal(activity.sessionId, undefined)
  assert.equal(activity.taskId, task.id)
  assert.deepEqual(activity.data, { receipt: result })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
  assert.equal(await h.inspectSupply(), undefined)
  assert.equal(h.calls.filter(call => call.path === '/camp/visit/supply').length, 1)
})

test('a normal visit, mismatched zone or expired supply permission never makes a Worker offer request', async t => {
  const ordinary = await fixture(t)
  await ordinary.start()
  assert.equal(await ordinary.inspectSupply(), undefined)
  await assert.rejects(ordinary.supply(), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  const h = await fixture(t)
  await h.start(true)
  assert.equal(await h.service.inspectVisitSupply(h.zone.id, randomUUID(), h.abort.signal), undefined)
  assert.equal(await h.service.inspectVisitSupply(randomUUID(), h.visitId, h.abort.signal), undefined)
  h.service.visitActionPermit.expiresAt = Date.now()
  assert.equal(await h.inspectSupply(), undefined)
  assert.ok([...ordinary.calls, ...h.calls].every(call => !call.path.includes('/visit/supply')))
})

test('an unavailable or unverified offer does not authorize crafting', async t => {
  const h = await fixture(t)
  await h.start(true)
  h.state.supplyOffer = () => null
  assert.equal(await h.inspectSupply(), undefined)
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  h.state.supplyOffer = () => ({ recipe: 'oak_planks', availableLogs: 2, planks: 0 })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-offer-unconfirmed' })
  h.state.supplyOffer = () => ({ recipe: 'oak_planks', availableLogs: 3, planks: 0 })
  await assert.rejects(h.supply('spruce_planks'), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  assert.equal(h.calls.filter(call => call.path === '/camp/visit/supply').length, 0)
  assert.equal(h.store.tasks().filter(task => task.capabilityId === 'minecraft.craft').length, 0)
})

test('a false receipt fails its one scoped attempt and publishes no material evidence', async t => {
  for (const [title, modify] of Object.entries({
    'changed recipe': result => { result.name = 'spruce_planks' },
    'wrong log delta': result => { result.inventory.logsAfter = 3 },
    'wrong plank delta': result => { result.inventory.planksAfter = 5 },
    'unexpected raw inventory': result => { result.observation = { inventory: [] } },
  })) {
    await t.test(title, async child => {
      const h = await fixture(child)
      const response = h.state.supplyReceipt()
      modify(response)
      h.state.supplyReceipt = () => response
      await h.start(true)
      await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-unconfirmed' })
      assert.equal(h.store.taskByExternalId(`minecraft-visit-supply:${h.visitId}`).status, 'failed')
      assert.equal(h.store.activities().some(item => item.kind === 'world.visit-supply'), false)
      await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
      assert.equal(h.calls.filter(call => call.path === '/camp/visit/supply').length, 1)
    })
  }
})

test('survey and supply claim one shared action slot for a visit', async t => {
  const h = await fixture(t)
  await h.start(true)
  h.state.status.online = true
  await h.service.surveyCamp(h.zone.id, 'east', h.abort.signal, 5, h.visitId)
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
  assert.ok(h.calls.every(call => !call.path.includes('/visit/supply')))
  const another = await fixture(t)
  await another.start(true)
  another.state.status.online = true
  await another.supply()
  await assert.rejects(another.service.surveyCamp(another.zone.id, 'east', another.abort.signal, 5, another.visitId),
    { code: 'minecraft-camp-visit-survey-used' })
  assert.ok(another.calls.every(call => call.path !== '/survey'))
})

test('revocation after the offer request and ending a visit during a craft invalidate late positive responses', async t => {
  const revoked = await fixture(t)
  await revoked.start(true)
  const previewSent = Promise.withResolvers()
  const offerReturned = Promise.withResolvers()
  revoked.state.supplyOffer = () => { previewSent.resolve(); return offerReturned.promise }
  const pendingPreview = revoked.supply()
  const rejectedPreview = assert.rejects(pendingPreview, { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  await previewSent.promise
  revoked.store.revokeBuildZone(revoked.zone.id)
  offerReturned.resolve({ recipe: 'oak_planks', availableLogs: 3, planks: 0 })
  await rejectedPreview
  assert.ok(revoked.calls.every(call => call.path !== '/camp/visit/supply'))

  const ended = await fixture(t)
  await ended.start(true)
  const craftSent = Promise.withResolvers()
  const craftReturned = Promise.withResolvers()
  const response = ended.state.supplyReceipt()
  ended.state.supplyReceipt = () => { craftSent.resolve(); return craftReturned.promise }
  const pendingCraft = ended.supply()
  const rejectedCraft = assert.rejects(pendingCraft, { code: 'minecraft-camp-visit-supply-cancelled' })
  await craftSent.promise
  await ended.end()
  craftReturned.resolve(response)
  await rejectedCraft
  assert.equal(ended.store.taskByExternalId(`minecraft-visit-supply:${ended.visitId}`).status, 'cancelled')
  assert.equal(ended.store.activities().some(item => item.kind === 'world.visit-supply'), false)
})

test('a late start response cannot restore supply authorization after ending its lease', async t => {
  const h = await fixture(t)
  const sent = Promise.withResolvers()
  const joined = Promise.withResolvers()
  h.state.start = () => { sent.resolve(); return joined.promise }
  const pending = h.start(true)
  const rejected = assert.rejects(pending, { code: 'minecraft-camp-visit-permit-ended' })
  await sent.promise
  await h.end()
  joined.resolve({ visitId: h.visitId, online: true, atCamp: true })
  await rejected
  assert.equal(await h.inspectSupply(), undefined)
  assert.ok(h.calls.every(call => !call.path.includes('/visit/supply')))
})

test('the mobile camp view reports supply using its existing craft state without a raw visit receipt', async t => {
  const h = await fixture(t)
  h.state.status = { online: true, auth: { mode: 'cbi' }, action: 'supply', inventory: [{ name: 'oak_log', count: 3 }] }
  const view = await h.service.campView()
  assert.equal(view.action, 'craft')
  assert.equal(view.connection, 'online')
  assert.equal(Object.hasOwn(view, 'inventory'), false)
})

test('short-visit building requires its own confirmed opt-in and commits a private receipt', async t => {
  const h = await fixture(t)
  await h.start(undefined, true)
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: h.expiresAt, allowBuild: true })
  assert.equal(await h.inspectSupply(), undefined)
  assert.equal(await h.service.inspectVisitBuild(h.zone.id, randomUUID(), h.abort.signal), undefined)
  assert.equal(await h.service.inspectVisitBuild(randomUUID(), h.visitId, h.abort.signal), undefined)
  assert.deepEqual(await h.inspectBuild(), h.state.buildOffer())
  const { task, result } = await h.build()
  assert.equal(task.capabilityId, 'minecraft.build')
  assert.equal(task.status, 'succeeded')
  assert.equal(task.externalId, `minecraft-visit-build:${h.visitId}`)
  assert.deepEqual(result, h.state.buildReceipt())
  assert.deepEqual(h.calls.at(-1), { path: '/camp/visit/build', method: 'POST', auth: 'Bearer local-fixture',
    lease: h.visitId, data: { zone: h.zone, material: 'oak_planks' } })
  const previews = h.calls.filter(call => call.path === '/camp/visit/build-preview')
  assert.equal(previews.length, 2)
  assert.ok(previews.every(call => call.lease === h.visitId && call.data.zone.id === h.zone.id))
  const activity = h.store.activityByEventId(`${task.externalId}:receipt`)
  assert.equal(activity.kind, 'world.visit-build')
  assert.equal(activity.contextId, 'autonomy.daily-visit')
  assert.equal(activity.source, 'game.minecraft')
  assert.equal(activity.sessionId, undefined)
  assert.equal(activity.taskId, task.id)
  assert.deepEqual(activity.data, { receipt: result })
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/supply-preview'))
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-used' })
  assert.equal(await h.inspectBuild(), undefined)
})

test('permission, revocation, false offers and a changed material block dispatch', async t => {
  const ordinary = await fixture(t)
  await ordinary.start(true)
  assert.equal(await ordinary.inspectBuild(), undefined)
  await assert.rejects(ordinary.build(), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  assert.ok(ordinary.calls.every(call => !call.path.includes('/visit/build')))

  const h = await fixture(t)
  await h.start(undefined, true)
  h.state.buildOffer = () => null
  assert.equal(await h.inspectBuild(), undefined)
  h.state.buildOffer = () => ({ material: 'oak_planks', availableFloor: 7, workbenches: 1 })
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-offer-unconfirmed' })
  h.state.buildOffer = () => ({ material: 'oak_planks', availableFloor: 8, workbenches: 1 })
  await assert.rejects(h.build('spruce_planks'), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  const previewSent = Promise.withResolvers()
  const offerReturned = Promise.withResolvers()
  h.state.buildOffer = () => { previewSent.resolve(); return offerReturned.promise }
  const blocked = assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  await previewSent.promise
  h.store.revokeBuildZone(h.zone.id)
  offerReturned.resolve({ material: 'oak_planks', availableFloor: 8, workbenches: 1 })
  await blocked
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/build'))
  assert.equal(h.store.taskByExternalId(`minecraft-visit-build:${h.visitId}`), undefined)
})

test('building and survey or supply consume the same one-action slot in both orders', async t => {
  for (const preceding of ['build', 'survey', 'supply']) {
    await t.test(preceding, async child => {
      const h = await fixture(child)
      await h.start(true, true)
      h.state.status.online = true
      const survey = () => h.service.surveyTrail(h.zone.id, 'east-south', h.abort.signal, h.visitId)
      await ({ build: h.build, survey, supply: h.supply })[preceding]()
      await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-used' })
      await assert.rejects(survey(), { code: 'minecraft-camp-visit-survey-used' })
      await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
      assert.equal(h.calls.filter(call => ['/camp/visit/build', '/survey', '/camp/visit/supply'].includes(call.path)).length, 1)
    })
  }
})

test('concurrent build and supply requests cannot both reach the Worker', async t => {
  const h = await fixture(t)
  await h.start(true, true)
  const bothPreviews = Promise.withResolvers()
  let previews = 0
  for (const name of ['buildOffer', 'supplyOffer']) {
    const value = h.state[name]()
    h.state[name] = async () => {
      if (++previews === 2) bothPreviews.resolve()
      await bothPreviews.promise
      return value
    }
  }
  const results = await Promise.allSettled([h.build(), h.supply()])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.match(results.find(item => item.status === 'rejected').reason.code, /minecraft-camp-visit-(?:supply|build)-(?:used|preconditions-changed)/u)
  assert.equal(h.calls.filter(call => ['/camp/visit/build', '/camp/visit/supply'].includes(call.path)).length, 1)
})

test('false builds and late positive replies produce no durable build evidence', async t => {
  for (const [name, alter] of [
    ['different zone', value => { value.zoneId = randomUUID() }],
    ['different wood', value => { value.material = 'spruce_planks' }],
    ['incorrect floor', value => { value.placedFloor = 7 }],
    ['incorrect inventory delta', value => { value.inventory.tablesAfter = 1 }],
    ['raw world data', value => { value.observation = { x: 6 } }],
  ]) {
    await t.test(name, async child => {
      const h = await fixture(child)
      await h.start(undefined, true)
      const response = h.state.buildReceipt()
      alter(response)
      h.state.buildReceipt = () => response
      await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-unconfirmed' })
      const externalId = `minecraft-visit-build:${h.visitId}`
      assert.equal(h.store.taskByExternalId(externalId).status, 'failed')
      assert.equal(h.store.activityByEventId(`${externalId}:receipt`), undefined)
      await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-used' })
    })
  }
  const h = await fixture(t)
  await h.start(undefined, true)
  const buildSent = Promise.withResolvers()
  const buildReturned = Promise.withResolvers()
  const response = h.state.buildReceipt()
  h.state.buildReceipt = () => { buildSent.resolve(); return buildReturned.promise }
  const rejected = assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-cancelled' })
  await buildSent.promise
  await h.end()
  buildReturned.resolve(response)
  await rejected
  const externalId = `minecraft-visit-build:${h.visitId}`
  assert.equal(h.store.taskByExternalId(externalId).status, 'cancelled')
  assert.equal(h.store.activityByEventId(`${externalId}:receipt`), undefined)
})

test('a failure to persist the private build receipt rolls back game success', async t => {
  const h = await fixture(t)
  await h.start(undefined, true)
  const record = h.store.recordActivity.bind(h.store)
  h.store.recordActivity = input => {
    if (input.kind === 'world.visit-build') throw new Error('fixture-receipt-write-failed')
    return record(input)
  }
  await assert.rejects(h.build(), /fixture-receipt-write-failed/u)
  const externalId = `minecraft-visit-build:${h.visitId}`
  const task = h.store.taskByExternalId(externalId)
  assert.equal(task.status, 'failed')
  assert.equal(h.store.activityByEventId(`${externalId}:receipt`), undefined)
  assert.equal(h.store.activities().some(item => item.taskId === task.id && item.kind === 'task.succeeded'), false)
})

test('paired camp status reports an authorized build without exposing raw coordinates', async t => {
  const h = await fixture(t)
  h.state.status = { online: true, auth: { mode: 'cbi' }, action: 'build-authorized', position: { x: 6, y: 80, z: -8 } }
  const view = await h.service.campView()
  assert.equal(view.action, 'build')
  assert.equal(view.connection, 'online')
  assert.equal(Object.hasOwn(view, 'position'), false)
  h.state.status.action = 'revisit'
  assert.equal((await h.service.campView()).action, 'revisit')
})

test('a revisit needs the read-only grant and its active visit identity', async t => {
  const h = await fixture(t)
  await assert.rejects(h.start(undefined, undefined, true), { code: 'minecraft-camp-visit-invalid-permit' })
  await assert.rejects(h.start(true, true, true), { code: 'minecraft-camp-visit-invalid-permit' })
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/start'))
  await h.start(undefined, true, true)
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: h.expiresAt, allowBuild: true, allowRevisit: true })
  await assert.rejects(h.service.revisitOnVisit(h.zone.id, 'oak_planks', randomUUID(), h.abort.signal),
    { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  await assert.rejects(h.service.revisitOnVisit(randomUUID(), 'oak_planks', h.visitId, h.abort.signal),
    { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  assert.equal(await h.inspectBuild(), undefined)
  assert.equal(await h.inspectSupply(), undefined)
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  h.service.visitActionPermit.expiresAt = Date.now()
  await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  assert.ok(h.calls.every(call => !/\/visit\/(?:build|supply|revisit)/u.test(call.path)))

  const building = await fixture(t)
  await building.start(undefined, true)
  await assert.rejects(building.revisit(), { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  assert.ok(building.calls.every(call => call.path !== '/camp/visit/revisit'))
})

test('intact, partial and absent camps all commit a private nine-block observation', async t => {
  for (const matchedBlocks of [9, 8, 0]) {
    await t.test(String(matchedBlocks), async child => {
      const h = await fixture(child)
      const expected = { ...h.state.revisitReceipt(), matchedBlocks }
      h.state.revisitReceipt = () => expected
      await h.start(undefined, true, true)
      const { task, result } = await h.revisit()
      assert.equal(task.capabilityId, 'minecraft.survey')
      assert.equal(task.status, 'succeeded')
      assert.equal(task.externalId, `minecraft-visit-revisit:${h.visitId}`)
      assert.deepEqual(result, expected)
      assert.deepEqual(h.calls.at(-1), { path: '/camp/visit/revisit', method: 'POST', auth: 'Bearer local-fixture',
        lease: h.visitId, data: { zone: h.zone, material: 'oak_planks' } })
      const activity = h.store.activityByEventId(`${task.externalId}:receipt`)
      assert.equal(activity.kind, 'world.visit-revisit')
      assert.equal(activity.contextId, 'autonomy.daily-visit')
      assert.equal(activity.source, 'game.minecraft')
      assert.equal(activity.sessionId, undefined)
      assert.equal(activity.taskId, task.id)
      assert.deepEqual(activity.data, { receipt: expected })
      await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-used' })
      await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-used' })
      await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
      await assert.rejects(h.service.surveyTrail(h.zone.id, 'east-south', h.abort.signal, h.visitId), { code: 'minecraft-camp-visit-survey-used' })
    })
  }
})

test('an ordinary survey consumes the same read-only action slot as revisiting', async t => {
  const h = await fixture(t)
  await h.start(undefined, true, true)
  h.state.status.online = true
  await h.service.surveyCamp(h.zone.id, 'east', h.abort.signal, 5, h.visitId)
  await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-used' })
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/revisit'))
})

test('false or late revisit receipts cannot report completed observation', async t => {
  for (const [name, change] of [
    ['wrong site', receipt => { receipt.zoneId = randomUUID() }],
    ['wrong material', receipt => { receipt.material = 'spruce_planks' }],
    ['missing block query', receipt => { receipt.checkedBlocks = 8 }],
    ['impossible matched count', receipt => { receipt.matchedBlocks = 10 }],
    ['raw coordinates', receipt => { receipt.position = { x: 6, y: 80, z: -8 } }],
  ]) {
    await t.test(name, async child => {
      const h = await fixture(child)
      const response = h.state.revisitReceipt()
      change(response)
      h.state.revisitReceipt = () => response
      await h.start(undefined, true, true)
      await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-unconfirmed' })
      const externalId = `minecraft-visit-revisit:${h.visitId}`
      assert.equal(h.store.taskByExternalId(externalId).status, 'failed')
      assert.equal(h.store.activityByEventId(`${externalId}:receipt`), undefined)
    })
  }
  const h = await fixture(t)
  await h.start(undefined, true, true)
  const sent = Promise.withResolvers()
  const returned = Promise.withResolvers()
  const response = h.state.revisitReceipt()
  h.state.revisitReceipt = () => { sent.resolve(); return returned.promise }
  const rejected = assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-cancelled' })
  await sent.promise
  await h.end()
  returned.resolve(response)
  await rejected
  const externalId = `minecraft-visit-revisit:${h.visitId}`
  assert.equal(h.store.taskByExternalId(externalId).status, 'cancelled')
  assert.equal(h.store.activityByEventId(`${externalId}:receipt`), undefined)
})

test('only a patrol lease allows up to fifteen minutes and is exclusive of existing visit actions', async t => {
  const h = await fixture(t)
  const start = (deadline, supply, build, revisit, patrol) =>
    h.service.startCampVisit(h.visitId, h.zone.id, deadline, h.abort.signal, supply, build, revisit, patrol)
  const tenMinutes = Date.now() + 10 * 60_000
  await assert.rejects(start(tenMinutes), { code: 'minecraft-camp-visit-invalid-permit' })
  await assert.rejects(start(Date.now() + 16 * 60_000, undefined, undefined, undefined, true), { code: 'minecraft-camp-visit-invalid-permit' })
  for (const [supply, build, revisit] of [[true], [undefined, true], [undefined, true, true]]) {
    await assert.rejects(start(h.expiresAt, supply, build, revisit, true), { code: 'minecraft-camp-visit-invalid-permit' })
  }
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/start'))
  await start(tenMinutes, undefined, undefined, undefined, true)
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: tenMinutes, patrol: true })
  h.state.status.online = true
  assert.ok((await h.service.inspectCampSurvey(h.zone.id, h.abort.signal, h.visitId)).routes.length)
  await assert.rejects(h.service.surveyCamp(h.zone.id, 'east', h.abort.signal, 5, h.visitId), { code: 'minecraft-camp-visit-patrol-exclusive' })
  await assert.rejects(h.service.surveyTrail(h.zone.id, 'east-south', h.abort.signal, h.visitId), { code: 'minecraft-camp-visit-patrol-exclusive' })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  assert.ok(h.calls.every(call => !['/survey', '/camp/visit/supply', '/camp/visit/build', '/camp/visit/revisit'].includes(call.path)))
  const ordinary = await fixture(t)
  await ordinary.start(undefined, true, true)
  await assert.rejects(ordinary.patrol('east', 4, 1), { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
})

test('patrol enforces the exact zone, step budget, index order and different return directions', async t => {
  const h = await fixture(t)
  await h.start(undefined, undefined, undefined, true)
  await assert.rejects(h.patrol('east', 4, 2), { code: 'minecraft-camp-visit-patrol-order' })
  await assert.rejects(h.service.patrolSegment(randomUUID(), 'east', 4, 1, h.visitId, h.abort.signal),
    { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
  await assert.rejects(h.service.patrolSegment(h.zone.id, 'east', 4, 1, randomUUID(), h.abort.signal),
    { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
  for (const [direction, steps, index] of [['east', 3, 1], ['east', 8, 1], ['east', 4, 3], ['up', 4, 1]]) {
    await assert.rejects(h.patrol(direction, steps, index), { code: 'minecraft-camp-visit-invalid-request' })
  }
  const first = await h.patrol('east', 4, 1)
  await assert.rejects(h.patrol('east', 4, 1), { code: 'minecraft-camp-visit-patrol-used' })
  await assert.rejects(h.patrol('east', 4, 2), { code: 'minecraft-camp-visit-patrol-direction-used' })
  const second = await h.patrol('north', 5, 2)
  await assert.rejects(h.patrol('south', 4, 2), { code: 'minecraft-camp-visit-patrol-used' })
  for (const { task, result } of [first, second]) {
    assert.equal(task.capabilityId, 'minecraft.survey')
    assert.equal(task.status, 'succeeded')
    assert.equal(task.externalId, `minecraft-visit-patrol:${h.visitId}:${result.index}`)
    const activity = h.store.activityByEventId(`${task.externalId}:receipt`)
    assert.equal(activity.kind, 'world.patrol-segment')
    assert.equal(activity.contextId, 'autonomy.daily-visit')
    assert.equal(activity.source, 'game.minecraft')
    assert.equal(activity.sessionId, undefined)
    assert.equal(activity.taskId, task.id)
    assert.deepEqual(activity.data, { receipt: result })
  }
  assert.deepEqual(h.calls.filter(call => call.path === '/camp/visit/patrol-segment'), [
    { path: '/camp/visit/patrol-segment', method: 'POST', auth: 'Bearer local-fixture', lease: h.visitId, data: { zone: h.zone, direction: 'east', steps: 4, index: 1 } },
    { path: '/camp/visit/patrol-segment', method: 'POST', auth: 'Bearer local-fixture', lease: h.visitId, data: { zone: h.zone, direction: 'north', steps: 5, index: 2 } },
  ])
  h.state.status = { online: true, auth: { mode: 'cbi' }, action: 'patrol' }
  assert.equal((await h.service.campView()).action, 'patrol')
  const tight = await fixture(t, 5)
  await tight.start(undefined, undefined, undefined, true)
  await assert.rejects(tight.patrol('east', 5, 1), { code: 'minecraft-camp-visit-invalid-request' })
})

test('a recovered first segment stores an actual return but cannot start a second segment', async t => {
  const h = await fixture(t)
  const normal = h.state.patrolReceipt
  h.state.patrolReceipt = data => ({ ...normal(data), surveyed: false, reached: false, reason: 'survey-terrain-changed' })
  await h.start(undefined, undefined, undefined, true)
  const { task, result } = await h.patrol('east', 4, 1)
  assert.equal(task.status, 'succeeded')
  assert.equal(result.surveyed, false)
  assert.deepEqual(h.store.activityByEventId(task.externalId + ':receipt').data, { receipt: result })
  await assert.rejects(h.patrol('north', 4, 2), { code: 'minecraft-camp-visit-patrol-order' })
  assert.equal(h.calls.filter(call => call.path === '/camp/visit/patrol-segment').length, 1)
})

test('wrong or late patrol receipts cannot record a return, authorize another segment, or be replayed', async t => {
  for (const [name, change] of [
    ['wrong site', receipt => { receipt.zoneId = randomUUID() }],
    ['wrong direction', receipt => { receipt.direction = 'south' }],
    ['wrong index', receipt => { receipt.index = 2 }],
    ['wrong steps', receipt => { receipt.steps = 5 }],
    ['no return', receipt => { receipt.returned = false }],
    ['raw position', receipt => { receipt.position = { x: 6, y: 80, z: -8 } }],
  ]) {
    await t.test(name, async child => {
      const h = await fixture(child)
      const valid = h.state.patrolReceipt
      h.state.patrolReceipt = data => {
        const receipt = valid(data)
        change(receipt)
        return receipt
      }
      await h.start(undefined, undefined, undefined, true)
      await assert.rejects(h.patrol('east', 4, 1), { code: 'minecraft-camp-visit-patrol-unconfirmed' })
      const externalId = `minecraft-visit-patrol:${h.visitId}:1`
      assert.equal(h.store.taskByExternalId(externalId).status, 'failed')
      assert.equal(h.store.activityByEventId(externalId + ':receipt'), undefined)
      await assert.rejects(h.patrol('east', 4, 1), { code: 'minecraft-camp-visit-patrol-used' })
      await assert.rejects(h.patrol('north', 4, 2), { code: 'minecraft-camp-visit-patrol-order' })
    })
  }
  const h = await fixture(t)
  await h.start(undefined, undefined, undefined, true)
  const sent = Promise.withResolvers()
  const returned = Promise.withResolvers()
  const valid = h.state.patrolReceipt
  h.state.patrolReceipt = async data => { sent.resolve(); await returned.promise; return valid(data) }
  const rejected = assert.rejects(h.patrol('east', 4, 1), { code: 'minecraft-camp-visit-patrol-cancelled' })
  await sent.promise
  await assert.rejects(h.patrol('north', 4, 1), { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
  await h.end()
  returned.resolve()
  await rejected
  const externalId = `minecraft-visit-patrol:${h.visitId}:1`
  assert.equal(h.store.taskByExternalId(externalId).status, 'cancelled')
  assert.equal(h.store.activityByEventId(externalId + ':receipt'), undefined)
  assert.equal(h.calls.filter(call => call.path === '/camp/visit/patrol-segment').length, 1)
})

test('gather uses an exclusive extended lease and refuses an older Worker before login', async t => {
  const h = await fixture(t)
  const long = Date.now() + 10 * 60_000
  for (const [supply, build, revisit] of [[true], [undefined, true], [undefined, true, true]]) {
    await assert.rejects(h.start(supply, build, revisit, 'gather'), { code: 'minecraft-camp-visit-invalid-permit' })
  }
  await assert.rejects(h.service.startCampVisit(h.visitId, h.zone.id, Date.now() + 16 * 60_000, h.abort.signal,
    undefined, undefined, undefined, 'gather'), { code: 'minecraft-camp-visit-invalid-permit' })
  h.state.status.capabilities.campVisitGather = false
  await assert.rejects(h.start(undefined, undefined, undefined, 'gather'), { code: 'minecraft-camp-visit-gather-unavailable' })
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/start'))
  h.state.status.capabilities.campVisitGather = true
  await h.service.startCampVisit(h.visitId, h.zone.id, long, h.abort.signal, undefined, undefined, undefined, 'gather')
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: long, gather: true })
  h.state.status.online = true
  assert.equal(await h.service.inspectCampSurvey(h.zone.id, h.abort.signal, h.visitId), undefined)
  assert.equal(await h.service.inspectCampSurvey(h.zone.id, h.abort.signal), undefined)
  await assert.rejects(h.service.surveyCamp(h.zone.id, 'north', h.abort.signal, 4, h.visitId), { code: 'minecraft-camp-visit-gather-exclusive' })
  await assert.rejects(h.service.surveyTrail(h.zone.id, 'north-east', h.abort.signal), { code: 'minecraft-camp-visit-gather-exclusive' })
  await assert.rejects(h.patrol('north', 4, 1), { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-preconditions-changed' })
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-preconditions-changed' })
  await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  assert.ok(h.calls.every(call => ['/events', '', '/camp/visit/start'].includes(call.path)))
  const ordinary = await fixture(t)
  await ordinary.start(undefined, undefined, undefined, true)
  assert.equal(await ordinary.inspectGather(), undefined)
  await assert.rejects(ordinary.gather(), { code: 'minecraft-camp-visit-gather-preconditions-changed' })
})

test('gather stores only the exact authorized receipt and spends one visit action', async t => {
  const h = await fixture(t)
  await h.start(undefined, undefined, undefined, 'gather')
  const offer = await h.inspectGather()
  assert.deepEqual(offer, h.state.gatherOffer())
  const { task, result } = await h.gather(offer)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.capabilityId, 'minecraft.dig')
  assert.equal(task.externalId, `minecraft-visit-gather:${h.visitId}`)
  const activity = h.store.activityByEventId(task.externalId + ':receipt')
  assert.equal(activity.contextId, 'autonomy.daily-visit')
  assert.equal(activity.source, 'game.minecraft')
  assert.equal(activity.kind, 'world.visit-gather')
  assert.equal(activity.taskId, task.id)
  assert.equal(activity.sessionId, undefined)
  assert.deepEqual(activity.data, { receipt: result })
  assert.deepEqual(result, h.state.gatherReceipt(offer))
  assert.deepEqual(h.calls.slice(-2), [
    { path: '/camp/visit/gather-preview', method: 'POST', auth: 'Bearer local-fixture', lease: h.visitId, data: { zone: h.zone } },
    { path: '/camp/visit/gather', method: 'POST', auth: 'Bearer local-fixture', lease: h.visitId,
      data: { zone: h.zone, direction: 'north', steps: 4 } },
  ])
  assert.ok(h.calls.every(call => call.path !== '/lessons'))
  assert.equal(await h.inspectGather(), undefined)
  await assert.rejects(h.gather(offer), { code: 'minecraft-camp-visit-gather-used' })
  h.state.status = { online: true, auth: { mode: 'cbi' }, action: 'gather' }
  assert.equal((await h.service.campView()).action, 'gather')
})

test('a long project lease shares one action between its authorized material choices', async t => {
  const h = await fixture(t)
  for (const [supply, build, revisit] of [[true], [undefined, true], [true, true, true]]) {
    await assert.rejects(h.start(supply, build, revisit, 'project-gather'), { code: 'minecraft-camp-visit-invalid-permit' })
  }
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/start'))
  const until = Date.now() + 10 * 60_000
  await h.service.startCampVisit(h.visitId, h.zone.id, until, h.abort.signal, true, true, undefined, 'project-gather')
  assert.deepEqual(h.calls.at(-1).data, { id: h.visitId, zone: h.zone, expiresAt: until,
    allowSupply: true, allowBuild: true, gather: true, projectGather: true })
  assert.deepEqual(await h.inspectSupply(), h.state.supplyOffer())
  assert.deepEqual(await h.inspectBuild(), h.state.buildOffer())
  h.state.status.online = true
  assert.ok((await h.service.inspectCampSurvey(h.zone.id, h.abort.signal, h.visitId)).routes.length)
  await assert.rejects(h.revisit(), { code: 'minecraft-camp-visit-revisit-preconditions-changed' })
  await assert.rejects(h.patrol('north', 4, 1), { code: 'minecraft-camp-visit-patrol-preconditions-changed' })
  const offer = await h.inspectGather()
  assert.deepEqual(offer, h.state.gatherOffer())
  assert.equal((await h.gather(offer)).task.status, 'succeeded')
  assert.equal(h.calls.at(-1).lease, h.visitId)
  assert.deepEqual(h.calls.at(-1).data, { zone: h.zone, direction: 'north', steps: 4 })
  await assert.rejects(h.supply(), { code: 'minecraft-camp-visit-supply-used' })
  await assert.rejects(h.build(), { code: 'minecraft-camp-visit-build-used' })
  await assert.rejects(h.service.surveyCamp(h.zone.id, 'east', h.abort.signal, 5, h.visitId), { code: 'minecraft-camp-visit-survey-used' })

  const supplied = await fixture(t)
  await supplied.start(true, true, undefined, 'project-gather')
  await supplied.supply()
  assert.equal(await supplied.inspectGather(), undefined)
  await assert.rejects(supplied.gather(), { code: 'minecraft-camp-visit-gather-used' })
  assert.ok(supplied.calls.every(call => !call.path.includes('/visit/gather')))
})

test('gather declines unavailable, out-of-zone and malformed offers', async t => {
  const h = await fixture(t, 5)
  await h.start(undefined, undefined, undefined, 'gather')
  h.state.gatherOffer = () => null
  assert.equal(await h.inspectGather(), undefined)
  h.state.gatherOffer = () => ({ direction: 'north', steps: 5, log: 'oak_log' })
  await assert.rejects(h.inspectGather(), { code: 'minecraft-camp-visit-gather-offer-unconfirmed' })
  await assert.rejects(h.gather(h.state.gatherOffer()), { code: 'minecraft-camp-visit-invalid-request' })
  h.state.gatherOffer = () => ({ direction: 'north', steps: 4, log: 'oak_log', position: {} })
  await assert.rejects(h.inspectGather(), { code: 'minecraft-camp-visit-gather-offer-unconfirmed' })
  await assert.rejects(h.gather(h.state.gatherOffer()), { code: 'minecraft-camp-visit-invalid-request' })
  assert.equal(await h.service.inspectVisitGather(randomUUID(), h.visitId, h.abort.signal), undefined)
  assert.equal(await h.service.inspectVisitGather(h.zone.id, randomUUID(), h.abort.signal), undefined)
  assert.ok(h.calls.every(call => call.path !== '/camp/visit/gather'))
  h.service.visitActionPermit.expiresAt = Date.now()
  await assert.rejects(h.gather(), { code: 'minecraft-camp-visit-gather-preconditions-changed' })
})

test('false and late gather receipts cannot certify a harvested item or return', async t => {
  for (const [name, alter] of [
    ['different zone', receipt => { receipt.zoneId = randomUUID() }],
    ['different direction', receipt => { receipt.direction = 'east' }],
    ['different length', receipt => { receipt.steps = 5 }],
    ['different wood', receipt => { receipt.log = 'spruce_log' }],
    ['wrong inventory change', receipt => { receipt.inventoryAfter = 4 }],
    ['missing return', receipt => { receipt.returned = false }],
    ['raw observation', receipt => { receipt.observation = {} }],
  ]) {
    await t.test(name, async child => {
      const h = await fixture(child)
      const original = h.state.gatherReceipt
      h.state.gatherReceipt = data => {
        const receipt = original(data)
        alter(receipt)
        return receipt
      }
      await h.start(undefined, undefined, undefined, 'gather')
      await assert.rejects(h.gather(), { code: 'minecraft-camp-visit-gather-unconfirmed' })
      const key = `minecraft-visit-gather:${h.visitId}`
      assert.equal(h.store.taskByExternalId(key).status, 'failed')
      assert.equal(h.store.activityByEventId(key + ':receipt'), undefined)
      await assert.rejects(h.gather(), { code: 'minecraft-camp-visit-gather-used' })
    })
  }
  const h = await fixture(t)
  const original = h.state.gatherReceipt
  const dispatched = Promise.withResolvers()
  const released = Promise.withResolvers()
  h.state.gatherReceipt = async data => { dispatched.resolve(); await released.promise; return original(data) }
  await h.start(undefined, undefined, undefined, 'gather')
  const denied = assert.rejects(h.gather(), { code: 'minecraft-camp-visit-gather-cancelled' })
  await dispatched.promise
  await assert.rejects(h.gather(), { code: 'minecraft-camp-visit-gather-used' })
  await h.end()
  released.resolve()
  await denied
  const key = `minecraft-visit-gather:${h.visitId}`
  assert.equal(h.store.taskByExternalId(key).status, 'cancelled')
  assert.equal(h.store.activityByEventId(key + ':receipt'), undefined)
})
