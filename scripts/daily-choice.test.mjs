import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { projectCommunity } from '../src/core/community.ts'
import { projectHome } from '../src/core/home.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SHARE_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY } from '../src/core/minecraft-house-project.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { deviceContextAllowed } from '../src/host/device-http.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'
import { verifiedDailyReflectionSource } from '../src/host/daily-reflection-source.ts'
import { recentDailyInitiativeEvidence } from '../src/host/daily-initiative-evidence.ts'

const DAILY = 'autonomy.daily'
const CUE = { from: 5.25, to: 7.5, text: '海风经过旧码头，远处的灯亮了。' }
const PRIVATE_CLIP = '隔离片段转写，不能进入其他会话。'
const SAMPLE = { start: 12, seconds: 6, mode: 'audio' }

function fixture(t, { publish = false, bili = true, clip = false, vision = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 11, 55) })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/daily-choice-')
  const filename = join(directory, 'companion.db')
  let store = new CompanionStore(filename)
  const zone = store.createBuildZone({ name: 'Private camp label', dimension: 'minecraft:overworld', x: 19, y: 64, z: 23, radius: 6 })
  const input = { zoneId: zone.id, start: '12:00', end: '12:45', days: 2, allowBilibili: true }
  const state = { ready: true, paused: false, idle: true, foregroundBusy: false,
    offer: { directions: ['north'], routes: [{ direction: 'north', steps: 5 }], trails: ['north-east'] } }
  const sent = []
  const previews = []
  const game = []
  const reads = []
  const clips = []
  const clipInputs = []
  const cancellations = []
  let sessionCount = 0
  const sessions = {
    chatAttachmentsAvailable: vision,
    async create({ sessionId, ...input }, _replace, check) {
      check?.()
      return { binding: store.bindContext({ ...input, sessionId: sessionId ?? `session-${++sessionCount}` }) }
    },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, messageId: `daily-input-${sent.length + 1}`, sessionId: store.bindingByContext(contextId).sessionId }
      sent.push({ receipt, prompt })
      return receipt
    },
    async bilibiliClipVision() { return vision },
    async sendBilibiliClip(sessionId, prompt, picture, check) {
      check()
      const receipt = { accepted: true, contextId: BILIBILI_CLIP_CONTEXT, sessionId, messageId: `clip-input-${clips.length + 1}`,
        ...(picture && { attachments: [{ id: 'sha256:daily-image' }] }) }
      clips.push({ receipt, prompt, picture })
      return receipt
    },
    async cancel(contextId) { cancellations.push(contextId) },
    async release() {},
  }
  function gameReceipt(result) {
    const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.survey', title: 'Verified survey' })
    store.transitionTask(task.id, 'running')
    return { task: store.transitionTask(task.id, 'succeeded'), result }
  }
  const minecraft = {
    async eventPrompt() { throw new Error('Unexpected game event') },
    finishEvent() { throw new Error('Unexpected game event') },
    campPaused() { return state.paused },
    surveyWindowReady() { return state.ready },
    async inspectCampSurvey(zoneId, signal) {
      signal.throwIfAborted()
      previews.push(zoneId)
      return state.offer
    },
    async surveyCamp(zoneId, direction, signal, steps) {
      signal.throwIfAborted()
      game.push({ zoneId, direction, steps })
      return gameReceipt({ zoneId, direction, steps: steps ?? 4, reached: true, surveyed: true, returned: true })
    },
    async surveyTrail(zoneId, trail, signal) {
      signal.throwIfAborted()
      game.push({ zoneId, trail })
      return gameReceipt({ zoneId, trail, outcome: 'completed', checkpoints: 2, returned: true })
    },
  }
  function readReceipt(input, context, provenance) {
    const kind = 'video.subtitle-read'
    const at = new Date().toISOString()
    const activityId = store.recordActivity({
      contextId: context.contextId, sessionId: context.sessionId,
      source: 'media.bilibili', kind, status: 'success', occurredAt: at, summary: '字幕回执',
      data: { bvid: input.video, part: input.part, candidateId: context.candidateId,
        ...(provenance && { subtitleOrigin: provenance.kind, subtitleSha256: provenance.sha256 }) },
    })
    return {
      bvid: input.video, part: input.part,
      subtitle: { status: 'excerpt', cues: [CUE], language: 'zh-CN', truncated: false, provenance }, receipt: { activityId, at, kind, provenance },
    }
  }
  let read = (input, context) => readReceipt(input, context)
  let sample = (input, vision) => ({
    transcript: input.mode !== 'visual' ? PRIVATE_CLIP : undefined, picture: vision ? Buffer.from([1, 2, 3]) : undefined,
    visual: { status: vision ? 'sampled' : 'unavailable' }, audio: { status: input.mode !== 'visual' ? 'sampled' : 'unavailable' },
  })
  const bilibili = bili ? {
    isIdle: () => state.idle,
    async read(input, context, signal) {
      reads.push({ input, context, signal })
      return read(input, context, signal)
    },
    ...(clip && { clipAudioAvailable: true, async sampleClip(input, vision, signal) {
      signal.throwIfAborted()
      clipInputs.push({ input, vision, signal })
      return sample(input, vision, signal)
    } }),
  } : undefined
  const newService = () => new AutonomyService(store, sessions, undefined, minecraft, publish ? input => store.feed.create(input) : undefined, bilibili,
    undefined, () => state.foregroundBusy)
  let service = newService()
  service.updateSettings({ quietStart: '00:00', quietEnd: '00:00', bilibiliEnabled: bili })
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const now = (hour, minute, date = 9) => t.mock.timers.setTime(new Date(2026, 10, date, hour, minute).getTime())
  const advance = at => t.mock.timers.setTime(at)
  const settle = async () => { await setImmediate(); await setImmediate() }
  const wake = async () => { service.wake(); await settle() }
  const add = (index = 1) => store.bilibili.add({ bvid: `BV123456789${index}`, part: index }, '待选视频')
  const jobs = () => store.autonomy.list().filter(job => job.kind === 'daily.choice')
  const memory = () => store.memory.list({ contextId: 'chat.mobile', status: 'active' })
  const home = () => projectHome({
    presence: 'idle', now: new Date(), activities: store.activities(), bindings: store.bindings(), runningSessions: new Set(),
    minecraft: false, speaking: false, quiet: false,
  })

  async function open({ candidate = true } = {}) {
    await settle()
    const auth = service.setSurveyWindow(input)
    assert.equal(auth.today.status, 'waiting')
    const item = candidate ? add() : undefined
    now(12, 0)
    await wake()
    assert.equal(sent.at(-1)?.receipt.contextId, DAILY)
    assert.equal(jobs()[0].task.status, 'running')
    return item
  }

  async function respond(response, { userId, addToolCall = false, omitMessageId = false, duplicateOutput = false, surfaceOp = 'append', sourceBinding, afterClaim } = {}) {
    const last = sent.at(-1).receipt
    const binding = sourceBinding ?? store.bindingByContext(last.contextId)
    const turn = sent.length
    service.observe(binding, { type: 'turn/start', data: { turn }, seq: turn * 10 + 1 })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id: userId ?? last.messageId, source: { kind: 'user' } }, seq: turn * 10 + 2 })
    afterClaim?.()
    const content = [{ type: 'text', text: JSON.stringify(response) }]
    if (addToolCall) content.push({ type: 'tool-call', name: 'mc_move' })
    const message = { content, ...(!omitMessageId && { id: `daily-assistant-${turn}` }) }
    service.observe(binding, { type: 'assistant/message', surfaceOp, data: { turn, message }, seq: turn * 10 + 3 })
    if (duplicateOutput) service.observe(binding, { type: 'assistant/message', surfaceOp, data: { turn, message }, seq: turn * 10 + 4 })
    service.observe(binding, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, seq: turn * 10 + 5 })
    await settle()
    await wake()
  }

  function startInitiative(messageId = sent.at(-1).receipt.messageId) {
    const binding = store.bindingByContext(DAILY)
    const turn = sent.length
    let seq = turn * 100
    let step = 1
    let lastCall
    const emit = (type, data, surfaceOp, source = binding) => {
      service.observe(source, { type, data, surfaceOp, seq: ++seq })
      return seq
    }
    emit('turn/start', { turn })
    emit('step/start', { turn, step })
    emit('user/message', { id: messageId, source: { kind: 'user' } }, 'append')
    const result = ({ callId = lastCall, isError = false, content, surfaceOp = 'append', turnOffset = 0, stepOffset = 0, source } = {}) =>
      emit('tool/result', { turn: turn + turnOffset, step: step + stepOffset, message: { toolCallId: callId, isError,
        content: content ?? [{ type: 'text', text: '{"accepted":true,"state":"proposed"}' }] } }, surfaceOp, source)
    return {
      sessionId: binding.sessionId,
      get lastCall() { return lastCall },
      emit, result,
      async propose(proposal, signal, { accept = true, name = 'daily_initiative_propose', record = true } = {}) {
        lastCall = `initiative-${turn}-${step}-${seq}`
        if (record) emit('tool/call', { turn, step, name, callId: lastCall, arguments: JSON.stringify(proposal) })
        const response = await service.proposeDailyInitiative(binding.sessionId, proposal, signal, lastCall)
        if (accept) result()
        return response
      },
      nextStep() {
        emit('step/end', { turn, step })
        emit('step/start', { turn, step: ++step })
      },
      lateAssistant() {
        emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '我走了没选过的东路。' }] } }, 'append')
      },
      async complete(reason = 'completed') {
        emit('step/end', { turn, step })
        emit('turn/end', { turn, reason: { kind: reason } })
        await settle()
        await wake()
      },
    }
  }

  async function reviewClip({ completed = true, matching = true } = {}) {
    const { receipt, prompt } = clips.at(-1)
    const binding = store.bindingByContext(receipt.contextId)
    const emit = (type, data) => service.observe(binding, { type, data, surfaceOp: 'append' })
    emit('turn/start', { turn: 1 })
    const content = [{ type: 'text', text: prompt }, ...(receipt.attachments?.map(item => ({ type: 'image', attachment: { attachmentId: item.id } })) ?? [])]
    emit('user/message', { id: matching ? receipt.messageId : 'wrong-clip', source: { kind: 'companion-bili-clip', form: 'autonomous' }, content })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ observation: '隔离模型观察不进入共享经历。' }) }] } })
    emit('turn/end', { turn: 1, reason: { kind: completed ? 'completed' : 'interrupted' } })
    await settle()
  }

  async function reopen() {
    await service.close()
    store.close()
    store = new CompanionStore(filename)
    service = newService()
    service.start()
    await settle()
  }

  return {
    get store() { return store }, get service() { return service }, zone, input, state, sent, previews, game, reads, cancellations, clips, clipInputs,
    minecraft, sessions, now, advance, settle, wake, add, jobs, memory, home, open, respond, reopen, readReceipt, startInitiative,
    mockRead: replacement => { read = replacement },
    mockSample: replacement => { sample = replacement }, reviewClip,
  }
}

const initiativeGoal = '我想沿北面再走一趟，看看回营的路是否好走。'

