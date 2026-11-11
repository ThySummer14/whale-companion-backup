import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CAMP_VISIT_BUILD_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

function fixture(t) {
  const work = resolve('.work')
  mkdirSync(work, { recursive: true })
  const directory = mkdtempSync(join(work, 'self-note-authorship-'))
  const path = join(directory, 'companion.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true }) })
  return { store, path, notes: store.selfNotes }
}

const owner = content => ({ content, basis: 'user-feedback', createdBy: 'owner' })
const character = (content, overrides = {}) => ({
  content, basis: 'inference', createdBy: 'companion', evidence: ['信息不足的时候，我先问清楚。'],
  sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'source-phone' }],
  evidenceRefs: [{ quoteIndex: 0, messageId: 'source-assistant', role: 'assistant' }],
  ...overrides,
})

test('building self-notes require an offline visit and the exact verified in-game build receipt', t => {
  const { store, notes, path } = fixture(t)
  const now = Date.now()
  const visitExpiresAt = now + 60_000
  const expiresAt = visitExpiresAt + 60_000
  const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT,
    dedupeKey: 'daily:2026-11-10', runAfter: now })
  store.transitionTask(daily.id, 'running')
  const zoneId = randomUUID()
  const visitBuild = { built: true, zoneId, material: 'oak_planks', placedFloor: 8, placedTable: 1,
    inventory: { floorBefore: 12, floorAfter: 4, tablesBefore: 2, tablesAfter: 1 } }
  const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
    dedupeKey: `visit-build:${daily.id}`, runAfter: now })
  store.transitionTask(child.id, 'running')
  const game = store.createTask({ capabilityId: 'minecraft.build', contextId: 'game.minecraft', title: '搭建地板',
    externalId: CAMP_VISIT_BUILD_TASK_PREFIX + daily.id })
  store.transitionTask(game.id, 'running')
  store.transitionTask(game.id, 'succeeded')
  const childPayload = { campZoneId: zoneId, expiresAt: visitExpiresAt, goal: 'camp', visitId: daily.id,
    visitBuild, receiptTaskId: game.id }
  store.autonomy.update(child.id, { payload: childPayload })
  store.transitionTask(child.id, 'succeeded')
  const dailyPayload = { choice: 'build', activityTaskId: child.id, visitId: daily.id, visitJoined: true,
    visitStatus: 'offline', visitExpiresAt, expiresAt }
  store.autonomy.update(daily.id, { payload: dailyPayload })
  store.transitionTask(daily.id, 'succeeded')
  const reflection = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT,
    dedupeKey: `reflect:${daily.id}`, runAfter: now, payload: { dailyTaskId: daily.id } })
  store.transitionTask(reflection.id, 'running')
  const sessionId = 'reflection-build'
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  const input = character('我想先数清木板，再动手建造。', {
    actorSessionId: sessionId,
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, sessionId, taskId: reflection.id, eventSeq: 3 }],
    experience: { kind: 'build', dailyTaskId: daily.id, activityTaskId: child.id, receiptTaskId: game.id },
  })
  for (const patch of [{ visitStatus: 'unconfirmed' }, { visitJoined: 1 }, { visitId: randomUUID() },
    { visitExpiresAt: expiresAt + 1 }, { visitExpiresAt: visitExpiresAt - 1 }]) {
    store.autonomy.update(daily.id, { payload: { ...dailyPayload, ...patch } })
    assert.throws(() => notes.create(input), /self-note-invalid-evidence/u)
  }
  store.autonomy.update(daily.id, { payload: dailyPayload })
  for (const patch of [{ visitId: randomUUID() }, { campZoneId: randomUUID() }, { receiptTaskId: randomUUID() },
    { visitBuild: { ...visitBuild, inventory: { ...visitBuild.inventory, floorAfter: 5 } } }]) {
    store.autonomy.update(child.id, { payload: { ...childPayload, ...patch } })
    assert.throws(() => notes.create(input), /self-note-invalid-evidence/u)
  }
  store.autonomy.update(child.id, { payload: childPayload })
  assert.throws(() => notes.create({ ...input, experience: { ...input.experience, receiptTaskId: randomUUID() } }), /self-note-invalid-evidence/u)
  const note = notes.create(input)
  assert.deepEqual(note.experience, input.experience)
  assert.deepEqual(notes.revisions(note.id)[0].snapshot.experience, input.experience)
  const reader = new CompanionStore(path)
  try { assert.deepEqual(reader.selfNotes.byDailyExperience(daily.id), note) }
  finally { reader.close() }
})

