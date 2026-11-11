import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { HOUSE_AGENT_RECOVERY_EVENT, HOUSE_AGENT_RECOVERY_PREFIX, HOUSE_CELL_ACTIVITY, HOUSE_CELL_AUDIT_ACTIVITY, HOUSE_CELL_AUDIT_PREFIX, HOUSE_CELL_CAPABILITY, HOUSE_CELL_TASK_PREFIX } from '../src/core/minecraft-recovery.ts'
import { HOUSE_COMPLETION_TASK_PREFIX } from '../src/core/minecraft-house-verification.ts'
import { MINECRAFT_HOUSE_EVENT, minecraftHouseBuildSummary } from '../src/core/minecraft-house-repository.ts'
import { MINECRAFT_RECOVERY_CONTEXT } from '../src/core/model.ts'
import { registerHttp } from '../src/host/http.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { verifiedMinecraftMilestone } from '../src/host/minecraft-milestones.ts'
import { HOUSE_DRAFT_TOOL, registerMinecraftHouseTool } from '../src/host/minecraft-house-tool.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const layout = { width: 2, height: 2, depth: 2, blocks: 'coo..gg.' }
const input = { name: '雨后木屋', layout, assumptions: '正面玻璃，背面与室内按需要补设计' }
const source = { sessionId: 'phone', messageId: 'owner-house' }

function makeStore(t) {
  const directory = mkdtempSync('.work/minecraft-house-host-')
  const path = join(directory, 'companion.sqlite')
  const store = new CompanionStore(path)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, directory, path }
}

