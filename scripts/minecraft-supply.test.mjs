import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { z } from 'zod'
import { MINECRAFT_SHARE_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { registerMemoryRecall } from '../src/host/recall.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

function fixture(t, radius = 4) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-supply-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const deviceId = '9b8eb34b-fe31-4830-86d7-ae8076872759'
  store.createDevice({ id: deviceId, name: 'Camp fixture', secretHash: 'fixture', createdAt: new Date().toISOString() })
  const zone = store.createBuildZone({ name: '隐私营地', dimension: 'minecraft:overworld', x: 417, y: 64, z: 915, radius })
  const sent = []
  const calls = []
  const completeAction = action => {
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: `minecraft.${action}`, title: 'Test game receipt' })
    store.transitionTask(task.id, 'running')
    return store.transitionTask(task.id, 'succeeded')
  }
  const minecraft = {
    async eventPrompt() { throw new Error('Unexpected game event') },
    finishEvent() { throw new Error('Unexpected game event') },
    async inspectSupply() { return { recipe: 'oak_planks', availableLogs: 3, planks: 0 } },
    async supply(zoneId, recipe, signal) {
      signal.throwIfAborted()
      calls.push({ zoneId, recipe })
      const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.craft', title: 'Test craft receipt' })
      store.transitionTask(task.id, 'running')
      store.transitionTask(task.id, 'succeeded')
      return { task, result: { crafted: true, name: recipe, count: 4 } }
    },
    async inspectCampBuild() { return { material: 'cherry_planks', availableFloor: 8, workbenches: 1 } },
    async buildAutonomousCamp(zoneId, material, signal) {
      signal.throwIfAborted()
      calls.push({ zoneId, material })
      const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.build', title: 'Test camp receipt' })
      store.transitionTask(task.id, 'running')
      store.transitionTask(task.id, 'succeeded')
      return { task, result: { built: true, zoneId, material, placedFloor: 8, placedTable: 1 } }
    },
    async inspectCampPreparation() { return { material: 'cherry_planks', batches: 2, availableFloor: 0 } },
    async prepareAutonomousCamp(zoneId, offer, { checkPermit, onStep }) {
      for (let index = 0; index < offer.batches; index++) {
        checkPermit()
        calls.push({ zoneId, recipe: offer.material })
        onStep({ action: 'craft', taskId: completeAction('craft').id })
      }
      checkPermit()
      calls.push({ zoneId, material: offer.material })
      const task = completeAction('build')
      onStep({ action: 'build', taskId: task.id })
      return { task, result: { built: true, zoneId, material: offer.material, placedFloor: 8, placedTable: 1 } }
    },
    async inspectCampSurvey(_zoneId, signal) {
      signal.throwIfAborted()
      return { directions: ['north', 'east'] }
    },
    async surveyCamp(zoneId, direction, signal) {
      signal.throwIfAborted()
      calls.push({ zoneId, direction })
      return { task: completeAction('survey'), result: { surveyed: true, zoneId, direction, steps: 4, reached: true, returned: true } }
    },
  }
  const sessions = {
    async create(input) { return { binding: store.bindContext({ ...input, sessionId: input.sessionId ?? 'supply-review' }) } },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, messageId: `permit-${sent.length + 1}`, sessionId: 'supply-review' }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel() {},
  }
  const service = new AutonomyService(store, sessions, undefined, minecraft, input => store.feed.create(input))
  service.updateSettings({ quietStart: '00:00', quietEnd: '00:00' })
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  async function due(job) {
    store.autonomy.update(job.id, { runAfter: Date.now() - 1 })
    service.wake()
    await setImmediate()
  }
  async function respond(response, userId = sent.at(-1).receipt.messageId) {
    const binding = store.bindingByContext(MINECRAFT_SUPPLY_CONTEXT)
    service.observe(binding, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id: userId, source: { kind: 'user' } }, seq: 2 })
    service.observe(binding, {
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(response) }] } }, seq: 3,
    })
    assert.equal(calls.length, 0)
    service.observe(binding, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 4 })
    await setImmediate()
  }
  const notices = () => store.notices.list(deviceId, {}).items.map(({ kind, taskId }) => ({ kind, taskId }))
  return { store, zone, service, minecraft, sent, calls, due, respond, completeAction, notices }
}

