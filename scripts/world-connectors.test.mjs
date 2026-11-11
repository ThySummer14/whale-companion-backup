import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorldConnectors, WorldConnectors } from '../src/host/world-connectors.ts'
import { WORLD_DEFINITIONS } from '../src/host/world-manifest.ts'
import { companionToolPolicy, restrictCompanionTools } from '../src/host/tool-policy.ts'

const definitions = Object.values(WORLD_DEFINITIONS)
const scope = ({ contextId, kind }) => ({ contextId, kind })
const connector = (definition, hooks) => ({
  definition,
  health: () => 'ready',
  registerTools: () => () => {},
  ...hooks,
})
const policies = [
  ...definitions.map(scope),
  { contextId: 'game.another', kind: 'game' },
  { contextId: 'game.minecraft', kind: 'chat' },
  { contextId: 'world.bilibili', kind: 'task' },
  { contextId: 'world.singing', kind: 'game' },
  { contextId: 'chat.mobile', kind: 'chat' },
  { contextId: 'autonomy.bilibili', kind: 'system' },
]

for (const { contextId, kind } of policies) {
  for (const definition of definitions) {
    test(`${contextId} (${kind}) exposes only the matching ${definition.id} actions`, () => {
      const registry = new WorldConnectors(definitions.map(world => connector(world)), () => {})
      registry.start()
      const policy = companionToolPolicy(contextId, kind)
      const expected = contextId === definition.contextId && kind === definition.kind
      for (const [name, summary, permission] of definition.actions) {
        assert.equal(policy.denied.includes(name), !expected)
        assert.equal(registry.denied(name, { contextId, kind }) === undefined, expected)
        if (expected) assert.deepEqual(policy.allowed.find(entry => entry.name === name), { name, summary, permission })
      }
    })
  }
}

test('scoped world tool policy retains the existing Bilibili memory and singing tool bounds', () => {
  for (const definition of [WORLD_DEFINITIONS.bilibili, WORLD_DEFINITIONS.singing]) {
    const calls = []
    const ctx = { tools: { get: () => true, restrict: input => calls.push(input) }, effect: fn => fn() }
    restrictCompanionTools(ctx, definition.contextId, definition.kind)
    const expected = companionToolPolicy(definition.contextId, definition.kind).allowed.map(({ name }) => name)
    assert.deepEqual(calls, [{ allow: expected }])
    assert.equal(expected.includes('companion_memory_search'), definition.memory)
  }
})

test('Minecraft wardrobe remains conditional and core tools are outside the connector guard', () => {
  assert.ok(companionToolPolicy('game.minecraft', 'game', false).denied.includes('mc_change_appearance'))
  const registry = new WorldConnectors([connector(WORLD_DEFINITIONS.minecraft)], () => {})
  assert.equal(registry.denied('companion_memory_search'), undefined)
  assert.equal(registry.denied('companion_bilibili_read'), undefined)
  assert.match(registry.denied('mc_status'), /requires/)
  assert.match(registry.denied('mc_status', scope(WORLD_DEFINITIONS.minecraft)), /unavailable/)
})

test('registered identities, contexts and tool names are unique', () => {
  const mc = WORLD_DEFINITIONS.minecraft
  const bili = WORLD_DEFINITIONS.bilibili
  for (const duplicate of [mc, { ...bili, id: mc.id }, { ...bili, contextId: mc.contextId },
    { ...bili, actions: [mc.actions[0]] }]) {
    assert.throws(() => new WorldConnectors([connector(mc), connector(duplicate)], () => {}), /Duplicate World/)
  }
})

for (const configured of [false, true]) {
  test(`actual World registrars match the manifest with optional actions ${configured ? 'on' : 'off'}`, async () => {
    const tools = new Set()
    const hooks = new Set()
    const ctx = {
      on: () => {
        const id = Symbol()
        hooks.add(id)
        return () => hooks.delete(id)
      },
      tools: { register: ({ name }) => {
        assert.ok(!tools.has(name))
        tools.add(name)
        return () => tools.delete(name)
      } },
      logger: { warn: assert.fail },
    }
    const service = { worldHealth: () => 'standby', start: () => {}, close: () => {} }
    const registry = createWorldConnectors(ctx, {
      minecraft: { ...service, wardrobeConfigured: configured },
      bilibili: service,
      singing: { ...service, scoreAvailable: configured },
    })
    registry.start()
    const expected = definitions.flatMap(definition => definition.actions.map(([name]) => name))
      .filter(name => configured || !['mc_change_appearance', 'companion_singing_score'].includes(name))
    assert.deepEqual(tools, new Set(expected))
    assert.ok(hooks.size > 0)
    await registry.close()
    assert.equal(tools.size, 0)
    assert.equal(hooks.size, 0)
  })
}

test('additional adapter is mounted, guarded, projected and disposed without changing the registry', async () => {
  const definition = {
    id: 'test-world', label: 'Test world', contextId: 'world.test', kind: 'topic', restricted: true, memory: false,
    actions: [['test_read', 'Reads a local fixture', 'test:read']],
  }
  const calls = []
  let status = 'standby'
  const registry = new WorldConnectors([connector(definition, {
    start: () => calls.push('start'),
    registerTools: () => { calls.push('register'); return () => calls.push('dispose') },
    health: () => status,
    abort: () => calls.push('abort'),
    close: async () => { calls.push('close') },
  })], () => assert.fail('Unexpected connector error'))
  assert.equal(registry.view().items[0].status, 'unavailable')
  registry.start()
  registry.start()
  assert.equal(registry.denied('test_read', scope(definition)), undefined)
  assert.match(registry.denied('test_read', scope(WORLD_DEFINITIONS.bilibili)), /requires/)
  assert.deepEqual(registry.view(), { version: 1, items: [{ id: definition.id, label: definition.label, status }] })
  status = 'busy'
  assert.equal(registry.view().items[0].status, 'busy')
  registry.beginStop()
  assert.equal(registry.view().items[0].status, 'unavailable')
  assert.match(registry.denied('test_read', scope(definition)), /unavailable/)
  const finished = registry.close()
  assert.equal(registry.close(), finished)
  await finished
  assert.deepEqual(calls, ['start', 'register', 'abort', 'dispose', 'close'])
})

test('failure during startup, status, abort or close is isolated to that connector', async () => {
  const failures = []
  const calls = []
  const fail = () => { throw new Error('/private/worlds/do-not-export') }
  const registry = new WorldConnectors([
    connector(WORLD_DEFINITIONS.minecraft, { start: fail, close: fail }),
    connector(WORLD_DEFINITIONS.bilibili, { health: fail, abort: fail, registerTools: () => fail }),
    connector(WORLD_DEFINITIONS.singing, { health: () => 'ready', close: () => calls.push('singing closed') }),
  ], (id, phase) => failures.push([id, phase]))
  registry.start()
  assert.deepEqual(registry.view().items.map(world => world.status), ['unavailable', 'unavailable', 'ready'])
  assert.doesNotMatch(JSON.stringify(registry.view()), /private|contextId|actions/)
  assert.match(registry.denied('mc_status', scope(WORLD_DEFINITIONS.minecraft)), /unavailable/)
  assert.equal(registry.denied('companion_singing_status', scope(WORLD_DEFINITIONS.singing)), undefined)
  await registry.close()
  assert.deepEqual(calls, ['singing closed'])
  assert.deepEqual(failures, [['minecraft', 'start'], ['bilibili', 'abort'], ['bilibili', 'dispose'], ['minecraft', 'close']])
})