function houseWindowFixture(t) {
  const h = fixture(t, { bili: false })
  const layout = { width: 4, depth: 4, height: 4, blocks: 'o'.repeat(64) }
  const project = h.store.minecraftHouseProjects.create({ zoneId: h.zone.id, name: '私有工程名',
    sections: [
      { name: '西翼', offset: { x: -2, y: 0, z: 0 }, layout },
      { name: '东翼', offset: { x: 2, y: 0, z: 0 }, layout },
    ] })
  const request = { zoneId: h.zone.id, start: '12:00', end: '12:45', days: 2, houseProjectId: project.id }
  const calls = { inspect: [], build: [] }
  const state = { offered: [{ section: 1, name: '东翼' }], beforeReceipt: async () => {}, emitReceipt: true, placed: 64 }
  h.minecraft.dailyHouseProjectReady = () => h.state.ready
  h.minecraft.inspectDailyHouseProject = async (projectId, zoneId, signal) => {
    signal.throwIfAborted()
    calls.inspect.push({ projectId, zoneId })
    return state.offered
  }
  h.minecraft.buildDailyHouseProjectSection = async (projectId, zoneId, offer, signal, assertPermit, lease) => {
    assert.equal(offer, state.offered[0])
    assertPermit()
    const task = h.store.transaction(() => {
      const accepted = h.store.createTask({ capabilityId: HOUSE_PROJECT_SECTION_CAPABILITY, title: '分段施工', contextId: 'game.minecraft',
        externalId: DAILY_HOUSE_PROJECT_TASK_PREFIX + lease.dailyTaskId })
      assert.equal(h.store.minecraftHouseProjects.start(projectId, offer.section, accepted.id), true)
      const current = h.store.transitionTask(accepted.id, 'running')
      lease.onStarted(current)
      return current
    })
    calls.build.push({ task, offer, signal, lease })
    const receipt = { built: true, zoneId, checked: 64, placed: state.placed, consumed: state.placed ? { oak_planks: state.placed } : {} }
    try {
      await state.beforeReceipt({ signal, assertPermit })
      assertPermit()
      h.store.transaction(() => {
        assert.equal(h.store.minecraftHouseProjects.finish(projectId, offer.section, task.id, { receipt }), true)
        h.store.transitionTask(task.id, 'succeeded')
        if (state.emitReceipt) h.store.recordActivity({ contextId: 'game.minecraft', taskId: task.id, source: 'game.minecraft',
          kind: 'world.house-project-section', status: 'success', summary: '分区回执',
          data: { projectId, index: offer.section, dailyTaskId: lease.dailyTaskId, ...receipt } })
      })
      return { task: h.store.taskById(task.id), receipt }
    } catch (error) {
      h.store.transaction(() => {
        h.store.minecraftHouseProjects.finish(projectId, offer.section, task.id, { reason: 'house-cancelled' })
        h.store.transitionTask(task.id, signal.aborted ? 'cancelled' : 'failed')
      })
      throw error
    }
  }
  const open = async () => {
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.settle()
    h.service.setSurveyWindow(request)
    h.now(12, 0)
    await h.wake()
    return h.startInitiative()
  }
  return { ...h, get store() { return h.store }, get service() { return h.service }, project, request, calls, projectState: state, open }
}

test('an existing same-zone project grant admits one ready section without borrowing camp permissions', async t => {
  const h = houseWindowFixture(t)
  assert.throws(() => h.service.setSurveyWindow(h.request), /house-project-window-unavailable/u)
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  const other = h.store.createBuildZone({ name: '另一个区域', dimension: 'minecraft:overworld', x: 50, y: 64, z: 50, radius: 6 })
  assert.throws(() => h.service.setSurveyWindow({ ...h.request, zoneId: other.id }), /house-project-window-invalid/u)
  assert.throws(() => h.service.setSurveyWindow({ ...h.request, houseProjectId: randomUUID() }), /house-project-window-invalid/u)
  h.state.ready = false
  h.service.setSurveyWindow(h.request)
  h.now(12, 0)
  await h.wake()
  assert.equal(h.service.surveyWindowView().today.status, 'paused')
  assert.deepEqual(h.calls.inspect, [])
  assert.deepEqual(h.sent, [])
  h.state.ready = true
  await h.wake()
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  const view = await h.service.observeDailyInitiative(turn.sessionId, signal)
  assert.deepEqual(view.options.map(option => option.id), ['house:2', 'defer'])
  assert.doesNotMatch(JSON.stringify(view), new RegExp(h.project.id, 'u'))
  assert.doesNotMatch(JSON.stringify(view), new RegExp(h.zone.id, 'u'))
  assert.deepEqual(h.previews, [])
  assert.deepEqual(h.game, [])
  const proposal = { option: 'house:2', goal: '想完成已经预检通过的东翼施工。', evidenceId: 'now-1' }
  await assert.rejects(turn.propose({ ...proposal, option: 'house:1' }, signal), /daily-initiative-proposal-invalid/u)
  await turn.propose(proposal, signal)
  assert.deepEqual(h.calls.build, [])
  await turn.complete()
  const [job] = h.jobs()
  assert.equal(job.task.status, 'succeeded')
  assert.equal(job.payload.choice, 'house-project')
  assert.equal(job.payload.houseSection.section, 1)
  assert.equal(job.payload.houseSection.projectId, h.project.id)
  assert.equal(job.payload.activityTaskId, h.calls.build[0].task.id)
  assert.equal(h.service.surveyWindowView().today.taskId, job.payload.activityTaskId)
  const current = h.store.minecraftHouseProjects.get(h.project.id)
  assert.equal(current.sections[0].status, 'pending')
  assert.equal(current.sections[1].status, 'built')
  assert.equal(current.verification, undefined)
  await h.reopen()
  assert.equal(h.jobs()[0].task.status, 'succeeded')
  assert.equal(h.calls.build.length, 1)
})

test('an admitted house initiative consumes the window on missing proof, rest or cancellation', async t => {
  for (const scenario of ['no native receipt', 'rest', 'missing world proof', 'revoke during work', 'foreground during work', 'expired during work']) {
    await t.test(scenario, async t => {
      const h = houseWindowFixture(t)
      const turn = await h.open()
      const signal = new AbortController().signal
      await h.service.observeDailyInitiative(turn.sessionId, signal)
      const options = scenario === 'no native receipt' ? { accept: false } : undefined
      const proposal = { option: scenario === 'rest' ? 'defer' : 'house:2', goal: '想决定现在是否适合施工。', evidenceId: 'now-1' }
      const later = scenario.endsWith('during work') ? Promise.withResolvers() : undefined
      if (later) h.projectState.beforeReceipt = () => later.promise
      if (scenario === 'missing world proof') h.projectState.emitReceipt = false
      await turn.propose(proposal, signal, options)
      await turn.complete()
      const shouldStart = !['no native receipt', 'rest'].includes(scenario)
      assert.equal(h.calls.build.length, shouldStart ? 1 : 0)
      if (later) {
        if (scenario === 'revoke during work') h.service.revokeSurveyWindow()
        else if (scenario === 'foreground during work') {
          const owner = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'owner-chat', kind: 'chat', label: '手机聊天' })
          h.service.observe(owner, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
        } else h.now(12, 8)
        if (scenario !== 'expired during work') assert.equal(h.calls.build[0].signal.aborted, true)
        later.resolve()
        await h.settle()
      }
      assert.ok(['failed', 'cancelled'].includes(h.jobs()[0].task.status))
      assert.equal(h.store.minecraftHouseProjects.get(h.project.id).verification, undefined)
      await h.wake()
      assert.equal(h.calls.build.length, shouldStart ? 1 : 0)
    })
  }
})

test('verified house work enters private reflection once, including work completed before reflection was enabled', async t => {
  for (const scenario of ['already enabled', 'enable after completion', 'zero placement', 'too old']) await t.test(scenario, async t => {
    const h = houseWindowFixture(t)
    if (scenario === 'already enabled' || scenario === 'zero placement') h.service.updateSettings({ dailyReflectionEnabled: true })
    if (scenario === 'zero placement') h.projectState.placed = 0
    const turn = await h.open()
    const signal = new AbortController().signal
    await h.service.observeDailyInitiative(turn.sessionId, signal)
    await turn.propose({ option: 'house:2', goal: '想完成已经预检通过的东翼施工。', evidenceId: 'now-1' }, signal)
    await turn.complete()
    const [daily] = h.jobs()
    assert.equal(daily.task.status, 'succeeded')
    assert.equal(h.store.minecraftHouseProjects.get(h.project.id).verification, undefined)
    if (scenario !== 'already enabled') assert.equal(reflectionJobs(h).length, 0)
    if (scenario === 'too old') h.advance(Date.now() + 48 * 60 * 60_000 + 1)
    if (scenario === 'enable after completion' || scenario === 'too old') {
      h.service.updateSettings({ dailyReflectionEnabled: true })
      await h.wake()
    }
    if (scenario === 'zero placement' || scenario === 'too old') {
      assert.equal(reflectionJobs(h).length, 0)
      assert.equal(h.store.selfNotes.byDailyExperience(daily.id), undefined)
      return
    }
    const [reflection] = reflectionJobs(h)
    const activity = h.store.activityByTask(daily.payload.activityTaskId, 'world.house-project-section', 'game.minecraft')
    assert.deepEqual(reflection.payload.sourceReceipt, {
      at: activity.occurredAt, fact: '在 Minecraft 自主施工第 2 个分区，核对 64 处位置，实际放置 64 块。',
    })
    assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 0)
    await h.reopen()
    h.advance(reflection.runAfter)
    await h.wake()
    const review = h.sent.at(-1)
    assert.equal(review.receipt.contextId, DAILY_REFLECTION_CONTEXT)
    assert.ok(review.prompt.includes(reflection.payload.sourceReceipt.fact))
    for (const privateValue of [h.project.id, h.zone.id, daily.id, daily.payload.activityTaskId, '私有工程名', '已经预检通过的东翼']) {
      assert.ok(!review.prompt.includes(privateValue))
    }
    const persona = h.store.persona()
    await h.respond(NOTE)
    const note = h.store.selfNotes.byDailyExperience(daily.id)
    assert.equal(note.createdBy, 'companion')
    assert.deepEqual(note.experience, { kind: 'house-project', dailyTaskId: daily.id,
      activityTaskId: daily.payload.activityTaskId, activityId: activity.id })
    assert.deepEqual(note.experienceReceipt, reflection.payload.sourceReceipt)
    assert.deepEqual(h.store.persona(), persona)
    const next = recentDailyInitiativeEvidence(h.store, Date.now())
    assert.deepEqual(next.selfNote, { noteId: note.id, revision: 1 })
    assert.ok(next.evidence.some(item => item.kind === 'experience' && item.text === reflection.payload.sourceReceipt.fact))
    assert.ok(next.evidence.every(item => !item.text.includes(note.content)))
    await h.reopen()
    await h.wake()
    assert.equal(reflectionJobs(h).length, 1)
    assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 1)
  })
})

test('a next-day plan cites the exact authored note revision that it observed', async t => {
  for (const change of ['unchanged', 'archived', 'archived and restored']) await t.test(change, async t => {
    const h = fixture(t)
    h.service.updateSettings({ dailyReflectionEnabled: true })
    const candidate = await h.open()
    await h.respond({ decision: 'bilibili', candidateId: candidate.id })
    const [reflection] = reflectionJobs(h)
    h.advance(reflection.runAfter)
    await h.wake()
    await h.respond(NOTE)
    const note = h.store.selfNotes.byDailyExperience(h.jobs()[0].id)
    assert.equal(note.status, 'active')
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    h.now(12, 0, 10)
    await h.wake()
    const turn = h.startInitiative()
    const signal = new AbortController().signal
    const observed = await h.service.observeDailyInitiative(turn.sessionId, signal)
    assert.deepEqual(observed.evidence.find(item => item.id === 'self-1'), { id: 'self-1', kind: 'self-note', text: '先核对证据再作判断' })
    assert.ok(!JSON.stringify(observed).includes(note.id))
    await turn.propose({ option: 'survey:north', goal: initiativeGoal, evidenceId: 'self-1' }, signal)
    if (change !== 'unchanged') h.store.selfNotes.update(note.id, { status: 'archived' })
    if (change === 'archived and restored') h.store.selfNotes.update(note.id, { status: 'active' })
    await turn.complete()
    const job = h.jobs().find(item => item.payload.date === '2026-11-10')
    if (change === 'unchanged') {
      assert.equal(job.task.status, 'succeeded')
      assert.deepEqual(job.payload.initiativeReceipt.selfNote, { noteId: note.id, revision: 1 })
      assert.equal(h.game.length, 1)
      await h.reopen()
      assert.deepEqual(h.store.autonomy.get(job.id).payload.initiativeReceipt.selfNote, { noteId: note.id, revision: 1 })
    } else {
      assert.equal(job.task.status, 'cancelled')
      assert.equal(job.payload.initiativeReceipt, undefined)
      assert.equal(h.game.length, 0)
    }
  })
})

