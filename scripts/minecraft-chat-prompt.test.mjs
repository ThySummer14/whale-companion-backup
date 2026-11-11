import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MINECRAFT_OWNER_MESSAGES, minecraftOwnerEventKey, minecraftOwnerEvents, minecraftOwnerMessageText } from '../src/core/minecraft-chat.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { registerMinecraftChatPrompt } from '../src/host/minecraft-chat-prompt.ts'
import { registerMinecraftTools } from '../src/host/minecraft-tools.ts'

const game = 'game.minecraft'
const generation = 'a4a96375-c431-41a5-aa23-71bc1fae68dd'
const nextGeneration = '6a4c28d6-4c9a-4f87-aaa8-ab3f1c52990b'
const owner = (seq, sourceId) => ({ seq, username: 'ownerqa', message: `游戏消息-${seq}`, ...(sourceId && { sourceId }) })

function fixture(t, onEvent) {
  const dir = mkdtempSync(resolve('.work/minecraft-chat-'))
  const store = new CompanionStore(join(dir, 'companion.db'))
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'ownerqa' }, onEvent)
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, service }
}

test('game messages keep only bounded owner lines without any implicit worker or archive read', async t => {
  const { service } = fixture(t)
  t.mock.method(service, 'observe', () => assert.fail('implicit observation'))
  t.mock.method(service, 'wardrobe', () => assert.fail('implicit wardrobe lookup'))
  const input = '带有换行\n双引号 " 和括号 [] 的私人消息'
  const source = { ...owner(8, generation), message: input }
  const result = await service.eventPrompt({ payload: { events: [...Array.from({ length: 7 }, (_, i) => owner(i)), source] } })
  assert.ok(result.startsWith(MINECRAFT_OWNER_MESSAGES))
  const messages = JSON.parse(result.slice(MINECRAFT_OWNER_MESSAGES.length))
  assert.equal(messages.length, 6)
  assert.equal(messages.at(-1), input)
  assert.doesNotMatch(result, /ownerqa|a4a96375|当前观察|背包|授权|衣柜/u)
  assert.equal(minecraftOwnerMessageText(result), messages.join('\n'))
  assert.equal(minecraftOwnerMessageText('legacy input'), 'legacy input')
  const malformed = MINECRAFT_OWNER_MESSAGES + 'broken'
  assert.equal(minecraftOwnerMessageText(malformed), malformed)
  await assert.rejects(service.eventPrompt({ payload: { events: [{}] } }), { code: 'minecraft-event-messages-invalid' })
})

test('game policy is a stable system section scoped to the live root in the Minecraft scene', async t => {
  let section
  let live
  let binding
  const stop = registerMinecraftChatPrompt({
    agents: { get: () => live },
    systemPrompt: { section(value) { section = value; return () => { section = undefined } } },
  }, { bindingBySession: () => binding })
  const agent = { id: 'game-fixture', session: { header: {} } }
  live = agent
  binding = { contextId: game, kind: 'game' }
  const rules = section.text({ agent })
  assert.match(rules, /mc_chat/u)
  assert.match(rules, /mc_observe/u)
  assert.match(rules, /实际回读/u)
  assert.equal(section.text({ agent }), rules)
  for (const [name, mutate] of [
    ['no agent', () => undefined],
    ['stale agent', () => ({ ...agent })],
    ['unbound', () => { binding = undefined; return agent }],
    ['ordinary chat', () => { binding = { contextId: 'chat.mobile', kind: 'chat' }; return agent }],
    ['wrong game context', () => { binding = { contextId: 'game.other', kind: 'game' }; return agent }],
    ['wrong scene kind', () => { binding = { contextId: game, kind: 'chat' }; return agent }],
    ['delegated', () => { agent.session.header.delegationDepth = 1; return agent }],
    ['subagent', () => { agent.session.header.origin = 'subagent'; return agent }],
  ]) await t.test(name, () => {
    binding = { contextId: game, kind: 'game' }
    agent.session.header = {}
    assert.equal(section.text({ agent: mutate() }), '')
  })
  stop()
  assert.equal(section, undefined)
})

