import { spawn } from 'node:child_process'
import { z } from 'zod'
import { DeviceAuthError } from './devices.ts'

export type ByteRange = { first: number; last: number }
type TrackKind = 'audio' | 'video'
type Fragment = ByteRange & { from: number; to: number; independent: boolean }
type Track = { url: URL; initialization: ByteRange; index: ByteRange }
const MAX_HEADER_BYTES = 128 * 1024
const MAX_TRACK_BYTES: Record<TrackKind, number> = { audio: 640 * 1024, video: 1536 * 1024 }
const MAX_FRAME_BYTES = 160 * 1024
const RATE = 16_000

const base = z.object({ Initialization: z.string().optional(), initialization: z.string().optional(),
  indexRange: z.string().optional(), index_range: z.string().optional() })
const representation = z.object({
  baseUrl: z.string().optional(), base_url: z.string().optional(), codecs: z.string(),
  bandwidth: z.int().positive(), width: z.int().nonnegative().optional(), height: z.int().nonnegative().optional(),
  SegmentBase: base.optional(), segment_base: base.optional(),
})
const tracks = z.object({ dash: z.object({ audio: z.array(z.unknown()).max(32).nullish(), video: z.array(z.unknown()).max(64).nullish() }) })

const invalid = () => new DeviceAuthError(422, 'bili-clip-index-unavailable')

function range(text?: string): ByteRange | undefined {
  const parsed = text && /^(\d{1,10})-(\d{1,10})$/u.exec(text)
  if (!parsed) return
  const first = Number(parsed[1])
  const last = Number(parsed[2])
  if (first <= last) return { first, last }
}

export function bilibiliTrackUrl(value: string, cid: number): URL | undefined {
  if (value.length > 2048 || /[\\\s]/u.test(value)) return
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !/^[a-z0-9][a-z0-9.-]*\.bilivideo\.(?:com|cn)$/u.test(url.hostname) ||
      !new RegExp(`/${cid}-[0-9]+-[0-9]+\\.m4s$`, 'u').test(url.pathname)) return
  return url
}

export function selectBilibiliTrack(data: unknown, kind: TrackKind, cid: number): Track | undefined {
  const parsed = tracks.safeParse(data)
  if (!parsed.success) return
  const eligible = (parsed.data.dash[kind] ?? []).flatMap(value => {
    const entry = representation.safeParse(value)
    if (!entry.success) return []
    const t = entry.data
    if (kind === 'video' ? !/^avc1\./u.test(t.codecs) || !t.width || t.width > 1280 || !t.height || t.height > 720
      : t.codecs !== 'mp4a.40.2') return []
    const url = bilibiliTrackUrl(t.baseUrl ?? t.base_url ?? '', cid)
    const segment = t.SegmentBase ?? t.segment_base
    const initialization = range(segment?.Initialization ?? segment?.initialization)
    const index = range(segment?.indexRange ?? segment?.index_range)
    if (!url || initialization?.first !== 0 || !index || index.first !== initialization.last + 1 || index.last >= MAX_HEADER_BYTES) return []
    return [{ url, initialization, index, bandwidth: t.bandwidth }]
  }).sort((a, b) => a.bandwidth - b.bandwidth)
  return eligible[0]
}

