import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate, setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { HOUSE_AGENT_RECOVERY_EVENT, HOUSE_AGENT_RECOVERY_PREFIX, HOUSE_RECOVERY_TTL_MS } from '../src/core/minecraft-recovery.ts'
import { MINECRAFT_RECOVERY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'

const plan = '我想先把目前能确认的证据记下来，之后再决定如何继续。'
const materials = [{ material: 'oak_planks', needed: 4, carried: 1, missing: 3 }]

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-recovery-scheduler-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const state = {
    source: { taskId: randomUUID(), at: new Date(Date.now() - 1000).toISOString(), reason: 'homebuild-materials', verification: 'blocked' },
    foreground: false, paused: false,
    probe: async () => ({ state: 'blocked', checked: 4, reason: 'homebuild-materials', materials }),
  }
  const sent = [], created = [], cancelled = [], reads = [], placementTools = [], verificationTools = [], placed = [], verified = []
  const sessions = {
    async create(input, fresh, assertAuthorized, recoveryPlacement, recoveryCompletion) {
      assert.equal(typeof assertAuthorized, 'function')
      assertAuthorized()
      created.push({ input, fresh })
      placementTools.push(recoveryPlacement)
      verificationTools.push(recoveryCompletion)
      return { binding: store.bindContext({ ...input, sessionId: randomUUID() }) }
    },
    async send(contextId, prompt, origin, voice, attachment, assertAuthorized) {
      assert.equal(typeof assertAuthorized, 'function')
      assertAuthorized()
      const receipt = { accepted: true, contextId, sessionId: store.bindingByContext(contextId).sessionId, messageId: randomUUID() }
      sent.push({ prompt, receipt, origin, voice, attachment })
      return receipt
    },
    async cancel(contextId) { cancelled.push(contextId) },
  }
  const minecraft = {
    campPaused: () => state.paused,
    recoverySources: () => state.source ? [state.source, state.source] : [],
    recoverySource: taskId => state.source?.taskId === taskId ? state.source : undefined,
    recoveryPlacementAvailable: async () => state.placementAvailable === true,
    recoveryCandidates: async () => state.candidates?.() ?? ({ checked: 3, blocked: 0, candidates: [{ index: 1, x: 1, y: 0, z: 0, material: 'glass' }] }),
    async placeRecoveryCell(taskId, index, signal, mode) {
      placed.push({ taskId, index, signal, mode })
      return state.place(index, signal)
    },
    async verifyRecoveryCompletion(taskId, signal, assertAuthorized) {
      verified.push(taskId)
      assertAuthorized()
      return state.verify(signal, assertAuthorized)
    },
    recoveryCompletionValid: (taskId, result) => state.completionProof?.taskId === taskId && state.completionProof.result === result.verification.checked,
    async resurveyRecovery(taskId, signal) {
      reads.push({ taskId, signal })
      return state.probe(signal)
    },
  }
  const service = new AutonomyService(store, sessions, undefined, minecraft, undefined, undefined, undefined,
    ignoreRecoveryPlacement => state.foreground || state.ownPlacementActivity && !ignoreRecoveryPlacement)
  const taskId = state.source.taskId
  const signal = new AbortController().signal
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true }) })
  const enable = options => service.updateSettings({ minecraftRecoveryEnabled: true, quietStart: '00:00', quietEnd: '00:00',
    memoryReview: false, ...options })
  async function tick() {
    await service.tick()
    await setImmediate()
  }
  const binding = () => store.bindingByContext(MINECRAFT_RECOVERY_CONTEXT)
  function startTurn(messageId = sent.at(-1).receipt.messageId, turn = 1) {
    service.observe(binding(), { type: 'turn/start', data: { turn }, seq: 1 })
    service.observe(binding(), { type: 'user/message', surfaceOp: 'append', data: { id: messageId, source: { kind: 'user' } }, seq: 2 })
  }
  async function endTurn(reason = 'completed', turn = 1) {
    service.observe(binding(), { type: 'turn/end', data: { turn, reason: { kind: reason } }, seq: 4 })
    await setImmediate()
  }
  function job() {
    const row = store.taskByExternalId(`autonomy:minecraft.recovery:${taskId}`)
    return row && store.autonomy.get(row.id)
  }
  const activity = () => store.activityByEventId(HOUSE_AGENT_RECOVERY_PREFIX + taskId)
  return { store, service, state, minecraft, sessions, sent, created, cancelled, reads, placementTools, verificationTools, placed, verified, taskId, signal, enable, tick, binding, startTurn, endTurn, job, activity }
}

