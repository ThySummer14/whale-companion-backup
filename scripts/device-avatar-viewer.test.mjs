import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { AvatarService } from '../src/host/avatar.ts'
import { DeviceAvatarViewer } from '../src/host/device-avatar-http.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { PresenterService } from '../src/host/presenter.ts'

const page = '/companion-device/avatar/'
const api = '/companion-device/api/'
const texturePath = '大肥鱼.4096/texture_00.png'

async function fixture(t, { enabled = true, complete = true } = {}) {
  await mkdir('.work', { recursive: true })
  const directory = await mkdtemp(resolve('.work/device-avatar-'))
  const assetRoot = join(directory, 'private')
  const stageRoot = join(directory, 'stage')
  const files = {
    'stage/index.html': '<canvas></canvas>', 'stage/device-presenter.html': '<canvas aria-label="Mobile Live2D"></canvas>',
    'stage/presenter.mjs': 'export const ready = true', 'stage/stage.mjs': 'private controller',
    'private/data/model-profile.json': '{"parameters":[]}', 'private/vendor/live2dcubismcore.min.js': '// private Core fixture',
    'private/model/大肥鱼.model3.json': JSON.stringify({ FileReferences: {
      Moc: '大肥鱼.moc3', Textures: [texturePath], Physics: '大肥鱼.physics3.json',
    } }),
    'private/model/大肥鱼.moc3': 'fixture moc', 'private/model/大肥鱼.physics3.json': '{}',
    'private/model/Exp3/脸红.exp3.json': '{}', 'private/model/Animation/竖手指切出来动画.motion3.json': '{"Meta":{"Duration":1.3}}',
    'private/model/private.json': 'unreferenced data', 'private/outside.png': 'outside data',
    ...(complete && { [`private/model/${texturePath}`]: 'approved fixture texture' }),
  }
  for (const [path, contents] of Object.entries(files)) {
    const file = join(directory, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
  }
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const avatar = new AvatarService(store, assetRoot, stageRoot)
  avatar.start()
  let origin
  const routes = new Map()
  const ctx = { webServer: { getOrigin: () => origin, register: route => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  } } }
  const devices = new DeviceService(ctx, store)
  const presenter = new PresenterService(avatar, () => ({
    ...avatar.presenterFrame(Date.now(), true), activity: 'singing', transcript: 'private stage text',
  }))
  const viewer = enabled ? new DeviceAvatarViewer(ctx, avatar, presenter, id => {
    const device = store.deviceById(id)
    return !!device && !device.revokedAt
  }) : undefined
  const unregisterViewer = viewer?.register()
  const unregisterDevice = registerDeviceHttp(ctx, { store, view: () => ({ schemaVersion: 2 }) }, devices, viewer)
  const server = createServer((req, res) => {
    const path = new URL(req.url, origin).pathname
    const route = [...routes].find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
    if (route) void route[1](req, res)
    else res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    unregisterViewer?.()
    unregisterDevice()
    devices.close()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await avatar.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const pair = name => devices.redeem(devices.createOffer({ name, routes: [origin] }).link)
  const send = (path, { method = 'GET', headers = {}, body, agent } = {}) => new Promise((resolve, reject) => {
    const req = request(origin, { path, method, headers, agent }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
      res.once('error', error => reject(new Error(`${method} ${path}: response failed`, { cause: error })))
    })
    req.once('error', error => reject(new Error(`${method} ${path}: request failed`, { cause: error })))
    req.end(body)
  })
  const issue = (device, headers = {}) => send(`${api}avatar/viewer`, { method: 'POST', headers: { authorization: device.credential, ...headers } })
  const exchange = (ticket, headers = {}) => send(page, { headers: { authorization: `AvatarView ${ticket}`, ...headers } })
  return { avatar, assetRoot, devices, exchange, issue, origin, pair, send, unregisterViewer }
}

async function session(h, device, headers = {}) {
  const issue = await h.issue(device, headers)
  assert.equal(issue.status, 201)
  const ticket = JSON.parse(issue.text).ticket
  assert.ok(/^[A-Za-z0-9_-]{43}$/u.test(ticket))
  const exchange = await h.exchange(ticket, headers)
  assert.equal(exchange.status, 200)
  const cookie = exchange.headers['set-cookie']?.[0]
  assert.ok(cookie)
  return { ticket, exchange, cookie, headers: { ...headers, cookie: cookie.split(';', 1)[0] } }
}

test('opt-in state, paired issuance and a one-time exchange produce a scoped viewer cookie', async t => {
  const h = await fixture(t)
  const device = h.pair('Phone')
  const auth = { authorization: device.credential }
  const state = await h.send(`${api}state`, { headers: auth })
  assert.deepEqual(JSON.parse(state.text).avatarViewer, { version: 1 })
  assert.equal((await h.send(`${api}avatar/viewer`, { method: 'POST' })).status, 401)
  assert.equal((await h.send(`${api}avatar/viewer?x=1`, { method: 'POST', headers: auth })).status, 400)
  assert.equal((await h.send(`${api}avatar/viewer`, { method: 'POST', headers: { ...auth, 'content-length': '2' }, body: '{}' })).status, 400)
  assert.equal((await h.send(page, { headers: auth })).status, 401)
  const view = await session(h, device)
  assert.ok(view.cookie.includes(`Path=${page}; HttpOnly; SameSite=Strict; Max-Age=1200`))
  assert.ok(!view.cookie.includes('Secure'))
  assert.equal(view.exchange.headers.location, undefined)
  assert.equal(view.exchange.headers['cache-control'], 'no-store')
  assert.equal(view.exchange.headers['referrer-policy'], 'no-referrer')
  assert.match(view.exchange.headers['content-security-policy'], /connect-src 'self'.*frame-ancestors 'none'/u)
  assert.match(view.exchange.headers['permissions-policy'], /microphone=\(\)/u)
  assert.match(view.exchange.text, /Mobile Live2D/u)
  assert.ok(!view.exchange.text.includes(view.ticket) && !view.exchange.text.includes(device.credential))
  assert.equal((await h.exchange(view.ticket, view.headers)).status, 401)
  assert.equal((await h.send(`${api}state`, { headers: view.headers })).status, 401)
})

test('projected cues follow only confirmed stage activity and viewer calls cannot write', async t => {
  const h = await fixture(t)
  const { headers } = await session(h, h.pair('Viewer'))
  const snapshot = async () => JSON.parse((await h.send(`${page}state`, { headers })).text)
  assert.deepEqual(await snapshot(), { available: true, activity: 'singing' })
  const stageId = 'db5fd8de-e3da-448a-93f7-d8e479430c85'
  h.avatar.heartbeat({ stageId, ready: true, frames: 5, nonFinite: 0,
    voice: { playing: true, positionMs: 4, energy: 0.37, audioContextState: 'running' } })
  const action = h.avatar.startAction('nod', stageId)
  assert.deepEqual(await snapshot(), { available: true, activity: 'singing', voiceEnergy: 0.37 })
  h.avatar.receipt({ taskId: action.taskId, stageId, status: 'playing', frames: 6 })
  const playing = await snapshot()
  assert.equal(playing.action.id, 'nod')
  assert.deepEqual(Object.keys(playing.action).sort(), ['elapsedMs', 'id', 'startedAt'])
  const refused = await h.send(`${page}state`, { headers, method: 'POST' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET, HEAD')
  assert.equal((await h.send(`${page}api/heartbeat`, { headers })).status, 404)
  assert.equal((await h.send(`${page}api/realtime/audio`, { headers })).status, 404)
  assert.equal((await h.send(`${page}stage.mjs`, { headers })).status, 404)
  const head = await h.send(`${page}state`, { headers, method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  h.avatar.stop(action.taskId)
  assert.equal((await snapshot()).action, undefined)
})

test('only the scoped HTTPS origin, permitted same-origin requests and allowlisted files are served', async t => {
  const h = await fixture(t)
  const device = h.pair('Viewer')
  const proxy = { host: 'viewer.example.test', 'x-forwarded-host': 'viewer.example.test', 'x-forwarded-proto': 'https' }
  const view = await session(h, device, proxy)
  assert.ok(view.cookie.startsWith('__Secure-CompanionAvatar=') && view.cookie.endsWith('; Secure'))
  assert.equal((await h.send(`${page}state`, { headers: view.headers })).status, 200)
  assert.equal((await h.send(`${page}state`, { headers: { cookie: view.headers.cookie } })).status, 401)
  assert.equal((await h.issue(device, { host: 'other.example.test' })).status, 403)
  for (const headers of [
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' },
    { origin: 'https://outsider.example.test' }, { referer: 'https://outsider.example.test/' },
    { 'tailscale-funnel-request': '?1' }, { 'x-forwarded-host': 'other.example.test' },
  ]) assert.equal((await h.send(`${page}state`, { headers: { ...view.headers, ...headers } })).status, 403)
  const other = { ...view.headers, host: 'other.example.test', 'x-forwarded-host': 'other.example.test' }
  assert.equal((await h.send(`${page}state`, { headers: other })).status, 401)
  for (const file of ['presenter.mjs', 'data/model-profile.json', 'vendor/live2dcubismcore.min.js', `model/${texturePath}`]) {
    const response = await h.send(page + encodeURI(file), { headers: view.headers })
    assert.equal(response.status, 200, file)
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
  }
  for (const file of ['state?token=fake', 'device-presenter.html', 'model/private.json', 'model/%2e%2e%2foutside.png', 'model/%5cprivate.json']) {
    assert.equal((await h.send(page + file, { headers: view.headers })).status, 404, file)
  }
  const texture = join(h.assetRoot, 'model', texturePath)
  await rm(texture)
  await symlink(join(h.assetRoot, 'outside.png'), texture)
  assert.equal((await h.send(page + encodeURI(`model/${texturePath}`), { headers: view.headers })).status, 404)
})

test('expiry, supersession and a revoke while looking up an asset do not expose it', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const h = await fixture(t)
  const device = h.pair('Viewer')
  const first = JSON.parse((await h.issue(device)).text).ticket
  const second = JSON.parse((await h.issue(device)).text).ticket
  assert.equal((await h.exchange(first)).status, 401)
  t.mock.timers.tick(15_001)
  assert.equal((await h.exchange(second)).status, 401)
  const idle = await session(h, device)
  t.mock.timers.tick(45_001)
  assert.equal((await h.send(`${page}state`, { headers: idle.headers })).status, 401)
  const active = await session(h, device)
  const lookup = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const resolveAsset = h.avatar.asset.bind(h.avatar)
  h.avatar.asset = async (kind, path) => {
    if (path === texturePath) { lookup.resolve(); await resume.promise }
    return resolveAsset(kind, path)
  }
  const asset = h.send(page + encodeURI(`model/${texturePath}`), { headers: active.headers })
  await lookup.promise
  h.devices.revoke(device.device.id)
  resume.resolve()
  assert.equal((await asset).status, 401)
  assert.equal((await h.send(`${page}state`, { headers: active.headers })).status, 401)
  assert.equal((await h.issue(device)).status, 401)
})

test('active polling refreshes idle expiry but cannot exceed the absolute session lifetime', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const h = await fixture(t)
  const device = h.pair('Viewer')
  const { headers } = await session(h, device)
  for (let minute = 0; minute < 27; minute++) {
    t.mock.timers.tick(44_000)
    assert.equal((await h.send(`${page}state`, { headers })).status, 200)
  }
  t.mock.timers.tick(12_000)
  assert.equal((await h.send(`${page}state`, { headers })).status, 401)
  assert.equal((await session(h, device)).exchange.status, 200)
})

test('disabled, incomplete and disposed viewers keep the paired state compatible', async t => {
  for (const options of [{ enabled: false }, { complete: false }]) {
    const h = await fixture(t, options)
    const device = h.pair('Viewer')
    const state = await h.send(`${api}state`, { headers: { authorization: device.credential } })
    assert.equal(state.status, 200)
    assert.equal(JSON.parse(state.text).avatarViewer, undefined)
    assert.equal((await h.issue(device)).status, 404)
    assert.equal((await h.send(page)).status, 404)
  }
  const live = await fixture(t)
  const device = live.pair('Viewer')
  const view = await session(live, device)
  live.unregisterViewer()
  assert.equal((await live.send(`${page}state`, { headers: view.headers, agent: false })).status, 404)
  assert.equal((await live.issue(device)).status, 404)
})
