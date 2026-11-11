import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { projectCommunity } from '../src/core/community.ts'
import { CAMP_PATROL_MAX_MS, CAMP_VISIT_PATROL_TASK_PREFIX, CAMP_VISIT_SURVEY_TASK_PREFIX } from '../src/core/minecraft-survey.ts'
import { CAMP_GATHER_MAX_MS, CAMP_VISIT_GATHER_TASK_PREFIX } from '../src/core/minecraft-gather.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { verifiedDailyReflectionSource } from '../src/host/daily-reflection-source.ts'

const local = (hour, minute, day = 9) => new Date(2026, 10, day, hour, minute).getTime()
const decision = { decision: 'visit' }

function fixture(t, { visit = true, bili = false, supply = false, build = false, revisit = false, patrol = false, gather = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: local(11, 55) })
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/daily-camp-visit-test-')
  const file = join(dir, 'companion.sqlite')
  let store = new CompanionStore(file)
  const zone = store.createBuildZone({ name: '授权营地', dimension: 'minecraft:overworld', x: 19, y: 64, z: 23, radius: 8 })
  const rule = { zoneId: zone.id, start: '12:00', end: '12:45', days: 2, allowMinecraftLogin: true }
  const state = { online: false, ready: true, paused: false,
    offer: { directions: ['east', 'north'], routes: [{ direction: 'east', steps: 7 }, { direction: 'north', steps: 4 }], trails: ['east-south'] } }
  const sent = [], starts = [], stops = [], previews = [], routes = [], reads = [], supplyPreviews = [], crafts = []
  const buildPreviews = [], builds = [], revisits = [], patrols = [], gatherPreviews = [], gathers = []
  let sessionCount = 0
  const sessions = {
    async create({ sessionId, ...input }) {
      return { binding: store.bindContext({ ...input, sessionId: sessionId ?? `isolated-${++sessionCount}` }) }
    },
    async send(contextId, prompt, _origin, _voice, _upload, assertAuthorized) {
      assertAuthorized?.()
      const receipt = { accepted: true, contextId, messageId: `prompt-${sent.length + 1}`, sessionId: store.bindingByContext(contextId).sessionId }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel() {},
  }
  const start = async (id, zoneId, expiresAt, signal) => {
    signal.throwIfAborted()
    state.online = true
    return { visitId: id, online: true, atCamp: true }
  }
  const stop = async id => {
    state.online = false
    return { visitId: id, online: false, confirmed: true }
  }
  const gameReceipt = result => {
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: '真实世界边界的替身勘察回执' })
    store.transitionTask(task.id, 'running')
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  const route = async (zoneId, direction, signal, steps) => {
    signal.throwIfAborted()
    return gameReceipt({ zoneId, direction, steps: steps ?? 4, reached: true, surveyed: true, returned: true })
  }
  const supplyReceipt = (id, withEvidence = true, inventory = { logsBefore: 3, logsAfter: 2, planksBefore: 0, planksAfter: 4 }) => {
    const externalId = `${CAMP_VISIT_SUPPLY_TASK_PREFIX}${id}`
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.craft', title: '测试真实游戏边界补给', externalId })
    store.transitionTask(task.id, 'running')
    const result = { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1, inventory }
    if (withEvidence) store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT,
      taskId: task.id, source: 'game.minecraft', kind: 'world.visit-supply', status: 'success', summary: '背包回执', data: { receipt: result } })
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  const buildReceipt = (id, { withEvidence = true, zoneId = zone.id, material = 'oak_planks', floorAfter = 0 } = {}) => {
    const externalId = `${CAMP_VISIT_BUILD_TASK_PREFIX}${id}`
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.build', title: '测试真实游戏边界搭建', externalId })
    store.transitionTask(task.id, 'running')
    const result = { built: true, zoneId, material, placedFloor: 8, placedTable: 1,
      inventory: { floorBefore: 8, floorAfter, tablesBefore: 1, tablesAfter: 0 } }
    if (withEvidence) store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT,
      taskId: task.id, source: 'game.minecraft', kind: 'world.visit-build', status: 'success', summary: '施工回执', data: { receipt: result } })
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  let onStart = start, onStop = stop, onRoute = route, onCraft = async id => supplyReceipt(id), onBuild = async id => buildReceipt(id)
  const minecraft = {
    async eventPrompt() { throw new Error('Unexpected Minecraft chat') },
    finishEvent() { throw new Error('Unexpected Minecraft chat') },
    campPaused() { return state.paused },
    surveyWindowReady() { return state.online && state.ready },
    async inspectCampSurvey(zoneId, signal, visitId) {
      signal.throwIfAborted()
      previews.push({ zoneId, visitId })
      return state.offer
    },
    async surveyCamp(zoneId, direction, signal, steps, visitId) {
      routes.push({ zoneId, direction, steps, visitId })
      return onRoute(zoneId, direction, signal, steps, visitId)
    },
    async surveyTrail(zoneId, trail, signal, visitId) {
      signal.throwIfAborted()
      routes.push({ zoneId, trail, visitId })
      return gameReceipt({ zoneId, trail, outcome: 'completed', checkpoints: 2, returned: true })
    },
    ...(visit && {
      campVisitReady() { return state.ready && !state.online },
      async startCampVisit(id, zoneId, expiresAt, signal, allowSupply, allowBuild, allowRevisit, activity) {
        const stored = store.autonomy.get(id)
        starts.push({ id, zoneId, expiresAt, signal, persistedStatus: stored?.payload.visitStatus,
          ...(allowSupply && { allowSupply }), ...(allowBuild && { allowBuild }), ...(allowRevisit && { allowRevisit }),
          ...(activity === true && { patrol: true }), ...(activity === 'gather' && { gather: true }),
          ...(activity === 'project-gather' && { gather: true, projectGather: true }) })
        return onStart(id, zoneId, expiresAt, signal)
      },
      async endCampVisit(id) {
        stops.push(id)
        return onStop(id)
      },
    }),
    ...(supply && {
      async inspectVisitSupply(zoneId, id, signal) {
        signal.throwIfAborted()
        supplyPreviews.push({ zoneId, id })
        return state.supplyOffer === undefined ? { recipe: 'oak_planks', availableLogs: 3, planks: 0 } : state.supplyOffer
      },
      async supplyOnVisit(zoneId, recipe, id, signal) {
        signal.throwIfAborted()
        crafts.push({ zoneId, recipe, id })
        return onCraft(id)
      },
    }),
    ...(build && {
      async inspectVisitBuild(zoneId, id, signal) {
        signal.throwIfAborted()
        buildPreviews.push({ zoneId, id })
        return state.buildOffer === undefined ? { material: 'oak_planks', availableFloor: 8, workbenches: 1 } : state.buildOffer
      },
      async buildOnVisit(zoneId, material, id, signal) {
        signal.throwIfAborted()
        builds.push({ zoneId, material, id })
        return onBuild(id)
      },
    }),
    ...(revisit && {
      async revisitOnVisit(zoneId, material, id, signal) {
        signal.throwIfAborted()
        revisits.push({ zoneId, material, id })
        if (state.onRevisit) return state.onRevisit(signal)
        return revisitReceipt(id, material, state.revisitProof)
      },
    }),
    ...(patrol && {
      async patrolSegment(zoneId, direction, steps, index, id, signal) {
        signal.throwIfAborted()
        const request = { zoneId, direction, steps, index, id }
        patrols.push(request)
        if (state.onPatrol) return state.onPatrol(request, signal)
        return patrolReceipt(request)
      },
    }),
    ...(gather && {
      async inspectVisitGather(zoneId, id, signal) {
        signal.throwIfAborted()
        gatherPreviews.push({ zoneId, id })
        return state.gatherOffer === undefined ? { direction: 'north', steps: 4, log: 'oak_log' } : state.gatherOffer
      },
      async gatherOnVisit(zoneId, offer, id, signal) {
        signal.throwIfAborted()
        const request = { zoneId, offer, id }
        gathers.push(request)
        if (state.onGather) return state.onGather(request, signal)
        return gatherReceipt(request)
      },
    }),
  }
  function gatherReceipt({ id, zoneId, offer }, { inventoryBefore = 1, inventoryAfter = inventoryBefore + 1, withEvidence = true, direction = offer.direction } = {}) {
    const externalId = `${CAMP_VISIT_GATHER_TASK_PREFIX}${id}`
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.dig', title: '真实橡木回营回执', externalId })
    store.transitionTask(task.id, 'running')
    const result = { zoneId, ...offer, direction, collected: 1, returned: true, inventoryBefore, inventoryAfter }
    if (withEvidence) store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT, taskId: task.id,
      source: 'game.minecraft', kind: 'world.visit-gather', status: 'success', summary: '采集回执', data: { receipt: result } })
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  function patrolReceipt({ id, index, zoneId, direction, steps }, { recovered = false, withEvidence = true } = {}) {
    const externalId = `${CAMP_VISIT_PATROL_TASK_PREFIX}${id}:${index}`
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: '实地巡视回执', externalId })
    store.transitionTask(task.id, 'running')
    const result = { zoneId, direction, steps, index, returned: true, surveyed: !recovered, reached: !recovered,
      ...(recovered && { reason: 'survey-terrain-changed' }) }
    if (withEvidence) store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT, taskId: task.id,
      source: 'game.minecraft', kind: 'world.patrol-segment', status: 'success', summary: '巡视回执', data: { receipt: result } })
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  function revisitReceipt(id, material, { matchedBlocks = 9, withEvidence = true, receiptMaterial = material } = {}) {
    const externalId = `${CAMP_VISIT_REVISIT_TASK_PREFIX}${id}`
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: '营地只读复访回执', externalId })
    store.transitionTask(task.id, 'running')
    const result = { zoneId: zone.id, material: receiptMaterial, checkedBlocks: 9, matchedBlocks }
    if (withEvidence) store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT, taskId: task.id,
      source: 'game.minecraft', kind: 'world.visit-revisit', status: 'success', summary: '只读复访', data: { receipt: result } })
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  const bilibili = bili ? { isIdle: () => true, async read(input) { reads.push(input); throw new Error('Unexpected Bilibili read') } } : undefined
  const newService = () => new AutonomyService(store, sessions, undefined, minecraft, undefined, bilibili)
  let service = newService()
  service.updateSettings({ quietStart: '00:00', quietEnd: '00:00' })
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const advance = at => t.mock.timers.setTime(at)
  const settle = async () => { await setImmediate(); await setImmediate() }
  const poll = async () => { service.wake(); await settle() }
  const job = () => store.autonomy.list().find(item => item.kind === 'daily.choice')
  const offlineMemories = () => store.memory.list({ contextId: 'chat.mobile', status: 'active' })
    .filter(item => item.content.includes('游戏服务端确认'))
  const offlineEvents = () => store.activities().filter(item => item.kind === 'world.visit-offline')

  async function open(input = rule) {
    await settle()
    assert.equal(service.setSurveyWindow(input).today.status, 'waiting')
    advance(local(12, 0))
    await poll()
  }
  async function respond(output, { mismatchedClaim = false } = {}) {
    const { receipt } = sent.at(-1)
    const binding = store.bindingByContext(receipt.contextId)
    const turn = sent.length
    service.observe(binding, { type: 'turn/start', data: { turn }, seq: 1 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append',
      data: { id: mismatchedClaim ? 'other-claim' : receipt.messageId, source: { kind: 'user' } }, seq: 2 })
    service.observe(binding, { type: 'assistant/message', surfaceOp: 'append',
      data: { turn, message: { id: `result-${turn}`, content: [{ type: 'text', text: JSON.stringify(output) }] } }, seq: 3 })
    service.observe(binding, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, seq: 4 })
    await settle()
  }
  async function restart({ abrupt = false } = {}) {
    if (!abrupt) await service.close()
    else await settle()
    store.close()
    store = new CompanionStore(file)
    service = newService()
    service.start()
    await settle()
  }
  function seedRecovery({ surveyed = false, status = 'online', endedMs = 180_000 } = {}) {
    advance(local(12, 0))
    const selected = service.setSurveyWindow(rule).rule
    const parent = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT,
      dedupeKey: 'daily:2026-11-09', runAfter: Date.now(), maxAttempts: 1,
      payload: { windowRuleId: selected.id, date: '2026-11-09', expiresAt: local(12, 45) } })
    store.transitionTask(parent.id, 'running')
    let activityTaskId
    if (surveyed) {
      const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
        dedupeKey: 'survey-window:2026-11-09', runAfter: Date.now(), maxAttempts: 1 })
      store.transitionTask(child.id, 'running')
      const game = gameReceipt({}).task
      store.autonomy.update(child.id, { payload: { windowSurveyZoneId: zone.id, windowRuleId: selected.id, goal: 'survey',
        expiresAt: Date.now() + endedMs, surveyOutcome: 'completed', direction: 'north', surveySteps: 4, receiptTaskId: game.id } })
      store.transitionTask(child.id, 'succeeded')
      activityTaskId = child.id
    }
    store.autonomy.update(parent.id, { attempts: 1, payload: { ...parent.payload, choice: 'survey', visitId: parent.id,
      visitExpiresAt: Date.now() + endedMs, visitStatus: status, ...(status !== 'starting' && { visitJoined: true }),
      ...(activityTaskId && { activityTaskId }) } })
    return parent.id
  }

  return {
    get service() { return service }, get store() { return store }, zone, rule, state, sent, starts, stops, previews, routes, reads, supplyPreviews, crafts, buildPreviews, builds, revisits, patrols, gatherPreviews, gathers,
    advance, settle, poll, job, offlineMemories, offlineEvents, open, respond, restart, seedRecovery,
    replaceStart: fn => { onStart = fn }, replaceStop: fn => { onStop = fn }, replaceRoute: fn => { onRoute = fn },
    replaceCraft: fn => { onCraft = fn }, replaceBuild: fn => { onBuild = fn }, supplyReceipt, buildReceipt, revisitReceipt, patrolReceipt, gatherReceipt, defaultStop: stop,
  }
}

