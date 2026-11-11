import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { AVATAR_ACTIONS } from '../core/model.ts'
import type { HomeView } from '../protocol/api.ts'
import type { AvatarService } from './avatar.ts'
import type { RealtimeVoiceService } from './realtime-voice.ts'
import { DeviceAuthError } from './devices.ts'
import { managementAllowed, managementAssetAllowed } from './security.ts'
import { streamAudio } from './audio.ts'
import { MAX_SONG_VOCAL_SAMPLES, SONG_VOCAL_ENVELOPE_HEADER } from '../protocol/singing.ts'
import { streamPcm } from './pcm-http.ts'

const ContextId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u)
const StageId = z.string().uuid()
const ActionInput = z.object({ action: z.enum(AVATAR_ACTIONS), stageId: StageId.optional() })
const HeartbeatInput = z.object({ ready: z.boolean(), frames: z.number().int().nonnegative().max(1_000_000_000), nonFinite: z.number().int().nonnegative().max(10_000), stageId: StageId.optional(), songReady: z.boolean().optional(), actionReady: z.boolean().optional(), renderer: z.string().max(160).optional(), jobId: z.string().uuid().optional(), parameterCount: z.number().int().positive().max(100_000).optional(), voice: z.object({ playing: z.boolean(), segmentIndex: z.number().int().nonnegative().max(5).optional(), positionMs: z.number().nonnegative().max(3_600_000), energy: z.number().nonnegative().max(1), audioContextState: z.string().max(40), error: z.string().max(300).optional() }).optional() })
const ReceiptInput = z.object({ taskId: z.string().uuid(), stageId: StageId.optional(), status: z.enum(['playing', 'completed', 'cancelled', 'error']), frames: z.number().int().nonnegative().max(1_000_000_000), error: z.string().max(300).optional() })

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.from(chunk).length
    if (size > 16_384) throw new Error('Request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function mime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    case '.txt': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

export function registerAvatarHttp(ctx: Context, avatar: AvatarService, realtime: RealtimeVoiceService, homeActivity?: () => HomeView['activity']): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/companion/avatar',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
        if (!url.pathname.startsWith('/companion/avatar/')) {
          json(res, 404, { error: 'not-found' })
          return
        }
        const path = decodeURIComponent(url.pathname.slice('/companion/avatar/'.length))
        if (path.startsWith('api')) {
          if (!managementAllowed(ctx, req)) {
            json(res, 403, { error: 'origin-refused' })
            return
          }
          if (req.method === 'GET' && path === 'api') {
            json(res, 200, avatar.view())
            return
          }
          if (req.method === 'GET' && path === 'api/realtime') {
            json(res, 200, realtime.view())
            return
          }
          if (req.method === 'GET' && path === 'api/realtime/scenes') {
            json(res, 200, realtime.autoReadScenes())
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/auto') {
            const input = z.object({ stageId: StageId, contextId: ContextId.optional() }).parse(await body(req))
            json(res, 200, input.contextId ? realtime.enableAutoRead(input.contextId, input.stageId) : realtime.disableAutoRead(input.stageId))
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/auto/poll') {
            const input = z.object({ stageId: StageId }).parse(await body(req))
            json(res, 200, realtime.pollAutoRead(input.stageId))
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/start') {
            const input = z.object({ contextId: ContextId, messageId: z.string().trim().min(1).max(200).optional(), streaming: z.boolean().optional() }).parse(await body(req))
            json(res, 202, await realtime.startSession(input.contextId, input.messageId, input.streaming))
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/song') {
            const input = z.strictObject({ taskId: z.uuid(), stageId: StageId.optional() }).parse(await body(req))
            json(res, 202, await realtime.startSong(input.taskId, input.stageId))
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/cancel') {
            const input = z.object({ sessionId: z.string().uuid().optional() }).parse(await body(req))
            json(res, 200, realtime.cancel(input.sessionId))
            return
          }
          if (req.method === 'POST' && path === 'api/realtime/receipt') {
            const input = z.object({ sessionId: z.string().uuid(), stageId: StageId.optional(), segmentIndex: z.number().int().nonnegative().max(5), status: z.enum(['playing', 'completed', 'cancelled', 'error']), positionMs: z.number().nonnegative().max(3_600_000).optional(), energy: z.number().nonnegative().max(1).optional(), error: z.string().max(300).optional() }).parse(await body(req))
            json(res, 200, realtime.receipt(input))
            return
          }
          const streamMatch = /^api\/realtime\/stream\/([0-9a-f-]+)\/([0-5])$/u.exec(path)
          if (req.method === 'GET' && streamMatch) {
            if (url.searchParams.size !== 1) throw new DeviceAuthError(400, 'invalid-request')
            const stageId = StageId.parse(url.searchParams.get('stageId'))
            const sessionId = z.string().uuid().parse(streamMatch[1])
            await streamPcm(res, signal => realtime.stream(sessionId, Number(streamMatch[2]), stageId, signal))
            return
          }
          const audioMatch = /^api\/realtime\/audio\/([0-9a-f-]+)$/u.exec(path)
          if (req.method === 'GET' && audioMatch) {
            const stageId = StageId.optional().parse(url.searchParams.get('stageId') ?? undefined)
            const audio = await realtime.audio(z.string().uuid().parse(audioMatch[1]), stageId)
            if (audio.onDelivered) res.once('finish', () => { if (res.statusCode === 200) audio.onDelivered?.() })
            if (!req.headers.range && audio.vocalEnvelope?.length && audio.vocalEnvelope.length <= MAX_SONG_VOCAL_SAMPLES) {
              res.setHeader(SONG_VOCAL_ENVELOPE_HEADER, `v1:${Buffer.from(audio.vocalEnvelope).toString('base64')}`)
            }
            streamAudio(req, res, audio)
            return
          }
          if (req.method === 'POST' && path === 'api/heartbeat') {
            const input = HeartbeatInput.parse(await body(req))
            const view = avatar.heartbeat(input)
            const activity = view.available && input.ready && input.actionReady !== false && input.frames > 0 && input.nonFinite === 0 ? homeActivity?.() : undefined
            json(res, 200, { ...view, homeActivity: activity })
            return
          }
          if (req.method === 'POST' && path === 'api/actions') {
            const input = ActionInput.parse(await body(req))
            json(res, 202, avatar.startAction(input.action, input.stageId))
            return
          }
          if (req.method === 'POST' && path === 'api/receipt') {
            json(res, 200, avatar.receipt(ReceiptInput.parse(await body(req))))
            return
          }
          if (req.method === 'POST' && path === 'api/stop') {
            const input = z.object({ taskId: z.string().uuid().optional() }).parse(await body(req))
            json(res, 200, avatar.stop(input.taskId))
            return
          }
          json(res, 404, { error: 'not-found' })
          return
        }
        if (!['GET', 'HEAD'].includes(req.method ?? '') || !managementAssetAllowed(ctx, req)) {
          json(res, 403, { error: 'origin-refused' })
          return
        }
        if (path.startsWith('model/') || path === 'data/model-profile.json' || path === 'vendor/live2dcubismcore.min.js') {
          const kind = path.startsWith('model/') ? 'model' : path.startsWith('data/') ? 'profile' : 'core'
          const file = await avatar.asset(kind, kind === 'model' ? path.slice('model/'.length) : undefined)
          if (!file) {
            json(res, 404, { error: 'asset-not-found' })
            return
          }
          res.writeHead(200, { 'content-type': mime(file.path), 'content-length': file.bytes, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
          if (req.method === 'HEAD') res.end()
          else createReadStream(file.path).pipe(res)
          return
        }
        const allowed = new Set(['index.html', 'stage.mjs', 'renderer.mjs', 'action-job.mjs', 'engine.mjs', 'idle-events.mjs', 'driver-pipeline.mjs', 'context-motion.mjs', 'voice.mjs', 'vendor/pixi.min.js', 'vendor/cubism4.min.js', 'NOTICE.txt'])
        if (!allowed.has(path || 'index.html')) {
          json(res, 404, { error: 'not-found' })
          return
        }
        const file = join(avatar.stageRoot, path || 'index.html')
        const info = await stat(file)
        if (!info.isFile()) throw new Error('Asset is not a file')
        res.writeHead(200, { 'content-type': mime(file), 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
        if (req.method === 'HEAD') res.end()
        else if (file.endsWith('.html') || file.endsWith('.txt')) res.end(await readFile(file))
        else createReadStream(file).pipe(res)
      } catch (error) {
        if (res.destroyed) return
        if (res.headersSent) {
          res.destroy()
          return
        }
        if (error instanceof DeviceAuthError) {
          json(res, error.status, { error: error.code })
          return
        }
        const message = error instanceof z.ZodError ? 'invalid-request' : error instanceof SyntaxError ? 'invalid-json' : error instanceof Error && /not live|not active|already active|already settled|current state|not finished rendering/.test(error.message) ? error.message : 'avatar-request-failed'
        json(res, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : message === 'avatar-request-failed' ? 500 : 409, { error: message })
      }
    },
  })
}
