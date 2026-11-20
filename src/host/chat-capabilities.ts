import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CompanionStore } from '../core/store.ts'
import { HOUSE_DRAFT_TOOL, isMinecraftHouseRequest } from './minecraft-house-tool.ts'
import { createMinecraftHouseProjectTool, HOUSE_PROJECT_PLAN_TOOL, minecraftHouseProjectRequest,
  type HouseProjectPlanningHost } from './minecraft-house-project-tool.ts'
import { createVoxelBlueprintTool, VOXEL_BLUEPRINT_TOOL, voxelBlueprintRequest, type VoxelBlueprintPreparation } from './minecraft-voxel-tool.ts'

const CAPABILITIES = {
  read_feed: 'companion_feed_read',
  remember: 'companion_memory_remember',
  correct_memory: 'companion_memory_correct',
  forget_memory: 'companion_memory_forget',
  gesture: 'companion_avatar_action',
  stop_gesture: 'companion_avatar_stop',
  house_blueprint: HOUSE_DRAFT_TOOL,
  house_project_plan: HOUSE_PROJECT_PLAN_TOOL,
  voxel_blueprint: VOXEL_BLUEPRINT_TOOL,
} as const

type Capability = keyof typeof CAPABILITIES
export const CHAT_CAPABILITY_TOOL = 'companion_open_capability'
export const CHAT_DEFERRED_TOOLS: readonly string[] = Object.values(CAPABILITIES)
const IDS = Object.keys(CAPABILITIES) as Capability[]

interface ScopedOwnerTool {
  name: string
  calls: Map<string, string>
  nested: Map<string, string>
  step?: AbortController
}

interface ChatTurn {
  agent: Agent
  contextId: string
  turn: number
  step?: number
  claim?: UserMessage
  admitted?: true
  ambiguous?: true
  scoped?: ScopedOwnerTool
  opened: Map<Capability, () => void>
  dispose: (() => void)[]
}

function ownerInput(message: UserMessage): boolean {
  return message.source.kind === 'user' || message.source.kind === 'companion-mobile' && message.source.form === 'relay'
}

export function registerMobileChatEffort(ctx: Context, store: Pick<CompanionStore, 'bindingBySession'>): () => void {
  return ctx.on('agent/request', async ({ agent, signal }, next) => {
    const config = await next()
    const isMobileChat = () => {
      const binding = store.bindingBySession(agent.id)
      return binding?.kind === 'chat' && binding.contextId === 'chat.mobile' && ctx.agents.get(agent.id) === agent
    }
    if (signal.aborted || !/^deepseek(?:-|$)/iu.test(config.model) || !isMobileChat()) return config
    const model = await ctx.llm.resolveModelInfo(config.provider, config.model, signal).catch(() => undefined)
    const low = model?.reasoning?.efforts.find(effort => effort.id === 'low')?.id
    return low && !signal.aborted && isMobileChat() ? { ...config, reasoningEffort: low } : config
  })
}

