import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { SessionService } from '../src/host/session.ts'

const CONTEXT = 'chat.mobile'
const SESSION = 'phone-source'
const CURATOR = 'memory.curator'
const TURN = 12
const user = { id: 'user-1', role: 'user', text: '我希望下雨的时候也可以去港口。' }
const assistant = { id: 'assistant-1', role: 'assistant', text: '我会先问你需要怎样的帮助，再开始行动。' }
const empty = { memories: [], selfNotes: [] }
const candidate = { kind: 'experience', content: '她在谈到港口时先询问需要怎样的帮助。', scope: 'shared' }
const selfNote = { content: '我习惯先问对方需要怎样的帮助。', evidence: ['先问你需要怎样的帮助'], confidence: 1 }

function fixture(t, retention) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 12) })
  const root = resolve('.work')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'memory-review-checkpoint-'))
  const path = join(directory, 'companion.sqlite')
  const store = new CompanionStore(path, retention)
  store.bindContext({ contextId: CONTEXT, sessionId: SESSION, label: '手机', kind: 'chat' })
  const snapshots = []
  const sent = []
  const released = []
  let curatorCount = 0
  let messages = [user, assistant]
  const sessions = {
    async create(input, replaceCurator) {
      assert.equal(replaceCurator, true)
      const previous = store.bindingByContext(input.contextId)
      const binding = store.bindContext({ ...input, sessionId: input.sessionId ?? `curator-session-${++curatorCount}` })
      if (previous) await this.release(previous.sessionId)
      return { binding }
    },
    async reviewSnapshot(contextId, sessionId, turnSeq, limit) {
      snapshots.push({ contextId, sessionId, turnSeq, limit })
      return { contextId, sessionId, messages }
    },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, sessionId: store.bindingByContext(contextId).sessionId, messageId: `input-${sent.length + 1}` }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel() {},
    async release(sessionId) { released.push(sessionId) },
  }
  const service = new AutonomyService(store, sessions)
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  function sourceTurn(seq = TURN) {
    service.observe(store.bindingByContext(CONTEXT), { type: 'turn/end', seq, data: { turn: seq, reason: { kind: 'completed' } } })
    return store.autonomy.pending('memory.review', CONTEXT)
  }
  async function run() {
    t.mock.timers.tick(90_001)
    service.wake()
    await setImmediate()
  }
  async function respond(result = empty, { inputId = sent.at(-1).receipt.messageId, extra = false } = {}) {
    const binding = store.bindingByContext(CURATOR)
    const turn = sent.length
    service.observe(binding, { type: 'turn/start', data: { turn } })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id: inputId, source: { kind: 'user' } } })
    const answer = { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: JSON.stringify(result) }] } } }
    service.observe(binding, answer)
    if (extra) service.observe(binding, answer)
    service.observe(binding, { type: 'turn/end', seq: 99, data: { turn, reason: { kind: 'completed' } } })
    await setImmediate()
  }
  return { store, service, path, sessions, snapshots, sent, released, sourceTurn, run, respond, replace: value => { messages = value } }
}

test('valid empty review certifies only the exact turn after restart and without activity history', async t => {
  const h = fixture(t, 1)
  const job = h.sourceTurn()
  await h.run()
  await h.respond()
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), true)
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN + 1), false)
  assert.equal(h.service.memoryReviewed(CONTEXT, 'different-source', TURN), false)
  assert.equal(h.store.activities().some(activity => activity.kind === 'memory.reviewed'), false)
  assert.equal(h.sourceTurn(), undefined)
  const reopened = new CompanionStore(h.path)
  try {
    const service = new AutonomyService(reopened, h.sessions)
    assert.equal(service.memoryReviewed(CONTEXT, SESSION, TURN), true)
    assert.deepEqual(reopened.memory.list({ status: 'all' }), [])
  } finally { reopened.close() }
})

