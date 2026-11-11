import { BILIBILI_CONTEXT, SINGING_CONTEXT, type ContextKind, type SessionBinding } from '../core/model.ts'

type WorldAction = readonly [name: string, summary: string, permission: string]

export interface WorldDefinition {
  id: string
  label: string
  contextId: string
  kind: ContextKind
  restricted: boolean
  memory: boolean
  actions: readonly WorldAction[]
}

const MINECRAFT_TOOLS = [
  ['mc_status', '查看真实 worker、连接与任务状态', 'minecraft:read'],
  ['mc_observe', '观察真实世界、血量、背包与附近实体', 'minecraft:read'],
  ['mc_name_place', '为已整体验收的建筑保存或修订命名地点', 'minecraft:place-name'],
  ['mc_storage', '在授权区使用 OVO 技能库存取少量物品并双向核对数量', 'minecraft:storage'],
  ['mc_smelt', '在授权区使用 OVO 技能库投料烧炼并核对实际成品', 'minecraft:smelt'],
  ['mc_chat', '以角色身份发送普通游戏聊天', 'minecraft:chat'],
  ['mc_follow', '用寻路跟随主人，直到停止', 'minecraft:move'],
  ['mc_move', '小范围受控寻路，不挖方块或放置方块', 'minecraft:move'],
  ['mc_dig', '采集有树叶旁证的自然原木并回读', 'minecraft:gather'],
  ['mc_return', '最多 16 格的受限垫脚脱困，核对真实出口与材料', 'minecraft:return'],
  ['mc_craft', '按白名单真实配方合成一次并核对背包', 'minecraft:craft'],
  ['mc_shield', '短时举起已有盾牌，确认格挡和释放', 'minecraft:defend'],
  ['mc_build_camp', '在主人授权区内建造 3×3 营地，禁止覆盖', 'minecraft:build'],
  ['mc_prepare_camp', '按真实背包采集、合成并搭建营地，失败即停', 'minecraft:prepare'],
  ['mc_stop', '停止跟随、移动、采集、回程和建造并释放控制位', 'minecraft:stop'],
] as const
const WARDROBE_TOOL = ['mc_change_appearance', '从已授权的外观中为自己的角色换装', 'minecraft:appearance'] as const
const BILIBILI_TOOL = ['companion_bilibili_read', '读取指定 B 站视频的公开资料与一小段可用字幕', 'bilibili:read'] as const
const SINGING_TOOLS = [
  ['companion_singing_generate', '按主人明确请求生成歌唱任务，音频以归档回执为准', 'singing:generate'],
  ['companion_singing_cover', '翻唱本轮明确授权的一份 WAV 附件', 'singing:cover'],
  ['companion_singing_status', '查询同一歌唱会话的任务和归档状态', 'singing:read'],
  ['companion_singing_score', '按本轮明确请求，以给定旋律和中文歌词生成演唱', 'singing:score'],
  ['companion_singing_share', '按本轮主人明确指定的作品发布或撤下私有歌唱动态', 'singing:share'],
] as const

export const WORLD_DEFINITIONS = {
  minecraft: {
    id: 'minecraft', label: 'Minecraft', contextId: 'game.minecraft', kind: 'game', restricted: false, memory: true,
    actions: [...MINECRAFT_TOOLS, WARDROBE_TOOL],
  },
  bilibili: {
    id: 'bilibili', label: 'Bilibili', contextId: BILIBILI_CONTEXT, kind: 'topic', restricted: true, memory: true,
    actions: [BILIBILI_TOOL],
  },
  singing: {
    id: 'singing', label: 'Singing', contextId: SINGING_CONTEXT, kind: 'topic', restricted: true, memory: false,
    actions: SINGING_TOOLS,
  },
} as const satisfies Record<string, WorldDefinition>

const worlds = Object.values(WORLD_DEFINITIONS)

export const WORLD_ACTIONS = worlds.flatMap<WorldAction>(world => [...world.actions])

export function worldForContext(contextId: string): WorldDefinition | undefined {
  return worlds.find(world => world.contextId === contextId)
}

export function worldForBinding(binding: Pick<SessionBinding, 'contextId' | 'kind'>): WorldDefinition | undefined {
  const world = worldForContext(binding.contextId)
  if (world?.kind === binding.kind) return world
}

export function worldActions(world: WorldDefinition, wardrobeEnabled: boolean): readonly WorldAction[] {
  return world.id === 'minecraft' && !wardrobeEnabled
    ? world.actions.filter(([name]) => name !== WARDROBE_TOOL[0])
    : world.actions
}