test('the legacy grant does not schedule an offline login, and older Workers cannot be authorized for visits', async t => {
  await t.test('offline legacy mode never offers a visit', async t => {
    const h = fixture(t)
    const { allowMinecraftLogin: _, ...old } = h.rule
    await h.open(old)
    assert.equal(h.service.surveyWindowView().campVisitAvailable, true)
    assert.equal(h.service.surveyWindowView().rule.allowMinecraftLogin, undefined)
    assert.equal(h.job(), undefined)
    assert.deepEqual(h.sent, [])
    assert.deepEqual(h.starts, [])
  })
  await t.test('older Worker does not expose or accept a visit', t => {
    const h = fixture(t, { visit: false })
    assert.equal(h.service.surveyWindowView().campVisitAvailable, undefined)
    assert.throws(() => h.service.setSurveyWindow(h.rule), /minecraft-survey-window-unavailable/u)
  })
})

test('one offline decision can choose to skip without logging into Minecraft', async t => {
  const h = fixture(t)
  await h.open()
  assert.equal(h.service.surveyWindowView().dailyChoiceAvailable, undefined)
  assert.match(h.sent[0].prompt, /"decision":"visit"/u)
  assert.doesNotMatch(h.sent[0].prompt, /B 站候选/u)
  await h.respond({ decision: 'skip' })
  assert.equal(h.job().task.status, 'cancelled')
  assert.equal(h.job().payload.choice, 'skip')
  await h.poll()
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.stops, [])
})

test('forged or stale model decisions cannot acquire a visit', async t => {
  for (const [label, edit, output, options] of [
    ['extra fields in the decision', () => {}, { ...decision, zoneId: randomUUID() }],
    ['unrelated appended user message', () => {}, decision, { mismatchedClaim: true }],
    ['Worker readiness has changed', h => { h.state.ready = false }, decision],
    ['camp paused after the prompt', h => { h.state.paused = true }, decision],
    ['the window already ended', h => h.advance(local(12, 45)), decision],
    ['quiet starts before the reply', h => { h.service.updateSettings({ quietStart: '12:00', quietEnd: '12:30' }) }, decision],
    ['the camp authorization was revoked', h => { h.service.revokeSurveyWindow() }, decision],
  ]) {
    await t.test(label, async t => {
      const h = fixture(t)
      await h.open()
      assert.equal(h.sent.length, 1)
      edit(h)
      await h.respond(output, options)
      assert.notEqual(h.job().task.status, 'succeeded')
      assert.deepEqual(h.starts, [])
      assert.deepEqual(h.stops, [])
    })
  }
})

