import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MINECRAFT_PLACE_CAPABILITY, MINECRAFT_PLACE_EVENT } from '../src/core/minecraft-place.ts'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { registerMinecraftTools } from '../src/host/minecraft-tools.ts'
import { registerMemoryRecall } from '../src/host/recall.ts'
import { deviceActivity } from '../src/host/device-http.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const layout = { width: 5, height: 4, depth: 5, blocks: 'o'.repeat(60) + '.'.repeat(40) }
const signal = () => new AbortController().signal

function fixture(t) {
  const directory = mkdtempSync('.work/minecraft-places-')
  const path = join(directory, 'companion.sqlite')
  const stores = []
  const legacy = new CompanionStore(path)
  const zone = legacy.createBuildZone({ name: '授权小院', dimension: 'minecraft:overworld', x: 112, y: 80, z: 112, radius: 8 })
  const project = legacy.minecraftHouseProjects.create({ name: '双翼小院', zoneId: zone.id,
    sections: [-2, 3].map((x, index) => ({ name: String(index + 1), offset: { x, y: 0, z: 0 }, layout })) })
  legacy.db.exec('DROP TABLE minecraft_place; PRAGMA user_version=43')
  legacy.close()
  const store = new CompanionStore(path)
  stores.push(store)
  t.after(() => {
    for (const db of stores) db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  assert.equal(Number(store.db.prepare('PRAGMA user_version').get().user_version), 44)
  assert.deepEqual(store.minecraftHouseProjects.get(project.id), project)
  assert.equal(store.buildZoneById(zone.id).name, zone.name)
  const serviceFor = db => new MinecraftService(db, {}, { dataDir: directory, serverRoot: directory, owner: 'fixture-owner' })
  const service = serviceFor(store)
  const complete = (id = project.id) => {
    const current = store.minecraftHouseProjects.get(id)
    current.sections.forEach((section, index) => {
      const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.house-project.section', title: '施工夹具' })
      assert.ok(store.minecraftHouseProjects.start(id, index, task.id))
      store.transitionTask(task.id, 'running')
      assert.ok(store.minecraftHouseProjects.finish(id, index, task.id, {
        receipt: { built: true, zoneId: zone.id, checked: 100, placed: 60, consumed: { oak_planks: 60 } },
      }))
      store.transitionTask(task.id, 'succeeded')
    })
    store.minecraftHouseProjects.verify(id, { matched: true, checked: 200, unmatchedSections: [], checkedAt: new Date().toISOString() })
    return store.minecraftHouseProjects.get(id)
  }
  const reopen = () => {
    const db = new CompanionStore(path)
    stores.push(db)
    return { db, service: serviceFor(db) }
  }
  return { store, service, serviceFor, zone, project, complete, reopen, directory }
}

test('verified project naming preserves one exact location, its memory revisions and cold restart', async t => {
  const h = fixture(t)
  assert.throws(() => h.service.nameHouseProjectPlace(h.project.id, '太早命名'), { code: 'minecraft-place-verification-required' })
  assert.throws(() => h.service.nameHouseProjectPlace(h.project.id, 'bad\nname'), { name: 'ZodError' })
  assert.throws(() => h.service.nameHouseProjectPlace(h.project.id, 'x'.repeat(41)), { name: 'ZodError' })
  assert.equal(h.store.tasks().length, 0)
  h.complete()
  assert.deepEqual(h.service.placeStatus().availableProjects, [{ id: h.project.id, name: '双翼小院', verifiedAt: h.service.placeStatus().availableProjects[0].verifiedAt }])
  const first = h.service.nameHouseProjectPlace(h.project.id, ' 橡木小院 ')
  assert.equal(first.outcome, 'named')
  assert.equal(first.place.name, '橡木小院')
  assert.deepEqual([first.place.x, first.place.y, first.place.z], [112, 80, 112])
  assert.equal(first.project.place.id, first.place.id)
  assert.equal(h.store.taskById(first.taskId).status, 'succeeded')
  assert.equal(h.store.taskById(first.taskId).capabilityId, MINECRAFT_PLACE_CAPABILITY)
  const activity = h.store.activityByTask(first.taskId, MINECRAFT_PLACE_EVENT, 'game.minecraft')
  assert.equal(activity.data.actor, 'owner')
  const paired = deviceActivity(activity)
  assert.deepEqual(paired.data, { dimension: 'minecraft:overworld', x: 112, y: 80, z: 112,
    verifiedAt: first.place.verifiedAt, actor: 'owner' })
  assert.equal(paired.sessionId, undefined)
  assert.equal(deviceActivity({ ...activity, source: 'invalid' }), undefined)
  assert.equal(deviceActivity({ ...activity, data: { ...activity.data, x: 'unknown' } }), undefined)
  assert.equal(h.store.memory.get(first.place.memoryId).scope, 'shared')
  assert.equal(h.store.memory.get(first.place.memoryId).sourceRefs[0].activityId, activity.id)
  assert.deepEqual(h.store.memory.find('橡木小院在哪里', { contextId: 'chat.mobile' }).map(row => row.id), [first.place.memoryId])
  assert.match(h.store.memory.get(first.place.memoryId).content, /minecraft:overworld.*112, 80, 112.*不是入口/u)
  assert.equal(h.service.placeStatus().places[0].memoryId, undefined)
  assert.equal(h.service.nameHouseProjectPlace(h.project.id, '橡木小院').outcome, 'unchanged')
  assert.equal(h.store.tasks().filter(task => task.capabilityId === MINECRAFT_PLACE_CAPABILITY).length, 1)
  const second = h.service.nameHouseProjectPlace(h.project.id, '白饭小院', 'companion')
  assert.equal(second.outcome, 'renamed')
  assert.equal(second.place.id, first.place.id)
  assert.equal(second.place.memoryId, first.place.memoryId)
  assert.equal(h.store.memory.list().length, 1)
  assert.match(h.store.memory.get(first.place.memoryId).content, /白饭小院/u)
  assert.doesNotMatch(h.store.memory.get(first.place.memoryId).content, /橡木小院/u)
  assert.ok(h.store.memory.revisions(first.place.memoryId).some(row => row.snapshot.content.includes('橡木小院')))
  const restarted = h.reopen()
  assert.deepEqual(restarted.db.minecraftPlaces.byProject(h.project.id), second.place)
  assert.equal(restarted.db.minecraftHouseProjects.get(h.project.id).place.name, '白饭小院')
  assert.equal(restarted.service.placeStatus().availableProjects.length, 0)
})

test('name conflicts, changed verification, archived memory and revoked zones cannot create a false live place', async t => {
  const h = fixture(t)
  h.complete()
  const other = h.store.minecraftHouseProjects.create({ name: '另一栋', zoneId: h.zone.id,
    sections: h.project.sections.map(({ name, offset, layout }) => ({ name, offset, layout })) })
  h.complete(other.id)
  const named = h.service.nameHouseProjectPlace(h.project.id, '东翼家')
  assert.throws(() => h.service.nameHouseProjectPlace(other.id, '东翼家'), { code: 'minecraft-place-name-conflict' })
  assert.equal(h.store.minecraftPlaces.byProject(other.id), undefined)
  assert.throws(() => h.service.nameHouseProjectPlace(other.id, '东翼家'), { code: 'minecraft-place-name-conflict' })
  h.store.minecraftHouseProjects.verify(h.project.id, { matched: false, checked: 200, unmatchedSections: [0], checkedAt: new Date().toISOString() })
  assert.throws(() => h.service.nameHouseProjectPlace(h.project.id, '改动后的家'), { code: 'minecraft-place-verification-required' })
  assert.equal(h.store.memory.get(named.place.memoryId).content.includes('东翼家'), true)
  h.store.memory.archive(named.place.memoryId)
  assert.deepEqual(h.service.placeStatus().places, [])
  assert.deepEqual(h.service.placeStatus().availableProjects.map(project => project.id), [other.id])
  h.store.memory.restore(named.place.memoryId)
  assert.equal(h.service.placeStatus().places.length, 1)
  assert.equal(await h.service.revokeBuildZone(h.zone.id), true)
  assert.deepEqual(h.service.placeStatus(), { places: [], availableProjects: [] })
  assert.throws(() => h.service.nameHouseProjectPlace(h.project.id, '撤权后的家'), { code: 'build-zone-not-found' })
  assert.equal(h.store.memory.get(named.place.memoryId).content.includes('东翼家'), true)
  const restarted = h.reopen()
  assert.equal(restarted.service.placeStatus().places.length, 0)
  assert.equal(restarted.db.memory.get(named.place.memoryId).content.includes('东翼家'), true)
})

test('game tools expose the place book only to the live Minecraft root session', async t => {
  const h = fixture(t)
  h.complete()
  const agent = { id: 'game-root', session: { header: {} } }
  h.store.bindContext({ contextId: 'game.minecraft', sessionId: agent.id, kind: 'game', label: '游戏' })
  const tools = new Map()
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => undefined },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  }
  t.after(registerMinecraftTools(ctx, { store: h.store, minecraft: h.service }))
  assert.ok(companionToolPolicy('game.minecraft', 'game', false).allowed.some(tool => tool.name === 'mc_name_place'))
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes('mc_name_place'))
  const execute = (name, args, caller = agent) => tools.get(name).execute(args, { agent: caller, signal: signal() })
  const available = JSON.parse(await execute('mc_status', { section: 'places' }))
  assert.deepEqual(available.places, [])
  assert.deepEqual(available.availableProjects.map(project => project.id), [h.project.id])
  await assert.rejects(execute('mc_name_place', { projectId: h.project.id, name: '越权地点' }, null), /require the game.minecraft session/u)
  await assert.rejects(execute('mc_name_place', { projectId: h.project.id, name: '越权地点' }, { ...agent }), /live Minecraft root session/u)
  agent.session.header.origin = 'subagent'
  await assert.rejects(execute('mc_name_place', { projectId: h.project.id, name: '越权地点' }), /live Minecraft root session/u)
  agent.session.header.origin = undefined
  const named = JSON.parse(await execute('mc_name_place', { projectId: h.project.id, name: '游戏里的家' }))
  assert.equal(named.outcome, 'named')
  assert.equal(named.place.name, '游戏里的家')
  const activity = h.store.activityByTask(named.taskId, MINECRAFT_PLACE_EVENT, 'game.minecraft')
  assert.equal(activity.data.actor, 'companion')
  assert.equal(activity.sessionId, agent.id)
  const status = JSON.parse(await execute('mc_status', { section: 'places' }))
  assert.equal(status.places[0].name, '游戏里的家')
  assert.equal(status.places[0].memoryId, undefined)
  assert.deepEqual(status.availableProjects, [])
})

