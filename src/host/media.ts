import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { MediaAsset, MediaCleanupPreview, MediaCleanupResult, MediaKind, MediaSummary, MediaView } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { DEVICE_FEED_IMAGE_PATH, DEVICE_FEED_IMAGE_SOURCE, SURVEY_CARD_MEDIA_PATH, SURVEY_CARD_MEDIA_SOURCE } from './device-media.ts'

const MANAGED_IMAGE_ORPHAN_GRACE_MS = 60 * 60 * 1000

export class MediaService {
  private readonly root: string
  private ready?: Promise<void>
  private refreshing?: Promise<MediaSummary>
  private closed = false
  private lastScanAt?: string
  private lastError?: string

  constructor(private readonly store: CompanionStore, root: string) {
    this.root = resolve(root)
  }

  start(): void {
    this.ready = this.refresh().then(() => undefined, () => undefined)
  }

  async view(refresh = false): Promise<MediaView> {
    if (!this.ready) this.start()
    if (refresh) await this.refresh()
    else await this.ready
    return {
      items: this.store.media.list(),
      summary: this.store.media.summary(),
      lastScanAt: this.lastScanAt,
      error: this.lastError,
      protected: ['模型权重', '角色原始素材与参考声线', '原始聊天与中央记忆', '数据库与备份', '已归档的歌曲', '保留素材'],
    }
  }

  refresh(): Promise<MediaSummary> {
    if (this.closed) return Promise.reject(new Error('Media service is stopping'))
    this.refreshing ??= this.scan().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  async preview(olderThanDays: number): Promise<MediaCleanupPreview> {
    await this.view()
    const preview = this.store.media.cleanupPreview(olderThanDays)
    this.store.recordActivity({ source: 'core.media', kind: 'media.cleanup-preview', summary: `预览 ${preview.candidates.length} 个可再生成缓存，不删除文件`, data: { files: preview.candidates.length, bytes: preview.bytes, olderThanDays } })
    return preview
  }

  async cleanup(olderThanDays: number, limit = 20): Promise<MediaCleanupResult> {
    const preview = await this.preview(olderThanDays)
    const result: MediaCleanupResult = { policy: 'delete-verified', olderThanDays, deleted: [], skipped: [], bytes: 0 }
    for (const asset of preview.candidates.slice(0, Math.max(1, Math.min(50, limit)))) {
      const path = this.absolute(asset.path)
      try {
        if (!path) {
          result.skipped.push({ asset, reason: 'missing' })
          continue
        }
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) {
          result.skipped.push({ asset, reason: 'missing' })
          continue
        }
        if (info.size !== asset.bytes) {
          result.skipped.push({ asset, reason: 'changed' })
          continue
        }
        if (asset.hash && await this.hashFile(path) !== asset.hash) {
          result.skipped.push({ asset, reason: 'hash-mismatch' })
          continue
        }
        await unlink(path)
        this.store.media.markDeleted(asset.id, new Date().toISOString())
        result.deleted.push(asset)
        result.bytes += info.size
      } catch {
        result.skipped.push({ asset, reason: 'io-error' })
      }
    }
    this.store.recordActivity({ source: 'core.media', kind: 'media.cleanup-deleted', summary: `已删除 ${result.deleted.length} 个可再生成缓存，实际释放 ${result.bytes} 字节`, data: { files: result.deleted.length, bytes: result.bytes, skipped: result.skipped.length, olderThanDays } })
    return result
  }

  async touch(filePath: string): Promise<void> {
    const path = this.relative(filePath)
    if (!path) return
    await this.view()
    this.store.media.touch(path, new Date().toISOString())
  }

  private relative(filePath: string): string | undefined {
    if (!isAbsolute(filePath)) return undefined
    const path = relative(this.root, resolve(filePath))
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
    return path.split(sep).join('/')
  }

