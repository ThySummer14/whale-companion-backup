import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { z } from 'zod'
import { TaskTransitionError } from '../core/store.ts'
import { BILIBILI_CLIP_CONTEXT, CONTEXT_COMPACTION_CAPABILITY, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT, SINGING_CONTEXT, type ActivityStatus, type CapabilityStatus, type JsonValue } from '../core/model.ts'
import { MINECRAFT_PERMIT_GOALS, SURVEY_WINDOW_KEY_PREFIX } from '../protocol/api.ts'
import { MinecraftWardrobeId } from '../protocol/minecraft-wardrobe.ts'
import { MinecraftSurveyWindowInputSchema } from '../core/minecraft-survey-window.ts'
import { CAMP_VISIT_PATROL_TASK_PREFIX, CAMP_VISIT_SURVEY_TASK_PREFIX } from '../core/minecraft-survey.ts'
import { CAMP_VISIT_GATHER_TASK_PREFIX } from '../core/minecraft-gather.ts'
import { MINECRAFT_HOUSE_CAPABILITY, MINECRAFT_HOUSE_EVENT, MINECRAFT_HOUSE_RECOVERY_EVENT,
  MINECRAFT_HOUSE_RECOVERY_PREFIX } from '../core/minecraft-house-repository.ts'
import { HOUSE_COMPLETION_TASK_PREFIX } from '../core/minecraft-house-verification.ts'
import { MinecraftHouseRevisionInput } from '../core/minecraft-house.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY, HOUSE_PROJECT_SUPPLY_CAPABILITY, HOUSE_PROJECT_SUPPLY_EVENT,
  HOUSE_PROJECT_VERIFY_CAPABILITY, MinecraftHouseProjectInput,
  PROJECT_MAX_SECTIONS } from '../core/minecraft-house-project.ts'
import { MinecraftHouseProjectImportInput } from '../core/minecraft-house-project-import.ts'
import { HOUSE_AGENT_RECOVERY_EVENT, HOUSE_AGENT_RECOVERY_PREFIX, HOUSE_CELL_ACTIVITY, HOUSE_CELL_AUDIT_ACTIVITY,
  HOUSE_CELL_AUDIT_PREFIX, HOUSE_CELL_CAPABILITY, HOUSE_CELL_TASK_PREFIX } from '../core/minecraft-recovery.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX } from '../core/minecraft-supply.ts'
import type { CompanionRuntime } from './runtime.ts'
import { managementAllowed } from './security.ts'
import { ContextInput, FeedPostInput, FeedReplyInput, MessageInput, SessionCreateInput, SingingInputSchema, TtsRenderInput, identifier } from './api-schemas.ts'
import { DeviceAuthError } from './devices.ts'
import { streamAudio } from './audio.ts'
import { parseBilibiliCollection, parseBilibiliTarget, plainBilibiliText } from '../core/bilibili.ts'
import { MAX_BILIBILI_SUBTITLE_BYTES } from '../protocol/bilibili.ts'
import { MAX_SINGING_WAV_BYTES } from '../protocol/singing.ts'
import { validSongGain, type SingingCoverMix } from './song-mix.ts'
import { SINGING_CHAT_COVER_ID_PREFIX, SINGING_CHAT_SCORE_ID_PREFIX } from './singing.ts'

class RouteError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

const SURVEY_WINDOW_TASK_PREFIX = `autonomy:minecraft.supply:${SURVEY_WINDOW_KEY_PREFIX}`

function requireUnmanagedExternalId(externalId?: string): void {
  if (externalId?.startsWith(DAILY_HOUSE_PROJECT_TASK_PREFIX)) {
    throw new RouteError(403, 'Daily building requires a confirmed initiative and game receipt', 'minecraft-house-project-managed')
  }
  if (externalId?.startsWith('autonomy:minecraft.recovery:') || externalId?.startsWith(HOUSE_CELL_TASK_PREFIX) || externalId?.startsWith(HOUSE_COMPLETION_TASK_PREFIX)) {
    throw new RouteError(403, 'House recovery requires an admitted private tool turn', 'minecraft-house-recovery-managed')
  }
  if ([CAMP_VISIT_SURVEY_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX, CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX,
    CAMP_VISIT_PATROL_TASK_PREFIX, CAMP_VISIT_GATHER_TASK_PREFIX,
    'autonomy:minecraft.supply:visit-supply:', 'autonomy:minecraft.supply:visit-build:', 'autonomy:minecraft.supply:visit-revisit:']
    .some(prefix => externalId?.startsWith(prefix))) {
    throw new RouteError(403, 'Camp visit tasks require a leased game receipt', 'minecraft-camp-visit-managed')
  }
  if (externalId?.startsWith('autonomy:daily.reflect:')) {
    throw new RouteError(403, 'Daily reflection tasks are managed by the idle scheduler', 'daily-reflection-managed')
  }
  if (externalId?.startsWith('autonomy:daily.choice:daily:') || externalId?.startsWith('autonomy:bilibili.review:daily:')) {
    throw new RouteError(403, 'Daily activity tasks require a live window and connector receipt', 'daily-choice-managed')
  }
  if (externalId?.startsWith(SURVEY_WINDOW_TASK_PREFIX)) {
    throw new RouteError(403, 'Scheduled survey tasks require a live window and game receipt', 'minecraft-survey-window-managed')
  }
}

