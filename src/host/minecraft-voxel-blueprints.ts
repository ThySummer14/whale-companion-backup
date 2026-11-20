import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { VOXEL_PREPARE_CAPABILITY, VoxelBlueprintInfo, type VoxelBlueprintRecord, type VoxelBlueprintSource } from '../core/minecraft-voxel-blueprints.ts'
import type { CompanionStore } from '../core/store.ts'
import { MAX_CHAT_ATTACHMENT_BYTES } from './chat-attachments.ts'
import { DeviceAuthError } from './devices.ts'

const run = promisify(execFile)
const MAX_PALETTE_BYTES = 256 * 1024
const MAX_PREVIEW_BYTES = 1024 * 1024
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SCHEM = Buffer.from([31, 139, 8])
const ConverterResult = z.looseObject({
  ok: z.literal(true), format: z.literal('sponge-schematic-v3'), minecraftDataVersion: z.literal(3955),
  source: z.object({ format: z.literal('magica-voxel'), depthAsZ: z.boolean() }),
})
const ConverterError = z.object({ code: z.string().regex(/^(?:invalid-vox-[a-z-]+|unsupported-vox-[a-z-]+|voxel-[a-z-]+|invalid-json|input-too-large)$/u) })

type Part = 'schematic' | 'preview'
const parts = {
  schematic: { extension: 'schem', mimeType: 'application/octet-stream', limit: MAX_CHAT_ATTACHMENT_BYTES },
  preview: { extension: 'png', mimeType: 'image/png', limit: MAX_PREVIEW_BYTES },
} as const
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export const MAX_VOXEL_PALETTE_BYTES = MAX_PALETTE_BYTES