export function sidxFragments(bytes: Buffer, index: ByteRange): Fragment[] {
  if (bytes.length !== index.last - index.first + 1 || bytes.length > MAX_HEADER_BYTES) throw invalid()
  let begin = 0
  while (begin + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(begin)
    const end = begin + size
    if (size < 8 || end > bytes.length) throw invalid()
    if (bytes.toString('ascii', begin + 4, begin + 8) !== 'sidx') { begin = end; continue }
    if (size < 32) throw invalid()
    const version = bytes[begin + 8]
    const scale = bytes.readUInt32BE(begin + 16)
    const wide = version === 1
    if (!scale || version !== 0 && !wide || wide && size < 40) throw invalid()
    const read = (offset: number) => wide ? Number(bytes.readBigUInt64BE(begin + offset)) : bytes.readUInt32BE(begin + offset)
    let time = read(20)
    let offset = index.first + end + read(wide ? 28 : 24)
    const head = begin + (wide ? 40 : 32)
    const count = bytes.readUInt16BE(head - 2)
    if (!count || count > 4096 || head + count * 12 !== end || !Number.isSafeInteger(time) || !Number.isSafeInteger(offset)) throw invalid()
    const result: Fragment[] = []
    for (let i = 0; i < count; i++) {
      const at = head + i * 12
      const length = bytes.readUInt32BE(at)
      const duration = bytes.readUInt32BE(at + 4)
      const sap = bytes.readUInt32BE(at + 8)
      if (!length || length >= 2 ** 31 || !duration || !Number.isSafeInteger(time + duration) || !Number.isSafeInteger(offset + length)) throw invalid()
      // FFmpeg also writes a set starts_with_SAP bit with type 0.
      result.push({ first: offset, last: offset + length - 1, from: time / scale, to: (time + duration) / scale,
        independent: (sap >>> 28) >= 8 && (sap >>> 28) <= 10 && (sap & 0x0fff_ffff) === 0 })
      offset += length
      time += duration
    }
    return result
  }
  throw invalid()
}

export async function readBilibiliFragment(track: Track, kind: TrackKind, start: number, seconds: number,
  read: (url: URL, range: ByteRange) => Promise<Buffer>): Promise<{ data: Buffer; skip: number }> {
  const head = await read(track.url, { first: 0, last: track.index.last })
  const entries = sidxFragments(head.subarray(track.index.first), track.index)
  let first = entries.findIndex(item => item.to > start)
  const end = entries.findIndex(item => item.to >= start + seconds - 0.03)
  if (first < 0 || end < first || entries[first]!.from > start + (start === 0 ? 0.25 : 0.03)) throw invalid()
  if (kind === 'video') {
    while (first > 0 && !entries[first]!.independent) first--
    if (!entries[first]!.independent || start - entries[first]!.from > 15) throw invalid()
  }
  const left = entries[first]!
  const right = entries[end]!
  if (right.last - left.first + 1 > MAX_TRACK_BYTES[kind]) throw new DeviceAuthError(413, 'bili-clip-budget')
  const fragments = await read(track.url, { first: left.first, last: right.last })
  return { data: Buffer.concat([head.subarray(0, track.initialization.last + 1), fragments]), skip: Math.max(0, start - left.from) }
}

async function decode(ffmpeg: string, input: Buffer, options: string[], limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe',
      '-max_alloc', '33554432', '-threads', '1', '-filter_threads', '1', '-f', 'mov', '-i', 'pipe:0', ...options],
    { stdio: ['pipe', 'pipe', 'ignore'], signal, killSignal: 'SIGKILL' })
    const output: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) child.kill('SIGKILL')
      else output.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(signal.aborted ? signal.reason : new DeviceAuthError(503, error.code === 'ENOENT' ? 'bili-clip-decoder-unavailable' : 'bili-clip-decode-failed'))
    })
    child.on('close', code => {
      if (signal.aborted) reject(signal.reason)
      else if (bytes > limit) reject(new DeviceAuthError(413, 'bili-clip-budget'))
      else if (code !== 0 || !bytes) reject(new DeviceAuthError(422, 'bili-clip-decode-failed'))
      else resolve(Buffer.concat(output, bytes))
    })
    child.stdin.end(input)
  })
}

export async function decodeBilibiliFrames(ffmpeg: string, { data, skip }: { data: Buffer; skip: number },
  seconds: number, signal: AbortSignal): Promise<Buffer> {
  const filter = `trim=start=${skip.toFixed(4)}:duration=${seconds},setpts=PTS-STARTPTS,fps=3/${seconds},scale=320:-2,tile=3x1`
  return decode(ffmpeg, data, ['-map', '0:v:0', '-an', '-vf', filter,
    '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'], MAX_FRAME_BYTES, signal)
}

export async function decodeBilibiliAudio(ffmpeg: string, { data, skip }: { data: Buffer; skip: number },
  seconds: number, signal: AbortSignal): Promise<Buffer> {
  const pcm = await decode(ffmpeg, data, ['-map', '0:a:0', '-vn', '-ss', skip.toFixed(4), '-t', String(seconds),
    '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], RATE * seconds * 2, signal)
  const header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
