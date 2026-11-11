import type { Context } from '@deepseek-ai/cordis'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_REFLECTION_CONTEXT, BILIBILI_SHARE_CONTEXT, DAILY_AUTONOMY_CONTEXT, DAILY_REFLECTION_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT, MINECRAFT_SHARE_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, type ContextKind } from '../core/model.ts'
import { WORLD_ACTIONS, worldActions, worldForBinding } from './world-manifest.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'
import { DAILY_INITIATIVE_OBSERVE_TOOL, DAILY_INITIATIVE_PROPOSE_TOOL } from './daily-initiative-tools.ts'
import { HOUSE_DRAFT_TOOL } from './minecraft-house-tool.ts'
import { HOUSE_PROJECT_PLAN_TOOL } from './minecraft-house-project-tool.ts'
import { CHAT_CAPABILITY_TOOL, CHAT_DEFERRED_TOOLS } from './chat-capabilities.ts'
import { HOUSE_RECOVERY_CANDIDATES_TOOL, HOUSE_RECOVERY_OBSERVE_TOOL, HOUSE_RECOVERY_PLACE_TOOL, HOUSE_RECOVERY_PLAN_TOOL, HOUSE_RECOVERY_VERIFY_TOOL } from './minecraft-recovery-tools.ts'

const MEMORY_TOOLS = [
  ['companion_memory_search', '检索当前场景及已共享的长期记忆', 'memory:read'],
  ['companion_memory_remember', '保存紧凑的长期事实', 'memory:write'],
  ['companion_memory_correct', '纠正有权限访问的记忆', 'memory:write'],
  ['companion_memory_forget', '遗忘有权限访问的记忆', 'memory:write'],
] as const
const FEED_TOOLS = [
  ['companion_feed_read', '读取授权范围内的真实动态', 'feed:read'],
  ['companion_post_create', '发布或回复授权范围内的动态', 'feed:write'],
] as const
const AVATAR_TOOLS = [
  ['companion_avatar_action', '在真实舞台请求脸红或抬手，完成以回执为准', 'avatar:action'],
  ['companion_avatar_stop', '停止当前形象动作并等待取消回执', 'avatar:stop'],
] as const
const HOUSE_TOOL = [HOUSE_DRAFT_TOOL, '从本轮主人文字或单张参考图拟定私有小屋蓝图', 'minecraft:house-draft'] as const
const HOUSE_PROJECT_TOOL = [HOUSE_PROJECT_PLAN_TOOL, '按当前工地预检和缺料提出私有下一段施工建议', 'minecraft:project-plan'] as const
const RECOVERY_TOOLS = [
  [HOUSE_RECOVERY_OBSERVE_TOOL, '核对当前已授权的中断施工现场和缺料', 'minecraft:read'],
  [HOUSE_RECOVERY_PLAN_TOOL, '为当前中断任务记录一份私有下一步方案', 'minecraft:recovery-plan'],
] as const
const RECOVERY_PLACEMENT_TOOLS = [
  [HOUSE_RECOVERY_CANDIDATES_TOOL, '只读列出当前蓝图里的空格', 'minecraft:read'],
  [HOUSE_RECOVERY_PLACE_TOOL, '选一格授权蓝图位置，在游戏内核验单次放置', 'minecraft:house-cell'],
] as const
const RECOVERY_VERIFY_TOOL = [HOUSE_RECOVERY_VERIFY_TOOL, '只读核对全部蓝图位置，匹配后登记真实完工', 'minecraft:house-verify'] as const
const INITIATIVE_TOOLS = [
  [DAILY_INITIATIVE_OBSERVE_TOOL, '查看这次自主活动可用的证据和选项', 'initiative:read'],
  [DAILY_INITIATIVE_PROPOSE_TOOL, '根据本次证据提出自己想做的事', 'initiative:propose'],
] as const
const ALL_TOOLS = [...MEMORY_TOOLS, ...FEED_TOOLS, ...WORLD_ACTIONS, HOUSE_TOOL, HOUSE_PROJECT_TOOL, ...RECOVERY_TOOLS, ...RECOVERY_PLACEMENT_TOOLS, RECOVERY_VERIFY_TOOL, ...INITIATIVE_TOOLS, ...AVATAR_TOOLS]

export function isMinecraftDecisionContext(contextId: string): boolean {
  return contextId === MINECRAFT_SHARE_CONTEXT || contextId === MINECRAFT_SUPPLY_CONTEXT || contextId === MINECRAFT_RECOVERY_CONTEXT
}

