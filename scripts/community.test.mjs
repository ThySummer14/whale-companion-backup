import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { projectCommunity, verifiedCampReceipt } from '../src/core/community.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { DAILY_AUTONOMY_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

const BASE = Date.parse('2026-11-01T09:00:00Z')
const at = milliseconds => new Date(BASE + milliseconds).toISOString()
const empty = { autonomy: { succeeded: () => [] }, taskById: () => undefined }

function fixture() {
  const jobs = []
  const children = new Map()
  const state = project => projectCommunity(project, {
    autonomy: { succeeded(kind, contextId, limit) {
      assert.equal(kind, 'minecraft.supply')
      assert.equal(contextId, MINECRAFT_SUPPLY_CONTEXT)
      assert.equal(limit, 32)
      return jobs.slice(0, limit)
    } },
    taskById: id => children.get(id),
  })
  const gameTask = (capabilityId, time) => {
    const task = { id: randomUUID(), capabilityId, contextId: 'game.minecraft', status: 'succeeded',
      createdAt: at(time - 100), updatedAt: at(time), title: 'private name and location' }
    children.set(task.id, task)
    return task
  }
  const permit = (goal, time, fields = {}) => {
    const zone = randomUUID()
    const action = { planks: 'craft', camp: 'build', prepare: 'build', survey: 'survey' }[goal]
    const field = { planks: 'zoneId', camp: 'campZoneId', prepare: 'prepareZoneId', survey: 'surveyZoneId' }[goal]
    const child = gameTask(`minecraft.${action}`, time)
    const id = randomUUID()
    const createdAt = at(time - 500)
    const updatedAt = at(time + 100)
    const job = {
      id, dedupeKey: id, kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, createdAt, updatedAt,
      task: { id, externalId: `autonomy:minecraft.supply:${id}`, contextId: MINECRAFT_SUPPLY_CONTEXT,
        capabilityId: 'core.autonomy', status: 'succeeded', createdAt, updatedAt },
      payload: { goal, [field]: zone, expiresAt: BASE + time + 1000, receiptTaskId: child.id, ...fields },
    }
    jobs.push(job)
    return { job, child }
  }
  return { jobs, gameTask, permit, state, taskById: id => children.get(id) }
}

test('the community follows the associated room activity and has no active site offline', () => {
  for (const [activity, activeSite] of Object.entries({ offline: null, idle: 'home', resting: 'home', chatting: 'home',
    minecraft: 'camp', speaking: 'studio', singing: 'studio', browsing: 'library' })) {
    assert.deepEqual(projectCommunity(activity, empty), { version: 1, activeSite, recentCamp: [] })
  }
})

test('camp entries use verified child completion times, retain old results offline and expose no identifiers', () => {
  const { jobs, permit, state } = fixture()
  const legacy = permit('planks', 1000)
  delete legacy.job.payload.goal
  permit('camp', 2000)
  permit('survey', 3000, { direction: 'west', surveySteps: 7, surveyOutcome: 'completed' })
  const recovery = permit('survey', 4000, { surveyTrail: 'east-south', surveyCheckpoints: 1, surveyOutcome: 'recovered' })
  // An identical persisted link must not count as another world action.
  jobs.push(structuredClone(recovery.job))
  permit('survey', 5000, { surveyTrail: 'north-west', surveyCheckpoints: 2, surveyOutcome: 'completed' })
  const view = state('offline')
  assert.equal(view.activeSite, null)
  assert.deepEqual(view.recentCamp, [
    { kind: 'survey', at: at(5000), outcome: 'completed', route: { kind: 'trail', trail: 'north-west', checkpoints: 2 } },
    { kind: 'survey', at: at(4000), outcome: 'recovered', route: { kind: 'trail', trail: 'east-south', checkpoints: 1 } },
    { kind: 'survey', at: at(3000), outcome: 'completed', route: { kind: 'straight', direction: 'west', steps: 7 } },
    { kind: 'build', at: at(2000) },
  ])
  assert.doesNotMatch(JSON.stringify(view), /TaskId|ZoneId|private|minecraft\.survey|autonomy/u)
  jobs.splice(1)
  assert.deepEqual(state('idle').recentCamp, [{ kind: 'supply', at: at(1000) }])
})

