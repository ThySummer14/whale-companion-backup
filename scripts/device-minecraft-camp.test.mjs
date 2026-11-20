import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceAuthError, DeviceService } from '../src/host/devices.ts'
import { registerHttp } from '../src/host/http.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'

async function setup(t, { real = false, avatarViewer } = {}) {
  const dir = await mkdtemp(resolve('.work/device-camp-'))
  const store = new CompanionStore(join(dir, 'companion.db'))
  let origin
  const routes = new Map()
  const ctx = { agents: { roots: () => [], get: () => undefined },
    webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  } } }
  const devices = new DeviceService(ctx, store)
  const control = { pairedPauseEnabled: false }
  const tts = { provider: 'piper', pythonPath: '/unavailable/python', modelPath: '/unavailable/model', mediaDir: join(dir, 'media'), timeoutMs: 5000 }
  const runtime = real ? new CompanionRuntime(ctx, store, 'test', tts, dir, dir, dir, dir, 'owner') : {
    autonomy: { campProjectSummary: () => undefined, campPatrolSummary: () => undefined, campGatherSummary: () => undefined }, minecraft: {
    campView: async () => ({ version: 1, connection: 'online', observedAt: new Date().toISOString(), control: { ...control } }),
    setPairedCampPause: enabled => { control.pairedPauseEnabled = enabled; return control },
    async pauseCamp() {
      if (!control.pairedPauseEnabled) throw new DeviceAuthError(403, 'minecraft-camp-pause-disabled')
      control.pausedAt = new Date().toISOString()
      return this.campView()
    },
    async resumeCamp() { delete control.pausedAt; return control },
  } }
  const disposeManagement = registerHttp(ctx, runtime)
  const disposeDevice = registerDeviceHttp(ctx, runtime, devices, avatarViewer)
  const server = createServer((req, res) => {
    const matched = [...routes.keys()].filter(path => req.url.startsWith(path + '/')).sort((a, b) => b.length - a.length)[0]
    if (matched) void routes.get(matched)(req, res)
    else res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    disposeDevice()
    disposeManagement()
    devices.close()
    if (real) await runtime.close()
    else store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const device = devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const phone = { authorization: device.credential }
  const owner = { 'x-companion-request': '1' }
  const get = (path, headers) => fetch(origin + path, { headers })
  const write = (path, data, headers, method = 'POST') => fetch(origin + path, {
    method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  return { runtime, store, control, device, devices, phone, owner, get, write }
}

const camp = '/companion-device/api/minecraft/camp'
const pause = '/companion-device/api/minecraft/pause'
const enable = '/companion/api/minecraft/camp-control'
const resume = '/companion/api/minecraft/camp-resume'
const state = '/companion-device/api/state'
const rule = '/companion/api/minecraft/survey-window'

function projectWindow(store) {
  const zone = store.createBuildZone({ name: '配对设备营地', x: 1, y: 80, z: 1, radius: 8, dimension: 'minecraft:overworld' })
  return { zoneId: zone.id, start: '12:00', end: '12:45', days: 1, allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true }
}

test('paired building progress reads saved verification and pages sections without blueprints or write access', async t => {
  const h = await setup(t, { real: true })
  const { id: zoneId } = h.store.createBuildZone({ name: '河边授权区', x: 1, y: 80, z: 1, radius: 40, dimension: 'minecraft:overworld' })
  const repo = h.store.minecraftHouseProjects
  const project = repo.create({ name: '河边茶肆', zoneId, sections: Array.from({ length: 34 }, (_, index) => ({
    name: `围墙 ${index + 1}`, offset: { x: index, y: 0, z: 0 },
    layout: { width: 1, height: 5, depth: 1, blocks: 'ooooo' },
  })) })
  const firstTask = h.store.createTask({ capabilityId: 'minecraft.house-project.section', contextId: 'game.minecraft', title: '第一段' })
  const secondTask = h.store.createTask({ capabilityId: 'minecraft.house-project.section', contextId: 'game.minecraft', title: '第二段' })
  assert.ok(repo.start(project.id, 0, firstTask.id))
  assert.ok(repo.finish(project.id, 0, firstTask.id, {
    receipt: { built: true, zoneId, placed: 1, checked: 5, consumed: { oak_planks: 1 } },
  }))
  assert.ok(repo.start(project.id, 1, secondTask.id))
  assert.ok(repo.finish(project.id, 1, secondTask.id, { reason: 'homebuild-retreat-unconfirmed' }))
  const checkedAt = '2026-11-17T00:00:00.000Z'
  repo.verify(project.id, { matched: false, checked: 170, unmatchedSections: [1, 2], checkedAt })
  const path = `/companion-device/api/minecraft/house-projects/${project.id}/sections`

  const view = await (await h.get(state, h.phone)).json()
  assert.ok(!view.activities.some(activity => activity.kind.startsWith('world.house-project-')))
  assert.deepEqual(view.houseProjectProgress, { version: 1, items: [{ id: project.id, name: '河边茶肆',
    totalSections: 34, verifiedSections: 1, runningSections: 0, interruptedSections: 1,
    lastVerification: { matched: false, checked: 170, unmatchedSections: 2, checkedAt },
  }] })
  assert.equal((await h.get(path, {})).status, 401)
  assert.equal((await h.write(path, {}, h.phone)).status, 404)
  for (const query of ['?after=0&after=1', '?limit=1', '?after=00', '?after=1%0A', '?after=9007199254740992']) {
    assert.equal((await h.get(path + query, h.phone)).status, 400, query)
  }
  const first = await (await h.get(path, h.phone)).json()
  assert.equal(first.version, 1)
  assert.equal(first.items.length, 32)
  assert.equal(first.nextAfter, 31)
  assert.deepEqual(first.items.slice(0, 3), [
    { index: 0, name: '围墙 1', status: 'built', checked: 5, placed: 1 },
    { index: 1, name: '围墙 2', status: 'interrupted' },
    { index: 2, name: '围墙 3', status: 'pending' },
  ])
  assert.ok(!JSON.stringify(first).includes(zoneId))
  const next = await (await h.get(path + '?after=31', h.phone)).json()
  assert.deepEqual(next.items.map(item => item.index), [32, 33])
  assert.equal(next.nextAfter, undefined)
  assert.deepEqual(await (await h.get(path + '?after=33', h.phone)).json(), { version: 1, items: [] })

  assert.equal(h.store.revokeBuildZone(zoneId), true)
  assert.equal((await h.get(path, h.phone)).status, 404)
  assert.deepEqual((await (await h.get(state, h.phone)).json()).houseProjectProgress.items, [])
})

test('camp station pairs read access with local-only permission and resume', async t => {
  const h = await setup(t)
  assert.equal((await h.get(camp, {})).status, 401)
  assert.equal((await h.get(camp + '?extended=1', h.phone)).status, 400)
  const initial = await h.get(camp, h.phone)
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  const view = await initial.json()
  assert.deepEqual(Object.keys(view).sort(), ['connection', 'control', 'observedAt', 'version'])
  assert.deepEqual(view.control, { pairedPauseEnabled: false })
  const disabled = await h.write(pause, {}, h.phone)
  assert.equal(disabled.status, 403)
  assert.equal((await disabled.json()).code, 'minecraft-camp-pause-disabled')
  assert.equal((await h.write(enable, { pairedPauseEnabled: true }, h.phone, 'PUT')).status, 403)
  assert.equal((await h.write(enable, { pairedPauseEnabled: true }, { ...h.owner, origin: 'https://external.invalid' }, 'PUT')).status, 403)
  assert.equal((await h.write(enable, { pairedPauseEnabled: true }, h.owner, 'PUT')).status, 200)
  assert.equal((await h.write(pause, { action: 'connect' }, h.phone)).status, 400)
  assert.equal((await h.write(pause, {}, h.phone)).status, 200)
  assert.ok(h.control.pausedAt)
  assert.equal((await h.write(resume.replace('/companion/api', '/companion-device/api'), {}, h.phone)).status, 404)
  assert.equal((await h.write(resume, {}, h.phone)).status, 403)
  assert.ok(h.control.pausedAt)
  assert.deepEqual(await (await h.write(resume, {}, h.owner)).json(), { pairedPauseEnabled: true })
})

test('device revocation after admission blocks the response and the hold remains effective', async t => {
  const h = await setup(t)
  h.control.pairedPauseEnabled = true
  const started = Promise.withResolvers()
  const settle = Promise.withResolvers()
  const pauseCamp = h.runtime.minecraft.pauseCamp.bind(h.runtime.minecraft)
  h.runtime.minecraft.pauseCamp = async () => {
    const view = await pauseCamp()
    started.resolve()
    await settle.promise
    return view
  }
  const inFlight = h.write(pause, {}, h.phone)
  await started.promise
  assert.ok(h.devices.revoke(h.device.device.id))
  settle.resolve()
  assert.equal((await inFlight).status, 401)
  assert.equal((await h.get(camp, h.phone)).status, 401)
  assert.ok(h.control.pausedAt)
})

test('paired home and camp share the bounded project summary through pause, resume, expiry and revocation', async t => {
  const noon = new Date(2026, 10, 10, 12, 5).getTime()
  t.mock.timers.enable({ apis: ['Date'], now: noon })
  const h = await setup(t, { real: true })
  const input = projectWindow(h.store)
  const readBoth = async expected => {
    const [homeResponse, campResponse] = await Promise.all([h.get(state, h.phone), h.get(camp, h.phone)])
    assert.equal(homeResponse.status, 200)
    assert.equal(campResponse.status, 200)
    assert.equal(homeResponse.headers.get('cache-control'), 'no-store')
    assert.equal(campResponse.headers.get('cache-control'), 'no-store')
    const home = (await homeResponse.json()).community
    const station = await campResponse.json()
    assert.deepEqual(home.campProject, expected)
    assert.deepEqual(station.project, expected)
    assert.equal(station.connection, 'unavailable')
    assert.equal(Object.hasOwn(home, 'campProject'), expected !== undefined)
    assert.equal(Object.hasOwn(station, 'project'), expected !== undefined)
  }
  const summary = availability => ({ stage: 'gathering', supplyVisits: 0, availability })
  assert.equal((await h.get(state, {})).status, 401)
  assert.equal((await h.get(camp, {})).status, 401)
  await readBoth(undefined)
  assert.equal((await h.write(rule, input, h.owner, 'PUT')).status, 200)
  await readBoth(undefined)
  assert.equal((await h.write(rule, {}, h.owner, 'DELETE')).status, 200)
  assert.equal((await h.write(rule, { ...input, allowMinecraftProject: true }, h.phone, 'PUT')).status, 403)
  assert.equal((await h.write(rule, { ...input, allowMinecraftProject: true }, h.owner, 'PUT')).status, 200)
  await readBoth(summary('active'))
  assert.equal((await h.write(pause, {}, h.phone)).status, 403)
  assert.equal((await h.write(enable, { pairedPauseEnabled: true }, h.owner, 'PUT')).status, 200)
  const paused = await h.write(pause, {}, h.phone)
  assert.equal(paused.status, 200)
  assert.deepEqual((await paused.json()).project, summary('paused'))
  await readBoth(summary('paused'))
  assert.equal((await h.write(resume, {}, h.owner)).status, 200)
  await readBoth(summary('active'))
  h.runtime.autonomy.updateSettings({ enabled: false })
  await readBoth(summary('paused'))
  t.mock.timers.setTime(noon + 40 * 60_000)
  await readBoth(summary('ended'))
  assert.equal((await h.write(rule, {}, h.owner, 'DELETE')).status, 200)
  await readBoth(undefined)
})

test('the current rule is checked after an in-flight camp status read', async t => {
  const h = await setup(t, { real: true })
  h.runtime.autonomy.setSurveyWindow({ ...projectWindow(h.store), allowMinecraftProject: true })
  const admitted = Promise.withResolvers()
  const settle = Promise.withResolvers()
  const campView = h.runtime.minecraft.campView.bind(h.runtime.minecraft)
  h.runtime.minecraft.campView = async () => {
    const view = await campView()
    admitted.resolve()
    await settle.promise
    return view
  }
  const pending = h.get(camp, h.phone)
  await admitted.promise
  h.runtime.autonomy.revokeSurveyWindow()
  settle.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(Object.hasOwn(await response.json(), 'project'), false)
})

test('paired home reauthenticates after its asynchronous avatar check', async t => {
  const admitted = Promise.withResolvers()
  const settle = Promise.withResolvers()
  const h = await setup(t, { real: true, avatarViewer: {
    async capability() { admitted.resolve(); await settle.promise },
  } })
  const pending = h.get(state, h.phone)
  await admitted.promise
  assert.ok(h.devices.revoke(h.device.device.id))
  settle.resolve()
  assert.equal((await pending).status, 401)
  assert.equal((await h.get(camp, h.phone)).status, 401)
})
