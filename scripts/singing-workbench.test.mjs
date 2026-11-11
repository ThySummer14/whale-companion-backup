import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { MediaService } from '../src/host/media.ts'
import { SingingService, SINGING_CHAT_COVER_ID_PREFIX } from '../src/host/singing.ts'
import { AceStepSingingProvider } from '../src/host/singing-provider.ts'
import { registerSingingTools } from '../src/host/singing-tools.ts'
import { companionToolPolicy } from '../src/host/tool-policy.ts'
import { MAX_SINGING_WAV_BYTES } from '../src/protocol/singing.ts'
import { MAX_SINGING_MIDI_BYTES } from '../src/protocol/singing-midi.ts'

const input = { title: '隔离短歌', lyrics: '原创测试歌词', style: '中文短歌', durationSeconds: 10 }

function wave() {
  const samples = 160_000
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40); bytes.writeInt16LE(800, 44)
  return bytes
}

test('the workbench authorizes song tasks, serves verified WAV ranges and refuses modified archives', async t => {
  mkdirSync('.work', { recursive: true })
  const dir = resolve(mkdtempSync('.work/singing-workbench-'))
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  const mediaRoot = join(dir, 'media')
  const bytes = wave()
  const media = new MediaService(store, mediaRoot)
  const requests = []
  const engine = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push(url.pathname)
    req.resume()
    if (url.pathname === '/v1/audio') {
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(bytes)
      return
    }
    const data = url.pathname === '/release_task' ? { task_id: 'fixture-engine', status: 'queued' } : [{
      task_id: 'fixture-engine', status: 1,
      result: JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fapi_audio%2F550e8400-e29b-41d4-a716-446655440000.wav', status: 1 }]),
    }]
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 200, data }))
  })
  await new Promise(done => engine.listen(0, '127.0.0.1', done))
  const provider = new AceStepSingingProvider(`http://127.0.0.1:${engine.address().port}`, 3000)
  const singing = new SingingService(store, mediaRoot, provider)
  let route, origin
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }, { store, singing, media })
  const server = createServer(route.handler)
  t.after(async () => {
    await new Promise(done => { server.close(done); server.closeAllConnections() })
    await singing.close(); provider.close()
    await new Promise(done => { engine.close(done); engine.closeAllConnections() })
    await media.close(); store.close(); rmSync(dir, { recursive: true, force: true })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-companion-request': '1' }
  const post = (value, authorized = true) => fetch(`${origin}/companion/api/singing/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? headers : {}) }, body: JSON.stringify(value),
  })
  assert.equal((await post(input, false)).status, 403)
  assert.equal((await post({ ...input, durationSeconds: 5 })).status, 400)
  const generic = await fetch(`${origin}/companion/api/tasks`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ capabilityId: 'media.singing', title: input.title }),
  })
  assert.equal(generic.status, 403)
  const spoofedOrigin = await fetch(`${origin}/companion/api/tasks`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ capabilityId: 'core.chat', externalId: SINGING_CHAT_COVER_ID_PREFIX + 'a'.repeat(64), title: input.title }),
  })
  assert.equal(spoofedOrigin.status, 403)
  assert.equal((await spoofedOrigin.json()).code, 'singing-task-managed')
  const response = await post(input)
  assert.equal(response.status, 202)
  const { task } = await response.json()
  assert.equal(task.status, 'accepted')
  const forged = await fetch(`${origin}/companion/api/tasks/${task.id}`, {
    method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'succeeded' }),
  })
  assert.equal(forged.status, 403)
  for (let wait = 0; wait < 50 && ['accepted', 'running'].includes(store.taskById(task.id).status); wait++) await delay(10)
  assert.equal(store.taskById(task.id).status, 'succeeded')
  assert.deepEqual(requests, ['/release_task', '/query_result', '/v1/audio'])
  const audio = `${origin}/companion/api/singing/tasks/${task.id}/audio`
  assert.equal((await fetch(audio)).status, 403)
  const partial = await fetch(audio, { headers: { ...headers, range: 'bytes=42-55' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 42-55/${bytes.length}`)
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(42, 56))
  const head = await fetch(audio, { method: 'HEAD', headers })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'audio/wav')
  assert.equal(Number(head.headers.get('content-length')), bytes.length)
  const archive = store.media.get(task.id)
  await media.refresh()
  assert.equal(store.media.get(task.id).sourceRef, task.id)
  assert.equal(store.media.get(task.id).hash, archive.hash)
  const changed = Buffer.from(bytes)
  changed.writeInt16LE(20, 44)
  writeFileSync(join(mediaRoot, archive.path), changed)
  assert.equal((await fetch(audio, { headers })).status, 404)
  await delay(2)
  await media.refresh()
  assert.equal(store.media.get(task.id).hash, archive.hash)
  assert.ok(store.media.get(task.id).missingAt)
  assert.deepEqual(store.media.cleanupPreview(0).candidates, [])
})

