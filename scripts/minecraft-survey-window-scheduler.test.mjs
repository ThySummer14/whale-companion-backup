import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { surveyWindowKey } from '../src/core/minecraft-survey-window.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 11, 55) })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/survey-window-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const zone = store.createBuildZone({ name: 'Private camp', dimension: 'minecraft:overworld', x: 19, y: 64, z: 23, radius: 6 })
  const sent = []
  const calls = []
  const previews = []
  const sessions = {
    async create(input) { return { binding: store.bindContext({ ...input, sessionId: 'window-review' }) } },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, messageId: `permit-${sent.length + 1}`, sessionId: 'window-review' }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel() {},
  }
  const state = { ready: true }
  const minecraft = {
    async eventPrompt() { throw new Error('Unexpected game event') },
    finishEvent() { throw new Error('Unexpected game event') },
    surveyWindowReady() { return state.ready },
    async inspectCampSurvey(zoneId, signal) {
      signal.throwIfAborted()
      previews.push(zoneId)
      return { directions: ['north'] }
    },
    async surveyCamp(zoneId, direction, signal) {
      signal.throwIfAborted()
      calls.push({ zoneId, direction })
      const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: 'Verified survey' })
      store.transitionTask(task.id, 'running')
      const result = { zoneId, direction, steps: 4, reached: true, surveyed: true, returned: true }
      return { task: store.transitionTask(task.id, 'succeeded'), result }
    },
  }
  const service = new AutonomyService(store, sessions, undefined, minecraft)
  service.updateSettings({ quietStart: '00:00', quietEnd: '00:00' })
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = { zoneId: zone.id, start: '12:00', end: '12:45', days: 2 }
  const now = (hour, minute, date = 9) => t.mock.timers.setTime(new Date(2026, 10, date, hour, minute).getTime())
  async function poll() { service.wake(); await setImmediate() }
  async function respond(response) {
    const binding = store.bindingByContext(MINECRAFT_SUPPLY_CONTEXT)
    const { messageId } = sent.at(-1).receipt
    const turn = sent.length
    service.observe(binding, { type: 'turn/start', data: { turn }, seq: 1 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id: messageId, source: { kind: 'user' } }, seq: 2 })
    service.observe(binding, {
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, message: { content: [{ type: 'text', text: JSON.stringify(response) }] } }, seq: 3,
    })
    service.observe(binding, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, seq: 4 })
    await setImmediate()
  }
  const windowJob = (date = '2026-11-09') => {
    const task = store.taskByExternalId(`autonomy:minecraft.supply:${surveyWindowKey(date)}`)
    return task && store.autonomy.get(task.id)
  }
  return { store, zone, service, input, minecraft, state, sessions, sent, calls, previews, now, poll, respond, windowJob }
}

test('daily survey waits for authorization, open hours, global autonomy, quiet and a fresh ready worker', async t => {
  const h = fixture(t)
  await h.poll()
  assert.equal(h.service.surveyWindowView().rule, null)
  assert.equal(h.service.setSurveyWindow(h.input).today.status, 'waiting')
  assert.throws(() => h.service.setSurveyWindow(h.input), /minecraft-survey-window-exists/u)
  await h.poll()
  assert.deepEqual(h.previews, [])
  h.now(12, 0)
  h.service.updateSettings({ enabled: false })
  await h.poll()
  assert.equal(h.service.surveyWindowView().today.status, 'paused')
  h.service.updateSettings({ enabled: true, quietStart: '11:59', quietEnd: '12:10' })
  await h.poll()
  assert.equal(h.windowJob(), undefined)
  h.now(12, 10)
  h.state.ready = false
  await h.poll()
  assert.equal(h.windowJob(), undefined)
  assert.deepEqual(h.previews, [])
  h.state.ready = true
  await h.poll()
  assert.equal(h.windowJob().task.status, 'running')
  assert.equal(h.service.surveyWindowView().today.status, 'used')
  assert.deepEqual(h.previews, [h.zone.id])
  assert.deepEqual(h.calls, [])
})

test('one daily task supports one deferral, then preserves verified Minecraft and shared memory receipts', async t => {
  const h = fixture(t)
  h.service.setSurveyWindow(h.input)
  h.now(12, 0)
  await h.poll()
  const job = h.windowJob()
  assert.equal(job.attempts, 1)
  assert.equal(job.maxAttempts, 1)
  assert.equal(job.payload.windowSurveyZoneId, h.zone.id)
  assert.equal(job.payload.surveyZoneId, undefined)
  assert.match(h.sent.at(-1).prompt, /"decision":"later"/u)
  await h.respond({ decision: 'later' })
  const deferred = h.windowJob()
  assert.equal(deferred.task.status, 'accepted')
  assert.equal(deferred.runAfter, Date.now() + 300_000)
  assert.deepEqual(h.calls, [])
  h.now(12, 4)
  await h.poll()
  assert.equal(h.sent.length, 1)
  h.now(12, 5)
  await h.poll()
  assert.equal(h.sent.length, 2)
  assert.doesNotMatch(h.sent.at(-1).prompt, /"decision":"later"/u)
  assert.equal(h.previews.length, 2)
  await h.respond({ decision: 'survey', direction: 'north' })
  const completed = h.windowJob()
  assert.equal(completed.id, job.id)
  assert.equal(completed.task.status, 'succeeded')
  assert.equal(completed.payload.surveyOutcome, 'completed')
  assert.deepEqual(h.calls, [{ zoneId: h.zone.id, direction: 'north' }])
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
    .some(memory => memory.sourceRefs.some(ref => ref.taskId === completed.payload.receiptTaskId)))
  h.service.revokeSurveyWindow()
  h.service.setSurveyWindow(h.input)
  await h.poll()
  assert.equal(h.sent.length, 2)
  assert.equal(h.windowJob().id, job.id)
  h.now(12, 0, 10)
  await h.poll()
  assert.equal(h.windowJob('2026-11-10').task.status, 'running')
})