const capabilityId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const sourceId = capabilityId
const status = z.enum(['info', 'success', 'warning', 'error'])
const capabilityStatus = z.enum(['ready', 'planned', 'unavailable', 'error'])
const memoryStatus = z.enum(['candidate', 'active', 'forgotten'])
const memoryKind = z.enum(['user-fact', 'preference', 'experience', 'event', 'goal', 'relationship', 'other'])
const score = z.number().min(0).max(1)
const sourceRef = z.object({
  contextId: identifier.optional(),
  sessionId: identifier.optional(),
  activityId: z.number().int().positive().optional(),
  taskId: identifier.optional(),
  eventSeq: z.number().int().nonnegative().optional(),
})
const personaVersion = z.int().positive()
const personaReason = z.string().trim().min(1).max(240).optional()
const PersonaInput = z.object({
  name: z.string().trim().min(1).max(80),
  tagline: z.string().trim().max(160),
  description: z.string().trim().max(20_000),
  expectedVersion: personaVersion.optional(),
  reason: personaReason,
})
const SessionInput = z.object({ sessionId: z.string().trim().min(1).max(200).nullable() })
const BindingInput = z.object({
  contextId: capabilityId,
  sessionId: identifier,
  kind: z.enum(['chat', 'game', 'task', 'topic', 'system']),
  label: z.string().trim().min(1).max(80),
})
const TaskInput = z.object({
  externalId: identifier.optional(),
  contextId: identifier.optional(),
  sessionId: identifier.optional(),
  capabilityId,
  title: z.string().trim().min(1).max(240),
})
const TaskUpdate = z.object({ status: z.enum(['accepted', 'running', 'succeeded', 'failed', 'cancelled']), error: z.string().max(2000).optional() })
const CapabilityUpdate = z.object({ status: capabilityStatus, detail: z.string().trim().min(1).max(500) })
const BilibiliReadInput = z.strictObject({
  video: z.string().trim().min(1).max(512),
  part: z.number().int().min(1).max(1_000).optional(),
  subtitles: z.boolean().optional(),
})
const BilibiliSubtitleInput = BilibiliReadInput.omit({ subtitles: true }).extend({
  format: z.enum(['srt', 'vtt']),
  content: z.string().min(1),
})
const ActivityInput = z.object({
  eventId: identifier.optional(),
  contextId: identifier.optional(),
  sessionId: identifier.optional(),
  taskId: identifier.optional(),
  source: sourceId,
  kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  summary: z.string().trim().min(1).max(240),
  status: status.default('info'),
  occurredAt: z.string().max(40).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
})
const MemoryInput = z.object({
  kind: memoryKind,
  content: z.string().trim().min(1).max(4000),
  scope: z.enum(['shared', 'context']).default('context'),
  contextId: identifier.optional(),
  status: memoryStatus.optional(),
  importance: score.optional(),
  confidence: score.optional(),
  pinned: z.boolean().optional(),
  sourceRefs: z.array(sourceRef).max(20).default([]),
  reason: z.string().trim().max(500).optional(),
}).superRefine((input, ctx) => {
  if (input.scope === 'context' && !input.contextId) ctx.addIssue({ code: 'custom', message: 'contextId is required for context-scoped memory' })
})
const MemoryUpdate = z.object({
  kind: memoryKind.optional(),
  content: z.string().trim().min(1).max(4000).optional(),
  scope: z.enum(['shared', 'context']).optional(),
  contextId: identifier.optional(),
  status: memoryStatus.optional(),
  importance: score.optional(),
  confidence: score.optional(),
  pinned: z.boolean().optional(),
  sourceRefs: z.array(sourceRef).max(20).optional(),
  reason: z.string().trim().max(500).optional(),
})

function json(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage, limit = 65_536): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new RouteError(400, `Request body exceeds ${limit / 1024} KiB`, 'body-too-large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RouteError(400, 'Request body is not JSON', 'invalid-json') }
}

function bodyTooLarge(res: ServerResponse, code: string): RouteError {
  res.setHeader('connection', 'close')
  return new RouteError(413, code, code)
}

async function boundedBodyBytes(req: IncomingMessage, res: ServerResponse, limit: number, limitCode: string): Promise<Buffer<ArrayBuffer>> {
  if (Number(req.headers['content-length']) > limit) throw bodyTooLarge(res, limitCode)
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > limit) throw bodyTooLarge(res, limitCode)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, length)
}

function coverGain(value: FormDataEntryValue | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length <= 24 && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) {
    const gain = Number(value)
    if (validSongGain(gain)) return gain
  }
  throw new RouteError(400, 'singing-invalid-gain', 'singing-invalid-gain')
}

async function coverTracks(req: IncomingMessage, res: ServerResponse): Promise<{ guide: Buffer; mix?: SingingCoverMix }> {
  const contentType = req.headers['content-type'] ?? ''
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (type === 'audio/wav' || type === 'audio/x-wav') {
    return { guide: await boundedBodyBytes(req, res, MAX_SINGING_WAV_BYTES, 'singing-guide-too-large') }
  }
  if (type !== 'multipart/form-data') throw new RouteError(415, 'singing-invalid-guide', 'singing-invalid-guide')
  const invalid = () => new RouteError(400, 'singing-invalid-multipart', 'singing-invalid-multipart')
  const data = await boundedBodyBytes(req, res, 2 * MAX_SINGING_WAV_BYTES + 65_536, 'singing-cover-too-large')
  const form = await new Response(data, { headers: { 'content-type': contentType } }).formData().catch(() => { throw invalid() })
  const fields = new Map<string, FormDataEntryValue>()
  form.forEach((value, name) => {
    if (!['guide', 'accompaniment', 'vocalGainDb', 'backingGainDb'].includes(name) || fields.has(name)) throw invalid()
    fields.set(name, value)
  })
  const guide = fields.get('guide')
  const accompaniment = fields.get('accompaniment')
  if (!(guide instanceof File) || !(accompaniment instanceof File)) throw invalid()
  if (guide.size > MAX_SINGING_WAV_BYTES) throw bodyTooLarge(res, 'singing-guide-too-large')
  if (accompaniment.size > MAX_SINGING_WAV_BYTES) throw bodyTooLarge(res, 'singing-accompaniment-too-large')
  const vocalGainDb = coverGain(fields.get('vocalGainDb'))
  const backingGainDb = coverGain(fields.get('backingGainDb'))
  const [guideBytes, accompanimentBytes] = await Promise.all([guide.arrayBuffer(), accompaniment.arrayBuffer()])
  return { guide: Buffer.from(guideBytes), mix: { accompaniment: Buffer.from(accompanimentBytes), vocalGainDb, backingGainDb } }
}

function allowed(ctx: Context, req: IncomingMessage): boolean {
  return managementAllowed(ctx, req)
}

function requireUnmanagedTask(capability: string, contextId?: string): void {
  if (contextId === MINECRAFT_RECOVERY_CONTEXT || capability === HOUSE_CELL_CAPABILITY) throw new RouteError(403, 'House recovery is managed by the scheduler', 'minecraft-house-recovery-managed')
  if (contextId === DAILY_VISIT_CONTEXT) throw new RouteError(403, 'Camp visit tasks require a leased game receipt', 'minecraft-camp-visit-managed')
  if (contextId === DAILY_REFLECTION_CONTEXT) throw new RouteError(403, 'Daily reflection tasks are managed by the idle scheduler', 'daily-reflection-managed')
  if (capability === CONTEXT_COMPACTION_CAPABILITY) throw new RouteError(403, 'Context compaction is managed by the idle scheduler', 'compaction-managed')
  if (capability === 'media.singing') throw new RouteError(403, 'Use the dedicated singing task endpoint', 'singing-task-managed')
  if (capability === 'media.avatar') throw new RouteError(403, 'Use the dedicated avatar action endpoint', 'avatar-task-managed')
  if (capability === 'minecraft.survey') throw new RouteError(403, 'Survey tasks require a live permit and game receipt', 'minecraft-survey-managed')
  if (capability === MINECRAFT_HOUSE_CAPABILITY) throw new RouteError(403, 'House tasks require an owner-approved blueprint and game receipt', 'minecraft-house-managed')
  if (capability === HOUSE_PROJECT_SECTION_CAPABILITY || capability === HOUSE_PROJECT_SUPPLY_CAPABILITY || capability === HOUSE_PROJECT_VERIFY_CAPABILITY) {
    throw new RouteError(403, 'Building projects require an owner-approved blueprint and game receipt', 'minecraft-house-project-managed')
  }
  if (capability === 'media.realtime' && contextId === SINGING_CONTEXT) {
    throw new RouteError(403, 'Use the dedicated song stage endpoint', 'song-stage-managed')
  }
}