test('daily initiative waits for genuine idle then runs one independently proposed goal with actual receipts', async t => {
  const h = fixture(t)
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.settle()
  h.service.setSurveyWindow(h.input)
  h.store.recordActivity({ contextId: 'chat.mobile', sessionId: 'chat-fixture', source: 'core.chat', kind: 'message.accepted', summary: 'owner input' })
  h.now(12, 0)
  await h.wake()
  assert.deepEqual(h.jobs(), [])
  assert.equal(h.sent.length, 0)
  h.now(12, 16)
  h.state.foregroundBusy = true
  await h.wake()
  assert.equal(h.sent.length, 0)
  h.state.foregroundBusy = false
  await h.wake()
  assert.match(h.sent.at(-1).prompt, /daily_initiative_observe/u)
  assert.doesNotMatch(h.sent.at(-1).prompt, /Private camp label|"direction"/u)
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  assert.equal(h.service.dailyInitiativeToolsActive(turn.sessionId), true)
  await assert.rejects(h.service.observeDailyInitiative('wrong-session', signal), { code: 'daily-initiative-tool-forbidden' })
  const proposal = { goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north' }
  await assert.rejects(turn.propose(proposal, signal), { code: 'daily-initiative-proposal-unavailable' })
  const seen = await h.service.observeDailyInitiative(turn.sessionId, signal)
  assert.deepEqual(seen.options.map(option => option.id), ['survey:north', 'trail:north-east', 'defer'])
  assert.match(seen.evidence[0].text, /北向.*5 格/u)
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(h.zone.id, 'u'))
  await assert.rejects(h.service.observeDailyInitiative(turn.sessionId, signal), { code: 'daily-initiative-observation-limit' })
  await assert.rejects(turn.propose({ ...proposal, option: 'survey:south' }, signal), { code: 'daily-initiative-proposal-invalid' })
  await assert.rejects(turn.propose({ ...proposal, evidenceId: 'invented-1' }, signal), { code: 'daily-initiative-proposal-invalid' })
  assert.deepEqual(await turn.propose(proposal, signal), { accepted: true, state: 'proposed' })
  await assert.rejects(turn.propose(proposal, signal), { code: 'daily-initiative-proposal-unavailable' })
  assert.deepEqual(h.game, [])
  assert.equal(h.jobs()[0].payload.initiative, undefined)
  await turn.complete()
  const [job] = h.jobs()
  assert.deepEqual(job.payload.initiative, { goal: initiativeGoal, evidence: seen.evidence[0], option: 'survey:north' })
  assert.equal(job.payload.initiativeReceipt.sessionId, turn.sessionId)
  assert.match(job.payload.initiativeReceipt.optionLabel, /北向.*5 格/u)
  assert.equal(job.task.status, 'succeeded')
  assert.equal(h.game.length, 1)
  assert.equal(h.memory().some(memory => memory.content.includes('步行 5 格')), true)
  await h.reopen()
  assert.equal(h.jobs()[0].payload.initiative.goal, initiativeGoal)
  assert.equal(h.game.length, 1)
})

