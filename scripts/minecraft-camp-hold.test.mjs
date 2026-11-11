import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-camp-hold-')
  const store = new CompanionStore(join(directory, 'companion.sqlite'))
  const callbacks = []
  const options = { dataDir: directory, serverRoot: directory, owner: 'camp-owner' }
  const service = new MinecraftService(store, {}, options, undefined, undefined,
    (zoneId, explicit) => callbacks.push({ zoneId, explicit }), () => callbacks.push('pause'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  service.ready = true
  return { directory, store, service, callbacks, options }
}

test('camp projection reads only the authenticated bounded CBI status and discards private data', async t => {
  const { service } = fixture(t)
  let worker = { online: true, auth: { mode: 'cbi' }, action: 'follow',
    lastError: 'secret', server: { host: 'private' }, observation: { username: 'secret', position: { x: 1 } } }
  t.mock.method(service, 'request', async (path, method, body, signal) => {
    assert.deepEqual([path, method, body], ['', 'GET', undefined])
    assert.ok(signal instanceof AbortSignal)
    return worker
  })
  const view = await service.campView()
  assert.ok(Number.isFinite(Date.parse(view.observedAt)))
  assert.deepEqual(view, { version: 1, connection: 'online', action: 'follow', observedAt: view.observedAt,
    control: { pairedPauseEnabled: false } })
  worker = { ...worker, action: 'private' }
  assert.equal((await service.campView()).action, undefined)
  worker = { ...worker, connecting: true }
  assert.equal((await service.campView()).connection, 'unavailable')
  worker = { online: false, auth: { mode: 'cbi' }, action: 'follow' }
  assert.equal((await service.campView()).connection, 'offline')
  worker = { online: true, auth: { mode: 'different' } }
  assert.equal((await service.campView()).connection, 'unavailable')
})

test('paired pause persists before dispatch, shares concurrent stops and rechecks local authorization', async t => {
  const { service, store, callbacks } = fixture(t)
  const gate = Promise.withResolvers()
  let stops = 0
  t.mock.method(service, 'request', async path => {
    if (path === '') return { online: true, auth: { mode: 'cbi' } }
    assert.equal(path, '/camp/pause')
    assert.deepEqual(callbacks, ['pause', { zoneId: undefined, explicit: true }])
    assert.equal(store.minecraftCampControl().stopStatus, 'pending')
    stops++
    return gate.promise
  })
  await assert.rejects(service.pauseCamp(), { code: 'minecraft-camp-pause-disabled' })
  service.setPairedCampPause(true)
  const task = store.createTask({ capabilityId: 'minecraft.move', contextId: 'game.minecraft', title: 'Pending move' })
  store.transitionTask(task.id, 'running')
  const first = service.pauseCamp()
  const second = service.pauseCamp()
  assert.equal(store.minecraftCampControl().stopStatus, 'pending')
  assert.equal(service.campControl().stopStatus, 'pending')
  await assert.rejects(service.resumeCamp(), { code: 'minecraft-camp-pause-busy' })
  await setImmediate()
  assert.equal(stops, 1)
  assert.equal(service.setPairedCampPause(false).pausedAt, store.minecraftCampControl().pausedAt)
  await assert.rejects(service.pauseCamp(), { code: 'minecraft-camp-pause-disabled' })
  gate.resolve({ stopped: true, displacement: 0, observation: { username: 'private', position: { x: 23 } } })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(a.control.stopStatus, 'confirmed')
  assert.equal(a.control.pairedPauseEnabled, false)
  assert.equal(store.taskById(task.id).status, 'cancelled')
  assert.equal(store.activities().filter(item => item.kind === 'camp.paused').length, 1)
  assert.equal(store.activities().find(item => item.kind === 'camp.stop-receipt').data.outcome, 'confirmed')
  assert.ok(!JSON.stringify(a).includes('private'))
})

test('a durable hold blocks mutations across service restart and clears only on local resume receipt', async t => {
  const { service, store, directory, options } = fixture(t)
  t.mock.method(service, 'request', async path => {
    if (path === '/camp/pause') return { stopped: true, displacement: 0.31 }
    assert.equal(path, '')
    return { online: true, auth: { mode: 'cbi' } }
  })
  service.setPairedCampPause(true)
  const paused = await service.pauseCamp()
  assert.equal(paused.control.stopStatus, 'unconfirmed')
  const stopped = store.tasks().find(task => task.capabilityId === 'minecraft.stop')
  assert.equal(stopped.status, 'failed')
  const restartedStore = new CompanionStore(join(directory, 'companion.sqlite'))
  t.after(() => restartedStore.close())
  const restarted = new MinecraftService(restartedStore, {}, options)
  restarted.ready = true
  assert.deepEqual(restarted.campControl(), paused.control)
  let validResume = false
  const calls = []
  t.mock.method(restarted, 'request', async path => {
    calls.push(path)
    if (path === '/camp/resume') return { resumed: validResume }
    if (path === '/observe') return { online: true }
    if (path === '/move') return { moved: true }
    throw new Error('unexpected worker request')
  })
  await assert.rejects(restarted.connect(), { code: 'minecraft-camp-paused' })
  await assert.rejects(restarted.follow(), { code: 'minecraft-camp-paused' })
  await assert.rejects(restarted.move({ x: 1, y: 2, z: 3 }), { code: 'minecraft-camp-paused' })
  await assert.rejects(restarted.prepareCamp('camp'), { code: 'minecraft-camp-paused' })
  await assert.rejects(restarted.eventPrompt({}), { code: 'minecraft-camp-paused' })
  assert.throws(() => restarted.ask('test'), { code: 'minecraft-camp-paused' })
  assert.equal((await restarted.observe()).online, true)
  assert.deepEqual(calls, ['/observe'])
  await assert.rejects(restarted.resumeCamp(), { code: 'minecraft-camp-resume-unconfirmed' })
  assert.deepEqual(restarted.campControl(), paused.control)
  validResume = true
  assert.deepEqual(await restarted.resumeCamp(), { pairedPauseEnabled: true })
  assert.equal((await restarted.move({ x: 1, y: 2, z: 3 })).task.status, 'succeeded')
})

test('an interrupted pending hold is shown as unconfirmed and can be rechecked while offline', async t => {
  const { store, service } = fixture(t)
  const pausedAt = new Date().toISOString()
  store.saveMinecraftCampControl({ pausedAt, pairedPauseEnabled: true, stopStatus: 'pending' })
  assert.deepEqual(service.campControl(), { pausedAt, pairedPauseEnabled: true, stopStatus: 'unconfirmed' })
  t.mock.method(service, 'request', async path => {
    if (path === '/camp/pause') return { stopped: true, online: false }
    assert.equal(path, '')
    return { online: false, auth: { mode: 'cbi' } }
  })
  const verified = await service.pauseCamp()
  assert.equal(verified.control.pausedAt, pausedAt)
  assert.equal(verified.control.stopStatus, 'offline')
  assert.equal(verified.connection, 'offline')
})

test('management still exposes a durable hold after the Worker connection fails', async t => {
  const { store, service } = fixture(t)
  const pausedAt = new Date().toISOString()
  store.saveMinecraftCampControl({ pausedAt, pairedPauseEnabled: false, stopStatus: 'unconfirmed' })
  t.mock.method(service, 'request', async () => { throw new Error('worker-unavailable') })
  const view = await service.view()
  assert.equal(view.workerOnline, false)
  assert.equal(view.online, false)
  assert.equal(view.observation, undefined)
  assert.equal(view.lastError, 'worker-unavailable')
  assert.equal(view.campControl.pausedAt, pausedAt)
})

test('a mutation started before pause cannot continue after local resume', async t => {
  const { store, service } = fixture(t)
  const lesson = Promise.withResolvers()
  t.mock.method(service, 'syncLessons', () => lesson.promise)
  const dispatched = []
  t.mock.method(service, 'request', async path => {
    dispatched.push(path)
    if (path === '/camp/pause') return { stopped: true, displacement: 0 }
    if (path === '/camp/resume') return { resumed: true }
    assert.equal(path, '')
    return { online: true, auth: { mode: 'cbi' } }
  })
  service.setPairedCampPause(true)
  const inFlight = assert.rejects(service.dig('oak_log'), { code: 'minecraft-camp-paused' })
  await service.pauseCamp()
  await service.resumeCamp()
  lesson.resolve()
  await inFlight
  assert.deepEqual(dispatched, ['/camp/pause', '', '/camp/resume'])
  assert.equal(store.tasks().find(task => task.capabilityId === 'minecraft.dig').status, 'cancelled')
})