test('house draft binds only the explicit current owner turn and its actual image, without starting construction', async t => {
  const { store } = makeStore(t)
  store.bindContext({ contextId: 'chat.mobile', sessionId: 'phone', kind: 'chat', label: '手机' })
  const session = { id: 'phone', header: {} }
  const agent = { id: 'phone', session }
  const hooks = new Map()
  const modelLookups = []
  let resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] })
  let tool
  const ctx = {
    on: (event, hook) => { hooks.set(event, hook); return () => hooks.delete(event) },
    agents: { get: id => id === agent.id ? agent : undefined },
    tools: { register: value => { tool = value; return () => {} } },
    llm: { resolveModelInfo: (provider, model, signal) => {
      modelLookups.push({ provider, model, signal })
      return resolveModelInfo()
    } },
  }
  t.after(registerMinecraftHouseTool(ctx, { store }))
  assert.ok(companionToolPolicy('chat.mobile', 'chat').allowed.some(entry => entry.name === HOUSE_DRAFT_TOOL))
  assert.ok(companionToolPolicy('autonomy.daily-visit', 'system').denied.includes(HOUSE_DRAFT_TOOL))
  const image = { type: 'image', attachment: { attachmentId: 'image-cabin', name: 'cabin.png', bytes: 284, mediaType: 'image/png' } }
  const message = (id, text, attachments = [], source = { kind: 'companion-mobile', form: 'relay' }) =>
    ({ id, role: 'user', source, content: [{ type: 'text', text }, ...attachments] })
  const emit = (type, data, surfaceOp) => hooks.get('session/event')(session, { type, data, surfaceOp })
  const begin = (turn, claimed, appended = claimed, toolName = HOUSE_DRAFT_TOOL) => {
    emit('turn/start', { turn })
    if (claimed) hooks.get('agent/inbox/claimed')({ agent, message: claimed, turn })
    emit('step/start', { turn, step: 1 })
    if (appended) emit('user/message', structuredClone(appended), 'append')
    emit('tool/call', { turn, step: 1, callId: `call-${turn}`, name: toolName })
  }
  const args = { name: input.name, ...layout, assumptions: input.assumptions }
  const execute = (turn, parameters = args, extra = {}) => tool.execute(parameters, {
    agent, signal: new AbortController().signal, callId: `call-${turn}`, ...extra,
  })
  begin(1, message(source.messageId, '照这张图盖一间小屋', [image]))
  await assert.rejects(execute(1, { name: input.name, ...layout }), /parts inferred/u)
  const first = JSON.parse(await execute(1))
  assert.equal(first.status, 'draft')
  assert.deepEqual(first.materials, { cobblestone: 1, oak_planks: 2, glass: 2 })
  assert.equal(JSON.parse(await execute(1, { ...args, name: '不能替换原图纸' })).draftId, first.draftId)
  const row = store.minecraftHouses.get(first.draftId)
  assert.deepEqual(row.reference, { contextId: 'chat.mobile', messageId: source.messageId, attachmentId: 'image-cabin' })
  assert.equal(row.name, input.name)
  assert.equal(store.tasks().length, 0)
  emit('turn/end', { turn: 1 })
  await assert.rejects(execute(1), /new owner message/u)
  begin(2, undefined, message('injected', '照这张图盖一间小屋', [image]))
  await assert.rejects(execute(2), /new owner message/u)
  begin(3, message('world', '照这张图盖一间小屋', [image], { kind: 'companion-world', form: 'minecraft-event' }))
  await assert.rejects(execute(3), /new owner message/u)
  begin(4, message('incidental', '我家附近有一间木屋', [image]))
  await assert.rejects(execute(4), /at most one image/u)
  begin(5, message('multiple', '照这张图盖一间小屋', [image, image]))
  await assert.rejects(execute(5), /at most one image/u)
  const owner = message('text', '帮我盖一个房子')
  begin(6, owner, owner, 'run_code')
  emit('tool/ptc-dispatch-start', { name: HOUSE_DRAFT_TOOL, rootCallId: 'call-6', subCallId: 'nested-6' })
  const text = JSON.parse(await execute(6, args, { parent: true, callId: 'nested-6', rootCallId: 'call-6' }))
  assert.equal(store.minecraftHouses.get(text.draftId).reference, undefined)
  assert.equal(store.minecraftHouses.list().length, 2)

  const { blocks, ...dimensions } = args
  const layers = [['co', 'o.'], ['.g', 'g.']]
  const layered = { ...dimensions, layers }
  begin(7, message('layered', '请帮我照这张图盖一间木屋', [image]))
  await assert.rejects(execute(7, dimensions), /exactly one of facade, layers or blocks/u)
  await assert.rejects(execute(7, { ...layered, blocks }), /exactly one of facade, layers or blocks/u)
  await assert.rejects(execute(7, { ...layered, width: 6 }), /width: use an integer from 1 to 5/u)
  await assert.rejects(execute(7, { ...layered, layers: [['co', 'o.']] }), /expected 2 layers bottom to top, received 1/u)
  await assert.rejects(execute(7, { ...layered, layers: [['co'], ['.g', 'g.']] }), /layers\[0\]: expected 2 rows north to south/u)
  await assert.rejects(execute(7, { ...layered, layers: [['co', 'o.'], ['.g', 'gz']] }), /layers\[1\]\[1\]: use exactly 2 characters/u)
  await assert.rejects(execute(7, { ...layered, layers: [['co', 'o.'], ['.g', 'g']] }), /layers\[1\]\[1\]: use exactly 2 characters/u)
  await assert.rejects(execute(7, { ...dimensions, blocks: 'co' }), /expected 8 cells including air, received 2/u)
  await assert.rejects(execute(7, { ...dimensions, blocks: '........' }), /one to 100 solid blocks/u)
  await assert.rejects(execute(7, { ...dimensions, width: 5, depth: 5, height: 5, blocks: 'o'.repeat(125) }), /one to 100 solid blocks/u)
  assert.equal(store.minecraftHouses.list().length, 2)
  emit('step/end', { turn: 7, step: 1 })
  emit('step/start', { turn: 7, step: 2 })
  emit('tool/call', { turn: 7, step: 2, callId: 'fixed-7', name: HOUSE_DRAFT_TOOL })
  await assert.rejects(execute(7, layered), /new owner message/u)
  const recovered = JSON.parse(await execute(7, layered, { callId: 'fixed-7' }))
  const recoveredDraft = store.minecraftHouses.get(recovered.draftId)
  assert.deepEqual(recoveredDraft.layout, layout)
  assert.deepEqual(recovered.materials, first.materials)
  assert.deepEqual(recoveredDraft.reference, { contextId: 'chat.mobile', messageId: 'layered', attachmentId: 'image-cabin' })
  assert.equal(store.minecraftHouses.list().length, 3)
  assert.equal(store.tasks().length, 0)

  const compact = { name: input.name, width: 3, height: 4, depth: 3, assumptions: input.assumptions,
    facade: { floor: 'c', wall: 'o', roof: 's', doorX: 1, frontWindows: [{ x: 2, y: 1 }] } }
  begin(8, message('compact', '请帮我照这张图盖一间木屋', [image]))
  await assert.rejects(execute(8, { ...compact, blocks }), /exactly one of facade, layers or blocks/u)
  await assert.rejects(execute(8, { ...compact, facade: { ...compact.facade, roof: 'g' } }), /facade.roof/u)
  assert.deepEqual(modelLookups, [])
  agent.options = { provider: 'default-provider', model: 'default-model' }
  session.requestHeader = () => ({ config: { provider: 'live-provider', model: 'live-model' } })
  resolveModelInfo = async () => ({ inputModalities: ['text'] })
  const signal = new AbortController().signal
  await assert.rejects(execute(8, compact, { signal }), /cannot read images.*DeepSeek Flash/u)
  assert.deepEqual(modelLookups.at(-1), { provider: 'live-provider', model: 'live-model', signal })
  assert.equal(store.minecraftHouses.list().length, 3)
  resolveModelInfo = async () => ({})
  const compactResult = JSON.parse(await execute(8, compact))
  const compactDraft = store.minecraftHouses.get(compactResult.draftId)
  assert.equal(compactDraft.layout.blocks, 'c.ccccccco.g o.o ooo o.o o.o ooo sss sss sss'.replaceAll(' ', ''))
  assert.deepEqual(compactDraft.reference, { contextId: 'chat.mobile', messageId: 'compact', attachmentId: 'image-cabin' })
  assert.equal(compactDraft.facade, undefined)
  assert.equal(store.tasks().length, 0)

  session.requestHeader = () => undefined
  begin(9, message('stale-during-lookup', '照这张图盖一间小屋', [image]))
  let finishLookup
  resolveModelInfo = () => new Promise(resolve => { finishLookup = resolve })
  const stale = execute(9, compact)
  emit('turn/end', { turn: 9 })
  finishLookup({ inputModalities: ['text', 'image'] })
  await assert.rejects(stale, /new owner message/u)
  assert.equal(modelLookups.at(-1).provider, 'default-provider')
  assert.equal(modelLookups.at(-1).model, 'default-model')
  assert.equal(store.minecraftHouses.list().length, 4)

  begin(10, message('no-vision-needed', '帮我盖一间小屋'))
  resolveModelInfo = async () => ({ inputModalities: ['text'] })
  const countBeforeText = modelLookups.length
  const { assumptions, ...compactWithoutNotes } = compact
  const textCompact = JSON.parse(await execute(10, compactWithoutNotes))
  assert.equal(store.minecraftHouses.get(textCompact.draftId).reference, undefined)
  assert.equal(store.minecraftHouses.get(textCompact.draftId).assumptions, undefined)
  assert.equal(modelLookups.length, countBeforeText)

  begin(11, message('compact-without-notes', '照这张图盖一间小屋', [image]))
  resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] })
  const noNotes = JSON.parse(await execute(11, compactWithoutNotes))
  const noNotesDraft = store.minecraftHouses.get(noNotes.draftId)
  assert.deepEqual(noNotesDraft.layout, compactDraft.layout)
  assert.match(noNotesDraft.assumptions, /按提交的平顶参数.*正面从左数第 2 列.*正面有 1 格玻璃.*左侧有 0 格玻璃/u)
  assert.match(noNotesDraft.assumptions, /默认墙体及留空布局.*对照参考图/u)
  assert.notEqual(noNotesDraft.assumptions, assumptions)
  assert.deepEqual(noNotesDraft.reference, { contextId: 'chat.mobile', messageId: 'compact-without-notes', attachmentId: 'image-cabin' })
  assert.equal(store.tasks().length, 0)
})

