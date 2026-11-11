import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WebSocket } from 'ws'
import { CompanionStore } from '../src/core/store.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { EventHub } from '../src/host/events.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'
import { RealtimePcmProvider } from '../src/host/realtime-pcm.ts'

const CONTEXT = 'chat.phone'
const SESSION = SessionId('voice-reply-test')
const MOBILE = { kind: 'companion-mobile', form: 'relay' }
const USER = { kind: 'user' }
const TOOL = { type: 'tool-call', id: 'tool-id', name: 'media', arguments: '{}' }
const PREFIX_PCM = Buffer.alloc(16, 1)
const TAIL_PCM = Buffer.alloc(16, 2)
const text = (value = '回复已完成。') => ({ type: 'text', text: value })
const voiced = client => client.events.filter(event => event.type === 'voice.reply.ready')
const pcm = (res, bytes = TAIL_PCM) => res.writeHead(200, { 'content-type': 'audio/pcm' }).end(bytes)

async function fixture(t, provider, contextId = CONTEXT) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/voice-reply-ready-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  store.bindContext({ contextId, sessionId: SESSION, label: 'Phone', kind: 'chat' })
  const session = Session.create(SESSION)
  const replacement = Session.create(SessionId('replacement'))
  const queued = []
  const agent = { id: SESSION, session, followup: message => queued.push(message) }
  const handlers = new Map()
  const routes = new Map()
  const upgrades = new Map()
  const sockets = new Set()
  const flush = t.mock.fn(async () => true)
  let persisted = []
  let origin
  const ctx = {
    agents: { get: id => id === SESSION ? agent : id === replacement.id ? { session: replacement } : undefined },
    sessions: { flush: async active => {
      const durable = await flush(active)
      if (durable) persisted = active.snapshotEvents()
      return durable
    } },
    sessionPersistence: {
      stat: async () => ({ eventCount: persisted.length }),
      open: async () => ({ read: async (offset, length) => ({ events: persisted.slice(offset, offset + length) }), close: async () => {} }),
    },
    on: (name, callback) => {
      const callbacks = handlers.get(name) ?? []
      callbacks.push(callback)
      handlers.set(name, callbacks)
      return () => callbacks.splice(callbacks.indexOf(callback), 1)
    },
    webServer: {
      getOrigin: () => origin,
      register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
      registerUpgrade: route => { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path) },
    },
  }
  const media = join(directory, 'media')
  const runtime = new CompanionRuntime(ctx, store, 'test', {
    provider: 'piper', pythonPath: '/unavailable/python', modelPath: '/unavailable/model', mediaDir: join(media, 'voice'), timeoutMs: 5000,
  }, media, directory, directory, directory, 'owner', provider)
  const devices = new DeviceService(ctx, store)
  for (const service of [runtime.tts, runtime.media, runtime.avatar, runtime.realtimeVoice, runtime.worlds, runtime.autonomy]) {
    t.mock.method(service, 'start', () => {})
  }
  runtime.attachEvents(new EventHub(ctx, store))
  runtime.attachEvents(new EventHub(ctx, store, {
    path: '/companion-device/api/events', authorize: req => devices.authorize(req), onConnection: (socket, req) => devices.track(req, socket),
  }))
  registerDeviceHttp(ctx, runtime, devices)
  const server = createServer((req, res) => routes.get([...routes.keys()].find(path => req.url.startsWith(`${path}/`)))(req, res))
  server.on('upgrade', (req, socket, head) => upgrades.get(new URL(req.url, origin).pathname)?.(req, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const device = devices.redeem(devices.createOffer({ routes: [origin] }).link)
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await runtime.close() } }
  t.after(async () => {
    devices.close()
    for (const socket of sockets) socket.terminate()
    await stop()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    rmSync(directory, { recursive: true, force: true })
  })
  runtime.start()

  const connect = async (context = contextId, management = false) => {
    const path = management ? '/companion/api/events' : '/companion-device/api/events'
    const socket = new WebSocket(origin.replace('http:', 'ws:') + `${path}?contextId=${context}`, {
      headers: management ? { 'x-companion-request': '1' } : { authorization: device.credential },
    })
    sockets.add(socket)
    const events = []
    const subscribed = Promise.withResolvers()
    const voice = Promise.withResolvers()
    socket.on('message', frame => {
      const event = JSON.parse(String(frame))
      events.push(event)
      if (event.type === 'stream.replay.complete') subscribed.resolve()
      if (event.type === 'voice.reply.ready') voice.resolve(event)
    })
    await once(socket, 'open')
    await subscribed.promise
    const completed = async messageId => {
      while (!events.some(event => event.type === 'message.completed' && event.payload.messageId === messageId)) await once(socket, 'message')
    }
    return { socket, events, voice: voice.promise, completed }
  }
  const post = (path, input) => fetch(`${origin}/companion-device/api/${path}`, {
    method: 'POST', headers: { authorization: device.credential, 'content-type': 'application/json' },
    body: JSON.stringify({ contextId, ...input }),
  })
  const send = async voiceReply => {
    const response = await post('messages', { text: '手机发出的输入。', voiceReply })
    assert.equal(response.status, 202)
    return response.json()
  }

  let turn = 0
  let step = 0
  let revision = 0
  let attempt = 0
  const emit = (name, ...args) => { for (const callback of handlers.get(name) ?? []) callback(...args) }
  const append = (type, data, options) => {
    const event = options === undefined ? session.append(type, data) : session.append(type, data, options)
    emit('session/event', session, event)
    return event
  }
  const start = (live = true) => {
    turn++
    step = 1
    if (live) append('turn/start', { turn })
    else session.append('turn/start', { turn })
    append('step/start', { turn, step })
  }
  const next = () => {
    append('step/end', { turn, step })
    append('step/start', { turn, step: ++step })
  }
  const input = (source = MOBILE, message = createUserMessage({ content: [text('输入')], source })) => {
    append('user/message', message, { surfaceOp: 'append' })
    return message.id
  }
  const reply = (content = [text()], interrupted = false) => {
    const message = createAssistantMessage({ content, source: { provider: 'test', model: 'test' } })
    append('assistant/message', { turn, step, message, stream: [], ...(interrupted ? { interrupted: true } : {}) }, { surfaceOp: 'append' })
    return message.id
  }
  const finish = (reason = { kind: 'completed' }) => {
    append('step/end', { turn, step })
    return append('turn/end', { turn, reason })
  }
  const live = () => {
    const attemptId = `${SESSION}:${++attempt}`
    let index = 0
    const publish = frame => emit('agent/assistant-stream', { agent, frame: { ...frame, attemptId, revision: ++revision } })
    publish({ type: 'start', turn, step })
    const chunk = chunk => publish({ type: 'chunk', index: index++, time: Date.now(), chunk })
    const delta = (value, block = 0) => chunk({ type: 'text-delta', index: block, text: value })
    const end = (outcome = { kind: 'committed', eventType: 'assistant/message', seq: session.snapshotEvents().at(-1).seq }) => publish({ type: 'end', index, outcome })
    return { chunk, delta, end, skipRevision: () => { revision++ } }
  }
  return { append, connect, device, emit, finish, flush, input, live, next, post, queued, replacement, reply, runtime, send, session, start, stop, store }
}

