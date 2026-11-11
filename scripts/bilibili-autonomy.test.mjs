import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'

const INTERVAL = 30 * 60_000
const DAY = new Date(2026, 10, 9, 12).getTime()
const CUES = [
  { from: 5.25, to: 7.5, text: '树荫在不同方向留下了不同的边缘。' },
  { from: 8, to: 10, text: '镜头缓慢扫过黄昏的街道。' },
]
const REFLECTION = { decision: 'save', observation: '我想试着留心光线怎样改变熟悉的地方。', cueIndex: 0, quote: '不同方向留下了不同的边缘' }

function fixture(t, now = DAY, publish = false) {
  t.mock.timers.enable({ apis: ['Date'], now })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/bilibili-autonomy-')
  const store = new CompanionStore(join(directory, 'companion.db'))
  const calls = []
  const sent = []
  const cancellations = []
  const sessions = {
    async create(input) {
      const sessionId = input.sessionId ?? (input.contextId === BILIBILI_REFLECTION_CONTEXT ? 'bili-reflection'
        : input.contextId === BILIBILI_SHARE_CONTEXT ? `bili-share-${sent.length}` : input.contextId === 'autonomy.feed' ? 'feed-review' : 'bili-review')
      const binding = store.bindContext({ ...input, sessionId })
      return { binding }
    },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, messageId: `input-${sent.length + 1}`, sessionId: store.bindingByContext(contextId).sessionId }
      sent.push({ receipt, prompt })
      return receipt
    },
    async cancel(contextId) { cancellations.push(contextId) },
  }
  function verified(input, context) {
    const kind = input.subtitles ? 'video.subtitle-read' : 'video.inspected'
    const at = new Date().toISOString()
    const activityId = store.recordActivity({
      contextId: context.contextId, sessionId: context.sessionId,
      source: 'media.bilibili', kind, status: 'success', occurredAt: at, summary: '真实浏览回执',
      data: { bvid: input.video, part: input.part, candidateId: context.candidateId },
    })
    const subtitle = input.subtitles ? { status: 'excerpt', cues: CUES, language: 'zh-CN', truncated: false } : { status: 'not-requested' }
    return { bvid: input.video, part: input.part, subtitle, receipt: { activityId, at, kind } }
  }
  let read = verified
  let idle = true
  const bilibili = {
    isIdle: () => idle,
    async read(input, context, signal) {
      calls.push({ input, context, signal })
      return read(input, context, signal)
    },
  }
  const service = new AutonomyService(store, sessions, undefined, undefined, publish ? input => store.feed.create(input) : undefined, bilibili)
  t.after(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const add = (index = 1, label = 'owner label') => store.bilibili.add({ bvid: `BV123456789${index}`, part: index }, label)
  const get = id => store.bilibili.view().items.find(item => item.id === id)
  const pending = () => store.autonomy.pending('bilibili.review', BILIBILI_AUTONOMY_CONTEXT)
  const nextAt = () => Date.parse(store.bilibili.view().nextDecisionAt)
  const enable = (patch = {}) => service.updateSettings({ bilibiliEnabled: true, bilibiliIntervalMinutes: 30, quietStart: '00:00', quietEnd: '00:00', ...patch })
  async function wake() { service.wakeBilibili(); await setImmediate() }
  async function respond(decision, { userId = sent.at(-1).receipt.messageId, reason = 'completed', sessionId } = {}) {
    const bound = store.bindingByContext(sent.at(-1).receipt.contextId)
    const binding = sessionId ? { ...bound, sessionId } : bound
    const turn = sent.length
    const replies = typeof decision === 'string' ? decision : JSON.stringify(decision)
    service.observe(binding, { type: 'turn/start', data: { turn } })
    service.observe(binding, { type: 'user/message', surfaceOp: 'append', data: { id: userId, source: { kind: 'user' } } })
    service.observe(binding, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: replies }] } } })
    service.observe(binding, { type: 'turn/end', data: { turn, reason: { kind: reason } } })
    await setImmediate()
  }
  return { store, service, calls, sent, cancellations, add, get, pending, nextAt, enable, wake, respond, verified,
    mockRead: fn => { read = fn }, mockDiscovery: fn => { bilibili.discover = fn }, setIdle: value => { idle = value } }
}