test('a single permit runs only the verified recipe after the matched completed decision', async t => {
  const h = fixture(t)
  assert.throws(() => h.service.enqueueMinecraftSupply('absent'), /build-zone-not-found/u)
  const job = h.service.enqueueMinecraftSupply(h.zone.id)
  h.store.autonomy.update(job.id, { payload: { zoneId: job.payload.zoneId, expiresAt: job.payload.expiresAt } })
  assert.ok(job.payload.expiresAt - job.runAfter === 15 * 60_000 - 15_000)
  assert.throws(() => h.service.enqueueMinecraftSupply(h.zone.id), /minecraft-supply-busy/u)
  await h.due(job)
  assert.match(h.sent[0].prompt, /oak_planks/u)
  assert.doesNotMatch(h.sent[0].prompt, /隐私营地|417|915/u)
  await h.respond({ decision: 'craft' })
  const completed = h.store.autonomy.get(job.id)
  assert.equal(completed.task.status, 'succeeded')
  assert.equal(h.store.taskById(completed.payload.receiptTaskId).status, 'succeeded')
  assert.deepEqual(h.notices(), [{ kind: 'camp-completed', taskId: job.id }])
  assert.deepEqual(h.calls, [{ zoneId: h.zone.id, recipe: 'oak_planks' }])
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
    .some(memory => memory.sourceRefs.some(ref => ref.taskId === completed.payload.receiptTaskId)))
  h.service.wake()
  await setImmediate()
  assert.equal(h.calls.length, 1)
})

test('one camp authorization uses the chosen material and records the verified build receipt', async t => {
  const h = fixture(t)
  const job = h.service.enqueueMinecraftSupply(h.zone.id, 'camp')
  assert.equal(job.payload.goal, 'camp')
  assert.equal(job.payload.campZoneId, h.zone.id)
  const legacyPermit = z.object({ zoneId: z.uuid(), expiresAt: z.int().positive() })
  assert.equal(legacyPermit.safeParse(job.payload).success, false)
  assert.throws(() => h.service.enqueueMinecraftSupply(h.zone.id), /minecraft-supply-busy/u)
  await h.due(job)
  assert.match(h.sent[0].prompt, /cherry_planks/u)
  assert.match(h.sent[0].prompt, /3×3/u)
  assert.doesNotMatch(h.sent[0].prompt, /隐私营地|417|915/u)
  await h.respond({ decision: 'build' })
  const completed = h.store.autonomy.get(job.id)
  assert.equal(completed.task.status, 'succeeded')
  assert.equal(legacyPermit.safeParse(completed.payload).success, false)
  assert.equal(h.store.taskById(completed.payload.receiptTaskId).capabilityId, 'minecraft.build')
  assert.deepEqual(h.calls, [{ zoneId: h.zone.id, material: 'cherry_planks' }])
  const shared = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
  assert.ok(shared.some(memory => memory.content.includes('3×3 营地') && memory.sourceRefs.some(ref => ref.taskId === completed.payload.receiptTaskId)))
})

test('camp authorization waits for materials and rejects a mismatched decision or partial build', async t => {
  for (const cause of ['materials', 'wrong action', 'partial receipt']) {
    await t.test(cause, async t => {
      const h = fixture(t)
      const build = h.minecraft.buildAutonomousCamp
      if (cause === 'materials') h.minecraft.inspectCampBuild = async () => undefined
      if (cause === 'partial receipt') {
        h.minecraft.buildAutonomousCamp = async (...input) => {
          const receipt = await build(...input)
          return { ...receipt, result: { ...receipt.result, placedFloor: 7 } }
        }
      }
      const job = h.service.enqueueMinecraftSupply(h.zone.id, 'camp')
      await h.due(job)
      if (cause === 'materials') {
        assert.equal(h.sent.length, 0)
        assert.equal(h.store.autonomy.get(job.id).task.status, 'accepted')
      } else {
        await h.respond({ decision: cause === 'wrong action' ? 'craft' : 'build' })
        assert.equal(h.store.autonomy.get(job.id).task.status, 'failed')
      }
      assert.equal(h.calls.length, cause === 'partial receipt' ? 1 : 0)
      assert.deepEqual(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }), [])
    })
  }
})

