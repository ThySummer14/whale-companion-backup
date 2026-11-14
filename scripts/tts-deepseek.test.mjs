import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { DeepSeekTtsProvider } from '../src/host/tts-deepseek.ts'
import { TtsService } from '../src/host/tts.ts'

function wav(frames = 2400, rate = 24_000) {
  const data = Buffer.alloc(frames * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function directory(t) {
  const dir = mkdtempSync('.work/tts-deepseek-test-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('deepseek provider posts the stella wav request and stores validated audio', async t => {
  const dir = directory(t)
  const audio = wav()
  const seen = []
  const provider = new DeepSeekTtsProvider({
    apiKey: 'test-key', timeoutMs: 5000,
    fetcher: async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response(audio, { status: 200, headers: { 'content-length': String(audio.length) } })
    },
  })
  assert.equal(provider.configured(), true)
  assert.equal(await provider.health(), true)
  const out = join(dir, 'clip.wav')
  const result = await provider.synthesize('你好，大肥鱼。', out, new AbortController().signal)
  assert.deepEqual(result, { durationMs: 100, bytes: audio.length })
  assert.deepEqual(readFileSync(out), audio)
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.deepseek.com/v1/tools/tts')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-key')
  assert.deepEqual(JSON.parse(seen[0].init.body), { text: '你好，大肥鱼。', voice_id: 'stella', format: 'wav' })
})

test('provider finalizes streamed WAV placeholder sizes before validation', async t => {
  const dir = directory(t)
  const audio = wav()
  audio.writeUInt32LE(0xFFFFFFFF, 4)
  audio.writeUInt32LE(0xFFFFFFFF, 40)
  const provider = new DeepSeekTtsProvider({
    apiKey: 'test-key', timeoutMs: 5000,
    fetcher: async () => new Response(audio, { status: 200 }),
  })
  const out = join(dir, 'streamed.wav')
  const result = await provider.synthesize('你好', out, new AbortController().signal)
  assert.equal(result.durationMs, 100)
  const stored = readFileSync(out)
  assert.equal(stored.readUInt32LE(4), stored.length - 8)
  assert.equal(stored.readUInt32LE(40), stored.length - 44)
})

test('provider rejects billing, rate and busy statuses without writing audio', async t => {
  const dir = directory(t)
  for (const status of [402, 429, 503]) {
    const provider = new DeepSeekTtsProvider({
      apiKey: 'test-key', timeoutMs: 5000,
      fetcher: async () => new Response('{"error":{"message":"no"}}', { status }),
    })
    const out = join(dir, `clip-${status}.wav`)
    await assert.rejects(provider.synthesize('你好', out, new AbortController().signal), new RegExp(String(status)))
    assert.equal(existsSync(out), false)
  }
})

test('provider rejects oversized or invalid wav bodies', async t => {
  const dir = directory(t)
  const huge = new DeepSeekTtsProvider({
    apiKey: 'k', timeoutMs: 5000,
    fetcher: async () => new Response(wav(), { status: 200, headers: { 'content-length': '60000000' } }),
  })
  await assert.rejects(huge.synthesize('你好', join(dir, 'huge.wav'), new AbortController().signal), /size limit/u)
  const broken = new DeepSeekTtsProvider({
    apiKey: 'k', timeoutMs: 5000,
    fetcher: async () => new Response(Buffer.from('not a wav'), { status: 200 }),
  })
  await assert.rejects(broken.synthesize('你好', join(dir, 'broken.wav'), new AbortController().signal), /WAV/u)
})

test('provider without a key is unconfigured and never fetches', async t => {
  const dir = directory(t)
  let calls = 0
  const provider = new DeepSeekTtsProvider({
    apiKey: '  ', timeoutMs: 5000,
    fetcher: async () => { calls += 1; return new Response(wav()) },
  })
  assert.equal(provider.configured(), false)
  assert.equal(await provider.health(), false)
  await assert.rejects(provider.synthesize('你好', join(dir, 'none.wav'), new AbortController().signal), /key/u)
  assert.equal(calls, 0)
})

function service(t, apiKey, expressive) {
  const dir = directory(t)
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  t.after(() => store.close())
  const sessions = { history: async () => ({ sessionId: 'mobile', messages: [{ id: 'm1', role: 'assistant', text: '你好，我是大肥鱼。' }] }) }
  const audio = wav()
  const tts = new TtsService(store, sessions, {
    provider: 'deepseek',
    deepseek: { apiKey, timeoutMs: 5000, fetcher: async () => new Response(audio, { status: 200 }) },
    pythonPath: '', modelPath: '', mediaDir: join(dir, 'media'), timeoutMs: 5000,
    ...(expressive && { expressive }),
  })
  tts.start()
  t.after(() => tts.close())
  return { tts, store, dir, audio }
}

async function settled(tts, taskId) {
  for (let i = 0; i < 100; i++) {
    const view = tts.get(taskId)
    if (view.status === 'succeeded' || view.status === 'failed') return view
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('task did not settle')
}

test('cloud service hides expressive styles and synthesizes with the official voice', async t => {
  const { tts, audio } = service(t, 'test-key', { pythonPath: '/unused/python', modelDir: '/unused/models', timeoutMs: 5000 })
  assert.equal(tts.expressiveCapability(), undefined)
  await assert.rejects(tts.synthesizeMessage('chat.mobile', 'm1', 'happy'), { code: 'expressive-tts-unavailable' })
  const task = await tts.synthesizeClip('chat.mobile', 'm1', '你好，我是大肥鱼。')
  const view = await settled(tts, task.id)
  assert.equal(view.status, 'succeeded')
  const clip = await tts.audio(task.id)
  assert.equal(clip.bytes, audio.length)
})

test('cloud service without a key stays unavailable', async t => {
  const { tts } = service(t, '')
  await assert.rejects(tts.synthesizeClip('chat.mobile', 'm1', '你好'), { code: 'tts-unavailable' })
})