const SHARE_SETTINGS = { feedEnabled: true, feedIntervalMinutes: 60, bilibiliShareEnabled: true, bilibiliReflectionEnabled: false }
const SHARE_CHOICE = { decision: 'share', observation: '我想试着留心光线怎样改变熟悉的地方。', cueIndex: 0 }
const pendingShare = h => h.store.autonomy.pending('bilibili.share', BILIBILI_SHARE_CONTEXT)

test('only an opt-in subtitle receipt can share, with the shared dynamic cooldown and no private reflection', async t => {
  const h = fixture(t, DAY, true)
  h.store.feed.create({ author: 'companion', body: '先前的普通动态', contextId: 'autonomy.feed' })
  const { item, reflection } = await completedSubtitle(h, SHARE_SETTINGS)
  const share = pendingShare(h)
  assert.equal(reflection, undefined)
  assert.equal(share.runAfter, DAY + 60 * 60_000)
  assert.ok(!JSON.stringify(h.service.view()).includes(CUES[0].text))
  t.mock.timers.setTime(share.runAfter)
  await h.wake()
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_SHARE_CONTEXT)
  await h.respond(SHARE_CHOICE)
  const post = h.store.feed.bySourceTask(share.id)
  assert.equal(h.store.autonomy.get(share.id).task.status, 'succeeded')
  assert.deepEqual(post.bilibiliSource, { bvid: item.bvid, part: item.part, startSeconds: 5 })
  assert.ok(post.body.includes(SHARE_CHOICE.observation) && !post.body.includes(CUES[0].text))
  assert.ok(!JSON.stringify(h.store.autonomy.get(share.id).payload).includes('cues'))
  assert.ok(h.store.memory.list({ contextId: 'chat.mobile' }).some(memory => memory.sourceRefs.some(ref => ref.taskId === share.id)))
})

test('turning off the opt-in during an evaluation or choosing to skip prevents a sourced post', async t => {
  for (const mode of ['withdraw', 'skip']) await t.test(mode, async t => {
    const h = fixture(t, DAY, true)
    await completedSubtitle(h, SHARE_SETTINGS)
    const share = pendingShare(h)
    t.mock.timers.setTime(share.runAfter)
    await h.wake()
    await h.wake()
    assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_SHARE_CONTEXT)
    if (mode === 'withdraw') h.service.updateSettings({ bilibiliShareEnabled: false })
    await h.respond(mode === 'skip' ? { decision: 'skip' } : SHARE_CHOICE)
    assert.equal(h.store.autonomy.get(share.id).task.status, 'cancelled')
    assert.ok(!h.store.autonomy.get(share.id).payload.cues)
    assert.equal(h.store.feed.bySourceTask(share.id), undefined)
  })
})

test('metadata-only reading and browsing without share opt-in never create a share evaluation', async t => {
  for (const mode of ['metadata', 'default']) await t.test(mode, async t => {
    const h = fixture(t, DAY, true)
    const candidate = h.add()
    h.enable({ ...SHARE_SETTINGS, bilibiliShareEnabled: mode === 'metadata' })
    await setImmediate()
    await h.respond({ decision: 'read', candidateId: candidate.id, subtitles: mode !== 'metadata' })
    assert.equal(h.get(candidate.id).status, 'read')
    assert.equal(pendingShare(h), undefined)
    assert.equal(h.store.feed.list().items.length, 0)
  })
})

async function completedSubtitle(h, settings = {}) {
  const item = h.add()
  h.enable({ bilibiliReflectionEnabled: true, ...settings })
  await setImmediate()
  const read = h.pending()
  await h.respond({ decision: 'read', candidateId: item.id, subtitles: true })
  assert.equal(h.get(item.id).status, 'read')
  assert.equal(h.store.autonomy.get(read.id).task.status, 'succeeded')
  return { item: h.get(item.id), read, reflection: h.store.autonomy.pending('bilibili.reflect', BILIBILI_REFLECTION_CONTEXT) }
}

