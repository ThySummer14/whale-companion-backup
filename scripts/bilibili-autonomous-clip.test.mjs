import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_SHARE_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { SessionService } from '../src/host/session.ts'
import { deviceFeedPost } from '../src/host/device-feed.ts'
import { AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS } from '../src/protocol/bilibili.ts'

const now = new Date('2026-11-10T05:00:00Z').getTime()
const bvid = 'BV1dLx46TEhw'
const privateTranscript = '不出现在共享状态里的试听原文'
const privateObservation = '不出现在共享状态里的模型观察'
const picture = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const sharedReaction = '我好奇为什么短短几秒就能让人想再看一次。'

function fixture(t, { asr = true, attachments = true, vision = true, busy = false, publishFailure = undefined } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now })
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/bili-clip-autonomy-')
  const file = join(directory, 'companion.db')
  const store = new CompanionStore(file)
  const plan = []
  const material = []
  const captures = []
  const cancelled = []
  const released = []
  let sample = (_input, hasVision) => ({
    picture: hasVision ? picture : undefined, transcript: asr ? privateTranscript : undefined,
    visual: { status: hasVision ? 'sampled' : 'unavailable' }, audio: { status: asr ? 'sampled' : 'unavailable' },
  })
  let index = 0
  const sessions = {
    chatAttachmentsAvailable: attachments,
    async create(input, _replace, check) {
      check?.()
      const binding = store.bindContext({ ...input, sessionId: `isolated-${++index}` })
      return { binding }
    },
    async send(contextId, prompt) {
      const receipt = { accepted: true, contextId, sessionId: store.bindingByContext(contextId).sessionId, messageId: `plan-${plan.length}` }
      plan.push({ receipt, prompt })
      return receipt
    },
    async bilibiliClipVision() { return vision },
    async sendBilibiliClip(sessionId, prompt, image, check) {
      check()
      const receipt = { accepted: true, contextId: BILIBILI_CLIP_CONTEXT, sessionId, messageId: `clip-${material.length}`,
        ...(image && { attachments: [{ id: 'sha256:clip-image' }] }) }
      material.push({ receipt, prompt, image })
      return receipt
    },
    async cancel(contextId) { cancelled.push(contextId) },
    async release(sessionId) { released.push(sessionId) },
  }
  const provider = {
    clipAudioAvailable: asr,
    isIdle: () => true,
    read() { assert.fail('clip flow must not spend another request reading metadata or subtitles') },
    async sampleClip(...args) { captures.push(args); return sample(...args) },
  }
  const service = new AutonomyService(store, sessions, undefined, undefined, input => {
    if (publishFailure === 'before') throw new Error('publish failed before commit')
    const post = store.feed.create(input)
    if (publishFailure === 'after') throw new Error('publish notification failed after commit')
    return post
  }, provider, undefined, () => busy)
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const add = (video = bvid) => store.bilibili.add({ bvid: video, part: 1 }, '已授权候选')
  const enable = (settings = {}) => service.updateSettings({ bilibiliEnabled: true, bilibiliClipsEnabled: true,
    bilibiliIntervalMinutes: 30, quietStart: '00:00', quietEnd: '00:00', ...settings })
  const current = () => store.autonomy.pending('bilibili.review', BILIBILI_AUTONOMY_CONTEXT)
  const tick = async () => { service.wakeBilibili(); await setImmediate() }
  async function answer({ receipt, prompt }, text, { clip = false, bad = undefined, afterInput } = {}) {
    const binding = store.bindingByContext(receipt.contextId)
    const turn = 1
    const emit = (type, data, surfaceOp) => service.observe(binding, { type, data, surfaceOp })
    emit('turn/start', { turn })
    const content = [{ type: 'text', text: bad === 'rewrite' ? '被更改的素材' : prompt }]
    if (receipt.attachments?.length) content.push({ type: 'image', attachment: { attachmentId: bad === 'wrong-image' ? 'wrong' : receipt.attachments[0].id } })
    emit('user/message', { id: bad === 'wrong-id' ? 'unrelated' : receipt.messageId,
      source: clip && bad !== 'forged-source' ? { kind: 'companion-bili-clip', form: 'autonomous' } : { kind: 'user' }, content }, 'append')
    afterInput?.()
    emit('assistant/message', { turn, interrupted: bad === 'interrupted',
      message: { content: [{ type: bad === 'tool-call' ? 'tool-call' : 'text', text: JSON.stringify(text) }] } }, 'append')
    emit('turn/end', { turn, reason: { kind: bad === 'stopped' ? 'interrupted' : 'completed' } })
    await setImmediate()
  }
  const choose = (candidate, options = {}) => answer(plan.at(-1), { decision: 'clip', candidateId: candidate.id, start: 12, seconds: 6, mode: 'both', ...options })
  const review = (bad, observation = privateObservation, reaction, afterInput) => answer(material.at(-1), { observation, reaction }, { clip: true, bad, afterInput })
  return { store, file, service, plan, material, captures, cancelled, released, add, enable, current, tick, choose, review,
    sample: next => { sample = next } }
}

