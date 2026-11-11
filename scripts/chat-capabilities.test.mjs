import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CHAT_CAPABILITY_TOOL, CHAT_DEFERRED_TOOLS, registerChatCapabilities } from '../src/host/chat-capabilities.ts'
import { HOUSE_DRAFT_TOOL } from '../src/host/minecraft-house-tool.ts'
import { HOUSE_PROJECT_PLAN_TOOL, minecraftHouseProjectRequest } from '../src/host/minecraft-house-project-tool.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const REMEMBER = 'companion_memory_remember'
const STOP = 'companion_avatar_stop'
const message = (text = '普通聊天', source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] })
const signal = new AbortController().signal

function fixture(t, minecraft) {
  const events = new Map()
  const agents = new Map()
  const bindings = new Map()
  const effects = new Map()
  const invoked = []
  const definitions = new Map(CHAT_DEFERRED_TOOLS.filter(name => name !== HOUSE_PROJECT_PLAN_TOOL).map(name => [name, { name, async execute(args, exec) {
    invoked.push({ name, args, agent: exec.agent.id })
    return 'real-result'
  } }]))
  const ctx = {
    agents: { get: id => agents.get(id) },
    tools: { get: name => definitions.get(name) },
    logger: { warn: (...args) => assert.fail(String(args)) },
    on(name, handler) { events.set(name, handler); return () => events.delete(name) },
  }
  const stop = registerChatCapabilities(ctx, { bindingBySession: id => bindings.get(id) }, minecraft)
  t.after(stop)
  const agent = (id = 'phone', kind = 'chat', header = {}) => {
    const scope = { tools: new Map(), filters: new Set() }
    const live = { id, session: { id, header }, ctx: { tools: {
      register(tool) {
        assert.ok(!scope.tools.has(tool.name))
        scope.tools.set(tool.name, tool)
        return () => scope.tools.delete(tool.name)
      },
      restrict(filter) { scope.filters.add(filter); return () => scope.filters.delete(filter) },
    } } }
    effects.set(live, scope)
    agents.set(id, live)
    bindings.set(id, { contextId: 'chat.' + id, kind })
    return live
  }
  const event = (live, type, data, surfaceOp) => events.get('session/event')?.(live.session, { type, data, surfaceOp })
  const claim = (live, input, turn = 1) => events.get('agent/inbox/claimed')?.({ agent: live, message: input, turn })
  const start = (live, turn = 1) => event(live, 'turn/start', { turn })
  const admit = (live, input, turn = 1, step = 1) => {
    event(live, 'step/start', { turn, step })
    event(live, 'user/message', input, 'append')
  }
  const scope = live => effects.get(live)
  const tool = (live, name) => scope(live).tools.get(name)
  const open = (live, capability, exec = {}) => tool(live, CHAT_CAPABILITY_TOOL).execute({ capability }, { agent: live, signal, ...exec })
  return { definitions, agents, bindings, invoked, agent, event, claim, start, admit, scope, tool, open,
    disposed: live => events.get('session/disposed')(live.session) }
}

test('routine chat starts with one small capability entry and hides only deferred Companion definitions', t => {
  const h = fixture(t)
  const agent = h.agent()
  h.start(agent)
  assert.deepEqual([...h.scope(agent).tools.keys()], [CHAT_CAPABILITY_TOOL])
  assert.deepEqual([...h.scope(agent).filters][0].deny, CHAT_DEFERRED_TOOLS.filter(name => name !== HOUSE_PROJECT_PLAN_TOOL))
  assert.ok(!CHAT_DEFERRED_TOOLS.includes('companion_memory_search'))
  assert.ok(!CHAT_DEFERRED_TOOLS.includes('working_directory'))
  assert.deepEqual(companionToolPolicy('chat.mobile', 'chat').onDemand, { entry: CHAT_CAPABILITY_TOOL, tools: CHAT_DEFERRED_TOOLS })
  for (const [context, kind] of [['game.minecraft','game'], ['world.bilibili','topic'], ['memory.curator','system']]) {
    assert.equal(companionToolPolicy(context, kind).onDemand, undefined)
  }
})

