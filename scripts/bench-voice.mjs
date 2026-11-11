import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const corpus = [
  '早上好，我刚从海边回来。',
  '我记得你在手机上说过，我们要一起去我的世界找一片樱花林。',
  '等等，箱子里还有三块铁锭。我们先合成一把镐，再从营地旁边的小路出发吧。',
]
const maxBytes = 16 * 1024 * 1024
const voicedRms = 10 ** (-45 / 20)

// Parse only the prefix so a RIFF header, metadata, or partial sample never counts as audio.
function wavPrefix(buffer) {
  if (buffer.length < 12) return
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF/WAVE response')
  }
  let sampleRate
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const name = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const data = offset + 8
    if (name === 'data') {
      if (!sampleRate) throw new Error('WAV data precedes format')
      return { sampleRate, data, size }
    }
    offset = data + size + (size % 2)
    if (offset > buffer.length) return
    if (name === 'fmt ') {
      if (size < 16 || buffer.readUInt16LE(data) !== 1 || buffer.readUInt16LE(data + 2) !== 1 || buffer.readUInt16LE(data + 14) !== 16) {
        throw new Error('Expected 16-bit mono PCM WAV')
      }
      sampleRate = buffer.readUInt32LE(data + 4)
      if (sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid WAV sample rate')
    }
  }
}

class AudioProbe {
  constructor(format, sampleRate) {
    this.format = format
    this.sampleRate = sampleRate
    this.prefix = Buffer.alloc(0)
    this.samples = 0
    this.squareSum = 0
  }

  append(chunk, elapsed) {
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.format === 'wav' && this.remaining === undefined) {
      bytes = Buffer.concat([this.prefix, bytes])
      const info = wavPrefix(bytes)
      if (!info) {
        if (bytes.length >= 65536) throw new Error('WAV header exceeds 64 KiB')
        this.prefix = bytes
        return
      }
      if (info.data > 65536) throw new Error('WAV header exceeds 64 KiB')
      this.sampleRate = info.sampleRate
      this.remaining = info.size
      this.prefix = undefined
      bytes = bytes.subarray(info.data)
    }
    if (this.remaining !== undefined) {
      bytes = bytes.subarray(0, this.remaining)
      this.remaining -= bytes.length
    }
    if (!bytes.length) return
    if (this.tail !== undefined) bytes = Buffer.concat([Buffer.of(this.tail), bytes])
    const count = bytes.length >> 1
    this.tail = bytes.length % 2 ? bytes.at(-1) : undefined
    if (!count) return
    this.firstPcmMs ??= elapsed
    const windowSamples = Math.round(this.sampleRate / 100)
    for (let i = 0; i < count && this.firstVoicedMs === undefined; i++) {
      const sample = bytes.readInt16LE(i * 2) / 32768
      this.squareSum += sample * sample
      if ((this.samples + i + 1) % windowSamples === 0) {
        if (this.squareSum >= windowSamples * voicedRms ** 2) this.firstVoicedMs = elapsed
        this.squareSum = 0
      }
    }
    this.samples += count
  }
}

export async function measureVoice({ endpoint, body, format, sampleRate, timeout = 60000, fresh = false }) {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a loopback HTTP endpoint without URL credentials, query, or fragment')
  }
  if (format !== 'wav' && !(format === 'pcm' && Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000)) {
    throw new Error('Select wav or pcm with a valid sample rate')
  }
  const startedAt = performance.now()
  const elapsed = () => performance.now() - startedAt
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(fresh && { connection: 'close' }) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  })
  const headersMs = elapsed()
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Provider HTTP ${response.status}`)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (format === 'pcm' && !['application/octet-stream', 'audio/pcm', 'audio/x-pcm', 'audio/raw'].includes(contentType)) {
    await response.body.cancel()
    throw new Error('Expected a raw PCM response')
  }
  const probe = new AudioProbe(format, sampleRate)
  const reader = response.body.getReader()
  let received = 0
  let firstByteMs
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value.length) continue
      const arrival = elapsed()
      firstByteMs ??= arrival
      received += value.length
      if (received > maxBytes) throw new Error('Audio response exceeds 16 MiB')
      probe.append(value, arrival)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const totalMs = elapsed()
  if (!probe.samples || probe.tail !== undefined || probe.remaining > 0) {
    throw new Error('No complete audio response')
  }
  const audioMs = probe.samples * 1000 / probe.sampleRate
  return {
    headersMs,
    firstByteMs,
    firstPcmMs: probe.firstPcmMs,
    firstVoicedMs: probe.firstVoicedMs ?? null,
    totalMs,
    audioMs,
    rtf: totalMs / audioMs,
    sampleRate: probe.sampleRate,
  }
}

const options = {
  endpoint: { type: 'string' },
  'body-file': { type: 'string' },
  format: { type: 'string', default: 'pcm' },
  'sample-rate': { type: 'string', default: '24000' },
  trials: { type: 'string', default: '9' },
  warmup: { type: 'string', default: '2' },
  timeout: { type: 'string', default: '60000' },
  fresh: { type: 'boolean', default: false },
  help: { type: 'boolean' },
}

function integer(value, name, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return number
}

function summarize(trials, field) {
  const values = trials.map(trial => trial[field]).filter(Number.isFinite).sort((a, b) => a - b)
  if (!values.length) return { n: 0, p50: null, p95: null }
  const quantile = percentile => values[Math.ceil(values.length * percentile) - 1]
  return { n: values.length, p50: quantile(0.5), p95: quantile(0.95) }
}

async function main() {
  const { values } = parseArgs({ options })
  if (values.help) {
    console.log('node scripts/bench-voice.mjs --endpoint http://127.0.0.1:9880/tts --body-file preset.json [--format pcm|wav] [--sample-rate 48000] [--warmup 2] [--trials 9] [--timeout 60000] [--fresh]')
    return
  }
  if (!values.endpoint || !values['body-file']) throw new Error('--endpoint and --body-file are required (see --help)')
  let body
  try {
    body = JSON.parse(await readFile(values['body-file'], 'utf8'))
  } catch {
    throw new Error('Could not read a JSON request preset')
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Request preset must be a JSON object')
  const inputField = ['text', 'input', 'target_text'].find(field => Object.hasOwn(body, field)) ?? 'text'
  const trials = integer(values.trials, '--trials', 1, 100)
  const warmup = integer(values.warmup, '--warmup', 0, 20)
  const settings = {
    endpoint: values.endpoint,
    format: values.format,
    sampleRate: integer(values['sample-rate'], '--sample-rate', 8000, 96000),
    timeout: integer(values.timeout, '--timeout', 100, 180000),
    fresh: values.fresh,
  }
  const results = []
  for (let i = -warmup; i < trials; i++) {
    const sentence = ((i % corpus.length) + corpus.length) % corpus.length
    try {
      const result = await measureVoice({ ...settings, body: { ...body, [inputField]: corpus[sentence] } })
      if (i >= 0) results.push({ sentence: sentence + 1, ...result })
      if (result.firstVoicedMs === null) process.exitCode = 1
    } catch (error) {
      const failure = { sentence: sentence + 1, error: error.message }
      if (i >= 0) results.push(failure)
      else console.error(`Warm-up ${i + warmup + 1}: ${failure.error}`)
      process.exitCode = 1
    }
  }
  const metrics = ['headersMs', 'firstByteMs', 'firstPcmMs', 'firstVoicedMs', 'totalMs', 'audioMs', 'rtf']
  const summary = Object.fromEntries(metrics.map(field => [field, summarize(results, field)]))
  console.log(JSON.stringify({ format: settings.format, fresh: settings.fresh, warmup, trials, summary, results }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
