import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { AVATAR_ACTIONS } from '../core/model.ts'
import type { PresenterSnapshot, PresenterView } from '../protocol/presenter.ts'
import type { AvatarService } from './avatar.ts'
import { DeviceAuthError } from './devices.ts'

const LOOPBACK = '127.0.0.1'
const MODEL = '大肥鱼.model3.json'
const MODEL_ASSETS = [MODEL, 'Exp3/脸红.exp3.json', 'Animation/竖手指切出来动画.motion3.json']
const BUNDLED = new Set([
  'presenter.mjs', 'presenter-cues.mjs', 'renderer.mjs', 'action-job.mjs', 'engine.mjs',
  'driver-pipeline.mjs', 'idle-events.mjs', 'context-motion.mjs', 'vendor/pixi.min.js', 'vendor/cubism4.min.js',
])
const ACTIVITIES = new Set(['offline', 'idle', 'resting', 'chatting', 'minecraft', 'speaking', 'browsing', 'singing'])
export const PRESENTER_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
  // The bundled PIXI 6 shader uniform synchronizer requires new Function.
  'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
} as const

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
}

export type PresenterAvatar = Pick<AvatarService, 'asset' | 'stageRoot'>

function json(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const bytes = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { ...PRESENTER_HEADERS, 'content-type': TYPES['.json'], 'content-length': bytes.length, ...extra })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

function validModelPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 400 && !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..') && /\.(moc3|json|png)$/iu.test(path)
}

export function presenterRequestPath(req: IncomingMessage): string | undefined {
  const raw = req.url?.split('?', 1)[0]
  if (!raw?.startsWith('/') || raw.startsWith('//')) return undefined
  try {
    const path = decodeURIComponent(raw)
    if (/[\\\u0000-\u001f\u007f]/u.test(path) || path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) return undefined
    return path
  } catch { return undefined }
}

