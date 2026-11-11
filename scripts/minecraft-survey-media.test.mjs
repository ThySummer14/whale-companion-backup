import assert from 'node:assert/strict'
import crypto, { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MINECRAFT_SHARE_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { DeviceMediaService } from '../src/host/device-media.ts'
import { MediaService } from '../src/host/media.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const NOOP = () => {}

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/minecraft-survey-media-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const root = join(directory, 'media')
  const images = join(root, 'images')
  const devices = new DeviceMediaService(store, root)
  const media = new MediaService(store, root)
  t.after(async () => { await media.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const task = store.createTask({ capabilityId: 'minecraft.survey', contextId: 'game.minecraft', title: 'Survey' })
  store.transitionTask(task.id, 'running')
  store.transitionTask(task.id, 'succeeded')
  const post = mediaId => store.feed.create({ author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, body: '勘察完成。', sourceTaskId: task.id, mediaId })
  return { store, images, devices, media, task, post }
}

test('survey media and its post commit together and survive verified scans', async t => {
  const { devices, store, task, post, media } = fixture(t)
  const published = await devices.attachGeneratedSurveyCard(PNG, task.id, NOOP, post)
  assert.equal(store.feed.bySourceTask(task.id).mediaId, published.mediaId)
  const before = store.media.get(published.mediaId)
  assert.match(before.path, /^images\/survey-[0-9a-f-]{36}\.png$/u)
  assert.equal(before.hash, createHash('sha256').update(PNG).digest('hex'))
  assert.equal(before.source, 'minecraft-survey-card')
  assert.equal(before.sourceRef, task.id)
  assert.equal(before.retention, 'keep')
  assert.equal(before.mimeType, 'image/png')
  assert.equal(before.bytes, PNG.length)
  await media.refresh()
  const { lastVerifiedAt, ...asset } = store.media.get(published.mediaId)
  const { lastVerifiedAt: originalVerification, ...original } = before
  assert.ok(lastVerifiedAt >= originalVerification)
  assert.deepEqual(asset, original)
  assert.deepEqual(readFileSync((await devices.content(published.mediaId)).path), PNG)
})

test('expired guards and persistence errors roll back only the attempted attachment', async t => {
  const { devices, store, task, images, post } = fixture(t)
  const existing = await devices.upload({ mimeType: 'image/png', dataBase64: PNG.toString('base64') })
  let checks = 0
  await assert.rejects(devices.attachGeneratedSurveyCard(PNG, task.id, () => {
    if (++checks !== 2) return
    assert.equal(readdirSync(images).length, 2)
    throw new Error('stale authorization')
  }, () => assert.fail('guard must prevent publication')), /stale authorization/u)
  assert.equal(checks, 2)
  assert.equal(readdirSync(images).length, 1)
  await assert.rejects(devices.attachGeneratedSurveyCard(PNG, task.id, NOOP, id => {
    assert.equal(store.media.get(id).sourceRef, task.id)
    assert.equal(store.feed.get(post(id).id).mediaId, id)
    throw new Error('publication rolled back')
  }), /publication rolled back/u)
  assert.deepEqual(store.media.all().map(asset => asset.id), [existing.id])
  assert.equal(store.feed.bySourceTask(task.id), undefined)
  assert.equal(readdirSync(images).length, 1)
  assert.deepEqual(readFileSync((await devices.content(existing.id)).path), PNG)
})

test('a generated path collision leaves the preexisting file in place', async t => {
  const { devices, store, task, images, post } = fixture(t)
  const id = randomUUID()
  mkdirSync(images, { recursive: true })
  const path = join(images, `survey-${id}.png`)
  writeFileSync(path, 'preexisting')
  const mock = t.mock.method(crypto, 'randomUUID', () => id)
  syncBuiltinESMExports()
  try {
    await assert.rejects(devices.attachGeneratedSurveyCard(PNG, task.id, NOOP, post), { code: 'EEXIST' })
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(path, 'utf8'), 'preexisting')
  assert.deepEqual(store.media.all(), [])
  assert.equal(store.feed.bySourceTask(task.id), undefined)
})

test('tampered survey media is never reindexed as a new image', async t => {
  const { devices, store, task, post, media } = fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const published = await devices.attachGeneratedSurveyCard(PNG, task.id, NOOP, post)
  const { path, asset } = await devices.content(published.mediaId)
  const replacement = Buffer.from(PNG)
  replacement[replacement.length - 1] ^= 1
  writeFileSync(path, replacement)
  await assert.rejects(devices.content(published.mediaId), { status: 409, code: 'image-changed' })
  t.mock.timers.tick(1000)
  await media.refresh()
  const invalid = store.media.get(published.mediaId)
  assert.ok(invalid.missingAt)
  assert.equal(invalid.sourceRef, task.id)
  assert.equal(invalid.hash, asset.hash)
  assert.equal(invalid.bytes, asset.bytes)
  await assert.rejects(devices.content(published.mediaId), { status: 404, code: 'image-not-found' })
  writeFileSync(path, PNG)
  await media.refresh()
  assert.equal(store.media.get(published.mediaId).missingAt, undefined)
})

test('only aged crash remnants enter the ordinary cleanup flow and never paired image access', async t => {
  const { devices, store, images, media } = fixture(t)
  mkdirSync(images, { recursive: true })
  const fresh = `survey-${randomUUID()}.png`
  const stale = `survey-${randomUUID()}.png`
  writeFileSync(join(images, fresh), PNG)
  writeFileSync(join(images, stale), PNG)
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
  utimesSync(join(images, stale), threeDaysAgo, threeDaysAgo)
  await media.refresh()
  const [orphan] = store.media.all()
  assert.equal(store.media.all().length, 1)
  assert.equal(orphan.path, `images/${stale}`)
  assert.equal(orphan.kind, 'other')
  assert.equal(orphan.source, 'minecraft-survey-card-orphan')
  assert.equal(orphan.retention, 'cache')
  assert.deepEqual(devices.list(), [])
  await assert.rejects(devices.content(orphan.id), { status: 404, code: 'image-not-found' })
  assert.ok(existsSync(join(images, stale)))
  assert.deepEqual((await media.cleanup(1)).deleted.map(asset => asset.id), [orphan.id])
  assert.equal(existsSync(join(images, stale)), false)
  assert.ok(existsSync(join(images, fresh)))
})

test('generated media rejects unbounded or invalid inputs before allocating a file', async t => {
  const { devices, store, images, task, post } = fixture(t)
  const oversized = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])
  const wide = Buffer.from(PNG)
  wide.writeUInt32BE(2049, 16)
  await assert.rejects(devices.attachGeneratedSurveyCard(PNG, 'arbitrary', NOOP, post), /source task/u)
  await assert.rejects(devices.attachGeneratedSurveyCard(PNG.subarray(0, 32), task.id, NOOP, post), /survey card PNG/u)
  await assert.rejects(devices.attachGeneratedSurveyCard(oversized, task.id, NOOP, post), /survey card PNG/u)
  await assert.rejects(devices.attachGeneratedSurveyCard(wide, task.id, NOOP, post), /survey card dimensions/u)
  assert.equal(existsSync(images), false)
  assert.deepEqual(store.media.all(), [])
})