test('the song generation tool is scoped to the dedicated singing scene', async () => {
  const name = 'companion_singing_generate'
  assert.ok(companionToolPolicy('chat.main', 'chat').denied.includes(name))
  assert.deepEqual(companionToolPolicy('world.singing', 'topic').allowed.map(tool => tool.name), [name, 'companion_singing_cover', 'companion_singing_status', 'companion_singing_score', 'companion_singing_share'])
  assert.deepEqual(companionToolPolicy('autonomy.bilibili-reflect', 'system').allowed, [])
  let tool
  const calls = []
  const ctx = { on: () => () => {}, tools: { register: value => { if (value.name === name) tool = value; return () => {} } }, agents: { currentInitiator: () => undefined } }
  registerSingingTools(ctx, {
    store: { bindingBySession: id => id === 'songs' ? { contextId: 'world.singing', kind: 'topic', sessionId: id } : undefined },
    singing: { submit: (...args) => { calls.push(args); return { task: { id: 'song', status: 'accepted', title: input.title } } } },
  })
  const signal = new AbortController().signal
  await assert.rejects(tool.execute(input, { agent: { id: 'other' }, signal }), /dedicated singing session/u)
  await tool.execute(input, { agent: { id: 'songs' }, signal })
  assert.deepEqual(calls, [[input, { sessionId: 'songs' }]])
})