test('one preparation permit persists each step and links all receipts to the shared memory', async t => {
  const h = fixture(t)
  const job = h.service.enqueueMinecraftSupply(h.zone.id, 'prepare')
  assert.equal(job.payload.prepareZoneId, h.zone.id)
  assert.equal(job.payload.zoneId, undefined)
  assert.equal(job.payload.campZoneId, undefined)
  assert.throws(() => h.service.enqueueMinecraftSupply(h.zone.id, 'camp'), /minecraft-supply-busy/u)
  await h.due(job)
  assert.match(h.sent[0].prompt, /cherry_planks.*2 批/u)
  assert.doesNotMatch(h.sent[0].prompt, /隐私营地|417|915/u)
  await h.respond({ decision: 'prepare' })
  const { task, payload } = h.store.autonomy.get(job.id)
  assert.equal(task.status, 'succeeded')
  assert.deepEqual(payload.steps.map(step => step.action), ['craft', 'craft', 'build'])
  assert.equal(payload.steps.at(-1).taskId, payload.receiptTaskId)
  assert.equal(payload.zoneId, undefined)
  assert.deepEqual(h.calls.map(call => call.recipe ?? call.material), Array(3).fill('cherry_planks'))
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
    .some(memory => payload.steps.every(step => memory.sourceRefs.some(ref => ref.taskId === step.taskId))))
})

test('revocation between steps retains only the verified craft receipt and stops the sequence', async t => {
  const h = fixture(t)
  h.minecraft.prepareAutonomousCamp = async (zoneId, _offer, { checkPermit, onStep }) => {
    checkPermit()
    const task = h.completeAction('craft')
    onStep({ action: 'craft', taskId: task.id })
    assert.equal(h.store.autonomy.pending('minecraft.supply', MINECRAFT_SUPPLY_CONTEXT).payload.steps[0].taskId, task.id)
    assert.equal(h.service.cancelMinecraftSupply(zoneId), true)
    checkPermit()
    assert.fail('Revocation must prevent the next action')
  }
  const job = h.service.enqueueMinecraftSupply(h.zone.id, 'prepare')
  await h.due(job)
  await h.respond({ decision: 'prepare' })
  const { task, payload } = h.store.autonomy.get(job.id)
  assert.equal(task.status, 'cancelled')
  assert.equal(payload.receiptTaskId, undefined)
  assert.deepEqual(payload.steps.map(step => step.action), ['craft'])
  assert.equal(h.store.taskById(payload.steps[0].taskId).status, 'succeeded')
  const [memory] = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
  assert.match(memory.content, /没有取得完整完工回执/u)
})

test('unsafe conditions defer the model; expiry and revocation consume the authorization', async t => {
  for (const cause of ['expires', 'zone', 'stop']) {
    await t.test(cause, async t => {
      const h = fixture(t)
      h.minecraft.inspectSupply = async () => undefined
      const job = h.service.enqueueMinecraftSupply(h.zone.id)
      await h.due(job)
      assert.equal(h.store.autonomy.get(job.id).task.status, 'accepted')
      assert.equal(h.sent.length, 0)
      if (cause === 'stop') {
        assert.equal(h.service.cancelMinecraftSupply(h.zone.id), true)
        assert.equal(h.service.cancelMinecraftSupply(h.zone.id), false)
      } else {
        if (cause === 'expires') h.store.autonomy.update(job.id, { payload: { ...job.payload, expiresAt: Date.now() - 1 } })
        else h.store.revokeBuildZone(h.zone.id)
        await h.due(job)
      }
      assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
      assert.equal(h.sent.length, 0)
    })
  }
})

test('skip, another input, or a model-selected extra recipe cannot craft', async t => {
  for (const cause of ['skip', 'unrelated', 'extra recipe']) {
    await t.test(cause, async t => {
      const h = fixture(t)
      const job = h.service.enqueueMinecraftSupply(h.zone.id)
      await h.due(job)
      const response = cause === 'skip' ? { decision: 'skip' } : cause === 'extra recipe' ? { decision: 'craft', recipe: 'shield' } : { decision: 'craft' }
      await h.respond(response, cause === 'unrelated' ? 'wrong-input' : undefined)
      assert.equal(h.calls.length, 0)
      assert.equal(h.store.autonomy.get(job.id).task.status, cause === 'extra recipe' ? 'failed' : 'cancelled')
    })
  }
})

test('cancelling a dispatched craft signals the executor and keeps the permit closed until it settles', async t => {
  const h = fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.minecraft.supply = async (_zone, _recipe, signal) => {
    entered.resolve(signal)
    await release.promise
    signal.throwIfAborted()
  }
  const job = h.service.enqueueMinecraftSupply(h.zone.id)
  await h.due(job)
  await h.respond({ decision: 'craft' })
  const signal = await entered.promise
  assert.equal(h.service.cancelMinecraftSupply(), true)
  assert.ok(signal.aborted)
  assert.throws(() => h.service.enqueueMinecraftSupply(h.zone.id), /minecraft-supply-busy/u)
  release.resolve()
  await setImmediate()
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
})

