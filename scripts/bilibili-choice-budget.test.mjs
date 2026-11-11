import assert from 'node:assert/strict'
import test from 'node:test'
import { registerBilibiliChoiceBudget } from '../src/host/bilibili-choice-budget.ts'

function fixture() {
  const state = { binding: { contextId: 'autonomy.bilibili', kind: 'system' } }
  const agent = { id: 'choice', session: { header: {} } }
  state.current = agent
  const config = { provider: 'fixture', model: 'exact-model' }
  const resolutions = []
  let listener
  registerBilibiliChoiceBudget({
    on(name, callback) { assert.equal(name, 'agent/request'); listener = callback },
    agents: { get: () => state.current },
    llm: { async resolveModelInfo(...args) {
      resolutions.push(args)
      if (state.resolve) return state.resolve()
      return { defaultMaxTokens: 2048 }
    } },
  }, { bindingBySession: () => state.binding })
  const request = ({ signal = new AbortController().signal, step = 1, base = config } = {}) =>
    listener({ agent, step, signal }, async () => base)
  return { state, agent, config, resolutions, request }
}

test('only the current private Bilibili selector receives a bounded output budget', async t => {
  const { request, resolutions, config } = fixture()
  const bounded = await request()
  assert.equal(bounded.maxTokens, 192)
  assert.equal(Object.hasOwn(bounded, 'reasoningEffort'), false)
  assert.deepEqual(resolutions[0].slice(0, 2), ['fixture', 'exact-model'])
  assert.equal((await request({ base: { ...config, maxTokens: 90 } })).maxTokens, 90)
  for (const kind of ['subagent', 'delegation depth', 'foreground', 'other decision', 'wrong kind', 'detached', 'later step', 'aborted']) await t.test(kind, async () => {
    const { state, agent, config, resolutions, request } = fixture()
    const options = {}
    if (kind === 'subagent') agent.session.header.origin = 'subagent'
    if (kind === 'delegation depth') agent.session.header.delegationDepth = 1
    if (kind === 'foreground') state.binding.contextId = 'world.bilibili'
    if (kind === 'other decision') state.binding.contextId = 'autonomy.bilibili-clip'
    if (kind === 'wrong kind') state.binding.kind = 'topic'
    if (kind === 'detached') state.current = undefined
    if (kind === 'later step') options.step = 2
    if (kind === 'aborted') options.signal = AbortSignal.abort()
    assert.equal(await request(options), config)
    assert.equal(resolutions.length, 0)
  })
})

test('the choice changes reasoning only when the exact route explicitly offers off', async () => {
  const { state, request, config } = fixture()
  const base = { ...config, reasoningEffort: 'high', maxTokens: 2048 }
  state.resolve = () => ({ defaultMaxTokens: 120, reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
  assert.deepEqual(await request({ base }), { ...base, reasoningEffort: 'off', maxTokens: 192 })
  assert.equal((await request()).maxTokens, 120)
  state.resolve = () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
  assert.equal(await request({ base }), base)
  state.resolve = () => ({})
  assert.equal(await request({ base }), base)
  state.resolve = () => { throw new Error('unavailable route metadata') }
  assert.equal(await request({ base }), base)
  state.resolve = () => { state.binding = undefined; return {} }
  assert.equal(await request({ base }), base)
})