test('construction recovery defaults off and accepts one source in a new private session after opt-in', async t => {
  const f = fixture(t)
  await f.tick()
  assert.equal(f.job(), undefined)
  assert.equal(f.sent.length, 0)
  f.store.bindContext({ contextId: MINECRAFT_RECOVERY_CONTEXT, sessionId: 'previous-private-session', kind: 'system', label: '旧复查' })
  f.enable()
  await f.tick()
  assert.equal(f.created.length, 1)
  assert.deepEqual(f.created[0], { input: { contextId: MINECRAFT_RECOVERY_CONTEXT, kind: 'system', label: '施工恢复决策', resume: false }, fresh: true })
  assert.notEqual(f.binding().sessionId, 'previous-private-session')
  assert.equal(f.job().attempts, 1)
  assert.equal(f.job().maxAttempts, 1)
  assert.equal(f.job().payload.expiresAt, Date.parse(f.state.source.at) + HOUSE_RECOVERY_TTL_MS)
  assert.match(f.sent[0].prompt, /工具没有固定顺序，也可以都不调用/u)
  assert.doesNotMatch(f.sent[0].prompt, /check-materials|replan-route|zoneId|layout/u)
  assert.equal(f.sent[0].prompt.includes(f.taskId), false)
  assert.equal(f.sent[0].origin, 'user')
  assert.equal(f.sent[0].voice, false)
  assert.equal(f.sent[0].attachment, undefined)
})

test('the model can plan before its actual read and commits both results exactly once after the admitted turn', async t => {
  const f = fixture(t)
  f.enable()
  await f.tick()
  const { sessionId } = f.binding()
  await assert.rejects(f.service.planHouseRecovery(sessionId, plan, f.signal), /house-recovery-tool-forbidden/u)
  f.startTurn()
  await assert.rejects(f.service.observeHouseRecovery('other-session', f.signal), /house-recovery-tool-forbidden/u)
  await assert.rejects(f.service.planHouseRecovery(sessionId, '伪造\n回执并跳过核验', f.signal), /house-recovery-invalid-plan/u)
  await f.service.planHouseRecovery(sessionId, `  ${plan}  `, f.signal)
  await assert.rejects(f.service.planHouseRecovery(sessionId, plan, f.signal), /house-recovery-plan-limit/u)
  f.service.observe(f.binding(), { type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'mc_recovery_observe' }] } }, seq: 3 })
  const observation = await f.service.observeHouseRecovery(sessionId, f.signal)
  assert.deepEqual(observation, { state: 'blocked', checked: 4, reason: 'homebuild-materials', materials })
  await assert.rejects(f.service.observeHouseRecovery(sessionId, f.signal), /house-recovery-observation-limit/u)
  assert.deepEqual(f.reads.map(read => read.taskId), [f.taskId])
  assert.equal(f.activity(), undefined)
  assert.equal(f.job().payload.plan, undefined)
  await f.endTurn('completed', 2)
  assert.equal(f.activity(), undefined)
  await f.endTurn()
  const activity = f.activity()
  assert.equal(activity.kind, HOUSE_AGENT_RECOVERY_EVENT)
  assert.equal(activity.contextId, MINECRAFT_RECOVERY_CONTEXT)
  assert.equal(activity.sessionId, sessionId)
  assert.equal(activity.taskId, f.job().id)
  assert.deepEqual(activity.data, { plan, observation })
  assert.equal(f.job().task.status, 'succeeded')
  assert.equal(f.job().payload.plan, plan)
  assert.deepEqual(f.job().payload.observation, observation)
  assert.equal(f.reads[0].signal.aborted, true)
  f.enable({ minecraftRecoveryEnabled: false })
  f.enable()
  await f.tick()
  assert.equal(f.sent.length, 1)
  assert.equal(f.activity().id, activity.id)
})