async function fixture(t, blueprint = layout) {
  const { store, directory, path } = makeStore(t)
  const zone = store.createBuildZone({ name: '小屋地块', dimension: 'minecraft:overworld', x: 6, y: 80, z: -8, radius: 8 })
  const draft = store.minecraftHouses.create({ ...input, layout: blueprint }, source)
  const state = { receipt: () => ({ built: true, zoneId: zone.id, checked: blueprint.blocks.length, placed: 5,
    consumed: { cobblestone: 1, oak_planks: 2, glass: 2 } }),
    ready: () => ({ online: true, auth: { mode: 'cbi' }, capabilities: { houseBuilding: true } }),
    preview: () => ({ ready: true, checked: blueprint.blocks.length }), buildFailure: undefined, calls: [] }
  const server = createServer(async (req, res) => {
    const body = []
    for await (const chunk of req) body.push(chunk)
    const path = req.url.slice('/api'.length)
    const input = body.length ? JSON.parse(Buffer.concat(body)) : undefined
    state.calls.push({ path, input })
    res.setHeader('content-type', 'application/json')
    if (path === '') res.end(JSON.stringify(await state.ready()))
    else if (path === '/house/preview') res.end(JSON.stringify(await state.preview()))
    else if (path === '/house/build' && state.buildFailure) { res.statusCode = 409; res.end(JSON.stringify({ error: state.buildFailure })) }
    else if (path === '/house/build') res.end(JSON.stringify(await state.receipt()))
    else if (path === '/house/candidates' && state.candidates) res.end(JSON.stringify(await state.candidates()))
    else if (path === '/house/cell' && state.cell) res.end(JSON.stringify(await state.cell(input)))
    else if (path === '/house/verify' && state.verify) res.end(JSON.stringify(await state.verify(input)))
    else if (path === '/stop') res.end('{}')
    else { res.statusCode = 404; res.end('{"error":"unexpected-path"}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const createService = store => {
    const instance = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'owner', workerPort: server.address().port })
    instance.ready = true
    instance.token = 'local-fixture'
    return instance
  }
  const service = createService(store)
  const preview = () => service.previewHouse(draft.id, zone.id, new AbortController().signal)
  const build = previewId => service.buildHouse(draft.id, zone.id, previewId)
  return { store, service, state, zone, draft, preview, build, createService, path }
}

const correctedBlocks = 'coog..g.'

test('material shortage passes only the current volume and planned materials, and cannot approve a build', async t => {
  const h = await fixture(t)
  const previous = await h.preview()
  const failure = { ready: false, checked: layout.blocks.length, reason: 'homebuild-materials' }
  const materials = [
    { material: 'oak_planks', needed: 2, carried: 1, missing: 1 },
    { material: 'glass', needed: 1, carried: 1, missing: 0 },
  ]
  h.state.preview = () => ({ ...failure, materials })
  assert.deepEqual(await h.preview(), { ...failure, materials })
  await assert.rejects(h.build(previous.previewId), /minecraft-house-preview-required/u)
  assert.equal(h.store.tasks().length, 0)

  for (const candidate of [
    { ...failure, materials: [{ material: 'spruce_planks', needed: 1, carried: 0, missing: 1 }] },
    { ...failure, materials: [{ material: 'oak_planks', needed: 3, carried: 2, missing: 1 }] },
    { ...failure, checked: layout.blocks.length - 1, materials },
    failure,
  ]) {
    h.state.preview = () => candidate
    assert.deepEqual(await h.preview(), { ...failure, checked: candidate.checked })
  }
  h.state.preview = () => ({ ...failure, materials: [{ ...materials[0], missing: 2 }] })
  await assert.rejects(h.preview(), /minecraft-house-preview-unconfirmed/u)
  assert.equal(h.state.calls.some(call => call.path === '/house/build'), false)
})

test('owner HTTP revises a blueprint without touching the world and requires fresh approval', async t => {
  const h = await fixture(t)
  let handler, origin
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } }
  registerHttp(ctx, { minecraft: h.service })
  const server = createServer(handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const owner = { 'x-companion-request': '1' }
  const url = `${origin}/companion/api/minecraft/houses/${h.draft.id}`
  const patch = (input, headers = owner) => fetch(url, { method: 'PATCH', body: JSON.stringify(input),
    headers: { 'content-type': 'application/json', ...headers } })
  const history = async () => (await (await fetch(url + '/revisions', { headers: owner })).json()).revisions

  const firstPreview = await h.preview()
  const callCount = h.state.calls.length
  const edit = { expectedRevision: 0, blocks: correctedBlocks }
  assert.equal((await fetch(url + '/revisions')).status, 403)
  assert.equal((await patch(edit, {})).status, 403)
  assert.equal((await patch(edit, { ...owner, origin: 'https://outside.invalid' })).status, 403)
  assert.equal((await patch({ ...edit, zoneId: h.zone.id })).status, 400)
  assert.equal((await patch({ ...edit, blocks: 'o' })).status, 400)
  assert.deepEqual((await history()).map(row => [row.revision, row.blocks]), [[0, layout.blocks]])

  const response = await patch(edit)
  assert.equal(response.status, 200)
  const revised = await response.json()
  assert.equal(revised.revision, 1)
  assert.deepEqual(revised.layout, { ...layout, blocks: correctedBlocks })
  const stale = await patch(edit)
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'minecraft-house-revision-stale')
  assert.deepEqual((await history()).map(row => [row.revision, row.blocks]), [[1, correctedBlocks], [0, layout.blocks]])
  await assert.rejects(h.build(firstPreview.previewId), /minecraft-house-preview-required/u)
  assert.equal(h.state.calls.length, callCount)
  assert.equal(h.store.tasks().length, 0)

  const currentPreview = await h.preview()
  const noChange = await patch({ ...edit, expectedRevision: 1 })
  assert.equal(noChange.status, 200)
  assert.equal((await noChange.json()).revision, 1)
  const built = await h.build(currentPreview.previewId)
  assert.equal(built.status, 'built')
  assert.equal(built.revision, 1)
  assert.equal(h.state.calls.find(call => call.path === '/house/build').input.layout.blocks, correctedBlocks)
  const locked = await patch({ expectedRevision: 1, blocks: layout.blocks })
  assert.equal(locked.status, 409)
  assert.equal((await locked.json()).code, 'minecraft-house-revision-locked')
})

test('preview of an older layout cannot finish late and replace approval for a newer revision', async t => {
  const h = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const preview = h.state.preview
  h.state.preview = async () => { entered.resolve(); await release.promise; return preview() }
  const stale = assert.rejects(h.preview(), /minecraft-house-revision-stale/u)
  await entered.promise
  try {
    h.service.reviseHouse(h.draft.id, { expectedRevision: 0, blocks: correctedBlocks })
    h.state.preview = preview
    const current = await h.preview()
    release.resolve()
    await stale
    assert.equal((await h.build(current.previewId)).status, 'built')
    const checks = h.state.calls.filter(call => call.path === '/house/preview')
    assert.deepEqual(checks.map(call => call.input.layout.blocks), [layout.blocks, correctedBlocks])
  } finally { release.resolve() }
})

test('an edit during asynchronous build readiness invalidates the approval before any task is created', async t => {
  const h = await fixture(t)
  const approval = await h.preview()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const ready = h.state.ready
  h.state.ready = async () => { entered.resolve(); await release.promise; return ready() }
  const stale = assert.rejects(h.build(approval.previewId), /minecraft-house-preview-required/u)
  await entered.promise
  try {
    h.service.reviseHouse(h.draft.id, { expectedRevision: 0, blocks: correctedBlocks })
    release.resolve()
    await stale
    assert.equal(h.store.tasks().length, 0)
    assert.equal(h.state.calls.some(call => call.path === '/house/build'), false)
  } finally { release.resolve() }
})

