import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY, MinecraftHouseProjectInput, MinecraftHouseProjectVerification,
  MinecraftHouseProjectVerifyRequest, minecraftHouseProjectRequests } from '../src/core/minecraft-house-project.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { DeviceAuthError } from '../src/host/devices.ts'
import { DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'

const layout = { width: 5, height: 4, depth: 5, blocks: 'o'.repeat(60) + '.'.repeat(40) }
const blueprint = zoneId => ({ name: '两间测试房', zoneId, sections: [-2, 3].map((x, i) =>
  ({ name: String(i + 1), offset: { x, y: 0, z: 0 }, layout })) })
const zone = { id: 'bf233e84-c7d8-4c3f-8fb2-e622a30b5bef', dimension: 'minecraft:overworld', x: -10, y: 80, z: 30, radius: 8 }
const signal = new AbortController().signal
const planRequest = '请帮我选 Minecraft 建筑工程「两间测试房」的下一段'

test('immutable sections cover all planned air and solids once and derive narrower cubes', () => {
  const input = MinecraftHouseProjectInput.parse(blueprint(zone.id))
  const sections = minecraftHouseProjectRequests(input, zone)
  assert.deepEqual(sections.map(({ zone: child }) => [child.x, child.y, child.z, child.radius]), [[-12, 80, 30, 6], [-7, 80, 30, 5]])
  assert.ok(sections.every(section => section.zone.id === zone.id && section.zone.dimension === zone.dimension))
  assert.ok(MinecraftHouseProjectVerifyRequest.safeParse({ sections }).success)
  assert.ok(MinecraftHouseProjectVerifyRequest.safeParse({ sections: [...sections].reverse() }).success)
  assert.equal(MinecraftHouseProjectVerifyRequest.safeParse({ sections: [sections[0], { ...sections[1],
    zone: { ...sections[1].zone, dimension: 'minecraft:the_nether' } }] }).success, false)
  assert.equal(MinecraftHouseProjectVerifyRequest.safeParse({ sections: [sections[0], { ...sections[1],
    zone: { ...sections[1].zone, radius: 2 } }] }).success, false)
  assert.equal(minecraftHouseProjectRequests(input, { ...zone, radius: 5 }), undefined)
  for (const x of [2, 4]) {
    const broken = structuredClone(input)
    broken.sections[1].offset.x = x
    assert.equal(MinecraftHouseProjectInput.safeParse(broken).success, false)
  }
  const tooSmall = structuredClone(input)
  for (const section of tooSmall.sections) section.layout.blocks = 'o'.repeat(50) + '.'.repeat(50)
  assert.equal(MinecraftHouseProjectInput.safeParse(tooSmall).success, false)
  for (const result of [
    { matched: true, checked: 200, unmatchedSections: [0] },
    { matched: false, checked: 200, unmatchedSections: [] },
    { matched: false, checked: 200, unmatchedSections: [0, 0] },
    { matched: false, checked: 200, unmatchedSections: [1, 0] },
  ]) assert.equal(MinecraftHouseProjectVerification.safeParse(result).success, false)
})

function fixture(t) {
  const dir = mkdtempSync('.work/minecraft-house-project-')
  const path = join(dir, 'companion.sqlite')
  const stores = [new CompanionStore(path)]
  t.after(() => {
    for (const store of stores) store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const [store] = stores
  const area = store.createBuildZone({ ...zone, name: '工程授权区' })
  const state = {
    calls: [], online: true, recovery: false,
    preview: () => ({ ready: true, checked: 100 }),
    receipt: () => ({ built: true, zoneId: area.id, checked: 100, placed: 60, consumed: { oak_planks: 60 } }),
    recoveryPreview: () => ({ ready: true, checked: 100 }),
    recoveryReceipt: () => ({ built: true, zoneId: area.id, checked: 100, placed: 2, consumed: { oak_planks: 2 } }),
    verification: () => ({ matched: true, checked: 200, unmatchedSections: [] }),
  }
  const serviceFor = db => {
    const service = new MinecraftService(db, {}, { dataDir: dir, serverRoot: dir, owner: 'fixture-owner' })
    service.request = async (path, _method, input) => {
      state.calls.push({ path, input })
      switch (path) {
        case '': return { online: state.online, auth: { mode: 'cbi' }, capabilities: {
          houseBuilding: true, houseProjects: true, houseRecovery: state.recovery,
        } }
        case '/house/preview': return state.preview(input)
        case '/house/build': return state.receipt(input)
        case '/house/recovery-preview': return state.recoveryPreview(input)
        case '/house/recover': return state.recoveryReceipt(input)
        case '/house/project-verify': return state.verification(input)
        case '/stop': return {}
        default: throw new Error('Unexpected request: ' + path)
      }
    }
    return service
  }
  const service = serviceFor(store)
  const input = MinecraftHouseProjectInput.parse(blueprint(area.id))
  const { id } = service.createHouseProject(input)
  const openAgain = () => {
    const reopened = new CompanionStore(path)
    stores.push(reopened)
    return { db: reopened, service: serviceFor(reopened) }
  }
  return { id, input, state, store, service, area, openAgain }
}

test('project progress, approval scope and world receipt survive cold reopen', async t => {
  const { id, input, state, store, service, area, openAgain } = fixture(t)
  assert.equal(service.createHouseProject(input).id, id)
  assert.equal(store.minecraftHouseProjects.list().length, 1)
  assert.equal((await service.houseProjects()).available, true)
  await assert.rejects(service.verifyHouseProject(id), /project-incomplete/u)
  const left = await service.previewHouseProjectSection(id, 0, signal)
  const right = await service.previewHouseProjectSection(id, 1, signal)
  await assert.rejects(service.buildHouseProjectSection(id, 1, left.previewId), /project-preview-required/u)
  assert.equal(state.calls.filter(call => call.path === '/house/build').length, 0)
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const regularReceipt = state.receipt
  state.receipt = async input => {
    started.resolve()
    await release.promise
    return regularReceipt(input)
  }
  const building = service.buildHouseProjectSection(id, 1, right.previewId)
  try {
    await started.promise
    assert.equal(store.minecraftHouseProjects.get(id).sections[1].status, 'running')
    await assert.rejects(service.previewHouseProjectSection(id, 0, signal), /project-busy/u)
    await assert.rejects(service.buildHouseProjectSection(id, 1, right.previewId), /project-preview-required/u)
  } finally { release.resolve() }
  assert.equal((await building).sections[1].receipt.placed, 60)
  await assert.rejects(service.buildHouseProjectSection(id, 0, left.previewId), /project-preview-required/u)
  const unused = await service.previewHouseProjectSection(id, 0, signal)
  const reopened = openAgain()
  assert.deepEqual(reopened.db.minecraftHouseProjects.get(id).sections.map(section => section.status), ['pending', 'built'])
  await assert.rejects(reopened.service.buildHouseProjectSection(id, 0, unused.previewId), /project-preview-required/u)
  const running = reopened.db.createTask({ capabilityId: HOUSE_PROJECT_SECTION_CAPABILITY, contextId: 'game.minecraft', title: '施工' })
  reopened.db.transitionTask(running.id, 'running')
  assert.equal(reopened.db.minecraftHouseProjects.start(id, 0, running.id), true)
  const crashed = openAgain()
  const recovered = (await crashed.service.houseProjects()).projects[0]
  assert.equal(recovered.sections[0].status, 'interrupted')
  assert.equal(recovered.sections[0].reason, 'house-result-unconfirmed-after-restart')
  assert.equal(crashed.db.taskById(running.id).status, 'cancelled')
  const fresh = await crashed.service.previewHouseProjectSection(id, 0, signal)
  const complete = await crashed.service.buildHouseProjectSection(id, 0, fresh.previewId)
  assert.deepEqual(complete.sections.map(section => section.status), ['built', 'built'])
  assert.deepEqual(await crashed.service.buildHouseProjectSection(id, 0, fresh.previewId), complete)
  assert.deepEqual(state.calls.filter(call => call.path === '/house/build').map(({ input }) => input.zone.x),
    [area.x + 3, area.x - 2])
  assert.equal((await crashed.service.verifyHouseProject(id)).verification.matched, true)
  const firstActivity = crashed.db.activities().find(a => a.kind === 'world.house-project-verification')
  assert.equal(firstActivity.status, 'success')
  assert.equal(firstActivity.data.checked, 200)
  state.verification = () => ({ matched: false, checked: 200, unmatchedSections: [0] })
  const drift = await crashed.service.verifyHouseProject(id)
  assert.deepEqual(drift.verification.unmatchedSections, [0])
  assert.ok(drift.sections.every(section => section.status === 'built' && section.receipt))
  assert.equal(openAgain().db.minecraftHouseProjects.get(id).verification.matched, false)
})

test('shortages, malformed worker receipts and revoked authorization never imply completion', async t => {
  const { id, state, service, store, area } = fixture(t)
  const ready = await service.previewHouseProjectSection(id, 0, signal)
  const shortage = { ready: false, checked: 100, reason: 'homebuild-materials',
    materials: [{ material: 'oak_planks', needed: 20, carried: 15, missing: 5 }] }
  state.preview = () => shortage
  assert.deepEqual(await service.previewHouseProjectSection(id, 0, signal), shortage)
  await assert.rejects(service.buildHouseProjectSection(id, 0, ready.previewId), /project-preview-required/u)
  state.preview = () => ({ ...shortage, materials: [{ material: 'glass', needed: 3, carried: 2, missing: 1 }] })
  const invalid = await service.previewHouseProjectSection(id, 0, signal)
  assert.equal(invalid.materials, undefined)
  state.preview = () => ({ ready: true, checked: 100 })
  state.receipt = () => ({ built: true, zoneId: area.id, checked: 100, placed: 1, consumed: { glass: 1 } })
  const fresh = await service.previewHouseProjectSection(id, 0, signal)
  await assert.rejects(service.buildHouseProjectSection(id, 0, fresh.previewId), /house-receipt-unconfirmed/u)
  assert.equal(store.minecraftHouseProjects.get(id).sections[0].status, 'interrupted')
  assert.equal(store.minecraftHouseProjects.get(id).sections[0].receipt, undefined)
  state.receipt = () => { throw new DeviceAuthError(409, 'homebuild-obstructed') }
  const retry = await service.previewHouseProjectSection(id, 0, signal)
  await assert.rejects(service.buildHouseProjectSection(id, 0, retry.previewId), /homebuild-obstructed/u)
  assert.equal(store.minecraftHouseProjects.get(id).sections[0].reason, 'homebuild-obstructed')
  const revoked = await service.previewHouseProjectSection(id, 0, signal)
  assert.equal(await service.revokeBuildZone(area.id), true)
  await assert.rejects(service.buildHouseProjectSection(id, 0, revoked.previewId), /build-zone-not-found/u)
  assert.equal(state.calls.filter(call => call.path === '/house/build').length, 2)
  assert.equal(store.activities().some(a => a.kind === 'world.house-project-verification'), false)
})

test('planning reads each unfinished sector once without creating an approval, task, or world memory', async t => {
  const { id, state, service, store, area, openAgain } = fixture(t)
  const shortage = { ready: false, checked: 100, reason: 'homebuild-materials',
    materials: [{ material: 'oak_planks', needed: 20, carried: 15, missing: 5 }] }
  state.preview = input => input.zone.x === area.x - 2 ? shortage : { ready: true, checked: 100 }
  const { status, observation } = await service.observeHouseProjectPlan(planRequest, signal)
  assert.equal(status, 'observed')
  assert.equal(observation.projectName, '两间测试房')
  assert.deepEqual(observation.options.map(option => JSON.parse(JSON.stringify(option))), [
    { section: 0, name: '1', status: 'pending', ready: false, reason: shortage.reason, materials: shortage.materials },
    { section: 1, name: '2', status: 'pending', ready: true },
  ])
  const build = { action: 'build', section: 1, reason: '二号区现场通过，一号区还缺五块木板。' }
  const prep = { action: 'prepare', section: 0, reason: '先准备一号区实际缺少的五块橡木木板。' }
  await assert.rejects(service.recordHouseProjectPlan(observation, { ...build, section: 0 }, signal), /project-plan-invalid/u)
  await assert.rejects(service.recordHouseProjectPlan(observation, { ...prep, section: 1 }, signal), /project-plan-invalid/u)
  await assert.rejects(service.recordHouseProjectPlan(observation, { ...build, section: 2 }, signal), /project-plan-invalid/u)
  await assert.rejects(service.recordHouseProjectPlan(structuredClone(observation), build, signal), /project-plan-stale/u)
  const result = await service.recordHouseProjectPlan(observation, build, signal)
  assert.equal(result.action, 'build')
  assert.equal(result.section, 1)
  assert.deepEqual(openAgain().db.minecraftHouseProjects.get(id).plan, JSON.parse(JSON.stringify(result)))
  assert.deepEqual(store.tasks(), [])
  assert.equal(store.memory.list().length, 0)
  assert.deepEqual(state.calls.filter(call => call.path === '/house/preview').map(call => call.input.zone.x), [area.x - 2, area.x + 3])
  await assert.rejects(service.recordHouseProjectPlan(observation, prep, signal), /project-plan-stale/u)
  await assert.rejects(service.buildHouseProjectSection(id, 1, area.id), /project-preview-required/u)
  assert.equal(state.calls.some(call => call.path === '/house/build'), false)
  const next = (await service.observeHouseProjectPlan(planRequest, signal)).observation
  const ownerPreview = await service.previewHouseProjectSection(id, 1, signal)
  assert.equal((await service.buildHouseProjectSection(id, 1, ownerPreview.previewId)).plan, undefined)
  await assert.rejects(service.recordHouseProjectPlan(next, prep, signal), /project-plan-stale/u)
  const following = (await service.observeHouseProjectPlan(planRequest, signal)).observation
  assert.deepEqual(following.options.map(option => option.section), [0])
  assert.equal((await service.recordHouseProjectPlan(following, prep, signal)).action, 'prepare')
})

test('owner-selected project names remain exact and ambiguity does not read the world', async t => {
  const { id, input, state, service, store } = fixture(t)
  assert.deepEqual(await service.observeHouseProjectPlan('请帮我选 Minecraft 建筑工程《不存在》的下一段', signal), { status: 'no-project' })
  const other = service.createHouseProject({ ...input, name: '另一栋' })
  assert.equal((await service.observeHouseProjectPlan('请帮我选 Minecraft 建筑工程的下一段', signal)).status, 'choose-project')
  const copy = service.createHouseProject({ ...input, sections: input.sections.map((section, i) => ({ ...section, name: '重复' + i })) })
  const ambiguous = await service.observeHouseProjectPlan(planRequest, signal)
  assert.equal(ambiguous.status, 'choose-project')
  assert.deepEqual(new Set(ambiguous.projects), new Set([`「两间测试房」 #${id}`, `「两间测试房」 #${copy.id}`]))
  assert.deepEqual(state.calls, [])
  const exact = await service.observeHouseProjectPlan(`请帮我选 Minecraft 建筑工程《两间测试房》 #${id.toUpperCase()}的下一段`, signal)
  assert.equal(exact.status, 'observed')
  assert.deepEqual(exact.observation.options.map(option => option.name), ['1', '2'])
  const wait = { action: 'wait', reason: '先停一下，等主人回来确定两翼的施工顺序。' }
  await service.recordHouseProjectPlan(exact.observation, wait, signal)
  assert.equal(store.minecraftHouseProjects.get(id).plan.action, 'wait')
  assert.equal(store.minecraftHouseProjects.get(copy.id).plan, undefined)
  assert.equal(store.minecraftHouseProjects.get(other.id).plan, undefined)
})

test('an expired, disconnected, revoked or no-longer-current decision is never written', async t => {
  const { id, state, service, store, area } = fixture(t)
  const choose = { action: 'build', section: 0, reason: '一号区现场预检可施工且材料足够。' }
  const observe = async () => (await service.observeHouseProjectPlan(planRequest, signal)).observation
  const old = await observe()
  const mock = t.mock.method(Date, 'now', () => Date.parse(old.observedAt) + 120_001)
  await assert.rejects(service.recordHouseProjectPlan(old, choose, signal), /project-plan-stale/u)
  mock.mock.restore()
  const beforeRebind = await observe()
  await assert.rejects(service.recordHouseProjectPlan(beforeRebind, choose, signal, () => { throw new Error('rebound') }), /rebound/u)
  const interrupted = new AbortController()
  interrupted.abort(new Error('owner cancelled'))
  await assert.rejects(service.recordHouseProjectPlan(beforeRebind, choose, interrupted.signal), /owner cancelled/u)
  state.online = false
  await assert.rejects(service.recordHouseProjectPlan(beforeRebind, choose, signal), /project-unavailable/u)
  assert.equal(store.minecraftHouseProjects.get(id).plan, undefined)
  state.online = true
  const beforeRevoke = await observe()
  await service.revokeBuildZone(area.id)
  await assert.rejects(service.recordHouseProjectPlan(beforeRevoke, choose, signal), /build-zone-not-found/u)
  assert.equal(store.minecraftHouseProjects.get(id).plan, undefined)
  assert.deepEqual(await service.observeHouseProjectPlan(planRequest, signal), { status: 'no-project' })
})

test('an interrupted project uses stance recovery only with a fresh, mode-bound owner approval', async t => {
  const { id, state, service, store, area, openAgain } = fixture(t)
  state.recovery = true
  const initial = await service.previewHouseProjectSection(id, 0, signal)
  assert.equal(initial.recovery, undefined)
  state.receipt = () => { throw new DeviceAuthError(409, 'homebuild-unreachable-placement') }
  await assert.rejects(service.buildHouseProjectSection(id, 0, initial.previewId), /homebuild-unreachable-placement/u)
  const failedTask = store.tasks().find(task => task.capabilityId === HOUSE_PROJECT_SECTION_CAPABILITY)
  assert.equal(failedTask.status, 'failed')
  assert.equal(store.minecraftHouseProjects.get(id).sections[0].status, 'interrupted')
  state.recovery = false
  const older = await service.previewHouseProjectSection(id, 0, signal)
  assert.equal(older.recovery, undefined)

  state.recovery = true
  state.recoveryPreview = () => ({ ready: false, checked: 100, reason: 'homebuild-no-recovery-route' })
  const blocked = await service.previewHouseProjectSection(id, 0, signal)
  assert.deepEqual(blocked, { ready: false, checked: 100, reason: 'homebuild-no-recovery-route', recovery: true })
  await assert.rejects(service.buildHouseProjectSection(id, 0, older.previewId), /project-preview-required/u)

  state.recoveryPreview = () => ({ ready: true, checked: 100 })
  const seen = (await service.observeHouseProjectPlan(planRequest, signal)).observation
  assert.deepEqual(seen.options.map(({ section, ready, recovery }) => [section, ready, recovery]), [[0, true, true], [1, true, undefined]])
  const recommendation = await service.recordHouseProjectPlan(seen, {
    action: 'build', section: 0, reason: '一号区有可往返的路线，可以换站位补缺块。',
  }, signal)
  assert.equal(recommendation.options[0].previousReason, 'homebuild-unreachable-placement')
  await assert.rejects(service.buildHouseProjectSection(id, 0, area.id), /project-preview-required/u)
  assert.equal(state.calls.some(call => call.path === '/house/recover'), false)

  const beforeDisconnect = await service.previewHouseProjectSection(id, 0, signal)
  assert.equal(beforeDisconnect.recovery, true)
  state.recovery = false
  await assert.rejects(service.buildHouseProjectSection(id, 0, beforeDisconnect.previewId), /project-unavailable/u)
  state.recovery = true
  await assert.rejects(service.buildHouseProjectSection(id, 0, beforeDisconnect.previewId), /project-preview-required/u)

  const checked = await service.previewHouseProjectSection(id, 0, signal)
  const built = await service.buildHouseProjectSection(id, 0, checked.previewId)
  assert.deepEqual(built.sections[0].receipt, { built: true, zoneId: area.id, checked: 100,
    placed: 2, consumed: { oak_planks: 2 }, recovery: true })
  assert.equal(built.sections[1].status, 'pending')
  assert.equal(built.plan, undefined)
  assert.deepEqual(openAgain().db.minecraftHouseProjects.get(id).sections[0].receipt, built.sections[0].receipt)
  assert.deepEqual(await service.buildHouseProjectSection(id, 0, checked.previewId), built)
  assert.equal(store.taskById(failedTask.id).status, 'failed')
  assert.equal(state.calls.filter(call => call.path === '/house/recover').length, 1)
  assert.equal(state.calls.filter(call => call.path === '/house/build').length, 1)
})

function dailyTask(store) {
  const job = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:fixture',
    runAfter: Date.now(), maxAttempts: 1 })
  return store.transitionTask(job.id, 'running')
}

test('daily building accepts only its original live offer and journals one actual section for the parent', async t => {
  const { id, state, service, store, area, openAgain } = fixture(t)
  const old = await service.previewHouseProjectSection(id, 0, signal)
  state.receipt = () => { throw new DeviceAuthError(409, 'homebuild-unreachable-placement') }
  await assert.rejects(service.buildHouseProjectSection(id, 0, old.previewId), /homebuild-unreachable-placement/u)
  const parent = dailyTask(store)
  await assert.rejects(service.inspectDailyHouseProject(id, id, signal), /project-zone-invalid/u)
  assert.deepEqual((await service.inspectDailyHouseProject(id, area.id, signal)).map(x => x.section), [1])
  state.recovery = true
  const [offer] = await service.inspectDailyHouseProject(id, area.id, signal)
  assert.deepEqual(offer, { section: 0, name: '1', recovery: true })
  let started
  const externalId = DAILY_HOUSE_PROJECT_TASK_PREFIX + parent.id
  const lease = { dailyTaskId: parent.id, onStarted: task => { started = task } }
  const run = value => service.buildDailyHouseProjectSection(id, area.id, value, signal, () => {}, lease)
  await assert.rejects(run({ ...offer }), /project-plan-stale/u)
  await assert.rejects(service.buildHouseProjectSection(id, 0, area.id), /project-preview-required/u)
  assert.equal(store.taskByExternalId(externalId), undefined)

  state.recoveryPreview = () => ({ ready: false, checked: 100, reason: 'homebuild-no-recovery-route' })
  await assert.rejects(run(offer), /homebuild-no-recovery-route/u)
  assert.equal(store.taskByExternalId(externalId), undefined)
  assert.equal(started, undefined)
  state.recoveryPreview = () => ({ ready: true, checked: 100 })
  const ready = (await service.inspectDailyHouseProject(id, area.id, signal))[0]
  state.recoveryReceipt = () => {
    assert.equal(started.id, store.taskByExternalId(externalId).id)
    assert.equal(store.minecraftHouseProjects.get(id).sections[0].status, 'running')
    return { built: true, zoneId: area.id, checked: 100, placed: 2, consumed: { oak_planks: 2 } }
  }
  const { task, receipt } = await run(ready)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.externalId, externalId)
  assert.equal(task.id, started.id)
  assert.equal(receipt.recovery, true)
  assert.equal(receipt.placed, 2)
  const reopened = openAgain().db
  assert.deepEqual(reopened.minecraftHouseProjects.sectionReceiptByTask(task.id), { projectId: id, zoneId: area.id, section: 0, receipt })
  const current = reopened.minecraftHouseProjects.get(id)
  assert.equal(current.sections[1].status, 'pending')
  assert.equal(current.verification, undefined)
  const activity = store.activityByTask(task.id, 'world.house-project-section', 'game.minecraft')
  assert.equal(activity.data.dailyTaskId, parent.id)
  assert.equal(activity.status, 'success')
  assert.match(store.memory.list()[0].content, /自主施工第 1 区/u)
  const [next] = await service.inspectDailyHouseProject(id, area.id, signal)
  assert.equal(next.section, 1)
  await assert.rejects(run(next), /project-plan-stale/u)
  assert.equal(state.calls.filter(call => call.path === '/house/recover').length, 1)
})