test('admitted owner chat opens just the selected tool, keeps its behavior, and does not leak into parallel or later turns', async t => {
  const h = fixture(t)
  const phone = h.agent()
  const other = h.agent('desktop')
  const input = message('记住我喜欢松木', { kind: 'companion-mobile', form: 'relay' })
  h.start(phone)
  h.start(other)
  h.claim(phone, input)
  await assert.rejects(h.open(phone, 'remember'), /current owner/)
  h.admit(phone, input)
  assert.match(await h.open(phone, 'remember'), /is available/u)
  assert.match(await h.open(phone, 'remember'), /already available/u)
  assert.deepEqual([...h.scope(phone).tools.keys()], [CHAT_CAPABILITY_TOOL, REMEMBER])
  assert.deepEqual([...h.scope(other).tools.keys()], [CHAT_CAPABILITY_TOOL])
  assert.deepEqual(h.invoked, [])
  const definition = h.tool(phone, REMEMBER)
  assert.equal(await definition.execute({ content: '喜欢松木' }, { agent: phone, signal }), 'real-result')
  assert.deepEqual(h.invoked, [{ name: REMEMBER, args: { content: '喜欢松木' }, agent: 'phone' }])
  await assert.rejects(definition.execute({}, { agent: other, signal }), /current owner/)
  await assert.rejects(definition.execute({}, { agent: phone, signal: AbortSignal.abort() }), { name: 'AbortError' })
  h.event(phone, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  assert.equal(h.scope(phone).filters.size, 0)
  assert.equal(h.scope(phone).tools.size, 0)
  await assert.rejects(definition.execute({}, { agent: phone, signal }), /current owner/)
  h.start(phone, 2)
  assert.deepEqual([...h.scope(phone).tools.keys()], [CHAT_CAPABILITY_TOOL])
})

test('the house uses the original explicit-request admission rule and is available on the first step', async t => {
  const h = fixture(t)
  const a = h.agent()
  const owner = message('大肥鱼，帮我设计一间木屋。')
  h.start(a)
  h.claim(a, owner)
  const tool = h.tool(a, HOUSE_DRAFT_TOOL)
  assert.ok(tool)
  await assert.rejects(tool.execute({}, { agent: a, signal }), /current owner/)
  h.admit(a, owner)
  assert.equal(await tool.execute({}, { agent: a, signal }), 'real-result')
  assert.match(await h.open(a, 'house_blueprint'), /already available/u)
  h.event(a, 'turn/end', { turn: 1 })
  h.start(a, 2)
  const ordinary = message('昨天去看了一间木屋')
  h.claim(a, ordinary, 2)
  h.admit(a, ordinary, 2)
  assert.match(await h.open(a, 'house_blueprint'), /explicit Minecraft house request/u)
  assert.ok(!h.tool(a, HOUSE_DRAFT_TOOL))
})

test('an explicit Minecraft house request can include dimensions before the house noun', t => {
  const h = fixture(t)
  const a = h.agent()
  const owner = message('照这张图盖一间 5×5×5 的 Minecraft 小屋。请保留屋顶高度。')
  h.start(a)
  h.claim(a, owner)
  h.admit(a, owner)
  assert.ok(h.tool(a, HOUSE_DRAFT_TOOL))
})

test('synthetic, changed and ambiguous owner input cannot activate a capability', async t => {
  const h = fixture(t)
  const a = h.agent()
  const owner = message('停一下动作')
  for (const [index, pair] of [
    [message('帮我盖一间小屋', { kind: 'companion-world', form: 'minecraft-event' }), undefined],
    [owner, { ...owner, content: message('改动过的内容').content }],
    [owner, owner, message('第二条输入')],
  ].entries()) {
    const turn = index + 1
    h.start(a, turn)
    h.claim(a, pair[0], turn)
    if (pair[2]) h.claim(a, pair[2], turn)
    if (pair[1]) h.admit(a, pair[1], turn)
    await assert.rejects(h.open(a, 'stop_gesture'), /current owner/)
    assert.ok(!h.tool(a, STOP))
    assert.ok(!h.tool(a, HOUSE_DRAFT_TOOL))
  }
})

test('tools from a disposed, unbound or replaced agent lose authority, and non-chat routes stay untouched', async t => {
  const h = fixture(t)
  for (const agent of [h.agent('world','game'), h.agent('bili','topic'), h.agent('child','chat',{ origin: 'subagent' }),
    h.agent('delegated','chat',{ delegationDepth: 1 })]) {
    h.start(agent)
    assert.equal(h.scope(agent).tools.size, 0)
  }
  const a = h.agent()
  const owner = message()
  h.start(a)
  h.claim(a, owner)
  h.admit(a, owner)
  h.definitions.delete(STOP)
  assert.match(await h.open(a, 'stop_gesture'), /unavailable/u)
  assert.match(await h.open(a, 'remember'), /available/u)
  const remember = h.tool(a, REMEMBER)
  h.bindings.set(a.id, { contextId: 'chat.another', kind: 'chat' })
  await assert.rejects(remember.execute({}, { agent: a, signal }), /current owner/)
  h.bindings.set(a.id, { contextId: 'chat.phone', kind: 'chat' })
  h.agent(a.id)
  await assert.rejects(remember.execute({}, { agent: a, signal }), /current owner/)
  h.disposed(a)
  assert.equal(h.scope(a).tools.size, 0)
})

const explicitProject = '请帮我选 Minecraft 建筑工程「双翼连廊屋」的下一段。先看哪边材料够。'
const inspect = { action: 'inspect' }
const build = { action: 'submit', choice: { action: 'build', section: 1, reason: '东翼已完成预检并且材料足够' } }

function projectFixture(t, change = {}) {
  const calls = []
  const observation = { projectName: '双翼连廊屋', observedAt: '2026-11-10T12:00:00Z', privateBlueprint: 'DO-NOT-EXPOSE', options: [
    { section: 0, name: '西翼', status: 'interrupted', ready: false, reason: 'homebuild-materials',
      materials: [{ material: 'spruce_planks', needed: 25, carried: 10, missing: 15, rawInventory: 'PRIVATE' }],
      previousReason: 'homebuild-unreachable-placement', coordinates: [1, 80, 2] },
    { section: 1, name: '东翼', status: 'pending', ready: true, approvalToken: 'PRIVATE' },
  ] }
  const h = fixture(t, {
    async observeHouseProjectPlan(request, signal) {
      calls.push({ type: 'observe', request, signal })
      return change.observe ? change.observe(request, signal) : { status: 'observed', observation }
    },
    async recordHouseProjectPlan(source, choice, signal, guard) {
      assert.equal(source, observation, 'host must receive the exact unprojected observation object')
      calls.push({ type: 'submit', choice })
      await change.beforeRecord?.(signal)
      guard()
      calls.push({ type: 'commit', choice })
      return { ...choice, options: source.options, internal: 'PRIVATE' }
    },
  })
  const a = h.agent()
  const owner = message(explicitProject, { kind: 'companion-mobile', form: 'relay' })
  const declare = (id, step = 1, name = HOUSE_PROJECT_PLAN_TOOL, turn = 1) => h.event(a, 'tool/call', { turn, step, callId: id, name })
  const execute = (id, args, extra) => h.tool(a, HOUSE_PROJECT_PLAN_TOOL).execute(args, { agent: a, signal, callId: id, rootCallId: id, ...extra })
  h.start(a)
  h.claim(a, owner)
  return { h, a, owner, calls, observation, execute, declare, admit: () => h.admit(a, structuredClone(owner)) }
}

test('only explicit next-section wording opens the private tool, and routine/quoted/attached input does not', async t => {
  assert.equal(minecraftHouseProjectRequest(message(explicitProject)), explicitProject)
  assert.ok(minecraftHouseProjectRequest(message('请帮我选 Minecraft 建筑工程「双翼连廊屋」 #e42d5446-3618-4bf2-bc03-dd5c877bc407的下一段')))
  assert.ok(minecraftHouseProjectRequest(message('大肥鱼，规划一下我的世界建筑项目《石屋》的下一步。')))
  assert.ok(minecraftHouseProjectRequest(message('Minecraft 建筑工程先建哪一段？')))
  for (const text of ['昨天我请她帮我选 Minecraft 建筑工程的下一段。', '“请帮我选 Minecraft 建筑工程的下一段”',
    '请帮我选下一段。', '聊聊 Minecraft 建筑工程的下一段', '别帮我选 Minecraft 建筑工程的下一段']) {
    assert.equal(minecraftHouseProjectRequest(message(text)), undefined)
  }
  assert.equal(minecraftHouseProjectRequest({ ...message(explicitProject),
    content: [...message(explicitProject).content, { type: 'image' }] }), undefined)
  const h = fixture(t, { async observeHouseProjectPlan() { assert.fail('ordinary chat must never reach the host') } })
  const a = h.agent()
  const ordinary = message('我今天建了一个 Minecraft 建筑工程')
  h.start(a)
  h.claim(a, ordinary)
  h.admit(a, ordinary)
  assert.equal(h.tool(a, HOUSE_PROJECT_PLAN_TOOL), undefined)
  assert.match(await h.open(a, 'house_project_plan'), /explicit project planning request/)
  assert.equal(h.definitions.has(HOUSE_PROJECT_PLAN_TOOL), false)
  assert.ok(companionToolPolicy('chat.mobile', 'chat').allowed.some(row => row.name === HOUSE_PROJECT_PLAN_TOOL))
  for (const [context, kind] of [['game.minecraft', 'game'], ['autonomy.minecraft-recovery', 'system'], ['autonomy.daily-visit', 'system']]) {
    assert.ok(companionToolPolicy(context, kind).denied.includes(HOUSE_PROJECT_PLAN_TOOL))
  }
})

test('paired owner inspection exposes only compact evidence and records one recommendation from the same turn', async t => {
  const p = projectFixture(t)
  assert.ok(p.h.tool(p.a, HOUSE_PROJECT_PLAN_TOOL), 'planner auto-opens before the first model step')
  p.declare('not-admitted')
  await assert.rejects(p.execute('not-admitted', inspect), /current owner chat step/)
  p.admit()
  p.declare('no-evidence')
  await assert.rejects(p.execute('no-evidence', build), /Inspect the project/)
  await assert.rejects(p.execute('fabricated', inspect), /current owner chat step/)
  p.declare('wrong-step', 2)
  await assert.rejects(p.execute('wrong-step', inspect), /current owner chat step/)
  p.declare('read')
  const result = await p.execute('read', inspect)
  assert.equal(p.calls[0].request, explicitProject)
  assert.doesNotMatch(result, /PRIVATE|coordinates|Blueprint|approvalToken/)
  assert.match(JSON.parse(result).next, /action=submit/)
  assert.match(JSON.parse(result).next, /build section \[1\], prepare section \[0\]/)
  assert.deepEqual(JSON.parse(result).options, [
    { section: 0, name: '西翼', status: 'interrupted', ready: false, reason: 'homebuild-materials',
      previousReason: 'homebuild-unreachable-placement', materials: [{ material: 'spruce_planks', needed: 25, carried: 10, missing: 15 }] },
    { section: 1, name: '东翼', status: 'pending', ready: true },
  ])
  await assert.rejects(p.execute('read', inspect), /current owner chat step/)
  p.declare('repeat-read')
  await assert.rejects(p.execute('repeat-read', inspect), /already used/)
  p.h.event(p.a, 'step/end', { turn: 1, step: 1 })
  assert.equal(p.calls[0].signal.aborted, true)
  p.h.event(p.a, 'step/start', { turn: 1, step: 2 })
  p.declare('bad-choice', 2)
  await assert.rejects(p.execute('bad-choice', { action: 'submit', choice: { action: 'build', reason: '故意省略施工段' } }), /separate choice/)
  p.declare('blocked-choice', 2)
  await assert.rejects(p.execute('blocked-choice', { ...build, choice: { ...build.choice, section: 0 } }), /build section \[1\], prepare section \[0\]/)
  p.declare('choose', 2)
  assert.deepEqual(JSON.parse(await p.execute('choose', build)), { status: 'recorded', ...build.choice, worldChanged: false,
    next: '请在 Minecraft 工作台重新预检，由主人确认开工。' })
  p.declare('choose-again', 2)
  await assert.rejects(p.execute('choose-again', build), /already .* recorded/)
  assert.deepEqual(p.calls.map(call => call.type), ['observe', 'submit', 'commit'])
  p.h.event(p.a, 'turn/end', { turn: 1 })
  p.h.start(p.a, 2)
  assert.equal(p.h.tool(p.a, HOUSE_PROJECT_PLAN_TOOL), undefined)
})

test('parallel and interrupted planning calls cannot turn stale evidence into a proposal', async t => {
  let resolve
  const gate = new Promise(done => { resolve = done })
  const p = projectFixture(t, { observe: () => gate })
  p.admit()
  p.declare('pending')
  const reading = p.execute('pending', inspect)
  p.declare('overlap')
  await assert.rejects(p.execute('overlap', inspect), /already in progress/)
  p.h.claim(p.a, message('第二条主人消息'))
  assert.equal(p.calls[0].signal.aborted, true)
  resolve({ status: 'observed', observation: p.observation })
  await assert.rejects(reading, { name: 'AbortError' })
  p.declare('late')
  await assert.rejects(p.execute('late', build), /current owner chat step/)
  assert.deepEqual(p.calls.map(call => call.type), ['observe'])
})

test('host commit callback rejects a replaced binding, a closed turn and cancellation', async t => {
  for (const close of ['rebind', 'step-end', 'cancel']) {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const p = projectFixture(t, { async beforeRecord() { entered.resolve(); await release.promise } })
    p.admit()
    p.declare('observe')
    await p.execute('observe', inspect)
    p.declare('submit')
    const cancel = new AbortController()
    const writing = p.execute('submit', build, { signal: cancel.signal })
    await entered.promise
    if (close === 'rebind') p.h.bindings.set(p.a.id, { contextId: 'chat.changed', kind: 'chat' })
    if (close === 'step-end') p.h.event(p.a, 'step/end', { turn: 1, step: 1 })
    if (close === 'cancel') cancel.abort()
    release.resolve()
    await assert.rejects(writing, close === 'rebind' ? /current owner chat step/ : { name: 'AbortError' })
    assert.deepEqual(p.calls.map(call => call.type), ['observe', 'submit'])
  }
})

test('nested dispatch requires an observed run_code root in the active step', async t => {
  const p = projectFixture(t)
  p.admit()
  p.declare('ordinary-root', 1, 'companion_memory_search')
  p.h.event(p.a, 'tool/ptc-dispatch-start', { name: HOUSE_PROJECT_PLAN_TOOL, subCallId: 'wrong-sub', rootCallId: 'ordinary-root' })
  await assert.rejects(p.execute('wrong-sub', inspect, { parent: {}, rootCallId: 'ordinary-root' }), /current owner chat step/)
  p.declare('ptc', 1, 'run_code')
  p.h.event(p.a, 'tool/ptc-dispatch-start', { name: HOUSE_PROJECT_PLAN_TOOL, subCallId: 'nested-read', rootCallId: 'ptc' })
  assert.equal(JSON.parse(await p.execute('nested-read', inspect, { parent: {}, rootCallId: 'ptc' })).status, 'observed')
  await assert.rejects(p.execute('nested-read', inspect, { parent: {}, rootCallId: 'ptc' }), /current owner chat step/)
  p.h.event(p.a, 'step/start', { turn: 1, step: 2 })
  p.h.event(p.a, 'tool/ptc-dispatch-start', { name: HOUSE_PROJECT_PLAN_TOOL, subCallId: 'stale-root', rootCallId: 'ptc' })
  await assert.rejects(p.execute('stale-root', build, { parent: {}, rootCallId: 'ptc' }), /current owner chat step/)
  assert.deepEqual(p.calls.map(call => call.type), ['observe'])
})

test('missing and ambiguous project lookups cannot produce a recommendation', async t => {
  for (const response of [{ status: 'choose-project', projects: ['一号工程', '二号工程'] }, { status: 'no-project' }]) {
    const p = projectFixture(t, { observe: async () => response })
    p.admit()
    p.declare('read')
    assert.deepEqual(JSON.parse(await p.execute('read', inspect)), response)
    p.declare('submit')
    await assert.rejects(p.execute('submit', build), /Inspect the project/)
    assert.deepEqual(p.calls.map(call => call.type), ['observe'])
  }
})