test('only the matching successful appended result can authorize a completed initiative', async t => {
  const cases = [
    ['missing result', () => {}],
    ['wrong call ID', turn => turn.result({ callId: 'another-call' })],
    ['wrong turn', turn => turn.result({ turnOffset: 1 })],
    ['wrong step', turn => turn.result({ stepOffset: 1 })],
    ['wrong session', turn => turn.result({ source: { contextId: DAILY, kind: 'system', sessionId: 'other-session' } })],
    ['tool failure despite success-looking text', turn => turn.result({ isError: true })],
    ['replaced history result', turn => turn.result({ surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } })],
    ['different success content', turn => turn.result({ content: [{ type: 'text', text: '已经出发' }] })],
    ['extra content in result', turn => turn.result({ content: [
      { type: 'text', text: '{"accepted":true,"state":"proposed"}' }, { type: 'text', text: 'unexpected' },
    ] })],
    ['duplicate matching receipt', turn => { turn.result(); turn.result() }],
    ['continued model step after terminal result', turn => { turn.result(); turn.nextStep() }],
    ['late free text after terminal result', turn => { turn.result(); turn.lateAssistant() }],
  ]
  for (const [label, deliver] of cases) await t.test(label, async child => {
    const h = fixture(child)
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    const turn = h.startInitiative()
    const signal = new AbortController().signal
    await h.service.observeDailyInitiative(turn.sessionId, signal)
    await turn.propose({ goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north' }, signal, { accept: false })
    deliver(turn)
    await turn.complete()
    const [job] = h.jobs()
    assert.ok(['failed', 'cancelled'].includes(job.task.status))
    assert.equal(job.payload.initiative, undefined)
    assert.equal(job.payload.initiativeReceipt, undefined)
    assert.deepEqual(h.game, [])
    assert.deepEqual(h.memory(), [])
  })
})

test('an explicit result error can be followed by a new successful call and receipts cite the accepted event', async t => {
  const h = fixture(t)
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.open({ candidate: false })
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  await h.service.observeDailyInitiative(turn.sessionId, signal)
  const proposal = { goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north' }
  await assert.rejects(turn.propose(proposal, signal, { record: false }), { code: 'daily-initiative-proposal-unavailable' })
  await assert.rejects(turn.propose(proposal, signal, { name: 'daily_initiative_observe' }), { code: 'daily-initiative-proposal-unavailable' })
  await turn.propose(proposal, signal, { accept: false })
  const previousCall = turn.lastCall
  turn.result({ isError: true })
  turn.nextStep()
  await turn.propose(proposal, signal, { accept: false })
  turn.result({ callId: previousCall })
  const resultSeq = turn.result()
  assert.deepEqual(h.game, [])
  await turn.complete()
  const [job] = h.jobs()
  assert.equal(job.task.status, 'succeeded')
  assert.equal(job.payload.initiativeReceipt.eventSeq, resultSeq)
  assert.equal(h.game.length, 1)
})

test('the initiative may defer, and a plain-text JSON choice cannot launch an action', async t => {
  await t.test('defers a real authored goal', async subtest => {
    const h = fixture(subtest)
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    const turn = h.startInitiative()
    const signal = new AbortController().signal
    await h.service.observeDailyInitiative(turn.sessionId, signal)
    await turn.propose({ goal: initiativeGoal, evidenceId: 'now-1', option: 'defer' }, signal)
    await turn.complete()
    assert.equal(h.jobs()[0].task.status, 'cancelled')
    assert.equal(h.jobs()[0].payload.initiative.option, 'defer')
    assert.equal(h.game.length, 0)
    assert.equal(h.memory().length, 0)
  })
  await t.test('ignores text masquerading as an action', async subtest => {
    const h = fixture(subtest)
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    await h.respond({ decision: 'survey', direction: 'north' })
    assert.equal(h.jobs()[0].task.status, 'cancelled')
    assert.equal(h.jobs()[0].payload.initiative, undefined)
    assert.equal(h.game.length, 0)
  })
})

test('initiative tools reject a forged inbox and foreground conversation can preempt a valid proposal', async t => {
  await t.test('forged inbox', async subtest => {
    const h = fixture(subtest)
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    const turn = h.startInitiative('other-message')
    await assert.rejects(h.service.observeDailyInitiative(turn.sessionId, new AbortController().signal), { code: 'daily-initiative-authority-changed' })
    await turn.complete()
    assert.equal(h.jobs()[0].task.status, 'failed')
    assert.equal(h.game.length, 0)
  })
  await t.test('foreground takes priority', async subtest => {
    const h = fixture(subtest)
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    const turn = h.startInitiative()
    const signal = new AbortController().signal
    await h.service.observeDailyInitiative(turn.sessionId, signal)
    await turn.propose({ goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north' }, signal)
    const chat = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'fore', label: '聊天', kind: 'chat' })
    h.service.observe(chat, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    await turn.complete()
    assert.equal(h.jobs()[0].task.status, 'cancelled')
    assert.deepEqual(h.cancellations, [DAILY])
    assert.equal(h.jobs()[0].payload.initiative, undefined)
    assert.equal(h.game.length, 0)
  })
})

async function deferInitiative(h, goal = initiativeGoal) {
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  await h.service.observeDailyInitiative(turn.sessionId, signal)
  await turn.propose({ goal, evidenceId: 'now-1', option: 'defer' }, signal)
  await turn.complete()
  return h.jobs().find(job => job.payload.initiative?.goal === goal)
}

test('a legacy-shaped deferred goal survives restart, can be revised, and closes only after a fresh world receipt', async t => {
  const h = fixture(t)
  h.input.days = 3
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.open({ candidate: false })
  const old = await deferInitiative(h)
  assert.deepEqual(Object.keys(old.payload.initiative), ['goal', 'evidence', 'option'])
  await h.reopen()
  await h.wake()
  assert.equal(h.sent.length, 1)
  h.now(12, 0, 10)
  await h.wake()
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  const observation = await h.service.observeDailyInitiative(turn.sessionId, signal)
  assert.deepEqual(observation.pendingGoals, [{ id: 'goal-1', goal: initiativeGoal }])
  assert.doesNotMatch(JSON.stringify(observation), new RegExp(old.id, 'u'))
  const revised = '我想先确认北边回营的路，给以后的探索留一条退路。'
  const plan = { goal: revised, evidenceId: 'now-1', option: 'survey:north', previousId: 'goal-1' }
  await assert.rejects(turn.propose({ ...plan, evidenceId: 'goal-1' }, signal),
    { code: 'daily-initiative-proposal-invalid' })
  await assert.rejects(turn.propose({ ...plan, option: 'survey:south' }, signal),
    { code: 'daily-initiative-proposal-invalid' })
  await turn.propose(plan, signal)
  assert.equal(h.game.length, 0)
  await turn.complete()
  const finished = h.jobs().find(job => job.id !== old.id)
  assert.equal(finished.task.status, 'succeeded')
  assert.deepEqual(finished.payload.initiative, { goal: revised, option: 'survey:north', evidence: observation.evidence[0],
    previous: { taskId: old.id, goal: initiativeGoal, expiresAt: Date.parse(old.task.createdAt) + 7 * 86_400_000 } })
  assert.equal(h.game.length, 1)
  assert.ok(h.memory().some(memory => memory.content.includes('步行 5 格')))
  assert.ok(h.memory().every(memory => !memory.content.includes(revised) && !memory.content.includes(initiativeGoal)))
  h.now(12, 0, 11)
  await h.wake()
  const third = h.startInitiative()
  const next = await h.service.observeDailyInitiative(third.sessionId, signal)
  assert.equal(next.pendingGoals, undefined)
  await third.complete()
  assert.equal(h.game.length, 1)
})

test('she can abandon a pending goal when there is no available world action', async t => {
  const h = fixture(t)
  h.input.days = 3
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.open({ candidate: false })
  const old = await deferInitiative(h)
  h.now(12, 0, 10)
  h.state.ready = false
  await h.wake()
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  const observation = await h.service.observeDailyInitiative(turn.sessionId, signal)
  assert.deepEqual(observation.options.map(item => item.id), ['defer', 'abandon'])
  assert.match(observation.evidence[0].text, /没有通过检查的行动/u)
  await assert.rejects(turn.propose({ option: 'abandon', previousId: 'goal-2' }, signal),
    { code: 'daily-initiative-proposal-invalid' })
  await assert.rejects(turn.propose({ option: 'abandon', previousId: 'goal-1', goal: initiativeGoal }, signal),
    { code: 'daily-initiative-proposal-invalid' })
  await turn.propose({ option: 'abandon', previousId: 'goal-1' }, signal)
  await turn.complete()
  const closed = h.jobs().find(job => job.id !== old.id)
  assert.equal(closed.task.status, 'cancelled')
  assert.equal(closed.payload.initiative.option, 'abandon')
  assert.equal(closed.payload.initiative.previous.taskId, old.id)
  assert.equal(closed.payload.initiative.evidence, undefined)
  h.now(12, 0, 11)
  await h.wake()
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.reads, [])
  assert.deepEqual(h.memory(), [])
})

test('a renewed defer replaces one goal, retains its original expiration and never executes an action', async t => {
  const h = fixture(t)
  h.input.days = 3
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.open({ candidate: false })
  const old = await deferInitiative(h)
  h.now(12, 0, 10)
  await h.wake()
  const turn = h.startInitiative()
  const signal = new AbortController().signal
  await h.service.observeDailyInitiative(turn.sessionId, signal)
  const revised = '我想改天先看看北边的路，再决定是否出发。'
  await turn.propose({ goal: revised, evidenceId: 'now-1', option: 'defer', previousId: 'goal-1' }, signal)
  await turn.complete()
  h.now(12, 0, 11)
  await h.wake()
  const next = h.startInitiative()
  const observation = await h.service.observeDailyInitiative(next.sessionId, signal)
  assert.deepEqual(observation.pendingGoals, [{ id: 'goal-1', goal: revised }])
  await next.propose({ option: 'abandon', previousId: 'goal-1' }, signal)
  await next.complete()
  const closed = h.jobs().find(job => job.payload.initiative?.option === 'abandon')
  assert.equal(closed.payload.initiative.previous.expiresAt, Date.parse(old.task.createdAt) + 7 * 86_400_000)
  assert.equal(h.game.length, 0)
  assert.equal(h.memory().length, 0)
})

test('turn interruption, foreground preemption and unconfirmed action each leave the original goal available', async t => {
  for (const mode of ['interrupted', 'preempted', 'no-receipt']) await t.test(mode, async child => {
    const h = fixture(child)
    h.input.days = 3
    h.service.updateSettings({ dailyInitiativeEnabled: true })
    await h.open({ candidate: false })
    await deferInitiative(h)
    h.now(12, 0, 10)
    await h.wake()
    const second = h.startInitiative()
    const signal = new AbortController().signal
    await h.service.observeDailyInitiative(second.sessionId, signal)
    if (mode === 'no-receipt') h.minecraft.surveyCamp = async () => { throw new Error('world did not confirm') }
    await second.propose(mode === 'no-receipt'
      ? { goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north', previousId: 'goal-1' }
      : { option: 'abandon', previousId: 'goal-1' }, signal)
    if (mode === 'preempted') {
      const binding = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'new-owner-turn', label: 'Phone', kind: 'chat' })
      h.service.observe(binding, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    }
    await second.complete(mode === 'interrupted' ? 'interrupted' : 'completed')
    h.now(12, 0, 11)
    await h.wake()
    const third = h.startInitiative()
    const observed = await h.service.observeDailyInitiative(third.sessionId, signal)
    assert.deepEqual(observed.pendingGoals, [{ id: 'goal-1', goal: initiativeGoal,
      ...(mode === 'no-receipt' && { lastUnconfirmedWorld: 'minecraft' }) }])
    await third.complete()
    assert.equal(h.memory().length, 0)
  })
})

test('new autonomous goal with no action receipt survives restart and can use a different world the next day', async t => {
  const h = fixture(t)
  h.input.days = 3
  h.service.updateSettings({ dailyInitiativeEnabled: true })
  await h.open({ candidate: false })
  const dayOne = h.startInitiative()
  const signal = new AbortController().signal
  await h.service.observeDailyInitiative(dayOne.sessionId, signal)
  await dayOne.propose({ goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north' }, signal)
  let attempted = 0
  h.minecraft.surveyCamp = async () => {
    attempted++
    throw new Error('private diagnostics of isolated route obstacle')
  }
  await dayOne.complete()
  const first = h.jobs().find(job => job.payload.initiative?.goal === initiativeGoal)
  assert.equal(first.task.status, 'failed')
  assert.equal(first.payload.initiativeAttempt, 'minecraft')
  assert.equal(first.payload.choice, 'survey')
  assert.ok(first.payload.activityTaskId)
  assert.equal(h.memory().length, 0)
  assert.equal(attempted, 1)
  await h.reopen()
  await h.wake()
  assert.equal(attempted, 1)
  assert.equal(h.sent.length, 1)

  const candidate = h.add()
  h.now(12, 0, 10)
  h.state.ready = false
  await h.wake()
  const dayTwo = h.startInitiative()
  const snapshot = await h.service.observeDailyInitiative(dayTwo.sessionId, signal)
  assert.deepEqual(snapshot.pendingGoals, [{ id: 'goal-1', goal: initiativeGoal, lastUnconfirmedWorld: 'minecraft' }])
  assert.deepEqual(snapshot.options.map(option => option.id), ['read:1', 'defer', 'abandon'])
  assert.ok(!JSON.stringify(snapshot).includes(first.id))
  assert.ok(!JSON.stringify(snapshot).includes('private diagnostics'))
  await assert.rejects(dayTwo.propose({
    goal: initiativeGoal, evidenceId: 'now-1', option: 'survey:north', previousId: 'goal-1',
  }, signal), { code: 'daily-initiative-proposal-invalid' })
  await dayTwo.propose({
    evidenceId: 'now-1', option: 'read:1', previousId: 'goal-1',
  }, signal)
  await dayTwo.complete()
  const second = h.jobs().find(job => job.payload.initiative?.previous?.taskId === first.id)
  assert.equal(second.task.status, 'succeeded')
  assert.equal(second.payload.initiativeAttempt, 'bilibili')
  assert.equal(second.payload.initiative.goal, initiativeGoal)
  assert.equal(second.payload.initiative.previous.taskId, first.id)
  assert.equal(second.payload.initiative.previous.lastUnconfirmedWorld, undefined)
  assert.equal(h.reads.at(-1).context.candidateId, candidate.id)
  assert.equal(attempted, 1)
  assert.ok(h.memory().length > 0)
  assert.ok(h.memory().every(memory => !memory.content.includes(initiativeGoal)))

  h.now(12, 0, 11)
  await h.wake()
  assert.equal(h.sent.filter(request => request.receipt.contextId === DAILY).length, 2)
})

test('the daily window is opt-in and old rules keep the original Minecraft-only evaluation', async t => {
  const h = fixture(t)
  await h.settle()
  assert.equal(h.service.surveyWindowView().rule, null)
  const { allowBilibili: _unused, ...legacy } = h.input
  assert.equal(h.service.setSurveyWindow(legacy).rule.allowBilibili, undefined)
  h.now(12, 0)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, MINECRAFT_SUPPLY_CONTEXT)
  assert.deepEqual(h.jobs(), [])
  assert.deepEqual(h.previews, [h.zone.id])
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.reads, [])
})

test('the workbench cannot authorize reading choices on a host without Bilibili', async t => {
  const h = fixture(t, { bili: false })
  await h.settle()
  assert.equal(h.service.surveyWindowView().dailyChoiceAvailable, undefined)
  assert.throws(() => h.service.setSurveyWindow(h.input))
  assert.equal(h.service.surveyWindowView().rule, null)
})

test('one tool-free decision offers a preflight route and a queued video without leaking camp details', async t => {
  const h = fixture(t)
  const item = await h.open()
  const { receipt, prompt } = h.sent.at(-1)
  assert.equal(h.service.surveyWindowView().dailyChoiceAvailable, true)
  assert.equal(h.service.surveyWindowView().rule.allowBilibili, true)
  assert.equal(h.store.bindingByContext(receipt.contextId).kind, 'system')
  assert.deepEqual(companionToolPolicy(DAILY, 'topic').allowed, [])
  assert.equal(deviceContextAllowed(DAILY), false)
  assert.match(prompt, /north/u)
  assert.ok(prompt.includes(item.id))
  assert.ok(!prompt.includes(h.zone.id))
  assert.doesNotMatch(prompt, /Private camp label/u)
  assert.ok(!prompt.includes(CUE.text))
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.reads, [])
})

test('daily decisions honor the existing Bilibili cooldown and bound the candidate list', async t => {
  const h = fixture(t)
  h.state.ready = false
  await h.settle()
  h.service.setSurveyWindow(h.input)
  const items = [1, 2, 3, 4, 5].map(h.add)
  h.now(12, 0)
  h.store.bilibili.defer(Date.now() + 60_000)
  await h.wake()
  assert.deepEqual(h.jobs(), [])
  assert.deepEqual(h.sent, [])
  h.now(12, 1)
  await h.wake()
  assert.equal(h.sent[0].receipt.contextId, DAILY)
  const offered = items.filter(item => h.sent[0].prompt.includes(item.id))
  assert.equal(offered.length, 3)
  await h.respond({ decision: 'bilibili', candidateId: items.find(item => !offered.includes(item)).id })
  assert.equal(h.jobs()[0].task.status, 'failed')
  assert.deepEqual(h.reads, [])
})

test('a regular Bilibili review crossing into the window yields to the daily choice', async t => {
  const h = fixture(t)
  await h.settle()
  h.service.setSurveyWindow(h.input)
  h.now(11, 59)
  const item = h.add()
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_AUTONOMY_CONTEXT)
  h.now(12, 0)
  await h.respond({ decision: 'read', candidateId: item.id, subtitles: true })
  assert.deepEqual(h.reads, [])
  assert.equal(h.store.bilibili.get(item.id).status, 'queued')
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
  await h.respond({ decision: 'skip' })
  assert.equal(h.sent.length, 2)
  h.now(12, 45)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_AUTONOMY_CONTEXT)
})

test('skipping leaves the video queued and consumes the current date across revocation and restart', async t => {
  const h = fixture(t)
  const item = await h.open()
  const id = h.jobs()[0].id
  await h.respond({ decision: 'skip' })
  assert.equal(h.jobs()[0].task.status, 'cancelled')
  assert.equal(h.service.surveyWindowView().today.choice, 'skip')
  assert.equal(h.store.bilibili.get(item.id).status, 'queued')
  assert.deepEqual(h.memory(), [])
  assert.deepEqual(h.home().recent, [])
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.reads, [])
  assert.deepEqual(h.sent.map(turn => turn.receipt.contextId), [DAILY])

  h.service.revokeSurveyWindow()
  h.service.setSurveyWindow(h.input)
  await h.reopen()
  assert.deepEqual(h.jobs().map(job => job.id), [id])
  assert.equal(h.service.surveyWindowView().today.status, 'used')
  assert.equal(h.sent.length, 1)
  h.now(12, 0, 10)
  await h.wake()
  assert.equal(h.jobs().length, 2)
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
  assert.notEqual(h.sent.at(-1).receipt.sessionId, h.sent[0].receipt.sessionId)
})

