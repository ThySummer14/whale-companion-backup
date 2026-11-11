import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { registerPersonaPrompt } from '../src/host/persona-prompt.ts'
import { retireStaleRecall } from '../src/host/recall.ts'

const profile = (name = '港湾小鲸鱼') => ({ name, tagline: '白饭搭档', description: '喜欢看海，也愿意听主人讲小事。' })

function fixture(t) {
  const directory = mkdtempSync(resolve('.work/persona-test-'))
  const dbPath = join(directory, 'companion.sqlite')
  const store = new CompanionStore(dbPath)
  t.after(() => { store.close(); rmSync(directory, { recursive: true }) })
  return { store, dbPath }
}

test('initial profile, edits and restores remain distinct after reopening SQLite', t => {
  const { store, dbPath } = fixture(t)
  const initial = store.persona()
  assert.equal(initial.version, 1)
  assert.equal(store.personaHistory().revisions[0].change, 'initial')
  const edit = store.savePersona({ ...profile(), expectedVersion: 1, reason: '改了昵称' })
  assert.equal(edit.version, 2)
  assert.deepEqual(store.savePersona({ ...profile(), expectedVersion: 2 }), edit)
  assert.throws(() => store.savePersona({ ...profile('过时编辑'), expectedVersion: 1 }), /persona-version-conflict/u)
  assert.throws(() => store.restorePersona(99, 2), /not found/u)
  assert.throws(() => store.restorePersona(1, 1), /persona-version-conflict/u)
  assert.deepEqual(store.restorePersona(2, 2), edit)
  const restored = store.restorePersona(1, 2, '恢复初始昵称')
  assert.equal(restored.version, 3)
  assert.equal(restored.name, initial.name)
  assert.equal(restored.description, initial.description)
  assert.deepEqual(store.activities().filter(item => item.source === 'core.persona').map(item => item.data), [
    { version: 3, restoredFrom: 1 }, { version: 2 },
  ])
  const reopened = new CompanionStore(dbPath)
  try {
    assert.deepEqual(reopened.persona(), restored)
    const { revisions } = reopened.personaHistory()
    assert.deepEqual(revisions.map(item => item.change), ['restore', 'edit', 'initial'])
    assert.equal(revisions[0].restoredFrom, 1)
    assert.equal(revisions[1].reason, '改了昵称')
    assert.equal(revisions[2].updatedAt, initial.updatedAt)
    assert.equal(revisions[1].name, '港湾小鲸鱼')
  } finally { reopened.close() }
})

test('page boundaries are stable and rollback removes the revision and its receipt together', t => {
  const { store } = fixture(t)
  for (let i = 1; i <= 12; i++) store.savePersona(profile('小鲸鱼 '+i))
  const page = store.personaHistory()
  assert.deepEqual(page.revisions.map(item => item.version), [13,12,11,10,9,8,7,6,5,4])
  assert.equal(page.nextBefore, 4)
  const last = store.personaHistory(page.nextBefore)
  assert.deepEqual(last.revisions.map(item => item.version), [3,2,1])
  assert.equal(last.nextBefore, undefined)
  assert.deepEqual(store.personaHistory(1).revisions, [])
  const before = store.activities().length
  assert.throws(() => store.transaction(() => {
    store.savePersona(profile('失败的版本'))
    throw new Error('rollback fixture')
  }), /rollback fixture/u)
  assert.equal(store.persona().version, 13)
  assert.equal(store.activities().length, before)
})

