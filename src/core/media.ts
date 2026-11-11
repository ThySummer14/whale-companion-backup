import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MAX_SINGING_SCORE_SECONDS, type SingingCoverEngine } from '../protocol/singing.ts'
import type { MediaAsset, MediaCleanupPreview, MediaKind, MediaSummary } from './model.ts'

export type MediaAssetInput = Omit<MediaAsset, 'id' | 'hash' | 'bytes' | 'lastVerifiedAt' | 'missingAt' | 'deletedAt'> & Partial<Pick<MediaAsset, 'id' | 'hash' | 'bytes' | 'lastVerifiedAt' | 'missingAt' | 'deletedAt'>>

export class MediaRepository {
  constructor(private readonly db: DatabaseSync) {}

  private fromRow(row: unknown): MediaAsset {
    const value = row as { id: string; kind: MediaKind; path: string; hash: string | null; mime_type: string; bytes: number; source: string; source_ref: string | null; retention: MediaAsset['retention']; created_at: string; last_used_at: string; last_verified_at: string; missing_at: string | null; deleted_at: string | null }
    return { id: value.id, kind: value.kind, path: value.path, hash: value.hash ?? undefined, mimeType: value.mime_type, bytes: Number(value.bytes), source: value.source, sourceRef: value.source_ref ?? undefined, retention: value.retention, createdAt: value.created_at, lastUsedAt: value.last_used_at, lastVerifiedAt: value.last_verified_at, missingAt: value.missing_at ?? undefined, deletedAt: value.deleted_at ?? undefined }
  }

  list(options: { kind?: MediaKind; limit?: number } = {}): MediaAsset[] {
    const limit = Math.floor(Math.max(1, Math.min(500, options.limit ?? 200)))
    const rows = options.kind
      ? this.db.prepare('SELECT * FROM media_asset WHERE kind=? AND deleted_at IS NULL ORDER BY last_used_at DESC, id DESC LIMIT ?').all(options.kind, limit)
      : this.db.prepare('SELECT * FROM media_asset WHERE deleted_at IS NULL ORDER BY last_used_at DESC, id DESC LIMIT ?').all(limit)
    return rows.map(row => this.fromRow(row))
  }

