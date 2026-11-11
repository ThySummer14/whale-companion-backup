import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MinecraftSurveyWindowInputSchema, MinecraftSurveyWindowRuleSchema, createSurveyWindow, isSurveyWindowKey, surveyWindowDay, surveyWindowKey } from '../src/core/minecraft-survey-window.ts'
import { DAILY_AUTONOMY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

const input = { zoneId: randomUUID(), start: '18:30', end: '19:00', days: 1 }
const local = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime()
const now = local(2026, 11, 9, 18, 0)

test('owner windows require a valid same-day clock range and one to seven days', () => {
  assert.equal(MinecraftSurveyWindowInputSchema.safeParse(input).success, true)
  assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, end: '21:30', days: 7 }).success, true)
  for (const changes of [
    { start: '8:30' }, { start: '24:00' }, { end: '19:60' }, { end: '18:59' }, { end: '21:31' },
    { start: '23:30', end: '01:00' }, { end: '18:30' }, { days: 0 }, { days: 1.5 }, { days: 8 },
    { zoneId: 'wrong' }, { expiresAt: now + 1000 }, { days: '3' },
  ]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, ...changes }).success, false, JSON.stringify(changes))
  }
})

test('a segmented building authorization is optional, exact, and independent of camp grants', () => {
  const houseProjectId = randomUUID()
  const legacy = createSurveyWindow(input, now)
  const house = createSurveyWindow({ ...input, houseProjectId }, now)
  assert.equal(legacy.houseProjectId, undefined)
  assert.equal(house.houseProjectId, houseProjectId)
  for (const field of ['allowMinecraftLogin', 'allowMinecraftSupply', 'allowMinecraftBuild', 'allowMinecraftProject']) {
    assert.equal(house[field], undefined, field)
  }
  assert.deepEqual(MinecraftSurveyWindowRuleSchema.parse(JSON.parse(JSON.stringify(house))), house)
  assert.deepEqual(MinecraftSurveyWindowRuleSchema.parse(legacy), legacy)
  for (const value of [true, false, 1, null, '', 'not-a-project', [houseProjectId], { id: houseProjectId }]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, houseProjectId: value }).success, false)
    assert.equal(MinecraftSurveyWindowRuleSchema.safeParse({ ...legacy, houseProjectId: value }).success, false)
  }
})

test('a window created before closing counts today and stores host-local opening and closing', () => {
  const rule = createSurveyWindow(input, now)
  assert.equal(rule.timeZone, new Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.equal(rule.createdAt, now)
  assert.equal(rule.expiresAt, local(2026, 11, 9, 19, 0))
  const expected = { date: '2026-11-09', opensAt: local(2026, 11, 9, 18, 30), closesAt: local(2026, 11, 9, 19, 0) }
  for (const time of [now, expected.opensAt, expected.closesAt, local(2026, 11, 9, 21, 30)]) {
    assert.deepEqual(surveyWindowDay(rule, time), expected)
  }
  assert.equal(createSurveyWindow(input, expected.closesAt - 1).expiresAt, expected.closesAt)
})

test('joining Minecraft and browsing Bilibili are independent explicit opt-ins', () => {
  const legacy = createSurveyWindow(input, now)
  assert.equal(legacy.allowMinecraftLogin, undefined)
  assert.equal(legacy.allowBilibili, undefined)
  for (const permissions of [{ allowMinecraftLogin: true }, { allowBilibili: true }, { allowMinecraftLogin: true, allowBilibili: true }]) {
    const rule = createSurveyWindow({ ...input, ...permissions }, now)
    assert.equal(rule.allowMinecraftLogin, permissions.allowMinecraftLogin)
    assert.equal(rule.allowBilibili, permissions.allowBilibili)
    assert.deepEqual(surveyWindowDay(rule, now), surveyWindowDay(legacy, now))
  }
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowMinecraftLogin: value }).success, false)
  }
})

test('short-visit supply requires its own explicit opt-in and prior login permission', () => {
  const visit = createSurveyWindow({ ...input, allowMinecraftLogin: true }, now)
  assert.equal(visit.allowMinecraftSupply, undefined)
  assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowMinecraftSupply: true }).success, false)
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowMinecraftLogin: true, allowMinecraftSupply: value }).success, false)
  }
  assert.equal(createSurveyWindow({ ...input, allowMinecraftLogin: true, allowMinecraftSupply: true }, now).allowMinecraftSupply, true)
})

