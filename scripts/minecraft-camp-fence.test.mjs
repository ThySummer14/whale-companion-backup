import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

test('a pre-pause worker operation cannot dispatch a console command after resume', async t => {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, campEpoch: 0, campPaused: false, commandQueue: Promise.resolve(),
  })
  const pause = Promise.withResolvers()
  const stops = t.mock.method(world, 'stop', async () => pause.promise)
  const preflight = Promise.withResolvers()
  const stale = assert.rejects(world.withCampAction(async () => {
    await preflight.promise
    return world.send('untrusted old action', /never runs/u)
  }), /minecraft-camp-paused/u)
  const first = world.pauseCamp()
  assert.equal(world.pauseCamp(), first)
  assert.throws(() => world.withCampAction(() => assert.fail()), /minecraft-camp-paused/u)
  assert.throws(() => world.resumeCamp(), /minecraft-camp-pause-busy/u)
  pause.resolve({ stopped: true, displacement: 0 })
  assert.deepEqual(await first, { stopped: true, displacement: 0 })
  assert.equal(stops.mock.callCount(), 1)
  assert.deepEqual(world.resumeCamp(), { resumed: true })
  preflight.resolve()
  await stale
  assert.equal(world.withCampAction(() => 'fresh admission'), 'fresh admission')
})

test('worker pause checks actual player presence before trusting an offline flag', async t => {
  const world = Object.assign(Object.create(CbiWorld.prototype), { online: false, campEpoch: 0, botName: 'dafeiyu' })
  const probe = t.mock.method(world, 'positionOf', async () => ({ x: 10, y: 62, z: 10 }))
  const stop = t.mock.method(world, 'stop', async () => {
    assert.equal(world.online, true)
    assert.equal(world.reflexEnabled, false)
    return { stopped: true, displacement: 0 }
  })
  assert.deepEqual(await world.pauseCamp(), { stopped: true, displacement: 0 })
  assert.deepEqual(probe.mock.calls[0].arguments, ['dafeiyu'])
  assert.equal(stop.mock.callCount(), 1)
})

