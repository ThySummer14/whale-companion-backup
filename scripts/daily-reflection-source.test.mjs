import assert from 'node:assert/strict'
import { reflectionPredecessors, restoreLegacyReflectionReceipt } from '../src/host/daily-reflection-context.ts'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('reflection selects bounded related earlier experiences and leaves out later receipts', () => {
  const fact = '营地复访核对施工回执'
  const earlier = '2026-11-09T00:00:00.000Z'
  const current = '2026-11-10T00:00:00.000Z'
  const later = '2026-11-11T00:00:00.000Z'
  const note = (id, kind, text, at = earlier) => ({ id, content: text, experience: { kind },
    ...(at && { experienceReceipt: { at, fact: text } }) })
  const notes = [note('later', 'house', fact, later), note('unrelated', 'bilibili', '歌曲谱面'),
    note('house', 'house', '完成木屋'), note('reading', 'bilibili', fact), note('same-time', 'survey', fact, current),
    note('legacy', 'survey', '看过旧营地', ''), note('supply', 'supply', '补给营地木板'), note('overflow', 'build', '营地搭建')]
  const selected = reflectionPredecessors(notes, { at: current, fact, experience: { kind: 'camp-project' } })
  assert.deepEqual(selected.map(item => item.id), ['house', 'legacy', 'supply', 'reading'])
})
import { surveyWindowKey } from '../src/core/minecraft-survey-window.ts'
import { BILIBILI_AUTONOMY_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, MINECRAFT_SUPPLY_CONTEXT } from '../src/core/model.ts'
import { CompanionStore } from '../src/core/store.ts'
import { recentDailyInitiativeEvidence } from '../src/host/daily-initiative-evidence.ts'
import { verifiedDailyReflectionSource } from '../src/host/daily-reflection-source.ts'

const DAY = '2026-11-09'
const BVID = 'BV1dLx46TEhw'
const CUE = '私有自制字幕，不应出现在复盘提示里。'
const HASH = 'a'.repeat(64)