test('short-visit building requires a separate explicit opt-in with login but can coexist with supply', () => {
  const login = { ...input, allowMinecraftLogin: true }
  const prior = createSurveyWindow({ ...login, allowMinecraftSupply: true }, now)
  assert.equal(prior.allowMinecraftBuild, undefined)
  assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowMinecraftBuild: true }).success, false)
  assert.equal(MinecraftSurveyWindowRuleSchema.safeParse({ ...prior, allowMinecraftLogin: undefined, allowMinecraftBuild: true }).success, false)
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...login, allowMinecraftBuild: value }).success, false)
  }
  const building = createSurveyWindow({ ...login, allowMinecraftBuild: true }, now)
  assert.equal(building.allowMinecraftBuild, true)
  assert.equal(building.allowMinecraftSupply, undefined)
  assert.deepEqual(MinecraftSurveyWindowRuleSchema.parse({ ...prior, allowMinecraftBuild: true }), { ...prior, allowMinecraftBuild: true })
})

test('a camp project needs an explicit grant alongside login, supply and building', () => {
  const permissions = { allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true }
  const legacy = createSurveyWindow({ ...input, ...permissions }, now)
  assert.equal(legacy.allowMinecraftProject, undefined)
  const explicit = createSurveyWindow({ ...input, ...permissions, days: 3, allowMinecraftProject: true }, now)
  assert.equal(explicit.allowMinecraftProject, true)
  for (const field of Object.keys(permissions)) {
    const omitted = { [field]: undefined, allowMinecraftProject: true }
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, ...permissions, ...omitted }).success, false, field)
    assert.equal(MinecraftSurveyWindowRuleSchema.safeParse({ ...explicit, ...omitted }).success, false, field)
  }
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, ...permissions, allowMinecraftProject: value }).success, false)
  }
})

test('project gathering requires a separate authorization alongside project and gathering', () => {
  const project = { allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true, allowMinecraftProject: true }
  const separate = createSurveyWindow({ ...input, ...project, allowMinecraftGather: true }, now)
  assert.equal(separate.allowMinecraftProjectGather, undefined)
  const combined = createSurveyWindow({ ...input, ...project, allowMinecraftGather: true, allowMinecraftProjectGather: true }, now)
  assert.equal(combined.allowMinecraftProjectGather, true)
  for (const field of ['allowMinecraftProject', 'allowMinecraftGather']) {
    const incomplete = { ...combined, [field]: undefined }
    assert.equal(MinecraftSurveyWindowRuleSchema.safeParse(incomplete).success, false, field)
    const request = { ...input, ...project, allowMinecraftGather: true, allowMinecraftProjectGather: true, [field]: undefined }
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse(request).success, false, field)
  }
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, ...project, allowMinecraftGather: true, allowMinecraftProjectGather: value }).success, false)
  }
})

test('patrol authorization is separate and requires login while preserving the other choices', () => {
  const project = { allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true, allowMinecraftProject: true }
  const previous = createSurveyWindow({ ...input, ...project, allowBilibili: true }, now)
  assert.equal(previous.allowMinecraftPatrol, undefined)
  const patrol = createSurveyWindow({ ...input, allowMinecraftLogin: true, allowMinecraftPatrol: true }, now)
  assert.equal(patrol.allowMinecraftPatrol, true)
  assert.equal(patrol.allowMinecraftProject, undefined)
  assert.equal(patrol.allowBilibili, undefined)
  assert.deepEqual(MinecraftSurveyWindowRuleSchema.parse({ ...previous, allowMinecraftPatrol: true }), { ...previous, allowMinecraftPatrol: true })
  assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowBilibili: true, allowMinecraftPatrol: true }).success, false)
  assert.equal(MinecraftSurveyWindowRuleSchema.safeParse({ ...patrol, allowMinecraftLogin: undefined }).success, false)
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, ...project, allowMinecraftPatrol: value }).success, false)
  }
})

