import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY } from '../src/core/minecraft-house-project.ts'
import { dailyHouseProjectReflectionFact } from '../src/core/daily-house-project-proof.ts'
import { SelfNoteExperienceReceiptSchema } from '../src/core/self-note.ts'
import { CompanionStore } from '../src/core/store.ts'

const sessionId = 'journal-reflection-session'
const at = offset => new Date(Date.now() - 3_600_000 + offset).toISOString()

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync(join('.work', 'self-note-journal-'))
  const path = join(dir, 'companion.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  return { store, path }
}

function reflection(store, content, sourceReceipt) {
  const now = Date.now()
  const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT,
    dedupeKey: randomUUID(), runAfter: now })
  store.transitionTask(daily.id, 'running')
  const receiptTaskId = randomUUID()
  const activity = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
    dedupeKey: randomUUID(), runAfter: now, payload: { receiptTaskId } })
  store.transitionTask(activity.id, 'running')
  store.transitionTask(activity.id, 'succeeded')
  store.autonomy.update(daily.id, { payload: { choice: 'survey', activityTaskId: activity.id } })
  store.transitionTask(daily.id, 'succeeded')
  const payload = { dailyTaskId: daily.id, expiresAt: now + 60_000, ...(sourceReceipt && { sourceReceipt }) }
  const job = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT,
    dedupeKey: 'daily-reflection:' + daily.id, runAfter: now, payload })
  store.transitionTask(job.id, 'running')
  const ref = { quoteIndex: 0, messageId: 'reflection-' + job.id, role: 'assistant' }
  const note = { content, basis: 'inference', createdBy: 'companion', actorSessionId: sessionId,
    experience: { kind: 'survey', dailyTaskId: daily.id, activityTaskId: activity.id, receiptTaskId },
    ...(sourceReceipt && { experienceReceipt: sourceReceipt }), evidence: [content], evidenceRefs: [ref],
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, taskId: job.id, sessionId, eventSeq: 10 }] }
  return { job, payload, note, ref }
}

function revision(source, predecessor, revisionReason = '我看到原路返回有了新的回读。') {
  return { ...source.note, supersedes: predecessor.id, revisionReason,
    evidence: [source.note.content, revisionReason], evidenceRefs: [source.ref, { ...source.ref, quoteIndex: 1 }] }
}

test('reflection receipt must match the current managed payload and role', t => {
  const { store } = fixture(t)
  const receipt = { at: at(0), fact: '已确认检查点与回营。' }
  const { note, job, payload } = reflection(store, '我会核对路线和回营。', receipt)
  const reject = input => assert.throws(() => store.selfNotes.create(input), /self-note-invalid-evidence/u)
  for (const change of [
    { experienceReceipt: undefined }, { experienceReceipt: { ...receipt, fact: '伪造事实。' } },
    { experienceReceipt: { ...receipt, at: at(1) } }, { actorSessionId: undefined },
    { revisionReason: '这是普通观察却带了理由。' },
  ]) reject({ ...note, ...change })
  store.autonomy.update(job.id, { payload: { ...payload, expiresAt: Date.now() - 1 } })
  reject(note)
  store.autonomy.update(job.id, { payload })
  const saved = store.selfNotes.create(note)
  assert.deepEqual(saved.experienceReceipt, receipt)
  assert.equal(saved.revisionReason, undefined)
  assert.equal(store.activities().some(activity => activity.data.journalRevision === true), false)
  for (const invalid of [{ ...receipt, fact: '甲\n乙' }, { ...receipt, fact: '甲'.repeat(241) },
    { ...receipt, fact: '  ' }, { ...receipt, at: '2026-11-10' }]) assert.equal(SelfNoteExperienceReceiptSchema.safeParse(invalid).success, false)
})

