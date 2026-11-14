import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { RealtimePcmProvider } from '../src/host/realtime-pcm.ts'

const PCM = Buffer.alloc(4800, 7)

function server(t, behavior) {
  const wss = new WebSocketServer({ port: 0 })
  t.after(() => new Promise(resolve => wss.close(resolve)))
  const seen = []
  wss.on('connection', (socket, req) => {
    seen.push({ authorization: req.headers.authorization, url: req.url })
    socket.on('message', raw => {
      const message = JSON.parse(String(raw))
      seen.push(message)
      if (message.event === 'finish_text') behavior(socket, seen)
    })
  })
  return { wss, seen }
}

function provider(port, apiKey = 'test-key') {
  return new RealtimePcmProvider({
    protocol: 'deepseek', apiKey, endpoint: `ws://127.0.0.1:${port}`, timeoutMs: 5000,
  })
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream.body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('deepseek realtime protocol streams PCM frames after finish_text at 24k', async t => {
  const { wss, seen } = server(t, socket => {
    socket.send(PCM.subarray(0, 1600), { binary: true })
    socket.send(PCM.subarray(1600, 3200), { binary: true })
    socket.send(PCM.subarray(3200), { binary: true })
    socket.send(JSON.stringify({ event: 'finish', code: 'success', message: 'ok' }))
  })
  const pcm = provider(wss.address().port)
  t.after(() => pcm.close())
  const stream = pcm.stream('你好，我是大肥鱼。', new AbortController().signal)
  assert.equal(stream.sampleRate, 24_000)
  assert.deepEqual(await collect(stream), PCM)
  assert.equal(seen[0].authorization, 'Bearer test-key')
  assert.ok(seen[0].url.includes('voice_id=stella'))
  assert.ok(seen[0].url.includes('format=pcm'))
  assert.deepEqual(seen.slice(1), [
    { event: 'text', text: '你好，我是大肥鱼。' },
    { event: 'finish_text' },
  ])
})

test('deepseek realtime surfaces provider finish errors and closes on abort', async t => {
  const failing = server(t, socket => {
    socket.send(JSON.stringify({ event: 'finish', code: 'content_filter', message: 'risk' }))
  })
  const bad = provider(failing.wss.address().port)
  t.after(() => bad.close())
  await assert.rejects(collect(bad.stream('你好', new AbortController().signal)), /content_filter/u)

  const slow = server(t, socket => {
    socket.send(PCM.subarray(0, 1600), { binary: true })
  })
  const aborted = provider(slow.wss.address().port)
  t.after(() => aborted.close())
  const controller = new AbortController()
  const stream = aborted.stream('你好', controller.signal)
  const first = await stream.body.next()
  assert.equal(first.done, false)
  controller.abort()
  await assert.rejects(stream.body.next(), /abort/u)
})