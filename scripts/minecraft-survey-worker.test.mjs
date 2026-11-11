import assert from 'node:assert/strict'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'

const zone = { id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension: 'minecraft:overworld', x: -12, y: 70, z: 32, radius: 5 }
const input = { zone, direction: 'west' }
const route = { ...input, zone: { ...zone, radius: 8 }, steps: 7 }
const trail = { zone, trail: 'east-south' }
const center = { x: -11.5, y: 70, z: 32.5 }
const runSignal = () => new AbortController().signal
const line = (message, sender = 'dafeiyu', command = 'survey') => `[10:00:01] [Server thread/INFO]: CBI feedback sender=${sender} target=dafeiyu message=[CBI] ${command} ${message}\n`
const receipt = (id, phase, reached = false, returned = false, reason = '-') => line(`id=${id} phase=${phase} reached=${reached} returned=${returned} reason=${reason}`)
const routeReceipt = (id, phase, reached = false, returned = false, reason = '-', steps = 7) =>
  line(`id=${id} phase=${phase} reached=${reached} returned=${returned} reason=${reason} steps=${steps}`, 'dafeiyu', 'surveyroute')
const trailReceipt = (id, phase, checkpoints = 0, returned = false, reason = '-', trailId = trail.trail) =>
  line(`id=${id} phase=${phase} trail=${trailId} checkpoints=${checkpoints} returned=${returned} reason=${reason}`, 'dafeiyu', 'surveytrail')

function fixture(t, extended = false, trails = false) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    online: true, features: { campSurvey: true, campSurveyRoutes: extended, campSurveyTrails: trails }, botName: 'dafeiyu', avoidTargets: new Set(),
  })
  const events = []
  t.mock.method(world, 'record', (event, data) => events.push({ event, ...data }))
  t.mock.method(world, 'setReflex', () => assert.fail('Survey must preserve current reflex settings'))
  const position = t.mock.method(world, 'positionOf', async () => center)
  const data = t.mock.method(world, 'data', async (_bot, key) => {
    assert.equal(key, 'Dimension')
    return zone.dimension
  })
  return { world, events, position, data }
}

test('survey is advertised only when the CBI exposes both survey and survival', async t => {
  const { world } = fixture(t)
  let commands = 'goto, survey'
  let survival = false
  t.mock.method(world, 'survivalStatus', async () => survival ? 'threat=NONE' : undefined)
  t.mock.method(world, 'cbi', async command => command === 'help'
    ? `CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] 导航: ${commands}\n`
    : `[CBI] ${command.split(' ')[1]} =`)
  for (const [knownCommands, knownSurvival, expected, extended, trails] of [
    ['goto, survey, surveyroute', false, false, undefined],
    ['goto', true, false, undefined],
    ['goto, survey', true, true, undefined],
    ['goto, survey, surveyroutes', true, true, undefined],
    ['goto, surveyroute', true, false, undefined],
    ['goto, survey, surveyroute', true, true, true],
    ['goto, survey, surveytrail', true, true, undefined],
    ['goto, survey, surveyroute, surveytrails', true, true, true],
    ['goto, survey, surveyroute, surveytrail', false, false, undefined],
    ['goto, survey, surveyroute, surveytrail', true, true, true, true],
  ]) {
    world.features = undefined
    commands = knownCommands
    survival = knownSurvival
    await world.configure()
    assert.equal(world.view().capabilities.campSurvey, expected)
    assert.equal(world.view().capabilities.campSurveyRoutes, extended)
    assert.equal(world.view().capabilities.campSurveyTrails, trails)
  }
})