test('creating at or after closing begins the following local date across month and year boundaries', () => {
  assert.equal(createSurveyWindow(input, local(2026, 11, 9, 19, 0)).expiresAt, local(2026, 11, 10, 19, 0))
  assert.equal(createSurveyWindow({ ...input, days: 3 }, local(2026, 12, 30, 19, 1)).expiresAt, local(2027, 1, 2, 19, 0))
  assert.equal(createSurveyWindow({ ...input, days: 2 }, local(2028, 2, 28, 18, 0)).expiresAt, local(2028, 2, 29, 19, 0))
})

test('the one-day dedupe key accepts canonical calendar dates only', () => {
  assert.equal(surveyWindowKey('2028-02-29'), 'survey-window:2028-02-29')
  assert.equal(isSurveyWindowKey('survey-window:2028-02-29'), true)
  for (const key of ['survey-window:2026-02-29', 'survey-window:2028-02-30', 'survey-window:2028-2-09',
    'survey-window:2028-13-09', 'survey-window:2028-03-09\n', 'wrong:2028-02-29', randomUUID()]) {
    assert.equal(isSurveyWindowKey(key), false, key)
  }
})

test('a different host timezone or invalid clock suppresses window bounds', () => {
  const rule = createSurveyWindow(input, now)
  const anotherZone = rule.timeZone === 'Asia/Tokyo' ? 'Europe/Berlin' : 'Asia/Tokyo'
  assert.equal(surveyWindowDay({ ...rule, timeZone: anotherZone }, now), undefined)
  assert.equal(surveyWindowDay(rule, Number.NaN), undefined)
})