function failure(error: unknown): [number, { error: string; code?: string }] {
  if (error instanceof RouteError) return [error.status, { error: error.message, code: error.code }]
  if (error instanceof DeviceAuthError) return [error.status, { error: error.code, code: error.code }]
  if (error instanceof z.ZodError) return [400, { error: 'Invalid request', code: 'invalid-request' }]
  if (error instanceof Error && error.message === 'Invalid feed cursor') return [400, { error: 'invalid-feed-cursor', code: 'invalid-feed-cursor' }]
  if (error instanceof Error && error.message === 'persona-version-conflict') return [409, { error: '角色档案已有新版本，请重新加载后编辑', code: error.message }]
  if (error instanceof Error && ['memory-archive-protected', 'memory-archive-state'].includes(error.message)) return [409, { error: error.message, code: error.message }]
  if (error instanceof Error && error.message === 'self-note-author-protected') return [403, { error: error.message, code: error.message }]
  if (error instanceof Error && error.message === 'self-note-superseded') return [409, { error: error.message, code: error.message }]
  if (error instanceof Error && ['self-note-invalid-evidence', 'self-note-invalid-supersession'].includes(error.message)) return [400, { error: error.message, code: error.message }]
  if (error instanceof Error && error.message === 'Only the author can delete this post') return [403, { error: error.message, code: 'forbidden' }]
  if (error instanceof TaskTransitionError) return [409, { error: error.message, code: error.code }]
  if (error instanceof Error && /not found/i.test(error.message)) return [404, { error: error.message, code: 'not-found' }]
  if (error instanceof Error && /not live|already bound/i.test(error.message)) return [409, { error: error.message, code: 'binding-conflict' }]
  return [500, { error: error instanceof Error ? error.message : String(error), code: 'internal-error' }]
}

