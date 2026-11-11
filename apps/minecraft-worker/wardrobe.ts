import { MinecraftWardrobeConfigSchema } from '../../src/protocol/minecraft-wardrobe.ts'

export const YSM_MODEL_NBT = 'ysm.model_id'

export function configuredWardrobe(raw: string | undefined) {
  if (!raw || Buffer.byteLength(raw) > 16_384) return []
  try {
    const parsed = MinecraftWardrobeConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch { return [] }
}

function* serverInfo(log: string): Generator<string> {
  for (const line of log.matchAll(/^\[[^\]\r\n]+\] \[Server thread\/INFO\]: ([^\r\n]*)\r?\n/gmu)) {
    yield line[1]!.replace(/§[0-9a-fk-or]/giu, '').trimEnd()
  }
}

export function ysmWardrobeAvailable(log: string): boolean {
  for (const message of serverInfo(log)) {
    if (/^\/ysm model set <targets> <model_id> <texture_id>(?: \[<ignore_auth>\])?$/u.test(message)) return true
  }
  return false
}

export function ysmWardrobeReceipt(log: string, player: string, model: string): 'accepted' | 'raw-accepted' | 'refused' | 'offline' | 'unconfirmed' | undefined {
  // In 2.6.5 even missing models and authorization refusals return Brigadier 1.
  // Require the server's post-assignment feedback carrying the actual model and player.
  for (const message of serverInfo(log)) {
    if (message === `[YSM] Set '${model}' models for player '${player}'` || message === `[YSM] 已将玩家 '${player}' 的模型设置为 '${model}'`) return 'accepted'
    if (message === `[YSM] Unable set '${model}' models for player '${player}', need model auth` ||
      message === `[YSM] 无法将玩家 '${player}' 的模型设置为 '${model}'，缺少权限` ||
      message === `[YSM] '${model}' is not exist` || message === `[YSM] '${model}' 不存在`) return 'refused'
    if (message === 'No player was found' || message === 'No entity was found') return 'offline'
    if (message === 'message.yes_steve_model.model.set.success') return 'raw-accepted'
    if (message === 'message.yes_steve_model.model.set.need_auth' || message === 'commands.yes_steve_model.export.not_exist') return 'unconfirmed'
  }
}

export function ysmWardrobeStateLine(log: string, player: string): { kind: 'data'; snbt: string } | { kind: 'absent' | 'offline' } | undefined {
  const prefix = `${player} has the following entity data: `
  for (const message of serverInfo(log)) {
    if (message.startsWith(prefix)) return { kind: 'data', snbt: message.slice(prefix.length) }
    if (message === `Found no elements matching ${YSM_MODEL_NBT}`) return { kind: 'absent' }
    if (message === 'No entity was found' || message === 'No player was found') return { kind: 'offline' }
  }
}
