import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompanionStore } from '../src/core/store.ts'
import { registerMemoryRecall, retireStaleRecall } from '../src/host/recall.ts'
import { SessionService } from '../src/host/session.ts'

function fixture(t) {
  const work = resolve('.work')
  mkdirSync(work, { recursive: true })
  const dir = mkdtempSync(join(work, 'memory-recall-'))
  const dbPath = join(dir, 'companion.sqlite')
  const store = new CompanionStore(dbPath)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true })
  })
  const add = (content, options = {}) => store.memory.create({
    content, contextId: 'chat.mobile', kind: 'experience', status: 'active', scope: 'shared', ...options,
  })
  return { store, dbPath, add }
}

function recall(store) {
  let handler
  registerMemoryRecall({ on(name, callback) { assert.equal(name, 'agent/pre-step'); handler = callback } }, store)
  const message = (text, kind = 'user') => createUserMessage({ source: { kind }, content: [{ type: 'text', text }] })
  return async (inputs, {
    turn = 2, step = 1, contextId = 'game.minecraft', signal = new AbortController().signal, admit = items => items, stale = false, session,
  } = {}) => {
    const sessionId = `test:${contextId}`
    store.bindContext({ contextId, sessionId, kind: contextId === 'memory.curator' ? 'system' : 'game', label: contextId })
    const inputsWithIds = inputs.map(input => typeof input === 'string' ? message(input) : input.id ? input : message(input.text, input.kind))
    const messages = admit(inputsWithIds)
    const decision = await handler({ agent: { id: sessionId, session }, messages: stale ? [] : inputsWithIds, turn, step, signal }, async () => ({ kind: 'enter', messages }))
    return decision.messages.slice(messages.length).map(item => item.content[0].text).join('\n')
  }
}

test('identical recent facts are reused from the live surface, corrected or compacted facts are recalled again', async t => {
  const { store, add } = fixture(t)
  const fact = add('蓝宝石在地下仓库\n旁边有雪松标记')
  const session = Session.create(SessionId('test:game.minecraft'))
  const run = recall(store)
  const first = await run(['蓝宝石'], { session })
  assert.match(first, /雪松标记/u)
  const old = session.append('user/message', createUserMessage({ source: { kind: 'companion-memory', form: 'recall', format: 2 },
    content: [{ type: 'text', text: first }] }), { surfaceOp: 'append' })
  assert.equal(await run(['蓝宝石'], { session }), '')
  assert.equal(store.memory.get(fact.id).recallCount, 1)
  assert.equal(store.memory.get(fact.id).reinforcementCount, 1) // Immediate repetitions stay inside the reinforcement cooldown.
  store.memory.update(fact.id, { content: '蓝宝石移到地上仓库', status: 'active' })
  const updated = await run(['蓝宝石'], { session })
  assert.match(updated, /地上仓库/u)
  const current = session.append('user/message', createUserMessage({ source: { kind: 'companion-memory', form: 'recall', format: 2 },
    content: [{ type: 'text', text: updated }] }), { surfaceOp: 'append' })
  assert.equal(await run(['蓝宝石'], { session }), '')
  const replacement = session.surface.nodes[0]
  assert.notEqual(replacement, old.seq)
  session.append('user/message', createUserMessage({ source: { kind: 'compact-checkpoint', compactionId: 'test-compaction' },
    content: [{ type: 'text', text: '此前谈到过物品整理。' }] }),
  { surfaceOp: { op: 'replace', startSeq: replacement, endSeq: current.seq }, sourceEventSeqs: [replacement, current.seq] })
  assert.match(await run(['蓝宝石'], { session }), /地上仓库/u)
  assert.equal(store.memory.get(fact.id).recallCount, 3)
})