test('a local clock gap never expands consent and a repeated hour has one window', () => {
  const module = new URL('../src/core/minecraft-survey-window.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import { createSurveyWindow, surveyWindowDay } from ${JSON.stringify(module)};
    const input = ${JSON.stringify({ ...input, start: '01:30', end: '02:30' })};
    const springEve = Date.parse('2026-03-07T23:45:00-05:00');
    assert.throws(() => createSurveyWindow(input, springEve), /survey-window-invalid-local-time/u);
    const spring = createSurveyWindow({ ...input, days: 2 }, springEve);
    assert.equal(spring.expiresAt, Date.parse('2026-03-09T02:30:00-04:00'));
    assert.equal(surveyWindowDay(spring, Date.parse('2026-03-08T01:45:00-05:00')), undefined);
    const fall = createSurveyWindow({ ...input, start: '01:00', end: '01:45' }, Date.parse('2026-10-31T23:30:00-04:00'));
    const secondPass = Date.parse('2026-11-01T01:30:00-05:00');
    assert.equal(fall.expiresAt, Date.parse('2026-11-01T01:45:00-04:00'));
    assert.equal(surveyWindowDay(fall, secondPass).closesAt, fall.expiresAt);
    assert.ok(secondPass > fall.expiresAt);
  `
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types', '--input-type=module', '-e', script],
    { env: { TZ: 'America/New_York' } })
})

test('a stored project rule and same-day suppression survive reopen and revoke cleanly', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'survey-window-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const rule = { ...createSurveyWindow({ ...input, houseProjectId: randomUUID() }, now), suppressedDate: '2026-11-09' }
  const first = new CompanionStore(path)
  assert.equal(first.autonomy.surveyWindow(), undefined)
  first.autonomy.saveSurveyWindow(rule)
  first.close()
  const second = new CompanionStore(path)
  try {
    assert.deepEqual(second.autonomy.surveyWindow(), rule)
    assert.throws(() => second.autonomy.saveSurveyWindow({ ...rule, expiresAt: rule.expiresAt + 1 }))
    assert.deepEqual(second.autonomy.surveyWindow(), rule)
    second.autonomy.saveSurveyWindow(null)
    assert.equal(second.autonomy.surveyWindow(), undefined)
  } finally { second.close() }
})

test('invalid persisted JSON and an overextended expiration grant no window', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'survey-window-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const rule = createSurveyWindow(input, now)
  const store = new CompanionStore(path)
  store.autonomy.saveSurveyWindow(rule)
  store.close()
  for (const value of ['{', JSON.stringify({ ...rule, expiresAt: rule.expiresAt + 60_000 }), JSON.stringify({ ...rule, timeZone: 'no/such/zone' })]) {
    const db = new DatabaseSync(path)
    db.prepare('UPDATE state SET value=? WHERE key=?').run(value, 'autonomy.minecraftSurveyWindow')
    db.close()
    const reloaded = new CompanionStore(path)
    try { assert.equal(reloaded.autonomy.surveyWindow(), undefined) } finally { reloaded.close() }
  }
})

test('v24 survey rules stay unchanged and a daily choice persists with a date-unique task identity', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'daily-window-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const legacy = createSurveyWindow(input, now)
  assert.equal(legacy.allowBilibili, undefined)
  for (const value of [false, 'true', 1, null]) {
    assert.equal(MinecraftSurveyWindowInputSchema.safeParse({ ...input, allowBilibili: value }).success, false)
  }
  const first = new CompanionStore(path)
  first.autonomy.saveSurveyWindow(legacy)
  const priorPost = first.feed.create({ author: 'user', body: '旧动态保留' })
  first.close()
  const previousVersion = new DatabaseSync(path)
  // v25 changes only the version guard. The v24 table layout is identical.
  previousVersion.exec('PRAGMA user_version=24')
  previousVersion.close()
  const second = new CompanionStore(path)
  const rule = createSurveyWindow({ ...input, allowBilibili: true }, now)
  const request = { kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: 'daily:2026-11-09', runAfter: now, maxAttempts: 1,
    payload: { ruleId: rule.id } }
  let daily
  try {
    assert.deepEqual(second.autonomy.surveyWindow(), legacy)
    assert.equal(second.feed.get(priorPost.id).body, priorPost.body)
    second.autonomy.saveSurveyWindow(rule)
    daily = second.autonomy.create(request)
    assert.equal(second.autonomy.create(request).id, daily.id)
  } finally { second.close() }
  const reopened = new CompanionStore(path)
  try {
    assert.deepEqual(reopened.autonomy.surveyWindow(), rule)
    assert.equal(reopened.taskByExternalId('autonomy:daily.choice:daily:2026-11-09').id, daily.id)
    assert.deepEqual(reopened.autonomy.get(daily.id), daily)
  } finally { reopened.close() }
  const current = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(current.prepare('PRAGMA user_version').get().user_version, 44)
    assert.equal(current.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(current.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { current.close() }
})

test('v26 Bilibili authorization remains intact without granting Minecraft login on upgrade', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'visit-window-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const oldRule = createSurveyWindow({ ...input, allowBilibili: true }, now)
  const first = new CompanionStore(path)
  first.autonomy.saveSurveyWindow(oldRule)
  first.close()
  const old = new DatabaseSync(path)
  old.exec('PRAGMA user_version=26')
  old.close()
  const upgraded = new CompanionStore(path)
  try {
    assert.deepEqual(upgraded.autonomy.surveyWindow(), oldRule)
    assert.equal(upgraded.autonomy.surveyWindow().allowMinecraftLogin, undefined)
    const newRule = createSurveyWindow({ ...input, allowMinecraftLogin: true }, now)
    upgraded.autonomy.saveSurveyWindow(newRule)
    assert.deepEqual(upgraded.autonomy.surveyWindow(), newRule)
    assert.equal(upgraded.autonomy.surveyWindow().allowBilibili, undefined)
  } finally { upgraded.close() }
})

test('a persisted v27 login window does not acquire supply permission during v28 migration', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'visit-supply-window-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const legacy = createSurveyWindow({ ...input, allowMinecraftLogin: true, allowBilibili: true }, now)
  const store = new CompanionStore(path)
  store.autonomy.saveSurveyWindow(legacy)
  store.close()
  const old = new DatabaseSync(path)
  old.exec('PRAGMA user_version=27')
  old.close()
  const upgraded = new CompanionStore(path)
  try {
    assert.deepEqual(upgraded.autonomy.surveyWindow(), legacy)
    assert.equal(upgraded.autonomy.surveyWindow().allowMinecraftSupply, undefined)
    assert.throws(() => upgraded.autonomy.saveSurveyWindow({ ...legacy, allowMinecraftLogin: undefined, allowMinecraftSupply: true }))
    const explicit = { ...legacy, allowMinecraftSupply: true }
    upgraded.autonomy.saveSurveyWindow(explicit)
    assert.deepEqual(upgraded.autonomy.surveyWindow(), explicit)
  } finally { upgraded.close() }
  const reopened = new CompanionStore(path)
  try { assert.equal(reopened.autonomy.surveyWindow().allowMinecraftSupply, true) }
  finally { reopened.close() }
  const current = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(current.prepare('PRAGMA user_version').get().user_version, 44)
    assert.equal(current.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(current.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { current.close() }
})

test('camp project history reads settled daily decisions for its exact rule, ordered and limited to seven', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'camp-project-days-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['Date'], now })
  const ruleId = randomUUID()
  const another = randomUUID()
  let day = 0
  const create = ({ at = now, contextId = DAILY_AUTONOMY_CONTEXT, kind = 'daily.choice', id = ruleId, status = 'succeeded', mismatched = false } = {}) => {
    t.mock.timers.setTime(at)
    const date = `2026-11-${String(++day).padStart(2, '0')}`
    const job = store.autonomy.create({ kind, contextId, dedupeKey: `daily:${date}`, runAfter: at,
      payload: { windowRuleId: id, date: mismatched ? '2026-11-30' : date } })
    if (status !== 'accepted') {
      store.transitionTask(job.id, 'running')
      store.transitionTask(job.id, status)
    }
    return job
  }
  for (const options of [{ status: 'accepted' }, { contextId: 'chat.mobile' }, { kind: 'minecraft.supply' },
    { id: another }, { id: ruleId.toUpperCase() }, { mismatched: true }]) create(options)
  const candidates = [7, 3, 1, 4, 0, 4, 6, 2, 5].map(offset => create({ at: now + offset * 1000 }))
  candidates.push(create({ status: 'failed' }), create({ at: now + 1000, status: 'cancelled' }))
  const expected = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, 7).map(job => job.id)
  const days = store.autonomy.campProjectDays(ruleId)
  assert.deepEqual(days.map(job => job.id), expected)
  assert.deepEqual(new Set(days.map(day => day.task.status)), new Set(['succeeded', 'failed', 'cancelled']))
  assert.ok(days.every(day => day.payload.windowRuleId === ruleId))
  assert.equal(store.autonomy.campProjectDays(another).length, 1)
})

test('latest camp patrol preserves the last authenticated daily visit across rule revocation', t => {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'camp-patrol-days-'))
  const path = join(directory, 'store.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['Date'], now })
  const rule = createSurveyWindow({ ...input, allowMinecraftLogin: true, allowMinecraftPatrol: true }, now)
  store.autonomy.saveSurveyWindow(rule)
  assert.equal(store.autonomy.latestCampPatrol(), undefined)
  let day = 0
  const create = ({ contextId = DAILY_AUTONOMY_CONTEXT, kind = 'daily.choice', payload = {}, status = 'running' } = {}) => {
    const date = `2026-11-${String(++day).padStart(2, '0')}`
    t.mock.timers.setTime(now + day * 1000)
    const job = store.autonomy.create({ kind, contextId, dedupeKey: `daily:${date}`, runAfter: now })
    store.autonomy.update(job.id, { payload: { windowRuleId: rule.id, date, choice: 'patrol', visitId: job.id,
      visitStatus: 'online', visitExpiresAt: now + 60_000, ...payload } })
    store.transitionTask(job.id, 'running')
    if (status !== 'running') store.transitionTask(job.id, status)
    return job.id
  }
  create({ status: 'succeeded', payload: { visitStatus: 'offline' } })
  const latest = create()
  assert.equal(store.autonomy.latestCampPatrol()?.id, latest)
  assert.equal(store.autonomy.latestCampPatrol()?.task.status, 'running')
  const payload = store.autonomy.latestCampPatrol().payload
  store.autonomy.update(latest, { payload: { ...payload, visitStatus: 'unconfirmed' } })
  store.transitionTask(latest, 'cancelled')
  for (const options of [
    { contextId: 'chat.mobile' }, { kind: 'minecraft.supply' },
    ...[{ choice: 'build' }, { visitId: randomUUID() }, { visitStatus: 'invalid' },
      { visitExpiresAt: 0 }, { visitExpiresAt: '60000' }, { date: '2026-11-29' }].map(payload => ({ payload })),
  ]) create(options)
  store.autonomy.saveSurveyWindow(null)
  assert.equal(store.autonomy.surveyWindow(), undefined)
  const reopened = new CompanionStore(path)
  try {
    const last = reopened.autonomy.latestCampPatrol()
    assert.equal(last.id, latest)
    assert.equal(last.task.status, 'cancelled')
    assert.equal(last.payload.visitStatus, 'unconfirmed')
  } finally { reopened.close() }
})