test('successful daily visit owns one bounded lease and commits only after matching offline proof', async t => {
  const h = fixture(t)
  h.service.updateSettings({ dailyReflectionEnabled: true })
  await h.open()
  const pendingEnd = Promise.withResolvers()
  h.replaceStop(async id => { await pendingEnd.promise; return h.defaultStop(id) })
  await h.respond(decision)
  const running = h.job()
  try {
    assert.equal(running.task.status, 'running')
    assert.equal(running.payload.visitJoined, true)
    assert.equal(running.payload.visitStatus, 'online')
    assert.equal(running.payload.visitId, running.id)
    assert.deepEqual(h.starts.map(({ id, zoneId, expiresAt, persistedStatus }) => ({ id, zoneId, expiresAt, persistedStatus })),
      [{ id: running.id, zoneId: h.zone.id, expiresAt: local(12, 5), persistedStatus: 'starting' }])
    assert.deepEqual(h.previews, [{ zoneId: h.zone.id, visitId: running.id }])
    assert.deepEqual(h.routes, [{ zoneId: h.zone.id, direction: 'north', steps: 4, visitId: running.id }])
    assert.deepEqual(h.stops, [running.id])
    assert.deepEqual(h.offlineMemories(), [])
    assert.equal(h.store.autonomy.list().some(item => item.kind === 'daily.reflect'), false)
  } finally {
    pendingEnd.resolve()
    await h.settle()
  }
  const complete = h.job()
  assert.equal(complete.task.status, 'succeeded')
  assert.equal(complete.payload.visitStatus, 'offline')
  assert.equal(h.service.surveyWindowView().today.visitStatus, 'offline')
  assert.equal(h.service.surveyWindowView().lastVisit.status, 'offline')
  assert.equal(h.offlineMemories().length, 1)
  assert.equal(h.offlineEvents().length, 1)
  assert.equal(h.state.online, false)
  assert.equal(h.store.autonomy.list().filter(item => item.kind === 'daily.reflect').length, 1)
  assert.equal(projectCommunity('idle', h.store).recentCamp[0].route.direction, 'north')
  h.service.revokeSurveyWindow()
  h.service.setSurveyWindow(h.rule)
  await h.poll()
  assert.deepEqual(h.stops, [running.id])
  assert.equal(h.starts.length, 1)
  assert.equal(h.sent.length, 1)
})

test('the offline lease ends at the next quiet boundary when it comes before five minutes', async t => {
  const h = fixture(t)
  h.service.updateSettings({ quietStart: '12:03', quietEnd: '12:45' })
  await h.open()
  await h.respond(decision)
  assert.equal(h.starts[0].expiresAt, local(12, 3))
  assert.equal(h.job().payload.visitExpiresAt, local(12, 3))
})

test('a trail-only preview with an empty routes array can still finish a safe visit', async t => {
  const h = fixture(t)
  h.state.offer = { directions: [], routes: [], trails: ['east-south'] }
  await h.open()
  await h.respond(decision)
  assert.deepEqual(h.routes, [{ zoneId: h.zone.id, trail: 'east-south', visitId: h.job().id }])
  assert.equal(h.job().task.status, 'succeeded')
})

test('an already online character stays in the existing manual session', async t => {
  const h = fixture(t)
  h.state.online = true
  await h.open()
  assert.doesNotMatch(h.sent[0].prompt, /"decision":"visit"/u)
  await h.respond({ decision: 'survey', direction: 'north' })
  assert.deepEqual(h.routes, [{ zoneId: h.zone.id, direction: 'north', steps: 4, visitId: undefined }])
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.job().payload.visitId, undefined)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.stops, [])
  assert.equal(h.state.online, true)
})

test('a visit cannot launch when an unoffered offline option is chosen against an already online session', async t => {
  const h = fixture(t)
  h.state.online = true
  await h.open()
  await h.respond(decision)
  assert.equal(h.job().task.status, 'failed')
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.stops, [])
  assert.equal(h.state.online, true)
})

test('a selected visit leaves the independently authorized Bilibili candidate queued', async t => {
  const h = fixture(t, { bili: true })
  await h.open({ ...h.rule, allowBilibili: true })
  h.store.bilibili.add({ bvid: 'BV1234567891', part: 1 }, '第二选择')
  // The first visit evaluation started with no Bilibili candidate; a late candidate cannot change the choice.
  h.service.updateSettings({ bilibiliEnabled: true })
  await h.respond(decision)
  assert.equal(h.job().task.status, 'succeeded')
  assert.deepEqual(h.reads, [])
  assert.equal(h.store.bilibili.view().items[0].status, 'queued')
})

test('partial failures clean up only their own lease and never claim completed exploration', async t => {
  for (const [label, change, attemptedRoute, joined] of [
    ['the Worker returns no safe routes', h => { h.state.offer = { directions: [] } }, false, true],
    ['spawn response is lost after the Worker joined', h => h.replaceStart(async () => {
      h.state.online = true
      throw new Error('lost-start-response')
    }), false, false],
    ['survey fails after entry', h => h.replaceRoute(async () => { throw new Error('terrain-changed') }), true, true],
    ['the Worker returns a forged join receipt', h => h.replaceStart(async () => ({ visitId: randomUUID(), online: true, atCamp: true })), false, false],
  ]) {
    await t.test(label, async t => {
      const h = fixture(t)
      change(h)
      await h.open()
      await h.respond(decision)
      const current = h.job()
      assert.notEqual(current.task.status, 'succeeded')
      assert.equal(h.routes.length > 0, attemptedRoute)
      assert.deepEqual(h.stops, [current.id])
      assert.equal(current.payload.visitStatus, 'offline')
      assert.equal(h.state.online, false)
      assert.equal(h.offlineMemories().length, Number(joined))
      assert.deepEqual(projectCommunity('idle', h.store).recentCamp, [])
    })
  }
})

test('a stale or mismatched end receipt never marks a visit successful; the same lease is used for recovery', async t => {
  const h = fixture(t)
  h.replaceStop(async () => ({ visitId: randomUUID(), online: false, confirmed: true }))
  await h.open()
  await h.respond(decision)
  const current = h.job()
  assert.notEqual(current.task.status, 'succeeded')
  assert.equal(current.payload.visitStatus, 'unconfirmed')
  assert.deepEqual(h.offlineMemories(), [])
  assert.deepEqual(h.offlineEvents(), [])
  assert.deepEqual(h.stops, [current.id])
  h.replaceStop(h.defaultStop)
  h.advance(local(12, 1))
  await h.poll()
  assert.deepEqual(h.stops, [current.id, current.id])
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.offlineMemories().length, 1)
  assert.equal(h.sent.length, 1)
})

test('revoking a visit during its start stops subsequent movement and still confirms cleanup', async t => {
  const h = fixture(t)
  const startGate = Promise.withResolvers()
  h.replaceStart(async id => {
    await startGate.promise
    h.state.online = true
    return { visitId: id, online: true, atCamp: true }
  })
  await h.open()
  await h.respond(decision)
  const current = h.job()
  try {
    assert.equal(current.payload.visitStatus, 'starting')
    h.service.revokeSurveyWindow()
    assert.equal(h.starts[0].signal.aborted, true)
  } finally {
    startGate.resolve()
    await h.settle()
  }
  assert.equal(h.job().task.status, 'cancelled')
  assert.equal(h.service.surveyWindowView().lastVisit.status, 'offline')
  assert.equal(h.service.surveyWindowView().rule, null)
  assert.deepEqual(h.routes, [])
  assert.deepEqual(h.stops, [current.id])
})

