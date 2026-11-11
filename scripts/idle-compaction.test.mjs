import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CONTEXT_COMPACTION_CAPABILITY, IDLE_COMPACTION_MINUTES } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { IdleCompactionService } from '../src/host/idle-compaction.ts'

const now = Date.now()
const endedAt = now - IDLE_COMPACTION_MINUTES * 60_000
const result = { compactionId: 'native-id', shadowedTokenCount: 1300 }

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/idle-compaction-test-')
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const agents = new Map()
  const reviewed = new Set()
  const services = []
  function service() {
    const instance = new IdleCompactionService(store, id => agents.get(id), (context, id, seq) => reviewed.has(`${context}:${id}:${seq}`))
    services.push(instance)
    return instance
  }
  t.after(async () => {
    for (const instance of services) await instance.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const enable = (enabled = true) => store.autonomy.saveSettings({ ...store.autonomy.settings(), idleCompactionEnabled: enabled })
  const add = (contextId = 'chat.mobile', options = {}) => {
    const sessionId = `session-${contextId}`
    store.bindContext({ contextId, sessionId, kind: options.kind ?? 'chat', label: contextId })
    const route = { provider: 'qa', model: 'local', contextWindow: 10_000 }
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'request/context', data: route },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: route.provider, model: route.model } }, usage: { inputTokens: options.tokens ?? 3000 } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((item, seq) => ({ ...item, seq, time: options.endedAt ?? endedAt }))
    const session = { seq: events.length, inheritedEventCount: 0, snapshotEvents: from => events.slice(from), requestContext: () => route, surface: { nodes: [] } }
    const compactNow = t.mock.fn(options.compact ?? (async () => result))
    const agent = { id: sessionId, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, ctx: { get: key => key === 'compaction' ? { compactNow } : undefined } }
    agents.set(sessionId, agent)
    return { sessionId, agent, compactNow, approve: () => reviewed.add(`${contextId}:${sessionId}:3`) }
  }
  return { store, enable, add, service, tasks: () => store.tasks(100, CONTEXT_COMPACTION_CAPABILITY) }
}

test('idle compaction requires exact review, elapsed idle time and routed pressure, then records one native receipt across restarts', async t => {
  const h = fixture(t)
  const mobile = h.add()
  const cheap = h.add('game.minecraft', { kind: 'game', tokens: 2999 })
  const internal = h.add('autonomy.example')
  cheap.approve()
  internal.approve()
  const service = h.service()
  await service.tick(now)
  assert.equal(h.tasks().length, 0)
  h.enable()
  await service.tick(now)
  assert.equal(h.tasks().length, 0)
  mobile.approve()
  await service.tick(now - 1)
  assert.equal(h.tasks().length, 0)
  await service.tick(now)
  assert.equal(mobile.compactNow.mock.callCount(), 1)
  assert.equal(mobile.compactNow.mock.calls[0].arguments[0], mobile.agent)
  assert.equal(h.tasks()[0].status, 'succeeded')
  const event = h.store.activities().find(item => item.kind === 'session.compaction.completed')
  assert.deepEqual(event.data, { turnSeq: 3, inputTokens: 3000, contextWindow: 10_000, ...result })
  assert.equal(event.contextId, 'chat.mobile')
  await service.close()
  await h.service().tick(now)
  assert.equal(h.tasks().length, 1)
  assert.equal(mobile.compactNow.mock.callCount(), 1)
})

test('new input aborts only its own maintenance and preserves the inbox; a synthetic checkpoint is not input', async t => {
  const h = fixture(t)
  h.enable()
  const mobile = h.add('chat.mobile', { compact: async (_agent, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  mobile.approve()
  const service = h.service()
  const pending = service.tick(now)
  await Promise.resolve()
  const signal = mobile.compactNow.mock.calls[0].arguments[1]
  service.observe(mobile.sessionId, { type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } })
  service.observe('other-session', { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'other' }] } })
  assert.equal(signal.aborted, false)
  const waiting = { id: 'waiting-user' }
  mobile.agent.inbox.nextTurn.push(waiting)
  service.observe(mobile.sessionId, { type: 'agent/inbox/spliced', data: { inserted: [waiting] } })
  await pending
  assert.equal(signal.aborted, true)
  assert.deepEqual(mobile.agent.inbox.nextTurn, [waiting])
  assert.equal(h.tasks()[0].status, 'cancelled')
  assert.ok(!h.store.activities().some(item => item.kind === 'session.compaction.completed'))
})

test('reserves one maintenance slot and turning off the policy aborts without replaying the same turn', async t => {
  const h = fixture(t)
  h.enable()
  const first = h.add('chat.aaa', { compact: async (_agent, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const second = h.add('game.minecraft', { kind: 'game' })
  first.approve()
  second.approve()
  const service = h.service()
  const pending = service.tick(now)
  await Promise.resolve()
  await service.tick(now)
  assert.equal(first.compactNow.mock.callCount(), 1)
  assert.equal(second.compactNow.mock.callCount(), 0)
  h.enable(false)
  service.policyChanged()
  await pending
  h.enable()
  await service.tick(now)
  assert.equal(first.compactNow.mock.callCount(), 1)
  assert.equal(second.compactNow.mock.callCount(), 1)
})

test('closes an unfinished durable task after restart and leaves original session bindings in place', async t => {
  const h = fixture(t)
  h.enable()
  const mobile = h.add()
  mobile.approve()
  const task = h.store.createTask({ externalId: `${CONTEXT_COMPACTION_CAPABILITY}:${mobile.sessionId}:3`, capabilityId: CONTEXT_COMPACTION_CAPABILITY, title: 'interrupted' })
  h.store.transitionTask(task.id, 'running')
  const service = h.service()
  service.start()
  await service.tick(now)
  assert.equal(h.store.taskById(task.id).status, 'cancelled')
  assert.equal(h.store.bindingByContext('chat.mobile').sessionId, mobile.sessionId)
  assert.equal(mobile.compactNow.mock.callCount(), 0)
})