  private absolute(path: string): string | undefined {
    const candidate = resolve(this.root, path)
    const normalized = relative(this.root, candidate)
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) return undefined
    return candidate
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  private async scan(): Promise<MediaSummary> {
    const scanStartedAt = new Date().toISOString()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const root = await realpath(this.root)
    const ttsByPath = new Map(this.store.ttsAssets().map(asset => [this.relative(asset.filePath), asset]))
    for (const asset of ttsByPath.values()) {
      const path = this.relative(asset.filePath)
      if (!path) continue
      const absolute = this.absolute(path)
      if (!absolute) continue
      const info = await lstat(absolute).catch(() => undefined)
      if (!info?.isFile() || info.isSymbolicLink()) continue
      this.store.media.upsert({ id: `tts:${asset.id}`, kind: 'voice', path, mimeType: asset.mimeType, bytes: asset.bytes, source: 'tts', sourceRef: asset.taskId, retention: 'cache', createdAt: asset.createdAt, lastUsedAt: asset.createdAt, lastVerifiedAt: new Date(0).toISOString() })
    }
    const files = await this.walk(root)
    const indexed = new Map(this.store.media.all().map(asset => [asset.path, asset]))
    const seen = new Set<string>()
    const now = new Date().toISOString()
    for (const file of files) {
      const path = relative(root, file).split(sep).join('/')
      const asset = indexed.get(path)
      const managedSource = SURVEY_CARD_MEDIA_PATH.test(path) ? SURVEY_CARD_MEDIA_SOURCE
        : DEVICE_FEED_IMAGE_PATH.test(path) ? DEVICE_FEED_IMAGE_SOURCE : undefined
      if (managedSource) {
        if (await this.scanManagedImage(file, path, managedSource, now)) seen.add(path)
        continue
      }
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) continue
      if (path.startsWith('songs/')) {
        if (asset?.kind === 'song' && asset.source === 'singing' && !asset.deletedAt
          && asset.hash && info.size === asset.bytes && await this.hashFile(file) === asset.hash) {
          this.store.media.upsert({ ...asset, lastVerifiedAt: now, missingAt: undefined })
          seen.add(path)
        }
        continue
      }
      const kind = this.kind(path)
      this.store.media.upsert({
        kind, path, hash: await this.hashFile(file), mimeType: this.mime(path), bytes: info.size,
        source: path.startsWith('voice/') ? 'tts' : 'media-import',
        sourceRef: ttsByPath.get(path)?.taskId,
        retention: path.startsWith('voice/') ? 'cache' : 'keep',
        createdAt: info.birthtime.toISOString(), lastUsedAt: info.atime.toISOString(), lastVerifiedAt: now,
      })
      seen.add(path)
    }
    this.store.media.markMissingExcept(seen, now, scanStartedAt)
    this.lastScanAt = now
    this.lastError = undefined
    const summary = this.store.media.summary()
    this.store.recordActivity({ source: 'core.media', kind: 'media.scanned', summary: `媒体清单已核对 ${summary.files} 个文件`, data: { files: summary.files, bytes: summary.bytes, cacheBytes: summary.cacheBytes } })
    return summary
  }

  private async scanManagedImage(file: string, path: string, source: string, now: string): Promise<boolean> {
    const orphanSource = `${source}-orphan`
    const adopted = (asset: MediaAsset) => source === DEVICE_FEED_IMAGE_SOURCE && asset.source === 'media-import'
    const canBeOrphan = (asset: MediaAsset) => !asset.deletedAt && (asset.source === orphanSource ||
      adopted(asset) && !this.store.feed.usesMedia(asset.id))
    try {
      const asset = this.store.media.byPath(path)
      const info = await lstat(file)
      if (!info.isFile() || asset?.deletedAt) return false
      if (asset && (asset.source === source || adopted(asset) && this.store.feed.usesMedia(asset.id))) {
        if (!asset.hash || info.size !== asset.bytes || await this.hashFile(file) !== asset.hash) return false
        this.store.media.upsert({ ...asset, lastVerifiedAt: now, missingAt: undefined })
        return true
      }
      // A new file can still be waiting for its post transaction to commit.
      if (asset && !canBeOrphan(asset) || info.mtimeMs > Date.parse(now) - MANAGED_IMAGE_ORPHAN_GRACE_MS) return false
      const hash = await this.hashFile(file)
      const current = this.store.media.byPath(path)
      if (current && !canBeOrphan(current)) return false
      this.store.media.upsert({
        kind: 'other', path, hash, mimeType: this.mime(path), bytes: info.size,
        source: orphanSource, retention: 'cache',
        createdAt: info.birthtime.toISOString(), lastUsedAt: info.mtime.toISOString(), lastVerifiedAt: now,
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async walk(directory: string): Promise<string[]> {
    const files: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) files.push(...await this.walk(path))
      else if (entry.isFile()) files.push(path)
    }
    return files
  }

  private kind(path: string): MediaKind {
    if (path.startsWith('voice/')) return 'voice'
    if (path.startsWith('avatar/')) return 'avatar'
    if (path.endsWith('.mp4')) return 'video'
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path))) return 'image'
    return 'other'
  }

  private mime(path: string): string {
    if (path.endsWith('.wav')) return 'audio/wav'
    if (path.endsWith('.mp4')) return 'video/mp4'
    if (path.endsWith('.png')) return 'image/png'
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
    if (path.endsWith('.webp')) return 'image/webp'
    if (path.endsWith('.json')) return 'application/json'
    return 'application/octet-stream'
  }

  async close(): Promise<void> {
    this.closed = true
    await this.refreshing
  }
}