test('candidates and self notes commit with exact snapshot sources, and private prompt data stays scoped', async t => {
  const h = fixture(t)
  h.store.memory.create({ contextId: 'game.minecraft', kind: 'preference', content: '港口 SECRET_OTHER_CANDIDATE', scope: 'shared', status: 'candidate' })
  h.store.selfNotes.create({ content: 'SECRET_OTHER_NOTE', basis: 'inference', evidence: [], sourceRefs: [{ contextId: 'game.minecraft' }], createdBy: 'companion' })
  const job = h.sourceTurn()
  await h.run()
  assert.deepEqual(h.snapshots, [{ contextId: CONTEXT, sessionId: SESSION, turnSeq: TURN, limit: 6 }])
  assert.match(h.sent[0].prompt, /先问你需要怎样的帮助/u)
  assert.doesNotMatch(h.sent[0].prompt, /SECRET_OTHER_/u)
  await h.respond({ memories: [candidate], selfNotes: [selfNote] })
  const sources = [{ contextId: CONTEXT, sessionId: SESSION, taskId: job.id, eventSeq: TURN }]
  const memory = h.store.memory.list({ status: 'candidate' }).find(item => item.content === candidate.content)
  assert.equal(memory.scope, 'context')
  assert.deepEqual(memory.sourceRefs, sources)
  const note = h.store.selfNotes.list().find(item => item.content === selfNote.content)
  assert.equal(note.confidence, 0.79)
  assert.deepEqual(note.sourceRefs, sources)
  assert.deepEqual(note.evidenceRefs, [{ quoteIndex: 0, messageId: assistant.id, role: 'assistant' }])
  const receipt = h.store.activities().find(activity => activity.kind === 'memory.reviewed')
  assert.deepEqual(receipt.data, { turnSeq: TURN, candidates: 1, selfNotes: 1 })
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), true)
})

test('wrong curator input or multiple responses cannot certify a turn', async t => {
  for (const [name, opts] of [['unrelated input', { inputId: 'unrelated-input' }], ['multiple replies', { extra: true }]]) {
    await t.test(name, async t => {
      const h = fixture(t)
      h.sourceTurn()
      await h.run()
      await h.respond({ memories: [candidate] }, opts)
      assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
      assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
    })
  }
})

test('role evidence must be a single verbatim quote from the same frozen snapshot', async t => {
  const h = fixture(t)
  h.sourceTurn()
  await h.run()
  h.replace([{ ...assistant, text: '一条仅在整理开始后才出现的内容。' }])
  await h.respond({ memories: [candidate], selfNotes: [{ ...selfNote, evidence: ['我希望下雨的时候', '一条仅在整理开始后才出现的内容'] }] })
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
  assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
  assert.ok(h.store.activities().some(activity => activity.kind === 'self-note.rejected'))
})

test('each distinct quote stores the exact message and prefers the latest matching assistant expression', async t => {
  const h = fixture(t)
  const assistantQuote = selfNote.evidence[0]
  const userQuote = '我希望下雨的时候'
  const originalUser = { ...user, text: `${user.text}${assistantQuote}` }
  const latestAssistant = { ...assistant, id: 'assistant-2' }
  h.replace([originalUser, assistant, latestAssistant])
  const job = h.sourceTurn()
  await h.run()
  assert.match(h.sent[0].prompt, /ask-before-assuming/u)
  assert.match(h.sent[0].prompt, /原话留在当前场景/u)
  await h.respond({ selfNotes: [{ ...selfNote, evidence: [userQuote, assistantQuote, assistantQuote], trait: 'ask-before-assuming' }], memories: [] })
  const note = h.store.selfNotes.list()[0]
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
  assert.equal(note.trait, 'ask-before-assuming')
  assert.deepEqual(note.evidence, [userQuote, assistantQuote])
  assert.deepEqual(note.evidenceRefs, [
    { quoteIndex: 0, messageId: user.id, role: 'user' },
    { quoteIndex: 1, messageId: latestAssistant.id, role: 'assistant' },
  ])
  const next = h.sourceTurn(TURN + 1)
  await h.run()
  await h.respond({ selfNotes: [{ ...selfNote, trait: 'ask-before-assuming' }], memories: [] })
  assert.equal(h.store.selfNotes.list().length, 1)
  assert.equal(h.store.activities().find(activity => activity.kind === 'memory.reviewed' && activity.taskId === next.id).data.selfNotes, 0)
})