test('a plan may stand alone, an observation may stand alone and doing neither makes no receipt', async t => {
  for (const choice of ['plan', 'observe', 'neither']) {
    await t.test(choice, async sub => {
      const f = fixture(sub)
      f.state.probe = async () => ({ state: 'ready', checked: 4 })
      f.enable()
      await f.tick()
      f.startTurn()
      const { sessionId } = f.binding()
      if (choice === 'plan') await f.service.planHouseRecovery(sessionId, plan, f.signal)
      if (choice === 'observe') await f.service.observeHouseRecovery(sessionId, f.signal)
      await f.endTurn()
      assert.equal(f.reads.length, choice === 'observe' ? 1 : 0)
      if (choice === 'neither') {
        assert.equal(f.activity(), undefined)
        assert.equal(f.job().task.status, 'cancelled')
      } else {
        assert.deepEqual(f.activity().data, choice === 'plan' ? { plan } : { observation: { state: 'ready', checked: 4 } })
      }
    })
  }
})

test('false inbox message, a second message and an incomplete turn cannot create a plan receipt', async t => {
  for (const change of ['false-inbox', 'extra-inbox', 'cancelled', 'source-revoked', 'rebound']) {
    await t.test(change, async sub => {
      const f = fixture(sub)
      f.enable()
      await f.tick()
      f.startTurn(change === 'false-inbox' ? 'foreign-inbox-message' : undefined)
      const { sessionId } = f.binding()
      if (change === 'false-inbox') {
        await assert.rejects(f.service.planHouseRecovery(sessionId, plan, f.signal), /house-recovery-authority-changed/u)
      } else {
        await f.service.planHouseRecovery(sessionId, plan, f.signal)
        if (change === 'extra-inbox') f.service.observe(f.binding(), {
          type: 'user/message', surfaceOp: 'append', data: { id: 'other-message', source: { kind: 'user' } }, seq: 3,
        })
        if (change === 'source-revoked') f.state.source = undefined
        if (change === 'rebound') {
          const old = f.binding()
          f.store.bindContext({ ...old, sessionId: 'new-binding' })
          f.service.observe(old, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 4 })
        }
      }
      await f.endTurn(change === 'cancelled' ? 'cancelled' : 'completed')
      assert.equal(f.activity(), undefined)
      assert.equal(f.job().payload.plan, undefined)
      assert.equal(f.job().task.status, 'cancelled')
    })
  }
})

test('foreground arrival aborts a running read and consumes the one recovery attempt', async t => {
  const f = fixture(t)
  f.state.probe = signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ state: 'ready', checked: 4 }), { once: true }))
  f.enable()
  await f.tick()
  f.startTurn()
  const pendingRead = f.service.observeHouseRecovery(f.binding().sessionId, f.signal)
  const cancelledRead = assert.rejects(pendingRead, { name: 'AbortError' })
  await setImmediate()
  assert.equal(f.reads.length, 1)
  const foreground = f.store.bindContext({ contextId: 'chat.mobile', kind: 'chat', label: '前台', sessionId: 'owner-chat' })
  f.service.observe(foreground, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
  await cancelledRead
  assert.equal(f.job().task.status, 'cancelled')
  assert.deepEqual(f.cancelled, [MINECRAFT_RECOVERY_CONTEXT])
  assert.equal(f.activity(), undefined)
})

test('queued source waits for foreground idle; expired and currently paused sources never start', async t => {
  const f = fixture(t)
  f.state.source.at = new Date(Date.now() - HOUSE_RECOVERY_TTL_MS - 1000).toISOString()
  f.enable()
  await f.tick()
  assert.equal(f.job(), undefined)
  f.enable({ minecraftRecoveryEnabled: false })
  f.state.source.at = new Date(Date.now() - 1000).toISOString()
  f.state.paused = true
  f.enable()
  await f.tick()
  assert.equal(f.job(), undefined)
  f.state.paused = false
  f.state.foreground = true
  await f.tick()
  assert.equal(f.job().task.status, 'accepted')
  assert.equal(f.job().attempts, 0)
  assert.equal(f.sent.length, 0)
  f.state.foreground = false
  f.store.autonomy.update(f.job().id, { runAfter: Date.now() - 1 })
  await f.tick()
  assert.equal(f.sent.length, 1)
})

