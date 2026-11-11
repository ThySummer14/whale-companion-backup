import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { CompanionStore } from '../core/store.ts'
import type { DeviceRecord } from '../core/model.ts'

interface Offer {
  codeHash: string
  name: string
  hostName: string
  routes: string[]
  expiresAt: number
}

interface PairPayload {
  v: 1
  offerId: string
  code: string
  hostName: string
  routes: string[]
  expiresAt: string
}

type DeviceAudioKind = 'voice-stream' | 'asr' | 'singing-audio'

export interface DeviceView {
  id: string
  name: string
  createdAt: string
  lastSeenAt?: string
  revokedAt?: string
}

export class DeviceAuthError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function view(device: DeviceRecord): DeviceView {
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt }
}

function validRoutes(routes: string[]): string[] {
  if (!routes.length || routes.length > 4) throw new DeviceAuthError(400, 'invalid-routes')
  return routes.map(route => {
    const url = new URL(route)
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new DeviceAuthError(400, 'invalid-routes')
    return url.origin
  })
}

export class DeviceService {
  private readonly offers = new Map<string, Offer>()
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()
  private readonly sockets = new Map<string, Set<WebSocket>>()
  private readonly audioRequests = new Map<string, Map<DeviceAudioKind, AbortController>>()
  private closed = false

  constructor(private readonly ctx: Context, private readonly store: CompanionStore, private readonly onRevoke?: (id: string) => void) {}

  createOffer(input: { name?: string; hostName?: string; routes?: string[] }): { link: string; expiresAt: string } {
    const offerId = randomUUID()
    const code = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + 5 * 60_000
    const offer: Offer = {
      codeHash: hash(code),
      name: input.name?.trim() || 'Paired device',
      hostName: input.hostName?.trim() || 'Companion Host',
      routes: validRoutes(input.routes?.length ? input.routes : [this.ctx.webServer.getOrigin()]),
      expiresAt,
    }
    for (const [id, current] of this.offers) if (current.expiresAt <= Date.now()) this.offers.delete(id)
    this.offers.set(offerId, offer)
    const payload: PairPayload = { v: 1, offerId, code, hostName: offer.hostName, routes: offer.routes, expiresAt: new Date(expiresAt).toISOString() }
    return { link: `companion://pair?p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, expiresAt: payload.expiresAt }
  }

  redeem(encoded: string): { credential: string; device: DeviceView; hostName: string; routes: string[] } {
    let payload: PairPayload
    try {
      const encodedOffer = encoded.startsWith('companion://') ? new URL(encoded).searchParams.get('p') : encoded
      if (!encodedOffer) throw new Error('missing offer')
      const value = JSON.parse(Buffer.from(encodedOffer, 'base64url').toString('utf8')) as Partial<PairPayload> | null
      if (!value || typeof value !== 'object' || typeof value.offerId !== 'string' || typeof value.code !== 'string' || value.code.length !== 43) throw new Error('invalid offer')
      payload = value as PairPayload
    } catch {
      throw new DeviceAuthError(401, 'offer-invalid')
    }
    const offer = this.offers.get(payload.offerId)
    if (!offer || offer.expiresAt <= Date.now() || payload.v !== 1 || !equal(hash(payload.code), offer.codeHash)) {
      throw new DeviceAuthError(401, 'offer-invalid')
    }
    this.offers.delete(payload.offerId)
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const now = new Date().toISOString()
    const device: DeviceRecord = { id, name: offer.name, secretHash: hash(secret), createdAt: now, lastSeenAt: now }
    this.store.createDevice(device)
    return { credential: `Device ${id}.${secret}`, device: view(device), hostName: offer.hostName, routes: offer.routes }
  }

  authenticate(req: IncomingMessage): DeviceRecord {
    const header = req.headers.authorization
    if (!header?.startsWith('Device ')) throw new DeviceAuthError(401, 'device-unauthorized')
    const [id, secret] = header.slice('Device '.length).split('.', 2)
    if (!id || !secret) throw new DeviceAuthError(401, 'device-unauthorized')
    const device = this.store.deviceById(id)
    if (!device || device.revokedAt || !equal(hash(secret), device.secretHash)) throw new DeviceAuthError(401, 'device-unauthorized')
    if (!device.lastSeenAt || Date.now() - new Date(device.lastSeenAt).getTime() > 60_000) this.store.touchDevice(id, new Date().toISOString())
    return device
  }

  authorize(req: IncomingMessage): boolean {
    try {
      this.authenticate(req)
      return true
    } catch {
      return false
    }
  }

  track(req: IncomingMessage, socket: WebSocket): void {
    const device = this.authenticate(req)
    const sockets = this.sockets.get(device.id) ?? new Set<WebSocket>()
    sockets.add(socket)
    this.sockets.set(device.id, sockets)
    socket.once('close', () => {
      const current = this.sockets.get(device.id)
      current?.delete(socket)
      if (!current?.size) this.sockets.delete(device.id)
    })
  }

  trackAudio(deviceId: string, kind: DeviceAudioKind, controller: AbortController): () => void {
    if (this.closed) throw new DeviceAuthError(503, `${kind}-stopping`)
    const device = this.store.deviceById(deviceId)
    if (!device || device.revokedAt) throw new DeviceAuthError(401, 'device-unauthorized')
    const requests = this.audioRequests.get(deviceId) ?? new Map<DeviceAudioKind, AbortController>()
    if (requests.has(kind)) throw new DeviceAuthError(409, `${kind}-busy`)
    requests.set(kind, controller)
    this.audioRequests.set(deviceId, requests)
    return () => {
      if (requests.get(kind) === controller) requests.delete(kind)
      if (!requests.size && this.audioRequests.get(deviceId) === requests) this.audioRequests.delete(deviceId)
    }
  }

  list(): DeviceView[] {
    return this.store.devices().map(view)
  }

  revoke(id: string): boolean {
    const revoked = this.store.revokeDevice(id, new Date().toISOString())
    if (!revoked) throw new DeviceAuthError(404, 'device-not-found')
    this.onRevoke?.(id)
    for (const socket of this.sockets.get(id) ?? []) socket.terminate()
    this.sockets.delete(id)
    for (const request of this.audioRequests.get(id)?.values() ?? []) request.abort(new DeviceAuthError(401, 'device-unauthorized'))
    this.audioRequests.delete(id)
    return true
  }

  allowAttempt(address: string | undefined): boolean {
    const now = Date.now()
    const current = this.attempts.get(address ?? 'unknown')
    if (!current || current.resetAt <= now) {
      this.attempts.set(address ?? 'unknown', { count: 1, resetAt: now + 60_000 })
      return true
    }
    if (current.count >= 20) return false
    current.count += 1
    return true
  }

  close(): void {
    this.closed = true
    this.offers.clear()
    this.attempts.clear()
    for (const sockets of this.sockets.values()) for (const socket of sockets) socket.terminate()
    this.sockets.clear()
    for (const requests of this.audioRequests.values()) {
      for (const [kind, request] of requests) request.abort(new DeviceAuthError(503, `${kind}-stopping`))
    }
    this.audioRequests.clear()
  }
}