export function isCompanionDecisionContext(contextId: string): boolean {
  return isFeedReplyContext(contextId) || isMinecraftDecisionContext(contextId) || contextId === BILIBILI_AUTONOMY_CONTEXT || contextId === BILIBILI_CLIP_CONTEXT ||
    contextId === BILIBILI_REFLECTION_CONTEXT || contextId === BILIBILI_SHARE_CONTEXT || contextId === DAILY_AUTONOMY_CONTEXT ||
    contextId === DAILY_REFLECTION_CONTEXT || contextId === DAILY_VISIT_CONTEXT
}

export function companionToolPolicy(contextId: string, kind: ContextKind, wardrobeEnabled = true, recoveryPlacement = false, recoveryCompletion = false, dailyInitiative = false) {
  const internal = contextId === 'memory.curator' || isCompanionDecisionContext(contextId)
  const feed = contextId === 'autonomy.feed'
  const world = worldForBinding({ contextId, kind })
  const memory = !internal && !feed && (kind === 'chat' || kind === 'game' || kind === 'topic')
  const recovery = contextId === MINECRAFT_RECOVERY_CONTEXT && kind === 'system'
  const initiative = contextId === DAILY_AUTONOMY_CONTEXT && kind === 'system' && dailyInitiative
  const actions = world ? worldActions(world, wardrobeEnabled) : []
  const allowed = recovery ? [...RECOVERY_TOOLS, ...(recoveryPlacement ? RECOVERY_PLACEMENT_TOOLS : []),
    ...(recoveryPlacement && recoveryCompletion ? [RECOVERY_VERIFY_TOOL] : [])] : initiative ? INITIATIVE_TOOLS : internal ? [] : feed ? FEED_TOOLS
    : world?.restricted ? [...(world.memory ? MEMORY_TOOLS : []), ...actions]
    : memory ? [...MEMORY_TOOLS, ...AVATAR_TOOLS, ...actions, ...(kind === 'chat' ? [HOUSE_TOOL, HOUSE_PROJECT_TOOL] : [])] : []
  const denied = ALL_TOOLS.filter(([name]) => !allowed.some(([visible]) => visible === name)).map(([name]) => name)
  const deferred = kind === 'chat' && memory ? CHAT_DEFERRED_TOOLS : []
  return {
    contextId,
    profile: recovery ? 'minecraft-recovery' : initiative ? 'daily-initiative' : contextId === DAILY_VISIT_CONTEXT ? 'daily-visit-plan' : contextId === DAILY_REFLECTION_CONTEXT ? 'daily-reflection' : contextId === DAILY_AUTONOMY_CONTEXT ? 'daily-choice' : contextId === BILIBILI_SHARE_CONTEXT ? 'bilibili-share' : contextId === BILIBILI_REFLECTION_CONTEXT ? 'bilibili-reflection' : contextId === BILIBILI_AUTONOMY_CONTEXT ? 'bilibili-review' : contextId === MINECRAFT_SHARE_CONTEXT ? 'minecraft-share' : contextId === MINECRAFT_SUPPLY_CONTEXT ? 'minecraft-supply' : isFeedReplyContext(contextId) ? 'feed-reply' : internal ? 'memory-curator' : feed ? 'feed-autonomy' : world ? `${world.id}-world` : memory ? 'scene-memory' : 'no-companion-tools',
    allowed: allowed.map(([name, summary, permission]) => ({ name, summary, permission })),
    ...(deferred.length && { onDemand: { entry: CHAT_CAPABILITY_TOOL, tools: deferred } }),
    denied,
  }
}

export function restrictCompanionTools(ctx: Context, contextId: string, kind: ContextKind, recoveryPlacement = false, recoveryCompletion = false, dailyInitiative = false): void {
  if (kind === 'system' && (contextId === MINECRAFT_RECOVERY_CONTEXT || contextId === DAILY_AUTONOMY_CONTEXT && dailyInitiative)) {
    ctx.effect(() => ctx.tools.presentAs('native'))
    const tools = companionToolPolicy(contextId, kind, true, recoveryPlacement, recoveryCompletion, dailyInitiative).allowed
    ctx.effect(() => ctx.tools.restrict({ allow: tools.map(({ name }) => name).filter(name => ctx.tools.get(name) !== undefined) }))
    return
  }
  if (contextId === 'memory.curator' || isCompanionDecisionContext(contextId)) {
    ctx.effect(() => ctx.tools.restrict({ allow: [] }))
    return
  }
  const policy = companionToolPolicy(contextId, kind)
  // DSH rejects unknown names. Optional tools only register on configured hosts.
  if (policy.profile === 'feed-autonomy' || worldForBinding({ contextId, kind })?.restricted) {
    ctx.effect(() => ctx.tools.restrict({ allow: policy.allowed.map(({ name }) => name).filter(name => ctx.tools.get(name) !== undefined) }))
    return
  }
  const deny = policy.denied.filter(name => ctx.tools.get(name) !== undefined)
  if (deny.length) ctx.effect(() => ctx.tools.restrict({ deny }))
}
