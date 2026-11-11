import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { dailyHouseSupplyFact } from '../src/core/daily-house-project-proof.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SUPPLY_CAPABILITY, HOUSE_PROJECT_SUPPLY_EVENT } from '../src/core/minecraft-house-project.ts'
import { DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { DeviceAuthError } from '../src/host/devices.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

const signal = new AbortController().signal
const layout = { width: 5, height: 4, depth: 5, blocks: 'o'.repeat(40) + 's'.repeat(20) + 'c'.repeat(10) + 'g'.repeat(5) + '.'.repeat(25) }
const ready = { ready: true, checked: 100 }
const oakShortage = { material: 'oak_planks', needed: 35, carried: 31, missing: 4 }
const spruceShortage = { material: 'spruce_planks', needed: 20, carried: 19, missing: 1 }
const glassShortage = { material: 'glass', needed: 2, carried: 1, missing: 1 }
const shortage = (...materials) => ({ ready: false, checked: 100, reason: 'homebuild-materials', materials })
const oakReceipt = { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
  inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 31, planksAfter: 35 } }

function fixture(t) {
  const dir = mkdtempSync('.work/minecraft-house-project-supply-')
  const path = join(dir, 'companion.sqlite')
  const stores = [new CompanionStore(path)]
  const [store] = stores
  t.after(() => {
    for (const db of stores) db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const zone = store.createBuildZone({ name: '院落授权地块', dimension: 'minecraft:overworld', x: 112, y: 80, z: 112, radius: 8 })
  const state = { calls: [], crafting: true,
    preview: ({ zone: section }) => section.x < zone.x ? shortage(oakShortage, spruceShortage, glassShortage) : ready,
    supplyPreview: ({ recipe }) => ({ ready: recipe === 'oak_planks' }), supply: () => oakReceipt,
  }
  const serviceFor = db => {
    const service = new MinecraftService(db, {}, { dataDir: dir, serverRoot: dir, owner: 'fixture-owner' })
    service.request = async (path, _method, input, actionSignal) => {
      state.calls.push({ path, input })
      switch (path) {
        case '': return { online: true, auth: { mode: 'cbi' },
          capabilities: { houseBuilding: true, houseProjects: true, crafting: state.crafting } }
        case '/house/preview': return state.preview(input)
        case '/house/supply-preview': return state.supplyPreview(input)
        case '/house/supply': return state.supply(input, actionSignal)
        case '/stop': return {}
        default: assert.fail('Unexpected Worker request: ' + path)
      }
    }
    return service
  }
  const service = serviceFor(store)
  const project = service.createHouseProject({ name: '院落', zoneId: zone.id,
    sections: [-2, 3].map((x, index) => ({ name: String(index + 1), offset: { x, y: 0, z: 0 }, layout })) })
  const inspect = (allow, active = signal) => service.inspectDailyHouseProject(project.id, zone.id, active, allow)
  const newParent = date => {
    const job = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT,
      dedupeKey: 'daily:' + date, runAfter: Date.now(), maxAttempts: 1 })
    return store.transitionTask(job.id, 'running')
  }
  const run = (offer, parent, { active = signal, authorize = () => {}, onStarted = () => {} } = {}) =>
    service.supplyDailyHouseProjectSection(project.id, zone.id, offer, active, authorize, { dailyTaskId: parent.id, onStarted })
  const reopen = () => {
    const db = new CompanionStore(path)
    stores.push(db)
    return { db, service: serviceFor(db) }
  }
  const supplyCalls = () => state.calls.filter(call => call.path === '/house/supply')
  return { store, zone, state, service, project, inspect, newParent, run, reopen, supplyCalls }
}