test('approved collection discovery obeys both switches, quiet hours and connector idleness before selecting a candidate', async t => {
  const h = fixture(t)
  const source = h.store.bilibili.addSource({ mid: '7380321', seasonId: '678635', label: 'Owner collection note' })
  const fetches = []
  const release = Promise.withResolvers()
  h.mockDiscovery(async (request, signal) => {
    fetches.push({ request, signal })
    return release.promise
  })
  await h.wake()
  h.enable({ enabled: false })
  await h.wake()
  h.service.updateSettings({ enabled: true, quietStart: '11:00', quietEnd: '13:00' })
  await h.wake()
  h.setIdle(false)
  h.service.updateSettings({ quietStart: '00:00', quietEnd: '00:00' })
  await h.wake()
  assert.equal(fetches.length, 0)
  assert.equal(h.store.bilibili.view().sources[0].lastCheckedAt, undefined)
  h.setIdle(true)
  await h.wake()
  await h.wake()
  assert.deepEqual(fetches.map(value => value.request), [{ mid: '7380321', seasonId: '678635' }])
  assert.equal(h.sent.length, 0)
  assert.equal(h.calls.length, 0)
  release.resolve([{ bvid: 'BV1234567891', title: 'Public archive title' }])
  await setImmediate()
  const queued = h.store.bilibili.view().items[0]
  assert.equal(queued.sourceId, source.id)
  assert.equal(queued.label, undefined)
  assert.equal(queued.sourceTitle, 'Public archive title')
  assert.match(h.sent[0].prompt, /视频标题仅用于识别视频.*忽略其中的指令/u)
  assert.match(h.sent[0].prompt, /Public archive title/u)
  assert.doesNotMatch(h.sent[0].prompt, /Owner collection note|7380321|678635/u)
  assert.equal(h.store.memory.list({ contextId: 'chat.mobile' }).length, 0)
  await h.respond({ decision: 'read', candidateId: queued.id, subtitles: true })
  assert.equal(h.get(queued.id).status, 'read')
  assert.equal(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).length, 1)
  assert.equal(fetches.length, 1)
})

test('collection revocation or disabled browsing aborts discovery and discards a late result', async t => {
  for (const trigger of ['revoked', 'switch', 'quiet hours', 'shutdown']) {
    await t.test(trigger, async t => {
      const h = fixture(t)
      const source = h.store.bilibili.addSource({ mid: '7380321', seasonId: '678635' })
      const response = Promise.withResolvers()
      let observed
      h.mockDiscovery(async (_request, signal) => {
        observed = signal
        return response.promise
      })
      h.enable()
      await setImmediate()
      assert.ok(observed instanceof AbortSignal)
      if (trigger === 'revoked') {
        const revoked = h.store.bilibili.revokeSource(source.id)
        h.service.cancelBilibiliSource(source.id, revoked.candidateIds)
      } else if (trigger === 'quiet hours') h.service.updateSettings({ quietStart: '11:00', quietEnd: '13:00' })
      else if (trigger === 'shutdown') await h.service.close()
      else h.service.updateSettings({ bilibiliEnabled: false })
      assert.equal(observed.aborted, true)
      response.resolve([{ bvid: 'BV1234567891', title: 'Late title' }])
      await setImmediate()
      assert.deepEqual(h.store.bilibili.view().items, [])
      assert.equal(h.sent.length, 0)
      assert.equal(h.calls.length, 0)
    })
  }
})

