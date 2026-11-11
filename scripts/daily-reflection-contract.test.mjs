import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CAMP_VISIT_SUPPLY_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { BILIBILI_AUTONOMY_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { companionToolPolicy, isCompanionDecisionContext } from '../src/host/tool-policy.ts'

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/daily-reflection-contract-')
  const path = join(directory, 'companion.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true }) })
  return { store, path, notes: store.selfNotes }
}

function review(store, kind = 'survey', { run = true } = {}) {
  const key = randomUUID()
  const sessionId = 'reflection-' + key
  const receipt = kind === 'survey' ? { receiptTaskId: randomUUID() } : { activityId: 37 }
  const activity = store.autonomy.create({ kind: kind === 'survey' ? 'minecraft.supply' : 'bilibili.review',
    contextId: kind === 'survey' ? MINECRAFT_SUPPLY_CONTEXT : BILIBILI_AUTONOMY_CONTEXT,
    dedupeKey: `activity:${key}`, runAfter: Date.now(), payload: receipt })
  store.transitionTask(activity.id, 'running')
  store.transitionTask(activity.id, 'succeeded')
  const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: `daily:${key}`,
    runAfter: Date.now(), payload: { choice: kind, activityTaskId: activity.id } })
  store.transitionTask(daily.id, 'running')
  store.transitionTask(daily.id, 'succeeded')
  const job = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT, dedupeKey: `reflect:${key}`,
    runAfter: Date.now(), payload: { dailyTaskId: daily.id } })
  if (run) store.transitionTask(job.id, 'running')
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  const note = {
    content: '我想把观察和判断分开，等确认后再做决定。', basis: 'inference', createdBy: 'companion',
    trait: 'check-evidence', evidence: ['我想把观察和判断分开。'],
    evidenceRefs: [{ quoteIndex: 0, messageId: `reflection-message-${key}`, role: 'assistant' }],
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, sessionId, taskId: job.id, eventSeq: 8 }], actorSessionId: sessionId,
    experience: { kind, dailyTaskId: daily.id, activityTaskId: activity.id, ...receipt },
  }
  return { activity, daily, job, note }
}

test('reflection is off by default and its setting persists without overwriting existing autonomy', t => {
  const { store, path } = fixture(t)
  assert.equal(store.autonomy.settings().dailyReflectionEnabled, false)
  store.autonomy.saveSettings({ ...store.autonomy.settings(), dailyReflectionEnabled: true, feedEnabled: true })
  const reopened = new CompanionStore(path)
  try {
    assert.equal(reopened.autonomy.settings().dailyReflectionEnabled, true)
    assert.equal(reopened.autonomy.settings().feedEnabled, true)
  } finally { reopened.close() }
})

test('survey provenance and assistant references are both retained in history and after reopen', t => {
  const { store, notes, path } = fixture(t)
  const { daily, note } = review(store)
  const saved = notes.create(note)
  assert.deepEqual(saved.experience, note.experience)
  assert.deepEqual(saved.sourceRefs, note.sourceRefs)
  assert.deepEqual(saved.evidenceRefs, note.evidenceRefs)
  assert.deepEqual(notes.revisions(saved.id)[0].snapshot.experience, note.experience)
  const reopened = new CompanionStore(path)
  try { assert.deepEqual(reopened.selfNotes.byDailyExperience(daily.id), saved) }
  finally { reopened.close() }
})

test('both connector variants require exact child and receipt identifiers', t => {
  const { store, notes } = fixture(t)
  for (const kind of ['survey', 'bilibili']) {
    const { note } = review(store, kind)
    assert.throws(() => notes.create({ ...note, experience: { ...note.experience, activityTaskId: randomUUID() } }), /self-note-invalid-evidence/u)
    const altered = kind === 'survey' ? { receiptTaskId: randomUUID() } : { activityId: 38 }
    assert.throws(() => notes.create({ ...note, experience: { ...note.experience, ...altered } }), /self-note-invalid-evidence/u)
    assert.throws(() => notes.create({ ...note, experience: { ...note.experience, dailyTaskId: randomUUID() } }), /self-note-invalid-evidence/u)
    assert.deepEqual(notes.create({ ...note, content: `${note.content} 这次来源为 ${kind}。` }).experience, note.experience)
  }
})