test('daily house supply offers require separate consent and exact Worker evidence', async t => {
  const h = fixture(t)
  assert.deepEqual(await h.inspect(), [{ section: 1, name: '2' }])
  assert.equal(h.state.calls.some(call => call.path === '/house/supply-preview'), false)
  h.state.crafting = false
  assert.deepEqual(await h.inspect(true), [{ section: 1, name: '2' }])
  assert.equal(h.state.calls.some(call => call.path === '/house/supply-preview'), false)
  h.state.crafting = true
  assert.deepEqual(await h.inspect(true), [{ section: 1, name: '2' }, { section: 0, name: '1', supply: { recipe: 'oak_planks', missing: 4 } }])
  const probes = h.state.calls.filter(call => call.path === '/house/supply-preview')
  const section = { id: h.zone.id, dimension: h.zone.dimension, x: 110, y: 80, z: 112, radius: 6 }
  assert.deepEqual(probes.map(call => call.input), [
    { zone: section, layout, recipe: 'oak_planks', missing: 4 },
    { zone: section, layout, recipe: 'spruce_planks', missing: 1 },
  ])
  h.state.supplyPreview = () => ({ ready: true, extra: 'unrecognized' })
  assert.deepEqual(await h.inspect(true), [{ section: 1, name: '2' }])
  h.state.supplyPreview = () => { throw new DeviceAuthError(404, 'not-found') }
  assert.deepEqual(await h.inspect(true), [{ section: 1, name: '2' }])
  h.state.supplyPreview = () => ({ ready: true })
  h.state.preview = () => ({ ...shortage(oakShortage), checked: 99 })
  assert.deepEqual(await h.inspect(true), [])
  assert.equal(h.supplyCalls().length, 0)
})

test('the daily lease records only a verified supply action, never a built section', async t => {
  const h = fixture(t)
  const parent = h.newParent('2026-11-12')
  const [build, offer] = await h.inspect(true)
  const externalId = DAILY_HOUSE_PROJECT_TASK_PREFIX + parent.id
  const lease = { dailyTaskId: parent.id, onStarted: () => assert.fail('wrong action used the lease') }
  await assert.rejects(h.run({ ...offer }, parent), /plan-stale/u)
  await assert.rejects(h.run(build, parent), /plan-stale/u)
  await assert.rejects(h.service.buildDailyHouseProjectSection(h.project.id, h.zone.id, offer, signal, () => {}, lease), /plan-stale/u)
  await assert.rejects(h.run(offer, { id: h.zone.id }), /plan-stale/u)
  h.state.supplyPreview = () => ({ ready: false })
  await assert.rejects(h.run(offer, parent), /supply-preconditions-changed/u)
  assert.equal(h.store.taskByExternalId(externalId), undefined)
  assert.equal(h.supplyCalls().length, 0)
  h.state.supplyPreview = () => ({ ready: true })
  let child
  h.state.supply = () => {
    assert.equal(h.store.taskByExternalId(externalId).id, child.id)
    assert.equal(h.store.taskById(child.id).status, 'running')
    assert.deepEqual(h.store.minecraftHouseProjects.get(h.project.id), h.project)
    h.service.ready = true
    h.service.homeActiveAt = Date.now()
    h.service.homeActiveKind = 'house-supply'
    assert.equal(h.service.homeActive(Date.now(), false, child.id), false)
    assert.equal(h.service.homeActive(Date.now(), false, parent.id), true)
    return oakReceipt
  }
  const { task, receipt } = await h.run(offer, parent, { onStarted: started => { child = started } })
  assert.deepEqual(receipt, oakReceipt)
  assert.equal(task.id, child.id)
  assert.equal(task.capabilityId, HOUSE_PROJECT_SUPPLY_CAPABILITY)
  assert.equal(task.externalId, externalId)
  assert.equal(task.status, 'succeeded')
  assert.deepEqual(h.store.minecraftHouseProjects.get(h.project.id), h.project)
  assert.equal(h.store.minecraftHouseProjects.sectionReceiptByTask(task.id), undefined)
  assert.equal(h.store.activityByTask(task.id, 'world.house-project-section', 'game.minecraft'), undefined)
  const row = h.store.activityByTask(task.id, HOUSE_PROJECT_SUPPLY_EVENT, 'game.minecraft')
  assert.deepEqual(row.data, { projectId: h.project.id, zoneId: h.zone.id, index: 0,
    dailyTaskId: parent.id, missing: 4, ...oakReceipt })
  const [memory] = h.store.memory.list()
  assert.equal(memory.content, dailyHouseSupplyFact(0, oakReceipt.name))
  assert.equal(memory.scope, 'shared')
  assert.deepEqual(memory.sourceRefs, [{ contextId: 'game.minecraft', taskId: task.id, activityId: row.id }])
  assert.deepEqual(h.reopen().db.activityByTask(task.id, HOUSE_PROJECT_SUPPLY_EVENT, 'game.minecraft'), row)
  const [nextBuild, nextSupply] = await h.inspect(true)
  await assert.rejects(h.run(nextSupply, parent), /plan-stale/u)
  await assert.rejects(h.service.buildDailyHouseProjectSection(h.project.id, h.zone.id, nextBuild, signal, () => {}, lease), /plan-stale/u)
  assert.equal(h.supplyCalls().length, 1)
})