test('an interrupted running decision is consumed across restart even with zero persisted attempts', async t => {
  const h = fixture(t)
  await h.settle()
  const { rule } = h.service.setSurveyWindow(h.input)
  h.add()
  h.now(12, 0)
  const interrupted = h.store.autonomy.create({
    kind: 'daily.choice', contextId: DAILY, dedupeKey: 'daily:2026-11-09', runAfter: Date.now(), maxAttempts: 1,
    payload: { windowRuleId: rule.id, date: '2026-11-09', expiresAt: Date.now() + 15 * 60_000 },
  })
  h.store.transitionTask(interrupted.id, 'running')
  assert.equal(h.store.autonomy.get(interrupted.id).attempts, 0)
  await h.reopen()
  assert.equal(h.store.taskById(interrupted.id).status, 'failed')
  assert.equal(h.service.surveyWindowView().today.status, 'used')
  assert.deepEqual(h.jobs().map(job => job.id), [interrupted.id])
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.reads, [])
})

test('restart settles a durable selected subtitle receipt without running the connector again', async t => {
  for (const durable of [false, true]) await t.test(durable ? 'receipt on disk' : 'read interrupted', async t => {
    const h = fixture(t)
    await h.settle()
    const { rule } = h.service.setSurveyWindow(h.input)
    const item = h.add()
    h.now(12, 0)
    const payload = { windowRuleId: rule.id, date: '2026-11-09', expiresAt: Date.now() + 15 * 60_000 }
    const daily = h.store.autonomy.create({
      kind: 'daily.choice', contextId: DAILY, dedupeKey: 'daily:2026-11-09', runAfter: Date.now(), maxAttempts: 1, payload,
    })
    h.store.transitionTask(daily.id, 'running')
    const child = h.store.autonomy.create({
      kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT, dedupeKey: `${daily.dedupeKey}:bilibili`, runAfter: Date.now(),
      maxAttempts: 1, payload: { candidateId: item.id, dailyTaskId: daily.id },
    })
    h.store.transitionTask(child.id, 'running')
    h.store.autonomy.update(child.id, { attempts: 1 })
    h.store.autonomy.update(daily.id, { attempts: 1, payload: { ...payload, choice: 'bilibili', activityTaskId: child.id } })
    assert.equal(h.store.bilibili.begin(item.id, Date.now() + 60 * 60_000), true)
    if (durable) h.readReceipt({ video: item.bvid, part: item.part, subtitles: true }, {
      candidateId: item.id, contextId: BILIBILI_AUTONOMY_CONTEXT, sessionId: 'before-restart',
    })
    await h.reopen()
    assert.equal(h.store.taskById(child.id).status, durable ? 'succeeded' : 'failed')
    assert.equal(h.store.taskById(daily.id).status, durable ? 'succeeded' : 'failed')
    assert.deepEqual(h.sent, [])
    assert.deepEqual(h.reads, [])
    assert.equal(h.memory().length, durable ? 1 : 0)
    await h.reopen()
    assert.equal(h.memory().length, durable ? 1 : 0)
    assert.deepEqual(h.jobs().map(job => job.id), [daily.id])
  })
})

test('changing the kind of window cannot consume a second decision that day', async t => {
  for (const dailyFirst of [false, true]) await t.test(dailyFirst ? 'daily to legacy' : 'legacy to daily', async t => {
    const h = fixture(t)
    const { allowBilibili: _unused, ...legacy } = h.input
    await h.settle()
    h.service.setSurveyWindow(dailyFirst ? h.input : legacy)
    h.now(12, 0)
    await h.wake()
    assert.equal(h.sent[0].receipt.contextId, dailyFirst ? DAILY : MINECRAFT_SUPPLY_CONTEXT)
    await h.respond({ decision: 'skip' })
    h.service.revokeSurveyWindow()
    h.service.setSurveyWindow(dailyFirst ? legacy : h.input)
    await h.wake()
    assert.equal(h.sent.length, 1)
    assert.equal(h.service.surveyWindowView().today.status, 'used')
  })
})

test('unoffered candidates, routes, extra fields, and forged model turns cannot execute or create memories', async t => {
  for (const variant of ['candidate', 'direction', 'extra field', 'wrong input', 'tool call']) await t.test(variant, async t => {
    const h = fixture(t)
    const item = await h.open()
    const selected = { decision: 'bilibili', candidateId: item.id }
    const choice = variant === 'candidate' ? { ...selected, candidateId: randomUUID() }
      : variant === 'direction' ? { decision: 'survey', direction: 'south' }
      : variant === 'extra field' ? { ...selected, url: 'https://example.invalid/' } : selected
    await h.respond(choice, { userId: variant === 'wrong input' ? 'other-user-message' : undefined, addToolCall: variant === 'tool call' })
    assert.equal(h.jobs()[0].task.status, 'failed')
    assert.equal(h.store.bilibili.get(item.id).status, 'queued')
    assert.deepEqual(h.game, [])
    assert.deepEqual(h.reads, [])
    assert.deepEqual(h.memory(), [])
  })
})

test('authoritative Bilibili subtitles reach the home history and independent phone recall', async t => {
  const h = fixture(t)
  h.state.ready = false
  const item = await h.open()
  await h.respond({ decision: 'bilibili', candidateId: item.id })
  assert.equal(h.jobs()[0].task.status, 'succeeded')
  assert.equal(h.service.surveyWindowView().today.choice, 'bilibili')
  assert.equal(h.service.surveyWindowView().today.decisionStatus, 'succeeded')
  assert.deepEqual(h.game, [])
  assert.equal(h.reads.length, 1)
  assert.deepEqual(h.reads[0].input, { video: item.bvid, part: item.part, subtitles: true })
  assert.equal(h.reads[0].context.contextId, BILIBILI_AUTONOMY_CONTEXT)
  assert.notEqual(h.reads[0].context.sessionId, h.sent[0].receipt.sessionId)
  const read = h.store.bilibili.get(item.id)
  assert.equal(read.status, 'read')
  assert.equal(read.receipt.kind, 'video.subtitle-read')
  assert.ok(h.home().recent.some(entry => entry.kind === 'video'))
  const recalled = h.store.memory.find(item.bvid, { contextId: 'chat.mobile', status: 'active' })
  assert.ok(recalled.some(note => note.sourceRefs.some(ref => ref.activityId === read.receipt.activityId)))
  assert.equal(h.store.feed.list().items.length, 0)
  assert.equal(h.store.autonomy.pending('bilibili.share', BILIBILI_SHARE_CONTEXT), undefined)
})

test('reading can publish a sourced post only through its separate sharing decision', async t => {
  const h = fixture(t, { publish: true })
  h.service.updateSettings({ feedEnabled: true, bilibiliShareEnabled: true })
  // Keep the unrelated regular-feed evaluation out of the first open-window tick.
  const routineFeed = h.store.autonomy.pending('feed.review', 'autonomy.feed')
  if (routineFeed) h.store.autonomy.update(routineFeed.id, { runAfter: Date.now() + 3600_000 })
  const item = await h.open()
  await h.respond({ decision: 'bilibili', candidateId: item.id })
  assert.equal(h.store.feed.list().items.length, 0)
  const pending = h.store.autonomy.pending('bilibili.share', BILIBILI_SHARE_CONTEXT)
  assert.ok(pending)
  h.advance(pending.runAfter)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_SHARE_CONTEXT)
  await h.respond({ decision: 'share', observation: '我想留意熟悉地方在黄昏时的变化。', cueIndex: 0 })
  const post = h.store.feed.bySourceTask(pending.id)
  assert.deepEqual(post.bilibiliSource, { bvid: item.bvid, part: item.part, startSeconds: 5 })
  assert.ok(!post.body.includes(CUE.text))
})

test('straight and turning expeditions preserve verified Worker receipts for the home and phone', async t => {
  for (const turning of [false, true]) await t.test(turning ? 'turning' : 'straight', async t => {
    const h = fixture(t)
    await h.open({ candidate: false })
    await h.respond(turning ? { decision: 'trail', trail: 'north-east' } : { decision: 'survey', direction: 'north' })
    assert.equal(h.jobs()[0].task.status, 'succeeded')
    const { today } = h.service.surveyWindowView()
    assert.equal(today.choice, 'survey')
    assert.equal(today.decisionStatus, 'succeeded')
    const task = h.store.autonomy.get(today.taskId)
    assert.equal(task.kind, 'minecraft.supply')
    assert.equal(task.task.status, 'succeeded')
    assert.equal(task.payload.surveyOutcome, 'completed')
    assert.deepEqual(h.game, [turning ? { zoneId: h.zone.id, trail: 'north-east' } : { zoneId: h.zone.id, direction: 'north', steps: 5 }])
    assert.deepEqual(h.reads, [])
    assert.ok(h.home().recent.some(entry => entry.kind === 'return'))
    assert.deepEqual(projectCommunity('idle', h.store).recentCamp[0].route, turning
      ? { kind: 'trail', trail: 'north-east', checkpoints: 2 }
      : { kind: 'straight', direction: 'north', steps: 5 })
    const recalled = h.store.memory.find('Coopcraft', { contextId: 'chat.mobile', status: 'active' })
    assert.ok(recalled.some(note => note.sourceRefs.some(ref => ref.taskId === task.payload.receiptTaskId)))
    assert.equal(h.store.feed.list().items.length, 0)
  })
})

test('a confirmed daily expedition can use the separate Minecraft sharing policy', async t => {
  const h = fixture(t, { publish: true })
  h.service.updateSettings({ feedEnabled: true, minecraftShareEnabled: true })
  const routineFeed = h.store.autonomy.pending('feed.review', 'autonomy.feed')
  if (routineFeed) h.store.autonomy.update(routineFeed.id, { runAfter: Date.now() + 3600_000 })
  await h.open({ candidate: false })
  await h.respond({ decision: 'survey', direction: 'north' })
  assert.equal(h.store.feed.list().items.length, 0)
  const pending = h.store.autonomy.pending('minecraft.share', MINECRAFT_SHARE_CONTEXT)
  assert.ok(pending)
  h.advance(pending.runAfter)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, MINECRAFT_SHARE_CONTEXT)
  await h.respond({ decision: 'publish', reflection: '我想下次也看看不同方向的风景。' })
  const post = h.store.feed.bySourceTask(pending.payload.taskId)
  assert.match(post.body, /向北步行 5 格探索/u)
  assert.match(post.body, /我想下次也看看不同方向的风景/u)
  assert.equal(h.store.feed.list().items.length, 1)
})

test('no eligible action waits without spending the daily model budget', async t => {
  const h = fixture(t)
  h.state.ready = false
  await h.settle()
  h.service.setSurveyWindow(h.input)
  h.now(12, 0)
  await h.wake()
  assert.deepEqual(h.jobs(), [])
  assert.deepEqual(h.sent, [])
  h.add()
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
})

test('a withdrawn candidate or changed game readiness cannot be selected from a stale decision', async t => {
  for (const kind of ['bilibili', 'minecraft']) await t.test(kind, async t => {
    const h = fixture(t)
    const item = await h.open()
    if (kind === 'bilibili') {
      assert.equal(h.store.bilibili.cancel(item.id), true)
      h.service.cancelBilibili(item.id)
    } else h.state.ready = false
    await h.respond(kind === 'bilibili' ? { decision: 'bilibili', candidateId: item.id } : { decision: 'survey', direction: 'north' })
    assert.ok(['cancelled', 'failed'].includes(h.jobs()[0].task.status))
    assert.deepEqual(h.game, [])
    assert.deepEqual(h.reads, [])
    assert.deepEqual(h.memory(), [])
  })
})

test('re-enabling Bilibili does not revive a selected read cancelled during session setup', async t => {
  const h = fixture(t)
  const item = await h.open()
  const wait = Promise.withResolvers()
  const create = h.sessions.create
  let openingReader = false
  h.sessions.create = async input => {
    if (input.contextId === BILIBILI_AUTONOMY_CONTEXT) {
      openingReader = true
      await wait.promise
    }
    return create(input)
  }
  await h.respond({ decision: 'bilibili', candidateId: item.id })
  try {
    assert.equal(openingReader, true)
    assert.equal(h.jobs()[0].task.status, 'running')
    h.service.updateSettings({ bilibiliEnabled: false })
    h.service.updateSettings({ bilibiliEnabled: true })
  } finally { wait.resolve() }
  await h.settle()
  assert.equal(h.jobs()[0].task.status, 'cancelled')
  assert.equal(h.store.bilibili.get(item.id).status, 'queued')
  assert.deepEqual(h.reads, [])
  assert.deepEqual(h.game, [])
  assert.deepEqual(h.memory(), [])
})

