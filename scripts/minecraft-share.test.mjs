import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_SHARE_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { MINECRAFT_HOUSE_CAPABILITY, MINECRAFT_HOUSE_EVENT, minecraftHouseBuildSummary } from '../src/core/minecraft-house-repository.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX } from '../src/core/minecraft-supply.ts'
import { createSurveyWindow } from '../src/core/minecraft-survey-window.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { verifiedMinecraftMilestone } from '../src/host/minecraft-milestones.ts'
import { verifiedMinecraftSurveyMoment } from '../src/host/minecraft-moments.ts'
import { restrictCompanionTools } from '../src/host/tool-policy.ts'

function setup(t, image) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/minecraft-share-test-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const sent = []
  const created = []
  const cancelled = []
  const sessions = {
    async create(input, fresh) {
      created.push({ input, fresh })
      return { binding: store.bindContext({ ...input, sessionId: input.sessionId ?? (fresh ? `review-${created.length}` : 'review') }) }
    },
    async send(contextId, prompt, _source, _voice, _attachments, assertAuthorized) {
      assertAuthorized?.()
      const receipt = { accepted: true, contextId, messageId: `input-${sent.length + 1}`, sessionId: store.bindingByContext(contextId).sessionId }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel(contextId) { cancelled.push(contextId) },
  }
  const publish = input => store.feed.create(input)
  const service = new AutonomyService(store, sessions, undefined, undefined, publish, undefined,
    image && ((input, receipt, assertReady) => image(store, input, receipt, assertReady)))
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  function moment(kind = 'dig', summary = '采集并拾取了自然生长的橡木原木，背包增加了 1 根。') {
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: `minecraft.${kind}`, title: 'Minecraft test' })
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
    return { taskId: task.id, kind, summary }
  }
  function survey(proof = { direction: 'east', surveySteps: 4, surveyOutcome: 'completed' }) {
    const payload = { surveyZoneId: randomUUID(), goal: 'survey', expiresAt: Date.now() + 60_000 }
    const parent = store.autonomy.create({
      kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT, dedupeKey: randomUUID(), runAfter: Date.now(), payload,
    })
    store.transitionTask(parent.id, 'running')
    const { taskId } = moment('survey')
    store.transitionTask(parent.id, 'succeeded', undefined, () => store.autonomy.update(parent.id, {
      payload: { ...payload, ...proof, receiptTaskId: taskId },
    }))
    return verifiedMinecraftSurveyMoment(parent.id, store).moment
  }
  async function due(job) {
    store.autonomy.update(job.id, { runAfter: Date.now() - 1 })
    service.wake()
    await setImmediate()
  }
  async function respond(result, id = sent.at(-1).receipt.messageId) {
    const binding = store.bindingByContext(MINECRAFT_SHARE_CONTEXT)
    service.observe(binding, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id, source: { kind: 'user' } }, seq: 2 })
    service.observe(binding, {
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(result) }] } }, seq: 3,
    })
    assert.equal(store.feed.list().items.length, 0)
    service.observe(binding, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 4 })
    await setImmediate()
  }
  const enable = extra => service.updateSettings({ feedEnabled: true, minecraftShareEnabled: true, quietStart: '00:00', quietEnd: '00:00', ...extra })
  return { store, sessions, publish, service, sent, created, cancelled, moment, survey, due, respond, enable }
}

const shareMoment = source => ({ kind: source.experience.kind, taskId: source.experience.taskId, summary: source.fact })

function builtHouse(store) {
  const zone = store.createBuildZone({ name: '机密区名', dimension: 'minecraft:overworld', x: 271, y: 80, z: -36, radius: 6 })
  const name = '机密设计标题'
  const assumptions = '主人原文不可公开'
  const reference = { contextId: 'chat.mobile', messageId: 'owner-reference-message', attachmentId: 'private-photo.png' }
  const draft = store.minecraftHouses.create({ name, assumptions, zoneId: zone.id, layout: { width: 2, height: 1, depth: 1, blocks: 'og' } },
    { sessionId: 'private-owner-chat', messageId: reference.messageId, reference })
  const task = store.createTask({ contextId: 'game.minecraft', capabilityId: MINECRAFT_HOUSE_CAPABILITY, title: name, sessionId: 'private-game-session' })
  assert.equal(store.minecraftHouses.start(draft.id, zone.id, task.id), true)
  store.transitionTask(task.id, 'running')
  const receipt = { built: true, zoneId: zone.id, checked: 2, placed: 2, consumed: { oak_planks: 1, glass: 1 } }
  assert.equal(store.minecraftHouses.finish(draft.id, task.id, receipt), true)
  store.transitionTask(task.id, 'succeeded')
  store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', sessionId: task.sessionId,
    kind: MINECRAFT_HOUSE_EVENT, taskId: task.id, summary: minecraftHouseBuildSummary(receipt), status: 'success' })
  return { zone, draft, moment: shareMoment(verifiedMinecraftMilestone(store, 'house', task.id)),
    privateValues: [name, assumptions, reference.attachmentId, reference.messageId, zone.name, zone.id, String(zone.x), draft.id, task.id, task.sessionId] }
}

