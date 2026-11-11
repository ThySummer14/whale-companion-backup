import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { AvatarService } from '../src/host/avatar.ts'
import { PresenterService } from '../src/host/presenter.ts'

function fixture(t, snapshot = () => ({ available: true }), port = 0) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/presenter-host-test-'))
  for (const [path, bytes] of Object.entries({
    'stage/presenter.html': '<!doctype html><canvas></canvas>', 'stage/presenter.mjs': 'export const ready = true',
    'stage/stage.mjs': 'private controller', 'stage/voice.mjs': 'private voice',
    'avatar/data/model-profile.json': '{"parameters":[]}', 'avatar/vendor/live2dcubismcore.min.js': '// private Core fixture',
    'avatar/model/大肥鱼.model3.json': JSON.stringify({ FileReferences: {
      Moc: '大肥鱼.moc3', Textures: ['大肥鱼.4096/texture_00.png', 'escape.png'], Physics: '大肥鱼.physics3.json', DisplayInfo: '../private.json',
    } }),
    'avatar/model/大肥鱼.moc3': 'fixture moc', 'avatar/model/大肥鱼.physics3.json': '{}',
    'avatar/model/大肥鱼.4096/texture_00.png': 'fixture texture', 'avatar/model/Exp3/脸红.exp3.json': '{}',
    'avatar/model/private.json': 'unreferenced private metadata', 'avatar/private.json': 'outside model directory',
  })) {
    const file = join(directory, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
  symlinkSync(join(directory, 'avatar/private.json'), join(directory, 'avatar/model/escape.png'))
  const avatar = new AvatarService({}, join(directory, 'avatar'), join(directory, 'stage'))
  const service = new PresenterService(avatar, snapshot, port)
  t.after(async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }) })
  return service
}

function raw(origin, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

test('listener serves distinct presentation URLs, static files, strict CSP and a redacted snapshot', async t => {
  const service = fixture(t, () => ({
    available: true, activity: 'singing', voiceEnergy: 0.32,
    action: { id: 'nod', startedAt: 123, elapsedMs: 40, taskId: 'private-task-id' },
    transcript: 'private chat', token: 'private token',
  }))
  assert.deepEqual(service.view(), { running: false })
  const { running, obsUrl, desktopUrl } = await service.start()
  const origin = new URL(obsUrl).origin
  assert.equal(running, true)
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
  assert.equal(obsUrl, `${origin}/?mode=obs`)
  assert.equal(desktopUrl, `${origin}/?mode=desktop`)
  const page = await raw(origin, '/?mode=desktop')
  assert.equal(page.status, 200)
  assert.match(page.text, /<canvas>/u)
  assert.match(page.headers['content-security-policy'], /connect-src 'self'.*frame-ancestors 'none'/u)
  assert.equal(page.headers['x-frame-options'], 'DENY')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['access-control-allow-origin'], undefined)
  assert.equal(page.headers['set-cookie'], undefined)
  assert.equal((await raw(origin, '/presenter.mjs')).status, 200)
  const state = await raw(origin, '/state')
  assert.deepEqual(JSON.parse(state.text), {
    available: true, activity: 'singing', voiceEnergy: 0.32, action: { id: 'nod', startedAt: 123, elapsedMs: 40 },
  })
  const head = await raw(origin, '/state', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.equal(head.headers['content-length'], state.headers['content-length'])
})

test('listener refuses cross-origin data, non-loopback authority, control routes and mutations', async t => {
  const { obsUrl } = await fixture(t).start()
  const origin = new URL(obsUrl).origin
  for (const headers of [
    { host: 'rebinding.example' }, { origin: 'https://cross-site.example' }, { origin: 'null' },
    { referer: 'https://cross-site.example/some-page' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) assert.equal((await raw(origin, '/state', { headers })).status, 403)
  const navigation = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  assert.equal((await raw(origin, '/', { headers: navigation })).status, 200)
  assert.equal((await raw(origin, '/state', { headers: navigation })).status, 403)
  assert.equal((await raw(origin, '/', { headers: { ...navigation, referer: 'http://127.0.0.1:8787/' } })).status, 403)
  const write = await raw(origin, '/state', { method: 'POST' })
  assert.equal(write.status, 405)
  assert.equal(write.headers.allow, 'GET, HEAD')
  for (const path of ['/companion/avatar/api/actions', '/api/heartbeat', '/stage.mjs', '/voice.mjs', '/realtime/audio']) {
    assert.equal((await raw(origin, path)).status, 404)
  }
})

test('listener serves only model dependencies and prevents path traversal or model symlink escape', async t => {
  const { obsUrl } = await fixture(t).start()
  const origin = new URL(obsUrl).origin
  for (const path of [
    '/model/大肥鱼.model3.json', '/model/大肥鱼.4096/texture_00.png', '/model/大肥鱼.moc3', '/model/Exp3/脸红.exp3.json',
    '/data/model-profile.json', '/vendor/live2dcubismcore.min.js',
  ]) assert.equal((await raw(origin, encodeURI(path))).status, 200, path)
  for (const path of ['/model/private.json', '/model/escape.png', '/model/%2e%2e/private.json', '/model/%2e%2e%2fprivate.json', '/model/%00', '/model/%5cprivate.json']) {
    const value = await raw(origin, path)
    assert.ok([403, 404].includes(value.status), path)
    assert.doesNotMatch(value.text, /outside model directory|unreferenced private metadata/u)
  }
})

test('serialized start and stop are idempotent and shutdown closes the listener', async t => {
  const service = fixture(t)
  const first = service.start()
  const concurrent = service.start()
  const stop = service.stop()
  assert.deepEqual(await first, await concurrent)
  const origin = new URL((await first).obsUrl).origin
  assert.deepEqual(await stop, { running: false })
  assert.deepEqual(await service.stop(), { running: false })
  await assert.rejects(raw(origin, '/state'), { code: 'ECONNREFUSED' })
  const restarted = await service.start()
  assert.equal((await raw(new URL(restarted.obsUrl).origin, '/state')).status, 200)
})

test('an occupied port is reported without diagnostics and a later start succeeds', async t => {
  const blocker = createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => { if (blocker.listening) blocker.close() })
  const service = fixture(t, () => ({ available: false, activity: 'unknown', voiceEnergy: 3, action: { id: 'arbitrary', startedAt: 0, elapsedMs: -1 } }), blocker.address().port)
  await assert.rejects(service.start(), { status: 409, code: 'presenter-port-in-use', message: 'presenter-port-in-use' })
  assert.deepEqual(service.view(), { running: false })
  await new Promise(resolve => blocker.close(resolve))
  const { obsUrl } = await service.start()
  assert.deepEqual(JSON.parse((await raw(new URL(obsUrl).origin, '/state')).text), { available: false })
})
