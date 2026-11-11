import assert from 'node:assert/strict'
import test from 'node:test'
import { offlineMinecraftProfile } from '../apps/minecraft-worker/offline.ts'

const input = { enabled: true, ovoRoot: '/private/ovo', gameHost: '127.0.0.1', botName: 'dafeiyu', owner: 'thyysummer' }

test('offline test identity is deterministic and distinct from the owner', () => {
  const profile = offlineMinecraftProfile(input)
  assert.deepEqual(profile, offlineMinecraftProfile(input))
  assert.match(profile.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.notEqual(profile.name, input.owner)
  assert.deepEqual(offlineMinecraftProfile({ ...input, gameHost: '::1' }), profile)
  assert.deepEqual(offlineMinecraftProfile({ ...input, gameHost: 'localhost' }), profile)
})

test('offline authentication requires OVO and a loopback server', () => {
  assert.equal(offlineMinecraftProfile({ ...input, enabled: false, gameHost: 'mc.example.net', ovoRoot: undefined }), undefined)
  for (const patch of [{ ovoRoot: undefined }, { ovoRoot: '' }, { gameHost: 'mc.example.net' }, { gameHost: '100.64.0.1' }, { gameHost: '0.0.0.0' }]) {
    assert.throws(() => offlineMinecraftProfile({ ...input, ...patch }), /offline-requires-loopback-ovo/u)
  }
  assert.throws(() => offlineMinecraftProfile({ ...input, botName: 'ThyySummer' }), /primary-account-refused/u)
})
