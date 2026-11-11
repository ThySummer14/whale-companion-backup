import assert from 'node:assert/strict'
import test from 'node:test'
import { DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT } from '../src/core/model.ts'
import { DAILY_INITIATIVE_OBSERVE_TOOL, DAILY_INITIATIVE_PROPOSE_TOOL, isDailyInitiativeTool,
  registerDailyInitiativeTools } from '../src/host/daily-initiative-tools.ts'
import { SessionService } from '../src/host/session.ts'
import { companionToolPolicy, restrictCompanionTools } from '../src/host/tool-policy.ts'

const names = [DAILY_INITIATIVE_OBSERVE_TOOL, DAILY_INITIATIVE_PROPOSE_TOOL]
const valid = { goal: '想看看上次没有走完的林边路线', evidenceId: 'recent-1', option: 'survey:north' }

function fixture(t) {
  const sessionId = 'session-daily-initiative'
  const binding = { contextId: DAILY_AUTONOMY_CONTEXT, kind: 'system', sessionId }
  const agent = { id: sessionId, session: { id: sessionId, header: {} } }
  const state = { agent, binding, current: binding, error: undefined }
  const tools = new Map()
  const calls = []
  const conclusions = []
  const observation = { evidence: [{ id: valid.evidenceId, kind: 'experience', text: '昨天遇到了树林。' }], options: [] }
  const response = { proposed: true }
  const ctx = {
    agents: { get: id => id === sessionId ? state.agent : undefined },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  const runtime = {
    store: { bindingBySession: id => id === sessionId ? state.binding : undefined,
      bindingByContext: id => id === DAILY_AUTONOMY_CONTEXT ? state.current : undefined },
    autonomy: {
      async observeDailyInitiative(id, signal) {
        calls.push({ type: 'observe', id, signal })
        if (state.error) throw state.error
        return observation
      },
      async proposeDailyInitiative(id, proposal, signal, callId) {
        calls.push({ type: 'propose', id, proposal, signal, callId })
        if (state.error) throw state.error
        state.afterProposal?.()
        return response
      },
    },
  }
  const dispose = registerDailyInitiativeTools(ctx, runtime)
  t.after(dispose)
  const signal = new AbortController().signal
  const execute = (name, args, context) => tools.get(name).execute(args, { agent, signal, callId: 'call-daily', rootCallId: 'call-daily',
    concludeTurn: () => conclusions.push(name), ...context })
  return { sessionId, agent, state, calls, tools, dispose, signal, execute, observation, response, conclusions }
}

test('daily initiative registers two narrow tools, forwards the live session and disposes both registrations', async t => {
  const h = fixture(t)
  assert.deepEqual([...h.tools.keys()], names)
  assert.ok(names.every(isDailyInitiativeTool))
  assert.equal(isDailyInitiativeTool('mc_follow'), false)
  assert.deepEqual(JSON.parse(await h.execute(names[0], {})), h.observation)
  assert.deepEqual(JSON.parse(await h.execute(names[1], { ...valid, goal: ` ${valid.goal} ` })), h.response)
  assert.deepEqual(h.calls, [{ type: 'observe', id: h.sessionId, signal: h.signal },
    { type: 'propose', id: h.sessionId, signal: h.signal, proposal: valid, callId: 'call-daily' }])
  assert.deepEqual(h.conclusions, [names[1]])
  h.dispose()
  assert.equal(h.tools.size, 0)
})

test('neither initiative tool can route unbound, unowned, replaced, or delegated calls', async t => {
  for (const [label, change] of [
    ['missing calling agent', h => ({ agent: undefined })],
    ['wrong context', h => { h.state.binding = { ...h.state.binding, contextId: 'chat.mobile' } }],
    ['wrong binding kind', h => { h.state.binding = { ...h.state.binding, kind: 'chat' } }],
    ['replacement binding', h => { h.state.current = { ...h.state.current, sessionId: 'different' } }],
    ['replacement agent with same id', h => { h.state.agent = { ...h.agent } }],
    ['subagent origin', h => { h.agent.session.header.origin = 'subagent' }],
    ['delegated depth', h => { h.agent.session.header.delegationDepth = 1 }],
    ['nested execution', () => ({ parent: Symbol() })],
    ['different root call', () => ({ rootCallId: 'outer' })],
  ]) await t.test(label, async child => {
    const h = fixture(child)
    const context = change(h)
    await assert.rejects(h.execute(names[0], {}, context), /current private daily session/u)
    await assert.rejects(h.execute(names[1], valid, context), /current private daily session/u)
    assert.deepEqual(h.calls, [])
  })
})

test('initiative tools reject aborted, malformed and no-longer-authorized calls', async t => {
  const h = fixture(t)
  await assert.rejects(h.execute(names[0], { contextId: 'chat.mobile' }), { name: 'ToolArgsError' })
  for (const proposal of [
    { ...valid, goal: '很短' }, { ...valid, goal: '先去看看林边，再\n决定怎么回来' },
    { ...valid, goal: '今天想检查营地\u202e旁的森林' }, { ...valid, goal: '森'.repeat(121) },
    { ...valid, evidenceId: 'recent 1' }, { ...valid, option: 'place:17' }, { ...valid, sessionId: 'external' },
  ]) await assert.rejects(h.execute(names[1], proposal), { name: 'ToolArgsError' })
  const controller = new AbortController()
  controller.abort(new Error('foreground changed'))
  await assert.rejects(h.execute(names[0], {}, { signal: controller.signal }), /foreground changed/u)
  await assert.rejects(h.execute(names[1], valid, { signal: controller.signal }), /foreground changed/u)
  assert.deepEqual(h.calls, [])
  h.state.error = new Error('scheduler authority changed')
  await assert.rejects(h.execute(names[0], {}), h.state.error)
  await assert.rejects(h.execute(names[1], valid), h.state.error)
  assert.deepEqual(h.conclusions, [])
})

test('cancellation after staging suppresses successful tool termination', async t => {
  const h = fixture(t)
  const controller = new AbortController()
  h.state.afterProposal = () => controller.abort(new Error('turn interrupted before receipt'))
  await assert.rejects(h.execute(names[1], valid, { signal: controller.signal }), /turn interrupted before receipt/u)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.conclusions, [])
})

