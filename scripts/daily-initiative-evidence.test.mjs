import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { DailyInitiativeProposal, DailyInitiativeRecord } from '../src/core/daily-initiative.ts'
import { DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { pendingDailyGoals } from '../src/host/daily-initiative-evidence.ts'

test('initiative proposals and stored records have a bounded goal, opaque evidence and a scoped option', t => {
  const input = { goal: '我想沿着已经核验的路线再看看营地。', evidenceId: 'recent-1', option: 'survey:north' }
  assert.deepEqual(DailyInitiativeProposal.parse(input), input)
  assert.equal(DailyInitiativeProposal.safeParse({ ...input, goal: undefined }).success, false)
  const continuation = { option: 'survey:north', evidenceId: 'recent-1', previousId: 'goal-1' }
  assert.deepEqual(DailyInitiativeProposal.parse(continuation), continuation)
  assert.equal(DailyInitiativeProposal.safeParse({ ...continuation, goal: '短句' }).success, false)
  for (const change of [
    { goal: '太短' }, { goal: '甲'.repeat(121) }, { goal: `${input.goal}\n另一行` }, { goal: `${input.goal}\u202e` },
    { evidenceId: 'REF-1' }, { evidenceId: 'a'.repeat(33) }, { option: 'read:0' }, { option: 'survey:../../../root' },
    { option: 'visit:123' }, { tool: '/give' },
  ]) assert.equal(DailyInitiativeProposal.safeParse({ ...input, ...change }).success, false, JSON.stringify(change))
  for (const option of ['read:1', 'trail:north-east', 'defer', 'patrol', 'gather', 'visit']) {
    assert.equal(DailyInitiativeProposal.safeParse({ ...input, option }).success, true)
  }
  const stored = { goal: input.goal, evidence: { id: 'recent-1', kind: 'experience', text: '这是已核对的游戏经历。' }, option: input.option }
  assert.deepEqual(DailyInitiativeRecord.parse(stored), stored)
  assert.equal(DailyInitiativeRecord.safeParse({ ...stored, evidence: { ...stored.evidence, taskId: 'private-id' } }).success, false)
  assert.equal(DailyInitiativeRecord.safeParse({ ...stored, evidence: { ...stored.evidence, text: '坏\u0000值' } }).success, false)
})

test('the v40 upgrade preserves the daily history and leaves initiative off unless explicitly enabled', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/daily-initiative-store-')
  const path = join(directory, 'companion.sqlite')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new CompanionStore(path)
  const job = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:2026-11-09',
    runAfter: 10_000, payload: { date: '2026-11-09', choice: 'skip' } })
  const legacy = { ...store.autonomy.settings(), dailyReflectionEnabled: true, minecraftMilestonesEnabled: true }
  delete legacy.dailyInitiativeEnabled
  store.close()
  const old = new DatabaseSync(path)
  old.exec('PRAGMA user_version=40')
  old.prepare('INSERT INTO state VALUES (?,?)').run('autonomy.settings', JSON.stringify(legacy))
  const schema = old.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()
  old.close()

  const upgraded = new CompanionStore(path)
  try {
    assert.equal(upgraded.autonomy.settings().dailyInitiativeEnabled, false)
    assert.deepEqual(upgraded.autonomy.get(job.id), job)
    assert.equal(upgraded.autonomy.settings().dailyReflectionEnabled, true)
    assert.equal(upgraded.autonomy.settings().minecraftMilestonesEnabled, true)
    upgraded.autonomy.saveSettings({ ...upgraded.autonomy.settings(), dailyInitiativeEnabled: 'true' })
    assert.equal(upgraded.autonomy.settings().dailyInitiativeEnabled, false)
    upgraded.autonomy.saveSettings({ ...upgraded.autonomy.settings(), dailyInitiativeEnabled: true })
  } finally { upgraded.close() }
  const final = new CompanionStore(path)
  try { assert.equal(final.autonomy.settings().dailyInitiativeEnabled, true) }
  finally { final.close() }
  const inspect = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 44)
    assert.deepEqual(inspect.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema)
    assert.equal(inspect.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { inspect.close() }
})


