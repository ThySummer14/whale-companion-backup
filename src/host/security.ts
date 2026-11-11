import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'

export function loopbackHttpEndpoint(input: string, name: string): URL {
  const message = `${name} endpoint must be an exact loopback HTTP URL with a path`
  let endpoint: URL
  try { endpoint = new URL(input) } catch { throw new Error(message) }
  const { protocol, hostname, pathname, search, hash, username, password } = endpoint
  if (protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(hostname) || pathname === '/' || search || hash || username || password) throw new Error(message)
  return endpoint
}

export function managementAllowed(ctx: Context, req: IncomingMessage): boolean {
  const origin = ctx.webServer.getOrigin()
  const expectedHost = new URL(origin).host
  if (req.headers.host !== expectedHost || req.headers['x-companion-request'] !== '1') return false
  const requestOrigin = req.headers.origin
  return requestOrigin === undefined || requestOrigin === origin || requestOrigin === 'dsh-app://app'
}

export function managementAssetAllowed(ctx: Context, req: IncomingMessage): boolean {
  if (!['GET', 'HEAD'].includes(req.method ?? '')) return false
  const origin = ctx.webServer.getOrigin()
  if (req.headers.host !== new URL(origin).host) return false
  const requestOrigin = req.headers.origin
  if (requestOrigin !== undefined && requestOrigin !== origin && requestOrigin !== 'dsh-app://app') return false
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || site === 'none'
}
