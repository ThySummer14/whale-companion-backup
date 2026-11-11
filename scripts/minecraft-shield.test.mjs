import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { registerMinecraftTools } from '../src/host/minecraft-tools.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'
import { MinecraftShieldReceipt, MinecraftShieldRequest } from '../src/protocol/minecraft-shield.ts'

const receipt = { raised: true, released: true, requestedTicks: 40, blockingTicks: 35 }

test('shield duration and receipt reject coercion, extra inputs and incomplete blocking', () => {
  assert.deepEqual(MinecraftShieldRequest.parse({}), { seconds: 2 })
  for (const seconds of [1, 2, 3, 4, 5]) assert.equal(MinecraftShieldRequest.parse({ seconds }).seconds, seconds)
  for (const input of [null, { seconds: 0 }, { seconds: 6 }, { seconds: 1.5 }, { seconds: '2' }, { seconds: null }, { target: 'other' }]) {
    assert.equal(MinecraftShieldRequest.safeParse(input).success, false)
  }
  assert.deepEqual(MinecraftShieldReceipt.parse(receipt), receipt)
  for (const input of [{ released: false }, { raised: false }, { blockingTicks: 33 }, { blockingTicks: 41 }, { requestedTicks: 39 }, { observation: {} }]) {
    assert.equal(MinecraftShieldReceipt.safeParse({ ...receipt, ...input }).success, false)
  }
})

async function worker(t) {
  const directory = await mkdtemp(resolve('.work/shield-worker-'))
  const name = 'COMPANION_MC_DATA_DIR'
  const previous = process.env[name]
  process.env[name] = directory
  const world = new CbiWorld()
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
  world.online = true
  world.features = { shield: true }
  t.after(async () => {
    world.online = false
    await world.close()
    await rm(directory, { recursive: true, force: true })
  })
  const frame = (token, result, sender = world.botName) =>
    `[17:00:00] [Server thread/INFO]: CBI feedback sender=${sender} target=${world.botName} message="[CBI] shield ${token} ${result}"\n`
  return { world, frame }
}

test('worker accepts only the server-thread result for this bot and nonce', async t => {
  const { world, frame } = await worker(t)
  const cbi = t.mock.method(world, 'cbi', async (command, sender, _settle, pattern, signal, dispatched) => {
    const [, verb, nonce, ticks] = command.split(' ')
    assert.equal(verb, 'hold')
    assert.match(nonce, /^[a-f0-9]{32}$/u)
    assert.equal(ticks, '40')
    assert.equal(sender, world.botName)
    const done = 'done requested=40 blocked=35 released=true'
    assert.equal(pattern.test(frame(nonce, done, 'spoof')), false)
    assert.equal(pattern.test(frame('0'.repeat(32), done)), false)
    assert.equal(pattern.test('[CBI] shield ' + nonce + ' ' + done), false)
    assert.equal(pattern.test(frame(nonce, done).replace('Server thread', 'Netty Server IO')), false)
    signal.throwIfAborted()
    dispatched()
    return frame(nonce, done)
  })
  assert.deepEqual(await world.holdShield({ seconds: 2 }, new AbortController().signal), receipt)
  assert.equal(cbi.mock.callCount(), 1)
  assert.equal(world.activityPresence().action, undefined)
  assert.ok(world.eventsAfter(0).some(event => event.kind === 'action.finished' && event.action === 'shield'))
})

test('old, offline, busy and paused workers never send a shield command', async t => {
  const { world } = await worker(t)
  const cbi = t.mock.method(world, 'cbi', async () => assert.fail('unexpected command'))
  const shield = () => world.holdShield({ seconds: 2 }, new AbortController().signal)
  world.features.shield = false
  await assert.rejects(shield(), /shield-unavailable/u)
  world.features.shield = true
  world.online = false
  await assert.rejects(shield(), /minecraft-offline/u)
  world.online = true
  world.action = { kind: 'follow', controller: new AbortController() }
  await assert.rejects(shield(), /action-busy/u)
  world.action = undefined
  world.campPaused = true
  assert.throws(() => world.withCampAction(shield), /minecraft-camp-paused/u)
  assert.equal(cbi.mock.callCount(), 0)
})

