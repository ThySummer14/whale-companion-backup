import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { minecraftHouseBuildSummary } from '../src/core/minecraft-house-repository.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { createSurveyWindow, surveyWindowDay } from '../src/core/minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { campProject } from '../src/host/minecraft-camp-project.ts'
import { recentDailyInitiativeEvidence } from '../src/host/daily-initiative-evidence.ts'
import { recentMinecraftMilestones, verifiedMinecraftMilestone } from '../src/host/minecraft-milestones.ts'

function fixture(t) {
  const day = new Date(2026, 10, 9, 10)
  t.mock.timers.enable({ apis: ['Date'], now: day.getTime() })
  const directory = mkdtempSync('.work/minecraft-milestones-')
  const path = join(directory, 'host.sqlite')
  const store = new CompanionStore(path)
  const db = new DatabaseSync(path)
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const zone = store.createBuildZone({ name: '私有工地名称', dimension: 'minecraft:overworld', x: 853, y: 81, z: -732, radius: 8 })
  return { store, db, zone, advance: () => t.mock.timers.setTime(Date.now() + 1_000),
    nextDay: () => t.mock.timers.setTime(new Date(2026, 10, 10, 10).getTime()) }
}

function campFixture(t, options = {}) {
  const { store, db, zone, advance, nextDay } = fixture(t)
  const rule = createSurveyWindow({ zoneId: zone.id, start: '10:00', end: '11:00', days: 2, allowMinecraftLogin: true,
    allowMinecraftSupply: true, allowMinecraftBuild: true, allowMinecraftProject: true }, Date.now())
  store.autonomy.saveSurveyWindow(rule)
  const material = 'oak_planks'

  function visit(choice, constructionTaskId) {
    const revisit = choice === 'revisit'
    const { date, closesAt } = surveyWindowDay(rule, Date.now())
    const visitExpiresAt = Date.now() + 300_000
    const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: `daily:${date}`,
      runAfter: Date.now(), payload: { windowRuleId: rule.id, date, expiresAt: closesAt } })
    store.transitionTask(daily.id, 'running')
    advance()
    const childPayload = { goal: revisit ? 'revisit' : 'camp', campZoneId: zone.id, visitId: daily.id, expiresAt: visitExpiresAt,
      ...(constructionTaskId && { constructionTaskId }) }
    const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
      dedupeKey: `visit-${choice}:${daily.id}`, runAfter: Date.now(), payload: childPayload })
    store.transitionTask(child.id, 'running')
    advance()
    const externalId = `${revisit ? CAMP_VISIT_REVISIT_TASK_PREFIX : CAMP_VISIT_BUILD_TASK_PREFIX}${daily.id}`
    const task = store.createTask({ externalId, contextId: 'game.minecraft', title: '私有任务文本',
      capabilityId: revisit ? 'minecraft.survey' : 'minecraft.build' })
    store.transitionTask(task.id, 'running')
    advance()
    const receipt = revisit ? { zoneId: zone.id, material, checkedBlocks: 9, matchedBlocks: options.matchedBlocks ?? 9 }
      : { built: true, zoneId: zone.id, material, placedFloor: 8, placedTable: 1,
        inventory: { floorBefore: 8, floorAfter: 0, tablesBefore: 1, tablesAfter: 0 } }
    store.transitionTask(task.id, 'succeeded', undefined, () => store.recordActivity({ eventId: `${externalId}:receipt`,
      taskId: task.id, contextId: DAILY_VISIT_CONTEXT, kind: `world.visit-${choice}`, source: 'game.minecraft', summary: '私有回执备注',
      status: 'success', data: { receipt } }))
    advance()
    store.autonomy.update(child.id, { payload: { ...childPayload, receiptTaskId: task.id, [revisit ? 'visitRevisit' : 'visitBuild']: receipt } })
    store.transitionTask(child.id, 'succeeded')
    advance()
    const offlineId = store.recordActivity({ eventId: `minecraft-visit:${daily.id}:offline`, contextId: 'game.minecraft',
      taskId: daily.id, source: 'game.minecraft', kind: 'world.visit-offline', summary: '下线', status: 'success' })
    store.autonomy.update(daily.id, { payload: { ...daily.payload, choice, visitId: daily.id, visitJoined: true, visitStatus: 'offline',
      visitExpiresAt, activityTaskId: child.id } })
    store.transitionTask(daily.id, 'succeeded')
    return { daily, task, offlineId }
  }

  const build = visit('build')
  nextDay()
  const revisit = visit('revisit', build.task.id)
  const verify = () => verifiedMinecraftMilestone(store, 'camp-project', revisit.daily.id)
  return { store, db, zone, rule, build, revisit, verify }
}