test('authorship persists and keeps companion text and evidence protected', t => {
  const { notes, path } = fixture(t)
  const input = character('遇到不确定的事，我通常先问。', { trait: 'ask-before-assuming' })
  const note = notes.create(input)
  assert.deepEqual(note.evidenceRefs, input.evidenceRefs)
  assert.equal(note.trait, input.trait)
  assert.equal(notes.revisions(note.id)[0].snapshot.trait, input.trait)
  for (const patch of [{ content: '伪造内容' }, { evidence: [] }, { confidence: 1 }, { counterEvidence: ['伪造反证'] }, {}]) {
    assert.throws(() => notes.update(note.id, patch), /self-note-author-protected/u)
  }
  assert.throws(() => notes.rollback(note.id, 1, '伪造回滚'), /self-note-author-protected/u)
  notes.update(note.id, { status: 'archived' })
  assert.deepEqual(notes.recallCandidates('chat.mobile'), [])
  const restored = notes.update(note.id, { status: 'active' })
  assert.equal(restored.content, note.content)
  assert.deepEqual(restored.evidenceRefs, note.evidenceRefs)

  const reader = new CompanionStore(path)
  try { assert.deepEqual(reader.selfNotes.get(note.id), restored) }
  finally { reader.close() }
})

test('feedback is independently editable and cannot impersonate character authorship', t => {
  const { notes } = fixture(t)
  const label = '请把具体例子放在解释前面。'
  const feedback = notes.create(owner(label))
  const model = notes.create(character(label))
  assert.notEqual(model.id, feedback.id)
  assert.equal(notes.create(owner(label)).id, feedback.id)
  assert.equal(notes.create(character(label)).id, model.id)
  const game = notes.create(character(label, { sourceRefs: [{ contextId: 'game.minecraft', sessionId: 'game' }] }))
  assert.notEqual(game.id, model.id)
  assert.throws(() => notes.create({ ...owner('冒名'), trait: 'ask-before-assuming' }), /self-note-author-protected/u)
  notes.update(feedback.id, { content: '保留解释中的一个例子。' })
  const restored = notes.rollback(feedback.id, 1, '更正反馈')
  assert.equal(restored.content, label)
  assert.equal(restored.createdBy, 'owner')
  assert.deepEqual(notes.recallCandidates('chat.mobile').map(item => item.id), [model.id])
  assert.deepEqual(notes.recallCandidates('game.minecraft').map(item => item.id), [game.id])
})

test('portable traits and replacements require complete bounded source evidence', t => {
  const { notes } = fixture(t)
  const bad = [
    { evidenceRefs: undefined, trait: 'follow-through' },
    { evidenceRefs: [{ quoteIndex: 0, messageId: 'owner', role: 'user' }] },
    { evidenceRefs: [{ quoteIndex: 1, messageId: 'assistant', role: 'assistant' }] },
    { evidenceRefs: [{ quoteIndex: 0, messageId: ' assistant', role: 'assistant' }] },
    { evidence: ['太短'] },
    { sourceRefs: [{ contextId: 'chat.mobile' }] },
    { sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'mobile' }, { contextId: 'game.minecraft', sessionId: 'game' }] },
    { trait: 'unexpected-trait' },
  ]
  for (const overrides of bad) assert.throws(() => notes.create(character('无效来源', overrides)), /self-note-invalid-evidence/u)
  assert.deepEqual(notes.list(), [])
})

