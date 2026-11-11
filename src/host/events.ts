import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { ActivityRecord, FeedPost, JsonValue } from '../core/model.ts'
import { MINECRAFT_SHARE_CONTEXT } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { CompanionEvent, HomeLiveView, VoiceReplyReadyEvent } from '../protocol/events.ts'
import { managementAllowed } from './security.ts'
import { deviceFeedPost } from './device-feed.ts'

export interface EventHubOptions {
  path?: string
  authorize?: (req: IncomingMessage) => boolean
  onConnection?: (socket: WebSocket, req: IncomingMessage) => void
  contextAllowed?: (contextId: string | undefined) => boolean
  projectActivity?: (activity: ActivityRecord) => ActivityRecord | undefined
  homeLive?: () => HomeLiveView
}

export class EventHub {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly sockets = new Set<WebSocket>()
  private readonly homeSockets = new Set<WebSocket>()
  private lastHomeKey?: string
  private unregister?: () => void
  private timer?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout
  private lastActivityId = 0

  constructor(private readonly ctx: Context, private readonly store: CompanionStore, private readonly options: EventHubOptions = {}) {}

  start(): void {
    this.lastActivityId = this.store.latestActivityId()
    this.unregister = this.ctx.webServer.registerUpgrade({
      path: this.options.path ?? '/companion/api/events',
      handler: (req, socket, head) => {
        const allowed = this.options.authorize?.(req) ?? managementAllowed(this.ctx, req)
        const query = new URL(req.url ?? '/', this.ctx.webServer.getOrigin()).searchParams
        const contextId = query.get('contextId') ?? undefined
        const home = query.get('view') === 'home'
        if (!allowed || !this.contextAllowed(contextId) || home && (!this.options.homeLive || query.has('contextId') || query.has('cursor'))) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        this.wss.handleUpgrade(req, socket, head, websocket => {
          if (home) this.homeConnection(websocket, req)
          else this.connection(websocket, req)
        })
      },
    })
    this.timer = setInterval(() => {
      this.flushActivities()
      this.flushHome()
    }, 250)
    this.heartbeat = setInterval(() => {
      const event: CompanionEvent = { eventId: randomUUID(), schemaVersion: 1, type: 'ping', occurredAt: new Date().toISOString(), cursor: null, payload: {} }
      for (const socket of this.sockets) this.send(socket, event)
      this.flushHome(true)
    }, 10_000)
  }

  private homeConnection(socket: WebSocket, req: IncomingMessage): void {
    this.options.onConnection?.(socket, req)
    this.homeSockets.add(socket)
    socket.on('close', () => {
      this.homeSockets.delete(socket)
      if (!this.homeSockets.size) this.lastHomeKey = undefined
    })
    socket.on('message', () => socket.close(1008, 'Read-only home stream'))
    this.flushHome(true, socket)
  }

  private flushHome(heartbeat = false, only?: WebSocket): void {
    if (!this.homeSockets.size || !this.options.homeLive) return
    let state: HomeLiveView
    try { state = this.options.homeLive() }
    catch { return } // An unavailable observation must not replace the last confirmed state.
    const { observedAt, ...status } = state
    const key = JSON.stringify(status)
    if (!heartbeat && key === this.lastHomeKey) return
    if (!only || this.homeSockets.size === 1) this.lastHomeKey = key
    const event: CompanionEvent = { eventId: randomUUID(), schemaVersion: 1, type: 'home.live', occurredAt: observedAt, cursor: null,
      payload: state as unknown as Record<string, JsonValue> }
    for (const socket of only ? [only] : this.homeSockets) {
      if (socket.bufferedAmount < 65_536) this.send(socket, event)
    }
  }

  private connection(socket: WebSocket, req: IncomingMessage): void {
    this.options.onConnection?.(socket, req)
    const requestUrl = req.url ?? '/'
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('message', data => {
      try {
        const input = JSON.parse(String(data)) as { contextId?: string; cursor?: number }
        this.replay(socket, input.contextId, input.cursor ?? 0)
      } catch {
        this.send(socket, { eventId: randomUUID(), schemaVersion: 1, type: 'message.failed', occurredAt: new Date().toISOString(), cursor: null, payload: { error: 'Invalid subscription message' } })
      }
    })
    const url = new URL(requestUrl, this.ctx.webServer.getOrigin())
    const contextId = url.searchParams.get('contextId') ?? undefined
    const cursor = Number(url.searchParams.get('cursor') ?? 0)
    ;(socket as WebSocket & { companionContextId?: string }).companionContextId = contextId
    this.send(socket, { eventId: randomUUID(), schemaVersion: 1, type: 'stream.ready', occurredAt: new Date().toISOString(), cursor: String(this.lastActivityId), payload: { contextId: contextId ?? null } })
    this.replay(socket, contextId, cursor)
  }

  private replay(socket: WebSocket, contextId: string | undefined, cursor: number): void {
    if (!this.contextAllowed(contextId)) throw new Error('Context unavailable')
    ;(socket as WebSocket & { companionContextId?: string }).companionContextId = contextId
    const activities = this.store.activitiesAfter(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, 1000, contextId)
      .map(activity => this.projectActivity(activity))
      .filter((activity): activity is ActivityRecord => activity !== undefined && this.contextAllowed(activity.contextId))
    for (const activity of activities) this.send(socket, this.activityEvent(activity))
    this.send(socket, {
      eventId: randomUUID(),
      schemaVersion: 1,
      type: 'stream.replay.complete',
      occurredAt: new Date().toISOString(),
      contextId,
      cursor: String(this.lastActivityId),
      payload: { count: activities.length },
    })
  }