const DAY = 86_400_000
const BASE = Date.UTC(2026, 10, 1, 12)
const evidence = { id: 'now-1', kind: 'current', text: '已确认今天可以勘察营地。' }
const originalGoal = '我想找个合适的时间核对营地周边的小路。'
const updatedGoal = '我想找个合适的时间先检查北侧的短路。'
const childTask = '0db06afd-8601-49f2-9914-b895a35e99de'

function goals(t) {
  t.mock.timers.enable({ apis: ['Date'], now: BASE })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/pending-goals-')
  const store = new CompanionStore(join(directory, 'goals.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const date = (day) => new Date(BASE + day * DAY).toISOString().slice(0, 10)
  const at = (day) => t.mock.timers.setTime(BASE + day * DAY)
  const find = (day, elapsed = day) => pendingDailyGoals(store, date(day), BASE + elapsed * DAY)
  function record(day, { initiative = { goal: originalGoal, option: 'defer', evidence }, status = 'cancelled',
    contextId = DAILY_AUTONOMY_CONTEXT, kind = 'daily.choice', dedupeKey = `daily:${date(day)}`,
    payload = {}, choice = 'skip', requested = true } = {}) {
    at(day)
    const job = store.autonomy.create({ kind, contextId, dedupeKey, runAfter: Date.now(),
      payload: { date: date(day), initiativeRequested: requested, choice, initiative, ...payload } })
    if (payload.visitId === 'self') store.autonomy.update(job.id, { payload: { ...job.payload, visitId: job.id } })
    if (status !== 'accepted') store.transitionTask(job.id, 'running')
    if (status !== 'accepted' && status !== 'running') store.transitionTask(job.id, status)
    return { taskId: job.id, goal: initiative.goal, expiresAt: BASE + (day + 7) * DAY }
  }
  return { record, find }
}

test('pending goals are newest first, scoped to earlier dates, limited to three and expire after one week', t => {
  const h = goals(t)
  const source = h.record(0)
  assert.deepEqual(h.find(0), [])
  assert.deepEqual(h.find(1, -1), [])
  assert.deepEqual(h.find(1), [source])
  assert.deepEqual(h.find(7, 7 - 1 / DAY), [source])
  assert.deepEqual(h.find(7), [])
  const more = [h.record(1), h.record(2), h.record(3)]
  assert.deepEqual(h.find(4), [...more].reverse())
  assert.deepEqual(h.find(3), [more[1], more[0], source])
})

test('only terminal records with a matching attempted world and admitted action become recoverable', async t => {
  for (const [label, option, choice, status, payload, expected] of [
    ['direct survey failure', 'survey:north', 'survey', 'failed', { initiativeAttempt: 'minecraft', activityTaskId: childTask }, 'minecraft'],
    ['two-leg trail interrupted', 'trail:north-east', 'survey', 'cancelled', { initiativeAttempt: 'minecraft', activityTaskId: childTask }, 'minecraft'],
    ['short visit failed after selecting a build', 'visit', 'build', 'failed', { initiativeAttempt: 'minecraft', visitId: 'self', visitStatus: 'offline' }, 'minecraft'],
    ['patrol failed after login', 'patrol', 'patrol', 'failed', { initiativeAttempt: 'minecraft', visitId: 'self', visitStatus: 'online' }, 'minecraft'],
    ['gather failed with uncertain logout', 'gather', 'gather', 'failed', { initiativeAttempt: 'minecraft', visitId: 'self', visitStatus: 'unconfirmed' }, 'minecraft'],
    ['reader paused after admission', 'read:1', 'bilibili', 'cancelled', { initiativeAttempt: 'bilibili', activityTaskId: childTask }, 'bilibili'],
    ['sampler failed after admission', 'clip:1', 'bilibili', 'failed', { initiativeAttempt: 'bilibili', activityTaskId: childTask }, 'bilibili'],
    ['absent marker in old failure', 'read:1', 'bilibili', 'failed', { activityTaskId: childTask }],
    ['not dispatched', 'read:1', 'bilibili', 'failed', { initiativeAttempt: 'bilibili' }],
    ['malformed child identity', 'survey:north', 'survey', 'failed', { initiativeAttempt: 'minecraft', activityTaskId: 'task' }],
    ['wrong world marker', 'read:1', 'bilibili', 'failed', { initiativeAttempt: 'minecraft', activityTaskId: childTask }],
    ['wrong choice', 'trail:north-east', 'patrol', 'failed', { initiativeAttempt: 'minecraft', activityTaskId: childTask }],
    ['unbound visit', 'visit', 'survey', 'failed', { initiativeAttempt: 'minecraft', visitId: childTask, visitStatus: 'offline' }],
    ['unobserved visit phase', 'visit', 'survey', 'failed', { initiativeAttempt: 'minecraft', visitId: 'self', visitStatus: 'fake' }],
    ['still executing', 'read:1', 'bilibili', 'running', { initiativeAttempt: 'bilibili', activityTaskId: childTask }],
    ['action completed', 'read:1', 'bilibili', 'succeeded', { initiativeAttempt: 'bilibili', activityTaskId: childTask }],
  ]) await t.test(label, child => {
    const h = goals(child)
    const initiative = { goal: originalGoal, evidence, option,
      ...(option === 'clip:1' && { clip: { start: 0, seconds: 4, mode: 'visual' } }) }
    const first = h.record(0, { initiative, choice, status, payload })
    assert.deepEqual(h.find(0), [])
    assert.deepEqual(h.find(1), expected ? [{ ...first, lastUnconfirmedWorld: expected }] : [])
    assert.deepEqual(h.find(7), [])
  })
})

test('unconfirmed revisions preserve the original intent, update the latest world and cannot extend its life', t => {
  const h = goals(t)
  const first = h.record(0, { initiative: { goal: originalGoal, evidence, option: 'survey:north' },
    choice: 'survey', status: 'failed', payload: { initiativeAttempt: 'minecraft', activityTaskId: childTask } })
  h.record(1, { initiative: { goal: updatedGoal, evidence, option: 'read:1', previous: first },
    choice: 'bilibili', status: 'cancelled', payload: { initiativeAttempt: 'bilibili', activityTaskId: childTask } })
  assert.deepEqual(h.find(2), [{ ...first, lastUnconfirmedWorld: 'bilibili' }])
  const deferred = h.record(3, { initiative: { goal: updatedGoal, evidence, option: 'defer', previous: first } })
  assert.deepEqual(h.find(4), [{ ...deferred, expiresAt: first.expiresAt, lastUnconfirmedWorld: 'bilibili' }])
  assert.deepEqual(h.find(7), [])
})

test('incomplete, foreign and contradictory history cannot become a pending initiative', async t => {
  for (const [name, options] of [
    ['no opt-in', { requested: false }],
    ['string opt-in', { requested: 'true' }],
    ['accepted task', { status: 'accepted' }],
    ['running task', { status: 'running' }],
    ['failed task', { status: 'failed' }],
    ['unexpected task success', { status: 'succeeded' }],
    ['different context', { contextId: 'chat.mobile' }],
    ['different kind', { kind: 'daily.reflect' }],
    ['wrong date key', { dedupeKey: 'daily:2026-10-31' }],
    ['unsettled choice', { choice: null }],
    ['unexpected activity child', { payload: { activityTaskId: 'child' } }],
    ['unexpected visit', { payload: { visitId: 'visit' } }],
    ['extra record property', { initiative: { goal: originalGoal, evidence, option: 'defer', sessionId: 'foreign' } }],
  ]) await t.test(name, child => {
    const h = goals(child)
    h.record(0, options)
    assert.deepEqual(h.find(1), [])
  })
})

test('only a matching earlier goal can be closed or rewritten, and a rewrite inherits its lifetime', async t => {
  for (const [name, change] of [
    ['wrong prior goal text', previous => ({ ...previous, goal: updatedGoal })],
    ['wrong expiry', previous => ({ ...previous, expiresAt: previous.expiresAt + DAY })],
    ['wrong identity', previous => ({ ...previous, taskId: 'f8d1d998-46ee-4118-9721-1a4485a149f7' })],
  ]) await t.test(name, child => {
    const h = goals(child)
    const first = h.record(0)
    h.record(1, { initiative: { goal: updatedGoal, evidence, option: 'defer', previous: change(first) } })
    assert.deepEqual(h.find(2), [first])
  })
  await t.test('revised copy expires with the first version', child => {
    const h = goals(child)
    const first = h.record(0)
    const second = h.record(2, { initiative: { goal: updatedGoal, evidence, option: 'defer', previous: first } })
    assert.deepEqual(h.find(3), [{ ...second, expiresAt: first.expiresAt }])
    assert.deepEqual(h.find(7), [])
  })
})