test('revocation, today suppression, global pause and quiet hours invalidate in-flight model choices', async t => {
  for (const condition of ['revoke', 'suppress', 'global pause', 'quiet']) await t.test(condition, async t => {
    const h = fixture(t)
    await h.open()
    if (condition === 'revoke') h.service.revokeSurveyWindow()
    else if (condition === 'suppress') h.service.stopMinecraftSurveyWindowForToday()
    else if (condition === 'global pause') h.service.updateSettings({ enabled: false })
    else h.service.updateSettings({ quietStart: '11:30', quietEnd: '12:30' })
    await h.respond({ decision: 'survey', direction: 'north' })
    assert.equal(h.jobs()[0].task.status, 'cancelled')
    assert.ok(h.cancellations.includes(DAILY))
    assert.deepEqual(h.game, [])
    assert.deepEqual(h.reads, [])
    assert.deepEqual(h.memory(), [])
  })
})

test('a mismatched game or subtitle receipt does not create a confirmed experience', async t => {
  for (const kind of ['game', 'subtitle']) await t.test(kind, async t => {
    const h = fixture(t)
    const item = await h.open()
    if (kind === 'game') {
      const actual = h.minecraft.surveyCamp
      h.minecraft.surveyCamp = async (...args) => {
        const receipt = await actual(...args)
        return { ...receipt, result: { ...receipt.result, direction: 'east' } }
      }
    } else h.mockRead((input, context) => ({ ...h.readReceipt(input, context), bvid: 'BV1234567890' }))
    await h.respond(kind === 'game' ? { decision: 'survey', direction: 'north' } : { decision: 'bilibili', candidateId: item.id })
    assert.ok(['failed', 'cancelled'].includes(h.jobs()[0].task.status))
    assert.deepEqual(projectCommunity('idle', h.store).recentCamp, [])
    assert.deepEqual(h.memory(), [])
    assert.equal(h.store.feed.list().items.length, 0)
  })
})

test('public video metadata alone never confirms the selected reading', async t => {
  const h = fixture(t, { publish: true })
  const item = await h.open()
  h.mockRead((input, context) => {
    const at = new Date().toISOString()
    const kind = 'video.inspected'
    const activityId = h.store.recordActivity({
      contextId: context.contextId, sessionId: context.sessionId, source: 'media.bilibili', kind,
      status: 'success', occurredAt: at, summary: '公开资料回执',
      data: { bvid: input.video, part: input.part, candidateId: context.candidateId },
    })
    return { bvid: input.video, part: input.part, subtitle: { status: 'unavailable' }, receipt: { activityId, at, kind } }
  })
  await h.respond({ decision: 'bilibili', candidateId: item.id })
  assert.ok(['failed', 'cancelled'].includes(h.jobs()[0].task.status))
  assert.deepEqual(h.home().recent, [])
  assert.deepEqual(h.memory(), [])
  assert.equal(h.store.feed.list().items.length, 0)
})

test('revocation while the selected provider is running aborts the signal and discards a late receipt', async t => {
  for (const kind of ['survey', 'bilibili']) await t.test(kind, async t => {
    const h = fixture(t)
    const item = await h.open()
    const wait = Promise.withResolvers()
    let signal
    if (kind === 'survey') {
      const perform = h.minecraft.surveyCamp
      h.minecraft.surveyCamp = async (zoneId, direction, liveSignal, steps) => {
        signal = liveSignal
        await wait.promise
        return perform(zoneId, direction, new AbortController().signal, steps)
      }
    } else h.mockRead(async (_input, _context, liveSignal) => {
      signal = liveSignal
      await wait.promise
      throw new Error('Provider callback completed after cancellation')
    })
    await h.respond(kind === 'survey' ? { decision: 'survey', direction: 'north' } : { decision: 'bilibili', candidateId: item.id })
    try {
      assert.ok(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      h.service.revokeSurveyWindow()
      assert.equal(signal.aborted, true)
    } finally { wait.resolve() }
    await h.settle()
    assert.equal(h.jobs()[0].task.status, 'cancelled')
    assert.deepEqual(h.memory(), [])
    assert.deepEqual(projectCommunity('idle', h.store).recentCamp, [])
    assert.equal(h.store.feed.list().items.length, 0)
  })
})

const OBSERVATION = '我更愿意先核对前路，再决定是否继续探索。'
const NOTE = { decision: 'note', observation: OBSERVATION, trait: 'check-evidence' }

function reflectionJobs(h) {
  return h.store.autonomy.list().filter(job => job.kind === 'daily.reflect')
}

async function reflectSurvey(h) {
  h.service.updateSettings({ dailyReflectionEnabled: true })
  await h.open({ candidate: false })
  await h.respond({ decision: 'survey', direction: 'north' })
  const [job] = reflectionJobs(h)
  assert.equal(job?.task.status, 'accepted')
  return job
}

test('daily reflection is opt-in and depends on the memory-review permission', async t => {
  for (const settings of [{}, { dailyReflectionEnabled: true, memoryReview: false }]) await t.test(JSON.stringify(settings), async t => {
    const h = fixture(t)
    h.service.updateSettings(settings)
    await h.open({ candidate: false })
    await h.respond({ decision: 'survey', direction: 'north' })
    assert.equal(h.jobs()[0].task.status, 'succeeded')
    assert.deepEqual(reflectionJobs(h), [])
    assert.deepEqual(h.store.selfNotes.list(), [])
  })
})

test('daily reflection waits thirty minutes after the receipt and the latest foreground conversation', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  assert.equal(job.runAfter, Date.now() + 30 * 60_000)
  h.now(12, 20)
  h.store.recordActivity({ contextId: 'chat.mobile', sessionId: 'mobile-main', source: 'core.chat', kind: 'message.accepted', summary: 'Private foreground message' })
  h.now(12, 29)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
  h.now(12, 30)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
  assert.equal(h.store.autonomy.get(job.id).runAfter, Date.now() + 20 * 60_000)
  h.now(12, 50)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
  assert.ok(!h.sent.at(-1).prompt.includes('Private foreground message'))
})

test('quiet hours and another live activity defer a queued reflection, and its source expires after 48 hours', async t => {
  await t.test('quiet until 13:00', async t => {
    const h = fixture(t)
    const job = await reflectSurvey(h)
    h.service.updateSettings({ quietStart: '12:25', quietEnd: '13:00' })
    h.now(12, 30)
    await h.wake()
    assert.equal(h.store.autonomy.get(job.id).runAfter, Date.now() + 30 * 60_000)
    h.now(13, 0)
    await h.wake()
    assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
  })
  await t.test('foreground busy probe', async t => {
    const h = fixture(t)
    const job = await reflectSurvey(h)
    h.state.foregroundBusy = true
    h.advance(job.runAfter)
    await h.wake()
    assert.equal(h.store.autonomy.get(job.id).runAfter, Date.now() + 15_000)
    assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
    h.state.foregroundBusy = false
    h.advance(Date.now() + 15_000)
    await h.wake()
    assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
  })
  await t.test('expired work never starts a model turn', async t => {
    const h = fixture(t)
    const job = await reflectSurvey(h)
    assert.equal(job.payload.expiresAt, Date.now() + 48 * 60 * 60_000)
    h.advance(job.payload.expiresAt)
    await h.wake()
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 0)
  })
})

test('a new chat, owner pause or quiet interval cancels an in-flight reflection without saving its late output', async t => {
  for (const condition of ['foreground turn', 'feature off', 'memory review off', 'global pause', 'quiet change']) await t.test(condition, async t => {
    const h = fixture(t)
    const job = await reflectSurvey(h)
    h.advance(job.runAfter)
    await h.wake()
    assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
    if (condition === 'foreground turn') {
      const binding = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'mobile-new', kind: 'chat', label: 'Mobile' })
      h.service.observe(binding, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    } else if (condition === 'feature off') h.service.updateSettings({ dailyReflectionEnabled: false })
    else if (condition === 'memory review off') h.service.updateSettings({ memoryReview: false })
    else if (condition === 'global pause') h.service.updateSettings({ enabled: false })
    else h.service.updateSettings({ quietStart: '12:20', quietEnd: '13:00' })
    await h.respond(NOTE)
    assert.ok(h.cancellations.includes(DAILY_REFLECTION_CONTEXT))
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.deepEqual(h.store.selfNotes.list(), [])
  })
})

test('pausing and reenabling while session send is pending cannot start a stale model request', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  const waiting = Promise.withResolvers()
  const release = Promise.withResolvers()
  const send = h.sessions.send
  h.sessions.send = async (contextId, prompt, origin, voiceReply, upload, assertAuthorized) => {
    if (contextId === DAILY_REFLECTION_CONTEXT) {
      waiting.resolve(assertAuthorized)
      await release.promise
      assertAuthorized?.()
    }
    return send(contextId, prompt, origin, voiceReply, upload)
  }
  h.advance(job.runAfter)
  await h.wake()
  try {
    assert.equal(typeof await waiting.promise, 'function')
    h.service.updateSettings({ dailyReflectionEnabled: false })
    h.service.updateSettings({ dailyReflectionEnabled: true })
  } finally { release.resolve() }
  await h.settle()
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 0)
  assert.deepEqual(h.store.selfNotes.list(), [])
})

test('the daily window can complete a chosen short clip and reflect on the verified receipt', async t => {
  for (const mode of ['audio', 'visual', 'both']) await t.test(mode, async t => {
    const initiative = mode !== 'audio'
    const h = fixture(t, { clip: true, vision: initiative, publish: true })
    h.service.updateSettings({ dailyReflectionEnabled: true, bilibiliClipsEnabled: true, dailyInitiativeEnabled: initiative })
    const item = await h.open()
    const clip = { ...SAMPLE, mode }
    if (initiative) {
      const turn = h.startInitiative()
      const signal = new AbortController().signal
      const observation = await h.service.observeDailyInitiative(turn.sessionId, signal)
      const option = observation.options.find(item => item.id === 'clip:1')
      assert.deepEqual(option.clipModes, ['visual', 'audio', 'both'])
      assert.ok(observation.options.some(item => item.id === 'read:1'))
      const goal = { goal: '我想看看这段视频里有趣的一小段。', evidenceId: observation.evidence[0].id, option: option.id }
      await assert.rejects(turn.propose(goal, signal), { code: 'daily-initiative-proposal-invalid' })
      await turn.propose({ ...goal, clip }, signal)
      await turn.complete()
    } else {
      assert.match(h.sent[0].prompt, /"clip":\{"start":0,"seconds":6,"mode":"audio"\}/u)
      await h.respond({ decision: 'bilibili', candidateId: item.id, clip })
    }
    assert.deepEqual(h.clipInputs.map(value => value.input), [{ bvid: item.bvid, part: item.part, ...clip }])
    assert.equal(h.clipInputs[0].vision, mode !== 'audio')
    assert.equal(h.clips[0].prompt.includes(PRIVATE_CLIP), mode !== 'visual')
    assert.equal(h.jobs()[0].task.status, 'running')
    assert.equal(h.store.bilibili.get(item.id).status, 'reading')
    assert.equal(reflectionJobs(h).length, 0)
    assert.equal(h.store.bilibili.canBeginClip(), false)
    await h.reviewClip()
    const [daily] = h.jobs()
    const child = h.store.autonomy.get(daily.payload.activityTaskId)
    const receipt = h.store.bilibili.get(item.id).receipt
    assert.deepEqual(receipt.clip, { start: 12, seconds: 6, audio: mode !== 'visual', visual: mode !== 'audio' })
    assert.equal(receipt.kind, 'video.clip-sampled')
    assert.equal(h.store.activityById(receipt.activityId).taskId, child.id)
    assert.equal(daily.task.status, 'succeeded')
    assert.equal(child.task.status, 'succeeded')
    if (initiative) assert.deepEqual(daily.payload.initiative.clip, clip)
    assert.equal(h.reads.length, 0)
    assert.equal(h.game.length, 0)
    assert.ok(h.home().recent.some(item => item.video?.mode === 'clip'))
    assert.match(h.memory()[0].content, /第 12 秒开始的 6 秒/u)
    assert.equal(h.store.feed.list().items.length, 0)
    assert.doesNotMatch(JSON.stringify([h.memory(), h.home(), h.service.view()]), /隔离片段转写|隔离模型观察/u)
    const proof = verifiedDailyReflectionSource(h.store, daily.id)
    assert.equal(proof.material, 'clip')
    assert.equal(proof.experience.activityId, receipt.activityId)
    const { evidence } = recentDailyInitiativeEvidence(h.store, Date.now())
    assert.deepEqual(evidence, [{ id: 'recent-1', kind: 'experience', text: '曾抽样理解一个经核验的 B 站短片段。' }])
    const [reflection] = reflectionJobs(h)
    h.advance(reflection.runAfter)
    await h.wake()
    assert.match(h.sent.at(-1).prompt, /从第 12 秒抽样 6 秒/u)
    assert.doesNotMatch(h.sent.at(-1).prompt, /隔离片段转写|隔离模型观察/u)
    await h.respond(NOTE)
    const note = h.store.selfNotes.byDailyExperience(daily.id)
    assert.equal(note?.experienceReceipt.fact, proof.fact)
    await h.reopen()
    assert.equal(h.store.selfNotes.byDailyExperience(daily.id)?.id, note.id)
    assert.equal(h.clipInputs.length, 1)
  })
})