test('camp pause during an in-flight route aborts that route and never starts a replacement', async t => {
  const h = fixture(t)
  const started = Promise.withResolvers()
  h.replaceRoute(async (_zoneId, _direction, signal) => {
    started.resolve()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await h.open()
  await h.respond(decision)
  await started.promise
  h.state.paused = true
  h.service.stopMinecraftSurveyWindowForToday()
  await h.settle()
  const current = h.job()
  assert.equal(current.task.status, 'cancelled')
  assert.equal(current.payload.visitStatus, 'offline')
  assert.equal(h.service.surveyWindowView().today.status, 'suppressed')
  assert.deepEqual(h.stops, [current.id])
  assert.equal(h.routes.length, 1)
  await h.poll()
  assert.equal(h.sent.length, 1)
})

test('host restart only reconciles a previously persisted lease, never replays its login or survey', async t => {
  for (const [label, surveyed, starting] of [['interrupted entry', false, true], ['completed route missing final proof', true, false]]) {
    await t.test(label, async t => {
      const h = fixture(t)
      h.state.ready = false
      const id = h.seedRecovery({ surveyed, status: starting ? 'starting' : 'online' })
      await h.settle()
      // The worker survives the simulated host restart, with the role online under the same lease.
      h.state.online = true
      await h.restart()
      const current = h.job()
      assert.equal(current.id, id)
      assert.equal(current.task.status, surveyed ? 'succeeded' : 'failed')
      assert.equal(current.payload.visitStatus, 'offline')
      assert.deepEqual(h.stops, [id])
      assert.deepEqual(h.starts, [])
      assert.deepEqual(h.routes, [])
      assert.deepEqual(h.sent, [])
      assert.equal(h.offlineMemories().length, Number(!starting))
    })
  }
})

test('after a long host outage, the latest uncertain lease is checked once and its interrupted game task is finalized', async t => {
  const h = fixture(t)
  h.state.ready = false
  const id = h.seedRecovery({ status: 'unconfirmed', endedMs: 60_000 })
  const survey = h.store.createTask({ capabilityId: 'minecraft.survey', contextId: 'game.minecraft',
    title: '中断中的短访勘察', externalId: CAMP_VISIT_SURVEY_TASK_PREFIX + id })
  h.store.transitionTask(survey.id, 'running')
  await h.settle()
  h.advance(local(12, 20))
  h.state.online = true
  await h.restart()
  assert.equal(h.job().task.status, 'failed')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.store.taskById(survey.id).status, 'failed')
  assert.deepEqual(h.stops, [id])
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.routes, [])
  assert.deepEqual(h.sent, [])
  assert.equal(h.offlineMemories().length, 1)
  h.advance(local(12, 25))
  await h.poll()
  assert.deepEqual(h.stops, [id])
})

test('only separately authorized visits expose actual inventory, while old visits stay single-turn', async t => {
  await t.test('legacy grant never requests a supply preview', async t => {
    const h = fixture(t, { supply: true })
    await h.open()
    await h.respond(decision)
    assert.equal(h.job().task.status, 'succeeded')
    assert.equal(h.sent.length, 1)
    assert.deepEqual(h.supplyPreviews, [])
    assert.equal(h.starts[0].allowSupply, undefined)
  })
  await t.test('unavailable provider cannot be granted supply', t => {
    const h = fixture(t)
    assert.throws(() => h.service.setSurveyWindow({ ...h.rule, allowMinecraftSupply: true }), /survey-window-unavailable/u)
  })
  for (const [name, inventory] of [['no available recipe', null], ['enough existing planks', { recipe: 'oak_planks', availableLogs: 5, planks: 8 }]]) {
    await t.test(name, async t => {
      const h = fixture(t, { supply: true })
      h.state.supplyOffer = inventory
      await h.open({ ...h.rule, allowMinecraftSupply: true })
      await h.respond(decision)
      assert.equal(h.sent.length, 1)
      assert.equal(h.supplyPreviews.length, 1)
      assert.equal(h.routes.length, 1)
      assert.deepEqual(h.crafts, [])
      assert.equal(h.job().payload.visitStatus, 'offline')
    })
  }
})

async function openVisitWithSupply(h) {
  await h.open({ ...h.rule, allowMinecraftSupply: true })
  assert.equal(h.sent[0].receipt.contextId, DAILY_AUTONOMY_CONTEXT)
  assert.deepEqual(h.supplyPreviews, [])
  await h.respond(decision)
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_VISIT_CONTEXT)
  assert.match(h.sent.at(-1).prompt, /同种原木 3 根，木板总数 0 块/u)
  assert.deepEqual(h.crafts, [])
  assert.deepEqual(h.routes, [])
}

test('real structured supply receipt gates diary, memory, reflection and final offline status', async t => {
  const h = fixture(t, { supply: true })
  h.service.updateSettings({ dailyReflectionEnabled: true })
  await openVisitWithSupply(h)
  const id = h.job().id
  const pendingEnd = Promise.withResolvers()
  h.replaceStop(async lease => { await pendingEnd.promise; return h.defaultStop(lease) })
  try {
    await h.respond({ decision: 'supply' })
    assert.equal(h.job().task.status, 'running')
    assert.equal(h.job().payload.choice, 'supply')
    assert.equal(h.starts[0].allowSupply, true)
    assert.deepEqual(h.crafts, [{ id, zoneId: h.zone.id, recipe: 'oak_planks' }])
    assert.deepEqual(h.routes, [])
    const child = h.store.autonomy.get(h.job().payload.activityTaskId)
    assert.equal(child.task.status, 'succeeded')
    assert.deepEqual(child.payload.visitSupply.inventory, { logsBefore: 3, logsAfter: 2, planksBefore: 0, planksAfter: 4 })
    assert.equal(verifiedDailyReflectionSource(h.store, id), undefined)
    assert.equal(h.store.autonomy.list().some(job => job.kind === 'daily.reflect'), false)
  } finally {
    pendingEnd.resolve()
    await h.settle()
  }
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.service.surveyWindowView().today.choice, 'supply')
  assert.equal(projectCommunity('idle', h.store).recentCamp[0].kind, 'supply')
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(memory => /新增 4 块木板/u.test(memory.content)))
  assert.equal(verifiedDailyReflectionSource(h.store, id)?.experience.kind, 'supply')
  assert.equal(h.store.autonomy.list().filter(job => job.kind === 'daily.reflect').length, 1)
  assert.deepEqual(h.stops, [id])
})

test('on-site choice can decline, choose a surveyed route, or reject forged and stale responses', async t => {
  for (const [name, response, status, routes, options] of [
    ['declines', { decision: 'skip' }, 'cancelled', 0],
    ['takes survey', { decision: 'survey' }, 'succeeded', 1],
    ['forges recipe', { decision: 'supply', recipe: 'diamond_block' }, 'failed', 0],
    ['forges claim', { decision: 'supply' }, 'failed', 0, { mismatchedClaim: true }],
  ]) await t.test(name, async t => {
    const h = fixture(t, { supply: true })
    await openVisitWithSupply(h)
    await h.respond(response, options)
    assert.equal(h.job().task.status, status)
    assert.equal(h.routes.length, routes)
    assert.deepEqual(h.crafts, [])
    assert.deepEqual(h.stops, [h.job().id])
  })
})

test('revoke or decision timeout triggers cleanup without dispatching the second choice', async t => {
  await t.test('owner revokes while awaiting the actual inventory decision', async t => {
    const h = fixture(t, { supply: true })
    await openVisitWithSupply(h)
    h.service.revokeSurveyWindow()
    await h.respond({ decision: 'supply' })
    assert.equal(h.job().task.status, 'cancelled')
    assert.deepEqual(h.crafts, [])
    assert.deepEqual(h.stops, [h.job().id])
    assert.equal(h.job().payload.visitStatus, 'offline')
  })
  await t.test('late model answer cannot spend inventory', async t => {
    const h = fixture(t, { supply: true })
    await openVisitWithSupply(h)
    h.advance(local(12, 1))
    await h.respond({ decision: 'supply' })
    assert.equal(h.job().task.status, 'failed')
    assert.deepEqual(h.crafts, [])
    assert.deepEqual(h.stops, [h.job().id])
  })
})

test('a successful craft task without its exact game receipt cannot create a supply record', async t => {
  const h = fixture(t, { supply: true })
  h.replaceCraft(async id => h.supplyReceipt(id, false))
  await openVisitWithSupply(h)
  await h.respond({ decision: 'supply' })
  assert.equal(h.job().task.status, 'failed')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.store.autonomy.get(h.job().payload.activityTaskId).task.status, 'failed')
  assert.deepEqual(projectCommunity('idle', h.store).recentCamp, [])
  assert.equal(verifiedDailyReflectionSource(h.store, h.job().id), undefined)
})

test('host can recover exact committed supply proof and confirm offline without spending inventory again', async t => {
  const h = fixture(t, { supply: true })
  h.state.ready = false
  const id = h.seedRecovery()
  const parent = h.store.autonomy.get(id)
  const child = h.store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, dedupeKey: `visit-supply:${id}`,
    runAfter: Date.now(), maxAttempts: 1, payload: { zoneId: h.zone.id, expiresAt: parent.payload.visitExpiresAt, goal: 'planks', visitId: id } })
  h.store.transitionTask(child.id, 'running')
  h.store.autonomy.update(id, { payload: { ...parent.payload, choice: 'supply', activityTaskId: child.id } })
  h.supplyReceipt(id)
  h.state.online = true
  await h.restart({ abrupt: true })
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.store.autonomy.get(child.id).task.status, 'succeeded')
  assert.equal(verifiedDailyReflectionSource(h.store, id)?.experience.kind, 'supply')
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.crafts, [])
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.stops, [id])
})

