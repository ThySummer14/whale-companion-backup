import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { FEED_REPLY_CONTEXT_PREFIX, FeedReplyDecision, feedReplyPrompt } from '../src/core/feed-reply.ts'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { registerFeedReplyBudget } from '../src/host/bilibili-choice-budget.ts'
import { deviceFeedPost } from '../src/host/device-feed.ts'
import { deviceContextAllowed } from '../src/host/device-http.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'

const DECISION = JSON.stringify({ decision: 'reply', body: '等你有空再一起去看。' })

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/feed-reply-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  const sends = []
  const creates = []
  const cancels = []
  let next = 0
  const sessions = {
    create: async (input, replace, assertAuthorized) => {
      assertAuthorized?.()
      const binding = { ...input, sessionId: 'isolated-' + ++next }
      creates.push({ ...input, replace, authorized: !!assertAuthorized })
      store.bindContext(binding)
      return { binding: store.bindingByContext(input.contextId) }
    },
    send: async (contextId, prompt, origin, voiceReply, upload, assertAuthorized) => {
      assertAuthorized?.()
      const binding = store.bindingByContext(contextId)
      const sent = { accepted: true, messageId: randomUUID(), sessionId: binding.sessionId, contextId }
      sends.push({ prompt, sent, binding })
      return sent
    },
    cancel: async contextId => { cancels.push(contextId) },
  }
  const service = new AutonomyService(store, sessions, undefined, undefined, input => store.feed.create(input))
  service.updateSettings({ quietStart: '00:00', quietEnd: '00:00', replyCooldownSec: 30, memoryReview: false })
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const post = (input, notify = true) => {
    const item = store.feed.create({ author: 'user', ...input })
    return { item, job: notify ? service.observePost(item) : undefined }
  }
  const run = async job => {
    store.autonomy.update(job.id, { runAfter: Date.now() - 10 })
    await delay(0)
    await service.tick()
    return sends.at(-1)
  }
  const finish = async (current, text = DECISION, { interrupted = false, otherUser = false, tool = false } = {}) => {
    let seq = 0
    const emit = (type, data) => service.observe(current.binding, { seq: ++seq, type, data, surfaceOp: 'append' })
    emit('turn/start', { turn: 1 })
    emit('user/message', { source: { kind: 'user' }, id: current.sent.messageId })
    if (otherUser) emit('user/message', { source: { kind: 'user' }, id: 'extra-user' })
    const content = [{ type: 'text', text }, ...(tool ? [{ type: 'tool-call' }] : [])]
    emit('assistant/message', { turn: 1, message: { content, id: 'reply' }, interrupted })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await delay(0)
  }
  return { service, store, sends, creates, cancels, post, run, finish }
}

test('reactive prompt preserves current input and bounds old thread data', t => {
  const h = fixture(t)
  const { item: root } = h.post({ body: '原动态' + '根'.repeat(3997) }, false)
  for (let i = 0; i < 10; i++) h.post({ parentId: root.id, body: `旧回复${i} ` + '长'.repeat(2000) }, false)
  const latest = h.post({ parentId: root.id, body: '字'.repeat(3990) + '最新细节' }, false).item
  const snapshot = h.store.feed.replySnapshot(root.id)
  const prompt = feedReplyPrompt({ name: '鲸鱼', tagline: '测试', description: '测试设定' }, snapshot)
  const [entry] = prompt.split('\n').filter(line => line.startsWith('{'))
  const { original, recent, current } = JSON.parse(entry)
  assert.equal(snapshot.replies.length, 4)
  assert.equal(h.store.feed.get(root.id).replies.length, 11)
  assert.equal(current.text, latest.body)
  assert.equal(original.text.length, 600)
  assert.equal(original.truncated, true)
  assert.equal(recent.length, 3)
  assert.ok(recent.every(item => item.text.length === 360 && item.truncated))
  assert.ok(!prompt.includes(root.id) && !prompt.includes(latest.id))
  assert.ok(!prompt.includes('旧回复0') && prompt.includes('旧回复9'))
})