test('the gather visit protocol is visible offline but campgather requires the exact live CBI feature', async t => {
  const { world } = fixture(t)
  let commands = ''
  let survival = true
  t.mock.method(world, 'survivalStatus', async () => survival ? 'threat=NONE' : undefined)
  t.mock.method(world, 'cbi', async command => command === 'help'
    ? `CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] 导航: ${commands}\n`
    : `[CBI] ${command.split(' ')[1]} =`)
  world.features = undefined
  assert.equal(world.view().capabilities.campVisitGather, true)
  assert.equal(world.view().capabilities.campGather, false)
  for (const [known, liveSurvival, expected] of [
    ['survey, surveyroute', true, false], ['survey, campgathers', true, false],
    ['campgather', true, false], ['survey, campgather', false, false], ['survey, campgather', true, true],
  ]) {
    world.features = undefined
    commands = known
    survival = liveSurvival
    await world.configure()
    assert.equal(world.view().capabilities.campGather, expected)
  }
})

test('preview accepts only unique cardinal routes from the bot to itself and dispatches no walk', async t => {
  const { world } = fixture(t)
  let response = line('preview directions=north,west')
  const cbi = t.mock.method(world, 'cbi', async command => {
    assert.equal(command, 'survey preview minecraft:overworld -12 70 32 5')
    return response
  })
  assert.deepEqual(await world.surveyPreview({ zone }, runSignal()), { directions: ['north', 'west'] })
  response = line('preview directions=-')
  assert.deepEqual(await world.surveyPreview({ zone }, runSignal()), { directions: [] })
  for (const wrong of [line('preview directions=north,north'), line('preview directions=north,up'), line('preview directions=north', 'other'),
    '[10:00:01] [Server thread/INFO]: <other> CBI feedback sender=dafeiyu target=dafeiyu message=[CBI] survey preview directions=north\n']) {
    response = wrong
    await assert.rejects(world.surveyPreview({ zone }, runSignal()), /survey-preview-unconfirmed/u)
  }
  await assert.rejects(world.surveyPreview({ zone: { ...zone, radius: 4 } }, runSignal()))
  assert.equal(cbi.mock.callCount(), 6)
  assert.equal(world.action, undefined)
})

test('survey holds its action slot and returns a verified receipt after actual outbound and home acknowledgments', async t => {
  const { world, events, position, data } = fixture(t)
  let id
  let polls = 0
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, signal, onDispatch) => {
    assert.equal(world.activityPresence().action, 'survey')
    signal.throwIfAborted()
    onDispatch()
    if (command.startsWith('survey run ')) {
      id = command.split(' ')[2]
      assert.match(id, /^[0-9a-f]{24}$/u)
      assert.equal(command, `survey run ${id} minecraft:overworld -12 70 32 5 west`)
      await assert.rejects(world.survey(input, runSignal()), /action-busy/u)
      await assert.rejects(world.surveyPreview({ zone }, runSignal()), /action-busy/u)
      return receipt(id, 'outbound')
    }
    assert.equal(command, `survey status ${id}`)
    return ++polls === 1 ? receipt(id, 'returning', true) : receipt(id, 'succeeded', true, true)
  })
  assert.deepEqual(await world.survey(input, runSignal()), { surveyed: true, zoneId: zone.id, direction: 'west', steps: 4, reached: true, returned: true })
  assert.equal(cbi.mock.callCount(), 3)
  assert.equal(position.mock.callCount(), 1)
  assert.equal(data.mock.callCount(), 1)
  assert.equal(world.action, undefined)
  assert.equal(events.at(-1).event, 'action.finished')
  assert.equal(events.at(-1).kind, 'survey')
  assert.equal(events.at(-1).returned, true)
})

test('success requires an exact nonce and valid complete receipt and otherwise sends only scoped cancel', async t => {
  const { world, position } = fixture(t)
  let id
  const calls = []
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    calls.push(command)
    onDispatch?.()
    if (command.startsWith('survey run ')) {
      id = command.split(' ')[2]
      return receipt(id, 'outbound')
    }
    if (command === `survey status ${id}`) return receipt(`${id}0`, 'succeeded', true, true)
    assert.equal(command, `survey cancel ${id}`)
    return receipt(id, 'cancelled', false, false, 'survey-cancelled')
  })
  await assert.rejects(world.survey(input, runSignal()), /survey-receipt-unconfirmed/u)
  assert.deepEqual(calls, [`survey run ${id} minecraft:overworld -12 70 32 5 west`, `survey status ${id}`, `survey cancel ${id}`])
  assert.equal(position.mock.callCount(), 0)
  assert.equal(world.action, undefined)
})

