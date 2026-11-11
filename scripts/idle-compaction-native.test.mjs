import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { compactIdleAgent, inspectIdleCompaction } from '../src/host/idle-compaction-native.ts'

function fixture() {
  const session = Session.create(SessionId('idle-native-test'))
  const source = { provider: 'test-route', model: 'test-model' }
  const engine = { async compactNow() { return null } }
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session, ctx: { get: name => name === 'compaction' ? engine : undefined } }
  let turn = 0
  const complete = (options = {}) => {
    const { route = { ...source, contextWindow: 10000 }, usage, reason = { kind: 'completed' }, replySource = source, afterMetering } = options
    const accounting = Object.hasOwn(options, 'usage') ? usage : { inputTokens: 400, outputTokens: 150, cacheReadTokens: 2600, cacheWriteTokens: 200 }
    session.append('turn/start', { turn: ++turn })
    session.append('step/start', { turn, step: 1 })
    if (route) session.append('request/context', route)
    session.append('assistant/message', {
      turn, step: 1, message: createAssistantMessage({ source: replySource, content: [{ type: 'text', text: 'reply' }] }),
      stream: [], ...(accounting === undefined ? {} : { usage: accounting }),
    }, { surfaceOp: 'append' })
    afterMetering?.(session)
    session.append('step/end', { turn, step: 1 })
    return session.append('turn/end', { turn, reason })
  }
  return { agent, engine, session, source, complete }
}

test('context pressure uses the exact routed durable prompt size, including disjoint cache tokens', () => {
  const { agent, complete } = fixture()
  const end = complete()
  assert.deepEqual(inspectIdleCompaction(agent), { turnSeq: end.seq, endedAt: end.time, inputTokens: 3200, contextWindow: 10000 })
  const end2 = complete({ route: null, usage: { inputTokens: 4600, outputTokens: 5 } })
  assert.deepEqual(inspectIdleCompaction(agent), { turnSeq: end2.seq, endedAt: end2.time, inputTokens: 4600, contextWindow: 10000 })
})

test('missing accounting or request capacity, mismatched routing and unfinished turns fail closed', () => {
  const { agent, complete, session, source } = fixture()
  complete()
  complete({ usage: undefined })
  assert.equal(inspectIdleCompaction(agent), undefined)
  complete({ route: source })
  assert.equal(inspectIdleCompaction(agent), undefined)
  complete({ replySource: { ...source, model: 'other-model' } })
  assert.equal(inspectIdleCompaction(agent), undefined)
  complete({ reason: { kind: 'abandoned' } })
  assert.equal(inspectIdleCompaction(agent), undefined)
  session.append('turn/start', { turn: 5 })
  assert.equal(inspectIdleCompaction(agent), undefined)
})

test('metering matches the request context preceding its response, rather than a later snapshot', () => {
  const { agent, source, complete } = fixture()
  complete({ afterMetering: session => session.append('request/context', { ...source, contextWindow: 20000 }) })
  assert.equal(inspectIdleCompaction(agent).contextWindow, 10000)
})

test('successful native compaction and checkpoint replacements require a newer completed turn', () => {
  const { agent, complete, session } = fixture()
  complete()
  session.append('compaction/end', { compactionId: 'failed', turn: null, error: 'interrupted' })
  assert.ok(inspectIdleCompaction(agent))
  session.append('compaction/end', { compactionId: 'success', turn: null })
  assert.equal(inspectIdleCompaction(agent), undefined)
  complete()
  assert.ok(inspectIdleCompaction(agent))
  session.append('user/message', createUserMessage({ source: { kind: 'compact-checkpoint', compactionId: 'checkpoint' }, content: [{ type: 'text', text: 'summary' }] }), { surfaceOp: 'append' })
  session.append('compaction/end', { compactionId: 'checkpoint', turn: null, error: 'flush failure' })
  assert.equal(inspectIdleCompaction(agent), undefined)
})

test('a queued turn, queued steering or unavailable native service cannot become a candidate', () => {
  const { agent, complete } = fixture()
  complete()
  agent.status = 'running'
  assert.equal(inspectIdleCompaction(agent), undefined)
  agent.status = 'idle'
  for (const target of ['nextTurn', 'nextStep']) {
    agent.inbox[target].push({})
    assert.equal(inspectIdleCompaction(agent), undefined)
    agent.inbox[target].pop()
  }
  agent.ctx.get = () => undefined
  assert.equal(inspectIdleCompaction(agent), undefined)
})

test('adapter forwards the original Agent and signal to compactNow and returns only receipt metadata', async () => {
  const { agent, engine } = fixture()
  const signal = new AbortController().signal
  engine.compactNow = async function (owner, operationSignal) {
    assert.equal(this, engine)
    assert.equal(owner, agent)
    assert.equal(operationSignal, signal)
    return { compactionId: 'real-transaction', shadowedTokenCount: 550, summary: [{ type: 'text', text: 'private' }] }
  }
  assert.deepEqual(await compactIdleAgent(agent, signal), { compactionId: 'real-transaction', shadowedTokenCount: 550 })
  engine.compactNow = async () => null
  assert.equal(await compactIdleAgent(agent, signal), null)
  const busy = Object.assign(new Error('native lock'), { code: 'busy' })
  engine.compactNow = async () => { throw busy }
  await assert.rejects(compactIdleAgent(agent, signal), error => error === busy)
  const reason = new Error('new user input')
  await assert.rejects(compactIdleAgent(agent, AbortSignal.abort(reason)), error => error === reason)
})
