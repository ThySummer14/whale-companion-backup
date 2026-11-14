import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { BILIBILI_CLIP_CONTEXT, BILIBILI_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT, MINECRAFT_SHARE_CONTEXT, type ActivityRecord } from '../core/model.ts'
import { HOUSE_COMPLETION_TASK_PREFIX } from '../core/minecraft-house-verification.ts'
import { minecraftHouseMaterials } from '../core/minecraft-house.ts'
import { exportLitematica } from '../core/litematica.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SUPPLY_EVENT, PROJECT_MAX_SECTIONS } from '../core/minecraft-house-project.ts'
import { MINECRAFT_PLACE_EVENT } from '../core/minecraft-place.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { streamAudio } from './audio.ts'
import { ContextInput, DeviceFeedPublishInput, FeedReplyInput, MessageInput, SessionCreateInput, TtsInput, TtsRenderInput, capabilityId, identifier } from './api-schemas.ts'
import { DeviceAuthError, type DeviceService } from './devices.ts'
import { resolvePluginFile } from './music-plugins.ts'
import type { DeviceAvatarViewer } from './device-avatar-http.ts'
import type { CompanionRuntime } from './runtime.ts'
import { managementAllowed } from './security.ts'
import { RealtimePcmError } from './realtime-pcm.ts'
import { streamPcm } from './pcm-http.ts'
import { MAX_ASR_WAV_BYTES } from './asr.ts'
import { MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_BASE64, MAX_CHAT_ATTACHMENT_BODY, MAX_CHAT_ATTACHMENT_BYTES } from './chat-attachments.ts'
import { deviceFeedPost } from './device-feed.ts'
import { MAX_DEVICE_IMAGE_BASE64, MAX_DEVICE_IMAGE_BYTES } from './device-media.ts'
import { QwenWatchInput } from './qwen-watch.ts'

const DevicePostInput = FeedReplyInput.extend({
  body: z.string().trim().max(4000).default(''),
  mediaId: z.string().uuid().optional(),
}).refine(input => !!(input.body || input.mediaId))
const VoiceStreamInput = TtsInput.strict()
const PlaybackInput = z.strictObject({
  id: z.uuid(), sequence: z.int().positive(), state: z.enum(['playing', 'paused', 'stopped']),
})
const DeviceMessageInput = MessageInput.extend({
  text: z.string().trim().max(16_000).default(''),
  voiceReply: z.boolean().optional(),
  requestId: z.string().uuid().optional(),
  expectedSessionId: identifier.optional(),
  attachments: z.array(z.strictObject({ name: z.string().trim().min(1).max(180), dataBase64: z.string().min(1).max(MAX_CHAT_ATTACHMENT_BASE64) }))
    .max(MAX_CHAT_ATTACHMENTS).optional(),
}).refine(input => !!(input.text || input.attachments?.length) && (!input.expectedSessionId || !!input.requestId))
const ChatAttachmentQuery = z.strictObject({ contextId: capabilityId, messageId: identifier, attachmentId: identifier })
const NoticeId = z.int().positive()
const NoticeReadInput = z.union([z.strictObject({ id: NoticeId }), z.strictObject({ through: NoticeId }),
  z.strictObject({ ids: z.array(NoticeId).min(1).max(50) })])
const MAX_NOTICE_READ_BODY = 1024
const HouseApprovalInput = z.strictObject({ zoneId: z.uuid(), revision: z.int().nonnegative() })

function houseApprovals(runtime: CompanionRuntime) {
  const drafts = runtime.store.minecraftHouses.listForApprovals()
  const pending = drafts.filter(draft => draft.status === 'draft')
  const zones = pending.length ? runtime.store.buildZones().filter(zone => pending.some(draft => !draft.zoneId || draft.zoneId === zone.id)) : []
  return {
    version: 1,
    items: drafts.map(({ id, name, zoneId, revision, status, assumptions, layout }) =>
      ({ id, name, zoneId, revision: revision ?? 0, status, assumptions, layout, materials: minecraftHouseMaterials(layout) })),
    zones: zones.map(({ id, name, dimension, x, y, z }) => ({ id, name, dimension, x, y, z })),
  }
}

export function deviceContextAllowed(contextId: string | undefined): boolean {
  return !isFeedReplyContext(contextId) && contextId !== BILIBILI_REFLECTION_CONTEXT && contextId !== BILIBILI_SHARE_CONTEXT && contextId !== BILIBILI_CLIP_CONTEXT &&
    contextId !== DAILY_AUTONOMY_CONTEXT && contextId !== DAILY_REFLECTION_CONTEXT && contextId !== DAILY_VISIT_CONTEXT &&
    contextId !== MINECRAFT_SHARE_CONTEXT && contextId !== MINECRAFT_RECOVERY_CONTEXT
}