test('owner approval binds an immutable draft and zone to a fresh preview and only one verified build', async t => {
  const h = await fixture(t)
  await assert.rejects(h.build(randomUUID()), /minecraft-house-preview-required/u)
  const expired = await h.preview()
  const clock = Date.now()
  t.mock.method(Date, 'now', () => clock + 120_001)
  await assert.rejects(h.build(expired.previewId), /minecraft-house-preview-required/u)
  t.mock.restoreAll()
  const stale = await h.preview()
  const approved = await h.preview()
  await assert.rejects(h.build(stale.previewId), /minecraft-house-preview-required/u)
  await assert.rejects(h.service.buildHouse(h.draft.id, randomUUID(), approved.previewId), /minecraft-house-preview-required/u)
  const concurrent = await Promise.allSettled([h.build(approved.previewId), h.build(approved.previewId)])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  const done = await h.build(approved.previewId)
  assert.equal(done.status, 'built')
  assert.equal(done.zoneId, h.zone.id)
  assert.deepEqual(done.receipt, h.state.receipt())
  assert.equal(h.state.calls.filter(call => call.path === '/house/build').length, 1)
  assert.deepEqual(h.state.calls.find(call => call.path === '/house/build').input.layout, layout)
  const tasks = h.store.tasks(20, 'minecraft.house')
  assert.deepEqual(tasks.map(task => task.status), ['succeeded'])
  const memory = h.store.memory.list().find(item => item.content.includes('按蓝图搭完小屋'))
  assert.equal(memory?.scope, 'shared')
  assert.equal(memory.sourceRefs[0].taskId, tasks[0].id)
})

test('unverified placement never produces success and can be resumed after a new preview', async t => {
  const h = await fixture(t)
  const original = h.state.receipt
  h.state.receipt = () => ({ ...original(), consumed: { glass: 5 } })
  const approval = await h.preview()
  await assert.rejects(h.build(approval.previewId), /minecraft-house-receipt-unconfirmed/u)
  assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
  assert.throws(() => h.service.reviseHouse(h.draft.id, { expectedRevision: 0, blocks: correctedBlocks }), /minecraft-house-revision-locked/u)
  assert.equal(h.store.memory.list().length, 0)
  await assert.rejects(h.build(approval.previewId), /minecraft-house-preview-required/u)
  h.state.receipt = () => ({ ...original(), placed: 0, consumed: {} })
  assert.equal((await h.build((await h.preview()).previewId)).receipt.placed, 0)
  assert.deepEqual(h.store.tasks(20, 'minecraft.house').map(task => task.status).sort(), ['failed', 'succeeded'])
})

test('a route interruption independently rechecks the same layout and adapts the next step without dispatching again', async t => {
  const h = await fixture(t)
  const approval = await h.preview()
  h.state.buildFailure = 'homebuild-unreachable-placement'
  h.state.preview = () => ({ ready: false, reason: 'homebuild-materials', checked: layout.blocks.length,
    materials: [{ material: 'glass', needed: 1, carried: 0, missing: 1 }] })
  await assert.rejects(h.build(approval.previewId), /homebuild-unreachable-placement/u)

  const { recovery } = (await h.service.houses()).drafts[0]
  assert.equal(recovery.reason, 'homebuild-unreachable-placement')
  assert.equal(recovery.next, 'check-materials')
  assert.equal(recovery.verification, 'blocked')
  const task = h.store.tasks(10, 'minecraft.house')[0]
  assert.equal(task.status, 'failed')
  assert.equal(task.error, 'homebuild-unreachable-placement')
  assert.deepEqual(h.store.activityByEventId(`minecraft-house-recovery:${task.id}`).data, recovery)
  const rechecks = h.state.calls.filter(call => call.path === '/house/preview')
  assert.equal(rechecks.length, 2)
  assert.deepEqual(rechecks[1].input, rechecks[0].input)
  assert.equal(h.state.calls.filter(call => call.path === '/house/build').length, 1)
  assert.equal(h.store.memory.list().length, 0)
  await assert.rejects(h.build(approval.previewId), /minecraft-house-preview-required/u)

  h.state.buildFailure = undefined
  h.state.preview = () => ({ ready: true, checked: layout.blocks.length })
  const built = await h.build((await h.preview()).previewId)
  assert.equal(built.status, 'built')
  assert.equal((await h.service.houses()).drafts[0].recovery, undefined)
})

test('unknown interruption is investigated once without exposing untrusted detail or retrying a world write', async t => {
  const h = await fixture(t)
  const approval = await h.preview()
  h.state.buildFailure = 'unexpected transport detail'
  await assert.rejects(h.build(approval.previewId), { code: h.state.buildFailure })
  const { recovery } = (await h.service.houses()).drafts[0]
  assert.equal(recovery.reason, 'house-result-unconfirmed')
  assert.equal(recovery.next, 'recheck-site')
  assert.equal(recovery.verification, 'ready')
  assert.equal(h.state.calls.filter(call => call.path === '/house/preview').length, 2)
  assert.equal(h.state.calls.filter(call => call.path === '/house/build').length, 1)
  await assert.rejects(h.build(approval.previewId), /minecraft-house-preview-required/u)
})

test('unsafe build failures leave a safety decision without additional world reads', async t => {
  for (const [error, reason] of [
    ['homebuild-unsafe-player', 'homebuild-unsafe-player'],
    ['house-ownership-unconfirmed', 'house-ownership-unconfirmed'],
    ['house-cancelled', 'house-cancelled'],
  ]) await t.test(reason, async subtest => {
    const h = await fixture(subtest)
    const approval = await h.preview()
    h.state.buildFailure = error
    await assert.rejects(h.build(approval.previewId), { code: error })
    const { recovery } = (await h.service.houses()).drafts[0]
    assert.equal(recovery.reason, reason)
    assert.equal(recovery.next, 'check-safety')
    assert.equal(recovery.verification, undefined)
    assert.equal(h.state.calls.filter(call => call.path === '/house/preview').length, 1)
    assert.equal(h.store.activities().some(row => row.kind === 'world.house-recovery'), false)
  })
})

test('model recovery can re-observe only the latest authorized interrupted construction', async t => {
  const h = await fixture(t)
  const first = await h.preview()
  h.state.buildFailure = 'homebuild-unreachable-placement'
  await assert.rejects(h.build(first.previewId), /homebuild-unreachable-placement/u)
  const attempt = h.store.tasks(10, 'minecraft.house')[0]
  const [source] = h.service.recoverySources(Date.now())
  assert.equal(source.taskId, attempt.id)
  assert.deepEqual(h.service.recoverySource(attempt.id), source)
  assert.equal(source.reason, 'homebuild-unreachable-placement')
  assert.equal(source.verification, 'ready')
  assert.deepEqual(Object.keys(source).sort(), ['at', 'reason', 'taskId', 'verification'])
  assert.equal(h.service.recoverySource(randomUUID()), undefined)

  const materials = [{ material: 'glass', needed: 1, carried: 0, missing: 1 }]
  h.state.preview = () => ({ ready: false, reason: 'homebuild-materials', checked: layout.blocks.length, materials })
  const signal = new AbortController().signal
  assert.deepEqual(await h.service.resurveyRecovery(attempt.id, signal), {
    state: 'blocked', reason: 'homebuild-materials', checked: layout.blocks.length, materials,
  })
  assert.equal(h.store.tasks(10, 'minecraft.house').length, 1)
  assert.equal(h.state.calls.filter(call => call.path === '/house/build').length, 1)
  await assert.rejects(h.build(first.previewId), /minecraft-house-preview-required/u)
  assert.equal(await h.service.revokeBuildZone(h.zone.id), true)
  assert.deepEqual(h.service.recoverySources(Date.now()), [])
  await assert.rejects(h.service.resurveyRecovery(attempt.id, signal), { code: 'minecraft-house-recovery-source-changed' })
})

