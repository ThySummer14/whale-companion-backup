import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepSeekAsrProvider } from '../src/host/asr-deepseek.ts'

function wav(seconds = 1, rate = 16_000) {
  const frames = seconds * rate
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2)
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

const read = buffer => async () => buffer

test('cloud ASR uploads the validated WAV as multipart file and returns trimmed text', async () => {
  const audio = wav()
  const seen = []
  const provider = new DeepSeekAsrProvider({
    apiKey: 'test-key', timeoutMs: 5000,
    fetcher: async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify({ request_id: 'r1', text: '  你好，我是大肥鱼。  ', duration_ms: 1000 }), { status: 200 })
    },
  })
  assert.equal(provider.configured(), true)
  const result = await provider.transcribe(read(audio), new AbortController().signal)
  assert.deepEqual(result, { text: '你好，我是大肥鱼。' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.deepseek.com/v1/tools/asr')
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-key')
  const form = seen[0].init.body
  assert.ok(form instanceof FormData)
  const file = form.get('file')
  assert.ok(file instanceof Blob)
  assert.equal(file.type, 'audio/wav')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio)
})

test('cloud ASR maps provider statuses and empty transcripts to stable device codes', async () => {
  const audio = wav()
  for (const [status, code] of [[413, 'asr-audio-too-large'], [429, 'asr-provider-unavailable'], [503, 'asr-provider-unavailable'], [400, 'asr-provider-status']]) {
    const provider = new DeepSeekAsrProvider({ apiKey: 'k', timeoutMs: 5000, fetcher: async () => new Response('{}', { status }) })
    await assert.rejects(provider.transcribe(read(audio), new AbortController().signal), { code })
  }
  const empty = new DeepSeekAsrProvider({ apiKey: 'k', timeoutMs: 5000, fetcher: async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 }) })
  await assert.rejects(empty.transcribe(read(audio), new AbortController().signal), { code: 'asr-no-speech' })
})

test('cloud ASR rejects invalid recordings before any network call', async () => {
  let calls = 0
  const provider = new DeepSeekAsrProvider({ apiKey: 'k', timeoutMs: 5000, fetcher: async () => { calls += 1; return new Response('{}') } })
  const stereo = wav()
  stereo.writeUInt16LE(2, 22)
  await assert.rejects(provider.transcribe(read(stereo), new AbortController().signal), { code: 'asr-invalid-wav' })
  assert.equal(calls, 0)
})

test('cloud ASR accepts the 24k WAV produced by cloud TTS', async () => {
  const audio = wav(1, 24_000)
  const provider = new DeepSeekAsrProvider({
    apiKey: 'k', timeoutMs: 5000,
    fetcher: async () => new Response(JSON.stringify({ text: '你好' }), { status: 200 }),
  })
  assert.deepEqual(await provider.transcribe(read(audio), new AbortController().signal), { text: '你好' })
})

test('cloud ASR without a key is unconfigured and never fetches', async () => {
  let calls = 0
  const provider = new DeepSeekAsrProvider({ apiKey: '', timeoutMs: 5000, fetcher: async () => { calls += 1; return new Response('{}') } })
  assert.equal(provider.configured(), false)
  await assert.rejects(provider.transcribe(read(wav()), new AbortController().signal), { code: 'asr-unconfigured' })
  assert.equal(calls, 0)
})