function fixture(t) {
  let now = Date.parse(`${DAY}T08:00:00.000Z`)
  t.mock.timers.enable({ apis: ['Date'], now })
  const directory = mkdtempSync('.work/daily-reflection-source-')
  const store = new CompanionStore(join(directory, 'reflection.db'))
  const ruleId = randomUUID()
  const expiresAt = now + 45 * 60_000
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

  function advance(ms = 1_000) {
    now += ms
    t.mock.timers.setTime(now)
  }

  function start(input) {
    const job = store.autonomy.create({ ...input, runAfter: now, maxAttempts: 1 })
    store.transitionTask(job.id, 'running')
    return job
  }

  function choose(choice, options = {}) {
    const date = options.date ?? DAY
    return start({ kind: 'daily.choice', contextId: options.contextId ?? DAILY_AUTONOMY_CONTEXT, dedupeKey: options.key ?? `daily:${date}`,
      payload: { windowRuleId: ruleId, date, expiresAt: options.expiresAt ?? expiresAt, choice } })
  }

  function finish(daily, child, status = 'succeeded') {
    store.autonomy.update(daily.id, { payload: { ...daily.payload, activityTaskId: child.id } })
    advance()
    store.transitionTask(daily.id, status)
  }

  function survey(options = {}) {
    const daily = choose('survey', options)
    advance()
    const child = start({ kind: 'minecraft.supply', contextId: MINECRAFT_SUPPLY_CONTEXT,
      dedupeKey: options.childKey ?? surveyWindowKey(DAY), payload: {} })
    advance()
    const receipt = store.createTask({ capabilityId: options.capability ?? 'minecraft.survey', contextId: 'game.minecraft', title: 'Private player at XYZ 19 64 23' })
    store.transitionTask(receipt.id, 'running')
    advance()
    store.transitionTask(receipt.id, options.receiptStatus ?? 'succeeded')
    advance()
    store.autonomy.update(child.id, { payload: {
      windowSurveyZoneId: randomUUID(), windowRuleId: options.childRuleId ?? ruleId, goal: 'survey', expiresAt,
      receiptTaskId: receipt.id, surveyOutcome: options.recovered ? 'recovered' : 'completed',
      ...(options.trail ? { surveyTrail: 'north-east', surveyCheckpoints: options.recovered ? 1 : 2 }
        : { direction: 'east', surveySteps: 5 }),
    } })
    store.transitionTask(child.id, 'succeeded')
    finish(daily, child, options.status)
    return { daily, child, receipt }
  }

  function putSubtitle(sha256) {
    const saved = store.bilibiliSubtitles.save({ bvid: BVID, part: 2, cid: 5, format: 'vtt', sha256, cueCount: 1,
      excerpt: { status: 'excerpt', language: 'zh', truncated: false, cues: [{ from: 1, to: 2, text: CUE }],
        provenance: { kind: 'owner-supplied', sha256 } } })
    assert.ok(saved)
  }

  function read(options = {}) {
    const daily = choose('bilibili', options)
    let source
    let item
    if (options.source) {
      source = store.bilibili.addSource({ mid: '42', seasonId: '123', label: 'Private collection' })
      const claim = store.bilibili.claimDiscovery(now)
      assert.equal(claim.id, source.id)
      assert.equal(store.bilibili.finishDiscovery(source.id, now, { items: [{ bvid: BVID, title: 'Private collection title' }] }), 1)
      item = store.bilibili.view().items[0]
    } else {
      item = store.bilibili.add({ bvid: BVID, part: 2 }, 'Private candidate label')
    }
    if (options.attachment) putSubtitle(HASH)
    advance()
    const child = start({ kind: 'bilibili.review', contextId: BILIBILI_AUTONOMY_CONTEXT,
      dedupeKey: options.childKey ?? `${daily.dedupeKey}:bilibili`, payload: {} })
    assert.equal(store.bilibili.begin(item.id), true)
    advance()
    const at = new Date(now).toISOString()
    const kind = options.metadata ? 'video.inspected' : 'video.subtitle-read'
    const provenance = options.attachment ? { kind: 'owner-supplied', sha256: HASH } : undefined
    const activityId = store.recordActivity({
      source: 'media.bilibili', contextId: BILIBILI_AUTONOMY_CONTEXT, sessionId: 'private-reading-session', occurredAt: at, kind,
      summary: `Private path /tmp/stored-subtitle.vtt. ${CUE}`,
      status: 'success', data: { candidateId: item.id, bvid: item.bvid, part: item.part,
        ...(provenance && { subtitleOrigin: provenance.kind, subtitleSha256: provenance.sha256 }) },
    })
    advance()
    assert.equal(store.bilibili.finish(item.id, { status: 'read', receipt: { kind, at, activityId, provenance } }), true)
    store.autonomy.update(child.id, { payload: { dailyTaskId: options.backref ?? daily.id, candidateId: item.id, activityId } })
    store.transitionTask(child.id, 'succeeded')
    finish(daily, child, options.status)
    return { daily, child, item, activityId, at, source }
  }

  function verify(id, activityById = id => store.activityById(id)) {
    const lookup = { autonomy: store.autonomy, taskById: id => store.taskById(id),
      bilibili: store.bilibili, bilibiliSubtitles: store.bilibiliSubtitles, activityById }
    return verifiedDailyReflectionSource(lookup, id)
  }

  return { store, survey, read, verify, putSubtitle }
}

test('daily reflection trusts a completed worker route without copying task labels or coordinates', t => {
  const { survey, verify } = fixture(t)
  const { daily, child, receipt } = survey()
  assert.deepEqual(verify(daily.id), {
    experience: { kind: 'survey', dailyTaskId: daily.id, activityTaskId: child.id, receiptTaskId: receipt.id },
    at: '2026-11-09T08:00:03.000Z',
    fact: '在 Minecraft 从营地向东步行 5 格探索，然后沿原路安全返回。',
  })
})