test('memory lifecycle withdraws stale automatic facts outside the recent window and keeps unrelated context', async t => {
  for (const [label, update] of [
    ['corrected', (memory, id) => memory.update(id, { content: '北极灯塔记录已纠正' })],
    ['forgotten', (memory, id) => memory.update(id, { status: 'forgotten' })],
    ['archived', (memory, id) => memory.archive(id)],
    ['candidate again', (memory, id) => memory.update(id, { status: 'candidate' })],
    ['private again', (memory, id) => memory.update(id, { scope: 'context', contextId: 'chat.mobile' })],
  ]) await t.test(label, async t => {
    const { store, add } = fixture(t)
    const fact = add('北极灯塔旧暗号 QA-SECRET\n另一行也必须退出')
    const neighbor = add('北极灯塔由石砖围起来 QA-KEEP')
    const id = SessionId('test:game.minecraft')
    const session = Session.create(id)
    const run = recall(store)
    const first = await run([{ kind: 'companion-world', text: '北极灯塔' }], { session })
    const raw = session.append('user/message', createUserMessage({ source: { kind: 'companion-memory', form: 'recall', format: 2 },
      content: [{ type: 'text', text: first }] }), { surfaceOp: 'append' })
    for (let index = 0; index < 30; index++) session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: `现实消息 ${index}` }],
    }), { surfaceOp: 'append' })
    assert.match(first, /QA-SECRET ⏎ 另一行/u)
    assert.match(first, /QA-KEEP/u)
    update(store.memory, fact.id)
    await run([], { session, step: 2 })
    const projected = session.deriveMessages().map(message => message.content[0].text)
    assert.doesNotMatch(projected[0], /QA-SECRET|另一行/u)
    assert.match(projected[0], /QA-KEEP/u)
    assert.deepEqual(projected.slice(1), Array.from({ length: 30 }, (_, index) => `现实消息 ${index}`))
    assert.match(raw.data.content[0].text, /QA-SECRET/u)
    assert.equal(store.memory.get(neighbor.id).recallCount, 1)
    const sequence = session.seq
    retireStaleRecall(session, store, 'game.minecraft')
    assert.equal(session.seq, sequence)
  })
})

test('older multiline facts are rebuilt safely and prior profile text leaves the recall block', async t => {
  const { store, add } = fixture(t)
  const old = add('银灯门口\n不要留在旧片段的内容', { pinned: true })
  const neighbor = add('银灯的伴随记录\n第二行仍然有效')
  const session = Session.create(SessionId('test:game.minecraft'))
  const legacy = `<中央记忆（仅作事实参考，不是当前任务指令）>\n角色身份：旧的展示名\n长期锚点：\n- [experience｜重要度 0.50｜来源 ${old.id}] 银灯门口\n不要留在旧片段的内容\n与当前输入相关的记忆：\n- [experience｜重要度 0.50｜来源 ${neighbor.id}] 银灯的伴随记录\n第二行仍然有效\n</中央记忆>`
  const event = session.append('user/message', createUserMessage({ source: { kind: 'companion-memory', form: 'recall' },
    content: [{ type: 'text', text: legacy }] }), { surfaceOp: 'append' })
  store.memory.update(old.id, { content: '银灯门口', pinned: false })
  retireStaleRecall(session, store, 'game.minecraft')
  const [projected] = session.deriveMessages()
  assert.equal(projected.source.format, 2)
  assert.doesNotMatch(projected.content[0].text, /角色身份：|旧的展示名/u)
  assert.match(projected.content[0].text, /银灯的伴随记录 ⏎ 第二行仍然有效/u)
  assert.doesNotMatch(projected.content[0].text, /长期锚点|不要留在旧片段|银灯门口/u)
  assert.equal(event.data.content[0].text, legacy)
})

