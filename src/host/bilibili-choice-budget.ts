import type { Context } from '@deepseek-ai/cordis'
import { BILIBILI_AUTONOMY_CONTEXT } from '../core/model.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'
import type { CompanionStore } from '../core/store.ts'

const MAX_CHOICE_OUTPUT_TOKENS = 192
const MAX_FEED_REPLY_OUTPUT_TOKENS = 512

export function registerBilibiliChoiceBudget(ctx: Context, store: CompanionStore): () => void {
  return registerDecisionBudget(ctx, store, id => id === BILIBILI_AUTONOMY_CONTEXT, MAX_CHOICE_OUTPUT_TOKENS)
}

export function registerFeedReplyBudget(ctx: Context, store: CompanionStore): () => void {
  return registerDecisionBudget(ctx, store, isFeedReplyContext, MAX_FEED_REPLY_OUTPUT_TOKENS)
}

function registerDecisionBudget(ctx: Context, store: CompanionStore, matches: (contextId: string) => boolean, maxTokens: number): () => void {
  return ctx.on('agent/request', async ({ agent, step, signal }, next) => {
    const config = await next()
    if (step !== 1 || signal.aborted) return config
    const isChoice = () => {
      const binding = store.bindingBySession(agent.id)
      return binding?.kind === 'system' && matches(binding.contextId) && ctx.agents.get(agent.id) === agent &&
        agent.session.header.origin !== 'subagent' && !(agent.session.header.delegationDepth && agent.session.header.delegationDepth > 0)
    }
    if (!isChoice()) return config
    const model = await ctx.llm.resolveModelInfo(config.provider, config.model, signal).catch(() => undefined)
    if (!model || signal.aborted || !isChoice()) return config
    const off = model.reasoning?.efforts.find(effort => effort.id === 'off')?.id
    if (!off && (model.reasoning || config.reasoningEffort)) return config
    return { ...config, ...(off && { reasoningEffort: off }), maxTokens: Math.min(config.maxTokens ?? model.defaultMaxTokens ?? Infinity, maxTokens) }
  })
}