test('one autonomous choice and exact review create a queue receipt and only factual shared memory', async t => {
  const h = fixture(t)
  assert.equal(h.store.autonomy.settings().bilibiliClipsEnabled, false)
  const candidate = h.add()
  h.enable({ feedEnabled: true, bilibiliShareEnabled: true, bilibiliReflectionEnabled: true })
  await setImmediate()
  const job = h.current()
  assert.match(h.plan[0].prompt, /visual、audio、both/u)
  await h.choose(candidate)
  assert.deepEqual(h.captures[0].slice(0, 2), [{ bvid, part: 1, start: 12, seconds: 6, mode: 'both' }, true])
  assert.equal(h.store.bilibili.get(candidate.id).status, 'reading')
  assert.equal(h.store.taskById(job.id).status, 'running')
  assert.equal(h.material[0].image, picture)
  assert.ok(h.material[0].prompt.includes(privateTranscript))
  assert.equal(h.store.bilibili.canBeginClip(now), false)
  assert.equal(h.store.bilibili.canBeginClip(now + AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS), true)
  assert.equal(h.store.bilibili.view().nextClipAt, new Date(now + AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS).toISOString())
  assert.ok(!h.store.activities().some(activity => activity.kind === 'video.clip-sampled'))
  await h.review()
  const receipt = h.store.bilibili.get(candidate.id).receipt
  assert.equal(receipt.kind, 'video.clip-sampled')
  assert.deepEqual(receipt.clip, { start: 12, seconds: 6, visual: true, audio: true })
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
  assert.equal(h.store.activityById(receipt.activityId).taskId, job.id)
  assert.ok(h.released.includes(h.material[0].receipt.sessionId))
  const memory = h.store.memory.find(bvid, { contextId: 'chat.mobile' })
  assert.equal(memory.length, 1)
  assert.match(memory[0].content, /12 秒.*6 秒.*抽样画面与声音转写/u)
  assert.ok(!JSON.stringify([h.service.view(), h.store.activities(), memory]).includes(privateTranscript))
  assert.ok(!JSON.stringify(memory).includes(privateObservation))
  assert.equal(h.store.autonomy.pending('bilibili.reflect', 'autonomy.bilibili-reflect'), undefined)
  assert.equal(h.store.autonomy.pending('bilibili.share', 'autonomy.bilibili-feed'), undefined)
  const copy = new CompanionStore(h.file)
  try {
    assert.equal(copy.bilibili.canBeginClip(now), false)
    assert.deepEqual(copy.bilibili.get(candidate.id).receipt, receipt)
  } finally { copy.close() }
  h.add('BV1pY4P6nEMp')
  t.mock.timers.setTime(now + 31 * 60_000)
  await h.tick()
  await h.tick()
  const browse = h.plan.filter(item => item.receipt.contextId === BILIBILI_AUTONOMY_CONTEXT)
  assert.equal(browse.length, 2)
  assert.doesNotMatch(browse[1].prompt, /"decision":"clip"/u)
  assert.equal(h.captures.length, 1)
})

test('the home stays at the phone only during the admitted private understanding turn', async t => {
  for (const state of ['valid', 'cancelled during turn', 'wrong-id', 'wrong-image', 'forged-source', 'rewrite']) await t.test(state, async t => {
    const h = fixture(t)
    const candidate = h.add()
    h.enable()
    await setImmediate()
    await h.choose(candidate)
    assert.equal(h.service.homeClipActive(), false)
    const trusted = state === 'valid' || state === 'cancelled during turn'
    await h.review(trusted ? undefined : state, privateObservation, undefined, () => {
      assert.equal(h.service.homeClipActive(), trusted)
      if (state === 'cancelled during turn') {
        h.enable({ bilibiliClipsEnabled: false })
        assert.equal(h.service.homeClipActive(), false)
      }
    })
    assert.equal(h.service.homeClipActive(), false)
  })
})