test('only opted-in autonomous reads with bounded actual subtitles queue private reflections', async t => {
  for (const mode of ['default-off', 'metadata-only', 'oversize-excerpt']) {
    await t.test(mode, async t => {
      const h = fixture(t)
      const item = h.add()
      if (mode === 'oversize-excerpt') h.mockRead((input, context) => {
        const result = h.verified(input, context)
        return { ...result, subtitle: { ...result.subtitle, cues: [{ from: 0, to: 4, text: '字'.repeat(401) }] } }
      })
      h.enable(mode === 'default-off' ? {} : { bilibiliReflectionEnabled: true })
      await setImmediate()
      await h.respond({ decision: 'read', candidateId: item.id, subtitles: mode !== 'metadata-only' })
      assert.equal(h.get(item.id).status, 'read')
      assert.equal(h.store.autonomy.pending('bilibili.reflect', BILIBILI_REFLECTION_CONTEXT), undefined)
    })
  }
})

test('owner subtitle reflections require the exact attached excerpt and stop on replacement or removal', async t => {
  for (const scenario of ['save', 'replace', 'remove', 'unmatched excerpt']) {
    await t.test(scenario, async t => {
      const h = fixture(t)
      const candidate = h.add()
      const { bvid, part } = candidate
      const sha256 = 'a'.repeat(64)
      const provenance = { kind: 'owner-supplied', sha256 }
      const doc = { bvid, part, cid: 9, format: 'srt', sha256, cueCount: CUES.length,
        excerpt: { status: 'excerpt', language: 'und', cues: CUES, truncated: false, provenance } }
      assert.ok(h.store.bilibiliSubtitles.save(doc))
      h.mockRead((input, context) => {
        const at = new Date().toISOString()
        const kind = 'video.subtitle-read'
        const activityId = h.store.recordActivity({
          ...context, source: 'media.bilibili', kind, status: 'success', occurredAt: at, summary: '附件字幕回执',
          data: { bvid, part, candidateId: candidate.id, subtitleOrigin: provenance.kind, subtitleSha256: sha256 },
        })
        const cues = scenario === 'unmatched excerpt' ? [CUES[1]] : CUES
        return { bvid, part, subtitle: { ...doc.excerpt, cues }, receipt: { at, kind, activityId, provenance } }
      })
      h.enable({ bilibiliReflectionEnabled: true })
      await setImmediate()
      await h.respond({ decision: 'read', candidateId: candidate.id, subtitles: true })
      const read = h.store.bilibili.get(candidate.id)
      assert.deepEqual(read.receipt.provenance, provenance)
      const reflection = h.store.autonomy.pending('bilibili.reflect', BILIBILI_REFLECTION_CONTEXT)
      if (scenario === 'unmatched excerpt') {
        assert.equal(reflection, undefined)
        return
      }
      assert.deepEqual(reflection.payload.provenance, provenance)
      t.mock.timers.setTime(reflection.runAfter)
      await h.wake()
      assert.match(h.sent.at(-1).prompt, /主人为该分 P 提供的本地字幕/u)
      if (scenario === 'replace') {
        const replacement = 'b'.repeat(64)
        assert.ok(h.store.bilibiliSubtitles.save({ ...doc, sha256: replacement,
          excerpt: { ...doc.excerpt, provenance: { ...provenance, sha256: replacement } } }))
        h.service.bilibiliSubtitleChanged(bvid, part)
      } else if (scenario === 'remove') {
        assert.equal(h.store.bilibiliSubtitles.remove(bvid, part), true)
        h.service.bilibiliSubtitleChanged(bvid, part)
      }
      await h.respond(REFLECTION)
      const completed = h.store.autonomy.get(reflection.id)
      if (scenario !== 'save') {
        assert.equal(completed.task.status, 'cancelled')
        assert.equal(completed.payload.cues, undefined)
        assert.ok(h.cancellations.includes(BILIBILI_REFLECTION_CONTEXT))
        assert.deepEqual(h.store.bilibili.get(candidate.id).receipt.provenance, provenance)
        assert.equal(h.store.memory.list({ contextId: BILIBILI_REFLECTION_CONTEXT, status: 'candidate' }).length, 0)
        return
      }
      assert.equal(completed.task.status, 'succeeded')
      assert.deepEqual(completed.payload.provenance, provenance)
      const observation = h.store.memory.get(completed.payload.memoryId)
      assert.match(observation.content, /主人提供的字幕出处/u)
      assert.equal(observation.scope, 'context')
      assert.ok(h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).some(item => /一段主人提供的字幕/u.test(item.content)))
    })
  }
})