test('a game event being prepared at pause cannot start after the owner resumes', async t => {
  const dir = mkdtempSync(resolve('.work/camp-event-test-'))
  const store = new CompanionStore(join(dir, 'companion.db'))
  const binding = store.bindContext({ contextId: 'game.minecraft', sessionId: 'game', kind: 'game', label: '隔离世界' })
  let held = false
  const preparing = Promise.withResolvers()
  const allowPrompt = Promise.withResolvers()
  const sent = []
  const service = new AutonomyService(store, {
    create: async () => ({ binding }), send: async (...args) => { sent.push(args) }, cancel: async () => {},
  }, undefined, {
    campPaused: () => held,
    async eventPrompt() { preparing.resolve(); return allowPrompt.promise },
    finishEvent: () => ({ acted: false, reason: 'fixture' }),
  })
  t.after(async () => {
    allowPrompt.resolve('finished')
    await service.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const job = service.enqueueMinecraft({ seq: 1, username: 'owner', message: 'follow' })
  assert.ok(job)
  await setImmediate()
  store.autonomy.update(job.id, { runAfter: Date.now() - 10 })
  service.wake()
  await Promise.race([preparing.promise, delay(1000, undefined, { ref: false }).then(() => assert.fail('game prompt not prepared'))])
  held = true
  service.cancelMinecraftEventForCampPause()
  assert.equal(store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(service.enqueueMinecraft({ seq: 2, username: 'owner', message: 'follow again' }), undefined)
  held = false
  allowPrompt.resolve('expired instructions')
  await setImmediate()
  assert.deepEqual(sent, [])
  assert.ok(service.enqueueMinecraft({ seq: 3, username: 'owner', message: 'new request' }))
})

test('only the dispatched Minecraft message and its actual turn can settle the world event', async t => {
  const dir = mkdtempSync(resolve('.work/camp-world-event-'))
  const store = new CompanionStore(join(dir, 'companion.db'))
  const binding = store.bindContext({ contextId: 'game.minecraft', sessionId: 'game', kind: 'game', label: '隔离世界' })
  const received = Promise.withResolvers()
  const finishes = []
  const service = new AutonomyService(store, {
    create: async () => ({ binding }), async send(contextId, _prompt, source) {
      assert.equal(source, 'world')
      received.resolve()
      return { accepted: true, sessionId: binding.sessionId, contextId, messageId: 'actual-game-input' }
    }, cancel: async () => {},
  }, undefined, { async eventPrompt() { return 'verified game event' }, finishEvent(job) {
    finishes.push(job.id)
    return { acted: false, reason: '已回复，无需世界动作' }
  } })
  service.updateSettings({ memoryReview: false })
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const job = service.enqueueMinecraft({ seq: 1, username: 'owner', message: '怎么看今天的进度？' })
  await setImmediate()
  store.autonomy.update(job.id, { runAfter: Date.now() - 10 })
  service.wake()
  await received.promise
  await setImmediate()
  function turn(index, source, id) {
    service.observe(binding, { type: 'turn/start', data: { turn: index }, seq: index * 3 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id, source }, seq: index * 3 + 1 })
    service.observe(binding, { type: 'turn/end', data: { turn: index, reason: { kind: 'completed' } }, seq: index * 3 + 2 })
  }
  turn(1, { kind: 'user' }, 'manual-game-chat')
  assert.equal(store.autonomy.get(job.id).task.status, 'running')
  assert.deepEqual(finishes, [])
  turn(2, { kind: 'companion-world', form: 'minecraft-event' }, 'actual-game-input')
  await setImmediate()
  assert.deepEqual(finishes, [job.id])
  assert.equal(store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(store.autonomy.get(job.id).task.error, '已回复，无需世界动作')
})

test('world event accounting ignores actions outside its current time and game context', t => {
  const dir = mkdtempSync(resolve('.work/camp-world-event-time-'))
  const store = new CompanionStore(join(dir, 'companion.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'owner' })
  const start = Date.parse('2026-11-10T00:00:00.000Z')
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const job = store.autonomy.create({ kind: 'minecraft.event', contextId: 'game.minecraft', dedupeKey: 'time-check', runAfter: start, payload: { startedAt: start } })
  function complete(contextId) {
    const task = store.createTask({ capabilityId: 'minecraft.build', contextId, title: '测试回执' })
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
  }
  t.mock.timers.setTime(start + 3_000)
  complete('game.minecraft')
  t.mock.timers.setTime(start + 1_000)
  complete('chat.mobile')
  assert.equal(service.finishEvent(job).acted, false)
  complete('game.minecraft')
  assert.equal(service.finishEvent(job).acted, true)
})

test('a receipt-only game chat skips the observation after verified private delivery', async t => {
  const world = Object.assign(Object.create(CbiWorld.prototype), { online: true, botName: 'dafeiyu', owner: 'ownerqa' })
  t.mock.method(world, 'positionOf', async () => ({ x: 0, y: 80, z: 0 }))
  const send = t.mock.method(world, 'send', async () =>
    '[14:00:00] [Server thread/INFO]: CBI feedback sender=dafeiyu target=ownerqa message=[CBI] 大肥鱼：确认收到')
  t.mock.method(world, 'record', () => {})
  const observe = t.mock.method(world, 'observe', async () => ({ inventory: [] }))
  const compact = await world.chat('确认收到', true)
  assert.equal(compact.delivery, 'private')
  assert.equal(compact.observation, undefined)
  assert.equal(observe.mock.callCount(), 0)
  assert.deepEqual((await world.chat('确认收到')).observation, { inventory: [] })
  assert.equal(observe.mock.callCount(), 1)
  assert.equal(send.mock.callCount(), 2)
  send.mock.mockImplementation(async () => 'No player was found')
  await assert.rejects(world.chat('无回执时拒绝', true), /owner-not-visible/u)
  assert.equal(observe.mock.callCount(), 1)
})