test('malformed probe data is presented as unavailable without accepting invented observations', async t => {
  const f = fixture(t)
  f.state.probe = async () => ({ state: 'ready', checked: -10, reason: 'invented', materials: [] })
  f.enable()
  await f.tick()
  f.startTurn()
  assert.deepEqual(await f.service.observeHouseRecovery(f.binding().sessionId, f.signal), { state: 'unavailable' })
  await f.endTurn()
  assert.deepEqual(f.activity().data, { observation: { state: 'unavailable' } })
})

test('a stalled session setup does not freeze the queue or submit a turn after its lease', async t => {
  const f = fixture(t)
  let resumeSetup
  const create = f.sessions.create
  f.sessions.create = async (...args) => {
    await new Promise(resolve => { resumeSetup = resolve })
    return create(...args)
  }
  f.enable()
  await f.tick()
  assert.equal(f.job().task.status, 'running')
  f.store.autonomy.update(f.job().id, { leaseUntil: Date.now() - 1 })
  await f.tick()
  assert.equal(f.job().task.status, 'cancelled')
  assert.equal(f.job().attempts, 1)
  resumeSetup()
  await setImmediate()
  assert.equal(f.sent.length, 0)
  assert.equal(f.binding(), undefined)
  assert.equal(f.activity(), undefined)
})

test('startup clears the old running attempt without calling a new model or writing a receipt', async t => {
  const f = fixture(t)
  f.enable()
  const task = f.store.autonomy.create({
    kind: 'minecraft.recovery', contextId: MINECRAFT_RECOVERY_CONTEXT, dedupeKey: f.taskId, maxAttempts: 1, runAfter: Date.now(),
    payload: { source: f.state.source, expiresAt: Date.parse(f.state.source.at) + HOUSE_RECOVERY_TTL_MS },
  })
  f.store.transitionTask(task.id, 'running')
  f.store.autonomy.update(task.id, { attempts: 1, leaseUntil: Date.now() + 60_000 })
  f.service.start()
  await setImmediate()
  assert.equal(f.job().task.status, 'failed')
  assert.equal(f.job().lastError, 'house-recovery-restarted')
  assert.equal(f.job().leaseUntil, undefined)
  assert.equal(f.sent.length, 0)
  assert.equal(f.activity(), undefined)
})

test('placement tools require both the explicit opt-in and worker support when the turn is admitted', async t => {
  for (const [optIn, available] of [[false, true], [true, false]]) await t.test(`${optIn}/${available}`, async subtest => {
    const f = fixture(subtest)
    f.state.placementAvailable = available
    f.enable({ minecraftRecoveryPlacementEnabled: optIn })
    await f.tick()
    f.startTurn()
    const id = f.binding().sessionId
    assert.deepEqual(f.placementTools, [false])
    assert.doesNotMatch(f.sent[0].prompt, /mc_recovery_place/u)
    assert.equal(f.service.recoveryPlacementToolsActive(id), false)
    await assert.rejects(f.service.placeHouseRecoveryCell(id, 1, f.signal), { code: 'house-recovery-placement-forbidden' })
    await assert.rejects(f.service.candidatesForHouseRecovery(id, f.signal), { code: 'house-recovery-placement-forbidden' })
    assert.equal(f.placed.length, 0)
  })
})

const blockedCell = index => ({ index, outcome: 'blocked', material: 'glass', consumed: 0, reason: 'homebuild-obstructed' })
const placedCell = index => ({ index, outcome: 'placed', material: 'glass', consumed: 1 })

async function placementTurn(t, options) {
  const f = fixture(t)
  f.state.placementAvailable = true
  f.enable({ minecraftRecoveryPlacementEnabled: true, ...options })
  await f.tick()
  f.startTurn()
  return { ...f, session: f.binding().sessionId }
}

