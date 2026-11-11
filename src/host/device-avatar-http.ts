import { createHash, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { TLSSocket } from 'node:tls'
import type { Context } from '@deepseek-ai/cordis'
import type { AvatarService } from './avatar.ts'
import { DeviceAuthError } from './devices.ts'
import { PRESENTER_HEADERS, presenterAsset, presenterAssetType, presenterModelManifest, presenterRequestPath, type PresenterService } from './presenter.ts'

const PREFIX = '/companion-device/avatar'
const TICKET_MS = 15_000
const IDLE_MS = 45_000
const SESSION_MS = 20 * 60_000
const MAX_TICKETS = 64
const MAX_SESSIONS = 64
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
const HEADERS = { ...PRESENTER_HEADERS, 'permissions-policy': 'camera=(), microphone=(), geolocation=()' }

interface ViewerOrigin { origin: string; secure: boolean; cookie: string }
interface ViewerTicket { deviceId: string; origin: string; expiresAt: number }
interface ViewerSession extends ViewerTicket { idleUntil: number }
type ViewerAvatar = Pick<AvatarService, 'asset' | 'stageRoot' | 'presenterFrame'>

function key(token: string): string { return createHash('sha256').update(token).digest('hex') }

function requestOrigin(req: IncomingMessage, localOrigin: string): ViewerOrigin | undefined {
  const { host, origin, referer, 'sec-fetch-site': site } = req.headers
  if (!host || !/^(?:[a-z\d.-]+|\[[a-f\d:]+\])(?::\d{1,5})?$/iu.test(host) ||
    req.headers['tailscale-funnel-request'] !== undefined || (site !== undefined && site !== 'same-origin' && site !== 'none')) return
  const loopback = LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')
  const proto = req.headers['x-forwarded-proto']
  const forwardedHost = req.headers['x-forwarded-host']
  const forwardedTls = loopback && proto === 'https' && (forwardedHost === undefined || forwardedHost === host)
  const secure = (req.socket as TLSSocket).encrypted === true || forwardedTls
  try {
    const requested = new URL(`${secure ? 'https' : 'http'}://${host}`)
    // Only the direct local development listener accepts HTTP. Proxy metadata never authorizes a viewer.
    if (!secure && (!loopback || !LOOPBACK_HOSTS.has(requested.hostname) || requested.origin !== localOrigin ||
      proto !== undefined || forwardedHost !== undefined || req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined)) return
    if ((origin !== undefined && origin !== requested.origin) || (referer !== undefined && new URL(referer).origin !== requested.origin)) return
    return { origin: requested.origin, secure, cookie: secure ? '__Secure-CompanionAvatar' : 'CompanionAvatarLoopback' }
  } catch { return undefined }
}

function json(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...extra })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const prefix = `${name}=`
  const matches = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(prefix))
  return matches?.length === 1 ? matches[0]!.slice(prefix.length) : undefined
}