test('a journal revision requires newer receipt, changed observation and two quotes in one assistant message', t => {
  const { store, path } = fixture(t)
  const initial = { at: at(0), fact: '第一次仅核对了出发路线。' }
  const next = { at: at(60_000), fact: '后来核对了回营与安全站位。' }
  const previousSource = reflection(store, '我会先查 Ａ 再行动。', initial)
  const previous = store.selfNotes.create(previousSource.note)
  store.transitionTask(previousSource.job.id, 'succeeded')
  const current = reflection(store, '我会先核对原路回程。', next)
  const input = revision(current, previous)
  const reject = (draft, code = /self-note-invalid-evidence/u) => assert.throws(() => store.selfNotes.create(draft), code)
  for (const change of [
    { revisionReason: undefined }, { revisionReason: '过短' },
    { evidence: [input.content, '另一条没有被提交的解释。'] },
    { evidence: ['不一致的本次观察。', input.revisionReason] },
    { evidenceRefs: [current.ref, { ...current.ref, quoteIndex: 1, messageId: 'different-assistant-message' }] },
    { evidenceRefs: [current.ref, { ...current.ref, quoteIndex: 1, role: 'user' }] },
  ]) reject({ ...input, ...change })
  const repeatedReason = '我会先核对原路回程！'
  reject({ ...input, revisionReason: repeatedReason, evidence: [input.content, repeatedReason] })
  const unchanged = '我会先查a再行动！'
  reject({ ...input, content: unchanged, evidence: [unchanged, input.revisionReason] }, /self-note-invalid-supersession/u)
  for (const olderAt of [initial.at, at(-60_000)]) {
    const oldReceipt = { ...next, at: olderAt }
    store.autonomy.update(current.job.id, { payload: { ...current.payload, sourceReceipt: oldReceipt } })
    reject({ ...input, experienceReceipt: oldReceipt }, /self-note-invalid-supersession/u)
  }
  store.autonomy.update(current.job.id, { payload: current.payload })
  assert.equal(store.selfNotes.get(previous.id).status, 'active')
  assert.equal(store.activities().some(activity => activity.data.journalRevision === true), false)
  const saved = store.selfNotes.create(input)
  assert.equal(store.selfNotes.create(input).id, saved.id)
  assert.deepEqual(saved.experienceReceipt, next)
  assert.equal(saved.revisionReason, input.revisionReason)
  assert.deepEqual(store.selfNotes.get(previous.id).experienceReceipt, initial)
  assert.equal(store.selfNotes.get(previous.id).status, 'archived')
  assert.throws(() => store.selfNotes.update(previous.id, { status: 'active' }), /self-note-superseded/u)
  assert.deepEqual(store.selfNotes.revisions(previous.id).map(entry => entry.snapshot.experienceReceipt), [initial, initial])
  assert.equal(store.selfNotes.revisions(saved.id)[0].snapshot.revisionReason, input.revisionReason)
  const entries = store.activities().filter(activity => activity.data.journalRevision === true)
  assert.equal(entries.length, 1)
  assert.deepEqual([entries[0].source, entries[0].kind, entries[0].status, entries[0].contextId, entries[0].sessionId, entries[0].data.noteId],
    ['core.self-note', 'self-note.created', 'success', DAILY_REFLECTION_CONTEXT, sessionId, saved.id])
  const reopened = new CompanionStore(path)
  try {
    assert.deepEqual(reopened.selfNotes.get(previous.id).experienceReceipt, initial)
    assert.deepEqual(reopened.selfNotes.get(saved.id), saved)
  } finally { reopened.close() }
})

test('legacy observations may be revised with new evidence and cannot replace a newer receipt without one', t => {
  const { store } = fixture(t)
  const legacySource = reflection(store, '我会直接沿走过的路线回营。')
  const legacy = store.selfNotes.create(legacySource.note)
  assert.equal(legacy.experienceReceipt, undefined)
  store.transitionTask(legacySource.job.id, 'succeeded')
  const next = reflection(store, '我会先核对回程再决定是否出发。', { at: at(60_000), fact: '服务端回读了回营位置。' })
  const saved = store.selfNotes.create(revision(next, legacy))
  assert.equal(store.selfNotes.get(legacy.id).status, 'archived')
  const oldJob = reflection(store, '我会照着旧路线继续行动。')
  assert.throws(() => store.selfNotes.create({ ...oldJob.note, supersedes: saved.id }), /self-note-invalid-supersession/u)
  assert.equal(store.selfNotes.get(saved.id).status, 'active')
})