test('the registered proposal tool preserves the requested clip and rejects partial or misplaced clip parameters', async t => {
  const h = fixture(t)
  const clip = { start: 12, seconds: 6, mode: 'audio' }
  const proposal = { ...valid, option: 'clip:2', clip }
  assert.deepEqual(JSON.parse(await h.execute(names[1], proposal)), h.response)
  assert.deepEqual(h.calls[0].proposal, proposal)
  for (const candidate of [{ ...proposal, clip: undefined }, { ...proposal, clip: { ...clip, seconds: 9 } },
    { ...proposal, clip: { ...clip, start: 1.5 } }, { ...proposal, clip: { ...clip, start: -1 } },
    { ...proposal, clip: { ...clip, mode: 'unsupported' } }, { ...valid, clip }]) {
    await assert.rejects(h.execute(names[1], candidate), { name: 'ToolArgsError' })
  }
  assert.equal(h.calls.length, 1)
})

test('a continuation can omit its goal and gets specific guidance for an unrelated clip argument', async t => {
  const h = fixture(t)
  const proposal = { option: 'survey:south', evidenceId: 'now-1', previousId: 'goal-1' }
  await assert.rejects(h.execute(names[1], { ...proposal, clip: { start: 0, seconds: 5, mode: 'both' } }),
    { name: 'ToolArgsError', message: /Remove the clip field/u })
  assert.deepEqual(h.calls, [])
  assert.deepEqual(JSON.parse(await h.execute(names[1], proposal)), h.response)
  assert.deepEqual(h.calls[0].proposal, proposal)
})

