import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MediaAsset } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { DeviceAuthError } from './devices.ts'

export const MAX_DEVICE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_DEVICE_IMAGE_BASE64 = 14_000_000
const MAX_SURVEY_CARD_BYTES = 1024 * 1024
const MAX_SURVEY_CARD_DIMENSION = 2048
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const SURVEY_TASK_ID = new RegExp(`^${UUID_V4}$`, 'u')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const SURVEY_CARD_MEDIA_PATH = new RegExp(`^images/survey-${UUID_V4}\\.png$`, 'u')
export const SURVEY_CARD_MEDIA_SOURCE = 'minecraft-survey-card'
export const DEVICE_FEED_IMAGE_PATH = new RegExp(`^images/feed-${UUID_V4}\\.(?:png|jpg|webp)$`, 'u')
export const DEVICE_FEED_IMAGE_SOURCE = 'device-feed-image'
const TYPES = {
  png: { mime: 'image/png', extension: 'png' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const

export interface DeviceImageUpload {
  mimeType: string
  dataBase64: string
}

export function prepareDeviceImage(input: DeviceImageUpload) {
  if (input.dataBase64.length > MAX_DEVICE_IMAGE_BASE64 || input.dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.dataBase64)) throw new DeviceAuthError(400, 'invalid-image-base64')
  const bytes = Buffer.from(input.dataBase64, 'base64')
  if (!bytes.length || bytes.length > MAX_DEVICE_IMAGE_BYTES) throw new DeviceAuthError(400, 'image-too-large')
  const detected = detect(bytes)
  if (!detected) throw new DeviceAuthError(400, 'unsupported-image-type')
  if (input.mimeType !== detected.mime) throw new DeviceAuthError(400, 'image-mime-mismatch')
  return { bytes, ...detected, hash: createHash('sha256').update(bytes).digest('hex') }
}

export class DeviceMediaService {
  private readonly root: string

  constructor(private readonly store: CompanionStore, root: string) {
    if (!isAbsolute(root)) throw new Error('Device media root must be absolute')
    this.root = resolve(root)
  }

  list(): MediaAsset[] {
    return this.store.media.list({ kind: 'image', limit: 100 })
  }

  async upload(input: DeviceImageUpload): Promise<MediaAsset> {
    const image = prepareDeviceImage(input)
    const id = randomUUID()
    const now = new Date().toISOString()
    const path = `images/${id}.${image.extension}`
    const absolute = this.absolute(path)
    if (!absolute) throw new DeviceAuthError(400, 'invalid-image-path')
    await mkdir(join(this.root, 'images'), { recursive: true, mode: 0o700 })
    try {
      await writeFile(absolute, image.bytes, { mode: 0o600, flag: 'wx' })
      return this.store.media.upsert({
        id, kind: 'image', path,
        hash: image.hash, mimeType: image.mime, bytes: image.bytes.length,
        source: 'device-upload', sourceRef: id, retention: 'keep',
        createdAt: now, lastUsedAt: now, lastVerifiedAt: now,
      })
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => {})
      throw error
    }
  }

  async attachDevicePostImage<T>(image: ReturnType<typeof prepareDeviceImage>, postId: string,
    reconcile: () => T | undefined, persist: (mediaId: string) => T): Promise<T> {
    const id = randomUUID()
    const path = `images/feed-${id}.${image.extension}`
    return this.withImageFile(path, image.bytes, () => this.store.transaction(() => {
      const previous = reconcile()
      if (previous !== undefined) return { value: previous, keep: false }
      const now = new Date().toISOString()
      const asset = this.store.media.upsert({
        id, kind: 'image', path, hash: image.hash, mimeType: image.mime, bytes: image.bytes.length,
        source: DEVICE_FEED_IMAGE_SOURCE, sourceRef: postId, retention: 'keep',
        createdAt: now, lastUsedAt: now, lastVerifiedAt: now,
      })
      return { value: persist(asset.id), keep: true }
    }))
  }

  async attachGeneratedSurveyCard<T>(bytes: Buffer, sourceTaskId: string, assertReady: () => void, persist: (mediaId: string) => T): Promise<T> {
    if (!SURVEY_TASK_ID.test(sourceTaskId)) throw new Error('Invalid survey card source task')
    if (bytes.length < 33 || bytes.length > MAX_SURVEY_CARD_BYTES || detect(bytes) !== TYPES.png
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid survey card PNG')
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (!width || !height || width > MAX_SURVEY_CARD_DIMENSION || height > MAX_SURVEY_CARD_DIMENSION) throw new Error('Invalid survey card dimensions')

    assertReady()
    const image = Buffer.from(bytes)
    const id = randomUUID()
    const path = `images/survey-${id}.png`
    return this.withImageFile(path, image, () => this.store.transaction(() => {
      assertReady()
      const now = new Date().toISOString()
      const asset = this.store.media.upsert({
        id, kind: 'image', path,
        hash: createHash('sha256').update(image).digest('hex'),
        mimeType: TYPES.png.mime, bytes: image.length,
        source: SURVEY_CARD_MEDIA_SOURCE, sourceRef: sourceTaskId, retention: 'keep',
        createdAt: now, lastUsedAt: now, lastVerifiedAt: now,
      })
      return { value: persist(asset.id), keep: true }
    }))
  }

  private async withImageFile<T>(path: string, image: Buffer, commit: () => { value: T; keep: boolean }): Promise<T> {
    const directory = join(this.root, 'images')
    const absolute = join(this.root, path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid image directory')

    let created = false
    let keep = false
    try {
      const file = await open(absolute, 'wx', 0o600)
      created = true
      try {
        await file.writeFile(image)
        await file.sync()
      } finally {
        await file.close()
      }
      const result = commit()
      keep = result.keep
      return result.value
    } finally {
      if (created && !keep) await rm(absolute, { force: true }).catch(() => {})
    }
  }

  async content(id: string): Promise<{ asset: MediaAsset; path: string; bytes: number }> {
    const asset = this.store.media.get(id)
    if (!asset || asset.kind !== 'image' || asset.deletedAt || asset.missingAt) throw new DeviceAuthError(404, 'image-not-found')
    const path = this.absolute(asset.path)
    if (!path) throw new DeviceAuthError(404, 'image-not-found')
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || info.size !== asset.bytes) throw new DeviceAuthError(404, 'image-not-found')
    if (asset.hash) {
      const hash = createHash('sha256')
      const { createReadStream } = await import('node:fs')
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
      if (hash.digest('hex') !== asset.hash) throw new DeviceAuthError(409, 'image-changed')
    }
    this.store.media.touch(asset.path, new Date().toISOString())
    return { asset, path, bytes: info.size }
  }

  private absolute(path: string): string | undefined {
    const candidate = resolve(this.root, path)
    const normalized = relative(this.root, candidate)
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) return undefined
    return candidate
  }
}

function detect(bytes: Buffer): { mime: string; extension: string } | undefined {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return TYPES.png
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return TYPES.jpeg
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return TYPES.webp
  return undefined
}