function requireDeviceContext(contextId: string | undefined): void {
  if (!deviceContextAllowed(contextId)) throw new DeviceAuthError(403, 'device-context-forbidden')
}

export function deviceActivity(activity: ActivityRecord): ActivityRecord | undefined {
  if (activity.contextId === MINECRAFT_RECOVERY_CONTEXT) return
  if (isFeedReplyContext(activity.contextId)) {
    if (activity.source !== 'core.feed' || activity.kind !== 'post.replied' || activity.data.author !== 'companion') return
    const { contextId: _context, sessionId: _session, taskId: _task, ...receipt } = activity
    return receipt
  }
  if (activity.source === 'game.build' && ['build-zone.created', 'build-zone.revoked'].includes(activity.kind)) return
  if (activity.kind === MINECRAFT_PLACE_EVENT) {
    const { dimension, x: px, y: py, z: pz, verifiedAt, actor } = activity.data
    if (activity.source !== 'game.minecraft' || activity.contextId !== 'game.minecraft' || activity.status !== 'success' ||
      typeof dimension !== 'string' || dimension.length < 1 || dimension.length > 100 ||
      typeof px !== 'number' || !Number.isSafeInteger(px) || typeof py !== 'number' || !Number.isSafeInteger(py) ||
      typeof pz !== 'number' || !Number.isSafeInteger(pz) || typeof verifiedAt !== 'string' || !z.iso.datetime().safeParse(verifiedAt).success ||
      actor !== 'owner' && actor !== 'companion') return
    return { ...activity, sessionId: undefined, data: { dimension, x: px, y: py, z: pz, verifiedAt, actor } }
  }
  if (activity.kind === HOUSE_PROJECT_SUPPLY_EVENT) {
    const { index, name, count, consumedLogs } = activity.data
    if (activity.source !== 'game.minecraft' || activity.contextId !== 'game.minecraft' || activity.status !== 'success' ||
      typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= PROJECT_MAX_SECTIONS ||
      name !== 'oak_planks' && name !== 'spruce_planks' || count !== 4 || consumedLogs !== 1) return
    return { ...activity, data: { index, name, count, consumedLogs } }
  }
  if (activity.source === 'game.minecraft' && activity.kind === 'world.house-project-section' && Object.hasOwn(activity.data, 'dailyTaskId')) {
    const { dailyTaskId: _parent, projectId: _project, zoneId: _zone, ...data } = activity.data
    return { ...activity, data }
  }
  if (activity.source !== 'core.memory' || activity.sessionId === undefined) return activity
  // Memory can be shared across scenes while its authoring session stays on the host.
  const { sessionId: _actorSession, ...projected } = activity
  return projected
}

function deviceState(view: WorkbenchView): WorkbenchView {
  const visible = ({ contextId }: { contextId?: string }) => !isFeedReplyContext(contextId) && contextId !== BILIBILI_CLIP_CONTEXT && contextId !== BILIBILI_SHARE_CONTEXT &&
    contextId !== DAILY_AUTONOMY_CONTEXT && contextId !== DAILY_REFLECTION_CONTEXT &&
    contextId !== DAILY_VISIT_CONTEXT && contextId !== MINECRAFT_SHARE_CONTEXT && contextId !== MINECRAFT_RECOVERY_CONTEXT
  const privateSessions = new Set<string>()
  for (const binding of view.bindings ?? []) if (!visible(binding)) privateSessions.add(binding.sessionId)
  for (const activity of view.activities ?? []) if (!visible(activity) && activity.sessionId) privateSessions.add(activity.sessionId)
  const jobs = view.autonomy?.jobs.filter(visible).map(job => {
    if (job.kind === 'minecraft.supply' && /^visit-(?:supply|build|revisit):/u.test(job.dedupeKey)) {
      const { visitId: _visitId, visitSupply: _visitSupply, visitBuild: _visitBuild, visitRevisit: _visitRevisit,
        constructionTaskId: _constructionTaskId, ...payload } = job.payload
      return { ...job, payload }
    }
    if (job.kind !== 'bilibili.review' || !Object.hasOwn(job.payload, 'dailyTaskId')) return job
    const { dailyTaskId: _, ...payload } = job.payload
    return { ...job, payload }
  })
  const stats = view.stats
  let deviceStats = stats
  if (stats?.usage24h) {
    const { byContext: _hostUsage, ...usage24h } = stats.usage24h
    deviceStats = { ...stats, usage24h }
  }
  return {
    ...view,
    stats: deviceStats,
    bindings: view.bindings?.filter(visible),
    sessions: view.sessions?.filter(session => !privateSessions.has(session.id)),
    activities: view.activities?.map(deviceActivity).filter((activity): activity is ActivityRecord => activity !== undefined && visible(activity)),
    tasks: view.tasks?.filter(visible).map(task => {
      if (!task.externalId?.startsWith(HOUSE_COMPLETION_TASK_PREFIX) && !task.externalId?.startsWith(DAILY_HOUSE_PROJECT_TASK_PREFIX)) return task
      const { externalId: _source, ...projected } = task
      return projected
    }),
    autonomy: view.autonomy && { ...view.autonomy, jobs: jobs ?? [] },
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new DeviceAuthError(400, 'invalid-json') }
}