async function pcmFixture(t, onSynthesize) {
  const calls = []
  const upstream = createServer(async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    const { input } = JSON.parse(Buffer.concat(parts))
    calls.push(input)
    onSynthesize(input, res)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() }))
  const provider = new RealtimePcmProvider({
    endpoint: `http://127.0.0.1:${upstream.address().port}/speech`, protocol: 'openai', model: 'test', voice: 'test', timeoutMs: 3000,
  })
  const original = provider.prewarm.bind(provider)
  const buffered = Promise.withResolvers()
  const collected = Promise.withResolvers()
  t.mock.method(provider, 'prewarm', (input, signal) => {
    const stream = original(input, signal)
    async function* complete() {
      try {
        for await (const bytes of stream.body) {
          yield bytes
          buffered.resolve()
        }
      } finally { collected.resolve() }
    }
    return { ...stream, body: complete() }
  })
  return { ...(await fixture(t, provider)), calls, buffered: buffered.promise, collected: collected.promise, prewarm: provider.prewarm }
}

test('uses the actual device POST ID and the final assistant reply after its durability checkpoint', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const selected = await h.connect()
  const otherContext = await h.connect('chat.other')
  const management = await h.connect(CONTEXT, true)
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementation(async session => {
    assert.equal(session, h.session)
    assert.equal(session.snapshotEvents().at(-1).type, 'turn/end')
    return checkpoint.promise
  })
  await h.runtime.sessions.send(CONTEXT, '网页或自主任务调用。')
  assert.deepEqual(h.queued.shift().source, USER)
  const receipt = await h.send()
  const deviceMessage = h.queued.shift()
  assert.deepEqual(deviceMessage.source, MOBILE)
  assert.equal(receipt.messageId, deviceMessage.id)

  h.start()
  h.input({ kind: 'runtime-context', form: 'snapshot', sections: [] })
  h.input(MOBILE, deviceMessage)
  h.input({ kind: 'companion-memory', form: 'recall' })
  const first = h.reply([text('正在调用工具。'), TOOL])
  h.next()
  const final = h.reply()
  const end = h.finish()
  h.emit('session/event', h.session, end)
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 1)
  assert.deepEqual(voiced(selected), [])
  await management.completed(final)
  checkpoint.resolve(true)
  const event = await selected.voice
  assert.deepEqual(event, {
    eventId: `voice-reply:${SESSION}:${end.seq}`, schemaVersion: 1, type: 'voice.reply.ready',
    occurredAt: new Date(end.time).toISOString(), contextId: CONTEXT, sessionId: SESSION, cursor: null,
    payload: { userMessageId: receipt.messageId, assistantMessageId: final },
  })
  assert.notEqual(event.payload.assistantMessageId, first)
  assert.deepEqual(voiced(otherContext), [])
  assert.deepEqual(voiced(management), [])
  assert.deepEqual(voiced(await h.connect()), [])
  assert.ok(h.store.activities().every(activity => activity.kind !== 'voice.reply.ready'))
})