async function openVisitWithBuild(h, input = {}) {
  await h.open({ ...h.rule, allowMinecraftBuild: true, ...input })
  assert.deepEqual(h.buildPreviews, [])
  await h.respond(decision)
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_VISIT_CONTEXT)
  assert.match(h.sent.at(-1).prompt, /已核验的空地.*选搭建/u)
  assert.deepEqual(h.builds, [])
}

test('a build lease is independent and unavailable offers retain the single-turn survey path', async t => {
  await t.test('provider is required', t => {
    const h = fixture(t, { supply: true })
    assert.throws(() => h.service.setSurveyWindow({ ...h.rule, allowMinecraftBuild: true }), /survey-window-unavailable/u)
  })
  await t.test('supply grant does not grant build', async t => {
    const h = fixture(t, { supply: true, build: true })
    await openVisitWithSupply(h)
    assert.equal(h.starts[0].allowBuild, undefined)
    assert.deepEqual(h.buildPreviews, [])
    await h.respond({ decision: 'build' })
    assert.equal(h.job().task.status, 'failed')
    assert.deepEqual(h.builds, [])
    assert.deepEqual(h.stops, [h.job().id])
  })
  for (const offer of [null, { material: 'oak_planks', availableFloor: 7, workbenches: 1 }]) {
    await t.test(offer ? 'short inventory' : 'no eligible location', async t => {
      const h = fixture(t, { build: true })
      h.state.buildOffer = offer
      await h.open({ ...h.rule, allowMinecraftBuild: true })
      await h.respond(decision)
      assert.equal(h.sent.length, 1)
      assert.equal(h.buildPreviews.length, 1)
      assert.equal(h.routes.length, 1)
      assert.equal(h.job().payload.visitStatus, 'offline')
      assert.deepEqual(h.builds, [])
    })
  }
})

test('exact build receipt records a construction and reflection waits for offline readback', async t => {
  const h = fixture(t, { supply: true, build: true })
  h.service.updateSettings({ dailyReflectionEnabled: true })
  await openVisitWithBuild(h)
  const id = h.job().id
  assert.equal(h.starts[0].allowBuild, true)
  assert.equal(h.starts[0].allowSupply, undefined)
  assert.doesNotMatch(h.sent.at(-1).prompt, /选补给/u)
  assert.deepEqual(h.supplyPreviews, [])
  const pendingEnd = Promise.withResolvers()
  h.replaceStop(async lease => { await pendingEnd.promise; return h.defaultStop(lease) })
  try {
    await h.respond({ decision: 'build' })
    assert.equal(h.job().task.status, 'running')
    assert.deepEqual(h.builds, [{ id, zoneId: h.zone.id, material: 'oak_planks' }])
    assert.deepEqual(h.routes, [])
    assert.deepEqual(h.crafts, [])
    const child = h.store.autonomy.get(h.job().payload.activityTaskId)
    assert.equal(child.task.status, 'succeeded')
    assert.deepEqual(child.payload.visitBuild.inventory, { floorBefore: 8, floorAfter: 0, tablesBefore: 1, tablesAfter: 0 })
    assert.equal(verifiedDailyReflectionSource(h.store, id), undefined)
  } finally {
    pendingEnd.resolve()
    await h.settle()
  }
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.service.surveyWindowView().today.choice, 'build')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.deepEqual(projectCommunity('idle', h.store).recentCamp[0], { kind: 'build', at: new Date(local(12, 0)).toISOString() })
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(memory => /放置 8 块木板和 1 个工作台/u.test(memory.content)))
  assert.equal(verifiedDailyReflectionSource(h.store, id)?.experience.kind, 'build')
  assert.equal(h.store.autonomy.list().filter(job => job.kind === 'daily.reflect').length, 1)
  assert.deepEqual(h.stops, [id])
})

test('construction rejects a forged model parameter or a revoked window without building', async t => {
  for (const [name, response, revoked] of [
    ['forged material', { decision: 'build', material: 'diamond_block' }, false],
    ['unoffered supply', { decision: 'supply' }, false],
    ['revoked during decision', { decision: 'build' }, true],
  ]) await t.test(name, async t => {
    const h = fixture(t, { build: true })
    await openVisitWithBuild(h)
    if (revoked) h.service.revokeSurveyWindow()
    await h.respond(response)
    assert.equal(h.job().task.status, revoked ? 'cancelled' : 'failed')
    assert.deepEqual(h.builds, [])
    assert.deepEqual(h.routes, [])
    assert.deepEqual(h.stops, [h.job().id])
  })
})

test('inexact construction proof cannot appear as an experience even when the game task succeeds', async t => {
  for (const [name, options] of [
    ['missing private activity', { withEvidence: false }],
    ['wrong authorized zone', { zoneId: randomUUID() }],
    ['different material', { material: 'birch_planks' }],
    ['incorrect debit', { floorAfter: 1 }],
  ]) await t.test(name, async t => {
    const h = fixture(t, { build: true })
    h.replaceBuild(async id => h.buildReceipt(id, options))
    await openVisitWithBuild(h)
    await h.respond({ decision: 'build' })
    assert.equal(h.job().task.status, 'failed')
    assert.equal(h.job().payload.visitStatus, 'offline')
    assert.equal(h.store.autonomy.get(h.job().payload.activityTaskId).task.status, 'failed')
    assert.deepEqual(projectCommunity('idle', h.store).recentCamp, [])
    assert.equal(verifiedDailyReflectionSource(h.store, h.job().id), undefined)
  })
})

test('restart reuses committed construction proof and logs out without building a second time', async t => {
  const h = fixture(t, { build: true })
  h.state.ready = false
  const id = h.seedRecovery()
  const parent = h.store.autonomy.get(id)
  const child = h.store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, dedupeKey: `visit-build:${id}`,
    runAfter: Date.now(), maxAttempts: 1, payload: { campZoneId: h.zone.id, expiresAt: parent.payload.visitExpiresAt, goal: 'camp', visitId: id } })
  h.store.transitionTask(child.id, 'running')
  h.store.autonomy.update(id, { payload: { ...parent.payload, choice: 'build', activityTaskId: child.id } })
  h.buildReceipt(id)
  h.state.online = true
  await h.restart({ abrupt: true })
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.store.autonomy.get(child.id).task.status, 'succeeded')
  assert.equal(verifiedDailyReflectionSource(h.store, id)?.experience.kind, 'build')
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.builds, [])
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.stops, [id])
})

const projectGrant = { allowMinecraftProject: true, allowMinecraftSupply: true, allowMinecraftBuild: true }
const projectFixture = t => fixture(t, { supply: true, build: true, revisit: true })

async function nextProjectDay(h, day) {
  h.advance(local(12, 0, day))
  await h.poll()
  assert.equal(h.job().dedupeKey, `daily:2026-11-${day}`)
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_AUTONOMY_CONTEXT)
  await h.respond(decision)
}

async function firstDayBuild(h) {
  h.state.supplyOffer = null
  await openVisitWithBuild(h, { ...projectGrant, days: 7 })
  await h.respond({ decision: 'build' })
}