test('fresh system decisions publish at most one reply with provenance and preserve old logs', async t => {
  const h = fixture(t)
  const { item: root, job } = h.post({ body: '主人发了动态' })
  h.store.bindContext({ contextId: job.contextId, sessionId: 'legacy-thread', label: 'Old', kind: 'topic' })
  const current = await h.run(job)
  assert.deepEqual(h.creates[0], { contextId: job.contextId, label: '动态线程回应', kind: 'system', sessionId: undefined, resume: false, replace: true, authorized: true })
  assert.notEqual(current.binding.sessionId, 'legacy-thread')
  assert.equal(h.store.feed.get(root.id).replies.length, 0)
  await h.finish(current)
  const reply = h.store.feed.get(root.id).replies[0]
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
  assert.equal(reply.parentId, root.id)
  assert.equal(reply.sourceTaskId, job.id)
  assert.equal(reply.sourceSessionId, current.binding.sessionId)
  assert.equal(h.store.feed.bySourceTask(job.id).id, reply.id)
  await h.finish(current)
  assert.equal(h.store.feed.get(root.id).replies.length, 1)
  assert.equal(h.store.autonomy.pending('memory.review', job.contextId), undefined)
  const projected = deviceFeedPost(reply)
  assert.equal(projected.id, reply.id)
  assert.equal(projected.body, reply.body)
  for (const key of ['sourceTaskId', 'sourceSessionId', 'contextId']) assert.equal(Object.hasOwn(projected, key), false)
})

test('the newest comment supersedes an in-flight response and gets its own short round', async t => {
  const h = fixture(t)
  const { item: root, job } = h.post({ body: '原动态' })
  const current = await h.run(job)
  const latest = h.post({ parentId: root.id, body: '刚才改主意了' })
  assert.equal(latest.job.id, job.id)
  await h.finish(current)
  assert.equal(h.store.taskById(job.id).status, 'accepted')
  assert.equal(h.store.autonomy.get(job.id).attempts, 0)
  assert.equal(h.store.feed.get(root.id).replies.length, 1)
  const next = await h.run(job)
  assert.notEqual(next.binding.sessionId, current.binding.sessionId)
  assert.match(next.prompt, /刚才改主意了/u)
  assert.ok(!next.prompt.includes(DECISION))
  await h.finish(next)
  assert.equal(h.store.feed.get(root.id).replies.length, 2)
  assert.equal(h.store.taskById(job.id).status, 'succeeded')
})

test('an owner comment on her own post can receive a reply after the normal cooldown', async t => {
  const h = fixture(t)
  const root = h.store.feed.create({ author: 'companion', body: '我在营地发现一棵樱花树' })
  assert.equal(h.service.observePost(root), undefined)
  const first = h.post({ parentId: root.id, body: '发个位置给我' })
  const current = await h.run(first.job)
  assert.match(current.prompt, /我在营地发现一棵樱花树/u)
  await h.finish(current)
  const followup = h.post({ parentId: root.id, body: '等我进服再说' })
  assert.ok(followup.job.runAfter >= h.store.feed.latestReactiveReplyAt(root.id) + 30_000)
  await h.service.tick()
  assert.equal(h.sends.length, 1)
  assert.equal(h.store.taskById(followup.job.id).status, 'accepted')
})