test('an older subtitle experience can be compared with a later house receipt after exact provenance is recovered', t => {
  const { read, verify } = fixture(t)
  const { daily, child, activityId, at } = read({ attachment: true })
  const original = { id: 'reading', content: '我愿意仔细核对看见的说法。', trait: 'check-evidence',
    evidenceRefs: [{ role: 'assistant' }], experience: { kind: 'bilibili', dailyTaskId: daily.id, activityTaskId: child.id, activityId } }
  const source = { at: '2026-11-10T00:00:00.000Z', fact: '在 Minecraft 完成木屋。', experience: { kind: 'house' } }
  assert.deepEqual(reflectionPredecessors([original], source), [])
  const verified = restoreLegacyReflectionReceipt(original, verify)
  assert.equal(verified.experienceReceipt.at, at)
  assert.match(verified.experienceReceipt.fact, /主人提供的字幕摘录/u)
  assert.doesNotMatch(verified.experienceReceipt.fact, /私有|stored-subtitle/u)
  assert.equal(original.experienceReceipt, undefined)
  assert.equal(restoreLegacyReflectionReceipt(verified, () => assert.fail('lookup for an existing receipt')), verified)
  const missingTrait = { ...verified, id: 'no-trait', trait: undefined }
  const missingAuthorship = { ...verified, id: 'no-author', evidenceRefs: [{ role: 'user' }] }
  assert.deepEqual(reflectionPredecessors([missingTrait, missingAuthorship, verified], source).map(note => note.id), ['reading'])
  const exact = { ...verified, id: 'lexical', content: source.fact }
  assert.deepEqual(reflectionPredecessors([verified, exact], source).map(note => note.id), ['lexical'])
  assert.deepEqual(reflectionPredecessors([verified], { ...source, at }), [])
  assert.deepEqual(reflectionPredecessors([verified], { ...source, at: 'invalid' }), [])
  for (const mismatch of [{ dailyTaskId: randomUUID() }, { activityTaskId: randomUUID() }, { activityId: activityId + 1 }, { kind: 'survey' }]) {
    const note = { ...original, experience: { ...original.experience, ...mismatch } }
    assert.equal(restoreLegacyReflectionReceipt(note, verify), note)
  }
})

test('an early trail return preserves only its actual checkpoint and recovered status', t => {
  const { survey, verify } = fixture(t)
  const { daily } = survey({ recovered: true, trail: true })
  assert.match(verify(daily.id).fact, /先向北、再向东.*确认 1 个检查点后提前折返/u)
})

test('invalid daily and game task relationships provide no reflection facts', async t => {
  const cases = [
    ['failed daily task', { status: 'failed' }],
    ['forged context', { contextId: 'chat.mobile' }],
    ['forged daily dedupe key', { key: 'daily:fake' }],
    ['impossible calendar day', { date: '2026-02-30' }],
    ['different window authority', { childRuleId: randomUUID() }],
    ['different child calendar day', { childKey: surveyWindowKey('2026-11-08') }],
    ['wrong worker capability', { capability: 'minecraft.craft' }],
    ['failed worker task', { receiptStatus: 'failed' }],
    ['receipt completed at the expiration', { expiresAt: Date.parse(`${DAY}T08:00:03.000Z`) }],
  ]
  for (const [label, options] of cases) await t.test(label, t => {
    const { survey, verify } = fixture(t)
    assert.equal(verify(survey(options).daily.id), undefined)
  })
})

test('the exact Bilibili subtitle receipt is read by ID without copying private labels or text', t => {
  const { store, read, verify } = fixture(t)
  const { daily, child, activityId, at } = read({ attachment: true })
  for (let index = 0; index < 110; index++) store.recordActivity({ source: 'other', kind: 'other', summary: 'Unrelated newer event' })
  assert.deepEqual(verify(daily.id), {
    experience: { kind: 'bilibili', dailyTaskId: daily.id, activityTaskId: child.id, activityId },
    at,
    fact: `阅读了 B 站视频 ${BVID} 第 2 P 的主人提供的字幕摘录。`,
  })
})

test('read metadata alone, a borrowed daily link or a wrong child dedupe key cannot become reading evidence', async t => {
  for (const [label, options] of [['metadata', { metadata: true }], ['borrowed link', { backref: randomUUID() }],
    ['wrong dedupe key', { childKey: 'unrelated-bili-review' }]]) await t.test(label, t => {
    const { read, verify } = fixture(t)
    assert.equal(verify(read(options).daily.id), undefined)
  })
})

test('withdrawal of an attached transcript or its collection invalidates delayed reflection', async t => {
  await t.test('remove and replace local attachment', t => {
    const { store, read, verify, putSubtitle } = fixture(t)
    const { daily } = read({ attachment: true })
    assert.ok(verify(daily.id))
    assert.equal(store.bilibiliSubtitles.remove(BVID, 2), true)
    assert.equal(verify(daily.id), undefined)
    putSubtitle('b'.repeat(64))
    assert.equal(verify(daily.id), undefined)
  })
  await t.test('revoke owner-approved collection', t => {
    const { store, read, verify } = fixture(t)
    const { daily, source } = read({ source: true })
    assert.ok(verify(daily.id))
    store.bilibili.revokeSource(source.id)
    assert.equal(verify(daily.id), undefined)
  })
})