test('old inbox events keep their identity and sequence restarts are scoped to the source', async t => {
  assert.equal(minecraftOwnerEventKey(owner(12)), '12')
  assert.notEqual(minecraftOwnerEventKey(owner(12, generation)), minecraftOwnerEventKey(owner(12, nextGeneration)))
  for (const bad of [undefined, null, {}, [{ ...owner(1), sourceId: 'bad' }], [{ ...owner(1), seq: 1.2 }], [{ ...owner(1), username: '' }],
    [{ ...owner(1), message: '' }], [{ ...owner(1), message: '甲'.repeat(1025) }]]) {
    await t.test(String(bad), () => assert.deepEqual(minecraftOwnerEvents(bad), []))
  }
})

test('a full running batch hands off new owner messages after the buffer rotates', async t => {
  const { service, store } = fixture(t)
  store.bindContext({ contextId: game, sessionId: 'game', label: 'Game', kind: 'game' })
  const scheduler = new AutonomyService(store, {}, undefined, service)
  try {
    const original = scheduler.enqueueMinecraft(owner(1, generation))
    for (let seq = 2; seq <= 6; seq++) scheduler.enqueueMinecraft(owner(seq, generation))
    const delivered = store.autonomy.get(original.id)
    store.transitionTask(original.id, 'running')
    scheduler.enqueueMinecraft(owner(1, nextGeneration))
    scheduler.enqueueMinecraft(owner(7, nextGeneration))
    scheduler.enqueueMinecraft(owner(7, nextGeneration))
    assert.deepEqual(store.autonomy.get(original.id).payload.events.map(event => event.seq), [3, 4, 5, 6, 1, 7])
    assert.deepEqual(service.finishEvent(delivered).remaining, [owner(1, nextGeneration), owner(7, nextGeneration)])
    store.transitionTask(original.id, 'cancelled')
    assert.equal(scheduler.enqueueMinecraft(owner(1, generation)), undefined)
    assert.notEqual(scheduler.enqueueMinecraft(owner(1, nextGeneration)).id, original.id)
  } finally { await scheduler.close() }
})

test('mc_status reads only the selected bounded section while management and observe stay distinct', async t => {
  const { service, store } = fixture(t)
  const controller = new AbortController()
  const signal = controller.signal
  const tools = new Map()
  const agent = { id: 'game' }
  store.bindContext({ contextId: game, sessionId: agent.id, label: 'Game', kind: 'game' })
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition); return () => {} } } }
  registerMinecraftTools(ctx, { store, minecraft: service })
  const execute = (name, input = {}, authority = { agent, signal }) => tools.get(name).execute(input, authority).then(JSON.parse)
  const requests = t.mock.method(service, 'request', async () => ({
    online: true, connecting: false, action: 'follow', observation: { private: true }, profile: { uuid: 'private' }, lastError: 'private',
  }))
  assert.deepEqual(await execute('mc_status'), { workerOnline: false, online: false, connecting: false, campPaused: false })
  assert.equal(requests.mock.callCount(), 0)
  service.ready = true
  assert.deepEqual(await execute('mc_status'), { workerOnline: true, online: true, connecting: false, campPaused: false, action: 'follow' })
  assert.deepEqual(requests.mock.calls[0].arguments, ['', 'GET', undefined, signal])
  for (let x = 0; x < 10; x++) store.createBuildZone({ name: `Zone ${x}`, dimension: 'minecraft:overworld', x, y: 64, z: 0, radius: 4 })
  const zones = await execute('mc_status', { section: 'build_zones' })
  assert.equal(zones.buildZones.length, 8)
  assert.equal(zones.nextOffset, 8)
  assert.deepEqual(Object.keys(zones.buildZones[0]), ['id', 'name', 'dimension', 'x', 'y', 'z', 'radius'])
  const rest = await execute('mc_status', { section: 'build_zones', offset: 8 })
  assert.equal(rest.buildZones.length, 2)
  assert.ok(rest.buildZones.every(zone => !zones.buildZones.some(previous => previous.id === zone.id)))
  assert.equal(rest.nextOffset, undefined)
  for (const offset of [-1, 0.1, Infinity, 1e18]) {
    await assert.rejects(execute('mc_status', { section: 'build_zones', offset }),
      { code: Number.isFinite(offset) ? 'minecraft-zone-offset-invalid' : 'INVALID_ARGS' })
  }
  assert.deepEqual(await execute('mc_status', { section: 'lessons' }), { lessons: [] })
  const wardrobe = t.mock.method(service, 'wardrobe', async () => ({ available: true, options: [{ id: 'blue', label: '蓝色' }] }))
  assert.deepEqual(await execute('mc_status', { section: 'wardrobe' }), { wardrobe: { available: true, options: [{ id: 'blue', label: '蓝色' }] } })
  assert.deepEqual(wardrobe.mock.calls[0].arguments, [signal])
  assert.equal(requests.mock.callCount(), 1)
  t.mock.method(service, 'observe', async () => ({ inventory: [{ name: 'oak_log', count: 2 }] }))
  assert.deepEqual(await execute('mc_observe'), { inventory: [{ name: 'oak_log', count: 2 }] })
  await assert.rejects(execute('mc_status', {}, { agent: { id: 'outside' }, signal }), /game.minecraft/u)
  controller.abort()
  await assert.rejects(execute('mc_status'), { name: 'AbortError' })
})