test('skips multi-input, desktop, tool, empty, interrupted, unsuccessful and restored turns', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const client = await h.connect()
  const cases = [
    { sources: [] }, { sources: [USER] }, { sources: [MOBILE, MOBILE] },
    { sources: [USER, MOBILE] }, { sources: [MOBILE, USER] }, { sources: [{ kind: 'companion-mobile' }] },
    { final: [text('工具前缀。'), TOOL] }, { final: [text('   ')] }, { interrupted: true },
    { reason: { kind: 'aborted', reason: { kind: 'user' } } }, { reason: { kind: 'blocked' } },
    { reason: { kind: 'max-tokens' } }, { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'failed' } } },
    { live: false },
  ]
  for (const { sources = [MOBILE], final, interrupted, reason, live } of cases) {
    h.start(live)
    for (const source of sources) h.input(source)
    if (final !== undefined) { h.reply([text('前一个可用回复不应被误报。')]); h.next() }
    h.reply(final, interrupted)
    h.finish(reason)
  }
  h.start()
  h.input()
  h.reply()
  h.next()
  h.input(USER)
  h.reply()
  h.finish()
  await setImmediate()
  assert.deepEqual(voiced(client), [])
  assert.equal(h.flush.mock.callCount(), 0)
  h.start()
  const nextId = h.input()
  h.reply()
  h.finish()
  assert.equal((await client.voice).payload.userMessageId, nextId)
})