test('a genuine success token still fails if an independent world read returns the wrong dimension', async t => {
  const { world, events, data } = fixture(t)
  data.mock.mockImplementation(async () => 'minecraft:the_nether')
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    const id = command.split(' ')[2]
    onDispatch()
    if (command.startsWith('survey run ')) return receipt(id, 'outbound')
    assert.equal(command, `survey status ${id}`)
    return receipt(id, 'succeeded', true, true)
  })
  await assert.rejects(world.survey(input, runSignal()), /survey-return-unconfirmed/u)
  assert.equal(events.at(-1).error, 'survey-return-unconfirmed')
  assert.equal(world.action, undefined)
})

test('abort after possible dispatch waits for one scoped stop and clears the action without a return claim', async t => {
  const { world, position } = fixture(t)
  const controller = new AbortController()
  const calls = []
  let id
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, signal, onDispatch) => {
    calls.push(command)
    if (command.startsWith('survey run ')) {
      id = command.split(' ')[2]
      onDispatch()
      controller.abort()
      signal.throwIfAborted()
    }
    assert.equal(command, `survey cancel ${id}`)
    assert.equal(world.action.kind, 'survey')
    return receipt(id, 'cancelled', false, false, 'survey-cancelled')
  })
  await assert.rejects(world.survey(input, controller.signal), /survey-cancelled/u)
  assert.equal(position.mock.callCount(), 0)
  assert.deepEqual(calls, [`survey run ${id} minecraft:overworld -12 70 32 5 west`, `survey cancel ${id}`])
  assert.equal(world.action, undefined)
})

test('extended preview binds cardinal routes and checked lengths to the authorized radius', async t => {
  const { world, position } = fixture(t, true)
  const preview = (entries, sender) => line(`preview routes=${entries}`, sender, 'surveyroute')
  let response = preview('north:7,east:4')
  const cbi = t.mock.method(world, 'cbi', async command => {
    assert.match(command, /^surveyroute preview minecraft:overworld -12 70 32 [58]$/u)
    return response
  })
  assert.deepEqual(await world.surveyPreview({ zone: route.zone }, runSignal()), {
    directions: ['north', 'east'], routes: [{ direction: 'north', steps: 7 }, { direction: 'east', steps: 4 }],
  })
  await assert.rejects(world.surveyPreview({ zone }, runSignal()), /survey-preview-unconfirmed/u)
  response = preview('-')
  assert.deepEqual(await world.surveyPreview({ zone }, runSignal()), { directions: [], routes: [] })
  for (const wrong of [preview('north:7,north:4'), preview('north:8'), preview('up:4'), preview('north:4', 'other'), line('preview directions=north')]) {
    response = wrong
    await assert.rejects(world.surveyPreview({ zone: route.zone }, runSignal()), /survey-preview-unconfirmed/u)
  }
  assert.equal(cbi.mock.callCount(), 8)
  assert.equal(position.mock.callCount(), 0)
  assert.equal(world.action, undefined)
})

test('length-bearing requests never dispatch on a legacy server or outside the permit radius', async t => {
  const { world } = fixture(t)
  const cbi = t.mock.method(world, 'cbi', () => assert.fail('invalid extension must not dispatch'))
  await assert.rejects(world.survey(route, runSignal()), /survey-unavailable/u)
  world.features.campSurveyRoutes = true
  for (const steps of [5, 7, 8, 3, 4.5]) await assert.rejects(world.survey({ ...input, steps }, runSignal()))
  assert.equal(cbi.mock.callCount(), 0)
})

