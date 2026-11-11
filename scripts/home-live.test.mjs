import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { communitySiteFor } from '../src/core/community.ts'
import { projectHomeStatus } from '../src/core/home.ts'
import { CompanionStore } from '../src/core/store.ts'
import { deviceContextAllowed } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { EventHub } from '../src/host/events.ts'

const path = '/companion-device/api/events'
const transitions = [
  ['resting', 'bed', 'home', { quiet: true }],
  ['chatting', 'sofa', 'home', { runningSessions: new Set(['phone-root']) }],
  ['browsing', 'phone', 'library', { browsing: true }],
  ['speaking', 'stage', 'studio', { speaking: true }],
  ['singing', 'stage', 'studio', { singing: true }],
  ['minecraft', 'desk', 'camp', { minecraft: true, singing: true }],
  ['offline', 'none', null, { presence: 'offline' }],
  ['idle', 'window', 'home', {}],
]

async function fixture(t, available = true) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/home-live-test-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const ctx = { webServer: { getOrigin: () => base, registerUpgrade: route => {
    server.on('upgrade', route.handler)
    return () => server.off('upgrade', route.handler)
  } } }
  const devices = new DeviceService(ctx, store)
  let observation = {}
  let samples = 0
  const sample = () => {
    samples++
    const home = projectHomeStatus({ presence: 'idle', minecraft: false, speaking: false, quiet: false,
      bindings: [{ kind: 'chat', contextId: 'chat.mobile', sessionId: 'phone-root' }], runningSessions: new Set(), now: new Date(), ...observation })
    return { ...home, activeSite: communitySiteFor(home.activity) }
  }
  const hub = new EventHub(ctx, store, { path, authorize: req => devices.authorize(req), onConnection: (socket, req) => devices.track(req, socket),
    contextAllowed: deviceContextAllowed, ...(available && { homeLive: sample }) })
  store.recordActivity({ source: 'fixture', kind: 'test.activity', summary: 'legacy history remains on the normal stream' })
  hub.start()
  const pair = devices.redeem(devices.createOffer({ name: 'Home fixture', routes: [base] }).link)
  const sockets = []
  function open(query = '?view=home', credential = pair.credential) {
    const socket = new WebSocket(base.replace('http', 'ws') + path + query, { headers: { authorization: credential } })
    sockets.push(socket)
    const frames = []
    socket.on('message', raw => frames.push(JSON.parse(String(raw))))
    return { socket, frames }
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    hub.close()
    devices.close()
    await new Promise(resolve => server.close(resolve))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { open, pair, devices, samples: () => samples, state: value => { observation = value } }
}

async function until(check, timeout = 1600) {
  const deadline = Date.now() + timeout
  do {
    const result = check()
    if (result) return result
    await delay(20)
  } while (Date.now() < deadline)
  assert.fail('Expected Home stream observation')
}

test('home socket requires pairing and an exclusive read-only view', async t => {
  for (const [label, query, credential, supported] of [
    ['missing credential', '?view=home', '', true], ['unknown credential', '?view=home', 'Device not-a-credential', true],
    ['mixed context', '?view=home&contextId=chat.mobile', undefined, true], ['mixed cursor', '?view=home&cursor=1', undefined, true],
    ['old host', '?view=home', undefined, false],
  ]) await t.test(label, async t => {
    const h = await fixture(t, supported)
    const { socket } = h.open(query, credential)
    socket.on('error', () => {})
    const [_, response] = await once(socket, 'unexpected-response')
    response.resume()
    assert.equal(response.statusCode, 403)
    assert.equal(h.samples(), 0)
  })
})

test('only Home clients get fresh bounded states, with no history or session metadata', async t => {
  const h = await fixture(t)
  const legacy = h.open('')
  await until(() => legacy.frames.some(frame => frame.type === 'stream.replay.complete'))
  assert.equal(h.samples(), 0)
  assert.ok(legacy.frames.some(frame => frame.payload.summary === 'legacy history remains on the normal stream'))
  const current = h.open()
  await until(() => current.frames.length === 1)
  assert.equal(current.frames[0].payload.activity, 'idle')
  for (const [activity, anchor, site, source] of transitions) await t.test(activity, async () => {
    h.state(source)
    const frame = await until(() => current.frames.at(-1)?.payload.activity === activity && current.frames.at(-1))
    assert.equal(frame.type, 'home.live')
    assert.equal(frame.cursor, null)
    assert.equal(frame.contextId, undefined)
    assert.equal(frame.sessionId, undefined)
    assert.deepEqual(frame.payload, { version: 1, activity, anchor, activeSite: site, observedAt: frame.occurredAt })
    assert.ok(Number.isFinite(Date.parse(frame.occurredAt)))
  })
  const at = new Date(Date.now() - 200).toISOString()
  h.state({ reflectionAt: at })
  await until(() => current.frames.at(-1)?.payload.journal?.state === 'reflecting')
  assert.deepEqual(current.frames.at(-1).payload.journal, { state: 'reflecting', at })
  assert.ok(!legacy.frames.some(frame => frame.type === 'home.live'))
  assert.ok(current.frames.every(frame => frame.type === 'home.live'))
  const reconnect = h.open()
  await until(() => reconnect.frames.length === 1)
  assert.deepEqual(reconnect.frames[0].payload.journal, { state: 'reflecting', at })
  const closed = once(reconnect.socket, 'close')
  reconnect.socket.send('{"cursor":0}')
  assert.equal((await closed)[0], 1008)
  const revoked = once(current.socket, 'close')
  assert.equal(h.devices.revoke(h.pair.device.id), true)
  await revoked
})

test('unchanged state is coalesced and refreshed by the socket heartbeat', { timeout: 14_000 }, async t => {
  const h = await fixture(t)
  const current = h.open()
  await until(() => current.frames.length === 1)
  await delay(600)
  assert.equal(current.frames.length, 1)
  await until(() => current.frames.length === 2, 10_000)
  assert.equal(current.frames[1].payload.activity, 'idle')
  assert.notEqual(current.frames[0].occurredAt, current.frames[1].occurredAt)
})