test('a socket reconnecting during the checkpoint does not get the old result', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const old = await h.connect()
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementationOnce(async () => checkpoint.promise)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 1)
  const closed = once(old.socket, 'close')
  old.socket.close()
  await closed
  const next = await h.connect()
  checkpoint.resolve(true)
  await setImmediate()
  assert.deepEqual(voiced(next), [])
  h.start()
  const id = h.input()
  h.reply()
  h.finish()
  assert.equal((await next.voice).payload.userMessageId, id)
})

test('missing, failed or stale durability confirmations cannot announce a reply', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const client = await h.connect()
  h.flush.mock.mockImplementationOnce(async () => false)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  h.flush.mock.mockImplementationOnce(async () => { throw new Error('storage offline') })
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 2)
  assert.deepEqual(voiced(client), [])

  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementationOnce(async () => checkpoint.promise)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  h.runtime.bindContext({ contextId: CONTEXT, sessionId: h.replacement.id, label: 'Replacement', kind: 'chat' })
  h.runtime.bindContext({ contextId: CONTEXT, sessionId: SESSION, label: 'Phone', kind: 'chat' })
  checkpoint.resolve(true)
  await setImmediate()
  assert.deepEqual(voiced(client), [])

  h.start(); h.input()
  h.emit('session/disposed', h.session)
  h.reply(); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 3)
  assert.deepEqual(voiced(client), [])
})

test('without a live device subscriber no checkpoint or announcement is created', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const web = await h.connect(CONTEXT, true)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 0)
  assert.deepEqual(voiced(web), [])
  assert.deepEqual(voiced(await h.connect()), [])
})

test('a completed phone reply becomes an inbox receipt after persistence without a connected socket', { timeout: 5000 }, async t => {
  const h = await fixture(t, undefined, 'chat.mobile')
  const notices = () => h.store.notices.list(h.device.device.id, {}).items
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementationOnce(async () => checkpoint.promise)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  assert.deepEqual(notices(), [])
  checkpoint.resolve(true)
  await setImmediate()
  assert.deepEqual(notices().map(notice => [notice.kind, notice.read]), [['chat-reply', false]])

  h.start(); h.input(USER); h.reply(); h.finish()
  h.start(); h.input(); h.reply([text()], true); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 1)
  assert.equal(notices().length, 1)
})

test('stopping the Host drops a reply whose durability checkpoint is still pending', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const client = await h.connect()
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementationOnce(async () => checkpoint.promise)
  h.start(); h.input(); h.reply(); h.finish()
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 1)
  await h.stop()
  checkpoint.resolve(true)
  await setImmediate()
  assert.deepEqual(voiced(client), [])
})

test('two distinct completed turns can both announce their own reply while storage is busy', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  const client = await h.connect()
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementation(async () => checkpoint.promise)
  const expected = []
  for (let turn = 0; turn < 2; turn++) {
    h.start()
    expected.push({ userMessageId: h.input(), assistantMessageId: h.reply() })
    h.finish()
  }
  await setImmediate()
  assert.equal(h.flush.mock.callCount(), 2)
  checkpoint.resolve(true)
  while (voiced(client).length < 2) await once(client.socket, 'message')
  assert.deepEqual(voiced(client).map(event => event.payload), expected)
})