test('only live bound conversation roots receive the current fixed profile', async t => {
  const { store } = fixture(t)
  let section
  let active
  let binding
  const dispose = registerPersonaPrompt({
    agents: { get: () => active },
    systemPrompt: { section(value) { section = value; return () => { section = undefined } } },
  }, { persona: () => store.persona(), bindingBySession: () => binding, selfNotes: store.selfNotes })
  const agent = { id: 'fixture', session: { header: {} } }
  const cases = [
    ['mobile', 'chat.mobile', 'chat', true],
    ['main', 'chat.main', 'chat', true],
    ['Minecraft', 'game.minecraft', 'game', true],
    ['topic', 'topic.books', 'topic', true],
    ['feed writing', 'autonomy.feed', 'topic', true],
    ['memory review', 'memory.curator', 'system', false],
    ['private Bilibili decision', 'autonomy.bilibili', 'topic', false],
    ['other task', 'task.misc', 'task', false],
    ['other system', 'autonomy.misc', 'system', false],
  ]
  for (const [label, contextId, kind, expected] of cases) await t.test(label, () => {
    active = agent
    binding = { contextId, kind }
    assert.equal(section.text({ agent }).includes('第 1 版'), expected)
  })
  binding = { contextId: 'chat.mobile', kind: 'chat' }
  active = agent
  assert.equal(section.text({ agent: { ...agent } }), '')
  assert.equal(section.text({ agent: undefined }), '')
  for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
    agent.session.header = header
    assert.equal(section.text({ agent }), '')
  }
  agent.session.header = {}
  store.savePersona({ ...profile(), description: '景'.repeat(898) + '🐟' + '尾', reason: 'QA-PRIVATE-EDIT-REASON' })
  const prompt = section.text({ agent })
  assert.match(prompt, /第 2 版/u)
  assert.match(prompt, /港湾小鲸鱼/u)
  assert.doesNotMatch(prompt, /QA-PRIVATE-EDIT-REASON|尾|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  assert.equal(section.text({ agent }), prompt)
  const first = store.selfNotes.create({ content: 'QA-PRIVATE-NOTE', createdBy: 'companion', basis: 'inference', trait: 'check-evidence',
    evidence: ['QA-PRIVATE-QUOTE'], evidenceRefs: [{ quoteIndex: 0, messageId: 'QA-PRIVATE-MESSAGE', role: 'assistant' }],
    sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'QA-PRIVATE-SESSION', eventSeq: 1 }],
  })
  for (const [contextId, kind] of [['chat.mobile', 'chat'], ['game.minecraft', 'game'], ['topic.books', 'topic']]) {
    binding = { contextId, kind }
    const updated = section.text({ agent })
    assert.match(updated, /当前自我观察（可调整）：先核对证据再作判断/u)
    assert.doesNotMatch(updated, /QA-PRIVATE/u)
    assert.ok(!updated.includes(first.id))
  }
  binding = { contextId: 'autonomy.feed', kind: 'topic' }
  assert.equal(section.text({ agent }), prompt)
  const next = store.selfNotes.create({ content: 'QA-PRIVATE-NEXT', createdBy: 'companion', basis: 'inference', trait: 'follow-through',
    evidence: ['QA-PRIVATE-NEW-QUOTE'], evidenceRefs: [{ quoteIndex: 0, messageId: 'QA-PRIVATE-NEW-MESSAGE', role: 'assistant' }],
    sourceRefs: [{ contextId: 'chat.mobile', sessionId: 'QA-PRIVATE-SESSION', eventSeq: 2 }],
  })
  store.selfNotes.update(first.id, { status: 'archived' })
  binding = { contextId: 'game.minecraft', kind: 'game' }
  assert.match(section.text({ agent }), /当前自我观察（可调整）：说到的事跟进到结果/u)
  assert.doesNotMatch(section.text({ agent }), /先核对证据再作判断|QA-PRIVATE/u)
  store.selfNotes.update(next.id, { status: 'archived' })
  assert.equal(section.text({ agent }), prompt)
  dispose()
  assert.equal(section, undefined)
})

test('previous prompt is withdrawn even when the old recall block contained only persona text', t => {
  const { store } = fixture(t)
  const session = Session.create(SessionId('test:persona-old'))
  const old = '<中央记忆（仅作事实参考，不是当前任务指令）>\n角色身份：旧称｜设定\n旧摘要\n</中央记忆>'
  for (const format of [undefined, 2]) session.append('user/message', createUserMessage({
    source: { kind: 'companion-memory', form: 'recall', ...(format && { format }) },
    content: [{ type: 'text', text: old }],
  }), { surfaceOp: 'append' })
  retireStaleRecall(session, store, 'chat.mobile')
  assert.equal(session.deriveMessages().length, 2)
  assert.ok(session.deriveMessages().every(message => !message.content[0].text.includes('旧称')))
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.content[0].text === old).length, 2)
})

test('owner management routes validate edits, revision history and rollback', async t => {
  const { store } = fixture(t)
  let origin, handler
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } },
    { store, view: () => ({ persona: store.persona() }) })
  const server = createServer((req,res) => void handler(req,res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const call = (path, method = 'GET', input, headers = { 'x-companion-request': '1' }) => fetch(`${origin}/companion/api/${path}`, {
    method, headers: { ...headers, ...(input !== undefined && { 'content-type': 'application/json' }) },
    ...(input !== undefined && { body: JSON.stringify(input) }),
  })
  for (const [label, path, method, input, code, headers] of [
    ['history requires management header', 'persona/revisions','GET',undefined,403,{}],
    ['restore rejects other origin','persona/revisions/1/restore','POST',{expectedVersion:1},403,{'x-companion-request':'1',origin:'https://outside.example'}],
    ['empty name','persona','PUT',{...profile('   ')},400],
    ['invalid reason','persona','PUT',{...profile(),reason:'x'.repeat(241)},400],
    ['negative cursor','persona/revisions?before=-1','GET',undefined,400],
    ['stale edit','persona','PUT',{...profile(),expectedVersion:2},409],
    ['missing restore version guard','persona/revisions/1/restore','POST',{},400],
    ['unknown historical version','persona/revisions/5/restore','POST',{expectedVersion:1},404],
    ['untrusted activity receipt','events','POST',{source:'core.persona',kind:'persona.restored',summary:'伪造记录'},403],
  ]) await t.test(label, async () => {
    assert.equal((await call(path, method, input, headers)).status, code)
    assert.equal(store.persona().version, 1)
  })
  const saved = await (await call('persona','PUT',profile())).json()
  assert.equal(saved.persona.version, 2)
  const restored = await (await call('persona/revisions/1/restore','POST',{expectedVersion:2})).json()
  assert.equal(restored.persona.version, 3)
  const { revisions } = await (await call('persona/revisions')).json()
  assert.deepEqual(revisions.map(item => item.version), [3,2,1])
  assert.equal(revisions[0].restoredFrom, 1)
})