function houseProjectReflection(store, now, placed = 2) {
  const zone = store.createBuildZone({ name: '施工地', dimension: 'minecraft:overworld', x: 0, y: 80, z: 0, radius: 8 })
  const layout = { width: 5, height: 4, depth: 5, blocks: 'o'.repeat(100) }
  const project = store.minecraftHouseProjects.create({ name: '双翼', zoneId: zone.id, sections: [
    { name: '西翼', offset: { x: -2, y: 0, z: 0 }, layout }, { name: '东翼', offset: { x: 3, y: 0, z: 0 }, layout },
  ] })
  const date = new Date(now).toISOString().slice(0, 10)
  const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: `daily:${date}`, runAfter: now })
  store.transitionTask(daily.id, 'running')
  const child = store.createTask({ contextId: 'game.minecraft', capabilityId: HOUSE_PROJECT_SECTION_CAPABILITY,
    externalId: DAILY_HOUSE_PROJECT_TASK_PREFIX + daily.id, title: '确认西翼续建' })
  assert.equal(store.minecraftHouseProjects.start(project.id, 0, child.id), true)
  store.transitionTask(child.id, 'running')
  const receipt = { built: true, zoneId: zone.id, checked: 100, placed, consumed: placed ? { oak_planks: placed } : {}, recovery: true }
  assert.equal(store.minecraftHouseProjects.finish(project.id, 0, child.id, { receipt }), true)
  store.transitionTask(child.id, 'succeeded')
  const activityId = store.recordActivity({ contextId: 'game.minecraft', taskId: child.id, source: 'game.minecraft',
    kind: 'world.house-project-section', summary: '分区已经核验', status: 'success',
    data: { ...receipt, dailyTaskId: daily.id, index: 0, projectId: project.id } })
  store.autonomy.update(daily.id, { payload: { windowRuleId: randomUUID(), date, expiresAt: now + 60_000, choice: 'house-project',
    initiativeAttempt: 'minecraft', activityTaskId: child.id, houseSection: { projectId: project.id, zoneId: zone.id,
      section: 0, deadline: now + 30_000, recovery: true },
    initiative: { goal: '我想核对并接续西翼的施工', option: 'house:1', evidence: { id: 'now-1', kind: 'current', text: '西翼通过预检' } },
    initiativeReceipt: { sessionId: 'private-initiative', eventSeq: 7, optionLabel: '西翼续建' },
  } })
  store.transitionTask(daily.id, 'succeeded')
  const sourceReceipt = { at: store.activityById(activityId).occurredAt, fact: dailyHouseProjectReflectionFact({ section: 0, receipt }) }
  const payload = { dailyTaskId: daily.id, expiresAt: now + 60_000, sourceReceipt }
  const job = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT,
    dedupeKey: `daily-reflection:${daily.id}`, runAfter: now, payload })
  const content = '我会把分区回执和整栋验收分开核对。'
  const note = { content, basis: 'inference', createdBy: 'companion', actorSessionId: sessionId,
    experience: { kind: 'house-project', dailyTaskId: daily.id, activityTaskId: child.id, activityId }, experienceReceipt: sourceReceipt,
    evidence: [content], evidenceRefs: [{ quoteIndex: 0, messageId: 'reflection-' + job.id, role: 'assistant' }],
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, taskId: job.id, sessionId, eventSeq: 10 }] }
  return { daily, job, note, payload, zone }
}

test('autonomous section notes independently verify the work receipt and private authorship', t => {
  const { store, path } = fixture(t)
  const { daily, job, note, payload, zone } = houseProjectReflection(store, Date.now())
  const reject = (change = {}) => assert.throws(() => store.selfNotes.create({ ...note, ...change }), /self-note-invalid-evidence/u)
  reject()
  store.transitionTask(job.id, 'running')
  reject({ experienceReceipt: undefined })
  reject({ actorSessionId: undefined })
  reject({ evidenceRefs: [{ ...note.evidenceRefs[0], role: 'user' }] })
  reject({ experience: { ...note.experience, activityId: note.experience.activityId + 1 } })
  reject({ experience: { ...note.experience, activityTaskId: randomUUID() } })
  reject({ sourceRefs: [{ ...note.sourceRefs[0], sessionId: 'different-session' }], actorSessionId: 'different-session' })
  reject({ sourceRefs: [{ ...note.sourceRefs[0], taskId: daily.id }] })
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'topic', sessionId, label: '错误场景' })
  reject()
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  for (const sourceReceipt of [
    { ...payload.sourceReceipt, fact: '整栋建筑已经竣工。' },
    { ...payload.sourceReceipt, at: new Date(Date.parse(payload.sourceReceipt.at) - 1000).toISOString() },
  ]) {
    store.autonomy.update(job.id, { payload: { ...payload, sourceReceipt } })
    reject({ experienceReceipt: sourceReceipt })
  }
  store.autonomy.update(job.id, { payload: { ...payload, expiresAt: Date.now() - 1 } })
  reject()
  store.autonomy.update(job.id, { payload })
  assert.equal(store.revokeBuildZone(zone.id), true)
  const saved = store.selfNotes.create(note)
  assert.deepEqual(saved.experience, note.experience)
  assert.deepEqual(saved.experienceReceipt, payload.sourceReceipt)
  assert.deepEqual(saved.evidence, note.evidence)
  assert.equal(store.selfNotes.create(note).id, saved.id)
  assert.deepEqual(store.selfNotes.revisions(saved.id)[0].snapshot.experience, note.experience)
  store.transitionTask(job.id, 'succeeded')
  reject()
  const reopened = new CompanionStore(path)
  try { assert.deepEqual(reopened.selfNotes.byDailyExperience(daily.id), saved) }
  finally { reopened.close() }
})

test('a no-op section receipt cannot be written as an autonomous construction observation', t => {
  const { store } = fixture(t)
  const { job, note } = houseProjectReflection(store, Date.now(), 0)
  store.transitionTask(job.id, 'running')
  assert.throws(() => store.selfNotes.create(note), /self-note-invalid-evidence/u)
  assert.equal(store.selfNotes.byDailyExperience(note.experience.dailyTaskId), undefined)
})