test('a clip can post a timed private reaction in its own review, with no extra model turn', async t => {
  for (const [name, options, mode, prefix] of [
    ['picture', { asr: false }, 'visual', /B 站视频的画面/u],
    ['sound', { attachments: false }, 'audio', /我参考了一小段 B 站视频的声音转写/u],
    ['picture and sound', {}, 'both', /也参考了声音转写/u],
    ['commit precedes a notification failure', { publishFailure: 'after' }, 'both', /也参考了声音转写/u],
  ]) await t.test(name, async t => {
    const h = fixture(t, options)
    const item = h.add()
    assert.equal(h.store.autonomy.settings().bilibiliClipShareEnabled, false)
    h.enable({ feedEnabled: true, bilibiliClipShareEnabled: true })
    await setImmediate()
    const read = h.current()
    await h.choose(item, { mode })
    assert.match(h.material[0].prompt, /可另外填写 reaction/u)
    await h.review(undefined, privateObservation, sharedReaction)
    const [post] = h.store.feed.list().items
    assert.match(post.body, prefix)
    assert.ok(post.body.endsWith(sharedReaction))
    assert.equal(post.mediaId, undefined)
    assert.deepEqual(post.bilibiliSource, { bvid, part: 1, startSeconds: 12 })
    assert.equal(h.store.autonomy.get(post.sourceTaskId).task.status, 'succeeded')
    assert.equal(h.store.autonomy.get(read.id).task.status, 'succeeded')
    assert.equal(h.plan.length, 1)
    assert.equal(h.material.length, 1)
    const paired = deviceFeedPost(post)
    assert.equal(paired.sourceSessionId, undefined)
    assert.equal(paired.sourceTaskId, undefined)
    assert.doesNotMatch(JSON.stringify([post, h.service.view(), h.store.memory.list({ contextId: 'chat.mobile' })]), /不出现在共享状态/u)
    assert.equal(h.store.memory.list({ contextId: 'chat.mobile' }).filter(item => /分享到了私有动态/u.test(item.content)).length, 1)
    const reopened = new CompanionStore(h.file)
    try { assert.deepEqual(reopened.feed.get(post.id).bilibiliSource, paired.bilibiliSource) }
    finally { reopened.close() }
  })
})

test('a refused clip share leaves the original reading confirmed', async t => {
  const cases = ['default off', 'general feed off', 'model abstains', 'enable after offer', 'disable and reenable', 'copied transcript',
    'copied private observation', 'link', 'whole video claim', 'wrong reaction type', 'existing feed cooldown', 'competing feed post', 'publish failure']
  for (const name of cases) await t.test(name, async t => {
    const h = fixture(t, name === 'publish failure' ? { publishFailure: 'before' } : {})
    const item = h.add()
    const other = () => h.store.feed.create({ contextId: 'autonomy.feed', author: 'companion', body: '另一条自主动态。' })
    if (name === 'existing feed cooldown') other()
    h.enable({ feedEnabled: name !== 'general feed off', bilibiliClipShareEnabled: !['default off', 'enable after offer'].includes(name) })
    await setImmediate()
    const read = h.current()
    await h.choose(item)
    if (name === 'enable after offer') h.enable({ bilibiliClipShareEnabled: true })
    if (name === 'disable and reenable') {
      h.enable({ bilibiliClipShareEnabled: false })
      h.enable({ bilibiliClipShareEnabled: true })
    }
    if (name === 'competing feed post') other()
    const reactions = { 'model abstains': undefined, 'copied transcript': `我留意到${privateTranscript}。`,
      'copied private observation': `我留意到${privateObservation}。`, link: '我想看 https://example.com 这个链接。',
      'whole video claim': '我刚把整集都看完了。', 'wrong reaction type': { body: sharedReaction } }
    await h.review(undefined, privateObservation, Object.hasOwn(reactions, name) ? reactions[name] : sharedReaction)
    assert.equal(h.store.autonomy.get(read.id).task.status, 'succeeded')
    assert.equal(h.store.bilibili.get(item.id).receipt.kind, 'video.clip-sampled')
    assert.equal(h.store.feed.list().items.filter(post => post.bilibiliSource).length, 0)
    assert.equal(h.store.memory.list({ contextId: 'chat.mobile' }).filter(item => /分享到了私有动态/u.test(item.content)).length, 0)
  })
})

test('unauthorized selections cannot spend the daily media slot or contact the media connector', async t => {
  for (const branch of ['default-off', 'busy', 'mode-not-offered', 'foreign-candidate', 'over-length', 'revoked-before-choice']) await t.test(branch, async t => {
    const h = fixture(t, { busy: branch === 'busy', asr: branch !== 'mode-not-offered' })
    const candidate = h.add()
    h.enable({ bilibiliClipsEnabled: branch !== 'default-off' })
    await setImmediate()
    if (branch === 'revoked-before-choice') h.enable({ bilibiliClipsEnabled: false })
    await h.choose(candidate, branch === 'over-length' ? { seconds: 9 } : branch === 'foreign-candidate' ? { candidateId: '13b80a74-c90c-448b-920c-f1d19dff9015' } : {})
    assert.equal(h.captures.length, 0)
    assert.equal(h.material.length, 0)
    assert.equal(h.store.bilibili.canBeginClip(now), true)
    assert.equal(h.store.bilibili.get(candidate.id).status, 'queued')
  })
})