test('a prepared camp requires the verified final build and chronological unique craft receipts', () => {
  const { gameTask, permit, state } = fixture()
  const { job, child } = permit('prepare', 1000)
  const craft = gameTask('minecraft.craft', 800)
  const last = { action: 'build', taskId: child.id }
  const first = { action: 'craft', taskId: craft.id }
  job.payload.steps = [first, last]
  assert.deepEqual(state('minecraft').recentCamp, [{ kind: 'prepare', at: at(1000) }])
  job.payload.steps = [last]
  assert.equal(state('minecraft').recentCamp.length, 1)
  job.payload.steps = [first, first, last]
  assert.equal(state('minecraft').recentCamp.length, 0)
  job.payload.steps = [first]
  assert.equal(state('minecraft').recentCamp.length, 0)
  job.payload.steps = [first, last]
  craft.updatedAt = at(950)
  assert.equal(state('minecraft').recentCamp.length, 0)
})

test('short-visit supplies project only the activity and time after verifying the lease-bound inventory receipt', () => {
  const { gameTask, permit, state, taskById } = fixture()
  const daily = gameTask('core.autonomy', 500)
  Object.assign(daily, { contextId: DAILY_AUTONOMY_CONTEXT, externalId: 'autonomy:daily.choice:daily:2026-11-01' })
  const visitSupply = { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
    inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 1, planksAfter: 5 } }
  const { job, child } = permit('planks', 1000, { visitId: daily.id, visitSupply })
  child.externalId = CAMP_VISIT_SUPPLY_TASK_PREFIX + daily.id
  job.dedupeKey = `visit-supply:${daily.id}`
  job.task.externalId = `autonomy:minecraft.supply:${job.dedupeKey}`
  assert.deepEqual(verifiedCampReceipt(job, taskById), { childId: child.id, item: { kind: 'supply', at: at(1000) },
    visitSupply: { visitId: daily.id, receipt: visitSupply } })
  assert.deepEqual(state('minecraft').recentCamp, [{ kind: 'supply', at: at(1000) }])

  for (const invalid of [
    { ...visitSupply, count: 8 },
    { ...visitSupply, inventory: { ...visitSupply.inventory, logsAfter: 1 } },
    { ...visitSupply, inventory: { ...visitSupply.inventory, planksAfter: 4 } },
    { ...visitSupply, name: 'diamond' },
  ]) {
    job.payload.visitSupply = invalid
    assert.deepEqual(state('minecraft').recentCamp, [])
  }
  job.payload.visitSupply = visitSupply
  child.externalId = CAMP_VISIT_SUPPLY_TASK_PREFIX + randomUUID()
  assert.deepEqual(state('minecraft').recentCamp, [])
  child.externalId = CAMP_VISIT_SUPPLY_TASK_PREFIX + daily.id
  daily.externalId = 'autonomy:daily.choice:daily:2026-02-30'
  assert.deepEqual(state('minecraft').recentCamp, [])
  daily.externalId = 'autonomy:daily.choice:daily:2026-11-01'
  delete job.payload.visitSupply
  delete job.payload.visitId
  assert.deepEqual(state('minecraft').recentCamp, [], 'removing the evidence cannot turn a leased action into a legacy supply')
})

test('projected camp receipts reject bad parents, forged or mismatched child tasks, stale leases and invalid survey geometry', () => {
  for (const [label, change] of Object.entries({
    'cancelled parent': ({ job }) => { job.task.status = 'cancelled' },
    'generic parent': ({ job }) => { job.task.externalId = 'made-up-parent' },
    'mismatched parent': ({ job }) => { job.task.id = randomUUID() },
    'unbound child': ({ job }) => { delete job.payload.receiptTaskId },
    'wrong context': ({ child }) => { child.contextId = 'chat.mobile' },
    'wrong capability': ({ child }) => { child.capabilityId = 'minecraft.build' },
    'unconfirmed child': ({ child }) => { child.status = 'running' },
    'preexisting child': ({ child }) => { child.createdAt = at(400) },
    'late child': ({ child }) => { child.updatedAt = at(1101) },
    'expired permit at completion': ({ job }) => { job.payload.expiresAt = BASE + 999 },
    'invalid date': ({ child }) => { child.updatedAt = 'invalid-date' },
    'invalid trail': ({ job }) => { job.payload.surveyTrail = 'north-south' },
    'completed without checkpoints': ({ job }) => { job.payload.surveyCheckpoints = 1 },
    'recovered after final checkpoint': ({ job }) => { job.payload.surveyOutcome = 'recovered' },
    'mixed route payload': ({ job }) => { job.payload.direction = 'west'; job.payload.surveySteps = 4 },
    'private extra fields': ({ job }) => { job.payload.extra = 'owner-only' },
  })) {
    const { permit, state } = fixture()
    const attempt = permit('survey', 1000, { surveyTrail: 'east-south', surveyCheckpoints: 2, surveyOutcome: 'completed' })
    change(attempt)
    assert.deepEqual(state('idle').recentCamp, [], label)
  }
})