test('extended route binds the full receipt to the requested length and rechecks the camp center', async t => {
  const { world, position, data, events } = fixture(t, true)
  let id
  const calls = []
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    calls.push(command)
    onDispatch()
    if (command.startsWith('surveyroute run ')) {
      id = command.split(' ')[2]
      return routeReceipt(id, 'outbound')
    }
    return routeReceipt(id, 'succeeded', true, true)
  })
  assert.deepEqual(await world.survey(route, runSignal()), {
    surveyed: true, zoneId: zone.id, direction: 'west', steps: 7, reached: true, returned: true,
  })
  assert.deepEqual(calls, [`surveyroute run ${id} minecraft:overworld -12 70 32 8 west 7`, `surveyroute status ${id}`])
  assert.equal(position.mock.callCount(), 1)
  assert.equal(data.mock.callCount(), 1)
  assert.equal(events.at(-1).surveyed, true)
})

test('verified terrain retreat returns home without claiming the planned endpoint', async t => {
  const { world, position, events } = fixture(t, true)
  let polls = 0
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    onDispatch()
    const id = command.split(' ')[2]
    if (command.startsWith('surveyroute run ')) return routeReceipt(id, 'outbound')
    assert.equal(command, `surveyroute status ${id}`)
    return ++polls === 1
      ? routeReceipt(id, 'returning', false, false, 'survey-terrain-changed')
      : routeReceipt(id, 'recovered', false, true, 'survey-terrain-changed')
  })
  const result = await world.survey(route, runSignal())
  assert.deepEqual(result, { surveyed: false, zoneId: zone.id, direction: 'west', steps: 7, reached: false, returned: true, reason: 'survey-terrain-changed' })
  assert.equal(position.mock.callCount(), 1)
  assert.equal(events.at(-1).surveyed, false)
  assert.equal(world.action, undefined)
})

test('extended recovery from a corner of the camp block does not count as a centered return', async t => {
  const { world, position, events } = fixture(t, true)
  position.mock.mockImplementation(async () => ({ ...center, x: center.x + 0.4 }))
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    onDispatch()
    const id = command.split(' ')[2]
    return command.startsWith('surveyroute run ')
      ? routeReceipt(id, 'outbound')
      : routeReceipt(id, 'recovered', false, true, 'survey-terrain-changed')
  })
  await assert.rejects(world.survey(route, runSignal()), /survey-return-unconfirmed/u)
  assert.equal(events.at(-1).event, 'action.failed')
  assert.equal(events.at(-1).error, 'survey-return-unconfirmed')
})

test('contradictory route progress and wrong lengths fail closed and issue only scoped cancel', async t => {
  const { world, position } = fixture(t, true)
  const invalid = [
    id => routeReceipt(id, 'succeeded', true, true, '-', 6),
    id => routeReceipt(id, 'recovered', true, true, 'survey-terrain-changed'),
    id => routeReceipt(id, 'returning', false, false, 'survey-unsafe-player'),
  ]
  let stopCount = 0
  const cbi = t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, _signal, onDispatch) => {
    onDispatch?.()
    const id = command.split(' ')[2]
    if (command.startsWith('surveyroute run ')) return routeReceipt(id, 'outbound')
    if (command === `surveyroute status ${id}`) return invalid[stopCount](id)
    assert.equal(command, `surveyroute cancel ${id}`)
    stopCount++
    return routeReceipt(id, 'cancelled', false, false, 'survey-cancelled')
  })
  for (const _ of invalid) await assert.rejects(world.survey(route, runSignal()), /survey-receipt-unconfirmed/u)
  assert.equal(stopCount, 3)
  assert.equal(cbi.mock.callCount(), 9)
  assert.equal(position.mock.callCount(), 0)
})

test('abort after extended route dispatch sends one matching cancel and suppresses a late recovery', async t => {
  const { world, position, events } = fixture(t, true)
  const controller = new AbortController()
  let id
  const calls = []
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, signal, onDispatch) => {
    calls.push(command)
    if (command.startsWith('surveyroute run ')) {
      id = command.split(' ')[2]
      onDispatch()
      controller.abort()
      signal.throwIfAborted()
    }
    assert.equal(command, `surveyroute cancel ${id}`)
    return routeReceipt(id, 'recovered', false, true, 'survey-terrain-changed')
  })
  await assert.rejects(world.survey(route, controller.signal), /survey-cancelled/u)
  assert.deepEqual(calls, [`surveyroute run ${id} minecraft:overworld -12 70 32 8 west 7`, `surveyroute cancel ${id}`])
  assert.equal(position.mock.callCount(), 0)
  assert.equal(events.at(-1).error, 'survey-cancelled')
  assert.equal(world.action, undefined)
})