test('owner HTTP naming respects local authority and the existing memory is recalled in a separate chat scene', async t => {
  const h = fixture(t)
  let handler, origin
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } }
  registerHttp(ctx, { minecraft: h.service })
  const server = createServer(handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const url = `${origin}/companion/api/minecraft/house-projects/${h.project.id}/place`
  const post = (name, headers = { 'x-companion-request': '1' }) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name }) })
  assert.equal((await post('未授权', {})).status, 403)
  assert.equal((await post('未授权', { 'x-companion-request': '1', origin: 'https://outside.invalid' })).status, 403)
  const early = await post('尚未验收')
  assert.equal(early.status, 409)
  assert.equal((await early.json()).code, 'minecraft-place-verification-required')
  h.complete()
  const saved = await post(' 河边小院 ')
  assert.equal(saved.status, 200)
  const project = await saved.json()
  assert.equal(project.place.name, '河边小院')
  assert.equal(h.store.memory.list().length, 1)
  const renamed = await post('山边小院')
  assert.equal(renamed.status, 200)
  assert.equal((await renamed.json()).place.id, project.place.id)
  assert.equal(h.store.memory.list().length, 1)

  h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'phone-session', kind: 'chat', label: '手机' })
  let recall
  registerMemoryRecall({ on(name, callback) { assert.equal(name, 'agent/pre-step'); recall = callback } }, h.store)
  const input = createUserMessage({ source: { kind: 'companion-mobile', form: 'relay' }, content: [{ type: 'text', text: '我们的山边小院在哪里？' }] })
  const decision = await recall({ agent: { id: 'phone-session' }, messages: [input], turn: 2, step: 1, signal: signal() },
    async () => ({ kind: 'enter', messages: [input] }))
  const injected = decision.messages.slice(1).map(message => message.content[0].text).join('\n')
  assert.match(injected, /山边小院.*minecraft:overworld.*112, 80, 112/u)
  assert.doesNotMatch(injected, /河边小院/u)
  assert.equal(await h.service.revokeBuildZone(h.zone.id), true)
  const revoked = await post('撤权后改名')
  assert.equal(revoked.status, 404)
  assert.equal((await revoked.json()).code, 'build-zone-not-found')
})
