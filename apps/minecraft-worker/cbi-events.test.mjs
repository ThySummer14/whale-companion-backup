import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from './cbi-world.ts'

test('CBI routes one private owner message and keeps public text separate from presence', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.cbi-events-'))
  const environment = {
    COMPANION_MC_SERVER_ROOT: root,
    COMPANION_MC_DATA_DIR: join(root, 'worker'),
    COMPANION_MC_OWNER: 'Qa_Owner',
    COMPANION_MC_BOT_NAME: 'qa_fish',
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const world = new CbiWorld()
  try {
    await mkdir(join(root, 'logs'))
    await appendFile(join(root, 'logs', 'latest.log'), [
      '[08:00:00] [Server thread/INFO]: [Not Secure] <qa_owner> qa_fish joined the game',
      '[08:00:00] [Server thread/INFO]: [Not Secure] <qa_other> qa_owner left the game',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_owner target=qa_fish route=llm message=owner private',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_other target=qa_fish route=llm message=other private',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_owner target=qa_fish route=cbi message=cbi help',
      '[08:00:00] [Server thread/INFO]: Qa_Owner joined the game',
      '[08:00:00] [Server thread/INFO]: <qa_fish> 任务失败：无法到达目标方块: -4 69 -8',
      '',
    ].join('\n'))
    const dig = { kind: 'dig', digTarget: { x: -4, y: 67, z: -8 }, controller: new AbortController() }
    world.action = dig
    await world.pump()
    assert.equal(dig.unreachable, undefined)
    await appendFile(join(root, 'logs', 'latest.log'), [
      '[08:00:01] [Server thread/INFO]: <qa_fish> 任务失败：无法到达目标方块: -4 67 -8',
      '[08:00:01] [Server thread/INFO]: qa_fish drowned',
      '[08:00:01] [Server thread/INFO]: qa_fish lost connection: qa_fish died',
      '[08:00:01] [Server thread/INFO]: qa_fish left the game',
      '',
    ].join('\n'))
    await world.pump()
    await world.pump()
    assert.equal(dig.unreachable, true)
    const events = world.eventsAfter(0)
    assert.equal(world.view().online, false)
    assert.deepEqual(events.map(event => [event.kind, event.message, event.delivery]), [
      ['chat.received', 'qa_fish joined the game', undefined],
      ['chat.received', 'qa_owner left the game', undefined],
      ['chat.received', 'owner private', 'private'],
      ['owner.online', undefined, undefined],
      ['world.alert', '[08:00:00] [Server thread/INFO]: <qa_fish> 任务失败：无法到达目标方块: -4 69 -8', undefined],
      ['world.alert', '[08:00:01] [Server thread/INFO]: <qa_fish> 任务失败：无法到达目标方块: -4 67 -8', undefined],
      ['player.death', 'qa_fish drowned', undefined],
    ])
  } finally {
    await world.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('CBI log offsets remain byte-based when Chinese text precedes live events', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.cbi-log-offset-'))
  const environment = {
    COMPANION_MC_SERVER_ROOT: root,
    COMPANION_MC_DATA_DIR: join(root, 'worker'),
    COMPANION_MC_OWNER: 'Qa_Owner',
    COMPANION_MC_BOT_NAME: 'qa_fish',
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const log = join(root, 'logs', 'latest.log')
  await mkdir(join(root, 'logs'), { recursive: true })
  const initial = '[08:00:00] [Server thread/INFO]: [Not Secure] <Qa_Owner> 茶肆就位，灯笼已点亮\n'
  const live = '[08:00:01] [Server thread/INFO]: Qa_Owner joined the game\n'
  await appendFile(log, initial)
  const world = new CbiWorld()
  try {
    const chunk = await world.readLog(Buffer.byteLength(initial))
    assert.equal(chunk.text, '')
    await appendFile(log, live)
    const appended = await world.readLog(Buffer.byteLength(initial))
    assert.equal(appended.text, live)
    assert.equal(appended.offset, Buffer.byteLength(initial + live))
    await world.pump()
    await world.pump()
    assert.deepEqual(world.eventsAfter(0).map(event => event.kind), ['owner.online'])
  } finally {
    await world.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('movement yields on falling air or a major detour before reporting arrival', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.cbi-movement-'))
  const previous = process.env.COMPANION_MC_DATA_DIR
  process.env.COMPANION_MC_DATA_DIR = root
  const world = new CbiWorld()
  try {
    const origin = { x: 0, y: 64, z: 0 }
    const target = { x: 4, y: 64, z: 0 }
    const action = { kind: 'move', controller: new AbortController() }
    world.observe = async () => ({ position: target, oxygen: 270 })
    await assert.rejects(world.waitForArrival(target, action, origin), /move-air-falling/)
    world.observe = async () => ({ position: { x: -13, y: 64, z: 0 }, oxygen: 300 })
    await assert.rejects(world.waitForArrival(target, action, origin), /move-route-diverged/)
    world.observe = async () => ({ position: target, oxygen: 300 })
    assert.equal((await world.waitForArrival(target, action, origin)).position, target)
  } finally {
    await world.close()
    if (previous === undefined) delete process.env.COMPANION_MC_DATA_DIR
    else process.env.COMPANION_MC_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('move reports a refused or exhausted route without treating it as owner cancellation', async t => {
  const origin = { x: 1, y: 64, z: 1 }
  const target = { x: 4, y: 64, z: 1 }
  for (const scenario of [
    { reason: 'move-target-blocked', start: '[CBI] 落脚点不可用 [move-target-blocked] 4 64 1', stops: 0 },
    { reason: 'move-target-unsupported', start: '[CBI] 落脚点不可用 [move-target-unsupported] 4 64 1', stops: 0 },
    { reason: 'move-ended-without-arrival', start: '[CBI] 正在计算到 4 64 1 的路径', stops: 1 },
    { reason: 'move-cancelled', start: '[CBI] 正在计算到 4 64 1 的路径', cancel: true, stops: 0 },
  ]) await t.test(scenario.reason, async t => {
    const root = await mkdtemp(join(import.meta.dirname, '.cbi-movement-'))
    const previous = process.env.COMPANION_MC_DATA_DIR
    process.env.COMPANION_MC_DATA_DIR = root
    const world = new CbiWorld()
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 100_000 })
      const commands = []
      world.online = true
      world.features = { survival: false }
      world.positionOf = async () => origin
      world.block = async () => false
      world.setReflex = async () => {}
      world.observe = async () => {
        t.mock.timers.setTime(102_000)
        return { position: origin, cbiStatus: '当前没有执行中的 cbi 任务' }
      }
      world.cbi = async command => {
        commands.push(command)
        if (command === 'stop') return '[CBI] 已停止当前 cbi 任务'
        if (scenario.cancel) world.action.controller.abort()
        return scenario.start
      }
      world.stop = async () => assert.fail('a move must never cancel its own action')
      await assert.rejects(world.move(target), { message: scenario.reason })
      assert.deepEqual(commands, ['goto 4 64 1', ...Array(scenario.stops).fill('stop')])
      assert.equal(world.action, undefined)
      assert.ok(world.eventsAfter(0).some(event => event.kind === 'action.failed' && event.error === scenario.reason))
    } finally {
      await world.close()
      if (previous === undefined) delete process.env.COMPANION_MC_DATA_DIR
      else process.env.COMPANION_MC_DATA_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('nearby bed automation preserves day follow and ends it only after a verified sleep', async t => {
  const root = await mkdtemp(join(import.meta.dirname, '.cbi-night-bed-'))
  const previous = process.env.COMPANION_MC_DATA_DIR
  process.env.COMPANION_MC_DATA_DIR = root
  const world = new CbiWorld()
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 })
    world.online = true
    world.features = { nightShelter: true, bedInteraction: true }
    const follow = { kind: 'follow', controller: new AbortController() }
    world.action = follow
    let output = 'nightbed spawn-set 4 64 -1'
    const commands = []
    world.nightCommand = async (command, _terminal, signal, guard) => {
      signal.throwIfAborted()
      guard?.()
      commands.push(command)
      return output
    }
    world.checkNearbyBed()
    await world.bedCheck
    assert.equal(world.action, follow)
    assert.equal(follow.controller.signal.aborted, false)
    assert.deepEqual(world.eventsAfter(0).map(({ kind, sleeping, spawnSet }) => ({ kind, sleeping, spawnSet })),
      [{ kind: 'night.bed', sleeping: false, spawnSet: true }])

    world.checkNearbyBed()
    assert.equal(commands.length, 1)
    t.mock.timers.setTime(110_000)
    world.campPaused = true
    world.checkNearbyBed()
    assert.equal(commands.length, 1)
    world.campPaused = false
    output = 'nightbed sleeping 4 64 -1 reminded'
    world.checkNearbyBed()
    await world.bedCheck
    assert.ok(commands.every(command => command === `nightbed auto ${world.owner}`))
    assert.equal(commands.length, 2)
    assert.equal(world.action, undefined)
    assert.equal(follow.controller.signal.aborted, true)
    assert.deepEqual(world.eventsAfter(0).slice(-2).map(({ kind, reason, sleeping, ownerReminded }) => ({ kind, reason, sleeping, ownerReminded })), [
      { kind: 'follow.ended', reason: 'bed', sleeping: undefined, ownerReminded: undefined },
      { kind: 'night.bed', reason: undefined, sleeping: true, ownerReminded: true },
    ])
  } finally {
    world.online = false
    await world.close()
    if (previous === undefined) delete process.env.COMPANION_MC_DATA_DIR
    else process.env.COMPANION_MC_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
