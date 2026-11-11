import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DAILY_HOUSE_PROJECT_LIMIT_MS, dailyHouseProjectReflectionFact, verifiedDailyHouseProjectSection } from '../src/core/daily-house-project-proof.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY } from '../src/core/minecraft-house-project.ts'
import { DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'

const epoch = Date.parse('2026-11-12T13:00:00.000Z')
const time = ms => new Date(epoch + ms).toISOString()

function fixture() {
  const id = randomUUID()
  const childId = randomUUID()
  const projectId = randomUUID()
  const zoneId = randomUUID()
  const date = '2026-11-12'
  const parent = { id, contextId: DAILY_AUTONOMY_CONTEXT, capabilityId: 'core.autonomy', externalId: `autonomy:daily.choice:daily:${date}`,
    title: '选择今日的自主活动', status: 'succeeded', createdAt: time(0), updatedAt: time(5000) }
  const child = { id: childId, contextId: 'game.minecraft', capabilityId: HOUSE_PROJECT_SECTION_CAPABILITY,
    externalId: DAILY_HOUSE_PROJECT_TASK_PREFIX + id, title: '续建', status: 'succeeded', createdAt: time(100), updatedAt: time(4000) }
  const job = { id, contextId: parent.contextId, kind: 'daily.choice', dedupeKey: `daily:${date}`, runAfter: epoch,
    attempts: 1, maxAttempts: 1, createdAt: parent.createdAt, updatedAt: parent.updatedAt, task: parent, payload: {
      date, windowRuleId: randomUUID(), expiresAt: epoch + 1_800_000, choice: 'house-project', activityTaskId: childId,
      houseSection: { projectId, zoneId, section: 1, recovery: true, deadline: epoch + DAILY_HOUSE_PROJECT_LIMIT_MS },
      initiative: { goal: '我想换一个站位补好东翼的缺口。', evidence: { id: 'now-1', kind: 'current', text: '现场已通过预检。' }, option: 'house:2' },
      initiativeReceipt: { sessionId: 'private-native-session', eventSeq: 17, optionLabel: '有通行位置，可续建东翼' },
    } }
  const receipt = { built: true, zoneId, checked: 100, placed: 2, consumed: { spruce_planks: 2 }, recovery: true }
  const row = { projectId, zoneId, section: 1, receipt }
  const activity = { id: 25, eventId: randomUUID(), taskId: childId, contextId: 'game.minecraft', source: 'game.minecraft',
    kind: 'world.house-project-section', status: 'success', summary: '已经核对分区', occurredAt: time(4001),
    data: { ...structuredClone(receipt), projectId, index: 1, dailyTaskId: id } }
  const state = { job, child, row, activity }
  const store = {
    taskById: id => id === childId ? state.child : undefined,
    activityByTask: (id, kind, context) => id === childId && kind === 'world.house-project-section' && context === 'game.minecraft'
      ? state.activity : undefined,
    minecraftHouseProjects: { sectionReceiptByTask: id => id === childId ? state.row : undefined },
  }
  return { ...state, state, store, proof: () => verifiedDailyHouseProjectSection(store, job) }
}

test('a saved section receipt is the same proof during settlement and after the authorization expires', t => {
  const f = fixture()
  const expected = { ...f.row, at: time(4001), activityId: 25 }
  t.mock.method(Date, 'now', () => epoch + 86_400_000)
  assert.deepEqual(f.proof(), expected)
  f.job.task.status = 'running'
  f.job.task.updatedAt = time(1)
  assert.deepEqual(f.proof(), expected)
  assert.equal(dailyHouseProjectReflectionFact(expected), '在 Minecraft 通过站位恢复流程续建第 2 个分区，核对 100 处位置，实际放置 2 块。')
  assert.doesNotMatch(dailyHouseProjectReflectionFact(expected), /东翼|整栋|private|[0-9a-f]{8}-/u)

  delete f.job.payload.houseSection.recovery
  delete f.row.receipt.recovery
  delete f.activity.data.recovery
  const zero = { checked: 100, placed: 0, consumed: {} }
  Object.assign(f.row.receipt, zero)
  Object.assign(f.activity.data, zero)
  assert.equal(dailyHouseProjectReflectionFact(f.proof()), '在 Minecraft 自主施工第 2 个分区，核对 100 处位置，实际放置 0 块。')
})

test('a project fact needs the exact authorized daily parent and native proposal', async t => {
  for (const [name, change] of [
    ['different job kind', f => { f.job.kind = 'daily.reflect' }],
    ['different context', f => { f.job.contextId = 'game.minecraft' }],
    ['different parent task ID', f => { f.job.task.id = randomUUID() }],
    ['different parent task context', f => { f.job.task.contextId = 'game.minecraft' }],
    ['different parent capability', f => { f.job.task.capabilityId = HOUSE_PROJECT_SECTION_CAPABILITY }],
    ['manual parent', f => { delete f.job.task.externalId }],
    ['different parent date key', f => { f.job.dedupeKey = 'daily:2026-11-11' }],
    ['invalid calendar date', f => {
      f.job.payload.date = '2026-02-30'
      f.job.dedupeKey = 'daily:2026-02-30'
      f.job.task.externalId = 'autonomy:daily.choice:daily:2026-02-30'
    }],
    ['different parent creation time', f => { f.job.task.createdAt = time(1) }],
    ['cancelled parent', f => { f.job.task.status = 'cancelled' }],
    ['rejected parent', f => { f.job.task.status = 'failed' }],
    ['wrong action', f => { f.job.payload.choice = 'build' }],
    ['missing permit window', f => { delete f.job.payload.windowRuleId }],
    ['short visit', f => { f.job.payload.visitId = randomUUID() }],
    ['short visit metadata alone', f => { f.job.payload.visitStatus = 'offline' }],
    ['different native option', f => { f.job.payload.initiative.option = 'house:1' }],
    ['missing native decision', f => { delete f.job.payload.initiative }],
    ['missing native receipt', f => { delete f.job.payload.initiativeReceipt }],
    ['unobserved native event', f => { f.job.payload.initiativeReceipt.eventSeq = 0 }],
    ['borrowed native clip', f => { f.job.payload.initiative.clip = { start: 0, seconds: 1, mode: 'visual' } }],
  ]) {
    await t.test(name, () => {
      const f = fixture()
      change(f)
      assert.equal(f.proof(), undefined)
    })
  }
})

test('a project fact requires the same child, saved section, worker event and in-window timestamps', async t => {
  for (const [name, change] of [
    ['missing child', f => { f.state.child = undefined }],
    ['wrong child lookup', f => { f.child.id = randomUUID() }],
    ['running child', f => { f.child.status = 'running' }],
    ['borrowed child context', f => { f.child.contextId = 'chat.mobile' }],
    ['manual child', f => { delete f.child.externalId }],
    ['wrong child capability', f => { f.child.capabilityId = 'minecraft.house' }],
    ['missing saved section', f => { f.state.row = undefined }],
    ['wrong saved project', f => { f.row.projectId = randomUUID() }],
    ['wrong saved zone', f => { f.row.zoneId = randomUUID() }],
    ['wrong saved section', f => { f.row.section = 0 }],
    ['wrong saved mode', f => { delete f.row.receipt.recovery }],
    ['matching receipts from a wrong grant', f => { f.activity.data.zoneId = f.row.receipt.zoneId = randomUUID() }],
    ['malformed saved receipt', f => { f.row.receipt = null }],
    ['missing or non-unique event', f => { f.state.activity = undefined }],
    ['different event task', f => { f.activity.taskId = randomUUID() }],
    ['different event kind', f => { f.activity.kind = 'world.house-project-verification' }],
    ['different event source', f => { f.activity.source = 'core.autonomy' }],
    ['unconfirmed event', f => { f.activity.status = 'warning' }],
    ['wrong event project', f => { f.activity.data.projectId = randomUUID() }],
    ['wrong event section', f => { f.activity.data.index = 0 }],
    ['wrong event parent', f => { f.activity.data.dailyTaskId = randomUUID() }],
    ['wrong event mode', f => { delete f.activity.data.recovery }],
    ['malformed event data', f => { f.activity.data = null }],
    ['different consumed blocks', f => { f.activity.data.consumed = { oak_planks: 2 } }],
    ['invalid consumed count on both records', f => { f.activity.data.consumed = f.row.receipt.consumed = { spruce_planks: 1 } }],
    ['completion after authorized deadline', f => { f.job.payload.houseSection.deadline = epoch + 4001 }],
    ['deadline extends past permit', f => { f.job.payload.expiresAt = epoch + 4002 }],
    ['deadline exceeds allowed duration', f => { f.job.payload.houseSection.deadline = epoch + DAILY_HOUSE_PROJECT_LIMIT_MS + 101 }],
    ['child predates parent', f => { f.child.createdAt = time(-1) }],
    ['event predates child completion', f => { f.activity.occurredAt = time(3999) }],
    ['event after parent completion', f => { f.job.task.updatedAt = time(4000) }],
    ['invalid event timestamp', f => { f.activity.occurredAt = 'not-a-time' }],
  ]) {
    await t.test(name, () => {
      const f = fixture()
      change(f)
      assert.equal(f.proof(), undefined)
    })
  }
})

test('malformed persisted receipt JSON yields no fact and infrastructure errors stay visible', () => {
  const f = fixture()
  f.store.minecraftHouseProjects.sectionReceiptByTask = () => { throw new SyntaxError('Invalid saved receipt') }
  assert.equal(f.proof(), undefined)
  f.store.minecraftHouseProjects.sectionReceiptByTask = () => { throw new Error('Unable to read the store') }
  assert.throws(f.proof, /Unable to read the store/u)
})