test('camp completion is the exact later, disconnected revisit backed by both private game actions', t => {
  const { store, db, rule, zone, build, revisit, verify } = campFixture(t)
  const proof = verify()
  assert.deepEqual(proof.experience, { kind: 'camp-project', taskId: revisit.daily.id, constructionTaskId: build.task.id, receiptTaskId: revisit.task.id })
  assert.equal(proof.at, store.activityById(revisit.offlineId).occurredAt)
  assert.match(proof.fact, /复访确认 9 处方块完好，已下线/u)
  for (const privateText of [rule.id, zone.id, zone.name, '853', '私有任务文本', '私有回执备注']) assert.ok(!proof.fact.includes(privateText))
  assert.deepEqual(recentMinecraftMilestones(store, Date.parse(proof.at)), [proof])
  assert.deepEqual(recentMinecraftMilestones(store, Date.parse(proof.at) + 1), [])
  store.autonomy.saveSurveyWindow({ ...rule, id: randomUUID() })
  assert.equal(verify(), undefined)
  store.autonomy.saveSurveyWindow(rule)
  db.prepare('DELETE FROM activity WHERE id=?').run(revisit.offlineId)
  assert.equal(campProject(store, rule).view.stage, 'complete')
  assert.equal(verify(), undefined)
})

test('initiative evidence requires the existing grant for completed Minecraft milestones', t => {
  const { store, rule } = campFixture(t)
  const { evidence: before } = recentDailyInitiativeEvidence(store, Date.now())
  assert.equal(before.length, 1)
  assert.match(before[0].text, /短访中选择搭建/u)
  store.autonomy.saveSettings({ ...store.autonomy.settings(), minecraftMilestonesEnabled: true })
  const { evidence: [proof] } = recentDailyInitiativeEvidence(store, Date.now())
  assert.equal(proof.kind, 'experience')
  assert.equal(proof.id, 'recent-1')
  assert.match(proof.text, /复访确认 9 处方块完好/u)
  assert.ok(!proof.text.includes(rule.id) && !proof.text.includes(rule.zoneId))
  store.autonomy.saveSettings({ ...store.autonomy.settings(), minecraftMilestonesEnabled: false })
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now()).evidence, before)
})

test('a settled 8-of-9 camp remains inspectable and provides no completion claim', t => {
  const { store, rule, verify } = campFixture(t, { matchedBlocks: 8 })
  assert.equal(campProject(store, rule).view.stage, 'needs-review')
  assert.equal(verify(), undefined)
})

test('house completion needs the unique matching event, an active zone, and an actual material debit', t => {
  const { store, db, zone } = fixture(t)
  const draft = store.minecraftHouses.create({ name: '私有屋名', layout: { width: 2, height: 1, depth: 1, blocks: 'oo' } },
    { sessionId: 'private-phone', messageId: 'private-message', reference: { contextId: 'chat.mobile', messageId: 'private-message', attachmentId: 'private-image' } })
  const task = store.createTask({ capabilityId: 'minecraft.house', contextId: 'game.minecraft', sessionId: 'private-session', title: '私有任务' })
  assert.ok(store.minecraftHouses.start(draft.id, zone.id, task.id))
  store.transitionTask(task.id, 'running')
  const receipt = { built: true, zoneId: zone.id, checked: 2, placed: 2, consumed: { oak_planks: 2 } }
  assert.ok(store.minecraftHouses.finish(draft.id, task.id, receipt))
  store.transitionTask(task.id, 'succeeded')
  const verify = () => verifiedMinecraftMilestone(store, 'house', task.id)
  assert.equal(verify(), undefined)
  store.recordActivity({ taskId: task.id, contextId: 'game.minecraft', sessionId: task.sessionId,
    kind: 'world.house-built', source: 'game.minecraft', status: 'success', summary: minecraftHouseBuildSummary(receipt) })
  const proof = verify()
  assert.deepEqual(proof.experience, { kind: 'house', taskId: task.id, draftId: draft.id })
  assert.equal(proof.fact, '在 Minecraft 按蓝图完成一座小屋，核验 2 处位置，本次放置 2 块。')
  const replaceReceipt = value => db.prepare('UPDATE minecraft_house SET receipt_json=? WHERE id=?').run(JSON.stringify(value), draft.id)
  for (const changed of [{ placed: 1, consumed: { oak_planks: 1 } }, { placed: 0, consumed: {} }, { consumed: { spruce_planks: 2 } }]) {
    replaceReceipt({ ...receipt, ...changed })
    assert.equal(verify(), undefined)
  }
  replaceReceipt(receipt)
  assert.ok(verify())
  assert.ok(store.revokeBuildZone(zone.id))
  assert.deepEqual(recentMinecraftMilestones(store, 0), [])
})