test('trail preview offers at most the eight perpendicular pairs and retains straight options', async t => {
  const { world } = fixture(t, true, true)
  const pairs = ['north-east', 'north-west', 'east-north', 'east-south', 'south-east', 'south-west', 'west-north', 'west-south']
  let trails = line(`preview trails=${pairs.join(',')}`, 'dafeiyu', 'surveytrail')
  const calls = []
  t.mock.method(world, 'cbi', async command => {
    calls.push(command)
    return command.startsWith('surveyroute') ? line('preview routes=east:4', 'dafeiyu', 'surveyroute') : trails
  })
  const straight = { directions: ['east'], routes: [{ direction: 'east', steps: 4 }] }
  assert.deepEqual(await world.surveyPreview({ zone }, runSignal()), { ...straight, trails: pairs })
  assert.deepEqual(calls, ['surveyroute preview minecraft:overworld -12 70 32 5', 'surveytrail preview minecraft:overworld -12 70 32 5'])
  trails = line('preview trails=-', 'dafeiyu', 'surveytrail')
  assert.deepEqual(await world.surveyPreview({ zone }, runSignal()), { ...straight, trails: [] })
  for (const wrong of [
    line('preview trails=north-east,north-east', 'dafeiyu', 'surveytrail'),
    line('preview trails=north-south', 'dafeiyu', 'surveytrail'),
    line('preview trails=east-south', 'other', 'surveytrail'),
    line(`preview trails=${[...pairs, 'east-south'].join(',')}`, 'dafeiyu', 'surveytrail'),
  ]) {
    trails = wrong
    await assert.rejects(world.surveyPreview({ zone }, runSignal()), /survey-preview-unconfirmed/u)
  }
  assert.equal(world.action, undefined)
})

test('trail requests reject unsupported capability, parallel legs, undersized zones and mixed straight fields before dispatch', async t => {
  const { world } = fixture(t, true)
  const cbi = t.mock.method(world, 'cbi', () => assert.fail('invalid trail must not dispatch'))
  await assert.rejects(world.survey(trail, runSignal()), /survey-unavailable/u)
  world.features.campSurveyTrails = true
  for (const invalid of [
    { ...trail, trail: 'south-north' },
    { ...trail, zone: { ...zone, radius: 4 } },
    { ...trail, direction: 'east' },
    { ...trail, steps: 4 },
  ]) await assert.rejects(world.survey(invalid, runSignal()))
  assert.equal(cbi.mock.callCount(), 0)
})

function mockTrailWire(t, world, progression) {
  let id
  const calls = []
  t.mock.method(world, 'cbi', async (command, _sender, _settle, _match, signal, onDispatch) => {
    calls.push(command)
    onDispatch?.()
    if (command.startsWith('surveytrail run ')) {
      id = command.split(' ')[2]
      assert.match(id, /^[a-f0-9]{24}$/u)
      assert.equal(command, `surveytrail run ${id} minecraft:overworld -12 70 32 5 east-south`)
      assert.equal(world.activityPresence().action, 'survey')
      return trailReceipt(id, 'outbound')
    }
    if (command === `surveytrail cancel ${id}`) return trailReceipt(id, 'cancelled', 0, false, 'survey-cancelled')
    assert.equal(command, `surveytrail status ${id}`)
    assert.ok(progression.length, 'Unexpected status poll')
    const next = progression.shift()
    return typeof next === 'function' ? next(id, signal) : trailReceipt(id, ...next)
  })
  return calls
}