function completedCampProject(t, store) {
  const dayStart = day => new Date(2026, 10, day, 12).getTime()
  t.mock.timers.enable({ apis: ['Date'], now: dayStart(9) - 60_000 })
  const zone = store.createBuildZone({ name: '机密营地区', dimension: 'minecraft:overworld', x: -271, y: 80, z: 36, radius: 6 })
  const rule = createSurveyWindow({ zoneId: zone.id, start: '12:00', end: '13:00', days: 2,
    allowMinecraftLogin: true, allowMinecraftSupply: true, allowMinecraftBuild: true, allowMinecraftProject: true }, Date.now())
  store.autonomy.saveSurveyWindow(rule)
  const visit = (choice, day, receipt, constructionTaskId) => {
    const now = dayStart(day)
    t.mock.timers.setTime(now)
    const date = `2026-11-${String(day).padStart(2, '0')}`
    const expiresAt = now + 90_000
    const daily = store.autonomy.create({ kind: 'daily.choice', contextId: DAILY_AUTONOMY_CONTEXT, dedupeKey: `daily:${date}`, runAfter: now })
    store.transitionTask(daily.id, 'running')
    const child = store.autonomy.create({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
      dedupeKey: `visit-${choice}:${daily.id}`, runAfter: now })
    store.transitionTask(child.id, 'running')
    const building = choice === 'build'
    const externalId = (building ? CAMP_VISIT_BUILD_TASK_PREFIX : CAMP_VISIT_REVISIT_TASK_PREFIX) + daily.id
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: building ? 'minecraft.build' : 'minecraft.survey', title: '真实短访', externalId })
    store.transitionTask(task.id, 'running')
    store.transitionTask(task.id, 'succeeded')
    store.autonomy.update(child.id, { payload: { campZoneId: zone.id, visitId: daily.id, expiresAt, receiptTaskId: task.id,
      ...(building ? { goal: 'camp', visitBuild: receipt } : { goal: 'revisit', constructionTaskId, visitRevisit: receipt }) } })
    store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT, source: 'game.minecraft',
      kind: `world.visit-${choice}`, taskId: task.id, summary: '实际游戏回执', status: 'success', data: { receipt } })
    store.transitionTask(child.id, 'succeeded')
    store.recordActivity({ eventId: `minecraft-visit:${daily.id}:offline`, contextId: 'game.minecraft', source: 'game.minecraft',
      kind: 'world.visit-offline', taskId: daily.id, summary: '实际下线回执', status: 'success' })
    store.autonomy.update(daily.id, { payload: { windowRuleId: rule.id, date, choice, expiresAt: now + 120_000,
      activityTaskId: child.id, visitId: daily.id, visitExpiresAt: expiresAt, visitJoined: true, visitStatus: 'offline' } })
    store.transitionTask(daily.id, 'succeeded')
    return { daily, task }
  }
  const build = visit('build', 9, { built: true, zoneId: zone.id, material: 'oak_planks', placedFloor: 8, placedTable: 1,
    inventory: { floorBefore: 8, floorAfter: 0, tablesBefore: 1, tablesAfter: 0 } })
  const revisit = visit('revisit', 10, { zoneId: zone.id, material: 'oak_planks', checkedBlocks: 9, matchedBlocks: 9 }, build.task.id)
  return { zone, build, revisit, moment: shareMoment(verifiedMinecraftMilestone(store, 'camp-project', revisit.daily.id)) }
}

function publishSurveyCard(store, input) {
  const now = new Date().toISOString()
  const media = store.media.upsert({
    kind: 'image', path: `${input.sourceTaskId}.png`, source: 'minecraft-survey-card', sourceRef: input.sourceTaskId,
    mimeType: 'image/png', retention: 'keep', createdAt: now, lastUsedAt: now, bytes: 1,
  })
  return store.feed.create({ ...input, mediaId: media.id })
}