test('cancellation after dispatch releases only its own nonce', async t => {
  const { world, frame } = await worker(t)
  const controller = new AbortController()
  const nonces = []
  t.mock.method(world, 'cbi', async (command, _sender, _settle, pattern, signal, dispatch) => {
    const [, verb, nonce] = command.split(' ')
    nonces.push([verb, nonce])
    if (verb === 'hold') {
      dispatch()
      controller.abort()
      signal.throwIfAborted()
    }
    const ack = frame(nonce, 'cancel-ack')
    assert.ok(pattern.test(ack))
    return ack
  })
  await assert.rejects(world.holdShield({ seconds: 2 }, controller.signal), /shield-cancelled/u)
  assert.deepEqual(nonces, [['hold', nonces[0][1]], ['cancel', nonces[0][1]]])
  assert.equal(world.activityPresence().action, undefined)
})

test('failed native action remains a failure and fabricated completion cannot persist memory', async t => {
  const directory = await mkdtemp(resolve('.work/shield-host-'))
  const store = new CompanionStore(join(directory, 'companion.db'))
  const service = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'owner' })
  store.bindContext({ contextId: 'game.minecraft', kind: 'game', label: 'Isolated', sessionId: 'qa-game' })
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  let output = { ...receipt, blockingTicks: 0 }
  const calls = t.mock.method(service, 'request', async (path, method, input) => {
    assert.equal(path, '/shield')
    assert.equal(method, 'POST')
    assert.deepEqual(input, { seconds: 2 })
    if (output instanceof Error) throw output
    return output
  })
  assert.throws(() => service.holdShield({ seconds: 30 }))
  assert.equal(calls.mock.callCount(), 0)
  await assert.rejects(service.holdShield({}), { code: 'shield-unconfirmed' })
  output = new Error('shield-not-found')
  await assert.rejects(service.holdShield({}), /shield-not-found/u)
  output = { ...receipt, requestedTicks: 20, blockingTicks: 15 }
  await assert.rejects(service.holdShield({}), { code: 'shield-unconfirmed' })
  assert.equal(store.memory.find('盾牌', { contextId: 'chat.mobile', limit: 4 }).length, 0)
  output = receipt
  const value = await service.holdShield({})
  assert.equal(value.task.status, 'succeeded')
  assert.deepEqual(value.result, receipt)
  const memory = store.memory.find('盾牌', { contextId: 'chat.mobile', limit: 4 })[0]
  assert.equal(memory.scope, 'shared')
  assert.equal(memory.sourceRefs[0].taskId, value.task.id)
  assert.deepEqual(store.activities().find(item => item.kind === 'world.action')?.data, { shield: receipt })
  assert.equal(store.tasks().filter(task => task.status === 'failed').length, 3)
})

test('only the live bound Minecraft root can invoke the tool', async () => {
  const root = { id: 'root', session: { header: { origin: 'root' } } }
  const nested = { id: 'nested', session: { header: { origin: 'subagent' } } }
  const tools = new Map()
  const calls = []
  let binding = { contextId: 'game.minecraft', kind: 'game' }
  let active = root
  registerMinecraftTools({
    agents: { get: () => active, currentInitiator: () => root },
    tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
  }, {
    store: { bindingBySession: () => binding },
    minecraft: { holdShield: async input => { calls.push(input); return { task: { id: 'task' }, result: receipt } } },
  })
  const signal = new AbortController().signal
  const tool = tools.get('mc_shield')
  assert.deepEqual(JSON.parse(await tool.execute({ seconds: 2 }, { agent: root, signal })), { taskId: 'task', receipt })
  await assert.rejects(tool.execute({}, { signal }), /Minecraft root/u)
  active = nested
  await assert.rejects(tool.execute({}, { agent: nested, signal }), /Minecraft root/u)
  await assert.rejects(tool.execute({}, { agent: root, signal }), /Minecraft root/u)
  active = root
  binding = { ...binding, kind: 'chat' }
  await assert.rejects(tool.execute({}, { agent: root, signal }), /Minecraft root/u)
  binding = { contextId: 'chat.mobile', kind: 'chat' }
  await assert.rejects(tool.execute({}, { agent: root, signal }), /game.minecraft/u)
  assert.equal(calls.length, 1)
  assert.ok(companionToolPolicy('game.minecraft', 'game').allowed.some(entry => entry.name === 'mc_shield'))
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes('mc_shield'))
})