test('the model may change targets after a no-op, but a verified placement spends the entire write allowance', async t => {
  const f = await placementTurn(t)
  f.state.place = async index => {
    if (index === 1) return blockedCell(index)
    f.state.ownPlacementActivity = true
    return placedCell(index)
  }
  assert.deepEqual(f.placementTools, [true])
  assert.equal(f.service.recoveryPlacementToolsActive(f.session), true)
  const offer = await f.service.candidatesForHouseRecovery(f.session, f.signal)
  assert.equal(offer.candidates[0].index, 1)
  await assert.rejects(f.service.candidatesForHouseRecovery(f.session, f.signal), { code: 'house-recovery-candidate-limit' })
  assert.deepEqual(await f.service.placeHouseRecoveryCell(f.session, 1, f.signal), blockedCell(1))
  await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 1, f.signal), { code: 'house-recovery-placement-limit' })
  assert.deepEqual(await f.service.placeHouseRecoveryCell(f.session, 2, f.signal), placedCell(2))
  await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 3, f.signal), { code: 'house-recovery-placement-closed' })
  await f.endTurn()
  assert.deepEqual(f.activity().data, { placed: { index: 2, material: 'glass' } })
  assert.deepEqual(f.placed.map(value => value.index), [1, 2])
})

test('the recovery turn ignores its own placement activity while still yielding to a real foreground turn', async t => {
  const f = await placementTurn(t)
  f.state.place = async index => {
    f.state.ownPlacementActivity = true
    return placedCell(index)
  }
  await f.service.placeHouseRecoveryCell(f.session, 1, f.signal)
  await f.service.planHouseRecovery(f.session, plan, f.signal)
  f.state.foreground = true
  await f.tick()
  assert.equal(f.job().task.status, 'cancelled')
  assert.equal(f.activity(), undefined)
})

test('only three distinct no-op results may be attempted, and uncertain results seal the write tools', async t => {
  await t.test('attempt count', async subtest => {
    const f = await placementTurn(subtest)
    f.state.place = async index => blockedCell(index)
    for (const index of [0, 1, 2]) assert.deepEqual(await f.service.placeHouseRecoveryCell(f.session, index, f.signal), blockedCell(index))
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 3, f.signal), { code: 'house-recovery-placement-limit' })
  })
  await t.test('mismatched worker receipt', async subtest => {
    const f = await placementTurn(subtest)
    f.state.place = async () => placedCell(9)
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 1, f.signal), { code: 'minecraft-house-cell-unconfirmed' })
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 2, f.signal), { code: 'house-recovery-placement-closed' })
    await f.endTurn()
    assert.equal(f.activity(), undefined)
  })
})

test('revoking placement aborts an in-flight tool and prevents parallel writes or stale results', async t => {
  const f = await placementTurn(t)
  const started = Promise.withResolvers()
  f.state.place = async (_index, signal) => {
    started.resolve()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const pending = assert.rejects(f.service.placeHouseRecoveryCell(f.session, 1, f.signal), { name: 'AbortError' })
  await started.promise
  await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 2, f.signal), { code: 'house-recovery-placement-closed' })
  f.enable({ minecraftRecoveryPlacementEnabled: false })
  await pending
  assert.equal(f.job().task.status, 'cancelled')
  assert.equal(f.activity(), undefined)
})

