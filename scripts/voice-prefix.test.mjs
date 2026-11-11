import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { RealtimePcmProvider } from '../src/host/realtime-pcm.ts'
import { VoicePrefixCache } from '../src/host/voice-prefix.ts'

const prefix = '我来啦。'
const suffix = '我们继续看星星。'
const pcmPrefix = Buffer.alloc(24, 1)
const pcmSuffix = Buffer.alloc(32, 2)
const sampleRate = 24_000
const signal = () => new AbortController().signal
const pcm = (res, data) => res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': String(sampleRate) }).end(data)
const promises = () => {
  const waits = new Map()
  return key => {
    if (!waits.has(key)) waits.set(key, Promise.withResolvers())
    return waits.get(key)
  }
}

async function fixture(t, serve = (text, res) => pcm(res, text === prefix ? pcmPrefix : pcmSuffix)) {
  const calls = []
  const called = promises()
  const closed = promises()
  const settled = promises()
  const server = createServer(async (req, res) => {
    const payload = []
    for await (const chunk of req) payload.push(chunk)
    const { input } = JSON.parse(Buffer.concat(payload).toString('utf8'))
    calls.push(input)
    res.once('close', () => closed(input).resolve(!res.writableFinished))
    called(input).resolve(res)
    serve(input, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new RealtimePcmProvider({
    endpoint: `http://127.0.0.1:${server.address().port}/speech`, protocol: 'openai', model: 'test', voice: 'whale', sampleRate, timeoutMs: 20_000,
  })
  const prewarm = provider.prewarm.bind(provider)
  t.mock.method(provider, 'prewarm', (text, abort) => {
    const stream = prewarm(text, abort)
    const body = async function* () {
      try { yield* stream.body } finally { settled(text).resolve() }
    }
    return { ...stream, body: body() }
  })
  const cache = new VoicePrefixCache(provider)
  t.after(async () => {
    cache.close()
    provider.close()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  return {
    calls, cache, provider,
    called: text => called(text).promise,
    closed: text => closed(text).promise,
    ready: async text => { await settled(text).promise; await setImmediate() },
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream.body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function consume(cache, text) {
  const hit = cache.take('scene', 'message', text)
  return hit ? { prefixPcm: hit.pcm, text: text.slice(hit.prefix.length) } : text
}

test('only a confirmed exact first sentence is reusable, once, without changing its bytes', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  h.cache.begin('attempt', prefix)
  await h.ready(prefix)
  assert.equal(h.cache.take('scene', 'message', prefix), undefined)
  h.cache.confirm('attempt', 'scene', 'message')
  assert.equal(h.cache.take('elsewhere', 'message', prefix), undefined)
  assert.equal(h.cache.take('scene', 'old', prefix), undefined)
  assert.deepEqual(h.cache.take('scene', 'message', prefix + suffix), { prefix, pcm: pcmPrefix })
  assert.equal(h.cache.take('scene', 'message', prefix + suffix), undefined)
  assert.deepEqual(h.calls, [prefix])
})

test('revised punctuation and leading whitespace never reuse the cached voice', { timeout: 5000 }, async t => {
  for (const revision of ['我来啦！' + suffix, ' ' + prefix + suffix]) {
    await t.test(JSON.stringify(revision), async sub => {
      const h = await fixture(sub)
      h.cache.begin('attempt', prefix)
      h.cache.confirm('attempt', 'scene', 'message')
      await h.ready(prefix)
      const result = await collect(h.provider.stream(async () => consume(h.cache, revision), signal()))
      assert.deepEqual(result, pcmSuffix)
      assert.deepEqual(h.calls, [prefix, revision])
      assert.equal(h.cache.take('scene', 'message', prefix + suffix), undefined)
    })
  }
})

test('foreground aborts unfinished speculation and synthesizes the complete text in the same slot', { timeout: 5000 }, async t => {
  const full = prefix + suffix
  const h = await fixture(t, (text, res) => {
    if (text === prefix) res.writeHead(200, { 'content-type': 'audio/pcm' }).write(pcmPrefix)
    else pcm(res, pcmSuffix)
  })
  h.cache.begin('attempt', prefix)
  h.cache.confirm('attempt', 'scene', 'message')
  await h.called(prefix)
  const normal = h.provider.stream(async () => consume(h.cache, full), signal())
  assert.deepEqual(await collect(normal), pcmSuffix)
  assert.equal(await h.closed(prefix), true)
  assert.deepEqual(h.calls, [prefix, full])
  assert.equal(h.cache.take('scene', 'message', full), undefined)
})

test('foreground priority preserves ordinary busy errors and never queues background synthesis', { timeout: 5000 }, async t => {
  const h = await fixture(t, () => {})
  const controller = new AbortController()
  const first = h.provider.stream('ordinary', controller.signal)
  const playing = first.body.next()
  await h.called('ordinary')
  h.cache.begin('attempt', prefix)
  await h.ready(prefix)
  assert.deepEqual(h.calls, ['ordinary'])
  await assert.rejects(h.provider.stream('another ordinary', signal()).body.next(), /voice-stream-busy/u)
  controller.abort()
  await assert.rejects(playing, { name: 'AbortError' })
})

test('the takeover deadline keeps a stalled lease from opening another upstream request', { timeout: 5000 }, async t => {
  const h = await fixture(t, (text, res) => {
    if (text === prefix) res.writeHead(200, { 'content-type': 'audio/pcm' }).write(pcmPrefix)
    else pcm(res, pcmSuffix)
  })
  const parked = h.provider.prewarm(prefix, signal())
  assert.deepEqual((await parked.body.next()).value, pcmPrefix)
  const start = performance.now()
  await assert.rejects(h.provider.stream('ordinary', signal()).body.next(), /voice-stream-busy/u)
  assert.ok(performance.now() - start < 1500)
  assert.deepEqual(h.calls, [prefix])
  assert.equal(await h.closed(prefix), true)
  await parked.body.return()
  assert.deepEqual(await collect(h.provider.stream('ordinary', signal())), pcmSuffix)
})

test('the stage receives the cached first chunk before a delayed suffix and preserves byte ordering', { timeout: 5000 }, async t => {
  const h = await fixture(t, (text, res) => { if (text === prefix) pcm(res, pcmPrefix) })
  h.cache.begin('attempt', prefix)
  h.cache.confirm('attempt', 'scene', 'message')
  await h.ready(prefix)
  const joined = h.provider.stream(async () => consume(h.cache, prefix + suffix), signal())
  assert.equal(joined.sampleRate, sampleRate)
  assert.deepEqual(await joined.body.next(), { done: false, value: pcmPrefix })
  const response = await h.called(suffix)
  pcm(response, pcmSuffix)
  assert.deepEqual(await joined.body.next(), { done: false, value: pcmSuffix })
  assert.equal((await joined.body.next()).done, true)
  assert.deepEqual(h.calls, [prefix, suffix])
})

test('a full-prefix hit needs no suffix request, and suffix failure after cached audio is terminal', { timeout: 5000 }, async t => {
  const h = await fixture(t, (text, res) => {
    if (text === prefix) pcm(res, pcmPrefix)
    else res.writeHead(503).end()
  })
  h.cache.begin('first', prefix)
  h.cache.confirm('first', 'scene', 'message')
  await h.ready(prefix)
  assert.deepEqual(await collect(h.provider.stream(async () => consume(h.cache, prefix), signal())), pcmPrefix)
  assert.deepEqual(h.calls, [prefix])
  const failing = h.provider.stream(async () => ({ prefixPcm: pcmPrefix, text: suffix }), signal())
  assert.deepEqual((await failing.body.next()).value, pcmPrefix)
  await assert.rejects(failing.body.next(), /voice-stream-provider-status/u)
  assert.deepEqual(h.calls, [prefix, suffix])
})

test('ending a joined stream while it is draining the prefix also aborts the suffix request', { timeout: 5000 }, async t => {
  const h = await fixture(t, () => {})
  const joined = h.provider.stream(async () => ({ prefixPcm: pcmPrefix, text: suffix }), signal())
  assert.deepEqual((await joined.body.next()).value, pcmPrefix)
  await h.called(suffix)
  await joined.body.return()
  assert.equal(await h.closed(suffix), true)
})

test('a revision drops the old candidate and schedules only the latest prefix', { timeout: 5000 }, async t => {
  const latest = '我在这里。'
  const h = await fixture(t, (text, res) => { if (text === latest) pcm(res, pcmSuffix) })
  h.cache.begin('attempt', prefix)
  await h.called(prefix)
  h.cache.begin('attempt', '改一下。')
  h.cache.begin('attempt', latest)
  h.cache.confirm('attempt', 'scene', 'message')
  await h.ready(latest)
  assert.equal(await h.closed(prefix), true)
  assert.deepEqual(h.calls, [prefix, latest])
  assert.deepEqual(h.cache.take('scene', 'message', latest + suffix), { prefix: latest, pcm: pcmSuffix })
})

test('confirmed audio expires and cannot outlive cancellation or context removal', { timeout: 5000 }, async t => {
  for (const action of ['expiry', 'cancel', 'clearContext']) {
    await t.test(action, async sub => {
      const h = await fixture(sub)
      if (action === 'expiry') sub.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
      h.cache.begin('attempt', prefix)
      h.cache.confirm('attempt', 'scene', 'message')
      await h.ready(prefix)
      if (action === 'expiry') sub.mock.timers.tick(15_001)
      else if (action === 'cancel') h.cache.cancel('attempt')
      else h.cache.clearContext('scene')
      assert.equal(h.cache.take('scene', 'message', prefix), undefined)
    })
  }
})

test('the separate inference deadline closes stalled speculation and leaves foreground usable', { timeout: 5000 }, async t => {
  const h = await fixture(t, (text, res) => { if (text !== prefix) pcm(res, pcmSuffix) })
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const timeouts = t.mock.method(AbortSignal, 'timeout', ms => timeout(ms === 8000 ? 50 : ms))
  h.cache.begin('attempt', prefix)
  h.cache.confirm('attempt', 'scene', 'message')
  await h.called(prefix)
  await h.ready(prefix)
  assert.ok(timeouts.mock.calls.some(call => call.arguments[0] === 8000))
  assert.equal(await h.closed(prefix), true)
  const full = prefix + suffix
  assert.deepEqual(await collect(h.provider.stream(async () => consume(h.cache, full), signal())), pcmSuffix)
  assert.deepEqual(h.calls, [prefix, full])
})

test('speculation retains at most 8 seconds of PCM', { timeout: 5000 }, async t => {
  const h = await fixture(t, (_text, res) => pcm(res, Buffer.alloc(sampleRate * 2 * 8 + 2)))
  h.cache.begin('attempt', prefix)
  h.cache.confirm('attempt', 'scene', 'message')
  await h.ready(prefix)
  assert.equal(h.cache.take('scene', 'message', prefix), undefined)
})