test('new evidence supersedes a note offered for this scene while retaining the predecessor', async t => {
  const h = fixture(t)
  h.sourceTurn()
  await h.run()
  await h.respond({ selfNotes: [selfNote], memories: [] })
  const predecessor = h.store.selfNotes.list()[0]

  const nextAssistant = { ...assistant, id: 'assistant-followup', text: '我先核对你说的位置，再决定往哪里走。' }
  h.replace([user, nextAssistant])
  const next = h.sourceTurn(TURN + 1)
  await h.run()
  assert.match(h.sent.at(-1).prompt, new RegExp(predecessor.id, 'u'))
  const content = '我在行动前会确认信息来自哪里。'
  await h.respond({ memories: [], selfNotes: [{ content, evidence: ['我先核对你说的位置'], trait: 'check-evidence', supersedes: predecessor.id }] })
  const saved = h.store.selfNotes.list()[0]
  assert.equal(h.store.taskById(next.id).status, 'succeeded')
  assert.equal(saved.content, content)
  assert.equal(saved.trait, 'check-evidence')
  assert.equal(saved.supersedes, predecessor.id)
  assert.deepEqual(saved.evidenceRefs, [{ quoteIndex: 0, messageId: nextAssistant.id, role: 'assistant' }])
  assert.equal(h.store.selfNotes.get(predecessor.id).status, 'archived')
  assert.equal(h.store.selfNotes.get(predecessor.id).content, predecessor.content)
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN + 1), true)
})

test('unoffered or stale notes and reused assistant messages cannot be superseded', async t => {
  for (const mode of ['another scene', 'owner feedback', 'arrived after prompt', 'archived after prompt', 'old assistant message']) {
    await t.test(mode, async t => {
      const h = fixture(t)
      const seed = () => h.store.selfNotes.create({
        content: '先问清楚需要什么帮助。', basis: 'inference', evidence: selfNote.evidence,
        createdBy: 'companion', sourceRefs: [{ contextId: mode === 'another scene' ? 'game.minecraft' : CONTEXT, sessionId: SESSION }],
        evidenceRefs: [{ quoteIndex: 0, messageId: assistant.id, role: 'assistant' }], actorSessionId: 'fixture-curator',
      })
      let predecessor = mode === 'owner feedback'
        ? h.store.selfNotes.create({ content: '请优先确认问题。', basis: 'user-feedback', createdBy: 'owner' })
        : mode !== 'arrived after prompt' ? seed() : undefined
      if (mode !== 'old assistant message') h.replace([user, { ...assistant, id: 'assistant-2' }])
      h.sourceTurn()
      await h.run()
      predecessor ??= seed()
      if (mode === 'archived after prompt') h.store.selfNotes.update(predecessor.id, { status: 'archived' })
      const prompt = h.sent[0].prompt
      assert.equal(prompt.includes(predecessor.id), ['archived after prompt', 'old assistant message'].includes(mode))
      await h.respond({ memories: [candidate], selfNotes: [{ ...selfNote, supersedes: predecessor.id }] })
      assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
      assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
      assert.equal(h.store.selfNotes.list({ status: 'all' }).length, 1)
      assert.equal(h.store.selfNotes.get(predecessor.id).status, mode === 'archived after prompt' ? 'archived' : 'active')
      assert.ok(h.store.activities().some(activity => activity.kind === 'self-note.rejected'))
    })
  }
})