test('missing activity or mismatched activity context, candidate, time and provenance fails closed', async t => {
  for (const [label, replace] of [
    ['missing activity', () => undefined],
    ['wrong context', event => ({ ...event, contextId: 'chat.mobile' })],
    ['wrong candidate', event => ({ ...event, data: { ...event.data, candidateId: randomUUID() } })],
    ['wrong timestamp', event => ({ ...event, occurredAt: `${DAY}T04:00:00.000Z` })],
    ['wrong provenance', event => ({ ...event, data: { ...event.data, subtitleSha256: 'b'.repeat(64) } })],
  ]) await t.test(label, t => {
    const { store, read, verify } = fixture(t)
    const { daily } = read({ attachment: true })
    assert.equal(verify(daily.id, id => replace(store.activityById(id))), undefined)
  })
})

test('daily initiative gets verified, bounded receipt text without transcript, raw IDs or candidate labels', t => {
  const { store, read } = fixture(t)
  const { daily, child, item } = read({ attachment: true })
  const { evidence } = recentDailyInitiativeEvidence(store, Date.now())
  assert.deepEqual(evidence, [{ id: 'recent-1', kind: 'experience', text: '曾阅读过一段经核验的 B 站字幕摘录。' }])
  const text = JSON.stringify(evidence)
  for (const privateValue of [daily.id, child.id, item.id, BVID, CUE, HASH, 'Private candidate label', 'private-reading-session']) {
    assert.ok(!text.includes(privateValue))
  }
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now() + 8 * 86_400_000).evidence, [])
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now() - 10_000).evidence, [])
  assert.equal(store.bilibiliSubtitles.remove(BVID, 2), true)
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now()).evidence, [])
})

test('initiative evidence ignores successful-looking rows without exact world receipts', t => {
  const { store, survey } = fixture(t)
  survey({ receiptStatus: 'failed' })
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now()), { evidence: [] })
})

test('initiative carries only the active companion trait label and revalidates its source', t => {
  const { store, read, verify } = fixture(t)
  const { daily } = read({ attachment: true })
  const source = verify(daily.id)
  const experienceReceipt = { at: source.at, fact: source.fact }
  const job = store.autonomy.create({ kind: 'daily.reflect', contextId: DAILY_REFLECTION_CONTEXT, dedupeKey: `daily-reflection:${daily.id}`,
    runAfter: Date.now(), payload: { dailyTaskId: daily.id, expiresAt: Date.now() + 60_000, sourceReceipt: experienceReceipt } })
  const sessionId = 'private-companion-reflection-session'
  store.bindContext({ contextId: DAILY_REFLECTION_CONTEXT, kind: 'system', sessionId, label: '私有复盘' })
  store.transitionTask(job.id, 'running')
  const content = '私有原文，这是角色自己写的判断，不能随标签传递。'
  const note = store.selfNotes.create({ content, basis: 'inference', createdBy: 'companion', actorSessionId: sessionId,
    evidence: [content], evidenceRefs: [{ quoteIndex: 0, messageId: 'private-message', role: 'assistant' }],
    sourceRefs: [{ contextId: DAILY_REFLECTION_CONTEXT, taskId: job.id, sessionId, eventSeq: 8 }],
    trait: 'check-evidence', experience: source.experience, experienceReceipt })
  const { evidence, selfNote } = recentDailyInitiativeEvidence(store, Date.now())
  assert.deepEqual(evidence.at(-1), { id: 'self-1', kind: 'self-note', text: '先核对证据再作判断' })
  assert.deepEqual(selfNote, { noteId: note.id, revision: 1 })
  for (const privateValue of [content, sessionId, note.id, job.id, 'private-message']) assert.ok(!JSON.stringify(evidence).includes(privateValue))
  store.selfNotes.update(note.id, { status: 'archived' })
  assert.equal(recentDailyInitiativeEvidence(store, Date.now()).selfNote, undefined)
  store.selfNotes.update(note.id, { status: 'active' })
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now()).selfNote, { noteId: note.id, revision: 3 })
  assert.equal(store.bilibiliSubtitles.remove(BVID, 2), true)
  assert.deepEqual(recentDailyInitiativeEvidence(store, Date.now()), { evidence: [] })
})