test('single-cell recovery records only an independently matched physical receipt without completing the house', async t => {
  const h = await fixture(t)
  const first = await h.preview()
  h.state.buildFailure = 'homebuild-unreachable-placement'
  await assert.rejects(h.build(first.previewId), /homebuild-unreachable-placement/u)
  const attempt = h.store.tasks(10, 'minecraft.house')[0]
  const signal = new AbortController().signal
  assert.equal(await h.service.recoveryPlacementAvailable(attempt.id, signal), false)
  h.state.ready = () => ({ online: true, auth: { mode: 'cbi' }, capabilities: { houseBuilding: true, houseCellPlacement: true } })
  assert.equal(await h.service.recoveryPlacementAvailable(attempt.id, signal), true)
  const candidate = { index: 1, x: 1, y: 0, z: 0, material: 'oak_planks' }
  h.state.candidates = () => ({ checked: 5, blocked: 0, candidates: [{ ...candidate, x: 0 }] })
  await assert.rejects(h.service.recoveryCandidates(attempt.id, signal), { code: 'minecraft-house-candidates-unconfirmed' })
  h.state.candidates = () => ({ checked: 5, blocked: 1, candidates: [candidate] })
  assert.deepEqual(await h.service.recoveryCandidates(attempt.id, signal), h.state.candidates())
  await assert.rejects(h.service.placeRecoveryCell(attempt.id, 3, signal), { code: 'minecraft-house-cell-invalid' })
  assert.deepEqual(h.store.tasks(10, HOUSE_CELL_CAPABILITY), [])
  h.state.cell = ({ index }) => index === 0 ? { index, material: 'cobblestone', outcome: 'blocked', consumed: 0, reason: 'homebuild-obstructed' }
    : { index, material: 'oak_planks', outcome: 'placed', consumed: 1 }
  assert.equal((await h.service.placeRecoveryCell(attempt.id, 0, signal)).outcome, 'blocked')
  assert.deepEqual(h.store.memory.list(), [])
  const ownerPreview = await h.preview()
  assert.equal((await h.service.placeRecoveryCell(attempt.id, 1, signal)).outcome, 'placed')
  await assert.rejects(h.build(ownerPreview.previewId), /minecraft-house-preview-required/u)
  await assert.rejects(h.service.placeRecoveryCell(attempt.id, 2, signal), { code: 'minecraft-house-cell-already-attempted' })
  assert.equal(h.store.taskByExternalId(`${HOUSE_CELL_TASK_PREFIX}${attempt.id}:0`).status, 'failed')
  assert.equal(h.store.taskByExternalId(`${HOUSE_CELL_TASK_PREFIX}${attempt.id}:1`).status, 'succeeded')
  const audit = h.store.activityByEventId(HOUSE_CELL_AUDIT_PREFIX + attempt.id)
  assert.deepEqual(audit.data, { index: 1, material: 'oak_planks' })
  const activity = h.store.activities().find(row => row.kind === HOUSE_CELL_ACTIVITY)
  assert.deepEqual(activity.data, { material: 'oak_planks', placed: 1 })
  assert.equal(activity.taskId, undefined)
  assert.equal(h.store.memory.list().length, 1)
  assert.deepEqual(h.store.memory.list()[0].sourceRefs, [{ contextId: 'game.minecraft', activityId: activity.id }])
  const [draft] = (await h.service.houses()).drafts
  assert.equal(draft.status, 'interrupted')
  assert.deepEqual(draft.recovery.agentDecision.placed, audit.data)
  assert.equal(draft.receipt, undefined)
  assert.equal(h.store.tasks(10, 'minecraft.house').length, 1)
})

async function interruptedPlacement(t, blueprint = layout) {
  const h = await fixture(t, blueprint)
  const first = await h.preview()
  h.state.buildFailure = 'homebuild-unreachable-placement'
  await assert.rejects(h.build(first.previewId), /homebuild-unreachable-placement/u)
  const attempt = h.store.tasks(10, 'minecraft.house')[0]
  h.state.ready = () => ({ online: true, auth: { mode: 'cbi' }, capabilities: { houseBuilding: true, houseCellPlacement: true } })
  const enable = (settings = {}) => h.store.autonomy.saveSettings({ ...h.store.autonomy.settings(), enabled: true,
    minecraftRecoveryEnabled: true, minecraftRecoveryPlacementEnabled: true, minecraftRecoveryContinuousEnabled: true, ...settings })
  const place = (index, signal = new AbortController().signal, mode = 'continuous') => h.service.placeRecoveryCell(attempt.id, index, signal, mode)
  const verify = (signal = new AbortController().signal, authorize = () => {}) => h.service.verifyRecoveryCompletion(attempt.id, signal, authorize)
  const journal = () => h.store.minecraftHouses.recoveryCells(attempt.id)
  const dispatches = () => h.state.calls.filter(call => call.path === '/house/cell').map(call => call.input.index)
  return { ...h, attempt, enable, place, verify, journal, dispatches }
}

const allCellsMatched = { checked: 8, matched: 8, missing: 0, blocked: 0, issues: [] }