test('daily admission checks the active parent and a cancelled execution cannot claim success', async t => {
  const { id, state, service, store, area } = fixture(t)
  const [offer] = await service.inspectDailyHouseProject(id, area.id, signal)
  await assert.rejects(service.buildDailyHouseProjectSection(id, area.id, offer, signal, () => {},
    { dailyTaskId: area.id, onStarted: () => assert.fail('accepted missing parent') }), /project-plan-stale/u)
  const parent = dailyTask(store)
  const controller = new AbortController()
  let taskId
  const receipt = state.receipt
  state.receipt = () => {
    assert.ok(taskId)
    controller.abort()
    return receipt()
  }
  await assert.rejects(service.buildDailyHouseProjectSection(id, area.id, offer, controller.signal, () => {},
    { dailyTaskId: parent.id, onStarted: task => { taskId = task.id } }), /house-cancelled/u)
  assert.equal(store.taskById(taskId).status, 'cancelled')
  assert.equal(store.minecraftHouseProjects.get(id).sections[0].status, 'interrupted')
  assert.equal(store.minecraftHouseProjects.sectionReceiptByTask(taskId), undefined)
  assert.equal(store.activityByTask(taskId, 'world.house-project-section', 'game.minecraft'), undefined)
  assert.deepEqual(store.memory.list(), [])
})
