import type { Context } from '@deepseek-ai/cordis'
import type { CompanionStore } from '../core/store.ts'
import { SELF_NOTE_TRAIT_LABELS } from '../core/model.ts'
import { isCompanionDecisionContext } from './tool-policy.ts'
import { canRecallSelfNotes } from './recall.ts'

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…'
}

export function registerPersonaPrompt(ctx: Context, store: Pick<CompanionStore, 'persona' | 'bindingBySession' | 'selfNotes'>): () => void {
  return ctx.systemPrompt.section({
    name: 'companion.persona',
    order: 10,
    interpolate: false,
    text({ agent }) {
      if (!agent || ctx.agents.get(agent.id) !== agent || agent.session.header.origin === 'subagent' ||
          (agent.session.header.delegationDepth ?? 0) > 0) return ''
      const binding = store.bindingBySession(agent.id)
      if (!binding || !['chat', 'game', 'topic'].includes(binding.kind) || binding.contextId === 'memory.curator' ||
          isCompanionDecisionContext(binding.contextId)) return ''
      const { version, name, tagline, description } = store.persona()
      const trait = canRecallSelfNotes(binding) ? store.selfNotes.recallCandidates(binding.contextId).find(note => note.trait)?.trait : undefined
      const behavior = trait ? `\n当前自我观察（可调整）：${SELF_NOTE_TRAIT_LABELS[trait]}` : ''
      return `当前角色档案（第 ${version} 版）\n角色身份：${excerpt(name, 80)}｜${excerpt(tagline, 160)}\n${excerpt(description, 900)}\n以当前档案表达角色。自我观察可以随经历调整，工具与世界权限由宿主规则决定。${behavior}`
    },
  })
}