test('chat singing tools bind covers and scores to the exact current owner request', async t => {
  const coverName = 'companion_singing_cover'
  const scoreName = 'companion_singing_score'
  const state = new Map()
  const tools = new Map()
  const wav = wave()
  const session = { id: 'songs', header: {} }
  const agent = { id: 'songs', session }
  let binding = { contextId: 'world.singing', kind: 'topic', sessionId: 'songs' }
  let readHook, reads = 0, submits = 0
  let fileBytes = wav
  const tasks = new Map()
  const scores = []
  const shares = []
  const scoreTasks = new Map()
  const ctx = {
    on: (name, handler) => { state.set(name, handler); return () => state.delete(name) },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    agents: { get: id => id === agent.id ? agent : undefined },
    get: () => ({
      async *readFileStream() { reads++; await readHook?.(); yield fileBytes },
      isAttachmentError: () => false,
    }),
  }
  const stop = registerSingingTools(ctx, {
    store: { bindingByContext: () => binding },
    async changeSongShare(input) {
      input.assertCurrent()
      shares.push({ operation: input.operation, selector: input.selector, sessionId: input.sessionId, caption: input.caption })
      return { status: input.operation === 'share' ? 'shared' : 'withdrawn', postId: 'test-post' }
    },
    singing: {
      sourceCoverAvailable: true,
      scoreAvailable: true,
      sourceCoverForMessage: ({ messageId }) => tasks.get(messageId),
      submitSourceCover(title, source, _gains, origin) {
        submits++
        assert.deepEqual(source, wav)
        assert.equal(origin.sessionId, agent.id)
        const result = { task: { id: `task-${origin.messageId}`, title, status: 'accepted' }, coverPhase: 'separating' }
        tasks.set(origin.messageId, result)
        return result
      },
      scoreForMessage: ({ messageId }) => scoreTasks.get(messageId),
      submitScore(input, origin) {
        scores.push({ input, origin })
        const result = { task: { id: `score-${origin.messageId}`, title: input.title, status: 'accepted' }, coverPhase: 'synthesizing' }
        scoreTasks.set(origin.messageId, result)
        return result
      },
      sessionTask: (id, taskId) => id === 'songs' && [...tasks.values()].find(row => !taskId || row.task.id === taskId),
    },
  })
  t.after(stop)
  const cover = tools.get(coverName)
  const score = tools.get(scoreName)
  const status = tools.get('companion_singing_status')
  const emit = (type, data, surfaceOp) => state.get('session/event')(session, { type, data, surfaceOp })
  const claim = (turn, message) => state.get('agent/inbox/claimed')({ agent, turn, message })
  const file = { type: 'file', attachment: { attachmentId: 'owner-wave', name: 'source.wav', bytes: wav.length } }
  const message = (id, text = '帮我翻唱这段，歌名叫空城计', blocks = [file], source = { kind: 'user' }) => ({
    id, role: 'user', source, content: [{ type: 'text', text }, ...blocks],
  })
  const start = (turn, original, appended = original, name = coverName) => {
    emit('turn/start', { turn })
    if (original) claim(turn, original)
    emit('step/start', { turn, step: 1 })
    if (appended) emit('user/message', structuredClone(appended), 'append')
    emit('tool/call', { turn, step: 1, callId: `call-${turn}`, name })
  }
  const call = (turn, extra = {}) => ({ agent, callId: `call-${turn}`, signal: new AbortController().signal, ...extra })
  const submit = (turn, extra) => cover.execute({ title: '空城计' }, call(turn, extra))
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes(coverName))
  start(1, message('valid'))
  await assert.rejects(submit(1, { agent: undefined }), /dedicated singing session/u)
  await assert.rejects(submit(1, { callId: 'another' }), /new, explicit/u)
  const accepted = JSON.parse(await submit(1))
  assert.deepEqual(accepted, { taskId: 'task-valid', status: 'accepted', title: '空城计', coverPhase: 'separating', playable: false })
  assert.deepEqual(JSON.parse(await submit(1)), accepted)
  assert.deepEqual(JSON.parse(await status.execute({}, call(1))), accepted)
  await assert.rejects(status.execute({ taskId: 'another-song' }, call(1)), /No matching/u)
  emit('turn/end', { turn: 1 })
  await assert.rejects(submit(1), /new, explicit/u)
  start(2, undefined, message('injected'))
  await assert.rejects(submit(2), /new, explicit/u)
  start(3, message('changed'), message('changed', '请翻唱另一段'))
  await assert.rejects(submit(3), /new, explicit/u)
  start(4, message('description', '这段以前有人翻唱过'))
  await assert.rejects(submit(4), /same message/u)
  start(5, message('multiple', '翻唱：歌曲', [file, file]))
  await assert.rejects(submit(5), /same message/u)
  start(6, message('relay', '请翻唱这段', [file], { kind: 'companion-mobile', form: 'relay' }), undefined, 'run_code')
  await assert.rejects(submit(6, { parent: Symbol(), rootCallId: 'call-6', callId: 'inner' }), /new, explicit/u)
  emit('tool/ptc-dispatch-start', { name: coverName, rootCallId: 'call-6', subCallId: 'inner' })
  assert.equal(JSON.parse(await submit(6, { parent: Symbol(), rootCallId: 'call-6', callId: 'inner' })).taskId, 'task-relay')
  start(7, message('stale'))
  readHook = () => { binding = { ...binding, sessionId: 'replacement' } }
  await assert.rejects(submit(7), /dedicated singing session/u)
  assert.equal(reads, 3)
  assert.equal(submits, 2)

  binding = { ...binding, sessionId: 'songs' }
  const scoreInput = { title: '归途', bpm: 120, notes: [{ midi: 60, beats: 4, lyric: '归' }, { midi: 62, beats: 4, lyric: '途' }] }
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes(scoreName))
  const ask = message('score-request', '请按谱唱这段', [], { kind: 'companion-mobile', form: 'relay' })
  start(8, undefined, ask, scoreName)
  await assert.rejects(score.execute(scoreInput, call(8)), /new, explicit/u)
  start(9, message('score-mention', '昨天我们聊过按谱唱', []), undefined, scoreName)
  await assert.rejects(score.execute(scoreInput, call(9)), /Begin a new score/u)
  start(10, ask, undefined, 'run_code')
  const subcall = call(10, { parent: Symbol(), rootCallId: 'call-10', callId: 'score-inner' })
  emit('tool/ptc-dispatch-start', { name: coverName, rootCallId: 'call-10', subCallId: 'score-inner' })
  await assert.rejects(score.execute(scoreInput, subcall), /new, explicit/u)
  emit('tool/ptc-dispatch-start', { name: scoreName, rootCallId: 'call-10', subCallId: 'score-inner' })
  assert.equal(JSON.parse(await score.execute(scoreInput, subcall)).coverPhase, 'synthesizing')
  assert.deepEqual(scores, [{ input: scoreInput, origin: { sessionId: 'songs', messageId: 'score-request' } }])

  const midi = Buffer.from('4d546864000000060000000101e04d54726b0000001600903c648f00803c0000903e648f00803e0000ff2f00', 'hex')
  const midiFile = { type: 'file', attachment: { attachmentId: 'owner-midi', name: 'melody.MID', bytes: midi.length } }
  const midiText = '按谱唱 MIDI\n曲名：海风\n轨道: 1\n通道：1\n起始：1\n音符数：2\n歌词：海 风'
  const midiOwner = (id, text = midiText, blocks = [midiFile]) => message(id, text, blocks, { kind: 'companion-mobile', form: 'relay' })
  const midiSubmit = turn => score.execute(scoreInput, call(turn))
  readHook = undefined
  fileBytes = midi

  const wrongFile = { ...midiFile, attachment: { ...midiFile.attachment, name: 'melody.bin' } }
  const largeFile = { ...midiFile, attachment: { ...midiFile.attachment, bytes: MAX_SINGING_MIDI_BYTES + 1 } }
  for (const [index, [owner, error]] of [
    [midiOwner('missing', midiText, []), /同一条消息/u],
    [midiOwner('wrong', midiText, [wrongFile]), /同一条消息/u],
    [midiOwner('mixed', midiText, [midiFile, file]), /同一条消息/u],
    [midiOwner('duplicate', midiText + '\n音符数：3'), /逐行填写/u],
    [midiOwner('vague', '请按谱唱这份文件'), /首行写/u],
    [midiOwner('large', midiText, [largeFile]), /KiB/u],
  ].entries()) {
    const turn = 11 + index
    start(turn, owner, undefined, scoreName)
    await assert.rejects(midiSubmit(turn), error)
  }
  assert.equal(reads, 3)
  assert.equal(scores.length, 1)

  start(17, midiOwner('new-midi'), undefined, scoreName)
  const [left, right] = await Promise.all([midiSubmit(17), score.execute({}, call(17))])
  assert.deepEqual(JSON.parse(left), { taskId: 'score-new-midi', status: 'accepted', title: '海风', coverPhase: 'synthesizing', playable: false })
  assert.equal(left, right)
  assert.equal(await midiSubmit(17), left)
  assert.equal(reads, 5)
  assert.deepEqual(scores[1], {
    input: { title: '海风', bpm: 120, notes: [{ midi: 60, beats: 4, lyric: '海' }, { midi: 62, beats: 4, lyric: '风' }] },
    origin: { sessionId: 'songs', messageId: 'new-midi' },
  })

  start(18, midiOwner('no-lyrics', midiText.replace(/\n歌词.*$/u, '')), undefined, scoreName)
  await assert.rejects(midiSubmit(18), /汉字/u)
  start(19, midiOwner('stale-midi'), undefined, scoreName)
  readHook = () => { binding = { ...binding, sessionId: 'replacement' } }
  await assert.rejects(midiSubmit(19), /dedicated singing session/u)
  assert.equal(scores.length, 2)

  binding = { ...binding, sessionId: 'songs' }
  const shareName = 'companion_singing_share'
  const share = tools.get(shareName)
  assert.ok(companionToolPolicy('chat.mobile', 'chat').denied.includes(shareName))
  const sharing = message('share-song', '发布歌唱动态：《微光照归途》', [], { kind: 'companion-mobile', form: 'relay' })
  start(20, undefined, sharing, shareName)
  await assert.rejects(share.execute({ caption: '隔离配文' }, call(20)), /new, explicit/u)
  start(21, message('discussion', '我们先讨论怎么发布歌唱动态：旧曲', []), undefined, shareName)
  await assert.rejects(share.execute({ caption: '隔离配文' }, call(21)), /请发送/u)
  start(22, sharing, undefined, shareName)
  assert.equal(JSON.parse(await share.execute({ caption: '隔离配文', taskId: 'injected-song' }, call(22))).status, 'shared')
  emit('turn/end', { turn: 22 })
  await assert.rejects(share.execute({ caption: '过期' }, call(22)), /new, explicit/u)
  start(23, message('withdraw', 'Withdraw song post: 微光照归途', []), undefined, shareName)
  assert.equal(JSON.parse(await share.execute({}, call(23))).status, 'withdrawn')
  assert.deepEqual(shares, [
    { operation: 'share', selector: '微光照归途', sessionId: 'songs', caption: '隔离配文' },
    { operation: 'withdraw', selector: '微光照归途', sessionId: 'songs', caption: undefined },
  ])
})