test('a daily clip needs permission at dispatch and completion', async t => {
  for (const name of ['disabled', 'unsupported mode', 'over-length', 'other candidate', 'foreground busy', 'revoke before dispatch',
    'provider loses capability', 'disable during review', 'revoke during review', 'foreground during review',
    'window expires', 'incomplete review', 'mismatched review']) await t.test(name, async t => {
    const h = fixture(t, { clip: name !== 'provider loses capability' })
    h.service.updateSettings({ dailyReflectionEnabled: true, bilibiliClipsEnabled: name !== 'disabled' })
    const candidate = await h.open()
    if (name === 'foreground busy') h.state.foregroundBusy = true
    if (name === 'revoke before dispatch') h.service.updateSettings({ bilibiliClipsEnabled: false })
    if (name === 'provider loses capability') assert.doesNotMatch(h.sent[0].prompt, /"clip"/u)
    const clip = { ...SAMPLE, ...(name === 'unsupported mode' && { mode: 'both' }), ...(name === 'over-length' && { seconds: 9 }) }
    await h.respond({ decision: 'bilibili', candidateId: name === 'other candidate' ? randomUUID() : candidate.id, clip })
    if (h.clips.length) {
      assert.equal(h.jobs()[0].task.status, 'running')
      if (name === 'disable during review') h.service.updateSettings({ bilibiliClipsEnabled: false })
      else if (name === 'revoke during review') h.service.revokeSurveyWindow()
      else if (name === 'foreground during review') {
        const binding = h.store.bindContext({ contextId: 'chat.mobile', kind: 'chat', label: 'phone', sessionId: 'phone-fixture' })
        h.service.observe(binding, { type: 'turn/start', data: { turn: 1 } })
      } else if (name === 'window expires') h.now(12, 45)
      await h.reviewClip({ completed: name !== 'incomplete review', matching: name !== 'mismatched review' })
      assert.equal(h.store.bilibili.canBeginClip(), false)
    } else {
      assert.equal(h.clipInputs.length, 0)
      assert.equal(h.store.bilibili.canBeginClip(), true)
      assert.equal(h.store.bilibili.get(candidate.id).status, 'queued')
    }
    assert.ok(['failed', 'cancelled'].includes(h.jobs()[0].task.status))
    assert.equal(h.reads.length, 0)
    assert.equal(h.memory().length, 0)
    assert.equal(reflectionJobs(h).length, 0)
    assert.ok(!h.store.activities().some(activity => activity.kind === 'video.clip-sampled'))
  })
})

test('cold restart settles only the exact durable daily clip without sampling it again', async t => {
  for (const name of ['confirmed', 'interrupted', 'foreign request', 'late receipt', 'relabelled as subtitle', 'wrong modality']) await t.test(name, async t => {
    const h = fixture(t, { clip: true })
    await h.settle()
    const { rule } = h.service.setSurveyWindow(h.input)
    const item = h.add()
    h.now(12, 0)
    const deadline = Date.now() + 45_000
    const payload = { windowRuleId: rule.id, date: '2026-11-09', expiresAt: deadline }
    const daily = h.store.autonomy.create({ kind: 'daily.choice', contextId: DAILY, dedupeKey: 'daily:2026-11-09',
      runAfter: Date.now(), maxAttempts: 1, payload })
    h.store.transitionTask(daily.id, 'running')
    const clipRequest = { ...SAMPLE, deadline, ...(name === 'wrong modality' && { mode: 'visual' }) }
    const child = h.store.autonomy.create({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT,
      dedupeKey: `${daily.dedupeKey}:bilibili`, runAfter: Date.now(), maxAttempts: 1, payload: { candidateId: item.id, dailyTaskId: daily.id, clipRequest } })
    h.store.transitionTask(child.id, 'running')
    h.store.autonomy.update(child.id, { attempts: 1 })
    h.store.autonomy.update(daily.id, { attempts: 1, payload: { ...payload, choice: 'bilibili', activityTaskId: child.id } })
    assert.equal(h.store.bilibili.beginClip(item.id, Date.now() + 60 * 60_000), true)
    if (name !== 'interrupted') {
      if (name === 'late receipt') h.advance(deadline)
      const clip = { start: name === 'foreign request' ? 10 : 12, seconds: 6, visual: false, audio: true }
      const at = new Date().toISOString()
      const kind = 'video.clip-sampled'
      const activityId = h.store.recordActivity({ contextId: BILIBILI_CLIP_CONTEXT, sessionId: 'clip-before-restart', taskId: child.id,
        source: 'media.bilibili', kind, status: 'success', occurredAt: at, summary: 'short clip', data: { candidateId: item.id, bvid: item.bvid, part: item.part, ...clip } })
      const recorded = h.store.bilibili.finish(item.id, { status: 'read', receipt: { activityId, at, kind, clip } })
      assert.equal(recorded, !['foreign request', 'wrong modality'].includes(name))
      if (recorded) {
        h.store.autonomy.update(child.id, { payload: { ...child.payload, activityId, ...(name === 'relabelled as subtitle' && { clipRequest: null }) } })
        h.store.transitionTask(child.id, 'succeeded')
      }
    }
    await h.reopen()
    assert.equal(h.store.taskById(daily.id).status, name === 'confirmed' ? 'succeeded' : 'failed')
    assert.equal(verifiedDailyReflectionSource(h.store, daily.id)?.material, name === 'confirmed' ? 'clip' : undefined)
    assert.equal(h.clipInputs.length, 0)
    assert.equal(h.reads.length, 0)
    assert.equal(h.store.bilibili.canBeginClip(), false)
  })
})

test('both worlds save an optional private observation with exact receipt and assistant message provenance', async t => {
  for (const kind of ['survey', 'bilibili']) await t.test(kind, async t => {
    const h = fixture(t)
    h.service.updateSettings({ dailyReflectionEnabled: true })
    const item = await h.open({ candidate: kind === 'bilibili' })
    const { name, tagline, description } = h.store.persona()
    const persona = h.store.savePersona({ name, tagline, description })
    await h.respond(kind === 'survey' ? { decision: 'survey', direction: 'north' } : { decision: 'bilibili', candidateId: item.id })
    const [job] = reflectionJobs(h)
    const [daily] = h.jobs()
    const child = h.store.autonomy.get(daily.payload.activityTaskId)
    h.advance(job.runAfter)
    await h.wake()
    const review = h.sent.at(-1)
    assert.equal(review.receipt.contextId, DAILY_REFLECTION_CONTEXT)
    assert.notEqual(review.receipt.sessionId, h.sent[0].receipt.sessionId)
    assert.ok(!review.prompt.includes(CUE.text) && !review.prompt.includes('Private camp label') && !review.prompt.includes('待选视频'))
    assert.match(review.prompt, kind === 'survey' ? /向北步行 5 格/u : /B 站视频的字幕摘录/u)
    assert.doesNotMatch(review.prompt, /BV[A-Za-z0-9]{10}/u)
    await h.respond(NOTE)
    const note = h.store.selfNotes.byDailyExperience(daily.id)
    assert.equal(h.store.autonomy.get(job.id).task.status, 'succeeded')
    assert.equal(note?.content, OBSERVATION)
    assert.equal(note.basis, 'inference')
    assert.equal(note.createdBy, 'companion')
    assert.deepEqual(note.experience, { kind, dailyTaskId: daily.id, activityTaskId: child.id,
      ...(kind === 'survey' ? { receiptTaskId: child.payload.receiptTaskId } : { activityId: child.payload.activityId }) })
    assert.deepEqual(note.evidenceRefs, [{ quoteIndex: 0, messageId: 'daily-assistant-2', role: 'assistant' }])
    assert.deepEqual(note.sourceRefs, [{ contextId: DAILY_REFLECTION_CONTEXT, sessionId: review.receipt.sessionId, taskId: job.id, eventSeq: 23 }])
    assert.deepEqual(h.store.persona(), persona)
    assert.equal(h.store.feed.list().items.length, 0)
    await h.reopen()
    await h.wake()
    assert.equal(h.store.selfNotes.byDailyExperience(daily.id)?.id, note.id)
    assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 1)
  })
})

test('a voluntary skip spends the reflection opportunity without creating a note', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  h.advance(job.runAfter)
  await h.wake()
  await h.respond({ decision: 'skip' })
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.deepEqual(h.store.selfNotes.list(), [])
  await h.reopen()
  await h.wake()
  assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 1)
})

test('daily reflection refuses untrusted output, unsupported references and changed session bindings', async t => {
  const cases = [
    ['wrong trigger message', NOTE, { userId: 'unrelated-user' }],
    ['missing assistant message ID', NOTE, { omitMessageId: true }],
    ['tool call', NOTE, { addToolCall: true }],
    ['duplicate assistant output', NOTE, { duplicateOutput: true }],
    ['replacement event', NOTE, { surfaceOp: 'replace' }],
    ['unoffered predecessor', { ...NOTE, supersedes: randomUUID(), revisionReason: '我看到新的回执，改变了以前的判断。' }, {}],
    ['untrusted receipt override', { ...NOTE, activityId: 99 }, {}],
    ['rebound session', NOTE, {}],
  ]
  for (const [name, result, options] of cases) await t.test(name, async t => {
    const h = fixture(t)
    const job = await reflectSurvey(h)
    h.advance(job.runAfter)
    await h.wake()
    if (name === 'rebound session') {
      options.sourceBinding = h.store.bindingByContext(DAILY_REFLECTION_CONTEXT)
      h.store.bindContext({ ...options.sourceBinding, sessionId: 'changed-review-session' })
    }
    await h.respond(result, options)
    assert.ok(['failed', 'cancelled'].includes(h.store.autonomy.get(job.id).task.status))
    assert.deepEqual(h.store.selfNotes.list(), [])
  })
})