test('stale and interrupted house supply do not publish a false result', async t => {
  for (const [label, change, expected, dispatch] of [
    ['modified recipe', ({ offer }) => { offer.supply.recipe = 'spruce_planks' }, /plan-stale/u, false],
    ['modified shortage', ({ offer }) => { offer.supply.missing = 1 }, /plan-stale/u, false],
    ['changed permit', ({ h }) => { h.state.supplyPreview = () => { throw new DeviceAuthError(409, 'permit-revoked') } }, /permit-revoked/u, false],
    ['expired offer', ({ mock }) => { mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER) }, /plan-stale/u, false],
    ['wrong Worker recipe', ({ h }) => { h.state.supply = () => ({ ...oakReceipt, name: 'spruce_planks' }) }, /receipt-unconfirmed/u, true],
    ['invalid Worker stock delta', ({ h }) => { h.state.supply = () => ({ ...oakReceipt, inventory: { ...oakReceipt.inventory, logsAfter: 3 } }) }, /receipt-unconfirmed/u, true],
    ['claimed stock above section bill', ({ h }) => { h.state.supply = () => ({ ...oakReceipt, inventory: { ...oakReceipt.inventory, planksBefore: 37, planksAfter: 41 } }) }, /receipt-unconfirmed/u, true],
    ['cancelled after dispatch', ({ h, controller }) => { h.state.supply = () => { controller.abort(); return oakReceipt } }, /house-cancelled/u, true],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    const parent = h.newParent('2026-11-12')
    const [, offer] = await h.inspect(true)
    const controller = new AbortController()
    change({ h, offer, controller, mock: child.mock })
    await assert.rejects(h.run(offer, parent, { active: controller.signal }), expected)
    assert.equal(h.supplyCalls().length, dispatch ? 1 : 0)
    const task = h.store.taskByExternalId(DAILY_HOUSE_PROJECT_TASK_PREFIX + parent.id)
    assert.equal(task?.status, dispatch ? controller.signal.aborted ? 'cancelled' : 'failed' : undefined)
    if (task) assert.equal(h.store.activityByTask(task.id, HOUSE_PROJECT_SUPPLY_EVENT, 'game.minecraft'), undefined)
    assert.deepEqual(h.store.memory.list(), [])
    assert.deepEqual(h.store.minecraftHouseProjects.get(h.project.id), h.project)
  })
})

test('cold restart reconciles an unconfirmed supply task and preserves the daily dedupe', async t => {
  const h = fixture(t)
  const parent = h.newParent('2026-11-12')
  const externalId = DAILY_HOUSE_PROJECT_TASK_PREFIX + parent.id
  const child = h.store.createTask({ contextId: 'game.minecraft', capabilityId: HOUSE_PROJECT_SUPPLY_CAPABILITY, title: '备料', externalId })
  h.store.transitionTask(child.id, 'running')
  const restarted = h.reopen()
  await restarted.service.houseProjects()
  assert.equal(restarted.db.taskById(child.id).status, 'cancelled')
  assert.equal(restarted.db.taskById(child.id).error, 'minecraft-house-project-supply-unconfirmed-after-restart')
  assert.equal(restarted.db.taskByExternalId(externalId).id, child.id)
  assert.deepEqual(restarted.db.minecraftHouseProjects.get(h.project.id), h.project)
  assert.deepEqual(restarted.db.memory.list(), [])
})
