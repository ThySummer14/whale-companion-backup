import assert from 'node:assert/strict'
import test from 'node:test'
import { DevicePlaybackService } from '../src/host/device-playback.ts'

const CLIENT = '1'.repeat(32)
const OTHER_CLIENT = '2'.repeat(32)
const idle = { speaking: false, singing: false }
const speech = { speaking: true, singing: false }
const song = { speaking: false, singing: true }
const grant = (service, device = 'phone', kind = 'speaking', client = CLIENT) =>
  service.issue(device, client, kind)['x-companion-playback-id']

test('download is silent and receipts are scoped to the paired device', () => {
  const service = new DevicePlaybackService()
  for (const client of [undefined, [CLIENT], 'too-short', 'G'.repeat(32)]) {
    assert.deepEqual(service.issue('phone', client, 'speaking'), {})
  }
  const id = grant(service)
  assert.match(id, /^[a-f0-9-]{36}$/u)
  assert.deepEqual(service.activity(0), idle)
  assert.equal(service.report('other', id, 1, 'playing', 0), false)
  assert.equal(service.report('phone', 'unknown', 1, 'playing', 0), false)
  assert.equal(service.report('phone', id, 1, 'playing', 0), true)
  assert.deepEqual(service.activity(1), speech)
})

test('start, heartbeat, connection loss and reconnection use a bounded lease', () => {
  const service = new DevicePlaybackService()
  const id = grant(service)
  service.report('phone', id, 1, 'playing', 0)
  service.report('phone', id, 1, 'playing', 2000)
  assert.deepEqual(service.activity(6499), speech)
  assert.deepEqual(service.activity(8499), speech)
  assert.deepEqual(service.activity(8500), idle)
  service.report('phone', id, 1, 'playing', 9000)
  assert.deepEqual(service.activity(9001), speech)
})

test('pause and stop win over out-of-order heartbeats, while resume and replay get new sequences', () => {
  const service = new DevicePlaybackService()
  const id = grant(service)
  service.report('phone', id, 1, 'paused', 0)
  service.report('phone', id, 1, 'playing', 1)
  assert.deepEqual(service.activity(2), idle)
  service.report('phone', id, 2, 'playing', 3)
  service.report('phone', id, 1, 'stopped', 4)
  assert.deepEqual(service.activity(5), speech)
  service.report('phone', id, 2, 'stopped', 6)
  service.report('phone', id, 2, 'playing', 7)
  assert.deepEqual(service.activity(8), idle)
  service.report('phone', id, 3, 'playing', 9)
  assert.deepEqual(service.activity(10), speech)
})

test('different sources on the same phone share native start ordering', () => {
  const service = new DevicePlaybackService()
  const voice = grant(service)
  const music = grant(service, 'phone', 'singing')
  service.report('phone', voice, 1, 'playing', 0)
  assert.deepEqual(service.activity(0), speech)
  service.report('phone', music, 2, 'playing', 1)
  service.report('phone', voice, 1, 'playing', 2)
  service.report('phone', voice, 1, 'stopped', 3)
  assert.deepEqual(service.activity(4), song)
  service.report('phone', music, 2, 'stopped', 5)
  service.report('phone', voice, 1, 'playing', 6)
  assert.deepEqual(service.activity(7), idle)
  service.report('phone', voice, 3, 'playing', 8)
  assert.deepEqual(service.activity(9), speech)
})

test('separate paired devices remain independent through revocation and shutdown', () => {
  const service = new DevicePlaybackService()
  const voice = grant(service)
  const music = grant(service, 'tablet', 'singing')
  service.report('phone', voice, 1, 'playing', 0)
  service.report('tablet', music, 1, 'playing', 0)
  assert.deepEqual(service.activity(1), { speaking: true, singing: true })
  service.revoke('phone')
  assert.deepEqual(service.activity(2), song)
  assert.equal(service.report('phone', voice, 1, 'playing', 2), false)
  service.close()
  assert.deepEqual(service.activity(3), idle)
  assert.equal(service.report('tablet', music, 1, 'playing', 3), false)
})

test('old grants are bounded, active grants survive preloads, and a new app process resets ordering', () => {
  const service = new DevicePlaybackService()
  const active = grant(service)
  const old = grant(service)
  service.report('phone', active, 50, 'playing', 0)
  for (let i = 0; i < 20; i++) grant(service)
  assert.equal(service.report('phone', old, 51, 'playing', 1), false)
  assert.equal(service.report('phone', active, 50, 'playing', 2), true)
  assert.deepEqual(service.activity(3), speech)
  const fresh = grant(service, 'phone', 'singing', OTHER_CLIENT)
  assert.equal(service.report('phone', active, 52, 'playing', 4), false)
  assert.deepEqual(service.activity(4), idle)
  assert.equal(service.report('phone', fresh, 1, 'playing', 5), true)
  assert.deepEqual(service.activity(5), song)
})