test('a user-only quotation or unsupported portable trait cannot create a note', async t => {
  for (const proposed of [{ ...selfNote, evidence: ['我希望下雨的时候'] }, { ...selfNote, trait: 'injected-custom-label' }]) {
    await t.test(proposed.trait ?? 'user-only evidence', async t => {
      const h = fixture(t)
      h.sourceTurn()
      await h.run()
      await h.respond({ memories: [candidate], selfNotes: [proposed] })
      assert.deepEqual(h.store.selfNotes.list(), [])
      assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
      assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
    })
  }
})

test('new source turn supersedes an in-flight review and the queued input is not downgraded by a manual request', async t => {
  const h = fixture(t)
  const first = h.sourceTurn()
  await h.run()
  const refreshed = h.sourceTurn(TURN + 1)
  assert.equal(refreshed.id, first.id)
  assert.equal(h.service.scheduleMemory(CONTEXT).payload.triggerSeq, TURN + 1)
  await h.respond({ memories: [candidate] })
  assert.equal(h.store.taskById(first.id).status, 'accepted')
  assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
  await h.run()
  assert.deepEqual(h.snapshots.map(item => item.turnSeq), [TURN, TURN + 1])
  assert.deepEqual(h.released, ['curator-session-1'])
  assert.notEqual(h.sent[0].receipt.sessionId, h.sent[1].receipt.sessionId)
  await h.respond()
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN + 1), true)
})

test('rebinding a source rejects old results and allows the same local event sequence for the new session', async t => {
  const h = fixture(t)
  const first = h.sourceTurn()
  await h.run()
  h.store.bindContext({ contextId: CONTEXT, sessionId: 'new-source', label: '手机', kind: 'chat' })
  await h.respond({ memories: [candidate] })
  assert.equal(h.store.taskById(first.id).status, 'cancelled')
  assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
  const second = h.sourceTurn()
  assert.notEqual(second.id, first.id)
  await h.run()
  await h.respond()
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
  assert.equal(h.service.memoryReviewed(CONTEXT, 'new-source', TURN), true)
})

test('a self-note store error rolls back earlier candidate writes and the checkpoint', async t => {
  const h = fixture(t)
  const job = h.sourceTurn()
  await h.run()
  t.mock.method(h.store.selfNotes, 'create', () => { throw new Error('simulated note failure') })
  await h.respond({ memories: [candidate], selfNotes: [selfNote] })
  assert.equal(h.store.taskById(job.id).status, 'accepted')
  assert.deepEqual(h.store.memory.list({ status: 'all' }), [])
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
})

test('manual review without a completed-turn source does not certify any specific turn', async t => {
  const h = fixture(t)
  const job = h.service.scheduleMemory(CONTEXT)
  await h.run()
  await h.respond()
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
  assert.equal(h.snapshots[0].turnSeq, undefined)
  assert.equal(h.service.memoryReviewed(CONTEXT, SESSION, TURN), false)
})

test('fresh curator swaps only after successful creation and then releases the old live handle', async t => {
  const h = fixture(t)
  const disposed = []
  let fail = false
  const context = {
    agentDefaultModel: { currentSelection: () => ({}) },
    agents: {
      get: () => undefined,
      async create({ sessionId }) {
        if (fail) throw new Error('simulated curator creation failure')
        return { async dispose() { disposed.push(sessionId) } }
      },
    },
  }
  const sessions = new SessionService(context, h.store, input => h.store.bindContext(input))
  t.after(() => sessions.close())
  const input = { contextId: CURATOR, kind: 'system', label: '长期记忆整理' }
  const first = await sessions.create(input, true)
  fail = true
  await assert.rejects(sessions.create(input, true), /simulated curator creation failure/u)
  assert.equal(h.store.bindingByContext(CURATOR).sessionId, first.binding.sessionId)
  assert.deepEqual(disposed, [])
  fail = false
  const second = await sessions.create(input, true)
  assert.notEqual(second.binding.sessionId, first.binding.sessionId)
  assert.equal(h.store.bindingByContext(CURATOR).sessionId, second.binding.sessionId)
  assert.deepEqual(disposed, [first.binding.sessionId])
})
