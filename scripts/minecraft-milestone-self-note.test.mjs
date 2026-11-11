import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MINECRAFT_HOUSE_CAPABILITY } from '../src/core/minecraft-house-repository.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, milestoneReflectionKey } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync(join('.work', 'minecraft-milestone-note-'))
  const path = join(dir, 'companion.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, path }
}

function reflection(store, experience, suffix, overrides = {}) {
  const sessionId = 'reflection-' + suffix
  const payload = { milestone: { kind: experience.kind, taskId: experience.taskId }, expiresAt: Date.now() + 60_000 }
  const task = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT, runAfter: Date.now(),
    dedupeKey: milestoneReflectionKey(experience.kind, experience.taskId), payload, ...overrides })
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  const source = { contextId: DAILY_REFLECTION_CONTEXT, sessionId, taskId: task.id, eventSeq: 3 }
  const note = { content: '我会在交付前核对结果。', basis: 'inference', createdBy: 'companion', actorSessionId: sessionId,
    evidence: ['我会在交付前核对结果。'], evidenceRefs: [{ quoteIndex: 0, role: 'assistant', messageId: 'reply-' + suffix }],
    sourceRefs: [source], experience }
  return { task, note, source, payload }
}

function finish(store, task) {
  store.transitionTask(task.id, 'running')
  return store.transitionTask(task.id, 'succeeded')
}

test('a milestone note requires the live reflection binding, exact payload and built house attempt', t => {
  const { store, path } = fixture(t)
  const zone = store.createBuildZone({ name: '小屋区', dimension: 'minecraft:overworld', x: 0, y: 80, z: 0, radius: 4 })
  const draft = store.minecraftHouses.create({ name: '小屋', zoneId: zone.id, layout: { width: 2, height: 1, depth: 1, blocks: 'og' } },
    { sessionId: 'chat-phone', messageId: 'reference' })
  const build = store.createTask({ contextId: 'game.minecraft', capabilityId: MINECRAFT_HOUSE_CAPABILITY, title: '已授权施工' })
  assert.equal(store.minecraftHouses.start(draft.id, zone.id, build.id), true)
  const experience = { kind: 'house', taskId: build.id, draftId: draft.id }
  const { task, note, source, payload } = reflection(store, experience, 'house')
  const invalid = (input = note) => assert.throws(() => store.selfNotes.create(input), /self-note-invalid-evidence/u)
  invalid()
  store.transitionTask(task.id, 'running')
  invalid()
  finish(store, build)
  const receipt = { built: true, zoneId: zone.id, checked: 2, placed: 2, consumed: { oak_planks: 1, glass: 1 } }
  assert.equal(store.minecraftHouses.finish(draft.id, build.id, receipt), true)

  for (const input of [
    { ...note, actorSessionId: undefined },
    { ...note, actorSessionId: 'stale', sourceRefs: [{ ...source, sessionId: 'stale' }] },
    { ...note, sourceRefs: [source, source] },
    { ...note, sourceRefs: [{ ...source, activityId: 1 }] },
    { ...note, sourceRefs: [{ ...source, taskId: build.id }] },
    { ...note, experience: { ...experience, draftId: randomUUID() } },
  ]) invalid(input)
  for (const patch of [{ expiresAt: Date.now() - 1 }, { dailyTaskId: randomUUID() },
    { milestone: { kind: 'camp-project', taskId: build.id } }, { milestone: { kind: 'house', taskId: randomUUID() } },
    { milestone: { ...payload.milestone, zoneId: zone.id } }]) {
    store.autonomy.update(task.id, { payload: { ...payload, ...patch } })
    invalid()
  }
  store.autonomy.update(task.id, { payload })
  const db = new DatabaseSync(path)
  try {
    const replaceReceipt = db.prepare('UPDATE minecraft_house SET receipt_json=? WHERE id=?')
    for (const replacement of [{ ...receipt, placed: 0, consumed: {} }, { ...receipt, consumed: { spruce_planks: 2 } }]) {
      replaceReceipt.run(JSON.stringify(replacement), draft.id)
      invalid()
    }
    replaceReceipt.run(JSON.stringify(receipt), draft.id)
  } finally { db.close() }
  const saved = store.selfNotes.create(note)
  assert.deepEqual(saved.experience, experience)
  assert.equal(store.selfNotes.create({ ...note, content: '重复复盘只保留一条。' }).id, saved.id)
  assert.equal(store.selfNotes.byDailyExperience(build.id), undefined)
  assert.equal(store.selfNotes.byMilestoneExperience('camp-project', build.id), undefined)
  assert.deepEqual(store.selfNotes.revisions(saved.id)[0].snapshot.experience, experience)
  store.selfNotes.update(saved.id, { status: 'archived' })
  store.transitionTask(task.id, 'succeeded')
  invalid()
  const reopened = new CompanionStore(path)
  try {
    assert.equal(reopened.selfNotes.byMilestoneExperience('house', build.id).status, 'archived')
    assert.deepEqual(reopened.selfNotes.byMilestoneExperience('house', build.id).experience, experience)
  } finally { reopened.close() }
})

