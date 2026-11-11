import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'

async function fixture(t) {
  await mkdir('.work', { recursive: true })
  const dir = await mkdtemp(resolve('.work/device-notices-'))
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  let handler
  let origin
  const ctx = { webServer: { getOrigin: () => origin, register: route => {
    if (route.path === '/companion-device/api') handler = route.handler
    return () => {}
  } } }
  const devices = new DeviceService(ctx, store)
  const dispose = registerDeviceHttp(ctx, { store, view: () => ({ schemaVersion: 2, pluginVersion: 'fixture' }) }, devices)
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    dispose()
    devices.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const base = `${origin}/companion-device/api/`
  const get = (path, device) => fetch(base + path, { headers: device && { authorization: device.credential } })
  const post = (path, body, device) => fetch(base + path, {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...(device && { authorization: device.credential }) },
  })
  const pair = async name => {
    const offer = devices.createOffer({ name, routes: [origin] })
    const response = await post('pair', JSON.stringify({ p: offer.link }))
    assert.equal(response.status, 201)
    return response.json()
  }
  const read = (input, device) => post('notices/read', JSON.stringify(input), device)
  const addChat = dedupe => store.notices.add({ kind: 'chat-reply' }, dedupe)
  return { base, get, post, pair, read, addChat, store, devices }
}

async function json(response, status = 200) {
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return result
}

const summary = unread => ({ version: 1, unread })

test('paired notice pages and exact or through acknowledgements are scoped to the authenticated device', async t => {
  const h = await fixture(t)
  h.addChat('pre-pair')
  const phone = await h.pair('Phone')
  assert.deepEqual(await json(await h.get('state', phone)), {
    schemaVersion: 2, pluginVersion: 'fixture', notices: summary(0), chatSend: { version: 1 },
  })
  h.addChat('phone-only')
  const tablet = await h.pair('Tablet')
  const parent = h.store.feed.create({ author: 'user', body: 'user fixture private body' })
  const reply = h.store.feed.create({ author: 'companion', parentId: parent.id, body: 'companion fixture private body' })
  h.store.notices.add({ kind: 'feed-reply', postId: parent.id, replyId: reply.id }, 'shared-reply')
  assert.equal((await h.get('notices')).status, 401)
  assert.equal((await h.read({ through: 1 })).status, 401)
  const first = await json(await h.get('notices?limit=1', phone))
  assert.equal(first.version, 1)
  assert.equal(first.unread, 2)
  assert.equal(first.items.length, 1)
  const [newest] = first.items
  assert.equal(first.nextBefore, newest.id)
  assert.deepEqual(newest, {
    id: newest.id, occurredAt: newest.occurredAt, read: false,
    kind: 'feed-reply', postId: parent.id, replyId: reply.id,
  })
  assert.ok(Number.isFinite(Date.parse(newest.occurredAt)))
  const second = await json(await h.get(`notices?before=${first.nextBefore}&limit=1`, phone))
  assert.equal(second.items.length, 1)
  assert.equal(second.nextBefore, undefined)
  const [older] = second.items
  assert.deepEqual(Object.keys(older).sort(), ['id', 'kind', 'occurredAt', 'read'])
  assert.equal(older.kind, 'chat-reply')
  assert.equal(older.read, false)
  assert.equal((await json(await h.get('notices', tablet))).unread, 1)
  assert.equal((await json(await h.read({ id: older.id }, tablet), 404)).code, 'notice-not-found')
  assert.deepEqual(await json(await h.read({ id: newest.id }, phone)), summary(1))
  assert.deepEqual(await json(await h.read({ id: newest.id }, phone)), summary(1))
  assert.deepEqual(await json(await h.read({ through: newest.id }, tablet)), summary(0))
  assert.deepEqual((await json(await h.get('state', phone))).notices, summary(1))
  assert.deepEqual((await json(await h.get('state', tablet))).notices, summary(0))
  assert.deepEqual((await json(await h.get('notices', phone))).items.map(item => item.read), [true, false])
  assert.deepEqual(await json(await h.read({ through: newest.id }, phone)), summary(0))
})

test('notice queries and writes reject ambiguous input and do not advance beyond visible IDs', async t => {
  const h = await fixture(t)
  const phone = await h.pair('Phone')
  h.addChat('initial')
  const [item] = (await json(await h.get('notices', phone))).items
  for (const query of [
    '?before=0', '?before=1e2', '?before=01', '?before=1.0', '?before=1%0A', '?before=9007199254740992',
    '?before=1&before=2', '?limit=1&limit=2', '?limit=0', '?limit=51', '?limit=', '?deviceId=other',
  ]) {
    assert.equal((await json(await h.get(`notices${query}`, phone), 400)).code, 'invalid-request', query)
  }
  for (const body of [
    '{}', '[]', 'null', '{"id":"1"}', '{"id":1.5}', '{"through":0}', '{"id":9007199254740992}',
    '{"id":1,"id":2}', '{"through":1,"throu\\u0067h":2}', '{"id":1,"through":2}',
    '{"id":1,"deviceId":"other"}', '{"id":1,"__proto__":0}',
  ]) {
    assert.equal((await json(await h.post('notices/read', body, phone), 400)).code, 'invalid-request', body)
  }
  assert.equal((await json(await h.post('notices/read', '{"id":', phone), 400)).code, 'invalid-json')
  assert.equal((await json(await h.post('notices/read', ' '.repeat(1025), phone), 400)).code, 'body-too-large')
  assert.equal((await json(await h.post('notices/read?deviceId=other', '{"id":1}', phone), 400)).code, 'invalid-request')
  assert.deepEqual((await json(await h.get(`notices?before=${Number.MAX_SAFE_INTEGER}&limit=50`, phone))).items, [item])
  assert.equal((await json(await h.read({ id: item.id + 1 }, phone), 404)).code, 'notice-not-found')
  assert.equal((await json(await h.read({ through: item.id + 1 }, phone), 404)).code, 'notice-not-found')
  h.addChat('next')
  assert.deepEqual((await json(await h.get('state', phone))).notices, summary(2))

  for (let index = 0; index < 200; index++) h.addChat(`retention-${index}`)
  assert.deepEqual((await json(await h.get(`notices?before=${item.id}`, phone))).items, [])
  assert.equal((await json(await h.read({ id: item.id }, phone), 404)).code, 'notice-not-found')
  assert.equal((await json(await h.read({ through: item.id }, phone), 404)).code, 'notice-not-found')
})

test('notice read reauthenticates after body upload and a revoked device cannot read state or pages', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const phone = await h.pair('Phone')
  h.addChat('pending-read')
  const [item] = (await json(await h.get('notices', phone))).items
  const admitted = Promise.withResolvers()
  const authenticate = h.devices.authenticate.bind(h.devices)
  t.mock.method(h.devices, 'authenticate', req => {
    const device = authenticate(req)
    admitted.resolve()
    return device
  })
  const mark = t.mock.method(h.store.notices, 'markRead')
  const body = JSON.stringify({ id: item.id })
  const complete = Promise.withResolvers()
  const req = httpRequest(`${h.base}notices/read`, {
    method: 'POST', headers: { authorization: phone.credential, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, response => {
    response.resume()
    complete.resolve(response.statusCode)
  }).once('error', complete.reject)
  req.flushHeaders()
  await admitted.promise
  assert.ok(h.devices.revoke(phone.device.id))
  req.end(body)
  assert.equal(await complete.promise, 401)
  assert.equal(mark.mock.callCount(), 0)
  assert.equal((await h.get('notices', phone)).status, 401)
  assert.equal((await h.get('state', phone)).status, 401)
})
