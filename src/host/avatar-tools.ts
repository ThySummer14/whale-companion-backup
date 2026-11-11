import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AVATAR_ACTIONS } from '../core/model.ts'
import type { CompanionRuntime } from './runtime.ts'

const output = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

export function registerAvatarTools(ctx: Context, runtime: CompanionRuntime): () => void {
  const authority = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    const binding = agent && runtime.store.bindingBySession(agent.id)
    if (!agent || !binding || !['chat', 'game', 'topic'].includes(binding.kind)) throw new Error('Avatar actions require a registered chat, game or topic session')
    if (binding.contextId === 'memory.curator' || binding.contextId === 'autonomy.feed' || binding.contextId.startsWith('feed.reply.')) throw new Error('Avatar actions are not available in this internal context')
    return binding
  }
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'companion_avatar_action',
      description: 'Request a brief expression or gesture on the live Live2D stage. accepted means queued for the stage. The later stage receipt records whether it played or completed.',
      parameters: { action: { type: 'string', enum: AVATAR_ACTIONS, description: 'blush: blush; point: point with a hand; nod: nod once; shake: briefly shake the head.', required: true } }, output,
      async execute(args, exec) {
        authority(exec)
        const result = runtime.avatar.startAction(args.action)
        return JSON.stringify({ status: 'accepted', ...result })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'companion_avatar_stop',
      description: 'Request the real Live2D stage to stop the current gesture. This is only a stop request; cancellation is confirmed by the stage receipt.',
      parameters: { taskId: { type: 'string', description: 'Optional task ID returned by companion_avatar_action.' } }, output,
      async execute(args, exec) {
        authority(exec)
        const view = runtime.avatar.stop(args.taskId)
        return JSON.stringify({ status: 'stop-requested', stopRequestIds: view.stopRequestIds })
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
