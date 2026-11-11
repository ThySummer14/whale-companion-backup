import { z } from 'zod'

const MinecraftOwnerEvent = z.object({
  seq: z.int(),
  username: z.string().min(1).max(32),
  message: z.string().min(1).max(1024),
  sourceId: z.uuid().optional(),
})
export type MinecraftOwnerEvent = z.infer<typeof MinecraftOwnerEvent>

export const MINECRAFT_EVENT_BATCH_LIMIT = 6
export const MINECRAFT_OWNER_MESSAGES = 'Minecraft 主人消息：'

export function minecraftOwnerEvents(value: unknown): MinecraftOwnerEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => MinecraftOwnerEvent.safeParse(item).data ?? []).slice(-MINECRAFT_EVENT_BATCH_LIMIT)
}

export function minecraftOwnerEventKey(event: MinecraftOwnerEvent): string {
  return event.sourceId ? `${event.sourceId}.${event.seq}` : String(event.seq)
}

export function minecraftOwnerMessageText(text: string): string {
  if (!text.startsWith(MINECRAFT_OWNER_MESSAGES)) return text
  try {
    const messages: unknown = JSON.parse(text.slice(MINECRAFT_OWNER_MESSAGES.length))
    if (Array.isArray(messages) && messages.length <= MINECRAFT_EVENT_BATCH_LIMIT &&
        messages.every(item => typeof item === 'string' && item.length <= 1024)) return messages.join('\n')
  } catch { /* A message from another format still has readable text. */ }
  return text
}