test('camp project requires same-rule earlier construction and a later nine-block offline revisit', t => {
  const { store } = fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T12:00:00Z') })
  const windowRuleId = randomUUID()
  const campZoneId = randomUUID()
  const visit = (choice, date, childPayload) => {
    const now = Date.parse(date + 'T12:00:00Z')
    t.mock.timers.setTime(now)
    const expiresAt = now + 60_000
    const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:' + date, runAfter: now })
    store.transitionTask(daily.id, 'running')
    const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
      dedupeKey: 'visit-' + choice + ':' + daily.id, runAfter: now })
    store.transitionTask(child.id, 'running')
    const built = choice === 'build'
    const receipt = finish(store, store.createTask({ contextId: 'game.minecraft', capabilityId: built ? 'minecraft.build' : 'minecraft.survey',
      title: '营地验收', externalId: (built ? CAMP_VISIT_BUILD_TASK_PREFIX : CAMP_VISIT_REVISIT_TASK_PREFIX) + daily.id }))
    const payload = { ...childPayload, visitId: daily.id, campZoneId, expiresAt, receiptTaskId: receipt.id }
    store.autonomy.update(child.id, { payload })
    store.transitionTask(child.id, 'succeeded')
    const day = { windowRuleId, date, choice, activityTaskId: child.id, visitId: daily.id, visitJoined: true, visitStatus: 'offline',
      visitExpiresAt: expiresAt, expiresAt: expiresAt + 60_000 }
    store.autonomy.update(daily.id, { payload: day })
    store.transitionTask(daily.id, 'succeeded')
    return { daily, child, payload, day, receipt }
  }
  const build = visit('build', '2026-11-10', { goal: 'camp', visitBuild: { built: true, zoneId: campZoneId, material: 'oak_planks',
    placedFloor: 8, placedTable: 1, inventory: { floorBefore: 9, floorAfter: 1, tablesBefore: 1, tablesAfter: 0 } } })
  const revisit = visit('revisit', '2026-11-11', { goal: 'revisit', constructionTaskId: build.receipt.id,
    visitRevisit: { zoneId: campZoneId, material: 'oak_planks', checkedBlocks: 9, matchedBlocks: 9 } })
  const experience = { kind: 'camp-project', taskId: revisit.daily.id, constructionTaskId: build.receipt.id, receiptTaskId: revisit.receipt.id }
  const { task, note } = reflection(store, experience, 'camp')
  store.transitionTask(task.id, 'running')
  const invalid = () => assert.throws(() => store.selfNotes.create(note), /self-note-invalid-evidence/u)
  for (const patch of [{ windowRuleId: randomUUID() }, { visitStatus: 'unconfirmed' }, { visitExpiresAt: Date.now() }]) {
    store.autonomy.update(revisit.daily.id, { payload: { ...revisit.day, ...patch } })
    invalid()
  }
  store.autonomy.update(revisit.daily.id, { payload: revisit.day })
  for (const patch of [{ constructionTaskId: randomUUID() }, { receiptTaskId: build.receipt.id },
    { visitRevisit: { ...revisit.payload.visitRevisit, matchedBlocks: 8 } },
    { visitRevisit: { ...revisit.payload.visitRevisit, material: 'spruce_planks' } }]) {
    store.autonomy.update(revisit.child.id, { payload: { ...revisit.payload, ...patch } })
    invalid()
  }
  store.autonomy.update(revisit.child.id, { payload: revisit.payload })
  const saved = store.selfNotes.create(note)
  assert.deepEqual(saved.experience, experience)
  assert.deepEqual(store.selfNotes.byMilestoneExperience('camp-project', revisit.daily.id), saved)
  assert.equal(store.selfNotes.byDailyExperience(revisit.daily.id), undefined)
})

test('milestone setting is independent and defaults to false for legacy and malformed settings', t => {
  const { store, path } = fixture(t)
  assert.equal(store.autonomy.settings().minecraftMilestonesEnabled, false)
  const legacy = { ...store.autonomy.settings(), dailyReflectionEnabled: false, feedEnabled: false }
  delete legacy.minecraftMilestonesEnabled
  store.autonomy.saveSettings(legacy)
  assert.equal(store.autonomy.settings().minecraftMilestonesEnabled, false)
  store.autonomy.saveSettings({ ...legacy, minecraftMilestonesEnabled: 'true' })
  assert.equal(store.autonomy.settings().minecraftMilestonesEnabled, false)
  store.autonomy.saveSettings({ ...legacy, minecraftMilestonesEnabled: true })
  const reopened = new CompanionStore(path)
  try {
    assert.equal(reopened.autonomy.settings().minecraftMilestonesEnabled, true)
    assert.equal(reopened.autonomy.settings().dailyReflectionEnabled, false)
    assert.equal(reopened.autonomy.settings().feedEnabled, false)
    assert.equal(reopened.autonomy.settings().minecraftShareEnabled, false)
  } finally { reopened.close() }
})