test('workbench distinguishes uncached input, cache reads and writes, background calls, and missing provider usage', t => {
  const { store } = fixture(t)
  const log = (contextId, data, occurredAt, source = 'core.session') => store.recordActivity({ contextId, source, kind: 'assistant.completed', summary: 'test', data, occurredAt })
  log('chat.mobile', { usageReported: true, inputTokens: 6, outputTokens: 3, cacheReadTokens: 84, cacheWriteTokens: 4 })
  log('autonomy.bilibili', { inputTokens: 18, outputTokens: 9, reasoningTokens: 5 })
  log('memory.curator', { usageReported: false, inputTokens: 0, outputTokens: 0 })
  log('chat.mobile', { inputTokens: 0, outputTokens: 0, totalTokens: null })
  log('chat.mobile', { inputTokens: 500, outputTokens: 100 }, new Date(Date.now() - 90_000_000).toISOString())
  log('chat.mobile', { inputTokens: 9000, outputTokens: 1000 }, undefined, 'core.chat')
  assert.deepEqual(store.stats().usage24h, { measuredCalls: 2, unmeteredCalls: 2, uncachedInputTokens: 24, cacheReadTokens: 84,
    cacheWriteTokens: 4, outputTokens: 12, backgroundCalls: 1, backgroundUncachedInputTokens: 18,
    byContext: [
      { contextId: 'autonomy.bilibili', measuredCalls: 1, unmeteredCalls: 0, uncachedInputTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 9, reasoningTokens: 5 },
      { contextId: 'chat.mobile', measuredCalls: 1, unmeteredCalls: 1, uncachedInputTokens: 6, cacheReadTokens: 84, cacheWriteTokens: 4, outputTokens: 3, reasoningTokens: null },
      { contextId: 'memory.curator', measuredCalls: 0, unmeteredCalls: 1, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: null },
    ] })
  assert.equal(store.stats().inputTokens, 524)
})

test('search ranks outside the display limit, matches full-width names and filters private and forgotten rows', t => {
  const { store, add } = fixture(t)
  const match = add('采过一块 ＱＡ-Quartz 矿石', { importance: 0.1 })
  const privateMemory = add('QA-Quartz 私下笔记', { scope: 'context', importance: 1 })
  const forgotten = add('QA-Quartz 已遗忘', { status: 'forgotten', importance: 1 })
  const candidate = add('QA-Quartz 尚未核实', { status: 'candidate', importance: 1 })
  for (let index = 0; index < 510; index++) add(`普通原木存货 ${index}`, { importance: 0.95 })
  const options = { contextId: 'game.minecraft', limit: 1 }
  assert.deepEqual(store.memory.find('QA-Quartz', options).map(item => item.id), [match.id])
  assert.equal(store.memory.get(match.id).recallCount, 0)
  assert.deepEqual(store.memory.search('QA-Quartz', options).map(item => item.id), [match.id])
  assert.equal(store.memory.get(match.id).recallCount, 1)
  for (const item of [privateMemory, forgotten, candidate]) assert.equal(store.memory.get(item.id).recallCount, 0)
  assert.equal(store.memory.find('QA-Quartz', { ...options, contextId: 'chat.mobile' })[0].id, privateMemory.id)
  assert.ok(store.memory.find('QA-Quartz', { ...options, status: 'active+candidate' }).some(item => item.id === candidate.id))
})

test('recall uses the newest user input and skips greetings, internal curator work and aborted steps', async t => {
  const { store, add } = fixture(t)
  const old = add('红石矿在下界传送门附近')
  const current = add('蓝宝石在地下仓库')
  const run = recall(store)
  const text = await run(['红石矿', '蓝宝石', { kind: 'companion-memory', text: '红石矿' }])
  assert.match(text, /蓝宝石/u)
  assert.doesNotMatch(text, /红石矿/u)
  assert.equal(await run(['蓝宝石', '你好！']), '')
  assert.equal(await run(['蓝宝石'], { contextId: 'memory.curator', turn: 1 }), '')
  assert.equal(await run(['蓝宝石'], { step: 2 }), '')
  assert.equal(await run(['蓝宝石'], { signal: AbortSignal.abort() }), '')
  assert.equal(store.memory.get(old.id).recallCount, 0)
  assert.equal(store.memory.get(current.id).recallCount, 1)
  assert.equal(store.memory.get(current.id).reinforcementCount, 1)
  assert.equal(store.memory.get(old.id).reinforcementCount, 0)
})

