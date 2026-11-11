import { randomUUID } from 'node:crypto'

const LEASE_MS = 6500
const MAX_DEVICES = 128
const MAX_GRANTS = 16

type PlaybackKind = 'speaking' | 'singing'
type PlaybackState = 'playing' | 'paused' | 'stopped'
type Grant = { kind: PlaybackKind; sequence: number; state?: PlaybackState }
type DevicePlayback = {
  client: string
  grants: Map<string, Grant>
  lastStart: number
  active?: { id: string; kind: PlaybackKind; until: number }
}

export class DevicePlaybackService {
  private readonly devices = new Map<string, DevicePlayback>()

  issue(deviceId: string, client: string | string[] | undefined, kind: PlaybackKind): Record<string, string> {
    if (typeof client !== 'string' || !/^[a-f0-9]{32}$/u.test(client)) return {}
    let device = this.devices.get(deviceId)
    if (device?.client !== client) device = { client, grants: new Map(), lastStart: 0 }
    this.devices.delete(deviceId)
    this.devices.set(deviceId, device)
    if (this.devices.size > MAX_DEVICES) this.devices.delete(this.devices.keys().next().value!)
    if (device.grants.size === MAX_GRANTS) {
      for (const oldId of device.grants.keys()) {
        if (oldId === device.active?.id) continue
        device.grants.delete(oldId)
        break
      }
    }
    const id = randomUUID()
    device.grants.set(id, { kind, sequence: 0 })
    return { 'x-companion-playback-id': id }
  }

  report(deviceId: string, id: string, sequence: number, state: PlaybackState, now = Date.now()): boolean {
    const device = this.devices.get(deviceId)
    const grant = device?.grants.get(id)
    if (!device || !grant) return false
    if (sequence < grant.sequence || (sequence === grant.sequence && grant.state !== 'playing')) return true
    grant.sequence = sequence
    grant.state = state
    // A terminal receipt wins over every heartbeat for its native start, regardless of arrival order.
    if (sequence < device.lastStart || (sequence === device.lastStart && device.active?.id !== id)) return true
    device.lastStart = sequence
    device.active = state === 'playing' ? { id, kind: grant.kind, until: now + LEASE_MS } : undefined
    return true
  }

  activity(now: number): { speaking: boolean; singing: boolean } {
    const result = { speaking: false, singing: false }
    for (const { active } of this.devices.values()) {
      if (active && active.until > now) result[active.kind] = true
    }
    return result
  }

  revoke(deviceId: string): void {
    this.devices.delete(deviceId)
  }

  close(): void {
    this.devices.clear()
  }
}