  private flushActivities(): void {
    const activities = this.store.activitiesAfter(this.lastActivityId)
    for (const activity of activities) {
      this.lastActivityId = Math.max(this.lastActivityId, activity.id)
      const projected = this.projectActivity(activity)
      if (projected) this.broadcast(this.activityEvent(projected))
    }
  }

  private projectActivity(activity: ActivityRecord): ActivityRecord | undefined {
    return this.options.projectActivity ? this.options.projectActivity(activity) : activity
  }

  private activityEvent(activity: ActivityRecord): CompanionEvent {
    return {
      eventId: `activity:${activity.id}`,
      schemaVersion: 1,
      type: activity.kind === 'turn.error' ? 'message.failed' : 'activity',
      occurredAt: activity.occurredAt,
      contextId: activity.contextId,
      sessionId: activity.sessionId,
      cursor: String(activity.id),
      payload: activity as unknown as Record<string, JsonValue>,
    }
  }

  assistantStream({ agent, frame }: { agent: Agent; frame: AssistantStreamFrame }): void {
    const binding = this.store.bindingBySession(agent.id)
    if (!binding) return
    const base = {
      schemaVersion: 1 as const,
      type: 'message.delta' as const,
      occurredAt: new Date().toISOString(),
      contextId: binding.contextId,
      sessionId: agent.id,
      cursor: null,
    }
    if (frame.type === 'start') {
      this.broadcast({ ...base, eventId: `stream:${agent.id}:${frame.attemptId}:${frame.revision}:start`, payload: { phase: 'start', attemptId: frame.attemptId, revision: frame.revision, turn: frame.turn, step: frame.step } })
      return
    }
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      this.broadcast({ ...base, eventId: `stream:${agent.id}:${frame.attemptId}:${frame.revision}:${frame.index}`, payload: { phase: 'chunk', attemptId: frame.attemptId, revision: frame.revision, index: frame.index, text: frame.chunk.text } })
      return
    }
    if (frame.type === 'end') {
      this.broadcast({ ...base, eventId: `stream:${agent.id}:${frame.attemptId}:${frame.revision}:end`, payload: { phase: 'end', attemptId: frame.attemptId, revision: frame.revision, outcome: frame.outcome } })
    }
  }

  assistantMessage(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    const binding = this.store.bindingBySession(sessionId)
    if (!binding) return
    const data = event.data
    this.broadcast({
      eventId: `message:${sessionId}:${event.seq}`,
      schemaVersion: 1,
      type: 'message.completed',
      occurredAt: new Date(event.time).toISOString(),
      contextId: binding.contextId,
      sessionId,
      cursor: null,
      payload: {
        messageId: data.message.id,
        turn: data.turn,
        step: data.step,
        text: data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        interrupted: data.interrupted === true,
        usage: data.usage ? {
          inputTokens: data.usage.inputTokens,
          outputTokens: data.usage.outputTokens,
          totalTokens: data.usage.totalTokens ?? null,
          cacheReadTokens: data.usage.cacheReadTokens ?? null,
          cacheWriteTokens: data.usage.cacheWriteTokens ?? null,
          reasoningTokens: data.usage.reasoningTokens ?? null,
        } : null,
      },
    })
  }

  postChanged(type: 'post.created' | 'post.deleted', post: FeedPost): void {
    const sharedReading = post.author === 'companion' && !post.parentId && !!post.bilibiliSource
    const sharedMinecraft = post.author === 'companion' && !post.parentId && post.contextId === MINECRAFT_SHARE_CONTEXT
    const visible = this.options.path === '/companion-device/api/events' ? deviceFeedPost(post) : post
    this.broadcast({
      eventId: randomUUID(),
      schemaVersion: 1,
      type,
      occurredAt: new Date().toISOString(),
      contextId: visible.contextId,
      sessionId: visible.sourceSessionId,
      cursor: null,
      payload: { post: visible as unknown as JsonValue },
    }, sharedReading || sharedMinecraft)
  }

  captureVoiceReply(event: VoiceReplyReadyEvent): (() => void) | undefined {
    if (this.options.path !== '/companion-device/api/events' || !this.contextAllowed(event.contextId)) return
    const recipients = [...this.sockets].filter(socket => socket.readyState === WebSocket.OPEN && this.subscribed(socket, event.contextId))
    if (!recipients.length) return
    return () => {
      for (const socket of recipients) {
        if (this.sockets.has(socket) && this.subscribed(socket, event.contextId)) this.send(socket, event)
      }
    }
  }

  private subscribed(socket: WebSocket, eventContext?: string): boolean {
    const contextId = (socket as WebSocket & { companionContextId?: string }).companionContextId
    return !contextId || contextId === eventContext
  }

  private contextAllowed(contextId: string | undefined): boolean {
    return this.options.contextAllowed?.(contextId) !== false
  }

  private broadcast(event: CompanionEvent, publicPost = false): void {
    if (!publicPost && !this.contextAllowed(event.contextId)) return
    for (const socket of this.sockets) {
      if (this.subscribed(socket, event.contextId)) this.send(socket, event)
    }
  }

  private send(socket: WebSocket, event: CompanionEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.unregister?.()
    for (const socket of this.sockets) socket.terminate()
    for (const socket of this.homeSockets) socket.terminate()
    this.sockets.clear()
    this.homeSockets.clear()
    this.wss.close()
  }
}
