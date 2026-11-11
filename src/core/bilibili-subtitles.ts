import type { DatabaseSync } from 'node:sqlite'
import type { BilibiliSubtitleDocument, BilibiliSubtitleExcerpt, BilibiliSubtitleProvenance } from '../protocol/bilibili.ts'
import { parseBilibiliTarget } from './bilibili.ts'

const MAX_ATTACHMENTS = 32
const MAX_EXCERPT_CUES = 12
const MAX_EXCERPT_BYTES = 1200
const MAX_VIDEO_SECONDS = 7 * 24 * 3600

type DocumentInput = Omit<BilibiliSubtitleDocument, 'updatedAt' | 'excerptCueCount'> & { excerpt: BilibiliSubtitleExcerpt }
type DocumentRow = {
  bvid: string; part: number; cid: number; format: BilibiliSubtitleDocument['format']; sha256: string
  cue_count: number; excerpt_cue_count: number; updated_at: string
}
type StoredExcerpt = Omit<BilibiliSubtitleExcerpt, 'provenance'>
export type BilibiliStoredSubtitle = BilibiliSubtitleDocument & {
  excerpt: StoredExcerpt & { provenance: BilibiliSubtitleProvenance }
}

export function isBilibiliSubtitleDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function document(row: DocumentRow): BilibiliSubtitleDocument {
  return {
    bvid: row.bvid, part: row.part, cid: row.cid, format: row.format, sha256: row.sha256,
    cueCount: row.cue_count, excerptCueCount: row.excerpt_cue_count, updatedAt: row.updated_at,
  }
}

function validExcerpt(input: DocumentInput): boolean {
  const { excerpt } = input
  if (excerpt?.status !== 'excerpt' || excerpt.provenance?.kind !== 'owner-supplied' ||
    excerpt.provenance.sha256 !== input.sha256 || typeof excerpt.language !== 'string' || !/^[a-z0-9-]{1,32}$/iu.test(excerpt.language) ||
    typeof excerpt.truncated !== 'boolean' || !Array.isArray(excerpt.cues) ||
    excerpt.cues.length < 1 || excerpt.cues.length > Math.min(input.cueCount, MAX_EXCERPT_CUES)) return false
  let previous = -1
  let bytes = 0
  for (const cue of excerpt.cues) {
    if (!cue) return false
    const { from, to, text } = cue
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from < previous || to <= from || to > MAX_VIDEO_SECONDS ||
      typeof text !== 'string' || !text.trim() || !text.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(text)) return false
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_EXCERPT_BYTES) return false
    previous = from
  }
  return true
}

const DOCUMENT_COLUMNS = 'bvid,part,cid,format,sha256,cue_count,excerpt_cue_count,updated_at'

export class BilibiliSubtitleRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  view(): BilibiliSubtitleDocument[] {
    const rows = this.db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM bilibili_subtitle_attachment
      ORDER BY updated_at DESC,bvid,part`).all() as unknown as DocumentRow[]
    return rows.map(document)
  }

  get(bvid: string, part: number): BilibiliStoredSubtitle | undefined {
    const row = this.db.prepare(`SELECT ${DOCUMENT_COLUMNS},excerpt_json FROM bilibili_subtitle_attachment WHERE bvid=? AND part=?`)
      .get(bvid, part) as unknown as (DocumentRow & { excerpt_json: string }) | undefined
    if (!row) return
    const excerpt = JSON.parse(row.excerpt_json) as StoredExcerpt
    return { ...document(row), excerpt: { ...excerpt, provenance: { kind: 'owner-supplied', sha256: row.sha256 } } }
  }

  save(input: DocumentInput): BilibiliSubtitleDocument | undefined {
    if (typeof input.bvid !== 'string' || parseBilibiliTarget(input.bvid, input.part)?.bvid !== input.bvid ||
      !Number.isSafeInteger(input.cid) || input.cid < 1 ||
      (input.format !== 'srt' && input.format !== 'vtt') || !isBilibiliSubtitleDigest(input.sha256) ||
      !Number.isInteger(input.cueCount) || input.cueCount < 1 || input.cueCount > 6000 || !validExcerpt(input)) return
    const { bvid, part, cid, format, sha256, cueCount } = input
    const { language, cues, truncated } = input.excerpt
    const excerpt: StoredExcerpt = { status: 'excerpt', language, cues: cues.map(({ from, to, text }) => ({ from, to, text })), truncated }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT 1 FROM bilibili_subtitle_attachment WHERE bvid=? AND part=?').get(bvid, part)
      if (!existing && Number(this.db.prepare('SELECT count(*) AS n FROM bilibili_subtitle_attachment').get()?.n) >= MAX_ATTACHMENTS) return
      const updatedAt = new Date().toISOString()
      this.db.prepare(`INSERT INTO bilibili_subtitle_attachment
        (${DOCUMENT_COLUMNS},excerpt_json) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(bvid,part) DO UPDATE SET cid=excluded.cid,format=excluded.format,sha256=excluded.sha256,
          cue_count=excluded.cue_count,excerpt_cue_count=excluded.excerpt_cue_count,
          updated_at=excluded.updated_at,excerpt_json=excluded.excerpt_json`)
        .run(bvid, part, cid, format, sha256, cueCount, cues.length, updatedAt, JSON.stringify(excerpt))
      return { bvid, part, cid, format, sha256, cueCount, excerptCueCount: cues.length, updatedAt }
    })
  }

  remove(bvid: string, part: number): boolean {
    return !!this.db.prepare('DELETE FROM bilibili_subtitle_attachment WHERE bvid=? AND part=?').run(bvid, part).changes
  }
}
