import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionService } from '../src/host/session.ts'

const contextId = 'chat.mobile'
const append = { surfaceOp: 'append' }
const content = text => [{ type: 'text', text }]
const human = (session, text, source = { kind: 'user' }) => session.append('user/message', createUserMessage({ content: content(text), source }), append)
const assistant = (session, text, turn) => session.append('assistant/message', {
  turn, step: 1, message: createAssistantMessage({ content: content(text), source: { provider: 'test', model: 'test' } }), stream: [],
}, append)
const turnEnd = (session, turn, kind = 'completed') => session.append('turn/end', { turn, reason: { kind } })

function fixture(session) {
  let binding = { contextId, sessionId: session.id }
  const service = new SessionService({ agents: { get: id => id === session.id ? { id, session } : undefined } }, {
    bindingByContext: context => context === binding.contextId ? binding : undefined,
  }, () => {})
  return { service, rebind: sessionId => { binding = { contextId, sessionId } } }
}

test('review keeps the original ordered chat through one exact completed turn after model compaction', async () => {
  const session = Session.create(SessionId('phone'))
  const { service } = fixture(session)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('私有系统提示') }, append)
  const first = human(session, '早期原文', { kind: 'companion-mobile', form: 'relay' })
  const privateHint = human(session, '内部召回提示', { kind: 'companion-memory', form: 'recall' })
  const reply = assistant(session, '早期回复', 1)
  session.append('step/end', { turn: 1, step: 1 })
  const boundary = turnEnd(session, 1)
  const checkpoint = createUserMessage({ content: content('模型摘要'), source: { kind: 'compact-checkpoint', compactionId: 'compaction-1' } })
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: reply.seq }, sourceEventSeqs: [first.seq, privateHint.seq, reply.seq],
  })
  session.append('turn/start', { turn: 2 })
  const later = human(session, '后续原文')
  const incomplete = turnEnd(session, 2, 'interrupted')

  assert.ok(!session.deriveMessages().some(message => message.id === first.data.id))
  const snapshot = await service.reviewSnapshot(contextId, session.id, boundary.seq)
  assert.deepEqual(snapshot.messages, [
    { id: first.data.id, role: 'user', text: '早期原文' },
    { id: reply.data.message.id, role: 'assistant', text: '早期回复' },
  ])
  assert.deepEqual((await service.history(contextId, 2)).messages.map(item => item.id), [reply.data.message.id, later.data.id])
  for (const seq of [first.seq, incomplete.seq, session.seq, -1, 0.5]) {
    await assert.rejects(service.reviewSnapshot(contextId, session.id, seq), { code: 'review-source-turn-unavailable' })
  }
})

test('history retains fork lineage, while curator review stays within the currently bound session', async () => {
  const parent = Session.create(SessionId('parent'))
  parent.append('turn/start', { turn: 1 })
  human(parent, '继承自另一场景的原文')
  const inherited = turnEnd(parent, 1)
  const id = SessionId('fork')
  const child = Session.create(id, buildForkSeed(parent.snapshotEvents(), inherited.seq),
    { ...parent.header, id, isSeeded: true, parentSession: parent.id }, SessionLogOffset(Number(inherited.seq) + 1))
  child.append('turn/start', { turn: 2 })
  human(child, '子场景对话')
  const owned = turnEnd(child, 2)
  const { service, rebind } = fixture(child)

  assert.deepEqual((await service.history(contextId)).messages.map(item => item.text), ['继承自另一场景的原文', '子场景对话'])
  assert.deepEqual((await service.reviewSnapshot(contextId, child.id, owned.seq)).messages.map(item => item.text), ['子场景对话'])
  await assert.rejects(service.reviewSnapshot(contextId, child.id, inherited.seq), { code: 'review-source-turn-unavailable' })
  const review = service.reviewSnapshot(contextId, child.id, owned.seq)
  rebind('replacement')
  await assert.rejects(review, { code: 'binding-conflict' })
})

test('incremental curator review only reads new settled turns and preserves the original transcript', async () => {
  const session = Session.create(SessionId('incremental-review'))
  const { service } = fixture(session)
  session.append('turn/start', { turn: 1 })
  const original = human(session, '第一段已经整理过的原文')
  const previous = turnEnd(session, 1)
  session.append('turn/start', { turn: 2 })
  const current = human(session, '新近新增的原文')
  const latest = turnEnd(session, 2)
  assert.deepEqual((await service.reviewSnapshot(contextId, session.id, latest.seq, 6, previous.seq)).messages.map(item => item.id), [current.data.id])
  assert.deepEqual((await service.reviewSnapshot(contextId, session.id, latest.seq, 6, original.seq)).messages.map(item => item.id), [original.data.id, current.data.id])
  assert.deepEqual((await service.history(contextId)).messages.map(item => item.id), [original.data.id, current.data.id])
})
