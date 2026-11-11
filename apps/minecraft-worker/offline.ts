import { createHash } from 'node:crypto'

export function offlineMinecraftProfile({ enabled, ovoRoot, gameHost, botName, owner }: {
  enabled: boolean
  ovoRoot?: string
  gameHost: string
  botName: string
  owner: string
}): { name: string; uuid: string } | undefined {
  if (!enabled) return
  if (!ovoRoot || !['127.0.0.1', '::1', 'localhost'].includes(gameHost)) throw new Error('offline-requires-loopback-ovo')
  if (botName.toLowerCase() === owner.toLowerCase()) throw new Error('primary-account-refused')
  const digest = createHash('md5').update(`OfflinePlayer:${botName}`, 'utf8').digest()
  digest[6] = (digest[6]! & 0x0f) | 0x30
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const raw = digest.toString('hex')
  return { name: botName, uuid: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}` }
}