test('a verified one-time survey links both receipts and is recalled in a different phone session', async t => {
  const h = fixture(t, 5)
  h.service.updateSettings({ feedEnabled: true, minecraftShareEnabled: true })
  const smallZone = h.store.createBuildZone({ ...h.zone, name: 'too small', radius: 4 })
  assert.throws(() => h.service.enqueueMinecraftSupply(smallZone.id, 'survey'), /minecraft-survey-zone-too-small/u)
  const job = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
  assert.equal(job.payload.surveyZoneId, h.zone.id)
  assert.equal(job.maxAttempts, 1)
  assert.equal(z.object({ zoneId: z.uuid(), expiresAt: z.int().positive() }).safeParse(job.payload).success, false)
  assert.throws(() => h.service.enqueueMinecraftSupply(h.zone.id, 'camp'), /minecraft-supply-busy/u)
  await h.due(job)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].prompt, /north（向北 4 格）、east（向东 4 格）/u)
  assert.doesNotMatch(h.sent[0].prompt, /south|west|隐私营地|417|915/u)
  const decisionBinding = h.store.bindingByContext(MINECRAFT_SUPPLY_CONTEXT)
  assert.deepEqual(companionToolPolicy(decisionBinding.contextId, decisionBinding.kind).allowed, [])
  await h.respond({ decision: 'survey', direction: 'east' })
  const complete = h.store.autonomy.get(job.id)
  assert.equal(complete.task.status, 'succeeded')
  assert.equal(complete.payload.direction, 'east')
  assert.deepEqual(h.calls, [{ zoneId: h.zone.id, direction: 'east' }])
  const child = h.store.taskById(complete.payload.receiptTaskId)
  assert.equal(child.capabilityId, 'minecraft.survey')
  assert.equal(child.status, 'succeeded')
  const share = h.store.autonomy.pending('minecraft.share', MINECRAFT_SHARE_CONTEXT)
  assert.deepEqual(share.payload, {
    kind: 'survey', taskId: child.id, surveyParentTaskId: complete.id,
    summary: '从营地向东步行 4 格探索，然后沿原路安全返回。',
  })
  assert.equal(h.store.feed.bySourceTask(child.id), undefined)
  const [memory] = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
  assert.match(memory.content, /Coopcraft.*向东步行 4 格探索.*回到营地/u)
  assert.ok(!memory.content.includes(h.zone.id))
  assert.deepEqual(memory.sourceRefs.map(ref => ref.taskId), [child.id, job.id])
  assert.equal(memory.sourceRefs[1].eventSeq, 4)
  const phone = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'survey-phone', kind: 'chat', label: '手机' })
  assert.notEqual(phone.sessionId, decisionBinding.sessionId)
  let recall
  registerMemoryRecall({ on(name, handler) { assert.equal(name, 'agent/pre-step'); recall = handler } }, h.store)
  const message = { id: 'survey-recall-input', role: 'user', source: { kind: 'companion-mobile' }, content: [{ type: 'text', text: '你还记得在 Coopcraft 的那次营地探索和回程吗？' }] }
  const response = await recall({ agent: { id: phone.sessionId }, messages: [message], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [message] }))
  const recalled = response.messages.slice(1).map(item => item.content[0].text).join('\n')
  assert.ok(recalled.includes(memory.id))
  assert.match(recalled, /向东步行 4 格探索.*回到营地/u)
  assert.ok(!recalled.includes(h.zone.id))
  h.service.wake()
  await setImmediate()
  assert.equal(h.calls.length, 1)
})