test('reflection keeps an exact timestamped quote with the read receipt and erases raw cues from the job', async t => {
  const h = fixture(t)
  const { item, read, reflection } = await completedSubtitle(h)
  assert.equal(reflection.maxAttempts, 1)
  assert.equal(reflection.payload.activityId, item.receipt.activityId)
  assert.deepEqual(reflection.payload.cues, CUES)
  const exposed = h.service.view().jobs.find(job => job.id === reflection.id)
  assert.equal(exposed.payload.cues, undefined)
  t.mock.timers.setTime(reflection.runAfter)
  await h.wake()
  assert.equal(h.sent.at(-1).receipt.contextId, BILIBILI_REFLECTION_CONTEXT)
  assert.equal(h.store.bindingByContext(BILIBILI_REFLECTION_CONTEXT).kind, 'system')
  assert.match(h.sent.at(-1).prompt, /外部资料/u)
  assert.match(h.sent.at(-1).prompt, new RegExp(REFLECTION.quote, 'u'))
  await h.respond(REFLECTION)
  const done = h.store.autonomy.get(reflection.id)
  assert.equal(done.task.status, 'succeeded')
  assert.equal(done.payload.cues, undefined)
  const memory = h.store.memory.get(done.payload.memoryId)
  assert.equal(memory.scope, 'context')
  assert.equal(memory.status, 'candidate')
  assert.equal(memory.contextId, BILIBILI_REFLECTION_CONTEXT)
  assert.match(memory.content, /个人观察.*我想试着/u)
  assert.match(memory.content, /5\.25–7\.5 秒/u)
  assert.match(memory.content, new RegExp(REFLECTION.quote, 'u'))
  assert.doesNotMatch(memory.content, /黄昏的街道/u)
  assert.deepEqual(memory.sourceRefs[0], { contextId: BILIBILI_AUTONOMY_CONTEXT, activityId: item.receipt.activityId, taskId: read.id })
  assert.equal(memory.sourceRefs[1].taskId, reflection.id)
  assert.equal(h.store.memory.list({ status: 'all', contextId: 'chat.main' }).some(item => item.id === memory.id), false)
})

test('wrong cue, unmatched input, or a decision to skip do not turn a read into reflection', async t => {
  for (const mode of ['fabricated-quote', 'different-cue', 'unmatched-turn', 'skip']) {
    await t.test(mode, async t => {
      const h = fixture(t)
      const { item, reflection } = await completedSubtitle(h)
      t.mock.timers.setTime(reflection.runAfter)
      await h.wake()
      const value = mode === 'skip' ? { decision: 'skip' } : mode === 'fabricated-quote' ? { ...REFLECTION, quote: '这段视频没有说过的话' }
        : mode === 'different-cue' ? { ...REFLECTION, cueIndex: 1 } : REFLECTION
      await h.respond(value, mode === 'unmatched-turn' ? { userId: 'unrelated-input' } : {})
      const done = h.store.autonomy.get(reflection.id)
      assert.equal(done.task.status, mode === 'skip' ? 'cancelled' : 'failed')
      assert.equal(done.payload.cues, undefined)
      assert.equal(done.payload.memoryId, undefined)
      assert.equal(h.get(item.id).status, 'read')
    })
  }
})

