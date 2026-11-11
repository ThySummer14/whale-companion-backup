import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MINECRAFT_RECOVERY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync(join('.work', 'minecraft-recovery-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'companion.sqlite')
}

test('recovery is opt-in for fresh, legacy and invalid settings and persists independently', t => {
  const path = fixture(t)
  const store = new CompanionStore(path)
  try {
    assert.equal(store.autonomy.settings().minecraftRecoveryEnabled, false)
    assert.equal(store.autonomy.settings().minecraftRecoveryPlacementEnabled, false)
    assert.equal(store.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
    const legacy = { ...store.autonomy.settings(), minecraftMilestonesEnabled: true, memoryReview: false, feedEnabled: false }
    delete legacy.minecraftRecoveryEnabled
    delete legacy.minecraftRecoveryPlacementEnabled
    delete legacy.minecraftRecoveryContinuousEnabled
    const db = new DatabaseSync(path)
    try {
      const write = db.prepare("INSERT INTO state VALUES ('autonomy.settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      write.run(JSON.stringify(legacy))
      assert.equal(store.autonomy.settings().minecraftRecoveryEnabled, false)
      assert.equal(store.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
      for (const invalid of [null, 'true', 1, {}]) {
        write.run(JSON.stringify({ ...legacy, minecraftRecoveryEnabled: invalid, minecraftRecoveryPlacementEnabled: invalid,
          minecraftRecoveryContinuousEnabled: invalid }))
        assert.equal(store.autonomy.settings().minecraftRecoveryEnabled, false)
        assert.equal(store.autonomy.settings().minecraftRecoveryPlacementEnabled, false)
        assert.equal(store.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
      }
    } finally { db.close() }
    store.autonomy.saveSettings({ ...legacy, minecraftRecoveryEnabled: 'true' })
    assert.equal(store.autonomy.settings().minecraftRecoveryEnabled, false)
    store.autonomy.saveSettings({ ...legacy, minecraftRecoveryEnabled: true })
    assert.equal(store.autonomy.settings().minecraftRecoveryPlacementEnabled, false)
    store.autonomy.saveSettings({ ...store.autonomy.settings(), minecraftRecoveryPlacementEnabled: true })
    assert.equal(store.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
    store.autonomy.saveSettings({ ...store.autonomy.settings(), minecraftRecoveryContinuousEnabled: 'true' })
    assert.equal(store.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
    store.autonomy.saveSettings({ ...store.autonomy.settings(), minecraftRecoveryContinuousEnabled: true })
  } finally { store.close() }

  const reopened = new CompanionStore(path)
  try {
    assert.equal(reopened.autonomy.settings().minecraftRecoveryEnabled, true)
    assert.equal(reopened.autonomy.settings().minecraftRecoveryPlacementEnabled, true)
    assert.equal(reopened.autonomy.settings().minecraftRecoveryContinuousEnabled, true)
    assert.equal(reopened.autonomy.settings().minecraftMilestonesEnabled, true)
    assert.equal(reopened.autonomy.settings().memoryReview, false)
    assert.equal(reopened.autonomy.settings().feedEnabled, false)
  } finally { reopened.close() }
})

test('v39 upgrade retains prior recovery and single placement without granting continuous placement', t => {
  const path = fixture(t)
  const store = new CompanionStore(path)
  const when = Date.parse('2026-11-10T00:00:00.000Z')
  const legacy = { ...store.autonomy.settings(), memoryReview: false, minecraftRecoveryEnabled: true, minecraftRecoveryPlacementEnabled: true }
  delete legacy.minecraftRecoveryContinuousEnabled
  const job = store.autonomy.create({ kind: 'minecraft.event', contextId: 'game.minecraft', dedupeKey: 'prior-event', runAfter: when })
  store.close()

  const prior = new DatabaseSync(path)
  let schema, settings
  try {
    prior.exec('PRAGMA user_version=39')
    prior.prepare('INSERT INTO state VALUES (?,?)').run('autonomy.settings', JSON.stringify(legacy))
    schema = prior.prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name').all()
    settings = prior.prepare("SELECT value FROM state WHERE key='autonomy.settings'").get().value
  } finally { prior.close() }

  const upgraded = new CompanionStore(path)
  try {
    assert.deepEqual(upgraded.autonomy.get(job.id), job)
    assert.equal(upgraded.autonomy.settings().minecraftRecoveryEnabled, true)
    assert.equal(upgraded.autonomy.settings().minecraftRecoveryPlacementEnabled, true)
    assert.equal(upgraded.autonomy.settings().minecraftRecoveryContinuousEnabled, false)
    assert.equal(upgraded.autonomy.settings().memoryReview, false)
    assert.deepEqual(upgraded.autonomy.open('minecraft.recovery', MINECRAFT_RECOVERY_CONTEXT), [])
  } finally { upgraded.close() }

  const after = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 43)
    assert.deepEqual(after.prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name').all(), schema)
    assert.equal(after.prepare("SELECT value FROM state WHERE key='autonomy.settings'").get().value, settings)
    assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(after.prepare('SELECT count(*) AS count FROM minecraft_house_recovery_cell').get().count, 0)
  } finally { after.close() }
})

test('recovery work uses a distinct durable title, context and external id', t => {
  const path = fixture(t)
  const store = new CompanionStore(path)
  try {
    const when = Date.parse('2026-11-10T00:00:00.000Z')
    const job = store.autonomy.create({ kind: 'minecraft.recovery', contextId: MINECRAFT_RECOVERY_CONTEXT,
      dedupeKey: 'failed-house-task', runAfter: when, maxAttempts: 1, payload: { sourceTaskId: 'failed-house-task' } })
    assert.equal(job.task.title, '判断小屋施工中断后的下一步')
    assert.equal(job.task.externalId, 'autonomy:minecraft.recovery:failed-house-task')
    assert.equal(job.contextId, 'autonomy.minecraft-recovery')
    assert.equal(job.maxAttempts, 1)
    assert.equal(store.autonomy.due(when - 1), undefined)
    assert.deepEqual(store.autonomy.due(when), job)
  } finally { store.close() }
})