test('survey requires a fresh offered direction, matched decision and complete durable return', async t => {
  for (const cause of ['no route', 'skip', 'outside offer', 'coordinates', 'wrong input', 'wrong zone', 'wrong direction', 'no return', 'wrong child']) {
    await t.test(cause, async t => {
      const h = fixture(t, 5)
      if (cause === 'no route') h.minecraft.inspectCampSurvey = async () => ({ directions: [] })
      const execute = h.minecraft.surveyCamp
      h.minecraft.surveyCamp = async (...input) => {
        const receipt = await execute(...input)
        if (cause === 'wrong zone') receipt.result.zoneId = '11111111-1111-4111-8111-111111111111'
        if (cause === 'wrong direction') receipt.result.direction = 'east'
        if (cause === 'no return') receipt.result.returned = false
        if (cause === 'wrong child') receipt.task = h.completeAction('move')
        return receipt
      }
      const job = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
      await h.due(job)
      if (cause === 'no route') assert.equal(h.sent.length, 0)
      else await h.respond(cause === 'skip' ? { decision: 'skip' } : {
        decision: 'survey', direction: cause === 'outside offer' ? 'west' : 'north', ...(cause === 'coordinates' && { x: 0 }),
      }, cause === 'wrong input' ? 'other-turn' : undefined)
      const saved = h.store.autonomy.get(job.id)
      const dispatched = ['wrong zone', 'wrong direction', 'no return', 'wrong child'].includes(cause)
      assert.equal(saved.task.status, cause === 'no route' ? 'accepted' : ['skip', 'wrong input'].includes(cause) ? 'cancelled' : 'failed')
      assert.equal(saved.payload.receiptTaskId, undefined)
      assert.equal(h.calls.length, dispatched ? 1 : 0)
      assert.deepEqual(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }), [])
    })
  }
})

test('the offered longer route and recovered return stay distinct in autonomous history and shared recall', async t => {
  for (const returned of ['completed', 'recovered', 'wrong-distance']) {
    await t.test(returned, async t => {
      const h = fixture(t, 8)
      h.minecraft.inspectCampSurvey = async () => ({
        directions: ['north', 'east'],
        routes: [{ direction: 'north', steps: 5 }, { direction: 'east', steps: 7 }],
      })
      h.minecraft.surveyCamp = async (zoneId, direction, signal, steps) => {
        signal.throwIfAborted()
        h.calls.push({ zoneId, direction, steps })
        return {
          task: h.completeAction('survey'),
          result: {
            surveyed: returned !== 'recovered', zoneId, direction, steps: returned === 'wrong-distance' ? 5 : steps,
            reached: returned !== 'recovered', returned: true, ...(returned === 'recovered' && { reason: 'survey-terrain-changed' }),
          },
        }
      }
      const job = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
      await h.due(job)
      assert.match(h.sent[0].prompt, /north（向北 5 格）、east（向东 7 格）/u)
      assert.doesNotMatch(h.sent[0].prompt, /417|915|隐私营地/u)
      await h.respond({ decision: 'survey', direction: 'east' })
      assert.deepEqual(h.calls, [{ zoneId: h.zone.id, direction: 'east', steps: 7 }])
      const saved = h.store.autonomy.get(job.id)
      const records = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
      if (returned === 'wrong-distance') {
        assert.equal(saved.task.status, 'failed')
        assert.deepEqual(records, [])
        assert.deepEqual(h.notices(), [])
        return
      }
      assert.equal(saved.task.status, 'succeeded')
      assert.equal(saved.payload.surveyOutcome, returned)
      assert.equal(saved.payload.surveySteps, 7)
      assert.deepEqual(h.notices(), [{ kind: returned === 'recovered' ? 'camp-returned' : 'camp-completed', taskId: job.id }])
      assert.deepEqual(records[0].sourceRefs.map(ref => ref.taskId), [saved.payload.receiptTaskId, job.id])
      assert.doesNotMatch(records[0].content, /417|915|隐私营地/u)
      if (returned === 'recovered') {
        assert.match(records[0].content, /前路地形变化后提前折返.*确认她回到营地/u)
        assert.doesNotMatch(records[0].content, /7 格|外出和回程均/u)
      } else {
        assert.match(records[0].content, /向东步行 7 格探索.*回到营地/u)
      }
      const phone = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'route-38-phone', kind: 'chat', label: '手机' })
      let recall
      registerMemoryRecall({ on(_name, handler) { recall = handler } }, h.store)
      const message = { id: 'route-38-recall', role: 'user', source: { kind: 'companion-mobile' }, content: [{ type: 'text', text: '你还记得在 Coopcraft 的那次营地探索和回程吗？' }] }
      const response = await recall({ agent: { id: phone.sessionId }, messages: [message], turn: 2, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [message] }))
      assert.ok(response.messages.slice(1).some(item => item.content[0].text.includes(records[0].content)))
    })
  }
})