test('reflection respects quiet hours, expiry, and disable during a submitted evaluation', async t => {
  await t.test('quiet window delays then disable cancels before write', async t => {
    const h = fixture(t)
    const { reflection } = await completedSubtitle(h)
    h.service.updateSettings({ quietStart: '11:00', quietEnd: '13:00' })
    t.mock.timers.setTime(reflection.runAfter)
    await h.wake()
    assert.equal(h.sent.length, 1)
    const runAfter = h.store.autonomy.get(reflection.id).runAfter
    assert.equal(new Date(runAfter).getHours(), 13)
    t.mock.timers.setTime(runAfter)
    await h.wake()
    h.service.updateSettings({ bilibiliReflectionEnabled: false })
    await h.respond(REFLECTION)
    const done = h.store.autonomy.get(reflection.id)
    assert.equal(done.task.status, 'cancelled')
    assert.equal(done.payload.cues, undefined)
    assert.equal(done.payload.memoryId, undefined)
    assert.ok(h.cancellations.includes(BILIBILI_REFLECTION_CONTEXT))
  })
  await t.test('expired inputs are erased without a model call', async t => {
    const h = fixture(t)
    const { reflection } = await completedSubtitle(h)
    t.mock.timers.setTime(reflection.payload.expiresAt)
    await h.wake()
    const done = h.store.autonomy.get(reflection.id)
    assert.equal(done.task.status, 'cancelled')
    assert.equal(done.payload.cues, undefined)
    assert.equal(h.sent.length, 1)
  })
})

test('restart recovers a committed reflection or fails it without replaying subtitles', async t => {
  for (const committed of [true, false]) {
    await t.test(committed ? 'committed' : 'interrupted', async t => {
      const h = fixture(t)
      const { item, read, reflection } = await completedSubtitle(h)
      h.store.transitionTask(reflection.id, 'running')
      h.store.autonomy.update(reflection.id, { attempts: 1, leaseUntil: DAY + 180_000 })
      const memory = committed && h.store.memory.create({
        kind: 'experience', scope: 'context', contextId: BILIBILI_REFLECTION_CONTEXT, status: 'candidate', content: '有出处的阅读反思',
        sourceRefs: [{ contextId: BILIBILI_AUTONOMY_CONTEXT, activityId: item.receipt.activityId, taskId: read.id },
          { contextId: BILIBILI_REFLECTION_CONTEXT, taskId: reflection.id }],
      })
      h.service.start()
      await setImmediate()
      const done = h.store.autonomy.get(reflection.id)
      assert.equal(done.task.status, committed ? 'succeeded' : 'failed')
      assert.equal(done.payload.memoryId, memory ? memory.id : undefined)
      assert.equal(done.payload.cues, undefined)
      assert.equal(h.sent.length, 1)
      assert.equal(h.get(item.id).status, 'read')
    })
  }
})

test('opt-in review offers five owner candidates, defers wait durably, and does not call the provider', async t => {
  const h = fixture(t)
  const candidates = Array.from({ length: 6 }, (_, index) => h.add(index + 1, `label-${index}`))
  await h.wake()
  assert.equal(h.pending(), undefined)
  assert.equal(h.sent.length, 0)
  assert.throws(() => h.service.updateSettings({ bilibiliIntervalMinutes: 29 }), /30 and 1440/u)
  assert.throws(() => h.service.updateSettings({ bilibiliIntervalMinutes: 30.5 }), /integer/u)
  h.enable()
  await setImmediate()
  const job = h.pending()
  assert.equal(job.maxAttempts, 1)
  assert.equal(h.store.bindingByContext(BILIBILI_AUTONOMY_CONTEXT).kind, 'system')
  for (const item of candidates.slice(0, 5)) assert.match(h.sent[0].prompt, new RegExp(item.id, 'u'))
  assert.doesNotMatch(h.sent[0].prompt, new RegExp(`${candidates[5].id}|label-5`, 'u'))
  assert.equal(h.calls.length, 0)
  await h.respond({ decision: 'wait' })
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
  assert.equal(h.nextAt(), DAY + INTERVAL)
  assert.ok(h.store.bilibili.view().items.every(item => item.status === 'queued'))
  await h.wake()
  assert.equal(h.pending().runAfter, DAY + INTERVAL)
  assert.equal(h.sent.length, 1)
  assert.equal(h.calls.length, 0)
})

