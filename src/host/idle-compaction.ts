import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CONTEXT_COMPACTION_CAPABILITY, IDLE_COMPACTION_MINUTES, IDLE_COMPACTION_PERCENT, type SessionBinding } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { compactIdleAgent, inspectIdleCompaction, type IdleCompactionCandidate } from './idle-compaction-native.ts'
import { retireStaleRecall } from './recall.ts'

const CHECK_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000

export class IdleCompactionService {
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private active?: { sessionId: string; controller: AbortController; pending: Promise<void> }

  constructor(
    private readonly store: CompanionStore,
    private readonly agentFor: (sessionId: string) => Agent | undefined,
    private readonly memoryReviewed: (contextId: string, sessionId: string, turnSeq: number) => boolean,
  ) {}

  start(): void {
    if (this.closed || this.timer) return
    for (const task of this.store.tasks(100, CONTEXT_COMPACTION_CAPABILITY)) {
      if (task.status === 'accepted' || task.status === 'running') {
        this.store.transitionTask(task.id, 'cancelled', '宿主重启，保留原会话日志并等待新回合')
      }
    }
    this.timer = setInterval(() => this.poll(), CHECK_INTERVAL_MS)
    this.timer.unref()
    this.poll()
  }

  private poll(): void {
    void this.tick().catch(() => {})
  }

  private enabled(): boolean {
    const settings = this.store.autonomy.settings()
    return settings.enabled && settings.memoryReview && settings.idleCompactionEnabled === true
  }

  policyChanged(): void {
    if (!this.enabled()) this.cancel()
  }

  observe(sessionId: string, event: SessionEvent): void {
    if (event.type === 'turn/start' || (event.type === 'user/message' && ['user', 'companion-mobile'].includes(event.data.source.kind)) ||
        (event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)) this.cancel(sessionId)
  }

  cancel(sessionId?: string): void {
    const active = this.active
    if (active && (!sessionId || sessionId === active.sessionId)) active.controller.abort()
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.closed || this.active || !this.enabled()) return
    for (const binding of this.store.bindings()) {
      if (!['chat', 'game', 'topic'].includes(binding.kind) || binding.contextId === 'memory.curator' ||
          binding.contextId.startsWith('autonomy.') || binding.contextId.startsWith('feed.reply.')) continue
      const agent = this.agentFor(binding.sessionId)
      if (!agent) continue
      const candidate = inspectIdleCompaction(agent)
      if (!candidate || now - candidate.endedAt < IDLE_COMPACTION_MINUTES * 60_000 ||
          candidate.inputTokens * 100 < candidate.contextWindow * IDLE_COMPACTION_PERCENT) continue
      const externalId = `${CONTEXT_COMPACTION_CAPABILITY}:${binding.sessionId}:${candidate.turnSeq}`
      if (this.store.taskByExternalId(externalId) || !this.memoryReviewed(binding.contextId, binding.sessionId, candidate.turnSeq)) continue
      const task = this.store.createTask({
        externalId, capabilityId: CONTEXT_COMPACTION_CAPABILITY, contextId: binding.contextId, sessionId: binding.sessionId,
        title: '闲置会话压缩',
      })
      const controller = new AbortController()
      const pending = Promise.resolve().then(() => this.run(task.id, binding, agent, candidate, controller.signal))
      this.active = { sessionId: binding.sessionId, controller, pending }
      try { await pending } finally { this.active = undefined }
      return
    }
  }

  private async run(taskId: string, binding: SessionBinding, agent: Agent, candidate: IdleCompactionCandidate, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.enabled() || this.store.bindingByContext(binding.contextId)?.sessionId !== binding.sessionId ||
        this.agentFor(binding.sessionId) !== agent || inspectIdleCompaction(agent)?.turnSeq !== candidate.turnSeq) {
      this.store.transitionTask(taskId, 'cancelled', '该场景已恢复活动或换绑')
      return
    }
    this.store.transitionTask(taskId, 'running')
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    let result: Awaited<ReturnType<typeof compactIdleAgent>>
    try {
      retireStaleRecall(agent.session, this.store, binding.contextId)
      result = await compactIdleAgent(agent, AbortSignal.any([signal, deadline]))
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (signal.aborted || code === 'busy' || code === 'cancelled' || code === 'changed') {
        this.store.transitionTask(taskId, 'cancelled', '会话恢复活动或上下文已变化')
      } else {
        this.store.transitionTask(taskId, 'failed', deadline.aborted ? '原生压缩超时' : '原生压缩未完成')
      }
      return
    }
    if (!result) {
      this.store.transitionTask(taskId, 'cancelled', signal.aborted ? '会话恢复活动' : '没有适合压缩的上下文范围')
      return
    }
    this.store.transitionTask(taskId, 'succeeded', undefined, () => {
      this.store.recordActivity({
        contextId: binding.contextId, sessionId: binding.sessionId, taskId, source: CONTEXT_COMPACTION_CAPABILITY,
        kind: 'session.compaction.completed', status: 'success', summary: 'DSH 已完成闲置会话压缩',
        data: { turnSeq: candidate.turnSeq, inputTokens: candidate.inputTokens, contextWindow: candidate.contextWindow, ...result },
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.cancel()
    await this.active?.pending.catch(() => {})
  }
}
