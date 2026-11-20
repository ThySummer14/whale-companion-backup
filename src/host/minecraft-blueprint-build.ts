import { randomUUID } from 'node:crypto'
import { VOXEL_BUILD_CAPABILITY, VOXEL_BUILD_EVENT, VoxelWorldInput, voxelBuildMemoryContent, voxelSiteOrigin, type VoxelBuildInput, type VoxelSiteInput,
  type VoxelWorldReceipt } from '../core/minecraft-blueprint-build.ts'
import type { TaskRecord } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { DeviceAuthError } from './devices.ts'
import type { VoxelBlueprintService } from './minecraft-voxel-blueprints.ts'
import type { MinecraftService } from './minecraft.ts'
import type { z } from 'zod'

const PREVIEW_TTL = 120_000
type Authorization = { deviceId: string; assertCurrent: () => void }
type Site = z.infer<typeof VoxelSiteInput>
type Admission = Site & { id: string; deviceId: string; approvedAt: string; expiresAt: number; generation: number }

export class VoxelConstructionService {
  private readonly previews = new Map<string, Admission>()

  constructor(private readonly store: CompanionStore, private readonly blueprints: VoxelBlueprintService,
    private readonly minecraft: Pick<MinecraftService, 'runVoxelSite' | 'voxelBuildingEnabled' | 'voxelSiteGeneration'>) {}

  reconcile(): void {
    this.store.transaction(() => {
      for (const build of this.store.voxelBuilds.running()) {
        const task = this.store.taskById(build.taskId)
        const reason = 'blueprint-unconfirmed-after-restart'
        if (task?.status === 'running') this.store.transitionTask(task.id, 'cancelled', reason)
        this.store.voxelBuilds.finish(build.blueprintId, build.taskId, { reason })
      }
    })
  }

  zones() {
    if (!this.minecraft.voxelBuildingEnabled) return []
    return this.store.buildZones().map(({ id, name, dimension, x, y, z, radius }) => ({ id, name, dimension, x, y, z, radius }))
  }

  private site(id: string, input: Site, approvedAt?: string) {
    if (!this.minecraft.voxelBuildingEnabled) throw new DeviceAuthError(409, 'blueprint-server-unavailable')
    const blueprint = this.store.voxelBlueprints.get(id)
    if (!blueprint) throw new DeviceAuthError(404, 'minecraft-blueprint-not-found')
    const file = this.store.media.get(blueprint.schematicId)
    if (!blueprint.approvedAt || approvedAt && approvedAt !== blueprint.approvedAt || input.sha256 !== file?.hash) {
      throw new DeviceAuthError(409, 'blueprint-review-required')
    }
    const zone = this.store.buildZoneById(input.zoneId)
    const origin = zone && voxelSiteOrigin(zone, blueprint.info.size)
    if (!zone || !origin) throw new DeviceAuthError(409, 'blueprint-zone-unavailable')
    const current = this.store.voxelBuilds.get(id)
    if (current && current.zoneId !== zone.id) throw new DeviceAuthError(409, 'blueprint-build-zone-fixed')
    return { blueprint, zone, origin, approvedAt: blueprint.approvedAt, current }
  }