test('replacement archives only a same-scene active character note, keeps history and is idempotent', t => {
  const { notes } = fixture(t)
  const earlier = notes.create(character('我有时会先给个猜测。'))
  const fresh = [{ quoteIndex: 0, messageId: 'new-assistant', role: 'assistant' }]
  const input = character('我倾向于先问清楚，再回应具体情况。', { supersedes: earlier.id, evidenceRefs: fresh })
  const feedback = notes.create(owner('给主人反馈的例子'))
  assert.throws(() => notes.create({ ...input, supersedes: feedback.id }), /self-note-invalid-supersession/u)
  assert.throws(() => notes.create({ ...input, sourceRefs: [{ contextId: 'game.minecraft', sessionId: 'game' }] }), /self-note-invalid-supersession/u)
  assert.throws(() => notes.create({ ...input, evidenceRefs: character('').evidenceRefs }), /self-note-invalid-supersession/u)
  assert.equal(notes.create({ ...input, content: earlier.content }).id, earlier.id)
  assert.equal(notes.get(earlier.id).status, 'active')
  const successor = notes.create(input)
  assert.equal(successor.supersedes, earlier.id)
  assert.equal(notes.get(earlier.id).status, 'archived')
  assert.equal(notes.revisions(earlier.id).at(-1).snapshot.content, earlier.content)
  assert.equal(notes.create(input).id, successor.id)
  assert.deepEqual(notes.recallCandidates('chat.mobile').map(note => note.id), [successor.id])
  notes.update(successor.id, { status: 'archived' })
  assert.throws(() => notes.update(earlier.id, { status: 'active' }), /self-note-superseded/u)
})

test('a failed successor transaction preserves the original observation and revision', t => {
  const { store, notes } = fixture(t)
  const earlier = notes.create(character('当前做法'))
  const record = store.recordActivity.bind(store)
  t.mock.method(store, 'recordActivity', input => {
    if (input.kind === 'self-note.created') throw new Error('simulated receipt failure')
    return record(input)
  })
  assert.throws(() => notes.create(character('调整后的做法', {
    supersedes: earlier.id, evidenceRefs: [{ quoteIndex: 0, messageId: 'new-assistant', role: 'assistant' }],
  })), /simulated receipt failure/u)
  assert.deepEqual(notes.list({ status: 'all' }).map(item => item.id), [earlier.id])
  assert.equal(notes.get(earlier.id).status, 'active')
  assert.equal(notes.revisions(earlier.id).length, 1)
})

test('legacy recall uses the original revision and cross-scene eligibility requires a verified trait', t => {
  const { notes, path } = fixture(t)
  const legacy = notes.create(character('原来的真实观察', { evidenceRefs: undefined }))
  const portable = notes.create(character('应只在原场景显示的私人观察', { trait: 'check-evidence' }))
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE self_note SET content=? WHERE id=?').run('旧版允许主人改过的内容', legacy.id) }
  finally { db.close() }
  const mobile = notes.recallCandidates('chat.mobile')
  assert.equal(mobile.find(note => note.id === legacy.id).content, '原来的真实观察')
  assert.equal(notes.get(legacy.id).content, '旧版允许主人改过的内容')
  assert.deepEqual(notes.recallCandidates('game.minecraft').map(note => ({ id: note.id, trait: note.trait })),
    [{ id: portable.id, trait: 'check-evidence' }])
})

test('the 40 active observations and 40 active feedback entries have independent limits', t => {
  const { notes } = fixture(t)
  const firstObservation = notes.create(character('最早的观察'))
  const firstFeedback = notes.create(owner('最早的反馈'))
  for (let i = 0; i < 40; i++) notes.create(owner(`反馈 ${i}`))
  assert.equal(notes.get(firstObservation.id).status, 'active')
  assert.equal(notes.get(firstFeedback.id).status, 'archived')
  for (let i = 0; i < 40; i++) notes.create(character(`角色观察 ${i}`))
  assert.equal(notes.get(firstObservation.id).status, 'archived')
  assert.deepEqual(notes.counts(), { active: 80, archived: 2, companionActive: 40, ownerActive: 40 })
  assert.equal(notes.recallCandidates('chat.mobile').length, 40)
  assert.equal(notes.update(firstObservation.id, { status: 'active' }).status, 'active')
  assert.deepEqual(notes.counts(), { active: 80, archived: 2, companionActive: 40, ownerActive: 40 })
})