test('an opted-in phone reply streams its cached first sentence followed by its exact remaining text only after durability', { timeout: 5000 }, async t => {
  const prefix = '今天会晴。'
  const tail = ' 晚上也凉快。'
  const h = await pcmFixture(t, (input, res) => pcm(res, input === prefix ? PREFIX_PCM : TAIL_PCM))
  const client = await h.connect()
  const receipt = await h.send(true)
  const input = h.queued.shift()
  assert.deepEqual(input.source, { ...MOBILE, voiceReply: true })
  h.start()
  h.input(MOBILE, input)
  const stream = h.live()
  stream.chunk({ type: 'reasoning-delta', index: 0, text: '只给模型自己的推理。' })
  stream.delta('今天', 1)
  await setImmediate()
  assert.deepEqual(h.calls, [])
  stream.delta('会晴。', 1)
  await h.collected
  await setImmediate()
  assert.deepEqual(h.calls, [prefix])
  stream.delta(tail, 1)
  const messageId = h.reply([text(prefix + tail)])
  stream.end()
  const checkpoint = Promise.withResolvers()
  h.flush.mock.mockImplementation(async () => checkpoint.promise)
  h.finish()
  assert.equal((await h.post('voice-stream', { messageId })).status, 404)
  assert.deepEqual(voiced(client), [])
  checkpoint.resolve(true)
  assert.deepEqual((await client.voice).payload, { userMessageId: receipt.messageId, assistantMessageId: messageId })

  const first = await h.post('voice-stream', { messageId })
  assert.equal(first.headers.get('content-type'), 'application/octet-stream')
  assert.equal(first.headers.get('x-companion-sample-rate'), '24000')
  assert.equal(first.headers.get('x-companion-voice-source'), 'prefetch-complete')
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.concat([PREFIX_PCM, TAIL_PCM]))
  assert.deepEqual(h.calls, [prefix, tail])
  const second = await h.post('voice-stream', { messageId })
  assert.equal(second.headers.get('x-companion-voice-source'), 'full')
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), TAIL_PCM)
  assert.deepEqual(h.calls, [prefix, tail, prefix + tail])
})

test('reuses a live prefix before upstream EOF and closes it when the device stops', { timeout: 8000 }, async t => {
  for (const stop of [false, true]) {
    await t.test(stop ? 'stop' : 'finish', async t => {
      const prefix = '今天会晴。'
      const tail = '我们出去走走。'
      const lead = Buffer.alloc(4_800, 1)
      const opened = Promise.withResolvers()
      const closed = Promise.withResolvers()
      const h = await pcmFixture(t, (input, res) => {
        if (input !== prefix) return pcm(res)
        res.once('close', () => closed.resolve(!res.writableFinished))
        res.writeHead(200, { 'content-type': 'audio/pcm' }).write(lead)
        opened.resolve(res)
      })
      const client = await h.connect()
      await h.send(true)
      h.start()
      h.input(MOBILE, h.queued.shift())
      const stream = h.live()
      stream.delta(prefix)
      await h.buffered
      const upstream = await opened.promise
      stream.delta(tail)
      const messageId = h.reply([text(prefix + tail)])
      stream.end()
      h.finish()
      await client.voice

      const response = await h.post('voice-stream', { messageId })
      assert.equal(response.headers.get('x-companion-voice-source'), 'prefetch-live')
      const reader = response.body.getReader()
      assert.deepEqual(Buffer.from((await reader.read()).value), lead)
      assert.equal(upstream.writableEnded, false)
      assert.deepEqual(h.calls, [prefix])
      if (stop) {
        await reader.cancel()
        assert.equal(await closed.promise, true)
        assert.deepEqual(h.calls, [prefix])
      } else {
        upstream.end(PREFIX_PCM)
        const chunks = []
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          chunks.push(next.value)
        }
        assert.deepEqual(Buffer.concat(chunks), Buffer.concat([PREFIX_PCM, TAIL_PCM]))
        assert.equal(await closed.promise, false)
        assert.deepEqual(h.calls, [prefix, tail])
      }
    })
  }
})

test('a model reply that completes within the grace period uses one full synthesis', { timeout: 5000 }, async t => {
  const h = await pcmFixture(t, (_, res) => pcm(res))
  const client = await h.connect()
  await h.send(true)
  h.start()
  h.input(MOBILE, h.queued.shift())
  const stream = h.live()
  const prefix = '我们去散步。'
  const tail = '带上伞吧。'
  stream.delta(prefix)
  stream.delta(tail)
  const messageId = h.reply([text(prefix + tail)])
  stream.end()
  h.finish()
  await client.voice
  const response = await h.post('voice-stream', { messageId })
  assert.equal(response.headers.get('x-companion-voice-source'), 'full')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), TAIL_PCM)
  assert.deepEqual(h.calls, [prefix + tail])
})