test('removing the exact attached Bilibili subtitle after dispatch blocks a late self-note', async t => {
  const h = fixture(t)
  h.service.updateSettings({ dailyReflectionEnabled: true })
  const item = await h.open()
  const provenance = { kind: 'owner-supplied', sha256: 'a'.repeat(64) }
  assert.ok(h.store.bilibiliSubtitles.save({ bvid: item.bvid, part: item.part, cid: 1, format: 'vtt', sha256: provenance.sha256, cueCount: 1,
    excerpt: { status: 'excerpt', language: 'zh', cues: [CUE], truncated: false, provenance } }))
  h.mockRead((input, context) => h.readReceipt(input, context, provenance))
  await h.respond({ decision: 'bilibili', candidateId: item.id })
  const [job] = reflectionJobs(h)
  h.advance(job.runAfter)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
  assert.equal(h.store.bilibiliSubtitles.remove(item.bvid, item.part), true)
  await h.respond(NOTE)
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.deepEqual(h.store.selfNotes.list(), [])
})

test('a removed attachment cannot revive a queued or dispatched reflection when the identical file is reattached', async t => {
  for (const running of [false, true]) await t.test(running ? 'dispatched' : 'queued', async t => {
    const h = fixture(t)
    h.service.updateSettings({ dailyReflectionEnabled: true })
    const item = await h.open()
    const provenance = { kind: 'owner-supplied', sha256: 'a'.repeat(64) }
    const attachment = { bvid: item.bvid, part: item.part, cid: 1, format: 'vtt', sha256: provenance.sha256, cueCount: 1,
      excerpt: { status: 'excerpt', language: 'zh', cues: [CUE], truncated: false, provenance } }
    assert.ok(h.store.bilibiliSubtitles.save(attachment))
    h.mockRead((input, context) => h.readReceipt(input, context, provenance))
    await h.respond({ decision: 'bilibili', candidateId: item.id })
    const [job] = reflectionJobs(h)
    if (running) {
      h.advance(job.runAfter)
      await h.wake()
      assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
    }
    assert.equal(h.store.bilibiliSubtitles.remove(item.bvid, item.part), true)
    h.service.bilibiliSubtitleChanged(item.bvid, item.part)
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.ok(h.store.bilibiliSubtitles.save(attachment))
    h.service.bilibiliSubtitleChanged(item.bvid, item.part)
    if (running) await h.respond(NOTE)
    else {
      h.advance(job.runAfter)
      await h.wake()
      assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
    }
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.deepEqual(h.store.selfNotes.list(), [])
  })
})

test('a later confirmed experience can revise an offered observation and archive its predecessor', async t => {
  const h = fixture(t)
  const firstJob = await reflectSurvey(h)
  h.advance(firstJob.runAfter)
  await h.wake()
  await h.respond(NOTE)
  const first = h.store.selfNotes.byDailyExperience(firstJob.payload.dailyTaskId)
  assert.ok(first)
  h.now(12, 0, 10)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY)
  await h.respond({ decision: 'trail', trail: 'north-east' })
  const secondJob = reflectionJobs(h).find(job => job.id !== firstJob.id)
  h.advance(secondJob.runAfter)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
  assert.ok(h.sent.at(-1).prompt.includes(first.id))
  assert.ok(h.sent.at(-1).prompt.includes(first.experienceReceipt.fact))
  assert.equal(h.service.homeReflection(), undefined)
  const revisionReason = '我过去只留意直路，这次转弯后的回程让我明白也要检查拐角。'
  await h.respond({ ...NOTE, supersedes: first.id, observation: '我现在会在转弯处也停下来检查回去的路。', revisionReason }, {
    afterClaim: () => assert.equal(h.service.homeReflection(), new Date().toISOString()),
  })
  assert.equal(h.service.homeReflection(), undefined)
  const second = h.store.selfNotes.byDailyExperience(secondJob.payload.dailyTaskId)
  assert.equal(second?.supersedes, first.id)
  assert.equal(second.revisionReason, revisionReason)
  assert.deepEqual(second.evidence, [second.content, revisionReason])
  assert.deepEqual(second.evidenceRefs.map(ref => ref.messageId), [second.evidenceRefs[0].messageId, second.evidenceRefs[0].messageId])
  assert.ok(Date.parse(second.experienceReceipt.at) > Date.parse(first.experienceReceipt.at))
  assert.equal(h.store.selfNotes.get(first.id).status, 'archived')
  assert.equal(h.store.selfNotes.list().length, 1)
  assert.equal(h.store.selfNotes.revisions(first.id)[0].snapshot.experience.dailyTaskId, firstJob.payload.dailyTaskId)
})

test('an unchanged observation does not create a second note after another experience', async t => {
  const h = fixture(t)
  const first = await reflectSurvey(h)
  h.advance(first.runAfter)
  await h.wake()
  await h.respond(NOTE)
  const original = h.store.selfNotes.byDailyExperience(first.payload.dailyTaskId)
  h.now(12, 0, 10)
  await h.wake()
  await h.respond({ decision: 'trail', trail: 'north-east' })
  const later = reflectionJobs(h).find(job => job.id !== first.id)
  h.advance(later.runAfter)
  await h.wake()
  await h.respond({ ...NOTE, observation: OBSERVATION.replace('。', '！') })
  assert.equal(h.store.autonomy.get(later.id).task.status, 'cancelled')
  assert.deepEqual(h.store.selfNotes.list().map(note => note.id), [original.id])
  assert.equal(h.store.selfNotes.revisions(original.id).length, 1)
})

test('a mismatched admitted message never appears as active reflection at home', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  h.advance(job.runAfter)
  await h.wake()
  await h.respond(NOTE, { userId: 'another-message', afterClaim: () => assert.equal(h.service.homeReflection(), undefined) })
  assert.equal(h.store.autonomy.get(job.id).task.status, 'failed')
  assert.deepEqual(h.store.selfNotes.list(), [])
})

test('a previously accepted reflection revalidates and fills its missing receipt before dispatch', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  const { sourceReceipt, ...legacy } = job.payload
  assert.ok(sourceReceipt)
  h.store.autonomy.update(job.id, { payload: legacy })
  h.advance(job.runAfter)
  await h.wake()
  assert.deepEqual(h.store.autonomy.get(job.id).payload.sourceReceipt, sourceReceipt)
  await h.respond(NOTE)
  assert.deepEqual(h.store.selfNotes.byDailyExperience(legacy.dailyTaskId).experienceReceipt, sourceReceipt)
  assert.deepEqual(h.store.autonomy.get(job.id).payload.sourceReceipt, sourceReceipt)
})

test('host startup drops an interrupted reflection without dispatching another model turn', async t => {
  const h = fixture(t)
  const job = await reflectSurvey(h)
  h.store.transitionTask(job.id, 'running')
  h.advance(job.runAfter)
  await h.reopen()
  await h.wake()
  assert.equal(h.store.autonomy.get(job.id).task.status, 'failed')
  assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 0)
  assert.deepEqual(h.store.selfNotes.list(), [])
})

function completedHouse(store, zoneId, { placed = 1 } = {}) {
  const draft = store.minecraftHouses.create({ zoneId, name: '测试草案私有名称', layout: { width: 1, height: 1, depth: 1, blocks: 'o' } },
    { sessionId: 'fixture-owner', messageId: randomUUID(), reference: { contextId: 'chat.mobile', messageId: 'private-message', attachmentId: 'private-png' } })
  const task = store.createTask({ contextId: 'game.minecraft', capabilityId: 'minecraft.house', title: 'Minecraft：小屋建造' })
  assert.equal(store.minecraftHouses.start(draft.id, zoneId, task.id), true)
  store.transitionTask(task.id, 'running')
  store.minecraftHouses.finish(draft.id, task.id, { built: true, zoneId, checked: 1, placed, consumed: placed ? { oak_planks: placed } : {} })
  store.transitionTask(task.id, 'succeeded')
  store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'world.house-built', taskId: task.id,
    summary: `在主人授权地块按蓝图搭完小屋，核对 1 处位置，本次放置 ${placed} 块。`, status: 'success' })
  return { kind: 'house', taskId: task.id, draftId: draft.id }
}

test('a completed house queues one private reflection after both permissions and keeps the authored note across restart', async t => {
  const h = fixture(t)
  h.service.updateSettings({ dailyReflectionEnabled: true })
  const experience = completedHouse(h.store, h.zone.id)
  completedHouse(h.store, h.zone.id, { placed: 0 })
  await h.wake()
  assert.deepEqual(reflectionJobs(h), [])
  h.service.updateSettings({ minecraftMilestonesEnabled: true, memoryReview: false })
  await h.wake()
  assert.deepEqual(reflectionJobs(h), [])
  h.service.updateSettings({ memoryReview: true })
  await h.wake()
  const [job] = reflectionJobs(h)
  assert.equal(reflectionJobs(h).length, 1)
  assert.deepEqual(job.payload.milestone, { kind: experience.kind, taskId: experience.taskId })
  assert.equal(job.runAfter, Date.now() + 30 * 60_000)
  assert.equal(job.payload.expiresAt, Date.now() + 48 * 60 * 60_000)
  h.advance(job.runAfter)
  await h.wake()
  const { receipt, prompt } = h.sent.at(-1)
  assert.equal(receipt.contextId, DAILY_REFLECTION_CONTEXT)
  assert.match(prompt, /小屋/u)
  for (const secret of [experience.taskId, experience.draftId, h.zone.id, '测试草案私有名称', 'private-message', 'private-png']) assert.ok(!prompt.includes(secret))
  await h.respond(NOTE)
  const note = h.store.selfNotes.byMilestoneExperience('house', experience.taskId)
  assert.deepEqual(note.experience, experience)
  assert.equal(note.sourceRefs[0].taskId, job.id)
  assert.equal(note.evidenceRefs[0].role, 'assistant')
  assert.equal(h.store.selfNotes.recallCandidates('chat.mobile').find(item => item.id === note.id)?.trait, NOTE.trait)
  h.store.selfNotes.update(note.id, { status: 'archived' })
  await h.reopen()
  h.advance(Date.now() + 31_000)
  await h.wake()
  assert.deepEqual(reflectionJobs(h).map(item => item.id), [job.id])
  assert.equal(h.store.selfNotes.byMilestoneExperience('house', experience.taskId)?.status, 'archived')
  assert.equal(h.sent.filter(turn => turn.receipt.contextId === DAILY_REFLECTION_CONTEXT).length, 1)
})

test('a pending or active milestone reflection loses authority on zone revoke, expiry, or disabling the source', async t => {
  for (const condition of ['zone revoke', 'expired', 'off and on']) await t.test(condition, async t => {
    const h = fixture(t)
    const experience = completedHouse(h.store, h.zone.id)
    h.service.updateSettings({ dailyReflectionEnabled: true, minecraftMilestonesEnabled: true })
    await h.wake()
    const [job] = reflectionJobs(h)
    if (condition === 'expired') {
      h.advance(job.payload.expiresAt)
      await h.wake()
      assert.equal(h.sent.length, 0)
    } else {
      h.advance(job.runAfter)
      await h.wake()
      assert.equal(h.sent.at(-1).receipt.contextId, DAILY_REFLECTION_CONTEXT)
      if (condition === 'zone revoke') h.store.revokeBuildZone(h.zone.id)
      else {
        h.service.updateSettings({ minecraftMilestonesEnabled: false })
        h.service.updateSettings({ minecraftMilestonesEnabled: true })
        assert.ok(h.cancellations.includes(DAILY_REFLECTION_CONTEXT))
      }
      await h.respond(NOTE)
    }
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.equal(h.store.selfNotes.byMilestoneExperience('house', experience.taskId), undefined)
  })
})
