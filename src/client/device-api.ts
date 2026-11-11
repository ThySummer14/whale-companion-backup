export interface DeviceView {
  id: string
  name: string
  createdAt: string
  lastSeenAt?: string
  revokedAt?: string
}

async function request<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
  const response = await fetch(`/companion/api/${path}`, {
    method,
    cache: 'no-store',
    headers: { 'x-companion-request': '1', ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  const value = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(value.error || `Device request failed (${response.status})`)
  return value as T
}

export const getDevices = () => request<{ items: DeviceView[] }>('devices/list')
export const createDeviceOffer = (input: { name: string; hostName: string; routes: string[] }) => request<{ link: string; expiresAt: string }>('devices/offer', 'POST', input)
export const revokeDevice = (id: string) => request<{ revoked: true; id: string }>('devices/revoke', 'POST', { id })
