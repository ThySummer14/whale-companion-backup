import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { projectHome } from '../src/core/home.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

test('scheduled surveys require fresh idle CBI presence and clear it on missing data or explicit stop', async t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/scheduled-minecraft-presence-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const stopped = []
  const service = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'owner' },
    undefined, undefined, (zoneId, explicit) => stopped.push({ zoneId, explicit }))
  let presence = { online: true, campSurveyReady: true }
  let fail = false
  t.mock.method(service, 'request', async path => {
    if (path === '/stop') return {}
    assert.match(path, /^\/events\?after=/u)
    if (fail) throw new Error('worker unavailable')
    return { items: [], presence }
  })
  const now = 1_790_000_000_000
  t.mock.method(Date, 'now', () => now)
  service.ready = true
  assert.equal(service.surveyWindowReady(now), false)
  await service.refreshEvents()
  assert.equal(service.surveyWindowReady(now), true)
  assert.equal(service.surveyWindowReady(now + 4_999), true)
  assert.equal(service.surveyWindowReady(now + 5_000), false)
  assert.equal(service.surveyWindowReady(now - 1), false)
  const active = store.createTask({ capabilityId: 'minecraft.move', title: '活动' })
  store.transitionTask(active.id, 'running')
  assert.equal(service.surveyWindowReady(now), false)
  store.transitionTask(active.id, 'succeeded')
  for (const blocked of [{ online: true }, { online: true, campSurveyReady: true, action: 'follow' }, { online: false, campSurveyReady: true }]) {
    presence = blocked
    await service.refreshEvents()
    assert.equal(service.surveyWindowReady(now), false)
  }
  presence = { online: true, campSurveyReady: true }
  await service.refreshEvents()
  fail = true
  await service.refreshEvents()
  assert.equal(service.surveyWindowReady(now), false)
  fail = false
  await service.refreshEvents()
  await service.stop()
  assert.equal(service.surveyWindowReady(now), false)
  assert.deepEqual(stopped, [{ zoneId: undefined, explicit: true }])
})

function fixture(t, radius = 5) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-survey-host-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const bounds = { dimension: 'minecraft:overworld', x: 10, y: 64, z: -12, radius }
  const permit = store.createBuildZone({ name: '测试营地', ...bounds })
  const zone = { id: permit.id, ...bounds }
  const service = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'owner' })
  const controller = new AbortController()
  const state = { capable: true, directions: ['east', 'west'], routes: undefined, trails: undefined, result: undefined, calls: [], dispatched: [] }
  t.mock.method(service, 'request', async (path, method, body, signal) => {
    state.calls.push(path)
    assert.equal(signal, controller.signal)
    if (path === '') return { online: true, auth: { mode: 'cbi' }, capabilities: { campSurvey: state.capable } }
    assert.equal(method, 'POST')
    assert.deepEqual(body.zone, zone)
    if (path === '/survey-preview') return { directions: state.directions, ...(state.routes && { routes: state.routes }), ...(state.trails && { trails: state.trails }) }
    assert.equal(path, '/survey')
    state.dispatched.push(body)
    if (body.trail) {
      assert.equal(body.direction, undefined)
      assert.equal(body.steps, undefined)
      const receipt = { zoneId: zone.id, trail: body.trail, checkpoints: 2, returned: true, outcome: 'completed' }
      return state.result?.(receipt) ?? receipt
    }
    assert.equal(body.direction, 'east')
    const receipt = { surveyed: true, zoneId: zone.id, direction: body.direction, steps: body.steps ?? 4, reached: true, returned: true }
    return state.result?.(receipt) ?? receipt
  })
  const tasks = () => store.tasks().filter(task => task.capabilityId === 'minecraft.survey')
  return { zone, state, controller, store, tasks, inspect: () => service.inspectCampSurvey(zone.id, controller.signal),
    run: steps => service.surveyCamp(zone.id, 'east', controller.signal, steps),
    trail: trail => service.surveyTrail(zone.id, trail, controller.signal) }
}

test('host checks a fresh candidate, confirms the round trip, and projects the return to existing phone clients', async t => {
  const h = fixture(t)
  assert.deepEqual(await h.inspect(), { directions: ['east', 'west'] })
  const { task } = await h.run()
  assert.deepEqual(h.state.calls, ['', '/survey-preview', '', '/survey-preview', '/survey'])
  assert.equal(task.status, 'succeeded')
  assert.equal(task.contextId, 'game.minecraft')
  assert.equal(h.store.memory.list().length, 0)
  const home = projectHome({ now: new Date(), presence: 'idle', minecraft: false, speaking: false, quiet: false,
    bindings: [], runningSessions: new Set(), activities: h.store.activities() })
  assert.deepEqual(home.recent.map(item => item.kind), ['return'])
})

test('older worker, undersized zone, duplicate directions or changed route cannot dispatch a survey', async t => {
  const h = fixture(t)
  h.state.capable = false
  assert.equal(await h.inspect(), undefined)
  assert.deepEqual(h.state.calls, [''])
  h.state.capable = true
  h.state.directions = ['east', 'east']
  assert.equal(await h.inspect(), undefined)
  h.state.directions = ['west']
  await assert.rejects(h.run(), /survey-preconditions-changed/u)
  assert.ok(!h.state.calls.includes('/survey'))
  assert.deepEqual(h.tasks(), [])

  const small = fixture(t, 4)
  assert.equal(await small.inspect(), undefined)
  assert.deepEqual(small.state.calls, [''])
})

