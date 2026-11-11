import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

const MAX_EVENTS = 4096

export interface IdleCompactionCandidate {
  turnSeq: number
  endedAt: number
  inputTokens: number
  contextWindow: number
}

interface NativeReceipt {
  compactionId: string
  shadowedTokenCount: number
}

interface NativeCompaction {
  compactNow(agent: Agent, signal: AbortSignal): Promise<NativeReceipt | null>
}

function nativeCompaction(agent: Agent): NativeCompaction | undefined {
  const service: unknown = agent.ctx.get('compaction')
  if (service && typeof service === 'object' && 'compactNow' in service && typeof service.compactNow === 'function') {
    return service as NativeCompaction
  }
}

function supersedesUsage({ type, data }: { type: string; data: unknown }): boolean {
  if (!data || typeof data !== 'object') return false
  if (type === 'compaction/end') {
    return 'compactionId' in data && typeof data.compactionId === 'string' && (!('error' in data) || data.error === undefined)
  }
  if (type !== 'user/message' || !('source' in data) || !data.source || typeof data.source !== 'object') return false
  return 'kind' in data.source && data.source.kind === 'compact-checkpoint'
}

export function inspectIdleCompaction(agent: Agent): IdleCompactionCandidate | undefined {
  if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || !nativeCompaction(agent)) return
  const { session } = agent
  // rc.5 exposes a bounded snapshot for a live Session. Avoid scanning the
  // entire archive on every poll, and require a complete locally owned turn.
  const events = session.snapshotEvents(SessionLogOffset(Math.max(session.inheritedEventCount, session.seq - MAX_EVENTS)))
  const endIndex = events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const end = events[endIndex]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || !Number.isFinite(end.time)) return
  const turn = events.slice(0, endIndex)
  const startIndex = turn.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const start = turn[startIndex]
  if (start?.type !== 'turn/start' || start.data.turn !== end.data.turn) return
  const meteringIndex = turn.findLastIndex(event => event.type === 'assistant/message')
  const metering = turn[meteringIndex]
  if (meteringIndex <= startIndex || metering?.type !== 'assistant/message' || metering.data.turn !== end.data.turn ||
      metering.data.interrupted || !metering.data.usage) return
  const subsequent = events.slice(meteringIndex + 1)
  if (subsequent.some(supersedesUsage)) return

  const routeEvent = events.slice(0, meteringIndex).findLast(event => event.type === 'request/context')
  const route = routeEvent?.data ?? (subsequent.some(event => event.type === 'request/context') ? undefined : session.requestContext())
  const source = metering.data.message.source
  const contextWindow = route?.contextWindow
  if (!route || source.provider !== route.provider || source.model !== route.model ||
      contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow < 1) return

  // DSH reports uncached, cache-read and cache-write input as disjoint counters.
  const { inputTokens: uncached, cacheReadTokens = 0, cacheWriteTokens = 0 } = metering.data.usage
  if (![uncached, cacheReadTokens, cacheWriteTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return
  const inputTokens = uncached + cacheReadTokens + cacheWriteTokens
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1) return
  return { turnSeq: end.seq, endedAt: end.time, inputTokens, contextWindow }
}

export async function compactIdleAgent(agent: Agent, signal: AbortSignal): Promise<NativeReceipt | null> {
  signal.throwIfAborted()
  const result = await nativeCompaction(agent)?.compactNow(agent, signal)
  if (!result) return null
  const { compactionId, shadowedTokenCount } = result
  if (typeof compactionId !== 'string' || !compactionId || !Number.isSafeInteger(shadowedTokenCount) || shadowedTokenCount < 0) {
    throw new Error('Invalid native compaction receipt')
  }
  return { compactionId, shadowedTokenCount }
}