test('one opt-in carries two supply visits, construction and a read-only revisit across four distinct days', async t => {
  const h = projectFixture(t)
  h.state.buildOffer = null
  h.state.supplyOffer = { recipe: 'oak_planks', availableLogs: 4, planks: 0 }
  h.replaceCraft(async id => {
    const { availableLogs, planks } = h.state.supplyOffer
    return h.supplyReceipt(id, true, { logsBefore: availableLogs, logsAfter: availableLogs - 1, planksBefore: planks, planksAfter: planks + 4 })
  })
  await h.open({ ...h.rule, ...projectGrant, days: 7 })
  const ruleId = h.service.surveyWindowView().rule.id
  await h.respond(decision)
  assert.match(h.sent.at(-1).prompt, /已确认 0 次补给/u)
  await h.respond({ decision: 'supply' })
  assert.deepEqual(h.service.surveyWindowView().project, { stage: 'gathering', supplyVisits: 1 })
  await h.poll()
  assert.equal(h.crafts.length, 1)

  h.state.supplyOffer = { recipe: 'oak_planks', availableLogs: 3, planks: 4 }
  await nextProjectDay(h, 10)
  assert.match(h.sent.at(-1).prompt, /已确认 1 次补给/u)
  await h.respond({ decision: 'supply' })
  assert.deepEqual(h.service.surveyWindowView().project, { stage: 'gathering', supplyVisits: 2 })

  h.state.supplyOffer = null
  delete h.state.buildOffer
  await nextProjectDay(h, 11)
  const holdOffline = Promise.withResolvers()
  h.replaceStop(async id => { await holdOffline.promise; return h.defaultStop(id) })
  try {
    await h.respond({ decision: 'build' })
    assert.equal(h.service.surveyWindowView().project.stage, 'gathering')
    assert.equal(h.revisits.length, 0)
  } finally {
    holdOffline.resolve()
    await h.settle()
    h.replaceStop(h.defaultStop)
  }
  const built = h.service.surveyWindowView().project
  assert.deepEqual(built, { stage: 'revisit', supplyVisits: 2, builtAt: new Date(local(12, 0, 11)).toISOString() })

  await nextProjectDay(h, 12)
  assert.match(h.sent.at(-1).prompt, /选复访/u)
  assert.doesNotMatch(h.sent.at(-1).prompt, /选搭建|选补给/u)
  assert.equal(h.starts.at(-1).allowRevisit, true)
  assert.equal(h.starts.at(-1).allowSupply, undefined)
  await h.respond({ decision: 'revisit' })
  assert.deepEqual(h.service.surveyWindowView().project, { ...built, stage: 'complete', revisitedAt: new Date(local(12, 0, 12)).toISOString() })
  assert.equal(h.service.surveyWindowView().today.choice, 'revisit')
  assert.deepEqual(h.revisits, [{ id: h.job().id, zoneId: h.zone.id, material: 'oak_planks' }])
  assert.deepEqual(h.store.autonomy.campProjectDays(ruleId).map(day => day.payload.choice), ['supply', 'supply', 'build', 'revisit'])
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(memory => /九处方块全部与原营地一致/u.test(memory.content)))

  await nextProjectDay(h, 13)
  assert.equal(h.starts.at(-1).allowBuild, undefined)
  assert.equal(h.starts.at(-1).allowRevisit, undefined)
  assert.equal(h.routes.length, 1)
  assert.equal(h.crafts.length, 2)
  assert.equal(h.builds.length, 1)
  assert.equal(h.revisits.length, 1)
  assert.equal(h.service.surveyWindowView().project.stage, 'complete')
})

test('the revisit reports changes, rejects unproven results and never triggers repairs', async t => {
  for (const [name, proof, stage] of [
    ['structure changed', { matchedBlocks: 7 }, 'needs-review'],
    ['invalid check count', { matchedBlocks: 10 }, 'revisit'],
    ['incorrect material', { receiptMaterial: 'birch_planks' }, 'revisit'],
    ['no private proof', { withEvidence: false }, 'revisit'],
  ]) await t.test(name, async t => {
    const h = projectFixture(t)
    await firstDayBuild(h)
    h.state.revisitProof = proof
    await nextProjectDay(h, 10)
    await h.respond({ decision: 'revisit' })
    assert.equal(h.service.surveyWindowView().project.stage, stage)
    assert.equal(h.job().task.status, stage === 'needs-review' ? 'succeeded' : 'failed')
    assert.equal(h.job().payload.visitStatus, 'offline')
    assert.equal(h.builds.length, 1)
    assert.deepEqual(h.crafts, [])
    if (stage === 'needs-review') {
      await nextProjectDay(h, 11)
      assert.equal(h.starts.at(-1).allowBuild, undefined)
      assert.equal(h.starts.at(-1).allowRevisit, undefined)
      assert.equal(h.service.surveyWindowView().project.stage, 'needs-review')
    }
  })
})

test('a construction without a confirmed logout requires review on the next day', async t => {
  const h = projectFixture(t)
  h.replaceStop(async id => { await h.defaultStop(id); return { visitId: id, online: false, confirmed: false } })
  await firstDayBuild(h)
  assert.equal(h.job().task.status, 'failed')
  assert.equal(h.job().payload.visitStatus, 'unconfirmed')
  assert.deepEqual(h.service.surveyWindowView().project, { stage: 'needs-review', supplyVisits: 0 })
  h.replaceStop(h.defaultStop)
  await nextProjectDay(h, 10)
  assert.equal(h.starts.at(-1).allowBuild, undefined)
  assert.equal(h.starts.at(-1).allowRevisit, undefined)
  assert.equal(h.builds.length, 1)
  assert.deepEqual(h.revisits, [])
})

test('project authorization does not carry a construction into a replacement window', async t => {
  const h = projectFixture(t)
  await firstDayBuild(h)
  assert.equal(h.service.surveyWindowView().project.stage, 'revisit')
  const previous = h.service.surveyWindowView().rule.id
  h.service.revokeSurveyWindow()
  assert.equal(h.service.surveyWindowView().project, undefined)
  h.advance(local(11, 55, 10))
  const fresh = h.service.setSurveyWindow({ ...h.rule, ...projectGrant })
  assert.notEqual(fresh.rule.id, previous)
  assert.deepEqual(fresh.project, { stage: 'gathering', supplyVisits: 0 })
  h.state.buildOffer = null
  await nextProjectDay(h, 10)
  assert.equal(h.starts.at(-1).allowRevisit, undefined)
  assert.deepEqual(h.revisits, [])
})

test('a host restart resumes a committed revisit receipt and never reads or dispatches it again', async t => {
  const h = projectFixture(t)
  await firstDayBuild(h)
  const built = h.store.autonomy.get(h.job().payload.activityTaskId)
  const rule = h.service.surveyWindowView().rule
  h.state.ready = false
  h.advance(local(12, 0, 10))
  const expiresAt = local(12, 4, 10)
  const parent = h.store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:2026-11-10',
    runAfter: Date.now(), maxAttempts: 1, payload: { windowRuleId: rule.id, date: '2026-11-10', expiresAt: local(12, 45, 10) } })
  h.store.transitionTask(parent.id, 'running')
  const child = h.store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, dedupeKey: `visit-revisit:${parent.id}`,
    runAfter: Date.now(), maxAttempts: 1, payload: { campZoneId: h.zone.id, expiresAt, goal: 'revisit', visitId: parent.id,
      constructionTaskId: built.payload.receiptTaskId } })
  h.store.transitionTask(child.id, 'running')
  h.store.autonomy.update(parent.id, { attempts: 1, payload: { ...parent.payload, choice: 'revisit', activityTaskId: child.id,
    visitId: parent.id, visitExpiresAt: expiresAt, visitJoined: true, visitStatus: 'online' } })
  h.revisitReceipt(parent.id, 'oak_planks')
  h.state.online = true
  await h.restart({ abrupt: true })
  assert.equal(h.job().task.status, 'succeeded')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.store.autonomy.get(child.id).task.status, 'succeeded')
  assert.equal(h.service.surveyWindowView().project.stage, 'complete')
  assert.deepEqual(h.revisits, [])
  assert.equal(h.starts.length, 1)
  assert.equal(h.sent.length, 2)
  assert.equal(h.stops.at(-1), parent.id)
})