export function registerChatCapabilities(ctx: Context, store: Pick<CompanionStore, 'bindingBySession'>,
  minecraft?: HouseProjectPlanningHost, voxelBlueprints?: VoxelBlueprintPreparation): () => void {
  const turns = new Map<Session, ChatTurn>()

  const ownsTurn = (turn: ChatTurn, agent?: Agent) => {
    if (agent !== turn.agent || turns.get(turn.agent.session) !== turn || ctx.agents.get(turn.agent.id) !== agent) return false
    const binding = store.bindingBySession(agent.id)
    return binding?.kind === 'chat' && binding.contextId === turn.contextId
  }
  const authorized = (turn: ChatTurn, agent?: Agent) => ownsTurn(turn, agent) && turn.admitted && !turn.ambiguous

  function close(session: Session) {
    const turn = turns.get(session)
    if (!turn) return
    turns.delete(session)
    turn.scoped?.step?.abort()
    for (const dispose of turn.opened.values()) dispose()
    for (const dispose of turn.dispose.reverse()) dispose()
  }

  function guardDispatch(turn: ChatTurn, name: string) {
    const scoped: ScopedOwnerTool = { name, calls: new Map(), nested: new Map() }
    turn.scoped = scoped
    return (exec: ToolRunContext) => {
      const step = scoped.step
      const matched = exec.parent
        ? scoped.nested.get(exec.callId) === exec.rootCallId && scoped.nested.delete(exec.callId)
        : exec.rootCallId === exec.callId && scoped.calls.get(exec.callId) === name && scoped.calls.delete(exec.callId)
      if (!step || !matched || !authorized(turn, exec.agent)) throw new Error('Capability requires a call in the current owner chat step')
      const signal = AbortSignal.any([exec.signal, step.signal])
      const assertCurrent = () => {
        signal.throwIfAborted()
        if (scoped.step !== step || !authorized(turn, exec.agent)) throw new Error('Capability requires a call in the current owner chat step')
      }
      assertCurrent()
      return { signal, assertCurrent }
    }
  }

  function open(turn: ChatTurn, capability: Capability): boolean {
    if (turn.opened.has(capability)) return true
    if (capability === 'house_project_plan') {
      const request = turn.claim && minecraftHouseProjectRequest(turn.claim)
      if (!minecraft || !request) return false
      const dispatch = guardDispatch(turn, HOUSE_PROJECT_PLAN_TOOL)
      const dispose = turn.agent.ctx.tools.register(createMinecraftHouseProjectTool(minecraft, exec => ({ request, ...dispatch(exec) })))
      turn.opened.set(capability, dispose)
      return true
    }
    if (capability === 'voxel_blueprint') {
      const request = turn.claim && voxelBlueprintRequest(turn.claim)
      const storage = ctx.get('attachments')
      if (!voxelBlueprints || !request || !storage) return false
      const scope = { contextId: turn.contextId, sessionId: turn.agent.id }
      const dispose = turn.agent.ctx.tools.register(createVoxelBlueprintTool(voxelBlueprints, storage, request, scope,
        guardDispatch(turn, VOXEL_BLUEPRINT_TOOL)))
      turn.opened.set(capability, dispose)
      return true
    }
    const definition = ctx.tools.get(CAPABILITIES[capability])
    if (!definition) return false
    // DSH filters inherited tools before adding this scope's registrations.
    // Use the original definition and dispatch path to retain validation,
    // tool receipts, PTC handling, and any capability-specific authority.
    const dispose = turn.agent.ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (!authorized(turn, exec.agent)) throw new Error('Capability requires the current owner chat turn')
        return definition.execute(args, exec)
      },
    })
    turn.opened.set(capability, dispose)
    return true
  }

  function begin(agent: Agent, contextId: string, number: number) {
    const turn: ChatTurn = { agent, contextId, turn: number, opened: new Map(), dispose: [] }
    turns.set(agent.session, turn)
    try {
      const deferred = CHAT_DEFERRED_TOOLS.filter(name => ctx.tools.get(name) !== undefined)
      if (deferred.length) turn.dispose.push(agent.ctx.tools.restrict({ deny: deferred }))
      turn.dispose.push(agent.ctx.tools.register(defineTool({
        name: CHAT_CAPABILITY_TOOL,
        description: 'Open a capability in this chat turn. Use read_feed for timeline posts, remember/correct_memory/forget_memory for long-term memory, gesture/stop_gesture for Live2D, house_blueprint for a Minecraft house, house_project_plan to plan the next Minecraft section, or voxel_blueprint to convert an attached .vox file. Then call the available tool.',
        parameters: { capability: { type: 'string', enum: IDS, required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute({ capability }, exec) {
          exec.signal.throwIfAborted()
          if (!authorized(turn, exec.agent)) throw new Error('Capability requires the current owner chat turn')
          const id = capability as Capability
          if (id === 'house_blueprint' && !isMinecraftHouseRequest(turn.claim!)) return 'Send an explicit Minecraft house request with at most one reference image.'
          if (id === 'house_project_plan' && !minecraftHouseProjectRequest(turn.claim!)) {
            return 'Send an explicit project planning request, such as 请帮我选 Minecraft 建筑工程的下一段.'
          }
          if (id === 'voxel_blueprint' && !voxelBlueprintRequest(turn.claim!)) return 'Attach a .vox file to the same message asking to convert it to a Minecraft blueprint.'
          const name = CAPABILITIES[id]
          if (turn.opened.has(id)) return `${name} is already available in this turn. Use it directly.`
          return open(turn, id) ? `${name} is available for the remainder of this turn.` : `${name} is unavailable on this host.`
        },
      })))
    } catch (error) {
      close(agent.session)
      ctx.logger.warn('Companion could not scope chat capabilities', error)
    }
  }

  const stopEvents = ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      close(session)
      const agent = ctx.agents.get(session.id)
      const binding = store.bindingBySession(session.id)
      if (agent?.session === session && binding?.kind === 'chat' && session.header.origin !== 'subagent' && !(session.header.delegationDepth ?? 0)) {
        begin(agent, binding.contextId, event.data.turn)
      }
      return
    }
    const turn = turns.get(session)
    if (!turn) return
    if (event.type === 'turn/end' && event.data.turn === turn.turn) {
      close(session)
      return
    }
    const scoped = turn.scoped
    if (event.type === 'step/start' && event.data.turn === turn.turn) {
      turn.step = event.data.step
      if (scoped) {
        scoped.step?.abort()
        scoped.calls.clear()
        scoped.nested.clear()
        scoped.step = new AbortController()
      }
    }
    if (event.type === 'step/end' && event.data.turn === turn.turn && event.data.step === turn.step && scoped) {
      scoped.step?.abort()
      scoped.step = undefined
      scoped.calls.clear()
      scoped.nested.clear()
    }
    if (event.type === 'user/message' && isAppendSurfaceEvent(event) && ownerInput(event.data)) {
      const claim = turn.claim
      if (!turn.admitted && !turn.ambiguous && turn.step === 1 && !scoped?.calls.size && claim?.id === event.data.id &&
          isDeepStrictEqual(claim.content, event.data.content) && isDeepStrictEqual(claim.source, event.data.source)) {
        turn.admitted = true
      } else {
        turn.ambiguous = true
        scoped?.step?.abort()
      }
    }
    if (scoped?.step && event.type === 'tool/call' && event.data.turn === turn.turn && event.data.step === turn.step) {
      scoped.calls.set(event.data.callId, event.data.name)
    }
    if (scoped?.step && event.type === 'tool/ptc-dispatch-start' && event.data.name === scoped.name &&
        scoped.calls.get(event.data.rootCallId) === 'run_code') {
      scoped.nested.set(event.data.subCallId, event.data.rootCallId)
    }
  })
  const stopClaims = ctx.on('agent/inbox/claimed', ({ agent, message, turn: number }) => {
    const turn = turns.get(agent.session)
    if (!turn || turn.turn !== number || !ownsTurn(turn, agent) || !ownerInput(message)) return
    if (turn.claim || turn.step !== undefined) {
      turn.ambiguous = true
      turn.scoped?.step?.abort()
      return
    }
    turn.claim = message
    if (message.content.some(block => block.type === 'text' &&
        /动态|朋友圈|时间线|timeline|\b(?:feed|posts?|comments?)\b/iu.test(block.text))) open(turn, 'read_feed')
    if (isMinecraftHouseRequest(message)) open(turn, 'house_blueprint')
    if (minecraftHouseProjectRequest(message)) open(turn, 'house_project_plan')
    if (voxelBlueprintRequest(message)) open(turn, 'voxel_blueprint')
  })
  const stopDisposed = ctx.on('session/disposed', close)
  return () => {
    stopDisposed()
    stopClaims()
    stopEvents()
    for (const session of turns.keys()) close(session)
  }
}