test('a text-only model can hear the selected clip, with no image or visual claim', async t => {
  const h = fixture(t, { vision: false })
  const candidate = h.add()
  h.enable()
  await setImmediate()
  await h.choose(candidate)
  assert.equal(h.captures[0][1], false)
  assert.equal(h.material[0].image, undefined)
  await h.review()
  assert.deepEqual(h.store.bilibili.get(candidate.id).receipt.clip, { start: 12, seconds: 6, visual: false, audio: true })
})

test('unverified private understanding never produces a read receipt or shared experience', async t => {
  for (const branch of ['rewrite', 'forged-source', 'wrong-image', 'wrong-id', 'interrupted', 'tool-call', 'stopped', 'over-length']) await t.test(branch, async t => {
    const h = fixture(t)
    const candidate = h.add()
    h.enable()
    await setImmediate()
    await h.choose(candidate)
    await h.review(branch, branch === 'over-length' ? '疑'.repeat(161) : privateObservation)
    assert.equal(h.store.bilibili.get(candidate.id).status, 'failed')
    assert.equal(h.store.bilibili.get(candidate.id).receipt, undefined)
    assert.equal(h.store.memory.find(bvid, { contextId: 'chat.mobile' }).length, 0)
    assert.equal(h.store.bilibili.canBeginClip(now), false)
  })
})

test('revocation, foreground and quiet changes abort private understanding without a replay or success', async t => {
  for (const branch of ['opt-out', 'queue-revoke', 'foreground', 'quiet', 'no-material', 'network-in-flight']) await t.test(branch, async t => {
    const h = fixture(t)
    const candidate = h.add()
    if (branch === 'no-material') h.sample(() => ({ visual: { status: 'unavailable' }, audio: { status: 'unavailable' } }))
    if (branch === 'network-in-flight') h.sample((_input, _vision, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    h.enable()
    await setImmediate()
    const job = h.current()
    await h.choose(candidate)
    if (branch === 'opt-out' || branch === 'network-in-flight') h.enable({ bilibiliClipsEnabled: false })
    if (branch === 'queue-revoke') { h.store.bilibili.cancel(candidate.id); h.service.cancelBilibili(candidate.id) }
    if (branch === 'foreground') {
      const binding = h.store.bindContext({ contextId: 'chat.mobile', sessionId: 'phone', kind: 'chat', label: '手机' })
      h.service.observe(binding, { type: 'turn/start', data: { turn: 1 } })
    }
    if (branch === 'quiet') h.enable({ quietStart: '00:00', quietEnd: '23:59' })
    await setImmediate()
    assert.ok(['cancelled', 'failed'].includes(h.store.taskById(job.id).status))
    assert.equal(h.captures.length, 1)
    assert.equal(h.store.bilibili.canBeginClip(now), false)
    assert.equal(h.store.bilibili.get(candidate.id).receipt, undefined)
    assert.equal(h.store.memory.find(bvid, { contextId: 'chat.mobile' }).length, 0)
  })
})

test('generic session creation and message submission cannot enter the managed clip session', async () => {
  const sessions = new SessionService({}, { bindingByContext: () => undefined }, () => {})
  await assert.rejects(sessions.create({ contextId: BILIBILI_CLIP_CONTEXT, kind: 'system' }), { code: 'bili-clip-session-managed' })
  await assert.rejects(sessions.send(BILIBILI_CLIP_CONTEXT, 'unapproved material'), { code: 'bili-clip-session-managed' })
})

test('restart reconciles an unfinished clip reservation without repeating media or resetting the 24-hour slot', async t => {
  const h = fixture(t)
  const candidate = h.add()
  const job = h.store.autonomy.create({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT,
    dedupeKey: 'interrupted-clip', runAfter: now, payload: { candidateId: candidate.id }, maxAttempts: 1 })
  assert.equal(h.store.bilibili.beginClip(candidate.id, now + 30 * 60_000), true)
  h.store.transitionTask(job.id, 'running')
  h.store.autonomy.update(job.id, { attempts: 1, leaseUntil: now + 55_000 })
  h.service.start()
  await setImmediate()
  assert.equal(h.store.taskById(job.id).status, 'failed')
  assert.equal(h.store.bilibili.get(candidate.id).status, 'failed')
  assert.equal(h.store.bilibili.get(candidate.id).error, 'bili-interrupted')
  assert.equal(h.store.bilibili.canBeginClip(now), false)
  assert.equal(h.captures.length, 0)
})
