import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { registerMinecraftTools } from '../src/host/minecraft-tools.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'
import { MinecraftWardrobeConfigSchema } from '../src/protocol/minecraft-wardrobe.ts'

const blue = { id: 'blue', label: '蓝色日常', modelId: 'D蓝色大肥鱼' }
const winter = { id: 'winter', label: '蓝色冬装', modelId: 'D蓝色大肥鱼(冬装)' }
const options = [blue, winter].map(({ id, label }) => ({ id, label }))
const confirmedAt = '2026-11-09T13:00:00.000Z'

async function fixture(t) {
  const directory = await mkdtemp(resolve('.work/minecraft-wardrobe-'))
  const store = new CompanionStore(join(directory, 'companion.db'))
  const service = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'owner', wardrobeFile: join(directory, 'wardrobe.json') })
  service.ready = true
  service.wardrobeModels = MinecraftWardrobeConfigSchema.parse([blue, winter])
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  return { service, store }
}

test('wardrobe config supports original model names and rejects duplicate IDs, extra fields and command syntax', () => {
  assert.deepEqual(MinecraftWardrobeConfigSchema.parse([blue, winter]), [blue, winter])
  for (const value of [[blue, blue], [{ ...blue, ignoreAuth: true }], [{ ...blue, textureId: 'override' }], [{ ...blue, modelId: 'blue" true' }],
    [{ ...blue, modelId: 'blue\nstop' }], [{ ...blue, modelId: 'blue\\winter' }], [{ ...blue, label: '蓝\u202e装' }],
    [{ ...blue, modelId: 'blue ' }], [{ ...blue, id: '../blue' }]]) {
    assert.equal(MinecraftWardrobeConfigSchema.safeParse(value).success, false)
  }
})

test('wardrobe confirms exact server receipts, retains the private allowlist projection and rejects the camp fence', async t => {
  const { service, store } = await fixture(t)
  let worker = { available: true, options: [{ id: 'blue', label: 'worker supplied label' }] }
  const calls = []
  t.mock.method(service, 'request', async (path, method, input) => {
    calls.push({ path, method, input })
    return worker
  })
  assert.deepEqual(await service.wardrobe(), { available: true, options })
  await assert.rejects(service.changeAppearance('elsewhere'), { code: 'minecraft-wardrobe-option-not-found' })
  assert.equal(calls.length, 1)
  await assert.rejects(service.changeAppearance('winter'), { code: 'minecraft-wardrobe-unconfirmed' })
  worker = { available: true, options, last: { id: 'winter', confirmedAt } }
  assert.deepEqual(await service.changeAppearance('winter'), worker)
  assert.deepEqual(await service.changeAppearance('winter'), worker)
  const activity = store.activities().filter(row => row.kind === 'wardrobe.accepted')
  assert.equal(activity.length, 1)
  assert.deepEqual(activity[0].data, { appearanceId: 'winter', confirmedAt })
  assert.equal(store.taskById(activity[0].taskId).status, 'succeeded')
  assert.equal(store.tasks().filter(task => task.capabilityId === 'minecraft.appearance').length, 1)
  store.saveMinecraftCampControl({ pairedPauseEnabled: false, pausedAt: confirmedAt })
  assert.equal((await service.wardrobe()).available, false)
  await assert.rejects(service.changeAppearance('blue'), { code: 'minecraft-camp-paused' })
  assert.equal(calls.filter(call => call.method === 'POST').length, 3)
})

test('local management route admits an ID only and rejects external origins', async t => {
  const { service } = await fixture(t)
  const accepted = { available: true, options, last: { id: 'blue', confirmedAt } }
  const apply = t.mock.method(service, 'changeAppearance', async (id, signal) => {
    assert.equal(id, 'blue')
    assert.ok(signal instanceof AbortSignal)
    return accepted
  })
  let handler, origin
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } }, { minecraft: service })
  const server = createServer(handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const submit = (payload, headers, query = '') => fetch(origin + '/companion/api/minecraft/wardrobe' + query, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  })
  const owner = { 'x-companion-request': '1' }
  assert.equal((await submit({ id: 'blue' }, {})).status, 403)
  assert.equal((await submit({ id: 'blue' }, { ...owner, origin: 'https://outside.invalid' })).status, 403)
  assert.equal((await submit({ id: 'blue', player: 'owner' }, owner)).status, 400)
  assert.equal((await submit({ id: 'blue' }, owner, '?texture=override')).status, 400)
  assert.deepEqual(await (await submit({ id: 'blue' }, owner)).json(), accepted)
  assert.equal(apply.mock.callCount(), 1)
})

test('wardrobe tool is available only to the live registered Minecraft root when configured', async t => {
  const { service, store } = await fixture(t)
  const id = 'fixture-minecraft-session'
  const agent = { id, session: { header: {} } }
  const tools = new Map()
  const apply = t.mock.method(service, 'changeAppearance', async () => ({ available: true, options, last: { id: 'blue', confirmedAt } }))
  let binding = { contextId: 'core.chat', kind: 'chat' }
  t.mock.method(store, 'bindingBySession', () => binding)
  const ctx = {
    agents: { get: key => key === id ? agent : undefined, currentInitiator: () => undefined },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  const dispose = registerMinecraftTools(ctx, { minecraft: service, store })
  t.after(dispose)
  const tool = tools.get('mc_change_appearance')
  const execute = (caller = agent) => tool.execute({ id: 'blue' }, { agent: caller, signal: new AbortController().signal })
  await assert.rejects(execute(), /require the game.minecraft session/u)
  binding = { contextId: 'game.minecraft', kind: 'game' }
  await assert.rejects(execute({ ...agent }), /live Minecraft root session/u)
  agent.session.header.delegationDepth = 1
  await assert.rejects(execute(), /live Minecraft root session/u)
  agent.session.header.delegationDepth = 0
  assert.equal(JSON.parse(await execute()).last.id, 'blue')
  assert.equal(apply.mock.callCount(), 1)
  assert.ok(companionToolPolicy('core.chat', 'chat').denied.includes('mc_change_appearance'))
  assert.ok(companionToolPolicy('game.minecraft', 'game', false).denied.includes('mc_change_appearance'))
})