test('whole-house verification reports a missing block and a reserved-air obstruction before recording a completed house', async t => {
  const h = await interruptedPlacement(t)
  h.enable()
  h.state.cell = ({ index }) => ({ index, material: index === 0 ? 'cobblestone' : 'oak_planks', outcome: 'placed', consumed: 1 })
  await h.place(0)
  const partial = { checked: 8, matched: 6, missing: 1, blocked: 1, issues: [{ index: 1, reason: 'missing' }, { index: 3, reason: 'blocked' }] }
  h.state.verify = () => partial
  assert.deepEqual(await h.verify(), { outcome: 'incomplete', verification: partial })
  assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
  assert.equal(h.store.tasks(10, 'minecraft.house').length, 1)
  assert.equal(h.store.activities().filter(activity => activity.kind === MINECRAFT_HOUSE_EVENT).length, 0)
  await h.place(1)
  h.state.verify = () => allCellsMatched
  const oldJournal = h.journal()
  const result = await h.verify()
  assert.deepEqual(result, { outcome: 'completed', verification: allCellsMatched, placed: 2 })
  assert.equal(h.service.recoveryCompletionValid(h.attempt.id, result), true)
  assert.equal(h.service.recoveryCompletionValid(h.attempt.id, { ...result, placed: 3 }), false)
  assert.equal(h.service.recoveryCompletionValid(h.attempt.id, { ...result, verification: { ...allCellsMatched, missing: 1 } }), false)
  assert.equal(h.service.recoveryCompletionValid(randomUUID(), result), false)
  assert.deepEqual(h.dispatches(), [0, 1])
  assert.equal(h.state.calls.filter(call => call.path === '/house/build').length, 1)
  assert.deepEqual(h.state.calls.filter(call => call.path === '/house/verify').map(call => call.input.layout), [layout, layout])
  const completion = h.store.taskByExternalId(HOUSE_COMPLETION_TASK_PREFIX + h.attempt.id)
  assert.notEqual(completion.id, h.attempt.id)
  assert.equal(completion.capabilityId, 'minecraft.house')
  assert.equal(completion.status, 'succeeded')
  assert.deepEqual(h.store.taskById(h.attempt.id), h.attempt)
  assert.deepEqual(h.journal(), oldJournal)
  const [draft] = (await h.service.houses()).drafts
  assert.equal(draft.status, 'built')
  assert.deepEqual(draft.receipt, { built: true, zoneId: h.zone.id, checked: 8, placed: 2, consumed: { cobblestone: 1, oak_planks: 1 } })
  assert.equal(h.store.minecraftHouses.latestAttempt(h.draft.id), completion.id)
  const activity = h.store.activityByTask(completion.id, MINECRAFT_HOUSE_EVENT, 'game.minecraft')
  assert.equal(activity.summary, minecraftHouseBuildSummary(draft.receipt))
  assert.deepEqual(activity.data, {})
  const shared = h.store.memory.list().find(memory => memory.content === activity.summary)
  assert.equal(shared.scope, 'shared')
  assert.deepEqual(shared.sourceRefs, [{ contextId: 'game.minecraft', taskId: completion.id, activityId: activity.id }])
  assert.equal(verifiedMinecraftMilestone(h.store, 'house', completion.id).experience.draftId, draft.id)
  await assert.rejects(h.verify(), { code: 'minecraft-house-recovery-source-changed' })
  const reopened = new CompanionStore(h.path)
  try {
    const service = h.createService(reopened)
    assert.equal(service.recoveryCompletionValid(h.attempt.id, result), true)
    await assert.rejects(service.verifyRecoveryCompletion(h.attempt.id, new AbortController().signal, () => {}),
      { code: 'minecraft-house-recovery-source-changed' })
    assert.equal(reopened.activities().filter(event => event.kind === MINECRAFT_HOUSE_EVENT).length, 1)
  } finally { reopened.close() }
})

test('completion refuses incomplete authority, missing physical evidence, and mismatched Worker proofs', async t => {
  const h = await interruptedPlacement(t)
  const code = 'minecraft-house-recovery-placement-unconfirmed'
  h.enable({ minecraftRecoveryContinuousEnabled: false })
  await assert.rejects(h.verify(), { code: 'minecraft-house-continuous-not-authorized' })
  h.enable()
  await assert.rejects(h.verify(), { code })
  h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
  await h.place(0)
  for (const impossible of [{ ...allCellsMatched, checked: 7, matched: 7 }, { ...allCellsMatched, missing: 1 },
    { ...allCellsMatched, matched: 7, missing: 1, issues: [{ index: 3, reason: 'missing' }] }]) {
    h.state.verify = () => impossible
    await assert.rejects(h.verify(), { code: 'minecraft-house-verification-unconfirmed' })
  }
  h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
  await assert.rejects(h.place(1), { code: 'minecraft-house-cell-unconfirmed' })
  await assert.rejects(h.verify(), { code })
  assert.equal(h.state.calls.filter(call => call.path === '/house/verify').length, 3)
  assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
  assert.deepEqual(h.journal().map(row => row.outcome), ['placed', 'unconfirmed'])
})

test('whole-house readback checks pause and model authorization before recording any completion', async t => {
  for (const mode of ['abort', 'grant revoked', 'turn revoked', 'zone revoked']) await t.test(mode, async subtest => {
    const h = await interruptedPlacement(subtest)
    h.enable()
    h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
    await h.place(0)
    const controller = new AbortController()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    h.state.verify = async () => { entered.resolve(); await release.promise; return allCellsMatched }
    let active = true
    const attempt = assert.rejects(h.verify(controller.signal, () => { if (!active) throw new Error('turn lost') }),
      mode === 'grant revoked' ? { code: 'minecraft-house-continuous-not-authorized' } : mode === 'turn revoked' ? /turn lost/u : { name: 'AbortError' })
    await entered.promise
    try {
      if (mode === 'abort') controller.abort()
      if (mode === 'grant revoked') h.enable({ minecraftRecoveryContinuousEnabled: false })
      if (mode === 'turn revoked') active = false
      if (mode === 'zone revoked') assert.equal(await h.service.revokeBuildZone(h.zone.id), true)
    } finally { release.resolve() }
    await attempt
    assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
    assert.equal(h.store.taskByExternalId(HOUSE_COMPLETION_TASK_PREFIX + h.attempt.id), undefined)
    assert.deepEqual(h.journal().map(row => row.outcome), ['placed'])
  })
})

test('an interrupted house displays only a bound successful incomplete check for its exact layout', async t => {
  for (const valid of [true, false]) await t.test(valid ? 'exact check' : 'wrong blueprint volume', async subtest => {
    const h = await interruptedPlacement(subtest)
    h.enable()
    h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
    await h.place(0)
    const job = h.store.autonomy.create({ kind: 'minecraft.recovery', contextId: MINECRAFT_RECOVERY_CONTEXT, dedupeKey: h.attempt.id, runAfter: 0 })
    const checked = valid ? 8 : 7
    const verification = { outcome: 'incomplete', verification: { checked, matched: checked - 1, missing: 0, blocked: 1, issues: [{ index: 3, reason: 'blocked' }] } }
    h.store.recordActivity({ eventId: HOUSE_AGENT_RECOVERY_PREFIX + h.attempt.id, taskId: job.id, contextId: MINECRAFT_RECOVERY_CONTEXT,
      source: 'game.minecraft', kind: HOUSE_AGENT_RECOVERY_EVENT, summary: '部分核验', data: { verification } })
    const read = async () => (await h.service.houses()).drafts[0].recovery.agentDecision
    assert.equal((await read()).verification, undefined)
    h.store.transitionTask(job.id, 'running')
    h.store.transitionTask(job.id, 'succeeded')
    assert.deepEqual((await read()).verification, valid ? verification : undefined)
    assert.deepEqual((await read()).placements, [{ index: 0, material: 'cobblestone' }])
  })
})