test('mismatched direction or missing return is terminal failure and never shows as home history', async t => {
  const h = fixture(t)
  for (const mismatch of [{ direction: 'west' }, { returned: false }]) {
    h.state.result = result => ({ ...result, ...mismatch })
    await assert.rejects(h.run(), /survey-receipt-unconfirmed/u)
  }
  assert.deepEqual(h.tasks().map(task => task.status), ['failed', 'failed'])
  assert.ok(!h.store.activities().some(item => item.source === 'minecraft.survey' && item.kind === 'task.succeeded'))
})

test('a receipt arriving after stop, abort or zone revocation cannot commit success', async t => {
  for (const end of ['abort', 'revoke', 'stop']) {
    const h = fixture(t)
    h.state.result = result => {
      if (end === 'abort') h.controller.abort(new Error('survey-test-cancel'))
      if (end === 'revoke') h.store.revokeBuildZone(h.zone.id)
      if (end === 'stop') h.store.transitionTask(h.tasks()[0].id, 'cancelled', 'test-stop')
      return result
    }
    await assert.rejects(h.run(), /survey-(test-cancel|cancelled)/u)
    assert.deepEqual(h.tasks().map(task => task.status), ['cancelled'])
  }
})

test('extended route keeps the selected distance across rechecks and rejects shortened, invalid or downgraded offers', async t => {
  const h = fixture(t, 8)
  h.state.routes = [{ direction: 'east', steps: 7 }, { direction: 'west', steps: 4 }]
  assert.deepEqual((await h.inspect()).routes, h.state.routes)
  h.state.routes[0].steps = 6
  await assert.rejects(h.run(7), /survey-preconditions-changed/u)
  h.state.routes = [{ direction: 'east', steps: 6 }, { direction: 'east', steps: 5 }]
  assert.equal(await h.inspect(), undefined)
  h.state.routes = undefined
  await assert.rejects(h.run(6), /survey-preconditions-changed/u)
  assert.deepEqual(h.tasks(), [])
  assert.deepEqual(h.state.dispatched, [])
  h.state.routes = [{ direction: 'east', steps: 7 }, { direction: 'west', steps: 5 }]
  const { task, result } = await h.run(6)
  assert.equal(task.status, 'succeeded')
  assert.equal(result.steps, 6)
  assert.equal(h.state.dispatched[0].steps, 6)
  const smaller = fixture(t, 6)
  smaller.state.routes = h.state.routes
  assert.equal(await smaller.inspect(), undefined)
})

test('host distinguishes a confirmed early return and rejects mismatched lengths or legacy recovery', async t => {
  const h = fixture(t, 8)
  h.state.routes = [{ direction: 'east', steps: 7 }, { direction: 'west', steps: 4 }]
  h.state.result = result => ({ ...result, steps: 6 })
  await assert.rejects(h.run(7), /survey-receipt-unconfirmed/u)
  h.state.result = result => ({ ...result, surveyed: false, reached: false, reason: 'survey-terrain-changed' })
  await assert.rejects(h.run(), /survey-receipt-unconfirmed/u)
  const { task, result } = await h.run(7)
  assert.equal(task.status, 'succeeded')
  assert.deepEqual([result.surveyed, result.returned, result.steps], [false, true, 7])
  assert.ok(h.store.activities().some(item => item.taskId === task.id && item.status === 'warning' && /提前返回/u.test(item.summary)))
})

test('a trail must still be offered at dispatch and must not silently degrade to a straight route', async t => {
  const h = fixture(t)
  h.state.trails = ['east-south']
  assert.deepEqual((await h.inspect()).trails, ['east-south'])
  h.state.trails = ['east-north']
  await assert.rejects(h.trail('east-south'), /survey-preconditions-changed/u)
  h.state.trails = ['east-south', 'east-south']
  assert.equal(await h.inspect(), undefined)
  h.state.trails = ['east-west']
  assert.equal(await h.inspect(), undefined)
  h.state.trails = undefined
  await assert.rejects(h.trail('east-south'), /survey-preconditions-changed/u)
  assert.deepEqual(h.tasks(), [])
  assert.deepEqual(h.state.dispatched, [])
  h.state.trails = ['east-south']
  const { task, result } = await h.trail('east-south')
  assert.equal(task.status, 'succeeded')
  assert.deepEqual(h.state.dispatched, [{ zone: h.zone, trail: 'east-south' }])
  assert.deepEqual(result, { zoneId: h.zone.id, trail: 'east-south', checkpoints: 2, returned: true, outcome: 'completed' })
})

test('trail return requires matching geometry, checkpoint outcome and live authorization', async t => {
  for (const [label, change] of [
    ['wrong trail', { trail: 'east-north' }],
    ['unfinished checkpoints', { checkpoints: 1 }],
    ['unconfirmed return', { returned: false }],
    ['contradictory recovery', { outcome: 'recovered', reason: 'survey-terrain-changed' }],
    ['zone revoked', { outcome: 'recovered', checkpoints: 1, reason: 'survey-terrain-changed' }],
  ]) {
    const h = fixture(t)
    h.state.trails = ['east-south']
    h.state.result = result => {
      if (label === 'zone revoked') h.store.revokeBuildZone(h.zone.id)
      return { ...result, ...change }
    }
    await assert.rejects(h.trail('east-south'), /survey-(receipt-unconfirmed|cancelled)/u)
    assert.notEqual(h.tasks()[0].status, 'succeeded', label)
    assert.equal(h.store.memory.list().length, 0, label)
  }
})