async function readBody(req: IncomingMessage, limit = 65_536): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new DeviceAuthError(400, 'body-too-large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function body(req: IncomingMessage, limit?: number): Promise<unknown> {
  return parseJson(await readBody(req, limit))
}

function noticeQueryInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (String(number) !== value) throw new DeviceAuthError(400, 'invalid-request')
  return NoticeId.parse(number)
}

function noticeListQuery(params: URLSearchParams): { before?: number; limit?: number } {
  const beforeValues = params.getAll('before')
  const limitValues = params.getAll('limit')
  if (beforeValues.length > 1 || limitValues.length > 1 || params.size !== beforeValues.length + limitValues.length) {
    throw new DeviceAuthError(400, 'invalid-request')
  }
  const before = noticeQueryInt(beforeValues[0])
  const limit = noticeQueryInt(limitValues[0])
  if (limit !== undefined && limit > 50) throw new DeviceAuthError(400, 'invalid-request')
  return { before, limit }
}

function parseNoticeRead(text: string): z.infer<typeof NoticeReadInput> {
  const input = NoticeReadInput.parse(parseJson(text))
  // Commas are only valid between IDs in a grouped acknowledgement.
  if ((text.match(/,/gu)?.length ?? 0) !== ('ids' in input ? input.ids.length - 1 : 0)) {
    throw new DeviceAuthError(400, 'invalid-request')
  }
  return input
}

async function whileConnected<T>(res: ServerResponse, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const disconnect = () => { if (!res.writableFinished) controller.abort() }
  res.once('close', disconnect)
  try {
    if (res.destroyed) controller.abort()
    controller.signal.throwIfAborted()
    return await work(controller.signal)
  } finally {
    res.off('close', disconnect)
  }
}