test('shares one confirmed action after its exact completed review and records the shared memory', async t => {
  const h = setup(t)
  const moment = h.moment()
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  h.service.updateSettings({ feedEnabled: true })
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  h.enable()
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, kind: 'build' }), undefined)
  const job = h.service.enqueueMinecraftShare(moment)
  assert.equal(job.maxAttempts, 1)
  assert.equal(h.service.enqueueMinecraftShare(h.moment()), undefined)
  await h.due(job)
  assert.equal(h.sent.length, 1)
  assert.ok(h.sent[0].prompt.includes(moment.summary))
  assert.ok(!h.sent[0].prompt.includes(moment.taskId))
  await h.respond({ decision: 'publish', reflection: '积少成多，心里踏实一点。' })
  const [post] = h.store.feed.list().items
  assert.equal(post.body, `${moment.summary}积少成多，心里踏实一点。`)
  assert.equal(post.sourceTaskId, moment.taskId)
  assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
  const memories = h.store.memory.list({ contextId: 'chat.mobile', status: 'active', limit: 10 })
  assert.ok(memories.some(memory => memory.scope === 'shared' && memory.sourceRefs.some(ref => ref.taskId === moment.taskId)))
  h.store.feed.delete(post.id, 'companion')
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  const next = h.service.enqueueMinecraftShare(h.moment())
  assert.ok(next.runAfter >= Date.parse(post.createdAt) + 360 * 60_000)
})

test('quiet hours defer the review, and a decision to stay silent consumes that candidate', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 1).getTime() })
  const h = setup(t)
  h.enable({ quietStart: '23:00', quietEnd: '08:00' })
  const moment = h.moment()
  const job = h.service.enqueueMinecraftShare(moment)
  await h.due(job)
  assert.equal(h.sent.length, 0)
  assert.equal(new Date(h.store.autonomy.get(job.id).runAfter).getHours(), 8)
  h.enable()
  await h.due(job)
  await h.respond({ decision: 'skip' })
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
})

test('an unrelated turn or a share disabled mid-review cannot publish', async t => {
  for (const invalid of ['receipt', 'disabled']) {
    await t.test(invalid, async t => {
      const h = setup(t)
      h.enable()
      const moment = h.moment()
      const job = h.service.enqueueMinecraftShare(moment)
      await h.due(job)
      if (invalid === 'disabled') {
        h.service.updateSettings({ minecraftShareEnabled: false })
        h.enable()
      }
      await h.respond({ decision: 'publish', reflection: '有些开心。' }, invalid === 'receipt' ? 'unrelated' : undefined)
      assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
      assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    })
  }
})

test('a standalone or forged survey receipt cannot enter or finish an autonomous share', async t => {
  const h = setup(t)
  h.enable()
  const moment = h.survey()
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, taskId: h.moment('survey').taskId }), undefined)
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, surveyParentTaskId: randomUUID() }), undefined)
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, summary: '未经核验的事实。' }), undefined)
  const job = h.service.enqueueMinecraftShare(moment)
  const parent = h.store.autonomy.get(moment.surveyParentTaskId)
  await h.due(job)
  h.store.autonomy.update(parent.id, { payload: { ...parent.payload, receiptTaskId: randomUUID() } })
  await h.respond({ decision: 'publish', reflection: '真想再走一段。' })
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
})

test('a candidate can remain private or be shared as text without invoking the renderer', async t => {
  for (const result of [{ decision: 'skip' }, { decision: 'publish', reflection: '这次慢慢走也挺好。' }]) {
    await t.test(result.decision, async t => {
      let rendered = 0
      const h = setup(t, async () => { rendered++ })
      h.enable({ minecraftShareImagesEnabled: true })
      const moment = h.survey({ surveyTrail: 'east-south', surveyCheckpoints: 1, surveyOutcome: 'recovered' })
      const job = h.service.enqueueMinecraftShare(moment)
      await h.due(job)
      const prompt = h.sent[0].prompt
      assert.match(prompt, /确认 1 个检查点后提前折返/u)
      assert.match(prompt, /"image":true/u)
      assert.doesNotMatch(prompt, new RegExp(`${moment.taskId}|${moment.surveyParentTaskId}`, 'u'))
      await h.respond(result)
      assert.equal(rendered, 0)
      const post = h.store.feed.bySourceTask(moment.taskId)
      if (result.decision === 'publish') {
        assert.equal(post.body, `${moment.summary}${result.reflection}`)
        assert.equal(post.mediaId, undefined)
        assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
      } else {
        assert.equal(post, undefined)
        assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
      }
    })
  }
})