test('ordinary phone text, invalid opt-in values and formatted first sentences do not run speculative synthesis', { timeout: 5000 }, async t => {
  const h = await pcmFixture(t, (_, res) => pcm(res))
  const client = await h.connect()
  assert.equal((await h.post('messages', { text: '输入', voiceReply: 'true' })).status, 400)
  assert.equal(h.queued.length, 0)
  for (const [flag, first] of [[undefined, '正常中文。'], [false, '正常中文。'], [true, '**粗体的首句。'], [true, '字'.repeat(40) + '。']]) {
    await h.send(flag)
    h.start()
    h.input(MOBILE, h.queued.shift())
    const stream = h.live()
    stream.delta(first)
    h.reply([text(first)])
    stream.end()
    h.finish()
  }
  await client.voice
  assert.equal(h.prewarm.mock.callCount(), 0)
  assert.deepEqual(h.calls, [])
})

test('a missing frame revision, a tool block or a changed final sentence aborts the tentative audio', { timeout: 5000 }, async t => {
  for (const trigger of ['revision', 'tool', 'rewrite']) {
    await t.test(trigger, async t => {
      const started = Promise.withResolvers()
      const stopped = Promise.withResolvers()
      const prefix = '早上好。'
      const final = trigger === 'rewrite' ? '晚上好。天气不错。' : prefix + '天气不错。'
      const h = await pcmFixture(t, (input, res) => {
        if (input !== prefix) return pcm(res)
        res.once('close', stopped.resolve)
        started.resolve()
      })
      const client = await h.connect()
      await h.send(true)
      h.start()
      h.input(MOBILE, h.queued.shift())
      const stream = h.live()
      stream.delta(prefix)
      await started.promise
      if (trigger === 'revision') {
        stream.skipRevision()
        stream.delta('天气不错。')
      } else if (trigger === 'tool') {
        stream.chunk({ type: 'block-start', index: 1, blockType: 'tool-call' })
      }
      const messageId = h.reply([text(final)])
      stream.end()
      h.finish()
      await stopped.promise
      await client.voice
      const response = await h.post('voice-stream', { messageId })
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), TAIL_PCM)
      assert.deepEqual(h.calls, [prefix, final])
    })
  }
})

test('a confirmed prefix is invalidated when the scene is rebound before playback', { timeout: 5000 }, async t => {
  const prefix = '你好。'
  const h = await pcmFixture(t, (input, res) => pcm(res, input === prefix ? PREFIX_PCM : TAIL_PCM))
  const client = await h.connect()
  await h.send(true)
  h.start()
  h.input(MOBILE, h.queued.shift())
  const stream = h.live()
  stream.delta(prefix)
  await h.collected
  const messageId = h.reply([text(prefix)])
  stream.end()
  h.finish()
  await client.voice
  h.runtime.bindContext({ contextId: CONTEXT, sessionId: h.replacement.id, label: 'Replacement', kind: 'chat' })
  h.runtime.bindContext({ contextId: CONTEXT, sessionId: SESSION, label: 'Phone', kind: 'chat' })
  const response = await h.post('voice-stream', { messageId })
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PREFIX_PCM)
  assert.deepEqual(h.calls, [prefix, prefix])
})

test('a turn cancelled during speculation closes its provider without sending a ready event', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  const h = await pcmFixture(t, (_, res) => { res.once('close', stopped.resolve); started.resolve() })
  const client = await h.connect()
  await h.send(true)
  h.start()
  h.input(MOBILE, h.queued.shift())
  const stream = h.live()
  stream.delta('你好。')
  await started.promise
  h.reply([text('你好。')], true)
  stream.end()
  h.finish({ kind: 'aborted', reason: { kind: 'user' } })
  await stopped.promise
  assert.deepEqual(voiced(client), [])
  assert.equal(h.flush.mock.callCount(), 0)
})
