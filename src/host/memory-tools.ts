import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CompanionStore } from '../core/store.ts'
import type { MemoryKind, MemoryScope, SessionBinding } from '../core/model.ts'

const KINDS = ['user-fact', 'preference', 'experience', 'event', 'goal', 'relationship', 'other'] as const
const output = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

export function registerMemoryTools(ctx: Context, store: CompanionStore): () => void {
  const authority = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    if (!agent) throw new Error('Companion memory requires a registered DSH session')
    const binding = store.bindingBySession(agent.id)
    if (!binding) throw new Error('This DSH session is not registered as a Companion context')
    return { agent, binding }
  }
  const authorizeMemory = (id: string, binding: SessionBinding) => {
    const memory = store.memory.get(id)
    if (!memory) throw new Error('Memory not found')
    if (memory.scope === 'context' && memory.contextId !== binding.contextId) throw new Error('This memory is private to another context')
    return memory
  }
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'companion_memory_search',
      description: 'Search the character\'s central long-term memory. Use only relevant active memories instead of replaying old sessions. Results are scoped to this context plus explicitly shared memories.',
      parameters: {
        query: { type: 'string', description: 'Keywords or a short phrase to recall.', required: true },
        limit: { type: 'number', description: 'Maximum results, from 1 to 6. Default 4.' },
        includeCandidates: { type: 'boolean', description: 'Include unconfirmed candidate memories, never forgotten ones. Default false.' },
      },
      output,
      async execute(args, exec) {
        const { binding } = authority(exec)
        if (binding.contextId === 'memory.curator') throw new Error('Memory curator output must be validated by the host')
        return JSON.stringify(store.memory.search(args.query, {
          status: args.includeCandidates ? 'active+candidate' : 'active',
          contextId: binding.contextId,
          limit: Math.max(1, Math.min(6, args.limit ?? 4)),
        }), null, 2)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'companion_memory_remember',
      description: 'Store a durable fact in central memory. Do not store secrets, raw transcripts or temporary task details. Confidence below 0.8 creates a candidate. Default visibility is this context only; choose shared only when the fact should be available to other scenes.',
      parameters: {
        kind: { type: 'string', enum: KINDS, description: 'Memory category.', required: true },
        content: { type: 'string', description: 'A compact durable fact, not a chat transcript.', required: true },
        importance: { type: 'number', description: 'Importance from 0 to 1. Default 0.5.' },
        confidence: { type: 'number', description: 'Confidence from 0 to 1. Default 0.7; below 0.8 is a candidate.' },
        scope: { type: 'string', enum: ['shared', 'context'], description: 'shared allows recall in other scenes; context keeps it in this scene.' },
      },
      output,
      async execute(args, exec) {
        const { agent, binding } = authority(exec)
        if (binding.contextId === 'memory.curator') throw new Error('Memory curator output must be validated by the host')
        return JSON.stringify(store.memory.create({
          kind: args.kind as MemoryKind,
          content: args.content,
          importance: args.importance,
          confidence: args.confidence,
          scope: args.scope as MemoryScope | undefined,
          contextId: binding.contextId,
          sourceRefs: [{ sessionId: agent.id, contextId: binding.contextId }],
          actorSessionId: agent.id,
          reason: `remember:${binding.contextId}`,
        }), null, 2)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'companion_memory_correct',
      description: 'Correct an existing central memory by id, preserving previous content in revision history. Context-private memories can only be changed in their owning context.',
      parameters: {
        id: { type: 'string', description: 'Memory id.', required: true },
        content: { type: 'string', description: 'Corrected memory content.' },
        importance: { type: 'number', description: 'Replacement importance from 0 to 1.' },
        confidence: { type: 'number', description: 'Replacement confidence from 0 to 1.' },
        reason: { type: 'string', description: 'Why this correction is needed.' },
      },
      output,
      async execute(args, exec) {
        const { agent, binding } = authority(exec)
        authorizeMemory(args.id, binding)
        if (binding.contextId === 'memory.curator') throw new Error('Memory curator output must be validated by the host')
        return JSON.stringify(store.memory.update(args.id, {
          content: args.content,
          importance: args.importance,
          confidence: args.confidence,
          sourceRefs: [{ sessionId: agent.id, contextId: binding.contextId }],
          actorSessionId: agent.id,
          reason: args.reason ?? `correct:${binding.contextId}`,
        }), null, 2)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'companion_memory_forget',
      description: 'Forget a central memory by id. The content is hidden from recall but retained as a restorable tombstone in revision history. Context-private memories can only be forgotten in their owning context.',
      parameters: {
        id: { type: 'string', description: 'Memory id.', required: true },
        reason: { type: 'string', description: 'Why the memory should be forgotten.' },
      },
      output,
      async execute(args, exec) {
        const { agent, binding } = authority(exec)
        authorizeMemory(args.id, binding)
        if (binding.contextId === 'memory.curator') throw new Error('Memory curator output must be validated by the host')
        const memory = store.memory.update(args.id, {
          status: 'forgotten',
          sourceRefs: [{ sessionId: agent.id, contextId: binding.contextId }],
          actorSessionId: agent.id,
          reason: args.reason ?? `forget:${binding.contextId}`,
        })
        return JSON.stringify({ id: memory.id, status: memory.status })
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