test('cancelling the active camp task aborts a revisit and confirms logout', async t => {
  const h = projectFixture(t)
  await firstDayBuild(h)
  await nextProjectDay(h, 10)
  let runningSignal
  h.state.onRevisit = signal => new Promise((_resolve, reject) => {
    runningSignal = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await h.respond({ decision: 'revisit' })
  assert.equal(h.service.cancelMinecraftSupply(randomUUID()), false)
  assert.equal(runningSignal.aborted, false)
  assert.equal(h.service.cancelMinecraftSupply(h.zone.id), true)
  await h.settle()
  assert.equal(runningSignal.aborted, true)
  assert.equal(h.job().task.status, 'cancelled')
  assert.equal(h.job().payload.visitStatus, 'offline')
  assert.equal(h.service.surveyWindowView().project.stage, 'revisit')
})

const choosePatrol = { decision: 'patrol' }
const openPatrol = h => h.open({ ...h.rule, allowMinecraftPatrol: true })

test('daily patrol requires its own opt-in and cannot be forged by a model choice', async t => {
  const h = fixture(t, { patrol: true })
  await h.open()
  assert.equal(h.service.surveyWindowView().campPatrolAvailable, true)
  assert.doesNotMatch(h.sent[0].prompt, /"patrol"/u)
  await h.respond(choosePatrol)
  assert.equal(h.job().task.status, 'failed')
  assert.deepEqual(h.starts, [])
  assert.equal(h.service.campPatrolSummary(), undefined)
})

test('patrol renews the route check between verified legs and waits for logout', async t => {
  const h = fixture(t, { patrol: true, supply: true, build: true })
  const holdOffline = Promise.withResolvers()
  h.replaceStop(async id => { await holdOffline.promise; return h.defaultStop(id) })
  h.state.onPatrol = async request => {
    if (request.index === 1) h.state.offer = { directions: ['north', 'south'],
      routes: [{ direction: 'north', steps: 4 }, { direction: 'south', steps: 6 }] }
    return h.patrolReceipt(request)
  }
  await h.open({ ...h.rule, allowMinecraftPatrol: true, allowMinecraftSupply: true, allowMinecraftBuild: true })
  assert.match(h.sent[0].prompt, /"patrol"/u)
  try {
    await h.respond(choosePatrol)
    assert.deepEqual(h.patrols.map(({ index, direction, steps }) => [index, direction, steps]), [[1, 'north', 4], [2, 'south', 6]])
    assert.equal(h.previews.length, 2)
    assert.deepEqual(h.crafts, [])
    assert.deepEqual(h.builds, [])
    assert.deepEqual(h.routes, [])
    assert.equal(h.sent.length, 1)
    assert.equal(h.starts[0].patrol, true)
    assert.equal(h.starts[0].allowSupply, undefined)
    assert.equal(h.starts[0].expiresAt - Date.now(), CAMP_PATROL_MAX_MS)
    assert.deepEqual(h.service.campPatrolSummary(), { status: 'running', completedSegments: 2, totalSegments: 2, visitStatus: 'online' })
  } finally {
    holdOffline.resolve()
    await h.settle()
  }
  assert.equal(h.job().task.status, 'succeeded')
  assert.deepEqual(h.service.campPatrolSummary(), { status: 'completed', completedSegments: 2, totalSegments: 2, visitStatus: 'offline' })
  assert.equal(h.service.surveyWindowView().today.choice, 'patrol')
  assert.equal(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).filter(memory => /段巡视已完成/u.test(memory.content)).length, 2)
  h.service.revokeSurveyWindow()
  assert.equal(h.service.surveyWindowView().rule, null)
  assert.equal(h.service.surveyWindowView().patrol.status, 'completed')
})

test('patrol stops on an unsafe next route, verified retreat or missing private proof', async t => {
  for (const [name, options, change, completedSegments] of [
    ['no distinct route survives', {}, true, 1],
    ['first leg returns early', { recovered: true }, false, 0],
    ['first leg has no private receipt', { withEvidence: false }, false, 0],
  ]) await t.test(name, async t => {
    const h = fixture(t, { patrol: true })
    h.state.onPatrol = async request => {
      if (change) h.state.offer = { directions: ['north'], routes: [{ direction: 'north', steps: 4 }] }
      return h.patrolReceipt(request, options)
    }
    await openPatrol(h)
    await h.respond(choosePatrol)
    assert.equal(h.patrols.length, 1)
    assert.deepEqual(h.service.campPatrolSummary(), { status: completedSegments ? 'partial' : 'failed', completedSegments, totalSegments: 2, visitStatus: 'offline' })
    assert.deepEqual(h.stops, [h.job().id])
  })
})

test('pause aborts the second patrol leg and preserves only the first verified return', async t => {
  const h = fixture(t, { patrol: true })
  let secondSignal
  h.state.onPatrol = (request, signal) => request.index === 1 ? h.patrolReceipt(request) : new Promise((_resolve, reject) => {
    secondSignal = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await openPatrol(h)
  await h.respond(choosePatrol)
  assert.deepEqual(h.service.campPatrolSummary(), { status: 'running', completedSegments: 1, totalSegments: 2, visitStatus: 'online' })
  h.service.stopMinecraftSurveyWindowForToday()
  await h.settle()
  assert.equal(secondSignal.aborted, true)
  assert.deepEqual(h.service.campPatrolSummary(), { status: 'cancelled', completedSegments: 1, totalSegments: 2, visitStatus: 'offline' })
  await h.poll()
  assert.equal(h.starts.length, 1)
  assert.deepEqual(h.stops, [h.job().id])
})

test('a host restart keeps the confirmed patrol leg and never resumes the interrupted lease', async t => {
  const h = fixture(t, { patrol: true })
  const id = h.seedRecovery()
  const job = h.store.autonomy.get(id)
  h.store.autonomy.update(id, { payload: { ...job.payload, choice: 'patrol', patrolZoneId: h.zone.id } })
  h.patrolReceipt({ id, index: 1, zoneId: h.zone.id, direction: 'east', steps: 5 })
  const interrupted = h.store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: '未取得回执的第二段',
    externalId: `${CAMP_VISIT_PATROL_TASK_PREFIX}${id}:2` })
  h.store.transitionTask(interrupted.id, 'running')
  h.state.online = true
  await h.restart({ abrupt: true })
  assert.deepEqual(h.service.campPatrolSummary(), { status: 'partial', completedSegments: 1, totalSegments: 2, visitStatus: 'offline' })
  assert.equal(h.store.taskById(interrupted.id).status, 'failed')
  assert.deepEqual(h.patrols, [])
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.stops, [id])
})

test('repeating a patrol on another day preserves both days of memory provenance', async t => {
  const h = fixture(t, { patrol: true })
  await openPatrol(h)
  await h.respond(choosePatrol)
  h.advance(local(12, 0, 10))
  await h.poll()
  await h.respond(choosePatrol)
  const memories = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).filter(memory => /段巡视已完成/u.test(memory.content))
  assert.equal(memories.length, 4)
  assert.equal(memories.filter(memory => memory.content.startsWith('2026-11-09')).length, 2)
  assert.equal(memories.filter(memory => memory.content.startsWith('2026-11-10')).length, 2)
  assert.equal(new Set(memories.map(memory => memory.sourceRefs[0].taskId)).size, 4)
})

const chooseGather = { decision: 'gather' }
const openGather = h => h.open({ ...h.rule, allowMinecraftGather: true })

test('gather requires its own grant and exposes only one live offer', async t => {
  const h = fixture(t, { gather: true })
  await h.open()
  assert.equal(h.service.surveyWindowView().campGatherAvailable, true)
  assert.doesNotMatch(h.sent[0].prompt, /"gather"/u)
  await h.respond(chooseGather)
  assert.equal(h.job().task.status, 'failed')
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.gatherPreviews, [])
})

test('one independently authorized gathering requires a receipt and offline before completing', async t => {
  const h = fixture(t, { gather: true, patrol: true, supply: true, build: true })
  const hold = Promise.withResolvers()
  h.replaceStop(async id => { await hold.promise; return h.defaultStop(id) })
  await h.open({ ...h.rule, allowMinecraftGather: true, allowMinecraftPatrol: true, allowMinecraftSupply: true, allowMinecraftBuild: true })
  assert.match(h.sent[0].prompt, /"gather"/u)
  try {
    await h.respond(chooseGather)
    assert.deepEqual(h.gatherPreviews, [{ id: h.job().id, zoneId: h.zone.id }])
    assert.deepEqual(h.gathers, [{ id: h.job().id, zoneId: h.zone.id, offer: { direction: 'north', steps: 4, log: 'oak_log' } }])
    assert.equal(h.sent.length, 1)
    assert.equal(h.starts[0].gather, true)
    assert.equal(h.starts[0].expiresAt - Date.now(), CAMP_GATHER_MAX_MS)
    assert.equal(h.starts[0].allowSupply, undefined)
    assert.equal(h.starts[0].patrol, undefined)
    assert.deepEqual(h.routes, [])
    assert.deepEqual(h.crafts, [])
    assert.deepEqual(h.builds, [])
    assert.deepEqual(h.service.campGatherSummary(), { status: 'running', collected: 1, visitStatus: 'online' })
  } finally {
    hold.resolve()
    await h.settle()
  }
  assert.deepEqual(h.service.campGatherSummary(), { status: 'completed', collected: 1, visitStatus: 'offline' })
  assert.equal(h.service.surveyWindowView().today.choice, 'gather')
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(memory => /采集了 1 根自然橡木原木/u.test(memory.content)))
  h.service.revokeSurveyWindow()
  assert.equal(h.service.surveyWindowView().rule, null)
  assert.equal(h.service.surveyWindowView().gather.status, 'completed')
})