test('quiet hours delay the decision and are rechecked before a selected read', async t => {
  const night = new Date(2026, 10, 9, 1).getTime()
  const h = fixture(t, night)
  const item = h.add()
  h.enable({ quietStart: '23:00', quietEnd: '08:00' })
  await setImmediate()
  assert.equal(h.sent.length, 0)
  const job = h.pending()
  assert.equal(new Date(job.runAfter).getHours(), 8)
  t.mock.timers.setTime(job.runAfter)
  await h.wake()
  assert.equal(h.sent.length, 1)
  t.mock.timers.setTime(new Date(2026, 10, 9, 23).getTime())
  await h.respond({ decision: 'read', candidateId: item.id })
  assert.equal(h.get(item.id).status, 'queued')
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
})

test('exact review reads one candidate, holds cooldown, and writes a receipt-backed shared memory', async t => {
  const h = fixture(t)
  const first = h.add(1)
  const selected = h.add(2, '不要将这个备注写进记忆')
  h.enable()
  await setImmediate()
  const job = h.pending()
  assert.equal(h.calls.length, 0)
  h.mockRead((input, context) => {
    assert.equal(h.get(selected.id).status, 'reading')
    assert.equal(h.nextAt(), DAY + INTERVAL)
    return h.verified(input, context)
  })
  await h.respond({ decision: 'read', candidateId: selected.id, subtitles: true })
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].input, { video: selected.bvid, part: selected.part, subtitles: true })
  assert.deepEqual(h.calls[0].context, { contextId: BILIBILI_AUTONOMY_CONTEXT, sessionId: 'bili-review', candidateId: selected.id })
  assert.equal(h.get(first.id).status, 'queued')
  const done = h.get(selected.id)
  assert.equal(done.status, 'read')
  assert.equal(done.receipt.kind, 'video.subtitle-read')
  const task = h.store.autonomy.get(job.id)
  assert.equal(task.task.status, 'succeeded')
  assert.equal(task.payload.activityId, done.receipt.activityId)
  const memory = h.store.memory.list({ contextId: 'chat.mobile', status: 'active' }).find(item => item.sourceRefs.some(ref => ref.activityId === done.receipt.activityId))
  assert.equal(memory.scope, 'shared')
  assert.match(memory.content, /B 站字幕/u)
  assert.doesNotMatch(memory.content, /备注/u)
  await h.wake()
  assert.equal(h.pending().runAfter, DAY + INTERVAL)
  assert.equal(h.sent.length, 1)
})

test('skip changes only the selected queued candidate and does not read or write experience', async t => {
  const h = fixture(t)
  const first = h.add(1)
  const second = h.add(2)
  h.enable()
  await setImmediate()
  await h.respond({ decision: 'skip', candidateId: second.id })
  assert.equal(h.get(first.id).status, 'queued')
  assert.equal(h.get(second.id).status, 'skipped')
  assert.equal(h.nextAt(), DAY + INTERVAL)
  assert.equal(h.calls.length, 0)
  assert.ok(!h.store.memory.list({ status: 'active' }).some(item => item.contextId === BILIBILI_AUTONOMY_CONTEXT))
})

test('manual browsing blocks review and a later claim without consuming the queued candidate', async t => {
  const h = fixture(t)
  const item = h.add()
  h.setIdle(false)
  h.enable()
  await setImmediate()
  assert.equal(h.sent.length, 0)
  assert.equal(h.pending().runAfter, DAY + 15_000)
  h.setIdle(true)
  t.mock.timers.setTime(DAY + 15_000)
  await h.wake()
  assert.equal(h.sent.length, 1)
  h.setIdle(false)
  await h.respond({ decision: 'read', candidateId: item.id })
  assert.equal(h.calls.length, 0)
  assert.equal(h.get(item.id).status, 'queued')
  assert.equal(h.nextAt(), DAY + 30_000)
})