test('legacy daily choice stays tool-free while the opted-in private session gets only two native tools', () => {
  const policy = (context, kind, enabled) => companionToolPolicy(context, kind, true, false, false, enabled)
  const legacy = policy(DAILY_AUTONOMY_CONTEXT, 'system', false)
  const active = policy(DAILY_AUTONOMY_CONTEXT, 'system', true)
  assert.equal(legacy.profile, 'daily-choice')
  assert.deepEqual(legacy.allowed, [])
  assert.equal(active.profile, 'daily-initiative')
  assert.deepEqual(active.allowed.map(tool => tool.name), names)
  for (const [context, kind] of [[DAILY_AUTONOMY_CONTEXT, 'chat'], [DAILY_REFLECTION_CONTEXT, 'system'],
    [DAILY_VISIT_CONTEXT, 'system'], [MINECRAFT_RECOVERY_CONTEXT, 'system'], ['chat.mobile', 'chat'], ['game.minecraft', 'game']]) {
    const scope = policy(context, kind, true)
    assert.ok(names.every(name => scope.denied.includes(name)), context)
    assert.ok(scope.allowed.every(tool => !isDailyInitiativeTool(tool.name)), context)
  }
  const registered = new Set([...names, 'working_directory', 'mc_status'])
  const applied = []
  const ctx = { effect: callback => callback(), tools: { get: name => registered.has(name) ? { name } : undefined,
    restrict: filter => applied.push(filter), presentAs: style => applied.push(style) } }
  restrictCompanionTools(ctx, DAILY_AUTONOMY_CONTEXT, 'system')
  restrictCompanionTools(ctx, DAILY_AUTONOMY_CONTEXT, 'system', false, false, true)
  registered.delete(names[1])
  restrictCompanionTools(ctx, DAILY_AUTONOMY_CONTEXT, 'system', false, false, true)
  assert.deepEqual(applied, [{ allow: [] }, 'native', { allow: names }, 'native', { allow: [names[0]] }])
})

test('only an authorized replacement daily session can be created with native initiative tools', async () => {
  const create = { contextId: DAILY_AUTONOMY_CONTEXT, kind: 'system', label: '每日自主活动' }
  const service = new SessionService({}, { bindingByContext: () => undefined }, () => {})
  await assert.rejects(service.create(create, true, undefined, false, false, true), { code: 'daily-initiative-managed' })
  await assert.rejects(service.create(create, false, () => {}, false, false, true), { code: 'daily-initiative-managed' })
  await assert.rejects(service.create({ ...create, contextId: 'chat.mobile' }, true, () => {}, false, false, true), { code: 'daily-initiative-managed' })
  await assert.rejects(service.create({ ...create, kind: 'chat' }, true, () => {}, false, false, true), { code: 'curator-binding-conflict' })
  await assert.rejects(service.create({ ...create, resume: true, sessionId: 'old' }, true, () => {}, false, false, true), { code: 'curator-binding-conflict' })
})

test('native daily creation checks authority on both sides of async agent creation and cannot leave a stale binding', async () => {
  const scope = []
  const activities = []
  const bindCalls = []
  let binding
  let checks = 0
  let disposed = 0
  let revoked = false
  const agentCtx = { effect: callback => callback(), tools: { get: name => names.includes(name) ? { name } : undefined,
    presentAs: style => scope.push(style), restrict: rules => scope.push(rules) } }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({}) },
    agents: { get: () => undefined, async create({ setup }) { setup(agentCtx); return { async dispose() { disposed++ } } } },
  }
  const store = { bindingByContext: () => binding, bindingBySession: () => undefined,
    recordActivity: activity => activities.push(activity) }
  const service = new SessionService(ctx, store, value => {
    bindCalls.push(value)
    binding = value
  })
  const input = { contextId: DAILY_AUTONOMY_CONTEXT, kind: 'system', label: '每日自主活动' }
  const assertAuthorized = () => {
    checks++
    if (checks === 2 && revoked) throw new Error('lease revoked during create')
  }

  revoked = true
  await assert.rejects(service.create(input, true, assertAuthorized, false, false, true), /lease revoked/u)
  assert.equal(checks, 2)
  assert.equal(disposed, 1)
  assert.deepEqual(bindCalls, [])
  assert.deepEqual(activities, [])
  assert.equal(binding, undefined)

  revoked = false
  checks = 0
  scope.length = 0
  const created = await service.create(input, true, assertAuthorized, false, false, true)
  assert.equal(checks, 2)
  assert.deepEqual(scope, ['native', { allow: names }])
  assert.equal(created.binding, binding)
  assert.equal(created.resumed, false)
  assert.equal(bindCalls.length, 1)
  assert.equal(activities[0].kind, 'session.created')
})