  get(id: string): MediaAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media_asset WHERE id=?').get(id)
    return row ? this.fromRow(row) : undefined
  }

  byPath(path: string): MediaAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media_asset WHERE path=?').get(path)
    return row ? this.fromRow(row) : undefined
  }

  songVocalEnvelope(id: string, hash: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT samples FROM song_vocal_envelope WHERE asset_id=? AND audio_hash=?').get(id, hash)
    return row?.samples instanceof Uint8Array ? row.samples : undefined
  }

  saveSongVocalEnvelope(id: string, hash: string, samples: Uint8Array): void {
    const inserted = this.db.prepare(`INSERT INTO song_vocal_envelope (asset_id,audio_hash,samples)
      SELECT id,hash,? FROM media_asset WHERE id=? AND hash=? AND kind='song' AND source='singing'`).run(samples, id, hash)
    if (!inserted.changes) throw new Error('Song vocal envelope requires its verified archive')
  }

  songCoverEngine(id: string, hash: string): SingingCoverEngine | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(songCoverEngineKey(id, hash))
    if (row?.value === '"seed-vc"') return 'seed-vc'
    if (row?.value === '"applio-rvc"') return 'applio-rvc'
  }

  saveSongCoverEngine(id: string, hash: string, engine: SingingCoverEngine): void {
    const inserted = this.db.prepare(`INSERT INTO state (key,value)
      SELECT ?,? FROM media_asset WHERE id=? AND hash=? AND kind='song' AND source='singing' AND source_ref=id`)
      .run(songCoverEngineKey(id, hash), JSON.stringify(engine), id, hash)
    if (!inserted.changes) throw new Error('Song cover engine requires its verified archive')
  }

  songDuration(id: string, hash: string): number | undefined {
    const value = this.db.prepare('SELECT value FROM state WHERE key=?').get(`singing.duration:${id}:${hash}`)?.value
    const seconds = typeof value === 'string' ? Number(value) : NaN
    return Number.isFinite(seconds) && seconds >= 1 && seconds <= MAX_SINGING_SCORE_SECONDS ? seconds : undefined
  }

  saveSongDuration(id: string, hash: string, seconds: number): void {
    const inserted = this.db.prepare(`INSERT INTO state (key,value)
      SELECT ?,? FROM media_asset WHERE id=? AND hash=? AND kind='song' AND source='singing' AND source_ref=id`)
      .run(`singing.duration:${id}:${hash}`, JSON.stringify(seconds), id, hash)
    if (!inserted.changes) throw new Error('Song duration requires its verified archive')
  }

  all(): MediaAsset[] {
    return this.db.prepare('SELECT * FROM media_asset ORDER BY last_used_at DESC, id DESC').all().map(row => this.fromRow(row))
  }

  upsert(input: MediaAssetInput): MediaAsset {
    const current = this.db.prepare('SELECT id FROM media_asset WHERE path=?').get(input.path)
    const asset: MediaAsset = {
      ...input,
      id: input.id ?? (current ? String(current.id) : randomUUID()),
      bytes: Math.max(0, Math.floor(input.bytes ?? 0)),
      lastVerifiedAt: input.lastVerifiedAt ?? new Date().toISOString(),
    }
    this.db.prepare(`INSERT INTO media_asset (id,kind,path,hash,mime_type,bytes,source,source_ref,retention,created_at,last_used_at,last_verified_at,missing_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,hash=excluded.hash,mime_type=excluded.mime_type,bytes=excluded.bytes,source=excluded.source,source_ref=excluded.source_ref,retention=excluded.retention,last_used_at=MAX(media_asset.last_used_at,excluded.last_used_at),last_verified_at=excluded.last_verified_at,missing_at=excluded.missing_at,deleted_at=NULL`)
      .run(asset.id, asset.kind, asset.path, asset.hash ?? null, asset.mimeType, asset.bytes, asset.source, asset.sourceRef ?? null, asset.retention, asset.createdAt, asset.lastUsedAt, asset.lastVerifiedAt, asset.missingAt ?? null, asset.deletedAt ?? null)
    return this.fromRow(this.db.prepare('SELECT * FROM media_asset WHERE path=?').get(input.path))
  }

  touch(path: string, now: string): void {
    this.db.prepare('UPDATE media_asset SET last_used_at=? WHERE path=? AND deleted_at IS NULL').run(now, path)
  }

  markMissingExcept(paths: Set<string>, now: string, scanStartedAt?: string): void {
    const update = this.db.prepare('UPDATE media_asset SET missing_at=? WHERE path=? AND missing_at IS NULL AND deleted_at IS NULL AND (? IS NULL OR last_verified_at<?)')
    for (const asset of this.all()) if (!paths.has(asset.path)) update.run(now, asset.path, scanStartedAt ?? null, scanStartedAt ?? null)
  }

  markDeleted(id: string, now: string): void {
    this.db.prepare('UPDATE media_asset SET deleted_at=?,last_verified_at=? WHERE id=? AND deleted_at IS NULL').run(now, now, id)
  }

  summary(): MediaSummary {
    const totals = this.db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes,
      COALESCE(SUM(CASE WHEN retention='cache' THEN bytes ELSE 0 END),0) AS cache_bytes,
      (SELECT COUNT(*) FROM media_asset WHERE missing_at IS NOT NULL AND deleted_at IS NULL) AS missing FROM media_asset WHERE missing_at IS NULL AND deleted_at IS NULL`).get() as { files: number; bytes: number; cache_bytes: number; missing: number }
    const deleted = this.db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM media_asset WHERE deleted_at IS NOT NULL').get() as { files: number; bytes: number }
    const byKind: MediaSummary['byKind'] = {}
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM media_asset WHERE missing_at IS NULL AND deleted_at IS NULL GROUP BY kind').all() as { kind: MediaKind; files: number; bytes: number }[]
    for (const row of rows) byKind[row.kind] = { files: Number(row.files), bytes: Number(row.bytes) }
    return { files: Number(totals.files), bytes: Number(totals.bytes), cacheBytes: Number(totals.cache_bytes), missingFiles: Number(totals.missing), deletedFiles: Number(deleted.files), deletedBytes: Number(deleted.bytes), byKind }
  }

  cleanupPreview(olderThanDays: number): MediaCleanupPreview {
    const cutoff = Date.now() - olderThanDays * 86_400_000
    const assets = this.all().filter(asset => asset.retention === 'cache' && !asset.missingAt && !asset.deletedAt)
    const expired = new Set(assets.filter(asset => Date.parse(asset.lastUsedAt) < cutoff).map(asset => asset.id))
    const hashes = new Map<string, MediaAsset[]>()
    for (const asset of assets) if (asset.hash) hashes.set(asset.hash, [...hashes.get(asset.hash) ?? [], asset])
    const duplicateGroups = [...hashes.entries()].filter(([, items]) => items.length > 1).map(([hash, items]) => ({ hash, files: items.length, bytes: items[0]!.bytes }))
    for (const [, items] of hashes) if (items.length > 1) for (const asset of items.slice(1)) expired.add(asset.id)
    const candidates = assets.filter(asset => expired.has(asset.id)).sort((a, b) => b.bytes - a.bytes)
    return { policy: 'preview-only', olderThanDays, candidates, bytes: candidates.reduce((total, asset) => total + asset.bytes, 0), duplicateGroups }
  }
}

// The activity log expires, so keep provenance with the archived asset identity and bytes.
function songCoverEngineKey(id: string, hash: string): string {
  return `singing.cover-engine:${id}:${hash}`
}