test('a late poll from the previous worker cannot advance the new cursor or submit a world message', async t => {
  const messages = []
  const { service } = fixture(t, message => messages.push(message))
  const oldPoll = Promise.withResolvers()
  const response = { items: [{ seq: 2, kind: 'chat.received', username: 'ownerqa', message: '过期或新来的输入', delivery: 'private' }],
    presence: { online: true } }
  const read = t.mock.method(service, 'request', () => oldPoll.promise)
  service.ready = true
  service.child = {}
  service.cursor = 36
  const first = service.refreshEvents()
  try {
    assert.equal(read.mock.calls[0].arguments[0], '/events?after=36')
    service.child = {}
    service.workerEventSource = nextGeneration
    service.cursor = 0
    oldPoll.resolve(response)
    await first
    assert.equal(service.cursor, 0)
    assert.deepEqual(messages, [])
    read.mock.mockImplementation(async () => response)
    await service.refreshEvents()
    assert.equal(read.mock.calls[1].arguments[0], '/events?after=0')
    assert.equal(service.cursor, 2)
    assert.deepEqual(messages, [{ seq: 2, sourceId: nextGeneration, username: 'ownerqa', message: '过期或新来的输入' }])
  } finally { service.child = undefined }
})

test('model chat persists a confirmed delivery and omits raw observation and recipients', async t => {
  const { service, store } = fixture(t)
  const signal = new AbortController().signal
  const request = t.mock.method(service, 'request', async () => ({
    delivery: 'private', recipient: 'ownerqa', observation: { inventory: ['private state'] },
  }))
  const output = await service.modelChat('隔离确认消息', signal)
  assert.deepEqual(output, { taskId: output.taskId, status: 'succeeded', delivery: 'private' })
  assert.equal(store.taskById(output.taskId).status, 'succeeded')
  assert.deepEqual(request.mock.calls[0].arguments.slice(0, 4), ['/chat', 'POST', { text: '隔离确认消息', receiptOnly: true }, signal])
  assert.equal((await service.chat('管理端仍可读取')).result.recipient, 'ownerqa')
  assert.equal(request.mock.calls[1].arguments[2].receiptOnly, undefined)
  request.mock.mockImplementation(async () => ({ observation: {} }))
  await assert.rejects(service.modelChat('没有送达证据', signal), { code: 'minecraft-chat-receipt-unconfirmed' })
  assert.equal(store.tasks().filter(task => task.capabilityId === 'minecraft.chat' && task.status === 'failed').length, 1)
})