test('continuous recovery uses actual results to refresh stock, retry another material and spend three successes', async t => {
  const f = await placementTurn(t, { minecraftRecoveryContinuousEnabled: true })
  assert.match(f.sent[0].prompt, /最多尝试 6 个不同格，最多确认放置 3 块/u)
  assert.ok(f.job().leaseUntil > Date.now() + 230_000)
  let stock = 3
  f.state.candidates = () => ({ checked: 3, blocked: 0, candidates: [{ index: 1, x: 1, y: 0, z: 0, material: 'glass' }], stock: { glass: stock } })
  f.state.place = async index => {
    if (index === 1) return { ...blockedCell(index), material: 'oak_planks', reason: 'homebuild-materials' }
    stock--
    return placedCell(index)
  }
  const read = () => f.service.candidatesForHouseRecovery(f.session, f.signal)
  const place = index => f.service.placeHouseRecoveryCell(f.session, index, f.signal)
  assert.deepEqual((await read()).stock, { glass: 3 })
  assert.deepEqual(await place(1), { ...blockedCell(1), material: 'oak_planks', reason: 'homebuild-materials', remainingAttempts: 5, remainingPlacements: 3 })
  assert.deepEqual(await place(2), { ...placedCell(2), remainingAttempts: 4, remainingPlacements: 2 })
  assert.deepEqual((await read()).stock, { glass: 2 })
  await assert.rejects(read(), { code: 'house-recovery-candidate-limit' })
  assert.deepEqual(await place(3), { ...placedCell(3), remainingAttempts: 3, remainingPlacements: 1 })
  assert.deepEqual(await place(4), { ...placedCell(4), remainingAttempts: 2, remainingPlacements: 0 })
  await assert.rejects(place(5), { code: 'house-recovery-placement-closed' })
  assert.deepEqual(f.placed.map(value => value.mode), ['continuous', 'continuous', 'continuous', 'continuous'])
  await f.endTurn()
  assert.deepEqual(f.activity().data, { placements: [2, 3, 4].map(index => ({ index, material: 'glass' })) })
})

test('continuous recovery respects its own cap, exact scope and revocation', async t => {
  await t.test('six distinct attempts', async subtest => {
    const f = await placementTurn(subtest, { minecraftRecoveryContinuousEnabled: true })
    f.state.place = async index => blockedCell(index)
    for (let index = 0; index < 6; index++) {
      assert.deepEqual(await f.service.placeHouseRecoveryCell(f.session, index, f.signal), { ...blockedCell(index), remainingAttempts: 5 - index, remainingPlacements: 3 })
    }
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 6, f.signal), { code: 'house-recovery-placement-limit' })
  })
  await t.test('late opt-in does not extend a single turn', async subtest => {
    const f = await placementTurn(subtest)
    f.enable({ minecraftRecoveryContinuousEnabled: true })
    f.state.place = async index => placedCell(index)
    assert.deepEqual(await f.service.placeHouseRecoveryCell(f.session, 1, f.signal), placedCell(1))
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 2, f.signal), { code: 'house-recovery-placement-closed' })
    assert.equal(f.placed[0].mode, 'single')
  })
  await t.test('continuous opt-in by itself grants no write tool', async subtest => {
    const f = fixture(subtest)
    f.state.placementAvailable = true
    f.enable({ minecraftRecoveryContinuousEnabled: true, minecraftRecoveryPlacementEnabled: false })
    await f.tick()
    f.startTurn()
    assert.equal(f.service.recoveryPlacementToolsActive(f.binding().sessionId), false)
  })
  await t.test('revoking only continuous cancels the active lease', async subtest => {
    const f = await placementTurn(subtest, { minecraftRecoveryContinuousEnabled: true })
    f.state.place = async index => placedCell(index)
    await f.service.placeHouseRecoveryCell(f.session, 1, f.signal)
    f.enable({ minecraftRecoveryContinuousEnabled: false })
    assert.equal(f.store.autonomy.settings().minecraftRecoveryPlacementEnabled, true)
    assert.equal(f.job().task.status, 'cancelled')
    assert.equal(f.activity(), undefined)
    await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 2, f.signal), { code: 'house-recovery-tool-forbidden' })
  })
})

test('the live placement signal reaches the absolute recovery deadline without waiting for a scheduler tick', async t => {
  const f = await placementTurn(t, { minecraftRecoveryContinuousEnabled: true })
  const leaseUntil = Date.now() + 40
  f.store.autonomy.update(f.job().id, { leaseUntil })
  f.service.active.job.leaseUntil = leaseUntil
  f.state.place = async (_index, signal) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await Promise.race([
    assert.rejects(f.service.placeHouseRecoveryCell(f.session, 1, f.signal), { name: 'TimeoutError' }),
    setTimeout(120).then(() => assert.fail('the tool outlived its recovery lease')),
  ])
  assert.equal(f.placed[0].signal.aborted, true)
  assert.equal(f.job().task.status, 'running')
  await f.tick()
  assert.equal(f.job().task.status, 'cancelled')
})