export class VoxelBlueprintService {
  private busy = false
  private readonly cli = join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'lib', 'dsh-litematica.js')

  constructor(private readonly store: CompanionStore, private readonly mediaRoot: string) {}

  private asset(record: VoxelBlueprintRecord, part: Part) {
    const id = part === 'schematic' ? record.schematicId : record.previewId
    const asset = this.store.media.get(id)
    const spec = parts[part]
    if (!asset || asset.source !== VOXEL_PREPARE_CAPABILITY || asset.sourceRef !== record.id || !asset.hash ||
        asset.mimeType !== spec.mimeType || asset.path !== `blueprints/${id}.${spec.extension}` ||
        asset.missingAt || asset.deletedAt || asset.bytes < 1 || asset.bytes > spec.limit) {
      throw new DeviceAuthError(404, 'minecraft-blueprint-file-unavailable')
    }
    return { ...asset, hash: asset.hash }
  }

  private present(record: VoxelBlueprintRecord) {
    const asset = this.asset(record, 'schematic')
    const { materials, ...dimensions } = record.info
    const construction = this.store.voxelBuilds.get(record.id)
    return { id: record.id, name: record.name, sourceName: record.source.filename, ...dimensions,
      materialStates: Object.keys(materials).length, createdAt: record.createdAt,
      ...(record.approvedAt && { approvedAt: record.approvedAt }), ...(construction && { construction }), sha256: asset.hash, bytes: asset.bytes }
  }

  list() {
    return this.store.voxelBlueprints.list().flatMap(record => {
      try { return [this.present(record)] } catch (error) {
        if (error instanceof DeviceAuthError) return []
        throw error
      }
    })
  }

  async read(id: string, part: Part, assertCurrent: () => void) {
    const record = this.store.voxelBlueprints.get(id)
    if (!record) throw new DeviceAuthError(404, 'minecraft-blueprint-not-found')
    const asset = this.asset(record, part)
    const bytes = await this.readFile(join(this.mediaRoot, asset.path), asset.bytes)
    assertCurrent()
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.hash) throw new DeviceAuthError(409, 'minecraft-blueprint-file-changed')
    this.store.media.touch(asset.path, new Date().toISOString())
    return { bytes, mimeType: asset.mimeType }
  }

  async review(id: string, sha256: string, approved: boolean, assertCurrent: () => void) {
    if (approved) await this.read(id, 'schematic', assertCurrent)
    assertCurrent()
    const record = this.store.voxelBlueprints.get(id)
    if (!record) throw new DeviceAuthError(404, 'minecraft-blueprint-not-found')
    const current = this.present(record)
    if (current.sha256 !== sha256) throw new DeviceAuthError(409, 'minecraft-blueprint-review-stale')
    if (Boolean(record.approvedAt) === approved) return current
    const approvedAt = approved ? new Date().toISOString() : null
    this.store.transaction(() => {
      if (!this.store.voxelBlueprints.review(id, approvedAt)) throw new DeviceAuthError(409, 'minecraft-blueprint-review-stale')
      this.store.recordActivity({ contextId: 'game.minecraft', taskId: id, source: VOXEL_PREPARE_CAPABILITY,
        kind: approved ? 'world.blueprint-approved' : 'world.blueprint-review-withdrawn',
        summary: `主人${approved ? '确认' : '撤回确认'}体素蓝图「${record.name}」`, data: { blueprintId: id, sha256 } })
    })
    return this.present({ ...record, approvedAt: approvedAt ?? undefined })
  }

  async prepare(input: { name: string; bytes: Uint8Array; palette?: Uint8Array; depthAsZ: boolean;
    source: Omit<VoxelBlueprintSource, 'sha256' | 'paletteSha256'> }, signal: AbortSignal, assertCurrent: () => void) {
    assertCurrent()
    if (input.bytes.length > MAX_CHAT_ATTACHMENT_BYTES || (input.palette?.length ?? 0) > MAX_PALETTE_BYTES) {
      throw new DeviceAuthError(413, 'chat-attachments-too-large')
    }
    const { contextId, sessionId, messageId } = input.source
    const externalId = `minecraft-voxel-chat:${digest(Buffer.from(JSON.stringify([contextId, sessionId, messageId])))}`
    const previous = this.store.taskByExternalId(externalId)
    if (previous && previous.capabilityId !== VOXEL_PREPARE_CAPABILITY) throw new DeviceAuthError(409, 'minecraft-blueprint-task-conflict')
    if (previous?.status === 'succeeded') {
      const saved = this.store.voxelBlueprints.get(previous.id)
      if (saved) return this.present(saved)
      throw new DeviceAuthError(409, 'minecraft-blueprint-file-unavailable')
    }
    if (previous?.status === 'cancelled' || previous?.status === 'failed') throw new DeviceAuthError(409, 'minecraft-blueprint-resend-required')
    if (this.busy) throw new DeviceAuthError(409, 'minecraft-blueprint-busy')
    this.busy = true
    const createdFiles: string[] = []
    let directory: string | undefined
    let taskId: string | undefined
    try {
      const task = previous ?? this.store.createTask({ externalId, capabilityId: VOXEL_PREPARE_CAPABILITY, contextId: 'game.minecraft',
        sessionId, title: 'Minecraft：转换体素蓝图' })
      taskId = task.id
      this.store.transitionTask(task.id, 'running')
      directory = await mkdtemp(join(tmpdir(), 'dafeiyu-blueprint-'))
      const src = join(directory, 'model.vox')
      const schematic = join(directory, 'blueprint.schem')
      const preview = join(directory, 'preview.png')
      await writeFile(src, input.bytes, { mode: 0o600 })
      const args = ['--max-old-space-size=768', this.cli, '--json', 'vox', src, '--out', schematic, '--preview', preview]
      if (input.palette) {
        const paletteFile = join(directory, 'palette.json')
        await writeFile(paletteFile, input.palette, { mode: 0o600 })
        args.push('--palette', paletteFile)
      }
      if (input.depthAsZ) args.push('--depth-as-z')
      assertCurrent()
      const { stdout } = await run(process.execPath, args, { signal, timeout: 20_000, maxBuffer: 128 * 1024 }).catch(error => {
        signal.throwIfAborted()
        let parsed: unknown
        try { parsed = JSON.parse(error.stderr) } catch { /* No converter error metadata. */ }
        const known = ConverterError.safeParse(parsed).data
        throw new DeviceAuthError(known ? 400 : 502, known?.code ?? 'minecraft-blueprint-conversion-failed')
      })
      const result = ConverterResult.parse(JSON.parse(stdout))
      const info = VoxelBlueprintInfo.parse({ ...result, depthAsZ: result.source.depthAsZ })
      if (info.depthAsZ !== input.depthAsZ) throw new DeviceAuthError(502, 'minecraft-blueprint-conversion-failed')
      const [schematicBytes, previewBytes] = await Promise.all([readFile(schematic), readFile(preview)])
      if (schematicBytes.length > parts.schematic.limit || !schematicBytes.subarray(0, 3).equals(SCHEM) ||
          previewBytes.length > parts.preview.limit || !previewBytes.subarray(0, 8).equals(PNG)) {
        throw new DeviceAuthError(502, 'minecraft-blueprint-conversion-failed')
      }
      const output = join(this.mediaRoot, 'blueprints')
      await mkdir(output, { recursive: true, mode: 0o700 })
      assertCurrent()
      const createdAt = new Date().toISOString()
      const archive = async (file: string, bytes: Buffer, part: Part) => {
        const artifact = randomUUID()
        const spec = parts[part]
        const basename = `${artifact}.${spec.extension}`
        const path = join(output, basename)
        await copyFile(file, path, constants.COPYFILE_EXCL)
        createdFiles.push(path)
        await chmod(path, 0o600)
        return { id: artifact, kind: part === 'preview' ? 'image' as const : 'other' as const, path: `blueprints/${basename}`,
          source: VOXEL_PREPARE_CAPABILITY, sourceRef: task.id, hash: digest(bytes), mimeType: spec.mimeType, bytes: bytes.length,
          retention: 'keep' as const, createdAt, lastUsedAt: createdAt }
      }
      const archivedSchematic = await archive(schematic, schematicBytes, 'schematic')
      const archivedPreview = await archive(preview, previewBytes, 'preview')
      assertCurrent()
      const record: VoxelBlueprintRecord = { id: task.id, name: input.name, createdAt, info,
        source: { ...input.source, sha256: digest(input.bytes), ...(input.palette && { paletteSha256: digest(input.palette) }) },
        schematicId: archivedSchematic.id, previewId: archivedPreview.id }
      this.store.transaction(() => {
        this.store.media.upsert(archivedSchematic)
        this.store.media.upsert(archivedPreview)
        this.store.voxelBlueprints.save(record)
        this.store.transitionTask(task.id, 'succeeded')
        this.store.recordActivity({ contextId: 'game.minecraft', sessionId, taskId: task.id, source: VOXEL_PREPARE_CAPABILITY,
          kind: 'world.blueprint-prepared', summary: `体素蓝图「${input.name}」已转换，等待主人预览`, status: 'success',
          data: { blueprintId: task.id, sha256: archivedSchematic.hash, size: info.size, blocks: info.declared } })
      })
      createdFiles.length = 0
      return this.present(record)
    } catch (error) {
      if (taskId && this.store.taskById(taskId)?.status === 'running') {
        this.store.transitionTask(taskId, signal.aborted ? 'cancelled' : 'failed',
          error instanceof DeviceAuthError ? error.code : 'minecraft-blueprint-conversion-failed')
      }
      throw error
    } finally {
      this.busy = false
      await Promise.allSettled([
        ...createdFiles.map(path => rm(path, { force: true })),
        ...(directory ? [rm(directory, { force: true, recursive: true })] : []),
      ])
    }
  }

  private async readFile(path: string, length: number): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
      throw new DeviceAuthError(404, 'minecraft-blueprint-file-unavailable')
    })
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== length) throw new DeviceAuthError(409, 'minecraft-blueprint-file-changed')
      const bytes = Buffer.alloc(length)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, length - offset)
        if (!result.bytesRead) throw new DeviceAuthError(409, 'minecraft-blueprint-file-changed')
        offset += result.bytesRead
      }
      return bytes
    } finally { await handle.close() }
  }
}