test('an unavailable image option cannot be introduced by a regular action or an in-flight settings change', async t => {
  for (const scenario of ['regular action', 'enabled after the prompt', 'missing renderer']) {
    await t.test(scenario, async t => {
      let rendered = 0
      const h = setup(t, scenario !== 'missing renderer' ? async () => { rendered++ } : undefined)
      h.enable({ minecraftShareImagesEnabled: scenario !== 'enabled after the prompt' })
      const moment = scenario === 'regular action' ? h.moment() : h.survey()
      const job = h.service.enqueueMinecraftShare(moment)
      await h.due(job)
      assert.doesNotMatch(h.sent[0].prompt, /"image":true/u)
      h.enable({ minecraftShareImagesEnabled: true })
      await h.respond({ decision: 'publish', reflection: '想附张图。', image: true })
      assert.equal(rendered, 0)
      assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
      assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    })
  }
})

test('only an authorized model decision renders a verified card and a committed post is never published twice', async t => {
  for (const broadcastError of [false, true]) {
    await t.test(broadcastError ? 'broadcast fails after commit' : 'normal publish', async t => {
      const receipts = []
      const h = setup(t, async (store, input, receipt, assertReady) => {
        receipts.push(receipt)
        assertReady()
        const post = publishSurveyCard(store, input)
        if (broadcastError) throw new Error('simulated broadcast failure')
        return post
      })
      h.enable({ minecraftShareImagesEnabled: true })
      const moment = h.survey()
      const job = h.service.enqueueMinecraftShare(moment)
      await h.due(job)
      assert.equal(receipts.length, 0)
      await h.respond({ decision: 'publish', reflection: '这张小路图值得留着。', image: true })
      assert.deepEqual(receipts.map(receipt => ({ ...receipt, at: undefined })), [{
        kind: 'survey', outcome: 'completed', route: { kind: 'straight', direction: 'east', steps: 4 }, at: undefined,
      }])
      const post = h.store.feed.bySourceTask(moment.taskId)
      assert.equal(h.store.media.get(post.mediaId).sourceRef, moment.taskId)
      assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
      assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' })
        .some(memory => memory.sourceRefs.some(ref => ref.taskId === moment.taskId)))
      h.store.feed.delete(post.id, 'companion')
      assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
      assert.equal(receipts.length, 1)
    })
  }
})

test('an async card is withheld if authorization, receipt, or cooldown changes during rendering', async t => {
  for (const scenario of ['image disabled and re-enabled', 'receipt changed', 'another post was published']) {
    await t.test(scenario, async t => {
      const staging = Promise.withResolvers()
      const release = Promise.withResolvers()
      const h = setup(t, async (store, input, _receipt, assertReady) => {
        staging.resolve()
        await release.promise
        assertReady()
        return publishSurveyCard(store, input)
      })
      h.enable({ minecraftShareImagesEnabled: true })
      const moment = h.survey()
      const job = h.service.enqueueMinecraftShare(moment)
      await h.due(job)
      try {
        await h.respond({ decision: 'publish', reflection: '今天去看了看。', image: true })
        assert.equal(await Promise.race([staging.promise.then(() => true), setImmediate(false)]), true)
        if (scenario === 'image disabled and re-enabled') {
          h.enable({ minecraftShareImagesEnabled: false })
          h.enable({ minecraftShareImagesEnabled: true })
        } else if (scenario === 'receipt changed') {
          const parent = h.store.autonomy.get(moment.surveyParentTaskId)
          h.store.autonomy.update(parent.id, { payload: { ...parent.payload, direction: 'north' } })
        } else {
          h.store.feed.create({ author: 'companion', contextId: 'autonomy.feed', body: '另一条动态' })
        }
      } finally {
        release.resolve()
      }
      await setImmediate()
      assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
      assert.deepEqual(h.store.media.list(), [])
      assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    })
  }
})