  async preview(id: string, input: Site, signal: AbortSignal, authorization: Authorization) {
    authorization.assertCurrent()
    const { blueprint, zone, origin, approvedAt, current } = this.site(id, input)
    if (current?.status === 'running') throw new DeviceAuthError(409, 'blueprint-world-busy')
    if (current?.status === 'built') throw new DeviceAuthError(409, 'blueprint-already-built')
    const generation = this.minecraft.voxelSiteGeneration
    const guard = () => {
      signal.throwIfAborted()
      authorization.assertCurrent()
      this.site(id, input, approvedAt)
      if (this.minecraft.voxelSiteGeneration !== generation) throw new DeviceAuthError(409, 'blueprint-operation-changed')
    }
    this.previews.delete(id)
    const { bytes } = await this.blueprints.read(id, 'schematic', guard)
    const request = VoxelWorldInput.parse({ operationId: randomUUID(), sha256: input.sha256, dimension: zone.dimension, origin,
      size: blueprint.info.size, solids: blueprint.info.declared })
    const receipt = await this.minecraft.runVoxelSite('preview', request, zone.id, bytes, signal, guard)
    guard()
    const details = { checked: receipt.checked, matched: receipt.matched, dimension: zone.dimension, origin }
    if (receipt.phase !== 'ready') return { ready: false, ...details, reason: receipt.reason }
    const now = Date.now()
    for (const [key, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(key)
    const previewId = randomUUID()
    this.previews.set(id, { ...input, id: previewId, deviceId: authorization.deviceId, approvedAt, generation, expiresAt: now + PREVIEW_TTL })
    return { ready: true, ...details, previewId }
  }

  async build(id: string, input: z.infer<typeof VoxelBuildInput>, authorization: Authorization) {
    authorization.assertCurrent()
    const { blueprint, zone, origin, approvedAt, current } = this.site(id, input)
    if (current?.status === 'built') return current
    if (current?.status === 'running') throw new DeviceAuthError(409, 'blueprint-world-busy')
    const preview = this.previews.get(id)
    const assertPreview = () => {
      if (!preview || this.previews.get(id) !== preview || preview.id !== input.previewId || preview.deviceId !== authorization.deviceId ||
          preview.zoneId !== zone.id || preview.sha256 !== input.sha256 || preview.approvedAt !== approvedAt ||
          preview.generation !== this.minecraft.voxelSiteGeneration || preview.expiresAt <= Date.now()) {
        throw new DeviceAuthError(409, 'blueprint-site-preview-required')
      }
    }
    assertPreview()
    const guard = () => {
      authorization.assertCurrent()
      this.site(id, input, approvedAt)
    }
    const { bytes } = await this.blueprints.read(id, 'schematic', guard)
    const request = VoxelWorldInput.parse({ operationId: randomUUID(), sha256: input.sha256, dimension: zone.dimension, origin,
      size: blueprint.info.size, solids: blueprint.info.declared })
    const binding = this.store.bindingByContext('game.minecraft')
    let task: TaskRecord | undefined, receipt: VoxelWorldReceipt | undefined
    try {
      receipt = await this.minecraft.runVoxelSite('build', request, zone.id, bytes, AbortSignal.timeout(165_000), guard, () => {
        assertPreview()
        task = this.store.transaction(() => {
          const accepted = this.store.createTask({ capabilityId: VOXEL_BUILD_CAPABILITY, contextId: 'game.minecraft',
            sessionId: binding?.sessionId, title: 'Minecraft：体素建筑施工' })
          if (!this.store.voxelBuilds.start(id, zone, accepted.id)) throw new DeviceAuthError(409, 'blueprint-world-busy')
          return this.store.transitionTask(accepted.id, 'running')
        })
        this.previews.delete(id)
      })
      guard()
      if (!task) throw new DeviceAuthError(502, 'blueprint-receipt-unconfirmed')
      const taskId = task.id
      this.store.transaction(() => {
        if (this.store.taskById(taskId)?.status !== 'running' || !this.store.voxelBuilds.finish(id, taskId,
          { receipt, reason: receipt!.reason })) throw new DeviceAuthError(409, 'blueprint-stopped')
        const built = receipt!.phase === 'built'
        this.store.transitionTask(taskId, built ? 'succeeded' : receipt!.phase === 'cancelled' ? 'cancelled' : 'failed', receipt!.reason)
        if (built) {
          const summary = `在「${zone.name}」完成了体素建筑「${blueprint.name}」，服务端核对 ${receipt!.matched} 块方块和 ${receipt!.checked - receipt!.matched} 处留空。`
          const activityId = this.store.recordActivity({ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId,
            source: 'game.minecraft', kind: VOXEL_BUILD_EVENT, summary, status: 'success',
            data: { blueprintId: id, zoneId: zone.id, sha256: input.sha256, ...origin, dimension: zone.dimension,
              checked: receipt!.checked, matched: receipt!.matched, placed: receipt!.placed, restored: receipt!.restored } })
          this.store.memory.create({ contextId: 'game.minecraft', actorSessionId: binding?.sessionId, kind: 'experience', scope: 'shared',
            status: 'active', confidence: 1, importance: 0.7, content: voxelBuildMemoryContent(summary, { ...origin, dimension: zone.dimension }, activityId),
            sourceRefs: [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId, activityId }], reason: 'minecraft-blueprint-built' })
        }
      })
    } catch (error) {
      if (!task) throw error
      const reason = error instanceof DeviceAuthError ? error.code : 'blueprint-receipt-unconfirmed'
      const taskId = task.id
      this.store.transaction(() => {
        if (this.store.taskById(taskId)?.status === 'running') this.store.transitionTask(taskId,
          error instanceof DeviceAuthError && [401, 409].includes(error.status) ? 'cancelled' : 'failed', reason)
        this.store.voxelBuilds.finish(id, taskId, { reason })
      })
    }
    authorization.assertCurrent()
    return this.store.voxelBuilds.get(id)!
  }
}