const incompleteVerification = { outcome: 'incomplete', verification: { checked: 8, matched: 6, missing: 1, blocked: 1,
  issues: [{ index: 2, reason: 'missing' }, { index: 7, reason: 'blocked' }] } }
const completeVerification = { outcome: 'completed', placed: 2, verification: { checked: 8, matched: 8, missing: 0, blocked: 0, issues: [] } }

test('the model can verify, act on mismatches and finish with the same authenticated turn after the house becomes built', async t => {
  const f = await placementTurn(t, { minecraftRecoveryContinuousEnabled: true })
  f.state.place = async index => placedCell(index)
  f.state.verify = async () => incompleteVerification
  assert.deepEqual(f.verificationTools, [true])
  assert.match(f.sent[0].prompt, /mc_recovery_verify/u)
  const verify = () => f.service.verifyHouseRecovery(f.session, f.signal)
  await assert.rejects(verify(), { code: 'house-recovery-verification-unavailable' })
  assert.deepEqual(f.verified, [])
  await f.service.placeHouseRecoveryCell(f.session, 1, f.signal)
  assert.deepEqual(await verify(), incompleteVerification)
  await f.service.placeHouseRecoveryCell(f.session, 2, f.signal)
  f.state.verify = async () => {
    f.state.source = undefined
    f.state.completionProof = { taskId: f.taskId, result: 8 }
    return completeVerification
  }
  assert.deepEqual(await verify(), completeVerification)
  assert.deepEqual(await verify(), completeVerification)
  assert.deepEqual(f.verified, [f.taskId, f.taskId])
  await assert.rejects(f.service.placeHouseRecoveryCell(f.session, 3, f.signal), { code: 'house-recovery-already-completed' })
  await assert.rejects(f.service.candidatesForHouseRecovery(f.session, f.signal), { code: 'house-recovery-already-completed' })
  await f.service.planHouseRecovery(f.session, plan, f.signal)
  await f.endTurn()
  assert.equal(f.job().task.status, 'succeeded')
  assert.deepEqual(f.activity().data.verification, completeVerification)
  assert.equal(f.activity().data.plan, plan)
})

test('whole-house verification only opens for supported continuous turns and bounds incomplete scans', async t => {
  await t.test('single-cell authorization', async subtest => {
    const f = await placementTurn(subtest)
    assert.deepEqual(f.verificationTools, [false])
    await assert.rejects(f.service.verifyHouseRecovery(f.session, f.signal), { code: 'house-recovery-verification-forbidden' })
  })
  await t.test('two incomplete scans', async subtest => {
    const f = await placementTurn(subtest, { minecraftRecoveryContinuousEnabled: true })
    f.state.place = async index => placedCell(index)
    f.state.verify = async () => incompleteVerification
    await f.service.placeHouseRecoveryCell(f.session, 1, f.signal)
    assert.deepEqual(await f.service.verifyHouseRecovery(f.session, f.signal), incompleteVerification)
    assert.deepEqual(await f.service.verifyHouseRecovery(f.session, f.signal), incompleteVerification)
    await assert.rejects(f.service.verifyHouseRecovery(f.session, f.signal), { code: 'house-recovery-verification-unavailable' })
    await f.endTurn()
    assert.deepEqual(f.activity().data.verification, incompleteVerification)
  })
  await t.test('false complete count', async subtest => {
    const f = await placementTurn(subtest, { minecraftRecoveryContinuousEnabled: true })
    f.state.place = async index => placedCell(index)
    f.state.verify = async () => completeVerification
    await f.service.placeHouseRecoveryCell(f.session, 1, f.signal)
    await assert.rejects(f.service.verifyHouseRecovery(f.session, f.signal), { code: 'house-recovery-verification-unconfirmed' })
    await f.endTurn()
    assert.equal(f.activity().data.verification, undefined)
  })
})