test('silence, unsafe proposals and withdrawn authority do not publish', async t => {
  for (const [label, text, options, change] of [
    ['deliberate silence', '{"decision":"skip"}'],
    ['malformed JSON', '我会回复'],
    ['extra output fields', '{"decision":"reply","body":"hello","parentId":"other"}'],
    ['overlong output', JSON.stringify({ decision: 'reply', body: '字'.repeat(241) })],
    ['interrupted output', DECISION, { interrupted: true }],
    ['injected input', DECISION, { otherUser: true }],
    ['invented tool call', DECISION, { tool: true }],
    ['root deleted', DECISION, {}, (h, root) => h.store.feed.delete(root.id, 'user')],
    ['settings turned off then on', DECISION, {}, h => {
      h.service.updateSettings({ feedRepliesEnabled: false })
      h.service.updateSettings({ feedRepliesEnabled: true })
    }],
    ['session rebound', DECISION, {}, (h, root) => h.store.bindContext({
      contextId: FEED_REPLY_CONTEXT_PREFIX + root.id, sessionId: 'replacement', kind: 'system', label: 'New',
    })],
  ]) await t.test(label, async t => {
    const h = fixture(t)
    const { item, job } = h.post({ body: '需要判断的动态' })
    const current = await h.run(job)
    change?.(h, item)
    await h.finish(current, text, options)
    assert.equal(h.store.taskById(job.id).status, 'cancelled')
    assert.equal(h.store.feed.bySourceTask(job.id), undefined)
    assert.equal(h.sends.length, 1)
  })
})

test('repository rejects forged, cross-thread, disabled and expired publications', async t => {
  const h = fixture(t)
  const { item: root, job } = h.post({ body: '主人发了动态' })
  const other = h.post({ body: '另一条动态' }, false).item
  const current = await h.run(job)
  const base = { author: 'companion', contextId: job.contextId, parentId: root.id, body: '正常字数', sourceTaskId: job.id,
    sourceSessionId: current.binding.sessionId }
  for (const input of [
    { sourceTaskId: undefined }, { sourceTaskId: randomUUID() }, { sourceSessionId: 'spoof' },
    { parentId: other.id }, { parentId: undefined }, { author: 'user' }, { mediaId: randomUUID() },
    { body: '字'.repeat(241) }, { body: '有\n换行' },
  ]) assert.throws(() => h.store.feed.create({ ...base, ...input }))
  h.store.autonomy.saveSettings({ ...h.store.autonomy.settings(), enabled: false })
  assert.throws(() => h.store.feed.create(base))
  h.store.autonomy.saveSettings({ ...h.store.autonomy.settings(), enabled: true })
  h.store.autonomy.update(job.id, { leaseUntil: Date.now() - 100 })
  assert.throws(() => h.store.feed.create(base))
})

test('reserved evaluation has no tools, a bounded first request and no phone session route', async () => {
  const id = FEED_REPLY_CONTEXT_PREFIX + randomUUID()
  const agent = { id: 'agent', session: { header: { origin: 'root' } } }
  let binding = { contextId: id, kind: 'system' }
  let middleware
  let reasoning
  registerFeedReplyBudget({
    on(name, fn) { assert.equal(name, 'agent/request'); middleware = fn },
    agents: { get: () => agent },
    llm: { resolveModelInfo: async () => ({ defaultMaxTokens: 1024, reasoning }) },
  }, { bindingBySession: () => binding })
  const config = { provider: 'local', model: 'model' }
  const request = (step = 1, value = config) => middleware({ agent, step, signal: new AbortController().signal }, async () => value)
  assert.equal((await request()).maxTokens, 512)
  assert.equal((await request(1, { ...config, maxTokens: 160 })).maxTokens, 160)
  assert.equal(await request(2), config)
  reasoning = { efforts: [{ id: 'high' }] }
  assert.equal(await request(), config)
  reasoning.efforts.push({ id: 'off' })
  assert.equal((await request()).reasoningEffort, 'off')
  binding = { contextId: 'chat.mobile', kind: 'chat' }
  assert.equal(await request(), config)
  assert.equal(deviceContextAllowed(id), false)
  assert.equal(deviceContextAllowed('chat.mobile'), true)
  assert.deepEqual(companionToolPolicy(id, 'system').allowed, [])
  assert.ok(FeedReplyDecision.safeParse({ decision: 'reply', body: '这是回复。' }).success)
})