test('short-visit builds require the leased game task, zone and exact stock delta while the public diary stays minimal', () => {
  const { gameTask, permit, state, taskById } = fixture()
  const daily = gameTask('core.autonomy', 500)
  Object.assign(daily, { contextId: DAILY_AUTONOMY_CONTEXT, externalId: 'autonomy:daily.choice:daily:2026-11-01' })
  const zoneId = randomUUID()
  const visitBuild = { built: true, zoneId, material: 'oak_planks', placedFloor: 8, placedTable: 1,
    inventory: { floorBefore: 12, floorAfter: 4, tablesBefore: 2, tablesAfter: 1 } }
  const { job, child } = permit('camp', 1000, { campZoneId: zoneId, visitId: daily.id, visitBuild })
  child.externalId = CAMP_VISIT_BUILD_TASK_PREFIX + daily.id
  job.dedupeKey = `visit-build:${daily.id}`
  job.task.externalId = `autonomy:minecraft.supply:${job.dedupeKey}`
  const item = { kind: 'build', at: at(1000) }
  assert.deepEqual(verifiedCampReceipt(job, taskById), { childId: child.id, item, visitBuild: { visitId: daily.id, receipt: visitBuild } })
  assert.deepEqual(state('minecraft').recentCamp, [item])
  for (const invalid of [
    { ...visitBuild, zoneId: randomUUID() },
    { ...visitBuild, placedFloor: 7 },
    { ...visitBuild, inventory: { ...visitBuild.inventory, tablesAfter: 0 } },
  ]) {
    job.payload.visitBuild = invalid
    assert.deepEqual(state('minecraft').recentCamp, [])
  }
  job.payload.visitBuild = visitBuild
  child.externalId = CAMP_VISIT_BUILD_TASK_PREFIX + randomUUID()
  assert.deepEqual(state('minecraft').recentCamp, [])
  child.externalId = CAMP_VISIT_BUILD_TASK_PREFIX + daily.id
  job.payload.expiresAt = BASE + 1000
  assert.deepEqual(state('minecraft').recentCamp, [])
  job.payload.expiresAt = BASE + 2000
  delete job.payload.visitBuild
  delete job.payload.visitId
  assert.deepEqual(state('minecraft').recentCamp, [])
})

test('the persisted lookup filters other jobs and generic activity and survives reopening', t => {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/community-test-'))
  const dbPath = join(directory, 'community.sqlite')
  let store = new CompanionStore(dbPath)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const job = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, dedupeKey: randomUUID(),
    runAfter: Date.now(), payload: { goal: 'camp', campZoneId: randomUUID(), expiresAt: Date.now() + 60_000 } })
  const child = store.createTask({ capabilityId: 'minecraft.build', contextId: 'game.minecraft', title: 'owner-only-zone' })
  store.transitionTask(child.id, 'running')
  store.transitionTask(child.id, 'succeeded')
  store.recordActivity({ kind: 'task.succeeded', source: 'minecraft.build', contextId: 'game.minecraft', status: 'success', taskId: child.id, summary: 'untrusted activity' })
  assert.deepEqual(projectCommunity('idle', store).recentCamp, [])
  store.transitionTask(job.id, 'running')
  store.transitionTask(job.id, 'succeeded', undefined, () => {
    store.autonomy.update(job.id, { payload: { ...job.payload, receiptTaskId: child.id } })
  })
  for (let i = 0; i < 35; i++) {
    const other = store.autonomy.create({ kind: 'memory.review', contextId: 'memory.curator', dedupeKey: randomUUID(), runAfter: Date.now() })
    store.transitionTask(other.id, 'running')
    store.transitionTask(other.id, 'succeeded')
  }
  const expected = { version: 1, activeSite: null, recentCamp: [{ kind: 'build', at: store.taskById(child.id).updatedAt }] }
  assert.deepEqual(projectCommunity('offline', store), expected)
  store.close()
  store = new CompanionStore(dbPath)
  assert.deepEqual(projectCommunity('offline', store), expected)
})
