import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { AceStepSingingProvider } from '../src/host/singing-provider.ts'

const input = { title: '潮汐', lyrics: '潮水轻轻拍岸', style: 'gentle acoustic song', durationSeconds: 10 }
const audioPath = '/private/tmp/ace step/api_audio/550e8400-e29b-41d4-a716-446655440000.wav'
const audioLink = `/v1/audio?path=${encodeURIComponent(audioPath)}`

function fixtureWav() {
  const audio = Buffer.alloc(44 + 16_000 * 10 * 2)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16_000, 24)
  audio.writeUInt32LE(32_000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(audio.length - 44, 40)
  audio.writeInt16LE(1000, 44)
  return audio
}

function wrap(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, code: 200, error: null }))
}

function queued(res, id = 'job-1') {
  wrap(res, { task_id: id, status: 'queued' })
}

function result(res, status, id = 'job-1', file = audioLink) {
  wrap(res, [{ task_id: id, status, result: JSON.stringify([{ file, status }]) }])
}

async function serve(t, reply, timeoutMs) {
  const seen = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const call = { method: req.method, url: req.url, input: raw ? JSON.parse(raw) : undefined }
      seen.push(call)
      reply(call, res)
    })().catch(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new AceStepSingingProvider(`http://127.0.0.1:${server.address().port}`, timeoutMs)
  t.after(() => {
    provider.close()
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { provider, seen }
}

test('only accepts an exact loopback origin and a bounded deadline', () => {
  for (const origin of [
    'https://127.0.0.1:8001', 'http://localhost:8001', 'http://127.1:8001', 'http://127.0.0.1',
    'http://127.0.0.1:65536', 'http://127.0.0.1:8001/?x=1', 'http://127.0.0.1:8001/release_task',
    'http://127.0.0.1:8001#fragment', 'http://name@127.0.0.1:8001', 'http://[::2]:8001',
  ]) assert.throws(() => new AceStepSingingProvider(origin), /exact loopback/u)
  assert.throws(() => new AceStepSingingProvider('http://127.0.0.1:8001', 999), /timeout/u)
  new AceStepSingingProvider('http://[::1]:8001').close()
})

test('submits a single sung result, checks task identity and returns exact generated WAV bytes', async t => {
  const wav = fixtureWav()
  const { provider, seen } = await serve(t, (call, res) => {
    if (call.url === '/release_task') queued(res)
    else if (call.url === '/query_result') result(res, 1)
    else res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length }).end(wav)
  })
  assert.deepEqual(await provider.generate(input, new AbortController().signal), wav)
  assert.deepEqual(seen.map(call => call.method), ['POST', 'POST', 'GET'])
  assert.deepEqual(seen[0].input, {
    task_type: 'text2music', prompt: 'Sung vocals. gentle acoustic song\nTitle: 潮汐', lyrics: input.lyrics,
    vocal_language: 'zh', audio_duration: 10, audio_format: 'wav', batch_size: 1,
    thinking: false, use_format: false, use_cot_caption: false, use_cot_language: false,
  })
  assert.deepEqual(seen[1].input, { task_id_list: ['job-1'] })
  const url = new URL(seen[2].url, 'http://127.0.0.1')
  assert.equal(url.pathname, '/v1/audio')
  assert.equal(url.searchParams.get('path'), audioPath)
})

test('rejects wrong task identities, non-generated paths and cross-origin or redirected results', async t => {
  for (const fixture of [
    { id: 'job-other', file: audioLink },
    { file: 'https://example.invalid/v1/audio?path=/tmp/a.wav' },
    { file: `/v1/audio?path=${encodeURIComponent('/tmp/../api_audio/550e8400-e29b-41d4-a716-446655440000.wav')}` },
    { file: `/v1/audio?path=${encodeURIComponent('/tmp/voice/550e8400-e29b-41d4-a716-446655440000.wav')}` },
    { file: `${audioLink}&path=${encodeURIComponent(audioPath)}` },
    { file: audioLink, redirect: true },
  ]) {
    const { provider, seen } = await serve(t, (call, res) => {
      if (call.url === '/release_task') queued(res)
      else if (call.url === '/query_result') result(res, 1, fixture.id, fixture.file)
      else res.writeHead(302, { location: '/must-not-follow' }).end()
    })
    await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-response-invalid/u)
    assert.equal(seen.length, fixture.redirect ? 3 : 2)
    assert.equal(seen.some(call => call.url === '/must-not-follow'), false)
  }
})

test('rejects oversized metadata and corrupt WAV even if the engine reports success', async t => {
  for (const fixture of ['metadata', 'audio-size', 'audio-header']) {
    const { provider } = await serve(t, (call, res) => {
      if (call.url === '/release_task') queued(res)
      else if (call.url === '/query_result') {
        if (fixture === 'metadata') res.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(65_537))
        else result(res, 1)
      } else if (fixture === 'audio-size') {
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': 24 * 1024 * 1024 + 1 }).end(Buffer.alloc(44))
      } else res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.alloc(44))
    })
    await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-response-invalid/u)
  }
})

test('after local cancellation checks the prior job before allowing another submit', async t => {
  let submitCount = 0
  let oldStatus = 0
  let onFirstQuery
  const queried = new Promise(resolve => { onFirstQuery = resolve })
  const wav = fixtureWav()
  const { provider, seen } = await serve(t, (call, res) => {
    if (call.url === '/release_task') queued(res, `job-${++submitCount}`)
    else if (call.url === '/query_result') {
      const id = call.input.task_id_list[0]
      result(res, id === 'job-1' ? oldStatus : 1, id)
      onFirstQuery()
    } else res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav)
  })
  const first = new AbortController()
  const pending = provider.generate(input, first.signal)
  await queried
  first.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-busy/u)
  assert.equal(submitCount, 1)
  oldStatus = 2
  assert.deepEqual(await provider.generate(input, new AbortController().signal), wav)
  assert.equal(submitCount, 2)
  assert.equal(seen.filter(call => call.method === 'GET').length, 1)
})

test('a lost submit receipt cannot trigger duplicate upstream work', async t => {
  const { provider, seen } = await serve(t, (_call, res) => res.destroy())
  await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-failed/u)
  await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-busy/u)
  assert.equal(seen.length, 1)
})

test('a bounded deadline stops polling without claiming a successful result', async t => {
  const { provider, seen } = await serve(t, (call, res) => {
    if (call.url === '/release_task') queued(res)
    else result(res, 0)
  }, 1000)
  await assert.rejects(provider.generate(input, new AbortController().signal), /singing-provider-timeout/u)
  assert.deepEqual(seen.map(call => call.url), ['/release_task', '/query_result'])
})