async function wavBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  const tooLarge = () => new DeviceAuthError(413, 'asr-audio-too-large')
  if (Number(req.headers['content-length'] ?? 0) > MAX_ASR_WAV_BYTES) throw tooLarge()
  const abort = () => { if (!req.complete) req.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted()
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_ASR_WAV_BYTES) throw tooLarge()
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function ocrBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer> {
  const limit = 20 * 1024 * 1024
  const tooLarge = () => new DeviceAuthError(413, 'ocr-file-too-large')
  if (Number(req.headers['content-length'] ?? 0) > limit) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) {
      if (!res.writableFinished) res.destroy()
      throw tooLarge()
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function failure(error: unknown): [number, { error: string; code?: string }] {
  if (error instanceof DeviceAuthError) return [error.status, { error: error.code, code: error.code }]
  if (error instanceof RealtimePcmError) {
    const code = error.message
    return [code === 'voice-stream-busy' ? 409 : code === 'voice-stream-stopping' ? 503 : 502, { error: code, code }]
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return [503, { error: 'voice-stream-timeout', code: 'voice-stream-timeout' }]
  if (error instanceof z.ZodError) return [400, { error: 'invalid-request', code: 'invalid-request' }]
  if (error instanceof Error && error.message === 'Invalid feed cursor') return [400, { error: 'invalid-feed-cursor', code: 'invalid-feed-cursor' }]
  if (error instanceof Error && error.message === 'Replies can only be added to a top-level post') return [400, { error: 'invalid-parent-post', code: 'invalid-parent-post' }]
  if (error instanceof Error && error.message === 'Only the author can delete this post') return [403, { error: error.message, code: 'forbidden' }]
  if (error instanceof Error && /not found/i.test(error.message)) return [404, { error: error.message, code: 'not-found' }]
  if (error instanceof Error && /not live|already bound/i.test(error.message)) return [409, { error: error.message, code: 'binding-conflict' }]
  return [500, { error: 'internal-error', code: 'internal-error' }]
}

export function registerDeviceHttp(ctx: Context, runtime: CompanionRuntime, devices: DeviceService, avatarViewer?: DeviceAvatarViewer): () => void {
  const PairInput = z.object({ p: z.string().trim().min(1).max(20_000) })
  const OfferInput = z.object({
    name: z.string().trim().min(1).max(80).default('Paired device'),
    hostName: z.string().trim().max(80).optional(),
    routes: z.array(z.string().trim().url()).max(4).optional(),
  })
  const RevokeInput = z.object({ id: z.string().uuid() })
  const disposers = [
    ctx.webServer.register({
      kind: 'prefix',
      path: '/companion-device/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
          if (!url.pathname.startsWith('/companion-device/api/')) throw new DeviceAuthError(404, 'not-found')
          const path = url.pathname.slice('/companion-device/api/'.length)
          const method = req.method ?? 'GET'
          if (method === 'POST' && path === 'pair') {
            if (!devices.allowAttempt(req.socket.remoteAddress)) throw new DeviceAuthError(429, 'pair-rate-limited')
            const result = devices.redeem(PairInput.parse(await body(req)).p)
            json(res, 201, result)
            return
          }
          const device = devices.authenticate(req)
          const playbackClient = req.headers['x-companion-playback-client']
          const playbackHeaders = (kind: 'speaking' | 'singing') =>
            playbackClient ? () => runtime.devicePlayback.issue(device.id, playbackClient, kind) : undefined
          if (method === 'POST' && path === 'avatar/viewer') {
            if (!avatarViewer) throw new DeviceAuthError(404, 'avatar-view-unavailable')
            if (req.url?.includes('?') || req.headers['transfer-encoding'] !== undefined ||
              (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
              throw new DeviceAuthError(400, 'invalid-request')
            }
            json(res, 201, await avatarViewer.issue(req, device.id))
            return
          }
          if (method === 'GET' && path === 'minecraft/camp') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const view = await runtime.minecraft.campView()
            devices.authenticate(req)
            json(res, 200, { ...view, project: runtime.autonomy.campProjectSummary(), patrol: runtime.autonomy.campPatrolSummary(), gather: runtime.autonomy.campGatherSummary() })
            return
          }
          if (method === 'POST' && path === 'minecraft/pause') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            z.strictObject({}).parse(await body(req, 1024))
            devices.authenticate(req)
            const view = await runtime.minecraft.pauseCamp()
            devices.authenticate(req)
            json(res, 200, { ...view, project: runtime.autonomy.campProjectSummary(), patrol: runtime.autonomy.campPatrolSummary(), gather: runtime.autonomy.campGatherSummary() })
            return
          }
          if (method === 'POST' && path === 'bilibili/watch') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const input = QwenWatchInput.parse(await body(req, 8192))
            devices.authenticate(req)
            const { target, ...result } = await whileConnected(res, signal => runtime.qwenWatch.reply(device.id, input, runtime.store.persona(),
              signal, () => { devices.authenticate(req) }))
            if (target) runtime.store.recordActivity({ contextId: BILIBILI_CONTEXT, source: 'media.bilibili', kind: 'video.watched',
              summary: '一起看 B 站片段', status: 'success', data: { ...target } })
            if (!res.destroyed) json(res, 200, result)
            return
          }
          const houseAction = /^minecraft\/approvals\/([\da-f-]+)\/(preview|build)$/u.exec(path)
          const houseProjection = /^minecraft\/approvals\/([\da-f-]+)\/projection$/u.exec(path)
          if (method === 'GET' && houseProjection) {
            const { revision } = z.strictObject({ revision: z.string().regex(/^\d{1,15}$/u).transform(Number) })
              .parse(Object.fromEntries(url.searchParams))
            if (url.searchParams.size !== 1) throw new DeviceAuthError(400, 'invalid-request')
            const draft = runtime.store.minecraftHouses.get(z.uuid().parse(houseProjection[1]))
            if (!draft || (draft.revision ?? 0) !== revision) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
            const bytes = exportLitematica(draft.layout, draft.name)
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length,
              'content-disposition': `attachment; filename="house-${draft.id}-r${revision}.litematic"`, 'cache-control': 'private, no-store' })
            res.end(bytes)
            return
          }
          if (method === 'POST' && houseAction) {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const id = z.uuid().parse(houseAction[1])
            if (houseAction[2] === 'preview') {
              const { zoneId, revision } = HouseApprovalInput.parse(await body(req, 1024))
              devices.authenticate(req)
              const preview = await whileConnected(res, signal => runtime.minecraft.previewHouse(id, zoneId, signal, revision))
              devices.authenticate(req)
              if (!res.destroyed) json(res, 200, preview)
            } else {
              const { zoneId, revision, previewId } = HouseApprovalInput.extend({ previewId: z.uuid() }).parse(await body(req, 1024))
              devices.authenticate(req)
              const draft = runtime.store.minecraftHouses.get(id)
              if (!draft || (draft.revision ?? 0) !== revision) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
              const result = await runtime.minecraft.buildHouse(id, zoneId, previewId, undefined, () => devices.authenticate(req))
              if (!res.destroyed) json(res, 200, { id, status: result.status })
            }
            return
          }
          if (method === 'GET' && path === 'singing') {
            if (url.searchParams.size > 1 || url.searchParams.size && !url.searchParams.has('cursor')) {
              throw new DeviceAuthError(400, 'invalid-request')
            }
            json(res, 200, runtime.singing.archive(url.searchParams.get('cursor') ?? undefined))
            return
          }
          if (method === 'POST' && path === 'ocr') {
            if (!runtime.ocr?.configured()) throw new DeviceAuthError(503, 'ocr-unconfigured')
            const purpose = url.searchParams.get('purpose') === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition'
            const type = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
            let bytes: Buffer
            let filename: string
            if (type === 'application/json') {
              const input = z.strictObject({ mediaId: z.string().uuid() }).parse(await body(req, 1024))
              const asset = runtime.store.media.get(input.mediaId)
              if (!asset) throw new DeviceAuthError(404, 'ocr-media-not-found')
              bytes = await readFile(asset.path)
              filename = asset.path.split('/').pop() ?? 'file'
            } else {
              bytes = await ocrBody(req, res)
              filename = url.searchParams.get('name')?.slice(0, 120) || 'upload'
            }
            json(res, 200, await runtime.ocr.recognize(bytes, filename, purpose))
            return
          }
          if (method === 'GET' && path === 'music/plugins') {
            json(res, 200, { items: runtime.musicPlugins?.list() ?? [] })
            return
          }
          const pluginPage = /^music\/plugins\/([a-z0-9-]{1,64})\/(home|search)$/u.exec(path)
          if (method === 'GET' && pluginPage) {
            if (!runtime.musicPlugins) throw new DeviceAuthError(404, 'music-plugin-not-found')
            const params = pluginPage[2] === 'search'
              ? { query: url.searchParams.get('query') ?? '', kind: url.searchParams.get('kind') ?? 'tracks', offset: Number(url.searchParams.get('offset') ?? 0) }
              : {}
            json(res, 200, await runtime.musicPlugins.call(pluginPage[1]!, pluginPage[2]!, params))
            return
          }
          const pluginStream = /^music\/plugins\/([a-z0-9-]{1,64})\/stream\/([A-Za-z0-9_-]{1,120})$/u.exec(path)
          if (method === 'GET' && pluginStream) {
            if (!runtime.musicPlugins) throw new DeviceAuthError(404, 'music-plugin-not-found')
            const result = await runtime.musicPlugins.call(pluginStream[1]!, 'stream', { id: pluginStream[2]! }) as { url?: string; type?: string }
            const target = result?.url ?? ''
            if (target.startsWith('companion://singing/')) {
              const audio = await runtime.singing.audio(target.slice('companion://singing/'.length))
              streamAudio(req, res, audio, playbackHeaders('singing'))
              return
            }
            if (target.startsWith('file://')) {
              const filePath = resolvePluginFile(runtime.musicPlugins.pluginDir(pluginStream[1]!), target)
              const size = statSync(filePath).size
              res.writeHead(200, {
                'content-type': result?.type === 'mp3' ? 'audio/mpeg' : 'audio/wav',
                'content-length': size,
                ...playbackHeaders('singing'),
              })
              const file = createReadStream(filePath)
              req.once('close', () => file.destroy())
              file.pipe(res)
              return
            }
            json(res, 200, { url: target, type: result?.type })
            return
          }
          const songMatch = /^singing\/([^/]+)\/audio$/u.exec(path)
          if ((method === 'GET' || method === 'HEAD') && songMatch) {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const taskId = z.uuid().parse(songMatch[1])
            const controller = new AbortController()
            const untrack = devices.trackAudio(device.id, 'singing-audio', controller)
            const abort = () => { if (res.headersSent && !res.writableFinished) res.destroy() }
            const cleanup = () => {
              res.off('finish', cleanup)
              res.off('close', disconnect)
              controller.signal.removeEventListener('abort', abort)
              untrack()
            }
            const disconnect = () => {
              if (!res.writableFinished) controller.abort()
              cleanup()
            }
            res.once('finish', cleanup)
            res.once('close', disconnect)
            controller.signal.addEventListener('abort', abort, { once: true })
            try {
              if (res.destroyed) controller.abort()
              const audio = await runtime.singing.audio(taskId, controller.signal)
              controller.signal.throwIfAborted()
              devices.authenticate(req)
              streamAudio(req, res, audio, playbackHeaders('singing'))
            } catch (error) {
              cleanup()
              throw error
            }
            return
          }
          if (path === 'transcribe' && (method === 'GET' || method === 'POST')) {
            try {
              if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
              if (method === 'GET') {
                json(res, 200, { available: !!runtime.asr, voiceReplyReady: true })
                return
              }
              if (!runtime.asr) throw new DeviceAuthError(404, 'asr-unavailable')
              const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
              if (type !== 'audio/wav' || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new DeviceAuthError(415, 'asr-audio-type-required')
              const controller = new AbortController()
              const untrack = devices.trackAudio(device.id, 'asr', controller)
              const disconnect = () => { if (!res.writableFinished) controller.abort() }
              res.once('close', disconnect)
              try {
                if (res.destroyed) controller.abort()
                json(res, 200, await runtime.asr.transcribe(signal => wavBody(req, signal), controller.signal))
              } finally {
                res.off('close', disconnect)
                untrack()
              }
              return
            } catch (error) {
              if (!req.complete && !res.destroyed) res.setHeader('connection', 'close')
              throw error
            }
          }
          if (method === 'GET' && path === 'media') {
            json(res, 200, { items: runtime.deviceMedia.list() })
            return
          }
          if (method === 'POST' && path === 'media') {
            const input = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), dataBase64: z.string().max(14_000_000) }).parse(await body(req, 14_000_000))
            json(res, 201, await runtime.deviceMedia.upload(input))
            return
          }
          if (method === 'POST' && path === 'feed/publish') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const input = DeviceFeedPublishInput.parse(await body(req, MAX_DEVICE_IMAGE_BASE64 + 32_768))
            requireDeviceContext(input.contextId)
            const result = await runtime.publishDevicePost(input, device.id, () => { devices.authenticate(req) })
            json(res, result.created ? 201 : 200, deviceFeedPost(result.post))
            return
          }
          const mediaMatch = /^media\/([0-9a-f-]+)$/u.exec(path)
          if (method === 'GET' && mediaMatch) {
            const content = await runtime.deviceMedia.content(z.string().uuid().parse(mediaMatch[1]))
            devices.authenticate(req)
            res.writeHead(200, { 'content-type': content.asset.mimeType, 'content-length': content.bytes, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
            createReadStream(content.path).pipe(res)
            return
          }
          if (method === 'GET' && path === 'feed') {
            const cursor = z.string().max(1024).optional().parse(url.searchParams.get('cursor') ?? undefined)
            const limit = z.coerce.number().int().positive().max(50).optional().parse(url.searchParams.get('limit') ?? undefined)
            const page = runtime.store.feed.list({ cursor, limit })
            json(res, 200, { ...page, items: page.items.map(deviceFeedPost) })
            return
          }
          if (method === 'POST' && path === 'feed') {
            const input = DevicePostInput.parse(await body(req))
            requireDeviceContext(input.contextId)
            json(res, 201, await runtime.publishPost({ ...input, author: 'user' }))
            return
          }
          const feedMatch = /^feed\/([^/]+)(\/replies)?$/.exec(path)
          if (method === 'GET' && feedMatch && !feedMatch[2]) {
            const thread = runtime.store.feed.get(decodeURIComponent(feedMatch[1]!))
            json(res, 200, { ...deviceFeedPost(thread), replies: thread.replies.map(deviceFeedPost) })
            return
          }
          if (method === 'POST' && feedMatch && feedMatch[2]) {
            const input = DevicePostInput.parse(await body(req))
            requireDeviceContext(input.contextId)
            json(res, 201, await runtime.publishPost({ ...input, parentId: decodeURIComponent(feedMatch[1]!), author: 'user' }))
            return
          }
          if (method === 'DELETE' && feedMatch && !feedMatch[2]) {
            json(res, 200, runtime.deletePost(decodeURIComponent(feedMatch[1]!), 'user'))
            return
          }
          if (method === 'GET' && path === 'health') {
            json(res, 200, { ok: true, schemaVersion: 2, pluginVersion: runtime.health().pluginVersion, deviceId: device.id,
              feedPublish: { version: 1, maxImageBytes: MAX_DEVICE_IMAGE_BYTES } })
            return
          }
          if (method === 'GET' && path === 'state') {
            const avatarCapability = await avatarViewer?.capability(req)
            const current = devices.authenticate(req)
            const view = deviceState(runtime.view())
            const notices = runtime.store.notices.summary(current.id)
            if (!notices) throw new DeviceAuthError(401, 'device-unauthorized')
            json(res, 200, { ...view, notices, houseApprovals: houseApprovals(runtime),
              bilibiliWatch: { version: 1, ready: runtime.qwenWatch?.ready === true }, noticeGroups: 1, chatSend: { version: 1 },
              ...(avatarCapability && { avatarViewer: avatarCapability }) })
            return
          }
          if (method === 'GET' && path === 'notices') {
            const page = runtime.store.notices.list(device.id, noticeListQuery(url.searchParams))
            if (!page) throw new DeviceAuthError(401, 'device-unauthorized')
            json(res, 200, page)
            return
          }
          if (method === 'POST' && path === 'notices/read') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            if (Number(req.headers['content-length'] ?? 0) > MAX_NOTICE_READ_BODY) {
              res.setHeader('connection', 'close')
              throw new DeviceAuthError(400, 'body-too-large')
            }
            const payload = await readBody(req, MAX_NOTICE_READ_BODY)
            const current = devices.authenticate(req)
            const input = parseNoticeRead(payload)
            const summary = 'ids' in input ? runtime.store.notices.markGroupRead(current.id, input.ids) : runtime.store.notices.markRead(current.id, input)
            if (!summary) throw new DeviceAuthError(404, 'notice-not-found')
            json(res, 200, summary)
            return
          }
          if (method === 'POST' && path === 'sessions') {
            const input = SessionCreateInput.parse(await body(req))
            requireDeviceContext(input.contextId)
            // A prior private decision may be unbound after a fresh review replaces it.
            if (input.sessionId && runtime.store.bindingByContext(input.contextId)?.sessionId !== input.sessionId) {
              throw new DeviceAuthError(403, 'device-context-forbidden')
            }
            json(res, 201, await runtime.sessions.create(input))
            return
          }
          if (method === 'POST' && path === 'messages') {
            if (Number(req.headers['content-length'] ?? 0) > MAX_CHAT_ATTACHMENT_BODY) {
              res.setHeader('connection', 'close')
              throw new DeviceAuthError(413, 'chat-attachments-too-large')
            }
            const input = DeviceMessageInput.parse(await body(req, MAX_CHAT_ATTACHMENT_BODY))
            requireDeviceContext(input.contextId)
            const receipt = await whileConnected(res, signal => runtime.sessions.send(input.contextId, input.text, 'device', input.voiceReply, {
              items: input.attachments,
              requestKey: input.requestId && `${device.id}.${input.requestId.toLowerCase()}`,
              expectedSessionId: input.expectedSessionId,
              assertAuthorized: () => { signal.throwIfAborted(); devices.authenticate(req) },
            }))
            json(res, 202, receipt)
            return
          }
          if (method === 'GET' && path === 'messages/attachments') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            json(res, 200, { available: runtime.sessions.chatAttachmentsAvailable, maxItems: MAX_CHAT_ATTACHMENTS, maxTotalBytes: MAX_CHAT_ATTACHMENT_BYTES })
            return
          }
          if (method === 'GET' && path === 'messages/attachment') {
            if (url.searchParams.size !== 3) throw new DeviceAuthError(400, 'invalid-request')
            const input = ChatAttachmentQuery.parse(Object.fromEntries(url.searchParams))
            requireDeviceContext(input.contextId)
            const { data, attachment } = await whileConnected(res, signal => runtime.sessions.chatAttachment(input.contextId, input.messageId, input.attachmentId, signal))
            devices.authenticate(req)
            res.writeHead(200, {
              'content-type': attachment.mimeType, 'content-length': data.byteLength,
              'content-disposition': 'attachment', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
            })
            res.end(data)
            return
          }
          if (method === 'POST' && path === 'messages/cancel') {
            const input = ContextInput.parse(await body(req))
            requireDeviceContext(input.contextId)
            await runtime.sessions.cancel(input.contextId)
            json(res, 202, { accepted: true, contextId: input.contextId })
            return
          }
          if (method === 'GET' && path === 'messages/history') {
            const contextId = capabilityId.parse(url.searchParams.get('contextId'))
            requireDeviceContext(contextId)
            const limit = z.coerce.number().int().positive().max(200).optional().parse(url.searchParams.get('limit') ?? undefined)
            json(res, 200, await runtime.sessions.history(contextId, limit))
            return
          }
          const messageTtsMatch = /^messages\/([^/]+)\/tts$/u.exec(path)
          if (method === 'POST' && messageTtsMatch) {
            const { contextId } = ContextInput.parse(await body(req))
            requireDeviceContext(contextId)
            json(res, 202, await runtime.tts.synthesizeMessage(contextId, identifier.parse(decodeURIComponent(messageTtsMatch[1]!))))
            return
          }
          if (method === 'POST' && path === 'tts') {
            const input = TtsRenderInput.parse(await body(req, 4096))
            requireDeviceContext(input.contextId)
            devices.authenticate(req)
            json(res, 202, await runtime.tts.synthesizeMessage(input.contextId, input.messageId, input.style))
            return
          }
          const expressiveCancel = /^tts\/([^/]+)\/cancel$/u.exec(path)
          if (method === 'POST' && expressiveCancel) {
            z.strictObject({}).parse(await body(req, 1024))
            devices.authenticate(req)
            const taskId = z.string().uuid().parse(decodeURIComponent(expressiveCancel[1]!))
            requireDeviceContext(runtime.tts.get(taskId).contextId)
            json(res, 200, { cancelled: runtime.tts.cancelExpressive(taskId) })
            return
          }
          if (method === 'POST' && path === 'audio-playback') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const input = PlaybackInput.parse(await body(req, 1024))
            devices.authenticate(req)
            if (!runtime.devicePlayback.report(device.id, input.id, input.sequence, input.state)) {
              throw new DeviceAuthError(404, 'playback-not-found')
            }
            json(res, 200, { ok: true })
            return
          }
          if (method === 'POST' && path === 'voice-stream') {
            if (url.searchParams.size) throw new DeviceAuthError(400, 'invalid-request')
            const input = VoiceStreamInput.parse(await body(req, 4096))
            requireDeviceContext(input.contextId)
            const controller = new AbortController()
            const untrack = devices.trackAudio(device.id, 'voice-stream', controller)
            try {
              await streamPcm(res, signal => runtime.streamDeviceVoice(input.contextId, input.messageId, AbortSignal.any([signal, controller.signal])),
                playbackHeaders('speaking'))
            } finally {
              untrack()
            }
            return
          }
          const ttsMatch = /^tts\/([^/]+)(\/audio)?$/u.exec(path)
          if ((method === 'GET' || method === 'HEAD') && ttsMatch) {
            const taskId = z.string().uuid().parse(decodeURIComponent(ttsMatch[1]!))
            const task = runtime.tts.get(taskId)
            requireDeviceContext(task.contextId)
            if (ttsMatch[2]) {
              const audio = await runtime.audio(taskId)
              devices.authenticate(req)
              streamAudio(req, res, audio, playbackHeaders('speaking'))
            } else if (method === 'GET') {
              json(res, 200, task)
            } else {
              json(res, 200, { ready: task.status === 'succeeded' })
            }
            return
          }
          throw new DeviceAuthError(404, 'not-found')
        } catch (error) {
          if (res.destroyed) return
          if (res.headersSent) {
            res.destroy()
            return
          }
          json(res, ...failure(error))
        }
      },
    }),
    ctx.webServer.register({
      kind: 'prefix',
      path: '/companion/api/devices',
      handler: async (req, res) => {
        if (!managementAllowed(ctx, req)) {
          json(res, 403, { error: 'Same-origin Companion management request required', code: 'origin-refused' })
          return
        }
        try {
          const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
          const path = url.pathname.slice('/companion/api/devices'.length)
          const method = req.method ?? 'GET'
          if (method === 'GET' && path === '/list') {
            json(res, 200, { items: devices.list() })
            return
          }
          if (method === 'POST' && path === '/offer') {
            json(res, 201, devices.createOffer(OfferInput.parse(await body(req))))
            return
          }
          if (method === 'POST' && path === '/revoke') {
            const input = RevokeInput.parse(await body(req))
            devices.revoke(input.id)
            json(res, 200, { revoked: true, id: input.id })
            return
          }
          throw new DeviceAuthError(404, 'not-found')
        } catch (error) {
          json(res, ...failure(error))
        }
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