test('replayed and rewritten input cannot trigger recall or reinforcement', async t => {
  const { store, add } = fixture(t)
  const fact = add('蓝宝石在地下仓库')
  const run = recall(store)
  assert.equal(await run(['蓝宝石'], { stale: true }), '')
  assert.equal(await run(['蓝宝石', '最新问题'], { admit: items => items.slice(0, 1) }), '')
  assert.equal(await run(['另一个问题'], { admit: items => [{ ...items[0], content: [{ type: 'text', text: '蓝宝石' }] }] }), '')
  assert.equal(await run([{ kind: 'companion-memory', text: '蓝宝石' }]), '')
  assert.equal(store.memory.get(fact.id).recallCount, 0)
  assert.equal(store.memory.get(fact.id).reinforcementCount, 0)
})

test('phone recall reinforces only delivered shared matches; explicit lookup and automatic anchors do not', async t => {
  const { store, add } = fixture(t)
  const shared = add('Coopcraft 里找到蓝宝石', { contextId: 'game.minecraft' })
  const privateFact = add('蓝宝石私下记号', { scope: 'context', contextId: 'game.minecraft' })
  const anchor = add('创作偏好保持中文', { pinned: true })
  const archived = add('蓝宝石旧路径')
  store.memory.archive(archived.id, '归档测试')
  const run = recall(store)
  const phone = await run([{ kind: 'companion-mobile', text: '蓝宝石' }], { contextId: 'chat.mobile', turn: 1 })
  assert.match(phone, /Coopcraft/u)
  assert.match(phone, /创作偏好/u)
  assert.doesNotMatch(phone, /私下记号|旧路径/u)
  assert.equal(store.memory.get(shared.id).reinforcementCount, 1)
  assert.equal(store.memory.get(anchor.id).recallCount, 1)
  assert.equal(store.memory.get(anchor.id).reinforcementCount, 0)
  assert.equal(store.memory.get(privateFact.id).reinforcementCount, 0)
  assert.equal(store.memory.get(archived.id).recallCount, 0)

  const lookup = store.memory.search('蓝宝石', { status: 'active+candidate', contextId: 'game.minecraft' })
  assert.ok(lookup.some(item => item.id === privateFact.id))
  assert.ok(!lookup.some(item => item.id === archived.id))
  assert.equal(store.memory.get(privateFact.id).reinforcementCount, 0)
  assert.match(await run(['蓝宝石']), /私下记号/u)
  assert.equal(store.memory.get(privateFact.id).reinforcementCount, 1)
  assert.equal(store.memory.get(shared.id).reinforcementCount, 1)
})

test('lexical recall offers a secondary trait across scenes and keeps the source wording in its own scene', async t => {
  const { store } = fixture(t)
  const content = '遇到私下的 QA-HARBOR 话题时，我会先问清楚港口安排。'
  const note = store.selfNotes.create({ content, basis: 'inference', createdBy: 'companion', trait: 'ask-before-assuming',
    evidence: ['私人原文我会先问清楚'], evidenceRefs: [{ quoteIndex: 0, messageId: 'exact-phone-message', role: 'assistant' }],
    sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'test:chat.mobile', eventSeq: 42 }],
  })
  store.selfNotes.create({ content: 'QA-SECOND-NOTE', basis: 'inference', createdBy: 'companion', trait: 'follow-through',
    evidence: ['QA-SECOND-QUOTE'], evidenceRefs: [{ quoteIndex: 0, messageId: 'second-phone-message', role: 'assistant' }],
    sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'test:chat.mobile', eventSeq: 43 }],
  })
  store.selfNotes.create({ content: '主人反馈说先问清楚 QA-HARBOR', basis: 'user-feedback', createdBy: 'owner' })
  const run = recall(store)
  assert.equal(await run(['你好'], { turn: 1 }), '')
  assert.equal(await run(['你好'], { turn: 2 }), '')
  assert.equal(await run(['说到的事跟进到结果']), '')
  const game = await run([{ kind: 'companion-world', text: '信息不足时先问清楚' }])
  assert.match(game, /相关自我观察.*\n- 信息不足时先问清楚/u)
  assert.doesNotMatch(game, /QA-HARBOR|exact-phone-message/u)
  const sameScene = await run(['QA-HARBOR'], { contextId: 'chat.mobile' })
  assert.match(sameScene, /先问清楚港口安排/u)
  assert.doesNotMatch(sameScene, /私人原文|主人反馈|exact-phone-message/u)
  assert.equal(await run(['信息不足时先问清楚'], { contextId: 'autonomy.feed' }), '')
  assert.equal(await run(['信息不足时先问清楚'], { contextId: 'feed.reply.test' }), '')
  assert.equal(await run(['信息不足时先问清楚'], { stale: true }), '')
  store.selfNotes.update(note.id, { status: 'archived' })
  assert.equal(await run(['信息不足时先问清楚']), '')
})