test('restart reconciles a share already committed to the feed without republishing', async t => {
  const h = setup(t)
  h.enable()
  const moment = h.survey()
  const job = h.service.enqueueMinecraftShare(moment)
  h.store.transitionTask(job.id, 'running')
  h.store.autonomy.update(job.id, { attempts: 1, leaseUntil: Date.now() + 5_000 })
  const post = h.publish({
    body: `${moment.summary}沿路走很踏实。`, author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT,
    sourceTaskId: moment.taskId, sourceSessionId: 'review',
  })
  const restarted = new AutonomyService(h.store, h.sessions, undefined, undefined, () => assert.fail('Share already committed'))
  try {
    restarted.start()
    assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
    assert.equal(h.store.feed.bySourceTask(moment.taskId).id, post.id)
    assert.equal(h.store.feed.list().items.length, 1)
  } finally {
    await restarted.close()
  }
})

test('verified house milestone has independent consent and shares only its fixed fact and a fresh private reflection', async t => {
  let renders = 0
  const h = setup(t, async () => { renders++ })
  const { moment, privateValues } = builtHouse(h.store)
  h.enable({ minecraftShareImagesEnabled: true })
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  h.enable({ minecraftMilestonesEnabled: true, minecraftShareEnabled: false })
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  h.enable({ minecraftMilestonesEnabled: true })
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, summary: ` ${moment.summary}` }), undefined)
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, kind: 'camp-project' }), undefined)
  assert.equal(h.service.enqueueMinecraftShare({ ...moment, reference: 'private' }), undefined)
  h.store.bindContext({ contextId: MINECRAFT_SHARE_CONTEXT, sessionId: 'old-review-with-history', kind: 'system', label: '旧分享' })
  const job = h.service.enqueueMinecraftShare(moment)
  assert.equal(job.maxAttempts, 1)
  await h.due(job)
  assert.equal(h.created.at(-1).fresh, true)
  assert.equal(h.created.at(-1).input.sessionId, undefined)
  assert.ok(h.sent.at(-1).prompt.includes(moment.summary))
  assert.doesNotMatch(h.sent.at(-1).prompt, /"image"/u)
  for (const value of privateValues) assert.ok(!h.sent.at(-1).prompt.includes(value), value)
  await h.respond({ decision: 'publish', reflection: '我喜欢慢慢把事情做稳。' })
  const post = h.store.feed.bySourceTask(moment.taskId)
  assert.equal(post.body, `${moment.summary}我喜欢慢慢把事情做稳。`)
  assert.equal(post.mediaId, undefined)
  assert.equal(renders, 0)
  assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
  for (const value of privateValues) assert.ok(!post.body.includes(value), value)
  assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
})

test('the same private share route accepts a fully verified offline camp project source', async t => {
  const h = setup(t)
  const { zone, build, revisit, moment } = completedCampProject(t, h.store)
  h.enable({ minecraftMilestonesEnabled: true })
  const job = h.service.enqueueMinecraftShare(moment)
  assert.ok(job)
  await h.due(job)
  assert.match(h.sent.at(-1).prompt, /复访确认 9 处方块完好，已下线/u)
  for (const value of [zone.id, zone.name, build.task.id, revisit.task.id, revisit.daily.id]) assert.ok(!h.sent.at(-1).prompt.includes(value))
  await h.respond({ decision: 'publish', reflection: '我想把这点踏实记住。' })
  assert.equal(h.store.feed.bySourceTask(revisit.daily.id).body, `${moment.summary}我想把这点踏实记住。`)
  assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(memory =>
    memory.sourceRefs.some(ref => ref.contextId === DAILY_AUTONOMY_CONTEXT && ref.taskId === revisit.daily.id)))
})

test('turning milestones off consumes accepted and active candidates, including replies arriving after re-enabling', async t => {
  for (const active of [false, true]) await t.test(active ? 'active' : 'queued', async t => {
    const h = setup(t)
    const { moment } = builtHouse(h.store)
    h.enable({ minecraftMilestonesEnabled: true })
    const job = h.service.enqueueMinecraftShare(moment)
    if (active) await h.due(job)
    h.enable({ minecraftMilestonesEnabled: false })
    h.enable({ minecraftMilestonesEnabled: true })
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    if (active) {
      assert.deepEqual(h.cancelled, [MINECRAFT_SHARE_CONTEXT])
      await h.respond({ decision: 'publish', reflection: '我有些开心。' })
    }
    assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
    assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  })
})