export function registerHttp(ctx: Context, runtime: CompanionRuntime): () => void {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.webServer.host)) {
    throw new Error('Companion management requires a loopback DSH web server')
  }
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/companion',
    handler: async (req, res) => {
      if (!allowed(ctx, req)) {
        json(res, 403, { error: 'Same-origin Companion management request required', code: 'origin-refused' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
        if (!url.pathname.startsWith('/companion/api/')) throw new RouteError(404, 'Unknown Companion route')
        const path = url.pathname.slice('/companion/api/'.length)
        const method = req.method ?? 'GET'
        if (method === 'GET' && path === 'health') {
          json(res, 200, runtime.health())
          return
        }
        if (method === 'GET' && path === 'state') {
          json(res, 200, runtime.view({ management: true }))
          return
        }
        if (method === 'GET' && path === 'feed') {
          const cursor = z.string().max(1024).optional().parse(url.searchParams.get('cursor') ?? undefined)
          const limit = z.coerce.number().int().positive().max(50).optional().parse(url.searchParams.get('limit') ?? undefined)
          json(res, 200, runtime.store.feed.list({ cursor, limit }))
          return
        }
        if (method === 'POST' && path === 'feed') {
          const input = FeedPostInput.parse(await body(req))
          json(res, 201, await runtime.publishPost(input))
          return
        }
        const feedMatch = /^feed\/([^/]+)(\/replies)?$/.exec(path)
        if (method === 'GET' && feedMatch && !feedMatch[2]) {
          json(res, 200, runtime.store.feed.get(decodeURIComponent(feedMatch[1]!)))
          return
        }
        if (method === 'POST' && feedMatch && feedMatch[2]) {
          const input = FeedReplyInput.parse(await body(req))
          json(res, 201, await runtime.publishPost({ ...input, parentId: decodeURIComponent(feedMatch[1]!), author: 'user' }))
          return
        }
        if (method === 'DELETE' && feedMatch && !feedMatch[2]) {
          const input = z.object({ author: z.enum(['companion', 'user']).default('user') }).parse(await body(req))
          json(res, 200, runtime.deletePost(decodeURIComponent(feedMatch[1]!), input.author))
          return
        }
        if (method === 'PUT' && path === 'persona') {
          runtime.store.savePersona(PersonaInput.parse(await body(req)))
          json(res, 200, runtime.view())
          return
        }
        if (method === 'GET' && path === 'persona/revisions') {
          const before = url.searchParams.get('before')
          json(res, 200, runtime.store.personaHistory(before === null ? undefined : personaVersion.parse(Number(before))))
          return
        }
        const personaRestore = /^persona\/revisions\/([0-9]+)\/restore$/u.exec(path)
        if (method === 'POST' && personaRestore) {
          const input = z.strictObject({ expectedVersion: personaVersion, reason: personaReason }).parse(await body(req))
          runtime.store.restorePersona(personaVersion.parse(Number(personaRestore[1])), input.expectedVersion, input.reason)
          json(res, 200, runtime.view())
          return
        }
        if (method === 'PUT' && path === 'session') {
          await runtime.bind(SessionInput.parse(await body(req)).sessionId)
          json(res, 200, runtime.view())
          return
        }
        if (method === 'PUT' && path === 'bindings') {
          const input = BindingInput.parse(await body(req))
          if (input.contextId === MINECRAFT_RECOVERY_CONTEXT) throw new RouteError(403, 'House recovery requires an admitted private tool turn', 'minecraft-house-recovery-managed')
          if (input.contextId === BILIBILI_CLIP_CONTEXT) throw new RouteError(403, 'Bilibili clip sessions are managed by the scheduler', 'bili-clip-session-managed')
          runtime.bindContext(input)
          json(res, 200, runtime.view())
          return
        }
        if (method === 'POST' && path === 'sessions') {
          json(res, 201, await runtime.sessions.create(SessionCreateInput.parse(await body(req))))
          return
        }
        if (method === 'POST' && path === 'messages') {
          const input = MessageInput.parse(await body(req))
          json(res, 202, await runtime.sessions.send(input.contextId, input.text))
          return
        }
        if (method === 'POST' && path === 'messages/cancel') {
          const input = ContextInput.parse(await body(req))
          await runtime.sessions.cancel(input.contextId)
          json(res, 202, { accepted: true, contextId: input.contextId })
          return
        }
        if (method === 'GET' && path === 'messages/history') {
          const contextId = capabilityId.parse(url.searchParams.get('contextId'))
          const limit = z.coerce.number().int().positive().max(200).optional().parse(url.searchParams.get('limit') ?? undefined)
          json(res, 200, await runtime.sessions.history(contextId, limit))
          return
        }
        const messageTtsMatch = /^messages\/([^/]+)\/tts$/u.exec(path)
        if (method === 'POST' && messageTtsMatch) {
          const { contextId } = ContextInput.parse(await body(req))
          json(res, 202, await runtime.tts.synthesizeMessage(contextId, identifier.parse(decodeURIComponent(messageTtsMatch[1]!))))
          return
        }
        if (method === 'POST' && path === 'tts') {
          const input = TtsRenderInput.parse(await body(req, 4096))
          json(res, 202, await runtime.tts.synthesizeMessage(input.contextId, input.messageId, input.style))
          return
        }
        const expressiveCancel = /^tts\/([^/]+)\/cancel$/u.exec(path)
        if (method === 'POST' && expressiveCancel) {
          z.strictObject({}).parse(await body(req, 1024))
          const taskId = z.string().uuid().parse(decodeURIComponent(expressiveCancel[1]!))
          runtime.tts.get(taskId)
          json(res, 200, { cancelled: runtime.tts.cancelExpressive(taskId) })
          return
        }
        const ttsMatch = /^tts\/([^/]+)(\/audio)?$/u.exec(path)
        if ((method === 'GET' || method === 'HEAD') && ttsMatch) {
          const taskId = z.string().uuid().parse(decodeURIComponent(ttsMatch[1]!))
          if (ttsMatch[2]) {
            streamAudio(req, res, await runtime.audio(taskId))
          } else if (method === 'GET') {
            json(res, 200, runtime.tts.get(taskId))
          } else {
            json(res, 200, { ready: runtime.tts.get(taskId).status === 'succeeded' })
          }
          return
        }
        const bindingMatch = /^bindings\/([^/]+)$/.exec(path)
        if (method === 'DELETE' && bindingMatch) {
          await runtime.unbindContext(decodeURIComponent(bindingMatch[1]!))
          json(res, 200, runtime.view())
          return
        }
        if (method === 'GET' && path === 'memories') {
          const requested = url.searchParams.get('status')
          const status = requested === null ? 'all' : z.enum(['candidate', 'active', 'archived', 'forgotten', 'all']).parse(requested)
          const query = z.string().trim().max(1600).parse(url.searchParams.get('q') ?? '')
          json(res, 200, runtime.memoryView(status, query))
          return
        }
        if (method === 'POST' && path === 'memories') {
          const input = MemoryInput.parse(await body(req))
          json(res, 201, runtime.store.memory.create(input))
          return
        }
        if (method === 'POST' && path === 'memories/maintain') {
          json(res, 200, { forgotten: runtime.store.memory.maintain() })
          return
        }
        if (method === 'GET' && path === 'memories/archive-preview') {
          json(res, 200, { items: runtime.store.memory.previewArchive() })
          return
        }
        if (method === 'POST' && path === 'memories/archive-stale') {
          const { items } = z.strictObject({ items: z.array(z.strictObject({ id: z.uuid(), updatedAt: z.iso.datetime() })).min(1).max(50)
            .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length) }).parse(await body(req))
          json(res, 200, runtime.store.memory.archiveStale(items))
          return
        }
        const memoryActionMatch = /^memories\/([^/]+)\/(archive|forget|restore)$/.exec(path)
        if (method === 'POST' && memoryActionMatch) {
          const id = decodeURIComponent(memoryActionMatch[1]!)
          const current = runtime.store.memory.get(id)
          if (!current) throw new RouteError(404, 'Memory not found')
          const input = z.object({ reason: z.string().trim().max(500).optional() }).parse(await body(req))
          const action = memoryActionMatch[2]
          const reason = input.reason ?? action
          const memory = action === 'archive' ? runtime.store.memory.archive(id, reason)
            : action === 'restore' ? runtime.store.memory.restore(id, reason)
              : runtime.store.memory.update(id, { status: 'forgotten', reason })
          json(res, 200, memory)
          return
        }
        const memoryMatch = /^memories\/([^/]+)$/.exec(path)
        if (method === 'GET' && memoryMatch) {
          const id = decodeURIComponent(memoryMatch[1]!)
          const memory = runtime.store.memory.get(id)
          if (!memory) throw new RouteError(404, 'Memory not found')
          json(res, 200, { memory, revisions: runtime.store.memory.revisions(id) })
          return
        }
        if (method === 'PATCH' && memoryMatch) {
          json(res, 200, runtime.store.memory.update(decodeURIComponent(memoryMatch[1]!), MemoryUpdate.parse(await body(req))))
          return
        }
        if (method === 'GET' && path === 'self-notes') {
          const status = z.enum(['active', 'archived', 'all']).default('active').parse(url.searchParams.get('status') ?? undefined)
          json(res, 200, { items: runtime.store.selfNotes.list({ status }), counts: runtime.store.selfNotes.counts() })
          return
        }
        if (method === 'POST' && path === 'self-notes') {
          const input = z.strictObject({
            content: z.string().trim().min(1).max(500), confidence: score.default(0.9),
            evidence: z.array(z.string().trim().min(1).max(500)).max(3).default([]),
            counterEvidence: z.array(z.string().trim().min(1).max(500)).max(3).default([]),
            reason: z.string().trim().max(500).optional(),
          }).parse(await body(req))
          json(res, 201, runtime.store.selfNotes.create({ ...input, basis: 'user-feedback', createdBy: 'owner', sourceRefs: [] }))
          return
        }
        const selfNoteAction = /^self-notes\/([^/]+)\/(archive|restore|rollback)$/u.exec(path)
        if (method === 'POST' && selfNoteAction) {
          const id = decodeURIComponent(selfNoteAction[1]!)
          const input = z.object({ revision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(500).default('面板操作') }).parse(await body(req))
          if (selfNoteAction[2] === 'rollback') {
            if (input.revision === undefined) throw new RouteError(400, 'revision is required', 'invalid-request')
            json(res, 200, runtime.store.selfNotes.rollback(id, input.revision, input.reason))
          } else {
            json(res, 200, runtime.store.selfNotes.update(id, { status: selfNoteAction[2] === 'archive' ? 'archived' : 'active', reason: input.reason }))
          }
          return
        }
        const selfNoteMatch = /^self-notes\/([^/]+)$/u.exec(path)
        if (method === 'GET' && selfNoteMatch) {
          const id = decodeURIComponent(selfNoteMatch[1]!)
          const note = runtime.store.selfNotes.get(id)
          if (!note) throw new RouteError(404, 'Self note not found')
          const revision = z.coerce.number().int().positive().optional().parse(url.searchParams.get('revision') ?? undefined)
          const snapshot = revision === undefined ? undefined : runtime.store.selfNotes.revision(id, revision)
          if (revision !== undefined && !snapshot) throw new RouteError(404, 'Self note revision not found', 'self-note-revision-not-found')
          json(res, 200, { note, revisions: snapshot ? [snapshot] : runtime.store.selfNotes.revisions(id) })
          return
        }
        if (method === 'PATCH' && selfNoteMatch) {
          const input = z.strictObject({
            content: z.string().trim().min(1).max(500).optional(), confidence: score.optional(),
            evidence: z.array(z.string().trim().min(1).max(500)).max(3).optional(),
            counterEvidence: z.array(z.string().trim().min(1).max(500)).max(3).optional(),
            reason: z.string().trim().max(500).optional(),
          }).parse(await body(req))
          json(res, 200, runtime.store.selfNotes.update(decodeURIComponent(selfNoteMatch[1]!), input))
          return
        }
        if (method === 'GET' && path === 'media') {
          json(res, 200, await runtime.media.view(url.searchParams.get('refresh') === '1'))
          return
        }
        if (method === 'GET' && path === 'singing') {
          json(res, 200, runtime.singing.view())
          return
        }
        if (method === 'POST' && path === 'singing/tasks') {
          json(res, 202, runtime.singing.submit(SingingInputSchema.parse(await body(req))))
          return
        }
        if (method === 'POST' && path === 'singing/score') {
          json(res, 202, runtime.singing.submitScore(await body(req)))
          return
        }
        if (method === 'POST' && path === 'singing/covers') {
          if (url.searchParams.size !== 1) throw new RouteError(400, 'Invalid guide title', 'invalid-request')
          const title = z.string().trim().min(1).max(80).parse(url.searchParams.get('title'))
          const { guide, mix } = await coverTracks(req, res)
          json(res, 202, runtime.singing.submitCover(title, guide, mix))
          return
        }
        if (method === 'POST' && path === 'singing/source-covers') {
          const params = url.searchParams
          const keys = [...params.keys()]
          if (new Set(keys).size !== keys.length || keys.some(key => !['title', 'vocalGainDb', 'backingGainDb'].includes(key))) {
            throw new RouteError(400, 'Invalid source cover options', 'invalid-request')
          }
          const title = z.string().trim().min(1).max(80).parse(params.get('title'))
          const vocalGainDb = coverGain(params.get('vocalGainDb') ?? undefined)
          const backingGainDb = coverGain(params.get('backingGainDb') ?? undefined)
          const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
          if (type !== 'audio/wav' && type !== 'audio/x-wav') throw new RouteError(415, 'singing-invalid-source', 'singing-invalid-source')
          const source = await boundedBodyBytes(req, res, MAX_SINGING_WAV_BYTES, 'singing-source-too-large')
          json(res, 202, runtime.singing.submitSourceCover(title, source, { vocalGainDb, backingGainDb }))
          return
        }
        const singingTask = /^singing\/tasks\/([0-9a-f-]+)\/(cancel|audio)$/u.exec(path)
        if (singingTask && singingTask[2] === 'cancel' && method === 'POST') {
          json(res, 200, runtime.singing.cancel(z.uuid().parse(singingTask[1])))
          return
        }
        if (singingTask && singingTask[2] === 'audio' && (method === 'GET' || method === 'HEAD')) {
          streamAudio(req, res, await runtime.singing.audio(z.uuid().parse(singingTask[1])))
          return
        }
        if (method === 'POST' && path === 'bilibili/read') {
          const input = BilibiliReadInput.parse(await body(req))
          const controller = new AbortController()
          const cancel = () => controller.abort()
          res.once('close', cancel)
          try {
            const result = await runtime.bilibili.read(input, undefined, controller.signal)
            if (!res.destroyed) json(res, 200, result)
          } catch (error) {
            if (!res.destroyed) throw error
          } finally {
            res.off('close', cancel)
          }
          return
        }
        if (method === 'PUT' && path === 'bilibili/subtitles') {
          // JSON escaping can use up to six bytes for each source byte.
          const bytes = await boundedBodyBytes(req, res, MAX_BILIBILI_SUBTITLE_BYTES * 6 + 4096, 'bili-subtitle-too-large')
          let raw: unknown
          try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
          catch { throw new RouteError(400, 'Request body is not UTF-8 JSON', 'invalid-json') }
          const input = BilibiliSubtitleInput.parse(raw)
          const controller = new AbortController()
          const cancel = () => controller.abort()
          res.once('close', cancel)
          if (res.destroyed) cancel()
          try {
            const saved = await runtime.bilibili.attachSubtitle(input, controller.signal)
            runtime.autonomy.bilibiliSubtitleChanged(saved.bvid, saved.part)
            if (!res.destroyed) json(res, 200, { items: runtime.store.bilibiliSubtitles.view() })
          } catch (error) {
            if (!res.destroyed) throw error
          } finally {
            res.off('close', cancel)
          }
          return
        }
        const bilibiliSubtitle = /^bilibili\/subtitles\/(BV[A-Za-z0-9]{10})\/([1-9]\d{0,3})$/u.exec(path)
        if (method === 'DELETE' && bilibiliSubtitle) {
          const bvid = bilibiliSubtitle[1]!
          const part = Number(bilibiliSubtitle[2])
          if (part > 1000 || !runtime.store.bilibiliSubtitles.remove(bvid, part)) {
            throw new RouteError(404, 'bili-subtitle-unavailable', 'bili-subtitle-unavailable')
          }
          runtime.autonomy.bilibiliSubtitleChanged(bvid, part)
          json(res, 200, { items: runtime.store.bilibiliSubtitles.view() })
          return
        }
        if (path === 'bilibili/queue' && method === 'GET') {
          json(res, 200, runtime.store.bilibili.view())
          return
        }
        if (path === 'bilibili/queue' && method === 'POST') {
          const input = BilibiliReadInput.omit({ subtitles: true }).extend({ label: z.string().trim().max(80).optional() }).parse(await body(req))
          const target = parseBilibiliTarget(input.video, input.part)
          if (!target) throw new RouteError(400, 'bili-invalid-video', 'bili-invalid-video')
          if (!runtime.store.bilibili.add(target, input.label || undefined)) throw new RouteError(409, 'bili-queue-full', 'bili-queue-full')
          runtime.autonomy.wakeBilibili()
          json(res, 201, runtime.store.bilibili.view())
          return
        }
        const bilibiliCandidate = /^bilibili\/queue\/([^/]+)$/.exec(path)
        if (bilibiliCandidate && method === 'DELETE') {
          const id = z.uuid().parse(bilibiliCandidate[1])
          if (!runtime.store.bilibili.cancel(id)) throw new RouteError(404, 'bili-candidate-unavailable', 'bili-candidate-unavailable')
          runtime.autonomy.cancelBilibili(id)
          json(res, 200, runtime.store.bilibili.view())
          return
        }
        if (path === 'bilibili/sources' && method === 'POST') {
          const input = z.strictObject({ url: z.string().trim().min(1).max(512), label: z.string().trim().max(80).optional() }).parse(await body(req))
          const collection = parseBilibiliCollection(input.url)
          if (!collection) throw new RouteError(400, 'bili-invalid-source', 'bili-invalid-source')
          const label = input.label && plainBilibiliText(input.label, 240) || undefined
          if (!runtime.store.bilibili.addSource({ ...collection, label })) throw new RouteError(409, 'bili-source-limit', 'bili-source-limit')
          runtime.autonomy.wakeBilibili()
          json(res, 201, runtime.store.bilibili.view())
          return
        }
        const bilibiliSource = /^bilibili\/sources\/([^/]+)$/.exec(path)
        if (bilibiliSource && method === 'DELETE') {
          const id = z.uuid().parse(bilibiliSource[1])
          const revoked = runtime.store.bilibili.revokeSource(id)
          if (!revoked) throw new RouteError(404, 'bili-source-unavailable', 'bili-source-unavailable')
          runtime.autonomy.cancelBilibiliSource(id, revoked.candidateIds)
          runtime.autonomy.wakeBilibili()
          json(res, 200, runtime.store.bilibili.view())
          return
        }
        if (method === 'POST' && path === 'media/refresh') {
          json(res, 200, await runtime.media.view(true))
          return
        }
        if (method === 'POST' && path === 'media/preview') {
          const input = z.object({ olderThanDays: z.number().int().min(1).max(365).default(30) }).parse(await body(req))
          json(res, 200, await runtime.media.preview(input.olderThanDays))
          return
        }
        if (method === 'POST' && path === 'media/cleanup') {
          const input = z.object({ olderThanDays: z.number().int().min(1).max(365), confirm: z.literal(true), limit: z.number().int().min(1).max(50).default(20) }).parse(await body(req))
          json(res, 200, await runtime.media.cleanup(input.olderThanDays, input.limit))
          return
        }
        const mediaFileMatch = /^media-file\/([0-9a-f-]+)$/u.exec(path)
        if ((method === 'GET' || method === 'HEAD') && mediaFileMatch) {
          const content = await runtime.deviceMedia.content(z.string().uuid().parse(mediaFileMatch[1]))
          res.writeHead(200, { 'content-type': content.asset.mimeType, 'content-length': content.bytes, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
          if (method === 'HEAD') res.end()
          else createReadStream(content.path).pipe(res)
          return
        }
        if (method === 'GET' && path === 'tools') {
          json(res, 200, runtime.toolPolicy(capabilityId.parse(url.searchParams.get('contextId'))))
          return
        }
        if (method === 'GET' && path === 'minecraft') {
          json(res, 200, await runtime.minecraft.view())
          return
        }
        if (method === 'GET' && path === 'minecraft/houses') {
          json(res, 200, await runtime.minecraft.houses())
          return
        }
        if (method === 'POST' && path === 'minecraft/house-projects/import-preview') {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const input = MinecraftHouseProjectImportInput.parse(await body(req))
          json(res, 200, runtime.minecraft.previewHouseProjectImport(input))
          return
        }
        if (path === 'minecraft/house-projects' && (method === 'GET' || method === 'POST')) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          if (method === 'GET') json(res, 200, await runtime.minecraft.houseProjects())
          else json(res, 201, runtime.minecraft.createHouseProject(MinecraftHouseProjectInput.parse(await body(req))))
          return
        }
        const projectSection = /^minecraft\/house-projects\/([0-9a-f-]+)\/sections\/([0-9])\/(preview|build)$/u.exec(path)
        if (method === 'POST' && projectSection) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const id = z.uuid().parse(projectSection[1])
          const index = z.int().min(0).max(PROJECT_MAX_SECTIONS - 1).parse(Number(projectSection[2]))
          if (projectSection[3] === 'build') {
            const { previewId } = z.strictObject({ previewId: z.uuid() }).parse(await body(req))
            json(res, 200, await runtime.minecraft.buildHouseProjectSection(id, index, previewId))
          } else {
            z.strictObject({}).parse(await body(req))
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try {
              const result = await runtime.minecraft.previewHouseProjectSection(id, index, controller.signal)
              if (!res.destroyed) json(res, 200, result)
            } finally { res.off('close', disconnect) }
          }
          return
        }
        const projectPlace = /^minecraft\/house-projects\/([0-9a-f-]+)\/place$/u.exec(path)
        if (method === 'POST' && projectPlace) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const { name } = z.strictObject({ name: z.string() }).parse(await body(req))
          const result = runtime.minecraft.nameHouseProjectPlace(z.uuid().parse(projectPlace[1]), name)
          json(res, 200, result.project)
          return
        }
        const projectVerify = /^minecraft\/house-projects\/([0-9a-f-]+)\/verify$/u.exec(path)
        if (method === 'POST' && projectVerify) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const id = z.uuid().parse(projectVerify[1])
          z.strictObject({}).parse(await body(req))
          json(res, 200, await runtime.minecraft.verifyHouseProject(id))
          return
        }
        const houseDraft = /^minecraft\/houses\/([a-z0-9-]+)(\/revisions)?$/u.exec(path)
        if (houseDraft && (method === 'PATCH' && !houseDraft[2] || method === 'GET' && houseDraft[2])) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const id = z.uuid().parse(houseDraft[1])
          if (method === 'GET') json(res, 200, runtime.minecraft.houseHistory(id))
          else {
            const input = MinecraftHouseRevisionInput.parse(await body(req))
            json(res, 200, runtime.minecraft.reviseHouse(id, input))
          }
          return
        }
        const houseReference = /^minecraft\/houses\/([a-z0-9-]+)\/reference$/u.exec(path)
        if (method === 'GET' && houseReference) {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid request', 'invalid-request')
          const source = runtime.store.minecraftHouses.referenceSource(z.uuid().parse(houseReference[1]))
          if (!source) throw new RouteError(404, 'minecraft-house-reference-not-found', 'minecraft-house-reference-not-found')
          const controller = new AbortController()
          const disconnect = () => controller.abort()
          res.once('close', disconnect)
          if (res.destroyed) disconnect()
          try {
            const { messageId, attachmentId } = source.reference
            const { data, attachment } = await runtime.sessions.houseReferenceAttachment(source.sessionId, messageId, attachmentId, controller.signal)
            if (res.destroyed) return
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType)) {
              throw new RouteError(404, 'minecraft-house-reference-not-found', 'minecraft-house-reference-not-found')
            }
            res.writeHead(200, { 'content-type': attachment.mimeType, 'content-length': data.byteLength,
              'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
            res.end(data)
          } finally { res.off('close', disconnect) }
          return
        }
        const houseAction = /^minecraft\/houses\/([a-z0-9-]+)\/(preview|build)$/u.exec(path)
        if (method === 'POST' && houseAction) {
          const id = z.uuid().parse(houseAction[1])
          if (houseAction[2] === 'preview') {
            const { zoneId } = z.strictObject({ zoneId: z.uuid() }).parse(await body(req))
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try {
              const preview = await runtime.minecraft.previewHouse(id, zoneId, controller.signal)
              if (!res.destroyed) json(res, 200, preview)
            } finally { res.off('close', disconnect) }
          } else {
            const { zoneId, previewId } = z.strictObject({ zoneId: z.uuid(), previewId: z.uuid() }).parse(await body(req))
            json(res, 200, await runtime.minecraft.buildHouse(id, zoneId, previewId))
          }
          return
        }
        if (method === 'POST' && path === 'minecraft/wardrobe') {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid wardrobe request', 'invalid-request')
          const { id } = z.strictObject({ id: MinecraftWardrobeId }).parse(await body(req))
          const controller = new AbortController()
          const disconnect = () => controller.abort()
          res.once('close', disconnect)
          if (res.destroyed) disconnect()
          try {
            const wardrobe = await runtime.minecraft.changeAppearance(id, controller.signal)
            if (!res.destroyed) json(res, 200, wardrobe)
          } finally { res.off('close', disconnect) }
          return
        }
        if (method === 'PUT' && path === 'minecraft/camp-control') {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid camp control request', 'invalid-request')
          const input = z.strictObject({ pairedPauseEnabled: z.boolean() }).parse(await body(req))
          json(res, 200, runtime.minecraft.setPairedCampPause(input.pairedPauseEnabled))
          return
        }
        if (method === 'POST' && path === 'minecraft/camp-resume') {
          if (url.searchParams.size) throw new RouteError(400, 'Invalid camp resume request', 'invalid-request')
          z.strictObject({}).parse(await body(req))
          json(res, 200, await runtime.minecraft.resumeCamp())
          return
        }
        if (method === 'POST' && path === 'minecraft/ask') {
          const input = z.object({ text: z.string().trim().min(1).max(256) }).parse(await body(req))
          const job = runtime.minecraft.ask(input.text)
          if (!job) throw new RouteError(409, 'Minecraft is not ready for world events')
          json(res, 202, job)
          return
        }
        if (path === 'minecraft/survey-window') {
          if (method === 'GET') {
            json(res, 200, runtime.autonomy.surveyWindowView())
            return
          }
          if (method === 'PUT') {
            json(res, 200, runtime.autonomy.setSurveyWindow(MinecraftSurveyWindowInputSchema.parse(await body(req))))
            return
          }
          if (method === 'DELETE') {
            json(res, 200, runtime.autonomy.revokeSurveyWindow())
            return
          }
        }
        if (method === 'POST' && path === 'minecraft/supply') {
          const { zoneId, goal } = z.strictObject({
            zoneId: z.uuid(),
            goal: z.enum(MINECRAFT_PERMIT_GOALS).default('planks'),
          }).parse(await body(req))
          json(res, 202, runtime.autonomy.enqueueMinecraftSupply(zoneId, goal))
          return
        }
        if (method === 'POST' && path === 'minecraft/supply/cancel') {
          const { zoneId } = z.strictObject({ zoneId: z.uuid().optional() }).parse(await body(req))
          json(res, 200, { cancelled: runtime.autonomy.cancelMinecraftSupply(zoneId) })
          return
        }
        if (path === 'minecraft/zones' && method === 'GET') {
          json(res, 200, runtime.minecraft.buildZones())
          return
        }
        if (path === 'minecraft/zones' && method === 'POST') {
          const input = z.object({
            name: z.string().trim().min(1).max(80),
            dimension: z.string().regex(/^[a-z0-9_:.-]{1,64}$/u),
            x: z.number().int().min(-30_000_000).max(30_000_000),
            y: z.number().int().min(-2048).max(2032),
            z: z.number().int().min(-30_000_000).max(30_000_000),
            radius: z.number().int().min(2).max(8),
          }).parse(await body(req))
          json(res, 201, runtime.minecraft.createBuildZone(input))
          return
        }
        const buildZoneMatch = /^minecraft\/zones\/([a-z0-9-]+)$/u.exec(path)
        if (method === 'DELETE' && buildZoneMatch) {
          json(res, 200, { revoked: await runtime.minecraft.revokeBuildZone(buildZoneMatch[1]!) })
          return
        }
        const minecraftMatch = /^minecraft\/(login|connect|disconnect|chat|follow|move|dig|return|craft|shield|build|prepare|stop)$/u.exec(path)
        if (method === 'POST' && minecraftMatch) {
          const input = await body(req)
          const action = minecraftMatch[1]
          if (action === 'login') json(res, 202, await runtime.minecraft.login())
          else if (action === 'connect') json(res, 202, await runtime.minecraft.connect())
          else if (action === 'disconnect') json(res, 202, await runtime.minecraft.disconnect())
          else if (action === 'chat') json(res, 202, await runtime.minecraft.chat(z.object({ text: z.string().trim().min(1).max(256) }).parse(input).text))
          else if (action === 'follow') json(res, 202, await runtime.minecraft.follow())
          else if (action === 'move') json(res, 202, await runtime.minecraft.move(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).parse(input)))
          else if (action === 'dig') json(res, 202, await runtime.minecraft.dig(z.object({ name: z.string().regex(/^[a-z_]+$/u).optional() }).parse(input).name))
          else if (action === 'return') json(res, 202, await runtime.minecraft.returnToSafety())
          else if (action === 'craft') json(res, 202, await runtime.minecraft.craft(z.object({ name: z.string().regex(/^[a-z_]+$/u) }).parse(input).name))
          else if (action === 'shield') {
            if (url.searchParams.size) throw new RouteError(400, 'Invalid shield request', 'invalid-request')
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try {
              const result = await runtime.minecraft.holdShield(input, controller.signal)
              if (!res.destroyed) json(res, 202, result)
            } finally { res.off('close', disconnect) }
          }
          else if (action === 'build') {
            const build = z.object({ zoneId: z.string().regex(/^[a-z0-9-]+$/u), material: z.string().regex(/^[a-z_]+$/u) }).parse(input)
            json(res, 202, await runtime.minecraft.buildCamp(build.zoneId, build.material))
          }
          else if (action === 'prepare') {
            const prepare = z.object({ zoneId: z.string().regex(/^[a-z0-9-]+$/u), material: z.string().regex(/^[a-z_]+$/u).optional() }).parse(input)
            json(res, 202, await runtime.minecraft.prepareCamp(prepare.zoneId, prepare.material))
          }
          else json(res, 202, await runtime.minecraft.stop())
          return
        }
        if (method === 'GET' && path === 'autonomy') {
          json(res, 200, runtime.autonomy.view())
          return
        }
        if (method === 'GET' && path === 'presenter') {
          json(res, 200, runtime.presenter.view())
          return
        }
        if (method === 'POST' && path === 'presenter/start') {
          json(res, 200, await runtime.presenter.start())
          return
        }
        if (method === 'POST' && path === 'presenter/stop') {
          json(res, 200, await runtime.presenter.stop())
          return
        }
        if (method === 'PUT' && path === 'autonomy') {
          const input = z.object({
            enabled: z.boolean().optional(),
            memoryReview: z.boolean().optional(),
            dailyReflectionEnabled: z.boolean().optional(),
            dailyInitiativeEnabled: z.boolean().optional(),
            minecraftMilestonesEnabled: z.boolean().optional(),
            minecraftRecoveryEnabled: z.boolean().optional(),
            minecraftRecoveryPlacementEnabled: z.boolean().optional(),
            minecraftRecoveryContinuousEnabled: z.boolean().optional(),
            memoryArchiveEnabled: z.boolean().optional(),
            idleCompactionEnabled: z.boolean().optional(),
            feedEnabled: z.boolean().optional(),
            feedRepliesEnabled: z.boolean().optional(),
            minecraftShareEnabled: z.boolean().optional(),
            minecraftShareImagesEnabled: z.boolean().optional(),
            bilibiliEnabled: z.boolean().optional(),
            bilibiliClipsEnabled: z.boolean().optional(),
            bilibiliReflectionEnabled: z.boolean().optional(),
            bilibiliShareEnabled: z.boolean().optional(),
            bilibiliClipShareEnabled: z.boolean().optional(),
            bilibiliIntervalMinutes: z.number().int().min(30).max(1440).optional(),
            reviewDelaySec: z.number().int().min(30).max(600).optional(),
            replyDelaySec: z.number().int().min(5).max(120).optional(),
            replyCooldownSec: z.number().int().min(30).max(3600).optional(),
            feedIntervalMinutes: z.number().int().min(60).max(1440).optional(),
            quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(),
            quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(),
          }).parse(await body(req))
          const view = runtime.autonomy.updateSettings(input)
          runtime.idleCompaction.policyChanged()
          json(res, 200, view)
          return
        }
        if (method === 'POST' && path === 'autonomy/jobs') {
          const input = z.object({ kind: z.enum(['memory.review', 'feed.review']), contextId: capabilityId.optional() }).parse(await body(req))
          json(res, 202, runtime.autonomy.enqueue(input.kind, input.contextId))
          return
        }
        if (method === 'POST' && path === 'tasks') {
          const input = TaskInput.parse(await body(req))
          requireUnmanagedExternalId(input.externalId)
          if (input.externalId?.startsWith(`${CONTEXT_COMPACTION_CAPABILITY}:`)) {
            throw new RouteError(403, 'Context compaction is managed by the idle scheduler', 'compaction-managed')
          }
          if (input.externalId?.startsWith(SINGING_CHAT_COVER_ID_PREFIX) || input.externalId?.startsWith(SINGING_CHAT_SCORE_ID_PREFIX)) {
            throw new RouteError(403, 'Use the dedicated singing task endpoint', 'singing-task-managed')
          }
          requireUnmanagedTask(input.capabilityId, input.contextId)
          if (!runtime.store.capabilities().some(capability => capability.id === input.capabilityId)) throw new RouteError(404, 'Capability not found')
          json(res, 201, runtime.store.createTask(input))
          return
        }
        const taskMatch = /^tasks\/([^/]+)$/.exec(path)
        if (method === 'PATCH' && taskMatch) {
          const update = TaskUpdate.parse(await body(req))
          const id = decodeURIComponent(taskMatch[1]!)
          const task = runtime.store.taskById(id)
          requireUnmanagedExternalId(task?.externalId)
          if (task) requireUnmanagedTask(task.capabilityId, task.contextId)
          json(res, 200, runtime.store.transitionTask(id, update.status, update.error))
          return
        }
        const capabilityMatch = /^capabilities\/([^/]+)$/.exec(path)
        if (method === 'PUT' && capabilityMatch) {
          const update = CapabilityUpdate.parse(await body(req))
          runtime.updateCapability(decodeURIComponent(capabilityMatch[1]!), update.status as CapabilityStatus, update.detail)
          json(res, 200, runtime.view())
          return
        }
        if (method === 'POST' && path === 'events') {
          const input = ActivityInput.parse(await body(req))
          if (input.kind === 'world.house-project-section' || input.kind === HOUSE_PROJECT_SUPPLY_EVENT || input.kind === 'world.house-project-verification') {
            throw new RouteError(403, 'Building project events require a game receipt', 'minecraft-house-project-managed')
          }
          if (input.contextId === DAILY_AUTONOMY_CONTEXT) throw new RouteError(403, 'Daily activity evidence is recorded by the scheduler', 'daily-choice-managed')
          if (input.contextId === DAILY_REFLECTION_CONTEXT) throw new RouteError(403, 'Daily reflection evidence is recorded by the scheduler', 'daily-reflection-managed')
          if (input.source === 'media.realtime' && input.kind === 'song.played') {
            throw new RouteError(403, 'Song playback events require a stage receipt', 'song-stage-managed')
          }
          if (input.source === 'media.avatar' && input.kind.startsWith('avatar.action.')) {
            throw new RouteError(403, 'Avatar action events require the dedicated stage endpoint', 'avatar-task-managed')
          }
          if (input.kind === MINECRAFT_HOUSE_RECOVERY_EVENT || input.eventId?.startsWith(MINECRAFT_HOUSE_RECOVERY_PREFIX)) {
            throw new RouteError(403, 'House recovery events require a verified construction attempt', 'minecraft-house-managed')
          }
          if (input.contextId === MINECRAFT_RECOVERY_CONTEXT || [HOUSE_AGENT_RECOVERY_EVENT, HOUSE_CELL_ACTIVITY, HOUSE_CELL_AUDIT_ACTIVITY].includes(input.kind) ||
            input.eventId?.startsWith(HOUSE_AGENT_RECOVERY_PREFIX) || input.eventId?.startsWith(HOUSE_CELL_AUDIT_PREFIX)) {
            throw new RouteError(403, 'House recovery events require an admitted private tool turn', 'minecraft-house-recovery-managed')
          }
          if (input.source === 'minecraft.survey') throw new RouteError(403, 'Survey events require a game receipt', 'minecraft-survey-managed')
          if (input.contextId === DAILY_VISIT_CONTEXT || input.source === 'game.minecraft' &&
            ['world.visit-offline', 'world.visit-supply', 'world.visit-build', 'world.visit-revisit', 'world.patrol-segment', 'world.visit-gather', MINECRAFT_HOUSE_EVENT].includes(input.kind)) {
            throw new RouteError(403, 'Camp visit events require a verified game receipt', 'minecraft-camp-visit-managed')
          }
          if (input.source === 'core.self-note') throw new RouteError(403, 'Self note activity is written by its authoring workflow', 'self-note-author-protected')
          if (input.source === 'core.persona') throw new RouteError(403, 'Persona activity requires a committed revision', 'persona-revision-managed')
          if (input.source === 'core.autonomy' && input.kind.startsWith('survey-window.')) {
            throw new RouteError(403, 'Survey window events require a local owner authorization', 'minecraft-survey-window-managed')
          }
          if (input.source === 'media.bilibili' && ['video.inspected', 'video.subtitle-read', 'video.clip-sampled'].includes(input.kind)) {
            throw new RouteError(403, 'Bilibili reading events require a connector receipt', 'bili-read-managed')
          }
          if (input.kind === 'assistant.completed') {
            throw new RouteError(403, 'Model usage requires a native assistant event', 'model-usage-managed')
          }
          if (input.source === CONTEXT_COMPACTION_CAPABILITY || input.source === 'core.memory' && input.kind === 'memory.reviewed') {
            throw new RouteError(403, 'Context maintenance events require a native receipt', 'compaction-managed')
          }
          if (input.source === 'core.memory' && ['memory.archived', 'memory.archive-sweep'].includes(input.kind)) {
            throw new RouteError(403, 'Memory archive receipts are written by the archive workflow', 'memory-archive-managed')
          }
          const id = runtime.store.recordActivity({
            ...input,
            status: input.status as ActivityStatus,
            data: input.data as Record<string, JsonValue>,
          })
          json(res, 201, { id })
          return
        }
        throw new RouteError(404, 'Unknown Companion operation', 'not-found')
      } catch (error) {
        json(res, ...failure(error))
      }
    },
  })
}
