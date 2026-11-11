import { createHash } from 'node:crypto'
import { MAX_BILIBILI_CLIP_SECONDS, type BilibiliClipInput } from '../protocol/bilibili.ts'

const BVID = /^BV[A-Za-z0-9]{10}$/u
const PLAYER_ORIGIN = 'https://www.bilibili.com'
const SPACE_ORIGIN = 'https://space.bilibili.com'
const SUBTITLE_ORIGINS = new Set(['https://aisubtitle.hdslb.com', 'https://i0.hdslb.com'])
// The public WBI signature uses the first 32 positions of the published mixin order.
const WBI_PERMUTATION = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]

export function parseBilibiliTarget(input: string, part?: number): { bvid: string; part: number } | undefined {
  const value = input.trim()
  if (value.length > 2000) return
  let bvid = value
  let page = part ?? 1
  if (!BVID.test(value)) {
    if (!value.startsWith(`${PLAYER_ORIGIN}/video/`) || /[\\\s]/u.test(value)) return
    let url: URL
    try { url = new URL(value) } catch { return }
    const path = /^\/video\/(BV[A-Za-z0-9]{10})\/?$/u.exec(url.pathname)
    if (url.origin !== PLAYER_ORIGIN || !path?.[1]) return
    bvid = path[1]
    const params = url.searchParams.getAll('p')
    if (params.length > 1 || params[0] !== undefined && !/^\d{1,4}$/u.test(params[0])) return
    if (part === undefined && params[0] !== undefined) page = Number(params[0])
  }
  if (!Number.isInteger(page) || page < 1 || page > 1000) return
  return { bvid, part: page }
}

export function parseBilibiliCollection(input: string): { mid: string; seasonId: string } | undefined {
  const value = input.trim()
  if (value.length > 512 || !value.startsWith(`${SPACE_ORIGIN}/`) || /[\\\s]/u.test(value)) return
  let url: URL
  try { url = new URL(value) } catch { return }
  const path = /^\/([1-9]\d{0,15})\/lists\/([1-9]\d{0,15})\/?$/u.exec(url.pathname)
  const types = url.searchParams.getAll('type')
  if (url.origin !== SPACE_ORIGIN || !value.startsWith(`${SPACE_ORIGIN}${url.pathname}?`) ||
    url.hash || !path || types.length !== 1 || types[0] !== 'season') return
  const [, mid, seasonId] = path
  if (!mid || !seasonId || !Number.isSafeInteger(Number(mid)) || !Number.isSafeInteger(Number(seasonId))) return
  return { mid, seasonId }
}

export function parseBilibiliClipRequest(text: string): BilibiliClipInput | undefined {
  const match = /^(?:请[ \t]*)?(?:帮我[ \t]*)?(?:看这段|看片段)[：: \t]+(\S+)[ \t]+(\d{1,6}(?::\d{2}){0,2})[ \t]+(\d{1,2})[ \t]*秒(?:[ \t]+(画面和声音|画面|声音))?[。！!]?$/u.exec(text.trim())
  if (!match?.[1] || !match[2] || !match[3]) return
  const target = parseBilibiliTarget(match[1])
  const time = match[2].split(':').map(Number)
  if (!target || time.slice(1).some(part => part >= 60)) return
  const start = time.reduce((total, part) => total * 60 + part, 0)
  const seconds = Number(match[3])
  if (start > 7 * 86_400 || seconds < 1 || seconds > MAX_BILIBILI_CLIP_SECONDS) return
  const mode = match[4] === '画面' ? 'visual' : match[4] === '声音' ? 'audio' : 'both'
  return { ...target, start, seconds, mode }
}

export function subtitleUrl(value: string): URL | undefined {
  if (!value || value.length > 2048 || /[\\\s]/u.test(value)) return
  let url: URL
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value) } catch { return }
  if (!SUBTITLE_ORIGINS.has(url.origin) || url.username || url.password || url.hash) return
  if (!url.pathname.endsWith('.json') && !url.pathname.startsWith('/bfs/ai_subtitle/')) return
  return url
}

function keyStem(value: string): string | undefined {
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.protocol !== 'https:' || url.username || url.password) return
  return /\/([0-9a-f]{32})\.[a-z]+$/u.exec(url.pathname)?.[1]
}

export function wbiPlayerQuery(input: { bvid: string; cid: number }, image: string, sub: string, timestamp: number, dash = false): URLSearchParams | undefined {
  const first = keyStem(image)
  const second = keyStem(sub)
  if (!first || !second) return
  const key = first + second
  const mixin = WBI_PERMUTATION.map(index => key[index]).join('')
  const query = new URLSearchParams({ bvid: input.bvid, cid: String(input.cid),
    ...(dash && { fnval: '16', fourk: '0', qn: '16' }), wts: String(timestamp) })
  query.set('w_rid', createHash('md5').update(query.toString() + mixin).digest('hex'))
  return query
}

export function plainBilibiliText(value: string, maxBytes: number): string {
  const clean = value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()
  if (Buffer.byteLength(clean) <= maxBytes) return clean
  let size = 0
  let end = 0
  for (const character of clean) {
    size += Buffer.byteLength(character)
    if (size > maxBytes) break
    end += character.length
  }
  return clean.slice(0, end).trimEnd()
}