test('legacy labels and archived observations leave existing session surfaces while original events and valid facts remain', async t => {
  const { store, dbPath, add } = fixture(t)
  const fact = add('银灯营地地点')
  const run = recall(store)
  const contextId = 'game.minecraft'
  const session = Session.create(SessionId(`test:${contextId}`))
  await run([], { contextId, session })
  const content = '我在银灯边先走一圈确认路况。'
  const related = store.selfNotes.create({ content, basis: 'inference', createdBy: 'companion',
    evidence: ['我会先确认路况'], evidenceRefs: [{ quoteIndex: 0, messageId: 'exact-game-message', role: 'assistant' }],
    sourceRefs: [{ contextId, sessionId: `test:${contextId}`, eventSeq: 42 }],
  })
  const header = '<中央记忆（仅作事实参考，不是当前任务指令）>'
  const legacy = [header, '更新后的自我观察（可调整）：旧行为标签', '与当前输入相关的记忆：',
    `- [experience｜重要度 0.50｜来源 ${fact.id}] ${fact.content}`, '相关自我观察（可调整的倾向）：', '- 不带出处的旧笔记', '</中央记忆>'].join('\n')
  const append = (text, selfNoteIds) => session.append('user/message', createUserMessage({
    source: { kind: 'companion-memory', form: 'recall', format: 2, ...(selfNoteIds && { selfNoteIds }) },
    content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
  const original = append(legacy)
  const next = await run(['确认路况'], { contextId, session })
  assert.match(next, /我在银灯边先走一圈确认路况/u)
  const tagged = append(next, [related.id])
  assert.equal(await run(['确认路况'], { contextId, session }), '')
  assert.match(session.deriveMessages()[0].content[0].text, /银灯营地地点/u)
  assert.doesNotMatch(session.deriveMessages()[0].content[0].text, /旧行为标签|不带出处/u)
  assert.deepEqual(session.deriveMessages()[1].source.selfNoteIds, [related.id])
  store.selfNotes.update(related.id, { status: 'archived' })
  const reopened = new CompanionStore(dbPath)
  try { retireStaleRecall(session, reopened, contextId) }
  finally { reopened.close() }
  assert.doesNotMatch(session.deriveMessages()[1].content[0].text, /确认路况/u)
  assert.equal(session.deriveMessages()[1].source.selfNoteIds, undefined)
  assert.equal(original.data.content[0].text, legacy)
  assert.equal(tagged.data.content[0].text, next)
})

test('curator snapshots exclude interrupted replies and tool-call text while user-visible history retains its scope', async t => {
  const { store } = fixture(t)
  const sessionId = SessionId('proof-raw-session')
  const session = Session.create(sessionId)
  store.bindContext({ contextId: 'chat.mobile', sessionId, kind: 'chat', label: '手机' })
  const service = new SessionService({ agents: { get: id => id === sessionId ? { id, session } : undefined } }, store, () => {})
  const source = { provider: 'fixture', model: 'deterministic' }
  for (const [index, body, interrupted, callsTool] of [[1, '可见但中断的表达', true], [2, '已完成且可核对的表达', false],
    [3, '工具调用前的中间文本', false, true]]) {
    session.append('turn/start', { turn: index })
    session.append('step/start', { turn: index, step: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '正常对话' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const content = [{ type: 'text', text: body }]
    if (callsTool) content.push({ type: 'tool-call', id: 'proof-tool', name: 'fixture_tool', arguments: '{}' })
    session.append('assistant/message', { turn: index, step: 1, message: createAssistantMessage({ source, content }), stream: [],
      ...(interrupted && { interrupted: true }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: index, step: 1 })
    session.append('turn/end', { turn: index, reason: { kind: 'completed' } })
  }
  const history = await service.history('chat.mobile')
  assert.ok(history.messages.some(message => message.text === '可见但中断的表达'))
  assert.ok(history.messages.some(message => message.text === '工具调用前的中间文本'))
  const reviewed = await service.reviewSnapshot('chat.mobile', sessionId, Number(session.seq) - 1)
  assert.ok(reviewed.messages.some(message => message.text === '已完成且可核对的表达'))
  assert.ok(reviewed.messages.every(message => message.text !== '可见但中断的表达'))
  assert.ok(reviewed.messages.every(message => message.text !== '工具调用前的中间文本'))
})

test('the game event bridge preserves visible recall without counting synthetic prompt text as recurrence', async t => {
  const { store, add } = fixture(t)
  const fact = add('红树林营地拥有深色木板')
  const sessionId = SessionId('test:game.minecraft')
  const session = Session.create(sessionId)
  store.bindContext({ contextId: 'game.minecraft', sessionId, kind: 'game', label: 'Minecraft' })
  let forwarded
  const agent = { id: sessionId, session, followup(message) {
    forwarded = message
    session.append('user/message', message, { surfaceOp: 'append' })
  } }
  const service = new SessionService({ agents: { get: id => id === sessionId ? agent : undefined } }, store, () => {})
  await service.send('game.minecraft', 'Minecraft 现场观察：红树林营地', 'world')
  assert.deepEqual(forwarded.source, { kind: 'companion-world', form: 'minecraft-event' })
  assert.deepEqual((await service.history('game.minecraft')).messages.map(item => item.text), ['Minecraft 现场观察：红树林营地'])
  const run = recall(store)
  assert.match(await run([forwarded]), /深色木板/u)
  assert.equal(store.memory.get(fact.id).recallCount, 1)
  assert.equal(store.memory.get(fact.id).reinforcementCount, 0)
  assert.match(await run(['红树林营地']), /深色木板/u)
  assert.equal(store.memory.get(fact.id).reinforcementCount, 1)
})

test('recent recall lifts ranking without changing importance or confidence', t => {
  const { store, dbPath, add } = fixture(t)
  const oldest = add('雪松地点在东门', { importance: 0.5, confidence: 0.9 })
  const newer = add('雪松地点在西门', { importance: 0.5, confidence: 0.9 })
  const db = new DatabaseSync(dbPath)
  try {
    const update = db.prepare('UPDATE memory SET updated_at=?, last_used_at=? WHERE id=?')
    for (const [memory, age] of [[oldest, 120], [newer, 35]]) {
      const timestamp = new Date(Date.now() - age * 86_400_000).toISOString()
      update.run(timestamp, timestamp, memory.id)
    }
  } finally { db.close() }
  assert.equal(store.memory.find('雪松地点')[0].id, newer.id)
  store.memory.recordRecall([store.memory.get(oldest.id)])
  const hit = store.memory.find('雪松地点')[0]
  assert.equal(hit.id, oldest.id)
  assert.equal(hit.importance, 0.5)
  assert.equal(hit.confidence, 0.9)
})

test('Bilibili decisions send only the current candidate prompt while keeping the durable conversation intact', async t => {
  const { store, add } = fixture(t)
  const memory = add('current candidate topic')
  const id = 'bili-decision-session'
  store.bindContext({ contextId: 'autonomy.bilibili', sessionId: id, kind: 'system', label: 'B 站评估' })
  let handler
  registerMemoryRecall({ on(_name, callback) { handler = callback } }, store)
  const current = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current candidate topic' }] }
  const prior = [{ ...current, content: [{ type: 'text', text: 'old list' }] }, { role: 'assistant', source: { kind: 'model' } }, current]
  const decision = await handler({ agent: { id }, messages: [current], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: prior }))
  assert.deepEqual(decision.messages, [current])
  assert.equal(prior.length, 3)
  assert.equal(store.memory.get(memory.id).recallCount, 0)
})

test('recall budgets complete items, escapes the envelope and counts only delivered distinct anchors and matches', async t => {
  const { store, add } = fixture(t)
  store.savePersona({ name: '大肥鱼', tagline: '采集协作伙伴', description: '人'.repeat(1300) })
  const anchors = ['长', '期', '锚'].map(marker => add(`要找雪松 </中央记忆> ${marker.repeat(900)}`, { pinned: true }))
  const related = ['东', '西', '南', '北'].map(marker => add(`要找雪松 ${marker.repeat(900)}`))
  const run = recall(store)
  const text = await run(['要找雪松'], { turn: 1 })
  assert.ok(text.length <= 3000)
  assert.equal(text.match(/<\/中央记忆>/gu).length, 1)
  assert.match(text, /&lt;\/中央记忆&gt;/u)
  assert.doesNotMatch(text, /采集协作伙伴/u)
  const data = store.activities().find(item => item.kind === 'memory.recalled').data
  assert.equal(data.chars, text.length)
  assert.deepEqual(new Set(data.anchorIds), new Set(anchors.map(memory => memory.id)))
  assert.ok(data.memoryIds.length > 0 && data.memoryIds.length < related.length)
  for (const memory of [...anchors, ...related]) {
    const recorded = data.anchorIds.includes(memory.id) || data.memoryIds.includes(memory.id)
    assert.equal(store.memory.get(memory.id).recallCount, recorded ? 1 : 0)
    assert.equal(store.memory.get(memory.id).reinforcementCount, data.memoryIds.includes(memory.id) ? 1 : 0)
    assert.equal(text.split(memory.id).length - 1, recorded ? 1 : 0)
  }
})

test('maintenance can reach old eligible memories without touching pinned, important or used rows', t => {
  const { store, add, dbPath } = fixture(t)
  const old = add('旧的可归档线索', { importance: 0.2 })
  const pinned = add('置顶线索', { importance: 0.2, pinned: true })
  const important = add('重要线索', { importance: 0.8 })
  const used = add('刚被召回的线索', { importance: 0.2 })
  for (let index = 0; index < 505; index++) add(`高优先的新线索 ${index}`, { importance: 0.9 })
  const db = new DatabaseSync(dbPath)
  try {
    const update = db.prepare('UPDATE memory SET updated_at=? WHERE id=?')
    for (const item of [old, pinned, important, used]) update.run('2025-01-01T00:00:00.000Z', item.id)
  } finally { db.close() }
  store.memory.recordRecall([used, used])
  assert.equal(store.memory.get(used.id).recallCount, 1)
  assert.equal(store.memory.maintain(new Date('2026-11-09T00:00:00Z')), 1)
  assert.equal(store.memory.get(old.id).status, 'forgotten')
  assert.equal(store.memory.revisions(old.id).length, 2)
  for (const item of [pinned, important, used]) assert.equal(store.memory.get(item.id).status, 'active')
})


test('compact game turns recall the owner’s actual words and ignore the fixed envelope', async t => {
  const { store, add } = fixture(t)
  add('Minecraft 主人消息格式的测试记录')
  add('海岸灯塔的门牌是一颗绿宝石')
  const run = recall(store)
  assert.equal(await run([{ kind: 'companion-world', text: 'Minecraft 主人消息：["你好"]' }]), '')
  const output = await run([{ kind: 'companion-world', text: 'Minecraft 主人消息：["海岸灯塔在哪里"]' }])
  assert.match(output, /绿宝石/u)
  assert.doesNotMatch(output, /消息格式的测试记录/u)
})