test('gather declines a missing target and rejects mismatched or invented receipts', async t => {
  for (const [name, offer, receipt] of [
    ['no safe tree', null, {}],
    ['unapproved material', { direction: 'north', steps: 4, log: 'spruce_log' }, {}],
    ['wrong path', undefined, { direction: 'south' }],
    ['inventory gain is not one', undefined, { inventoryAfter: 3 }],
    ['missing private proof', undefined, { withEvidence: false }],
  ]) await t.test(name, async t => {
    const h = fixture(t, { gather: true })
    h.state.gatherOffer = offer
    h.state.onGather = request => h.gatherReceipt(request, receipt)
    await openGather(h)
    await h.respond(chooseGather)
    assert.equal(h.gathers.length, offer === undefined ? 1 : 0)
    assert.deepEqual(h.service.campGatherSummary(), { status: 'failed', collected: 0, visitStatus: 'offline' })
    assert.deepEqual(h.stops, [h.job().id])
  })
})

test('pause cancels an in-flight gather and releases the owned visit', async t => {
  const h = fixture(t, { gather: true })
  let activeSignal
  h.state.onGather = (_request, signal) => new Promise((_resolve, reject) => {
    activeSignal = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await openGather(h)
  await h.respond(chooseGather)
  h.service.stopMinecraftSurveyWindowForToday()
  await h.settle()
  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(h.service.campGatherSummary(), { status: 'cancelled', collected: 0, visitStatus: 'offline' })
  await h.poll()
  assert.equal(h.starts.length, 1)
})

test('restart recovers a committed gathering receipt without dispatching again', async t => {
  const h = fixture(t, { gather: true })
  const id = h.seedRecovery()
  const job = h.store.autonomy.get(id)
  const offer = { direction: 'north', steps: 4, log: 'oak_log' }
  h.store.autonomy.update(id, { payload: { ...job.payload, choice: 'gather', gatherZoneId: h.zone.id, gatherOffer: offer } })
  h.gatherReceipt({ id, zoneId: h.zone.id, offer })
  h.state.online = true
  await h.restart({ abrupt: true })
  assert.deepEqual(h.service.campGatherSummary(), { status: 'completed', collected: 1, visitStatus: 'offline' })
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.gathers, [])
  assert.deepEqual(h.stops, [id])
  assert.equal(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).filter(memory => /自然橡木原木/u.test(memory.content)).length, 1)
})

const projectGatherGrant = { ...projectGrant, allowMinecraftGather: true, allowMinecraftProjectGather: true }
const projectGatherFixture = t => fixture(t, { supply: true, build: true, revisit: true, gather: true })

test('one project turns seven days of inventory offers and verified receipts into gather, supply, build and revisit choices', async t => {
  const h = projectGatherFixture(t)
  const inventory = { logs: 1, planks: 0, tables: 1 }
  const refresh = () => {
    const { logs, planks, tables } = inventory
    h.state.supplyOffer = logs >= 3 && planks < 8 ? { recipe: 'oak_planks', availableLogs: logs, planks } : null
    h.state.buildOffer = planks >= 8 && tables > 0 ? { material: 'oak_planks', availableFloor: planks, workbenches: tables } : null
    h.state.gatherOffer = tables > 0 && planks < 8 && logs < 3 ? { direction: 'north', steps: 4, log: 'oak_log' } : null
  }
  h.state.onGather = request => h.gatherReceipt(request, { inventoryBefore: inventory.logs++ })
  h.replaceCraft(async id => {
    const previous = { logsBefore: inventory.logs, planksBefore: inventory.planks }
    inventory.logs--
    inventory.planks += 4
    return h.supplyReceipt(id, true, { ...previous, logsAfter: inventory.logs, planksAfter: inventory.planks })
  })
  h.replaceBuild(async id => {
    assert.deepEqual(inventory, { logs: 2, planks: 8, tables: 1 })
    inventory.planks -= 8
    inventory.tables--
    return h.buildReceipt(id)
  })
  refresh()
  await h.open({ ...h.rule, ...projectGatherGrant, days: 7 })
  const ruleId = h.service.surveyWindowView().rule.id
  assert.equal(h.service.surveyWindowView().project.gatheredLogs, 0)
  assert.doesNotMatch(h.sent[0].prompt, /"decision":"gather"/u)
  await h.respond(decision)
  assert.equal(h.starts[0].projectGather, true)
  assert.equal(h.starts[0].allowSupply, true)
  assert.equal(h.starts[0].allowBuild, true)
  const offline = Promise.withResolvers()
  h.replaceStop(async id => { await offline.promise; return h.defaultStop(id) })
  try {
    await h.respond(chooseGather)
    assert.equal(h.service.campGatherSummary().collected, 1)
    assert.equal(h.service.surveyWindowView().project.gatheredLogs, 0)
  } finally {
    offline.resolve()
    await h.settle()
    h.replaceStop(h.defaultStop)
  }
  assert.equal(h.service.surveyWindowView().project.gatheredLogs, 1)
  for (const [day, choice, gatheredLogs, supplyVisits] of [
    [10, 'gather', 2, 0], [11, 'supply', 2, 1], [12, 'gather', 3, 1],
    [13, 'supply', 3, 2], [14, 'build', 3, 2], [15, 'revisit', 3, 2],
  ]) {
    refresh()
    await nextProjectDay(h, day)
    assert.match(h.sent.at(-1).prompt, new RegExp(`"decision":"${choice}"`, 'u'))
    if (choice !== 'gather') assert.doesNotMatch(h.sent.at(-1).prompt, /"decision":"gather"/u)
    await h.respond({ decision: choice })
    assert.equal(h.job().task.status, 'succeeded')
    assert.equal(h.service.surveyWindowView().project.gatheredLogs, gatheredLogs)
    assert.equal(h.service.surveyWindowView().project.supplyVisits, supplyVisits)
  }
  assert.equal(h.service.surveyWindowView().project.stage, 'complete')
  assert.deepEqual(inventory, { logs: 2, planks: 0, tables: 0 })
  assert.equal(h.gatherPreviews.length, 3)
  assert.equal(h.stops.length, 7)
  assert.deepEqual(h.store.autonomy.campProjectDays(ruleId).map(job => job.payload.choice), ['gather', 'gather', 'supply', 'gather', 'supply', 'build', 'revisit'])
})

test('existing grants keep gathering independent until the project connection is authorized', async t => {
  const h = projectGatherFixture(t)
  await h.open({ ...h.rule, ...projectGrant, allowMinecraftGather: true })
  assert.match(h.sent[0].prompt, /"decision":"gather"/u)
  await h.respond(chooseGather)
  assert.equal(h.starts[0].projectGather, undefined)
  assert.equal(h.service.campGatherSummary().collected, 1)
  assert.equal(h.service.surveyWindowView().project.gatheredLogs, undefined)
  h.service.revokeSurveyWindow()
  h.advance(local(11, 55, 10))
  const fresh = h.service.setSurveyWindow({ ...h.rule, ...projectGatherGrant })
  assert.equal(fresh.project.gatheredLogs, 0)
})

test('the project declines an unoffered or unproven gathering without increasing the ledger', async t => {
  for (const [name, supply, proof, dispatches] of [
    ['existing usable recipe', undefined, {}, 0], ['missing receipt', null, { withEvidence: false }, 1],
    ['overstocked proof', null, { inventoryBefore: 3 }, 1],
  ]) await t.test(name, async t => {
    const h = projectGatherFixture(t)
    h.state.supplyOffer = supply
    h.state.buildOffer = null
    h.state.onGather = request => h.gatherReceipt(request, proof)
    await h.open({ ...h.rule, ...projectGatherGrant })
    await h.respond(decision)
    await h.respond(chooseGather)
    assert.equal(h.job().task.status, 'failed')
    assert.equal(h.service.surveyWindowView().project.gatheredLogs, 0)
    assert.equal(h.gathers.length, dispatches)
    assert.equal(h.stops.length, 1)
  })
})
