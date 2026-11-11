import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { measureVoice } from './bench-voice.mjs'

const rate = 24000
const quiet = Buffer.alloc(480)
const voiced = Buffer.alloc(480)
for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(i % 4 ? -1000 : 1000, i)

async function serve(t, send) {
  const server = createServer((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/octet-stream')
    void send(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return `http://127.0.0.1:${server.address().port}`
}

function wave(data) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(data.length + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('measures first byte, full PCM sample, voiced window and EOF separately', async t => {
  const endpoint = await serve(t, async res => {
    res.write(quiet.subarray(0, 1))
    await delay(30)
    res.write(quiet.subarray(1))
    await delay(30)
    res.write(voiced)
    await delay(50)
    res.end(voiced)
  })
  const result = await measureVoice({ endpoint, body: {}, format: 'pcm', sampleRate: rate })
  assert.ok(result.firstByteMs < result.firstPcmMs)
  assert.ok(result.firstPcmMs < result.firstVoicedMs)
  assert.ok(result.totalMs - result.firstVoicedMs > 20)
  assert.equal(result.audioMs, 30)
})

test('detects the WAV format across chunks and excludes headers from audio', async t => {
  const wav = wave(voiced)
  const endpoint = await serve(t, async res => {
    res.write(wav.subarray(0, 43))
    await delay(30)
    res.end(wav.subarray(43))
  })
  const result = await measureVoice({ endpoint, body: {}, format: 'wav' })
  assert.ok(result.firstByteMs < result.firstPcmMs)
  assert.equal(result.firstPcmMs, result.firstVoicedMs)
  assert.equal(result.sampleRate, rate)
  assert.equal(result.audioMs, 10)
})

test('reports silence explicitly and rejects truncated WAVs', async t => {
  const silence = await serve(t, res => res.end(quiet))
  assert.equal((await measureVoice({ endpoint: silence, body: {}, format: 'pcm', sampleRate: rate })).firstVoicedMs, null)
  const partial = await serve(t, res => res.end(wave(voiced).subarray(0, 100)))
  await assert.rejects(measureVoice({ endpoint: partial, body: {}, format: 'wav' }), /complete audio/)
})

test('rejects non-loopback endpoints and does not follow loopback redirects', async t => {
  const endpoint = await serve(t, res => { res.writeHead(302, { location: 'http://example.com/' }); res.end() })
  await assert.rejects(measureVoice({ endpoint: 'http://example.com/', body: {}, format: 'wav' }), /loopback/)
  await assert.rejects(measureVoice({ endpoint, body: {}, format: 'wav' }), /fetch failed/)
})