test('the full verification fences a concurrent build and rolls back if recording the completion fails', async t => {
  const h = await interruptedPlacement(t)
  h.enable()
  h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
  await h.place(0)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.state.verify = async () => { entered.resolve(); await release.promise; return allCellsMatched }
  const record = h.store.recordActivity.bind(h.store)
  let simulateFailure = true
  t.mock.method(h.store, 'recordActivity', input => {
    if (simulateFailure && input.kind === MINECRAFT_HOUSE_EVENT) throw new Error('simulated persistence failure')
    return record(input)
  })
  const attempt = assert.rejects(h.verify(), /simulated persistence failure/u)
  await entered.promise
  try {
    await assert.rejects(h.place(1), { code: 'minecraft-house-unavailable' })
    await assert.rejects(h.preview(), { code: 'minecraft-house-unavailable' })
  } finally { release.resolve() }
  await attempt
  assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
  assert.equal(h.store.taskByExternalId(HOUSE_COMPLETION_TASK_PREFIX + h.attempt.id), undefined)
  assert.equal(h.store.activities().filter(event => event.kind === MINECRAFT_HOUSE_EVENT).length, 0)
  assert.deepEqual(h.journal().map(row => row.outcome), ['placed'])
  simulateFailure = false
  assert.equal((await h.verify()).outcome, 'completed')
  assert.equal(h.store.activities().filter(event => event.kind === MINECRAFT_HOUSE_EVENT).length, 1)
})

test('continuous construction needs its own live grant and cannot be promoted mid-journal', async t => {
  const h = await interruptedPlacement(t)
  for (const setting of ['enabled', 'minecraftRecoveryEnabled', 'minecraftRecoveryPlacementEnabled', 'minecraftRecoveryContinuousEnabled']) {
    h.enable({ [setting]: false })
    await assert.rejects(h.place(0), { code: 'minecraft-house-continuous-not-authorized' })
  }
  assert.deepEqual(h.journal(), [])
  assert.deepEqual(h.dispatches(), [])
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const ready = h.state.ready
  h.state.ready = async () => { entered.resolve(); await release.promise; return ready() }
  h.enable()
  const revokedDuringRead = assert.rejects(h.place(0), { code: 'minecraft-house-continuous-not-authorized' })
  await entered.promise
  h.enable({ minecraftRecoveryContinuousEnabled: false })
  release.resolve()
  await revokedDuringRead
  assert.deepEqual(h.journal(), [])
  assert.deepEqual(h.dispatches(), [])
  h.state.cell = ({ index }) => ({ outcome: 'blocked', index, material: 'cobblestone', reason: 'homebuild-obstructed', consumed: 0 })
  assert.equal((await h.place(0, undefined, 'single')).outcome, 'blocked')
  h.enable()
  await assert.rejects(h.place(1), { code: 'minecraft-house-cell-already-attempted' })
  assert.deepEqual(h.dispatches(), [0])
  assert.deepEqual(h.journal().map(row => [row.mode, row.outcome]), [['single', 'blocked']])
})

test('a continuous journal follows confirmed receipts in execution order, keeps public memories, and stops at three placements', async t => {
  const h = await interruptedPlacement(t, { ...layout, blocks: 'cooosgg.' })
  h.enable()
  const seen = []
  h.state.cell = ({ index }) => {
    const last = h.journal().at(-1)
    seen.push([last.index, last.outcome, h.store.taskById(last.taskId).status])
    if (index === 0) return { index, material: 'cobblestone', outcome: 'blocked', reason: 'homebuild-materials', consumed: 0 }
    if (index === 5) return { index, material: 'glass', outcome: 'already-present', consumed: 0 }
    return { index, material: index === 6 ? 'glass' : 'oak_planks', outcome: 'placed', consumed: 1 }
  }
  for (const index of [0, 2, 5, 1, 6]) await h.place(index)
  await assert.rejects(h.place(1), { code: 'minecraft-house-cell-already-attempted' })
  await assert.rejects(h.place(3), { code: 'minecraft-house-cell-already-attempted' })
  assert.deepEqual(h.dispatches(), [0, 2, 5, 1, 6])
  assert.deepEqual(seen, h.dispatches().map(index => [index, 'started', 'running']))
  assert.deepEqual(h.journal().map(row => [row.index, row.outcome]), [[0, 'blocked'], [2, 'placed'], [5, 'already-present'], [1, 'placed'], [6, 'placed']])
  assert.ok(h.journal().every(row => row.settledAt && row.mode === 'continuous'))
  const privateAudits = [2, 1, 6].map(index => h.store.activityByEventId(`${HOUSE_CELL_AUDIT_PREFIX}${h.attempt.id}:${index}`))
  assert.ok(privateAudits.every(activity => activity?.contextId === MINECRAFT_RECOVERY_CONTEXT && activity.kind === HOUSE_CELL_AUDIT_ACTIVITY))
  const publicEvents = h.store.activities().filter(activity => activity.kind === HOUSE_CELL_ACTIVITY)
  assert.equal(publicEvents.length, 3)
  assert.ok(publicEvents.every(activity => activity.taskId === undefined && activity.contextId === 'game.minecraft' && activity.data.placed === 1))
  assert.equal(h.store.memory.list().length, 2)
  assert.equal(h.store.memory.list().find(memory => memory.content.includes('橡木木板')).sourceRefs.length, 2)
  assert.equal(h.store.activities().filter(activity => activity.kind === 'world.house-built').length, 0)
  const reopened = new CompanionStore(h.path)
  try {
    const after = h.createService(reopened)
    const [draft] = (await after.houses()).drafts
    assert.equal(draft.status, 'interrupted')
    assert.equal(draft.receipt, undefined)
    assert.equal(draft.recovery.agentDecision.placed, undefined)
    assert.deepEqual(draft.recovery.agentDecision.placements, [{ index: 2, material: 'oak_planks' },
      { index: 1, material: 'oak_planks' }, { index: 6, material: 'glass' }])
    await assert.rejects(after.placeRecoveryCell(h.attempt.id, 0, new AbortController().signal, 'continuous'), { code: 'minecraft-house-cell-already-attempted' })
  } finally { reopened.close() }
})

