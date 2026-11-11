import type { Context } from '@deepseek-ai/cordis'
import type { CompanionStore } from '../core/store.ts'

const RULES = `你在真实 Minecraft 世界。根据主人消息和现场，自己决定回应、行动或安静。用 mc_chat 私聊游戏内的主人。
现场位置、背包、耐久和威胁用 mc_observe 查询；连接、授权建筑区、衣柜和已经验证的经验可按项用 mc_status 查询。
举盾、反击、避险与进食由 Worker 的低延迟反射处理。尊重当前权限与工具的范围、材料和超时，以实际回读确认动作结果。`

export function registerMinecraftChatPrompt(ctx: Context, store: Pick<CompanionStore, 'bindingBySession'>): () => void {
  return ctx.systemPrompt.section({
    name: 'companion.minecraft-chat',
    order: 15,
    interpolate: false,
    text({ agent }) {
      if (!agent || ctx.agents.get(agent.id) !== agent || agent.session.header.origin === 'subagent' ||
          (agent.session.header.delegationDepth ?? 0) > 0) return ''
      const binding = store.bindingBySession(agent.id)
      return binding?.contextId === 'game.minecraft' && binding.kind === 'game' ? RULES : ''
    },
  })
}
