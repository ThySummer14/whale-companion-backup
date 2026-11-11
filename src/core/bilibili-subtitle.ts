import { MAX_BILIBILI_SUBTITLE_BYTES, type BilibiliSubtitleCue, type BilibiliSubtitleFormat } from '../protocol/bilibili.ts'
import { plainBilibiliText } from './bilibili.ts'

const MAX_CUES = 6_000
const MAX_SECONDS = 7 * 24 * 60 * 60
const SRT_TIMESTAMP = /^(\d{2,3}):([0-5]\d):([0-5]\d),(\d{3})$/u
const VTT_TIMESTAMP = /^(?:(\d{2,3}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/u
const MARKUP = /<\/?[a-z][^<>\n]*>|<(?:\d{2,3}:)?[0-5]\d:[0-5]\d\.\d{3}>|\{\\an[1-9]\}/giu
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '', quot: '"', apos: "'",
}

function timestamp(value: string, format: BilibiliSubtitleFormat): number | undefined {
  const match = (format === 'srt' ? SRT_TIMESTAMP : VTT_TIMESTAMP).exec(value)
  if (!match) return
  const [, hours = '0', minutes, seconds, fraction] = match
  const whole = (Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)
  const time = (whole * 1000 + Number(fraction)) / 1000
  return time <= MAX_SECONDS ? time : undefined
}

function timing(line: string, format: BilibiliSubtitleFormat): { from: number; to: number } | undefined {
  const [start, arrow, end, ...settings] = line.trim().split(/[ \t]+/u)
  if (!start || !end || arrow !== '-->') return
  if (format === 'srt' && settings.length) return
  if (settings.some(value => !/^[a-z][a-z\d-]*:[^ \t]+$/iu.test(value) || value.includes('-->'))) return
  const from = timestamp(start, format)
  const to = timestamp(end, format)
  if (from === undefined || to === undefined || from >= to) return
  return { from, to }
}

function cueText(value: string): string {
  const text = value.replace(MARKUP, '').replace(
    /&(?:(amp|lt|gt|nbsp|lrm|rlm|quot|apos)|#(x[\da-f]{1,6}|\d{1,7}));/giu,
    (reference: string, name: string | undefined, numeric: string | undefined) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? reference
      if (!numeric) return reference
      const codepoint = numeric.toLowerCase().startsWith('x') ? Number.parseInt(numeric.slice(1), 16) : Number(numeric)
      if (codepoint < 32 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return reference
      return String.fromCodePoint(codepoint)
    },
  )
  return plainBilibiliText(text.replace(MARKUP, ''), MAX_BILIBILI_SUBTITLE_BYTES)
}

export function parseBilibiliSubtitleFile(format: BilibiliSubtitleFormat, content: string): BilibiliSubtitleCue[] | undefined {
  if (format !== 'srt' && format !== 'vtt') return
  if (!content || Buffer.byteLength(content) > MAX_BILIBILI_SUBTITLE_BYTES ||
    !content.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(content)) return
  const blocks = content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trimEnd().split(/\n(?:[ \t]*\n)+/u)
  if (format === 'vtt') {
    const header = blocks.shift()
    if (!header || !/^WEBVTT(?:[ \t][^\n]*)?$/u.test(header) || header.includes('-->')) return
  }
  const cues: BilibiliSubtitleCue[] = []
  const identifiers = new Set<string>()
  for (const block of blocks) {
    const [first = '', ...lines] = block.split('\n')
    let timeLine = first
    if (format === 'srt') {
      const ordinal = first.trim()
      if (!/^\d{1,9}$/u.test(ordinal) || Number(ordinal) === 0) return
      timeLine = lines.shift() ?? ''
    } else if (/^NOTE(?:[ \t]|$)/u.test(first) || (!cues.length && /^(?:STYLE|REGION)[ \t]*$/u.test(first))) {
      if (block.includes('-->')) return
      continue
    } else if (!first.includes('-->')) {
      if (!first.trim() || identifiers.has(first)) return
      identifiers.add(first)
      timeLine = lines.shift() ?? ''
    }
    const times = timing(timeLine, format)
    if (!times || times.from < (cues.at(-1)?.from ?? 0) || cues.length >= MAX_CUES) return
    const payload = lines.join('\n')
    if (payload.includes('-->')) return
    const text = cueText(payload)
    if (!text) return
    cues.push({ ...times, text })
  }
  if (cues.length) return cues
}
