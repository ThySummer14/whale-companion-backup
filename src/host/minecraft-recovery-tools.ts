import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MINECRAFT_RECOVERY_CONTEXT } from '../core/model.ts'
import { HouseRecoveryPlan } from '../core/minecraft-recovery.ts'
import { MinecraftHouseCellIndex } from '../core/minecraft-house-cell.ts'
import type { CompanionRuntime } from './runtime.ts'

export const HOUSE_RECOVERY_OBSERVE_TOOL = 'mc_recovery_observe'
export const HOUSE_RECOVERY_PLAN_TOOL = 'mc_recovery_plan'
export const HOUSE_RECOVERY_CANDIDATES_TOOL = 'mc_recovery_candidates'
export const HOUSE_RECOVERY_PLACE_TOOL = 'mc_recovery_place'
export const HOUSE_RECOVERY_VERIFY_TOOL = 'mc_recovery_verify'
export function isMinecraftRecoveryTool(name: string): boolean {
  return [HOUSE_RECOVERY_OBSERVE_TOOL, HOUSE_RECOVERY_PLAN_TOOL, HOUSE_RECOVERY_CANDIDATES_TOOL, HOUSE_RECOVERY_PLACE_TOOL, HOUSE_RECOVERY_VERIFY_TOOL].includes(name)
}

export function registerMinecraftRecoveryTools(ctx: Context, runtime: CompanionRuntime): () => void {
  const liveRecoverySession = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent
    const binding = agent && runtime.store.bindingBySession(agent.id)
    if (!agent || binding?.contextId !== MINECRAFT_RECOVERY_CONTEXT || binding.kind !== 'system' || ctx.agents.get(agent.id) !== agent ||
      agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
      throw new Error('Recovery tools require the current private recovery session')
    }
    return binding.sessionId
  }
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const observe = ctx.tools.register(defineTool({
    name: HOUSE_RECOVERY_OBSERVE_TOOL,
    description: 'Read the current authorized interrupted Minecraft site once. Returns actual preflight and any verified materials shortage. Does not move the character or issue construction approval.',
    parameters: {}, output,
    async execute(_args, exec) {
      return JSON.stringify(await runtime.autonomy.observeHouseRecovery(liveRecoverySession(exec), exec.signal))
    },
  }))
  const plan = ctx.tools.register(defineTool({
    name: HOUSE_RECOVERY_PLAN_TOOL,
    description: 'Leave a short private workbench plan for the next step after an interrupted Minecraft build. Explain what you would try and what real evidence supports it. This records a proposal, without modifying the world.',
    parameters: { plan: { type: 'string', required: true, description: 'One line, 6 to 240 characters. Use only what you know about this site.' } }, output,
    async execute({ plan }, exec) {
      const id = liveRecoverySession(exec)
      const value = HouseRecoveryPlan.safeParse(plan)
      if (!value.success) throw new ToolArgsError(['plan: use one line with 6 to 240 characters'])
      await runtime.autonomy.planHouseRecovery(id, value.data, exec.signal)
      return JSON.stringify({ pendingReview: true })
    },
  }))
  const candidates = ctx.tools.register(defineTool({
    name: HOUSE_RECOVERY_CANDIDATES_TOOL,
    description: 'Read which non-air blueprint cells are currently empty, with the character’s verified stock if available. Coordinates and indices are relative to the blueprint. Empty cells may still lack a safe stance or material.',
    parameters: {}, output,
    async execute(_args, exec) {
      return JSON.stringify(await runtime.autonomy.candidatesForHouseRecovery(liveRecoverySession(exec), exec.signal))
    },
  }))
  const place = ctx.tools.register(defineTool({
    name: HOUSE_RECOVERY_PLACE_TOOL,
    description: 'Try placing one authorized blueprint cell using its zero-based index. The game checks the real cell and inventory, uses survival placement and verifies the return. A blocked or already-present result consumes nothing. The turn prompt sets the placement and attempt limits.',
    parameters: { index: { type: 'integer', required: true, description: 'Blueprint cell index from 0 to 124. It must point to an actual non-air blueprint cell.' } }, output,
    async execute({ index }, exec) {
      const parsed = MinecraftHouseCellIndex.safeParse(index)
      if (!parsed.success) throw new ToolArgsError(['index: use an integer from 0 to 124'])
      return JSON.stringify(await runtime.autonomy.placeHouseRecoveryCell(liveRecoverySession(exec), parsed.data, exec.signal))
    },
  }))
  const verify = ctx.tools.register(defineTool({
    name: HOUSE_RECOVERY_VERIFY_TOOL,
    description: 'Verify the entire authorized house after a confirmed placement in this continuous recovery turn. Checks both intended blocks and reserved air without moving the character or placing anything. Only a completed result records the house as complete. If incomplete, use the reported issues to decide what to do next.',
    parameters: {}, output,
    async execute(_args, exec) {
      return JSON.stringify(await runtime.autonomy.verifyHouseRecovery(liveRecoverySession(exec), exec.signal))
    },
  }))
  return () => { observe(); plan(); candidates(); place(); verify() }
}