test('single-source cover transport checks owner, options, content type and upload size', async t => {
  let route, origin
  const calls = []
  const singing = {
    submitSourceCover: (title, source, gains) => {
      calls.push({ title, source, gains })
      return { task: { id: 'fixture', status: 'accepted', title }, coverPhase: 'separating' }
    },
  }
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }, { singing })
  const server = createServer(route.handler)
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections() }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  const source = wave()
  const post = (query, headers = {}, data = source) => fetch(`${origin}/companion/api/singing/source-covers?${query}`, {
    method: 'POST', body: data,
    headers: { 'x-companion-request': '1', 'content-type': 'audio/wav', ...headers },
  })
  const check = async (response, status, code) => {
    assert.equal(response.status, status)
    assert.equal((await response.json()).code, code)
  }
  await check(await post('title=local', { 'x-companion-request': '0' }), 403, 'origin-refused')
  await check(await post('title=local', { origin: 'https://example.com' }), 403, 'origin-refused')
  await check(await post('title=a&title=b'), 400, 'invalid-request')
  await check(await post('title=a&url=https://example.com'), 400, 'invalid-request')
  await check(await post('title=a&backingGainDb=-31'), 400, 'singing-invalid-gain')
  await check(await post('title=a', { 'content-type': 'audio/mpeg' }), 415, 'singing-invalid-source')
  const oversize = await new Promise((resolve, reject) => {
    const req = request(`${origin}/companion/api/singing/source-covers?title=a`, { method: 'POST', headers: {
      'x-companion-request': '1', 'content-type': 'audio/wav', 'content-length': String(MAX_SINGING_WAV_BYTES + 1),
    } }, response => {
      const parts = []
      response.on('data', part => parts.push(part))
      response.on('end', () => resolve(new Response(Buffer.concat(parts), { status: response.statusCode })))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
  await check(oversize, 413, 'singing-source-too-large')
  assert.equal(calls.length, 0)
  const response = await post('title=%20local%20&vocalGainDb=1.5&backingGainDb=-4', { 'content-type': 'audio/x-wav' })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { task: { id: 'fixture', status: 'accepted', title: 'local' }, coverPhase: 'separating' })
  assert.deepEqual(calls, [{ title: 'local', source, gains: { vocalGainDb: 1.5, backingGainDb: -4 } }])
})