test('trail completes both outbound stops and only reports success after independent home reads', async t => {
  const { world, position, data, events } = fixture(t, true, true)
  const calls = mockTrailWire(t, world, [['outbound', 1], ['returning', 2], ['succeeded', 2, true]])
  const result = { trail: trail.trail, zoneId: zone.id, checkpoints: 2, returned: true, outcome: 'completed' }
  assert.deepEqual(await world.survey(trail, runSignal()), result)
  assert.equal(calls.length, 4)
  assert.equal(position.mock.callCount(), 1)
  assert.equal(data.mock.callCount(), 1)
  assert.deepEqual(events.at(-1), { event: 'action.finished', kind: 'survey', ...result })
  assert.equal(world.action, undefined)
})

test('trail returns after a terrain change with only the checkpoints actually confirmed', async t => {
  const reason = 'survey-terrain-changed'
  for (const checkpoints of [0, 1]) await t.test(`${checkpoints} checkpoints`, async t => {
    const { world, position } = fixture(t, true, true)
    mockTrailWire(t, world, [['returning', checkpoints, false, reason], ['recovered', checkpoints, true, reason]])
    assert.deepEqual(await world.survey(trail, runSignal()), {
      trail: trail.trail, zoneId: zone.id, checkpoints, returned: true, outcome: 'recovered', reason,
    })
    assert.equal(position.mock.callCount(), 1)
  })
})

test('trail rejects another route, a disappearing checkpoint, a backward phase or a contradictory success', async t => {
  for (const [label, progression] of [
    ['wrong trail', [id => trailReceipt(id, 'succeeded', 2, true, '-', 'east-north')]],
    ['wrong command ID', [id => trailReceipt(`${id}0`, 'succeeded', 2, true)]],
    ['checkpoint regression', [['outbound', 1], ['returning', 0, false, 'survey-terrain-changed']]],
    ['checkpoint added during return', [['returning', 0, false, 'survey-terrain-changed'], ['recovered', 1, true, 'survey-terrain-changed']]],
    ['backward phase', [['returning', 1, false, 'survey-terrain-changed'], ['outbound', 1]]],
    ['only one checkpoint before alleged success', [['succeeded', 1, true]]],
  ]) await t.test(label, async t => {
    const { world, position } = fixture(t, true, true)
    const calls = mockTrailWire(t, world, progression)
    await assert.rejects(world.survey(trail, runSignal()), /survey-receipt-unconfirmed/u)
    const id = calls[0].split(' ')[2]
    assert.deepEqual(calls.filter(command => command.includes(' cancel ')), [`surveytrail cancel ${id}`])
    assert.equal(position.mock.callCount(), 0)
    assert.equal(world.action, undefined)
  })
})

test('an obstructed trail return and a false center both fail without a return event', async t => {
  for (const [progress, error] of [
    [['failed', 1, false, 'survey-terrain-changed'], /survey-terrain-changed/u],
    [['succeeded', 2, true], /survey-return-unconfirmed/u],
  ]) await t.test(error.source, async t => {
    const { world, position, events } = fixture(t, true, true)
    position.mock.mockImplementation(async () => ({ ...center, z: center.z - 0.4 }))
    mockTrailWire(t, world, [progress])
    await assert.rejects(world.survey(trail, runSignal()), error)
    assert.ok(events.every(item => item.event !== 'action.finished'))
  })
})

test('trail abort scopes cancellation and rejects a recovery arriving after authority ended', async t => {
  const { world, position, events } = fixture(t, true, true)
  const controller = new AbortController()
  const calls = mockTrailWire(t, world, [id => {
    controller.abort()
    return trailReceipt(id, 'recovered', 1, true, 'survey-terrain-changed')
  }])
  await assert.rejects(world.survey(trail, controller.signal), /survey-cancelled/u)
  const id = calls[0].split(' ')[2]
  assert.deepEqual(calls, [`surveytrail run ${id} minecraft:overworld -12 70 32 5 east-south`, `surveytrail status ${id}`, `surveytrail cancel ${id}`])
  assert.equal(position.mock.callCount(), 0)
  assert.equal(events.at(-1).error, 'survey-cancelled')
  assert.equal(world.action, undefined)
})