test('stopping today suppresses future evaluation until tomorrow and zone revocation clears matching rule', async t => {
  const h = fixture(t)
  h.service.setSurveyWindow(h.input)
  h.service.stopMinecraftSurveyWindowForToday()
  h.now(12, 0)
  await h.poll()
  assert.equal(h.service.surveyWindowView().today.status, 'suppressed')
  assert.equal(h.windowJob(), undefined)
  h.now(12, 0, 10)
  await h.poll()
  const next = h.windowJob('2026-11-10')
  assert.equal(next.task.status, 'running')
  h.service.stopMinecraftSurveyWindowForToday('different-zone')
  assert.equal(h.store.taskById(next.id).status, 'running')
  h.service.stopMinecraftSurveyWindowForToday(h.zone.id)
  assert.equal(h.service.surveyWindowView().rule, null)
  assert.equal(h.store.taskById(next.id).status, 'cancelled')
  assert.deepEqual(h.calls, [])
})

test('manual permits occupy the survey slot and cannot use scheduled deferral or be revoked with the rule', async t => {
  const h = fixture(t)
  h.service.setSurveyWindow(h.input)
  await setImmediate()
  const manual = h.service.enqueueMinecraftSupply(h.zone.id, 'survey')
  h.now(12, 0)
  await h.poll()
  assert.equal(h.windowJob(), undefined)
  assert.equal(h.store.taskById(manual.id).status, 'running')
  h.service.revokeSurveyWindow()
  assert.equal(h.store.taskById(manual.id).status, 'running')
  assert.doesNotMatch(h.sent.at(-1).prompt, /"decision":"later"/u)
  await h.respond({ decision: 'later' })
  assert.equal(h.store.taskById(manual.id).status, 'failed')
  assert.deepEqual(h.calls, [])
})

test('late observations and failed authority checks never produce an expedition receipt', async t => {
  const h = fixture(t)
  h.service.setSurveyWindow(h.input)
  h.now(12, 43)
  await h.poll()
  const job = h.windowJob()
  assert.equal(job.payload.expiresAt, new Date(2026, 10, 9, 12, 45).getTime())
  assert.doesNotMatch(h.sent.at(-1).prompt, /"decision":"later"/u)
  h.now(12, 45)
  await h.respond({ decision: 'survey', direction: 'north' })
  assert.equal(h.windowJob().task.status, 'cancelled')
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }), [])
  h.now(12, 44, 10)
  await h.poll()
  assert.equal(h.windowJob('2026-11-10'), undefined)
})

test('Worker becoming unavailable after the decision began cancels the scheduled route', async t => {
  const h = fixture(t)
  h.service.setSurveyWindow(h.input)
  h.now(12, 0)
  await h.poll()
  h.state.ready = false
  await h.respond({ decision: 'survey', direction: 'north' })
  assert.equal(h.windowJob().task.status, 'cancelled')
  assert.deepEqual(h.calls, [])
})

test('revoking a rule aborts in-flight travel and discards a late success receipt', async t => {
  const h = fixture(t)
  const originalSurvey = h.minecraft.surveyCamp
  let resolveSurvey, activeSignal
  const pending = new Promise(resolve => { resolveSurvey = resolve })
  h.minecraft.surveyCamp = async (zoneId, direction, signal) => {
    activeSignal = signal
    await pending
    return originalSurvey(zoneId, direction, new AbortController().signal)
  }
  h.service.setSurveyWindow(h.input)
  h.now(12, 0)
  await h.poll()
  await h.respond({ decision: 'survey', direction: 'north' })
  try {
    assert.equal(activeSignal?.aborted, false)
    h.service.revokeSurveyWindow()
    assert.equal(activeSignal.aborted, true)
  } finally { resolveSurvey() }
  await setImmediate()
  assert.equal(h.windowJob().task.status, 'cancelled')
  assert.equal(h.windowJob().payload.receiptTaskId, undefined)
  assert.deepEqual(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }), [])
})

test('restart after entering running consumes the day even if no attempt count was persisted', async t => {
  const h = fixture(t)
  const { rule } = h.service.setSurveyWindow(h.input)
  h.now(12, 0)
  const job = h.store.autonomy.create({
    kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
    dedupeKey: surveyWindowKey('2026-11-09'), runAfter: Date.now(), maxAttempts: 1,
    payload: { windowSurveyZoneId: h.zone.id, windowRuleId: rule.id, goal: 'survey', expiresAt: Date.now() + 15 * 60_000 },
  })
  h.store.transitionTask(job.id, 'running')
  const restarted = new AutonomyService(h.store, h.sessions, undefined, h.minecraft)
  try {
    restarted.start()
    await setImmediate()
    assert.equal(h.windowJob().task.status, 'failed')
    assert.equal(h.windowJob().id, job.id)
    assert.equal(restarted.surveyWindowView().today.status, 'used')
    assert.equal(h.sent.length, 0)
    assert.deepEqual(h.calls, [])
  } finally {
    await restarted.close()
  }
})