test('milestone finishes fail closed when provenance changes or the model includes coordinates, quoted titles, links or an image', async t => {
  for (const [scenario, reply] of [
    ['revoked', { decision: 'publish', reflection: '我有些开心。' }],
    ['coordinate', { decision: 'publish', reflection: '我记住坐标一二三。' }],
    ['title', { decision: 'publish', reflection: '我喜欢《机密设计标题》。' }],
    ['url', { decision: 'publish', reflection: '我存到了 https://example.test。' }],
    ['empty fragment', { decision: 'publish', reflection: '我……' }],
    ['image', { decision: 'publish', reflection: '我有些开心。', image: true }],
    ['skip', { decision: 'skip' }],
  ]) await t.test(scenario, async t => {
    const h = setup(t, () => assert.fail('milestone cannot render an image'))
    const { zone, moment } = builtHouse(h.store)
    h.enable({ minecraftMilestonesEnabled: true, minecraftShareImagesEnabled: true })
    const job = h.service.enqueueMinecraftShare(moment)
    await h.due(job)
    if (scenario === 'revoked') h.store.revokeBuildZone(zone.id)
    await h.respond(reply)
    assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.equal(h.service.enqueueMinecraftShare(moment), undefined)
  })
})

test('milestone source timing shares the existing quiet period, cooldown and maximum age', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 1).getTime() })
  const h = setup(t)
  const { moment } = builtHouse(h.store)
  h.enable({ minecraftMilestonesEnabled: true, quietStart: '23:00', quietEnd: '08:00' })
  const job = h.service.enqueueMinecraftShare(moment)
  assert.equal(new Date(job.runAfter).getHours(), 8)
  await h.due(job)
  assert.equal(h.sent.length, 0)
  h.enable({ minecraftMilestonesEnabled: true })
  const recent = h.store.feed.create({ author: 'companion', body: '一次已有动态', contextId: 'autonomy.feed' })
  await h.due(job)
  assert.equal(h.sent.length, 0)
  assert.ok(h.store.autonomy.get(job.id).runAfter >= Date.parse(recent.createdAt) + 360 * 60_000)
  t.mock.timers.setTime(Date.now() + 24 * 60 * 60_000)
  assert.equal(h.service.minecraftShareGate(moment), '游戏经历已过分享时限')
  assert.equal(h.store.feed.bySourceTask(moment.taskId), undefined)
})

test('the feed repository refuses a milestone forgery without its running share authority and recovers a committed share once', async t => {
  const h = setup(t)
  const { moment } = builtHouse(h.store)
  h.enable({ minecraftMilestonesEnabled: true })
  const body = `${moment.summary}我心里很踏实。`
  const postInput = { body, author: 'companion', contextId: MINECRAFT_SHARE_CONTEXT, sourceTaskId: moment.taskId, sourceSessionId: 'review' }
  h.store.bindContext({ contextId: MINECRAFT_SHARE_CONTEXT, sessionId: 'review', kind: 'system', label: '私有评估' })
  assert.throws(() => h.publish(postInput), /milestone share source job/u)
  const job = h.service.enqueueMinecraftShare(moment)
  assert.throws(() => h.publish(postInput), /milestone share source job/u)
  h.store.transitionTask(job.id, 'running')
  h.store.autonomy.update(job.id, { attempts: 1, leaseUntil: Date.now() + 5_000 })
  for (const patch of [{ sourceSessionId: 'other' }, { body: '改写已核验事实。' }, { body: `${moment.summary}我留了原图。` }]) {
    assert.throws(() => h.publish({ ...postInput, ...patch }), /milestone share source job/u)
  }
  assert.throws(() => h.publish({ ...postInput, mediaId: randomUUID() }), /authorized text review/u)
  h.store.autonomy.update(job.id, { payload: { ...moment, kind: 'camp-project' } })
  assert.throws(() => h.publish(postInput), /not an eligible completed action/u)
  h.store.autonomy.update(job.id, { payload: moment })
  const post = h.publish(postInput)
  h.store.autonomy.saveSettings({ ...h.store.autonomy.settings(), minecraftMilestonesEnabled: false })
  const restarted = new AutonomyService(h.store, h.sessions, undefined, undefined, () => assert.fail('Already committed'))
  try {
    restarted.start()
    assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
    assert.equal(h.store.feed.bySourceTask(moment.taskId).id, post.id)
    assert.equal(h.store.feed.list().items.length, 1)
  } finally { await restarted.close() }
})

test('the dedicated game sharing context asks the pinned DSH tool registry for an empty allowlist', () => {
  const filters = []
  restrictCompanionTools({ effect: handler => handler(), tools: { restrict: filter => filters.push(filter) } }, MINECRAFT_SHARE_CONTEXT, 'system')
  assert.deepEqual(filters, [{ allow: [] }])
})
