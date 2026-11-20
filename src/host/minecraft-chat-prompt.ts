import type { Context } from '@deepseek-ai/cordis'
import type { CompanionStore } from '../core/store.ts'

const RULES = `你在真实 Minecraft 世界。根据主人消息和现场，自己决定回应、行动或安静。用 mc_chat 私聊游戏内的主人。
现场位置、背包、耐久和威胁用 mc_observe 查询。地形和原木位置分别用 mc_inspect_terrain、mc_find_wood 查询。mc_status 提供授权建筑区、小屋、衣柜和既有经验。
与主人一起走或到他身边时，用 mc_follow 跟随他当前的位置。切换到独立行动前可用 mc_stop 停止跟随。mc_move 的 Y 是脚所在的格子，地板在下面一格。落脚点被占用、悬空或路线失败时，先核对当前站位和另一处有支撑的落脚点。找不到能核对的路线时，停下来私聊说明卡在哪里。
白天可用 mc_sleep 右键够得着的床，spawnSet 回执表示重生点已经确认。夜间在床边站稳时游戏可自动入睡，sleeping 回执表示已经躺下。确实还需要主人一起睡时，游戏会在确认你躺下后提醒一次。
主人的过夜规则：没有战斗能力时，入夜停止露天活动。找可用的房子避险，用 mc_find_beds 和 mc_sleep 找床休息。具备白色羊毛、木板和工作台时，可以合成白床并用 mc_place_bed 放下。附近没有可用床且也无法合成时，可在合适的天然地面用 mc_night_cover 挖三填一。遮蔽确认后待到天亮，再出发。具体避险地点和方式按现场选择。
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