test('a received and authenticated cell receipt remains evidence if the model is cancelled after readback', async t => {
  const h = await interruptedPlacement(t)
  h.enable()
  h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
  const controller = new AbortController()
  const request = h.service.request.bind(h.service)
  t.mock.method(h.service, 'request', async (path, ...args) => {
    const result = await request(path, ...args)
    if (path === '/house/cell') controller.abort()
    return result
  })
  assert.equal((await h.place(0, controller.signal)).outcome, 'placed')
  assert.equal(controller.signal.aborted, true)
  assert.equal(h.journal()[0].outcome, 'placed')
  assert.equal(h.store.memory.list().length, 1)
})

test('host restart seals a claimed cell with no receipt and preserves the preceding settled one', async t => {
  const h = await interruptedPlacement(t)
  h.enable()
  h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
  await h.place(0)
  const pending = h.store.transaction(() => {
    const task = h.store.createTask({ externalId: `${HOUSE_CELL_TASK_PREFIX}${h.attempt.id}:1`, capabilityId: HOUSE_CELL_CAPABILITY,
      contextId: MINECRAFT_RECOVERY_CONTEXT, title: 'pending cell at crash' })
    h.store.minecraftHouses.startRecoveryCell(h.attempt.id, task.id, { index: 1, material: 'oak_planks' }, 'continuous')
    return h.store.transitionTask(task.id, 'running')
  })
  const reopened = new CompanionStore(h.path)
  try {
    const after = h.createService(reopened)
    after.reconcileHouseRuns()
    after.reconcileHouseRuns()
    assert.equal(reopened.taskById(pending.id).status, 'cancelled')
    assert.equal(reopened.taskById(pending.id).error, 'minecraft-house-cell-unconfirmed-after-restart')
    assert.deepEqual(reopened.minecraftHouses.recoveryCells(h.attempt.id).map(row => row.outcome), ['placed', 'unconfirmed'])
    const [draft] = (await after.houses()).drafts
    assert.deepEqual(draft.recovery.agentDecision.placements, [{ index: 0, material: 'cobblestone' }])
    await assert.rejects(after.placeRecoveryCell(h.attempt.id, 2, new AbortController().signal, 'continuous'), { code: 'minecraft-house-cell-unconfirmed' })
    assert.deepEqual(h.dispatches(), [0])
  } finally { reopened.close() }
})

test('continuous recovery consumes no-write attempts and has a durable six-attempt limit', async t => {
  const h = await interruptedPlacement(t, { ...layout, blocks: 'cooosgg.' })
  h.enable()
  const materials = ['cobblestone', 'oak_planks', 'oak_planks', 'oak_planks', 'spruce_planks', 'glass']
  h.state.cell = ({ index }) => ({ index, material: materials[index], outcome: 'blocked', reason: 'homebuild-obstructed', consumed: 0 })
  for (const index of [0, 1, 2, 3, 4, 5]) await h.place(index)
  await assert.rejects(h.place(6), { code: 'minecraft-house-cell-already-attempted' })
  assert.deepEqual(h.dispatches(), [0, 1, 2, 3, 4, 5])
  assert.equal(h.journal().length, 6)
  assert.deepEqual(h.store.memory.list(), [])
})

test('a cancelled or ambiguous cell seals future dispatch without erasing earlier placement evidence', async t => {
  for (const error of ['invalid receipt', 'aborted request']) await t.test(error, async subtest => {
    const h = await interruptedPlacement(subtest)
    h.enable()
    h.state.cell = ({ index }) => ({ index, material: 'cobblestone', outcome: 'placed', consumed: 1 })
    await h.place(0)
    const controller = new AbortController()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    h.state.cell = async ({ index }) => {
      entered.resolve()
      await release.promise
      return { index, material: 'spruce_planks', outcome: 'placed', consumed: 1 }
    }
    const interrupted = assert.rejects(h.place(1, controller.signal), error === 'invalid receipt'
      ? { code: 'minecraft-house-cell-unconfirmed' } : { name: 'AbortError' })
    await entered.promise
    try {
      assert.equal(h.journal().at(-1).outcome, 'started')
      await assert.rejects(h.place(2), { code: 'minecraft-house-unavailable' })
      if (error === 'aborted request') controller.abort()
      release.resolve()
      await interrupted
    } finally { release.resolve() }
    assert.deepEqual(h.journal().map(row => row.outcome), ['placed', 'unconfirmed'])
    assert.equal(h.store.taskById(h.journal().at(-1).taskId).status, error === 'invalid receipt' ? 'failed' : 'cancelled')
    await assert.rejects(h.place(2), { code: 'minecraft-house-cell-unconfirmed' })
    assert.deepEqual(h.dispatches(), [0, 1])
    const [draft] = (await h.service.houses()).drafts
    assert.deepEqual(draft.recovery.agentDecision.placements, [{ index: 0, material: 'cobblestone' }])
    assert.equal(h.store.memory.list().length, 1)
  })
})

test('pre-journal single receipts still project and protect their interrupted attempt from any replay', async t => {
  const h = await interruptedPlacement(t)
  h.enable()
  const legacy = h.store.createTask({ externalId: `${HOUSE_CELL_TASK_PREFIX}${h.attempt.id}:1`, capabilityId: HOUSE_CELL_CAPABILITY,
    contextId: MINECRAFT_RECOVERY_CONTEXT, title: '0.78 placement' })
  h.store.transitionTask(legacy.id, 'running')
  h.store.transitionTask(legacy.id, 'succeeded')
  h.store.recordActivity({ eventId: HOUSE_CELL_AUDIT_PREFIX + h.attempt.id, contextId: MINECRAFT_RECOVERY_CONTEXT,
    taskId: legacy.id, source: 'game.minecraft', kind: HOUSE_CELL_AUDIT_ACTIVITY, summary: '0.78 recorded cell', data: { index: 1, material: 'oak_planks' } })
  assert.deepEqual(h.journal(), [])
  const [draft] = (await h.service.houses()).drafts
  assert.deepEqual(draft.recovery.agentDecision.placed, { index: 1, material: 'oak_planks' })
  assert.equal(draft.recovery.agentDecision.placements, undefined)
  await assert.rejects(h.place(2), { code: 'minecraft-house-cell-already-attempted' })
  assert.deepEqual(h.dispatches(), [])
})

test('zone revocation cancels a live house attempt and prevents progress or reuse', async t => {
  const h = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const original = h.state.receipt
  h.state.receipt = async () => { entered.resolve(); await release.promise; return original() }
  const approval = await h.preview()
  const attempt = assert.rejects(h.build(approval.previewId), /minecraft-house-cancelled/u)
  await entered.promise
  try {
    assert.equal(await h.service.revokeBuildZone(h.zone.id), true)
    await attempt
    assert.equal(h.store.minecraftHouses.get(h.draft.id).status, 'interrupted')
    assert.equal(h.store.memory.list().length, 0)
    assert.equal(h.state.calls.some(call => call.path === '/stop'), true)
    await assert.rejects(h.preview(), /build-zone-not-found/u)
  } finally { release.resolve() }
})