export class DeviceAvatarViewer {
  private readonly tickets = new Map<string, ViewerTicket>()
  private readonly sessions = new Map<string, ViewerSession>()
  private readonly responses = new Set<ServerResponse>()
  private readonly preparation: Promise<ReadonlySet<string> | undefined>
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly avatar: ViewerAvatar,
    private readonly presenter: Pick<PresenterService, 'frame'>,
    private readonly activeDevice: (id: string) => boolean,
  ) {
    this.preparation = this.prepareAssets().catch(() => undefined)
  }

  async capability(req: IncomingMessage): Promise<{ version: 1 } | undefined> {
    if (!requestOrigin(req, this.ctx.webServer.getOrigin()) || !await this.availableAssets()) return
    return { version: 1 }
  }

  async issue(req: IncomingMessage, deviceId: string): Promise<{ ticket: string }> {
    const origin = requestOrigin(req, this.ctx.webServer.getOrigin())
    if (!origin) throw new DeviceAuthError(403, 'avatar-view-origin-refused')
    if (!await this.availableAssets()) throw new DeviceAuthError(404, 'avatar-view-unavailable')
    if (!this.activeDevice(deviceId)) throw new DeviceAuthError(401, 'device-unauthorized')
    const now = Date.now()
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now || ticket.deviceId === deviceId) this.tickets.delete(id)
    if (this.tickets.size >= MAX_TICKETS) throw new DeviceAuthError(429, 'avatar-view-busy')
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(key(ticket), { deviceId, origin: origin.origin, expiresAt: now + TICKET_MS })
    return { ticket }
  }

  register(): () => void {
    const dispose = this.ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => this.handle(req, res) })
    return () => {
      this.closed = true
      this.tickets.clear()
      this.sessions.clear()
      dispose()
      for (const res of this.responses) if (!res.writableFinished) res.destroy()
      this.responses.clear()
    }
  }

  private async prepareAssets(): Promise<ReadonlySet<string> | undefined> {
    const { paths, complete } = await presenterModelManifest(this.avatar)
    if (!complete) return
    const required = ['/', '/data/model-profile.json', '/vendor/live2dcubismcore.min.js', ...[...paths].map(path => `/model/${path}`)]
    const assets = await Promise.all(required.map(path => presenterAsset(this.avatar, path, paths, 'device-presenter.html')))
    return assets.every(asset => asset && asset.bytes > 0) ? paths : undefined
  }

  private async availableAssets(): Promise<ReadonlySet<string> | undefined> {
    const assets = await this.preparation
    return !this.closed && this.avatar.presenterFrame(Date.now(), false).available ? assets : undefined
  }

  private redeem(req: IncomingMessage, origin: ViewerOrigin): ViewerTicket {
    const token = req.headers.authorization?.startsWith('AvatarView ') ? req.headers.authorization.slice('AvatarView '.length) : undefined
    const hash = token && TOKEN.test(token) ? key(token) : ''
    const ticket = this.tickets.get(hash)
    if (!ticket || ticket.origin !== origin.origin || ticket.expiresAt <= Date.now() || !this.activeDevice(ticket.deviceId)) {
      throw new DeviceAuthError(401, 'avatar-view-unauthorized')
    }
    this.tickets.delete(hash)
    return ticket
  }

  private requireSession(req: IncomingMessage, origin: ViewerOrigin): ViewerSession {
    const token = readCookie(req, origin.cookie)
    const hash = token && TOKEN.test(token) ? key(token) : ''
    const session = this.sessions.get(hash)
    const now = Date.now()
    if (session?.origin !== origin.origin) throw new DeviceAuthError(401, 'avatar-view-unauthorized')
    if (session.expiresAt <= now || session.idleUntil <= now || !this.activeDevice(session.deviceId)) {
      this.sessions.delete(hash)
      throw new DeviceAuthError(401, 'avatar-view-unauthorized')
    }
    return session
  }

  private startSession(ticket: ViewerTicket, origin: ViewerOrigin): string {
    const now = Date.now()
    if (this.closed || ticket.expiresAt <= now || !this.activeDevice(ticket.deviceId)) throw new DeviceAuthError(401, 'avatar-view-unauthorized')
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now || session.idleUntil <= now || (session.deviceId === ticket.deviceId && session.origin === ticket.origin)) this.sessions.delete(id)
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new DeviceAuthError(429, 'avatar-view-busy')
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(key(token), { deviceId: ticket.deviceId, origin: ticket.origin, expiresAt: now + SESSION_MS, idleUntil: now + IDLE_MS })
    return `${origin.cookie}=${token}; Path=${PREFIX}/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${origin.secure ? '; Secure' : ''}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.responses.add(res)
    try {
      const origin = requestOrigin(req, this.ctx.webServer.getOrigin())
      if (!origin) throw new DeviceAuthError(403, 'avatar-view-origin-refused')
      const requestPath = presenterRequestPath(req)
      if (!requestPath?.startsWith(`${PREFIX}/`) || req.url?.includes('?')) throw new DeviceAuthError(404, 'avatar-view-not-found')
      const paths = await this.availableAssets()
      if (!paths) throw new DeviceAuthError(404, 'avatar-view-unavailable')
      const path = requestPath.slice(PREFIX.length)
      const ticket = path === '/' && req.method === 'GET' && req.headers.authorization !== undefined ? this.redeem(req, origin) : undefined
      if (!ticket) this.requireSession(req, origin)
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'avatar-view-read-only' }, { allow: 'GET, HEAD' })
      if (path === '/state') {
        const frame = this.presenter.frame()
        this.requireSession(req, origin).idleUntil = Date.now() + IDLE_MS
        return json(req, res, 200, frame)
      }

      const asset = await presenterAsset(this.avatar, path, paths, 'device-presenter.html')
      if (!ticket) this.requireSession(req, origin)
      if (!asset) throw new DeviceAuthError(404, 'avatar-view-not-found')
      const file = await open(asset.path, 'r').catch(() => undefined)
      if (!file) throw new DeviceAuthError(404, 'avatar-view-not-found')
      try {
        const info = await file.stat()
        if (res.destroyed) return
        if (!info.isFile()) throw new DeviceAuthError(404, 'avatar-view-not-found')
        if (this.closed) throw new DeviceAuthError(503, 'avatar-view-unavailable')
        const headers: Record<string, string | number> = { ...HEADERS, 'content-type': presenterAssetType(path), 'content-length': info.size }
        if (ticket) headers['set-cookie'] = this.startSession(ticket, origin)
        else this.requireSession(req, origin).idleUntil = Date.now() + IDLE_MS
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else await pipeline(file.createReadStream({ autoClose: false }), res)
      } finally { await file.close() }
    } catch (error) {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else if (error instanceof DeviceAuthError) json(req, res, error.status, { error: error.code })
      else json(req, res, 503, { error: 'avatar-view-unavailable' })
    } finally { this.responses.delete(res) }
  }
}