test('a short-visit supply note requires verified offline status, the exact craft task and matching inventory deltas', t => {
  const { store, notes, path } = fixture(t)
  const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:2026-11-09',
    runAfter: Date.now() })
  store.transitionTask(daily.id, 'running')
  const craft = store.createTask({ capabilityId: 'minecraft.craft', contextId: 'game.minecraft', title: 'craft',
    externalId: CAMP_VISIT_SUPPLY_TASK_PREFIX + daily.id })
  store.transitionTask(craft.id, 'running')
  store.transitionTask(craft.id, 'succeeded')
  const receipt = { crafted: true, name: 'oak_planks', count: 4, consumedLogs: 1,
    inventory: { logsBefore: 3, logsAfter: 2, planksBefore: 1, planksAfter: 5 } }
  const supplyPayload = { zoneId: randomUUID(), goal: 'planks', expiresAt: Date.now() + 60_000,
    visitId: daily.id, visitSupply: receipt, receiptTaskId: craft.id }
  const supply = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
    dedupeKey: `visit-supply:${daily.id}`, runAfter: Date.now(), payload: supplyPayload })
  store.transitionTask(supply.id, 'running')
  store.transitionTask(supply.id, 'succeeded')
  const dailyPayload = { choice: 'supply', activityTaskId: supply.id, visitId: daily.id, visitJoined: true, visitStatus: 'offline' }
  store.autonomy.update(daily.id, { payload: dailyPayload })
  store.transitionTask(daily.id, 'succeeded')
  const reviewJob = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT,
    dedupeKey: `reflect:${daily.id}`, runAfter: Date.now(), payload: { dailyTaskId: daily.id } })
  store.transitionTask(reviewJob.id, 'running')
  const sessionId = 'reflection-supply'
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  const note = {
    content: '我想保留一些原木，等需要时再补给。', basis: 'inference', createdBy: 'companion', actorSessionId: sessionId,
    evidence: ['我想保留一些原木。'], evidenceRefs: [{ quoteIndex: 0, messageId: 'reflection-supply-message', role: 'assistant' }],
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, sessionId, taskId: reviewJob.id, eventSeq: 8 }],
    experience: { kind: 'supply', dailyTaskId: daily.id, activityTaskId: supply.id, receiptTaskId: craft.id },
  }
  for (const change of [{ visitStatus: 'unconfirmed' }, { visitJoined: false }, { visitId: randomUUID() }]) {
    store.autonomy.update(daily.id, { payload: { ...dailyPayload, ...change } })
    assert.throws(() => notes.create(note), /self-note-invalid-evidence/u)
  }
  store.autonomy.update(daily.id, { payload: dailyPayload })
  store.autonomy.update(supply.id, { payload: { ...supplyPayload, visitSupply: { ...receipt, inventory: { ...receipt.inventory, logsAfter: 1 } } } })
  assert.throws(() => notes.create(note), /self-note-invalid-evidence/u)
  store.autonomy.update(supply.id, { payload: supplyPayload })
  assert.throws(() => notes.create({ ...note, experience: { ...note.experience, receiptTaskId: randomUUID() } }), /self-note-invalid-evidence/u)
  const saved = notes.create(note)
  assert.deepEqual(saved.experience, note.experience)
  assert.deepEqual(notes.revisions(saved.id)[0].snapshot.experience, note.experience)
  const reopened = new CompanionStore(path)
  try { assert.deepEqual(reopened.selfNotes.byDailyExperience(daily.id)?.experience, note.experience) }
  finally { reopened.close() }
})

test('an exact persisted activity event can be retrieved without falling back to a recent activity', t => {
  const { store } = fixture(t)
  const id = store.recordActivity({ eventId: 'minecraft-visit:supply:exact', contextId: 'game.minecraft',
    source: 'game.minecraft', kind: 'world.visit-supply', summary: '短访补给回执', status: 'success', data: { count: 4 } })
  store.recordActivity({ source: 'game.minecraft', kind: 'world.visit-supply', summary: '相邻记录', status: 'success' })
  assert.equal(store.activityByEventId('minecraft-visit:supply:exact')?.id, id)
  assert.deepEqual(store.activityByEventId('minecraft-visit:supply:exact')?.data, { count: 4 })
  assert.equal(store.activityByEventId('missing-event'), undefined)
})

test('only an inference from the current bound companion session can cite an experience', t => {
  const { store, notes } = fixture(t)
  const { note } = review(store)
  assert.throws(() => notes.create({ ...note, createdBy: 'owner' }), /self-note-author-protected/u)
  for (const altered of [
    { basis: 'observation' },
    { experience: undefined },
    { actorSessionId: 'wrong-actor' },
    { sourceRefs: [{ ...note.sourceRefs[0], contextId: 'chat.mobile' }], actorSessionId: undefined },
    { sourceRefs: [{ ...note.sourceRefs[0], eventSeq: undefined }] },
    { sourceRefs: [{ ...note.sourceRefs[0], taskId: randomUUID() }] },
    { evidence: ['助手写的这句足够长。', '主人的这句足够长。'],
      evidenceRefs: [...note.evidenceRefs, { quoteIndex: 1, messageId: 'owner-text', role: 'user' }] },
  ]) assert.throws(() => notes.create({ ...note, ...altered }), /self-note-invalid-evidence/u)
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId: 'replaced', label: '新的会话' })
  assert.throws(() => notes.create(note), /self-note-invalid-evidence/u)
  assert.deepEqual(notes.list(), [])
})