test('revocation or a changed quiet schedule aborts an in-flight survey and rejects its late receipt', async t => {
  for (const reason of ['zone revoked', 'quiet schedule changed']) {
    await t.test(reason, async t => {
      const h = fixture(t, 5)
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const execute = h.minecraft.surveyCamp
      h.minecraft.surveyCamp = async (zoneId, direction, signal) => {
        entered.resolve(signal)
        await release.promise
        return execute(zoneId, direction, new AbortController().signal)
      }
      const job = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
      await h.due(job)
      await h.respond({ decision: 'survey', direction: 'north' })
      const signal = await entered.promise
      try {
        if (reason === 'zone revoked') {
          h.store.revokeBuildZone(h.zone.id)
          assert.equal(h.service.cancelMinecraftSupply(h.zone.id), true)
        } else h.service.updateSettings({ quietStart: '12:00', quietEnd: '13:00' })
        assert.ok(signal.aborted)
      } finally { release.resolve() }
      await setImmediate()
      const saved = h.store.autonomy.get(job.id)
      assert.equal(saved.task.status, 'cancelled')
      assert.equal(saved.payload.receiptTaskId, undefined)
      assert.deepEqual(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }), [])
    })
  }
})

test('two-leg survey has a finite offer, verified checkpoints, and cross-scene memory', async t => {
  for (const scenario of ['complete', 'early corner', 'early first leg', 'unoffered', 'mixed shape', 'wrong receipt']) {
    await t.test(scenario, async t => {
      const h = fixture(t, 5)
      h.minecraft.inspectCampSurvey = async () => ({
        directions: ['east'],
        routes: [{ direction: 'east', steps: 4 }],
        trails: ['east-south'],
      })
      h.minecraft.surveyTrail = async (zoneId, trail, signal) => {
        signal.throwIfAborted()
        h.calls.push({ zoneId, trail })
        const recovered = scenario.startsWith('early')
        return {
          task: h.completeAction('survey'),
          result: {
            zoneId, trail: scenario === 'wrong receipt' ? 'east-north' : trail, returned: true,
            outcome: recovered ? 'recovered' : 'completed',
            checkpoints: scenario === 'early first leg' ? 0 : recovered ? 1 : 2,
            ...(recovered && { reason: 'survey-terrain-changed' }),
          },
        }
      }
      const permit = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
      await h.due(permit)
      assert.match(h.sent[0].prompt, /east-south（先向东、再向南）.*每段 4 格/u)
      assert.doesNotMatch(h.sent[0].prompt, /east-north|417|915|隐私营地/u)
      await h.respond({ decision: 'trail', trail: scenario === 'unoffered' ? 'east-north' : 'east-south', ...(scenario === 'mixed shape' && { direction: 'east' }) })
      const job = h.store.autonomy.get(permit.id)
      const memories = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
      if (['unoffered', 'mixed shape', 'wrong receipt'].includes(scenario)) {
        assert.equal(job.task.status, 'failed')
        assert.equal(h.calls.length, scenario === 'wrong receipt' ? 1 : 0)
        assert.deepEqual(memories, [])
        return
      }
      assert.deepEqual(h.calls, [{ zoneId: h.zone.id, trail: 'east-south' }])
      assert.equal(job.task.status, 'succeeded')
      const { surveyTrail, surveyCheckpoints, surveyOutcome, receiptTaskId } = job.payload
      assert.equal(surveyTrail, 'east-south')
      assert.equal(surveyCheckpoints, scenario === 'early first leg' ? 0 : scenario === 'early corner' ? 1 : 2)
      assert.equal(surveyOutcome, scenario === 'complete' ? 'completed' : 'recovered')
      const [memory] = memories
      assert.deepEqual(memory.sourceRefs.map(ref => ref.taskId), [receiptTaskId, permit.id])
      assert.doesNotMatch(memory.content, /417|915|隐私营地/u)
      if (scenario === 'complete') {
        assert.match(memory.content, /先向东、再向南.*两个检查点停稳.*回到营地/u)
      } else {
        assert.match(memory.content, new RegExp(`提前折返.*${surveyCheckpoints} 个检查点.*回到营地`, 'u'))
        assert.doesNotMatch(memory.content, /每段步行|终点.*停稳/u)
      }
      const phone = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'route-39-phone', kind: 'chat', label: '手机' })
      let recall
      registerMemoryRecall({ on(_name, handler) { recall = handler } }, h.store)
      const message = { id: 'route-39-recall', role: 'user', source: { kind: 'companion-mobile' }, content: [{ type: 'text', text: '你还记得在 Coopcraft 营地探索的转弯检查点和回程吗？' }] }
      const response = await recall({ agent: { id: phone.sessionId }, messages: [message], turn: 2, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [message] }))
      assert.ok(response.messages.slice(1).some(item => item.content[0].text.includes(memory.content)))
    })
  }
})
