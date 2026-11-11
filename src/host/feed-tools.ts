import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CompanionRuntime } from './runtime.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'

const output = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

export function registerFeedTools(ctx: Context, runtime: CompanionRuntime): () => void {
  const store = runtime.store
  const authority = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    if (!agent) throw new Error('Companion feed requires a registered DSH session')
    const binding = store.bindingBySession(agent.id)
    if (!binding) throw new Error('This DSH session is not registered as a Companion context')
    if (binding.contextId === 'memory.curator' || isFeedReplyContext(binding.contextId)) throw new Error('Private evaluations cannot access feed tools')
    return { agent, binding }
  }
  const readFor = (contextId: string, id?: string, limit?: number) => {
    if (contextId === 'autonomy.feed' && id) throw new Error('Autonomous feed review can only read the timeline')
    return id ? store.feed.get(id) : store.feed.list({ limit: Math.max(1, Math.min(20, Math.floor(limit ?? 10))) })
  }
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'companion_feed_read',
      description: 'Read real posts from the shared Companion timeline. Use post ids from this result when replying. Do not invent posts, activities, or replies that are not present.',
      parameters: {
        id: { type: 'string', description: 'Optional real post id to read with its replies.' },
        limit: { type: 'number', description: 'Maximum recent top-level posts, from 1 to 20. Default 10.' },
      },
      output,
      async execute(args, exec) {
        const { binding } = authority(exec)
        return JSON.stringify(readFor(binding.contextId, args.id), null, 2)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'companion_post_create',
      description: 'Publish a genuine short thought, current activity, or reply to a real timeline post as the companion. Never use this for private conversation and never invent real-world experiences, completed actions, or feelings.',
      parameters: {
        body: { type: 'string', description: 'Text of the post or reply, 1 to 4000 characters.', required: true },
        parentId: { type: 'string', description: 'Optional real top-level post id to reply to, obtained from companion_feed_read.' },
      },
      output,
      async execute(args, exec) {
        const { agent, binding } = authority(exec)
        if (binding.contextId === 'autonomy.feed' && args.parentId) throw new Error('Autonomous feed review cannot reply to a thread')
        return JSON.stringify(await runtime.publishPost({
          body: args.body,
          author: 'companion',
          parentId: args.parentId,
          contextId: binding.contextId,
          sourceSessionId: agent.id,
        }), null, 2)
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