test('accepted or ended review cannot write a new note', t => {
  const { store, notes } = fixture(t)
  const { note, job } = review(store, 'bilibili', { run: false })
  assert.throws(() => notes.create(note), /self-note-invalid-evidence/u)
  store.transitionTask(job.id, 'running')
  store.transitionTask(job.id, 'cancelled')
  assert.throws(() => notes.create(note), /self-note-invalid-evidence/u)
  assert.deepEqual(notes.list(), [])
})

test('same daily task stays idempotent after archive and cannot overwrite a character note', t => {
  const { store, notes } = fixture(t)
  const { daily, note } = review(store)
  const saved = notes.create(note)
  const archived = notes.update(saved.id, { status: 'archived' })
  assert.equal(notes.create({ ...note, content: '一次迟来的不同决定也不能重新写入。' }).id, saved.id)
  assert.deepEqual(notes.byDailyExperience(daily.id), archived)
  assert.throws(() => notes.update(saved.id, { content: '从外部替换笔记' }), /self-note-author-protected/u)
  assert.equal(notes.list({ status: 'all' }).length, 1)
})

test('new experience can extend an older reflection while preserving both receipts', t => {
  const { store, notes } = fixture(t)
  const first = notes.create(review(store).note)
  const { note } = review(store, 'bilibili')
  const second = notes.create({ ...note, content: '我会耐心把两次不确定的判断放在一起比较。', supersedes: first.id })
  assert.equal(notes.get(first.id).status, 'archived')
  assert.deepEqual(notes.get(first.id).experience, first.experience)
  assert.equal(second.supersedes, first.id)
  assert.equal(notes.recallCandidates('chat.mobile').find(item => item.id === second.id)?.trait, 'check-evidence')
  assert.ok(!notes.recallCandidates('chat.mobile').some(item => item.id === first.id))
})

test('open reflection query finds accepted and running rows without a recent-list cutoff', t => {
  const { store } = fixture(t)
  const pending = review(store, 'survey', { run: false }).job
  const running = review(store).job
  const closed = review(store).job
  store.transitionTask(closed.id, 'cancelled')
  for (let index = 0; index < 60; index++) {
    store.autonomy.create({ kind: 'memory.review', contextId: 'chat.mobile', dedupeKey: `other:${index}`, runAfter: Date.now() })
  }
  assert.deepEqual(store.autonomy.open('daily.reflect', DAILY_REFLECTION_CONTEXT).map(item => item.id).sort(), [pending.id, running.id].sort())
})

test('idle query uses genuine foreground timestamps and exact receipt lookup ignores pagination', t => {
  const { store } = fixture(t)
  const now = Date.now()
  const event = (contextId, source, kind, age) => store.recordActivity({ contextId, sessionId: 'actual-session', source, kind,
    summary: '受控测试事件', occurredAt: new Date(now - age).toISOString() })
  const expected = event('chat.mobile', 'core.session', 'turn.completed', 90_000)
  event('game.minecraft', 'core.chat', 'message.accepted', 120_000)
  for (const contextId of [DAILY_REFLECTION_CONTEXT, DAILY_AUTONOMY_CONTEXT, 'memory.curator', 'feed.reply.thread']) {
    event(contextId, 'core.session', 'turn.started', 3_000)
  }
  event('world.bilibili', 'core.session', 'assistant.completed', 3_000)
  event('chat.mobile', 'core.chat', 'message.accepted', -60_000)
  assert.equal(store.latestForegroundActivityAt(now - 180_000), now - 90_000)
  assert.equal(store.latestForegroundActivityAt(now - 30_000), undefined)
  assert.equal(store.activityById(expected).kind, 'turn.completed')
  assert.equal(store.activityById(-1), undefined)
})

test('a mistyped topic binding still provides no tools to the private reflection scene', () => {
  assert.equal(isCompanionDecisionContext(DAILY_REFLECTION_CONTEXT), true)
  for (const kind of ['system', 'topic']) {
    const policy = companionToolPolicy(DAILY_REFLECTION_CONTEXT, kind)
    assert.equal(policy.profile, 'daily-reflection')
    assert.deepEqual(policy.allowed, [])
    assert.ok(policy.denied.includes('companion_memory_remember'))
  }
})