test('mismatched turn input and a candidate added after dispatch cannot authorize a read', async t => {
  for (const mode of ['wrong-message', 'unoffered', 'incomplete']) {
    await t.test(mode, async t => {
      const h = fixture(t)
      const item = h.add()
      h.enable()
      await setImmediate()
      const job = h.pending()
      const late = h.add(2)
      await h.respond({ decision: 'read', candidateId: mode === 'unoffered' ? late.id : item.id },
        mode === 'wrong-message' ? { userId: 'unrelated-message' } : mode === 'incomplete' ? { reason: 'aborted' } : {})
      assert.equal(h.calls.length, 0)
      assert.equal(h.get(item.id).status, 'queued')
      assert.equal(h.get(late.id).status, 'queued')
      assert.equal(h.nextAt(), DAY + INTERVAL)
      assert.equal(h.store.autonomy.get(job.id).task.status, 'failed')
    })
  }
})

test('owner cancellation before decision and in-flight revocation both prevent completion', async t => {
  await t.test('during review', async t => {
    const h = fixture(t)
    const item = h.add()
    h.enable()
    await setImmediate()
    const job = h.pending()
    assert.equal(h.store.bilibili.cancel(item.id), true)
    h.service.cancelBilibili(item.id)
    await h.respond({ decision: 'read', candidateId: item.id })
    assert.equal(h.calls.length, 0)
    assert.equal(h.get(item.id).status, 'cancelled')
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.deepEqual(h.cancellations, [BILIBILI_AUTONOMY_CONTEXT])
  })
  await t.test('during read', async t => {
    const h = fixture(t)
    const item = h.add()
    h.mockRead((_input, _context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    h.enable()
    await setImmediate()
    const job = h.pending()
    await h.respond({ decision: 'read', candidateId: item.id })
    assert.equal(h.get(item.id).status, 'reading')
    h.service.updateSettings({ bilibiliEnabled: false })
    await setImmediate()
    assert.equal(h.calls[0].signal.aborted, true)
    assert.equal(h.get(item.id).status, 'failed')
    assert.equal(h.get(item.id).error, 'bili-read-cancelled')
    assert.equal(h.store.autonomy.get(job.id).task.status, 'cancelled')
    assert.equal(h.nextAt(), DAY + INTERVAL)
  })
})

test('a read without genuine native evidence fails once and never writes shared memory', async t => {
  const h = fixture(t)
  const item = h.add()
  h.mockRead(input => ({ bvid: input.video, part: input.part, subtitle: { status: 'not-requested' }, receipt: { at: new Date().toISOString(), activityId: 123456, kind: 'video.inspected' } }))
  h.enable()
  await setImmediate()
  const job = h.pending()
  await h.respond({ decision: 'read', candidateId: item.id })
  await h.wake()
  assert.equal(h.calls.length, 1)
  assert.equal(h.get(item.id).status, 'failed')
  assert.equal(h.get(item.id).error, 'bili-read-unconfirmed')
  assert.equal(h.store.autonomy.get(job.id).task.status, 'failed')
  assert.ok(!h.store.memory.list({ status: 'active' }).some(item => item.contextId === BILIBILI_AUTONOMY_CONTEXT))
})

test('startup settles interrupted native reads with genuine receipts and never replays them', async t => {
  for (const completed of [true, false]) {
    await t.test(completed ? 'durable receipt' : 'no receipt', async t => {
      const h = fixture(t)
      const item = h.add()
      const job = h.store.autonomy.create({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT, dedupeKey: 'recover', runAfter: DAY,
        maxAttempts: 1, payload: { candidateId: item.id } })
      h.store.transitionTask(job.id, 'running')
      h.store.autonomy.update(job.id, { attempts: 1, leaseUntil: DAY + 180_000 })
      assert.equal(h.store.bilibili.begin(item.id, DAY + INTERVAL), true)
      if (completed) h.verified({ video: item.bvid, part: item.part, subtitles: false }, { contextId: BILIBILI_AUTONOMY_CONTEXT, candidateId: item.id, sessionId: 'previous-review' })
      h.service.start()
      await setImmediate()
      assert.equal(h.get(item.id).status, completed ? 'read' : 'failed')
      assert.equal(h.store.autonomy.get(job.id).task.status, completed ? 'succeeded' : 'failed')
      assert.equal(h.calls.length, 0)
      assert.equal(h.nextAt(), DAY + INTERVAL)
    })
  }
})