function authorized(req: IncomingMessage, origin: string, path: string): boolean {
  if (req.socket.remoteAddress !== LOOPBACK || req.headers.host !== new URL(origin).host) return false
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false
  if (req.headers.referer !== undefined) {
    try { if (new URL(req.headers.referer).origin !== origin) return false } catch { return false }
  }
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none' ||
    (site === 'same-site' && path === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')
}

function project(snapshot: PresenterSnapshot): PresenterSnapshot {
  const { activity, voiceEnergy, action } = snapshot
  return {
    available: snapshot.available === true,
    ...(activity && ACTIVITIES.has(activity) && { activity }),
    ...(typeof voiceEnergy === 'number' && Number.isFinite(voiceEnergy) && voiceEnergy >= 0 && voiceEnergy <= 1 && { voiceEnergy }),
    ...(action && AVATAR_ACTIONS.includes(action.id) && Number.isSafeInteger(action.startedAt) && action.startedAt > 0 &&
      Number.isFinite(action.elapsedMs) && action.elapsedMs >= 0 && action.elapsedMs <= 60_000 && {
      action: { id: action.id, startedAt: action.startedAt, elapsedMs: action.elapsedMs },
    }),
  }
}

export async function presenterModelManifest(avatar: PresenterAvatar): Promise<{ paths: Set<string>; complete: boolean }> {
  const paths = new Set(MODEL_ASSETS)
  try {
    const asset = await avatar.asset('model', MODEL)
    if (!asset || asset.bytes > 128 * 1024) return { paths, complete: false }
    const { FileReferences: refs } = JSON.parse(await readFile(asset.path, 'utf8'))
    if (!refs || typeof refs !== 'object') return { paths, complete: false }
    const textures: unknown[] = Array.isArray(refs.Textures) ? refs.Textures.slice(0, 64) : []
    const optional = [refs.Physics, refs.Pose, refs.UserData, refs.DisplayInfo].filter(path => path !== undefined)
    for (const path of [refs.Moc, ...optional, ...textures]) {
      if (validModelPath(path)) paths.add(path)
    }
    return { paths, complete: validModelPath(refs.Moc) && refs.Moc.toLowerCase().endsWith('.moc3') &&
      textures.length > 0 && refs.Textures.length === textures.length && textures.every(path => validModelPath(path) && path.toLowerCase().endsWith('.png')) &&
      optional.every(validModelPath) }
  } catch { return { paths, complete: false } }
}

export async function presenterAsset(avatar: PresenterAvatar, path: string, modelPaths: ReadonlySet<string>, page: 'presenter.html' | 'device-presenter.html'): Promise<{ path: string; bytes: number } | undefined> {
  if (path === '/data/model-profile.json') return avatar.asset('profile')
  if (path === '/vendor/live2dcubismcore.min.js') return avatar.asset('core')
  if (path.startsWith('/model/') && modelPaths.has(path.slice(7))) return avatar.asset('model', path.slice(7))
  if (path !== '/' && !BUNDLED.has(path.slice(1))) return undefined
  const file = join(avatar.stageRoot, path === '/' ? page : path.slice(1))
  const info = await stat(file).catch(() => undefined)
  if (info?.isFile()) return { path: file, bytes: info.size }
}

export function presenterAssetType(path: string): string {
  return TYPES[path === '/' ? '.html' : extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export class PresenterService {
  private server?: Server
  private operations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly avatar: PresenterAvatar,
    private readonly snapshot: () => PresenterSnapshot,
    private readonly port = 18790,
  ) {}

  private origin(server: Server | undefined): string | undefined {
    const address = server?.address()
    return address && typeof address !== 'string' ? `http://${LOOPBACK}:${address.port}` : undefined
  }

  view(): PresenterView {
    const origin = this.origin(this.server)
    return origin ? { running: true, obsUrl: `${origin}/?mode=obs`, desktopUrl: `${origin}/?mode=desktop` } : { running: false }
  }

  frame(): PresenterSnapshot { return project(this.snapshot()) }

  private change(operation: () => Promise<PresenterView>): Promise<PresenterView> {
    const result = this.operations.then(operation)
    this.operations = result.catch(() => {})
    return result
  }

  start(): Promise<PresenterView> {
    return this.change(async () => {
      if (this.server) return this.view()
      const { paths: modelPaths } = await presenterModelManifest(this.avatar)
      const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
        (req, res) => { void this.handle(server, req, res, modelPaths) })
      server.on('upgrade', (_req, socket) => socket.destroy())
      server.on('connect', (_req, socket) => socket.destroy())
      server.on('clientError', (_error, socket) => socket.destroy())
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen({ host: LOOPBACK, port: this.port, exclusive: true }, () => {
            server.off('error', reject)
            resolve()
          })
        })
      } catch (error) {
        const inUse = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        throw new DeviceAuthError(inUse ? 409 : 503, inUse ? 'presenter-port-in-use' : 'presenter-listen-failed')
      }
      this.server = server
      server.on('error', () => {
        if (this.server === server) this.server = undefined
        if (server.listening) server.close()
        server.closeAllConnections()
      })
      return this.view()
    })
  }

  stop(): Promise<PresenterView> {
    return this.change(async () => {
      const server = this.server
      if (!server) return this.view()
      this.server = undefined
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return this.view()
    })
  }

  private async handle(server: Server, req: IncomingMessage, res: ServerResponse, modelPaths: ReadonlySet<string>): Promise<void> {
    try {
      const origin = this.origin(server)
      const path = presenterRequestPath(req)
      if (!origin || !path || !authorized(req, origin, path)) return json(req, res, 403, { error: 'presenter-origin-refused' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'presenter-read-only' }, { allow: 'GET, HEAD' })
      if (path === '/state') return json(req, res, 200, this.frame())

      const asset = await presenterAsset(this.avatar, path, modelPaths, 'presenter.html')
      if (res.destroyed) return
      if (!asset) return json(req, res, 404, { error: 'presenter-not-found' })
      const headers = { ...PRESENTER_HEADERS, 'content-type': presenterAssetType(path), 'content-length': asset.bytes }
      if (req.method === 'HEAD') { res.writeHead(200, headers).end(); return }
      const stream = createReadStream(asset.path)
      res.once('close', () => stream.destroy())
      stream.once('open', () => { if (!res.destroyed) { res.writeHead(200, headers); stream.pipe(res) } })
      stream.once('error', () => {
        if (res.destroyed) return
        if (res.headersSent) res.destroy()
        else json(req, res, 404, { error: 'presenter-not-found' })
      })
    } catch {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else json(req, res, 503, { error: 'presenter-unavailable' })
    }
  }
}
