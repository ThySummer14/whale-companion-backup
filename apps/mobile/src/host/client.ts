import * as SecureStore from 'expo-secure-store'
import { AppState, Platform } from 'react-native'
import type { ChatMessage, CompanionEvent, FeedList, FeedPost, FeedThread, PairResult, TtsTask, WorkbenchView } from './types.ts'

const HOST_KEY = 'companion.host.v1'
const webStorage = {
  get: (key: string) => localStorage.getItem(key),
  set: (key: string, value: string) => localStorage.setItem(key, value),
  clear: (key: string) => localStorage.removeItem(key),
}
const storage = Platform.OS === 'web' ? webStorage : {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  clear: (key: string) => SecureStore.deleteItemAsync(key),
}

export interface SavedHost extends PairResult {
  baseUrl: string
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/')
  if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/u.test(base64)) throw new Error('invalid-base64url')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let buffer = 0
  let bits = 0
  let bytes = ''
  for (const char of base64) {
    buffer = (buffer << 6) | alphabet.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes += `%${((buffer >> bits) & 0xff).toString(16).padStart(2, '0')}`
    }
  }
  return decodeURIComponent(bytes)
}

export class CompanionClient {
  constructor(readonly baseUrl: string, readonly credential: string) {}

  static async load(): Promise<SavedHost | null> {
    const value = await storage.get(HOST_KEY)
    return value ? JSON.parse(value) as SavedHost : null
  }

  static async pair(link: string): Promise<SavedHost> {
    const trimmed = link.trim()
    if (!trimmed) throw new Error('请粘贴一次性配对链接')
    let routes: string[]
    try {
      const match = /^companion:\/\/pair\?p=([A-Za-z0-9_-]+)$/u.exec(trimmed)
      const encoded = trimmed.startsWith('companion://') ? match?.[1] : trimmed
      if (!encoded) throw new Error('invalid-pair-link')
      const payload = JSON.parse(base64UrlDecode(encoded)) as { routes?: unknown }
      if (!Array.isArray(payload.routes) || !payload.routes.length || payload.routes.length > 4) throw new Error('invalid-routes')
      routes = payload.routes.map(route => {
        if (typeof route !== 'string') throw new Error('invalid-routes')
        const url = new URL(route)
        const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('invalid-routes')
        return url.origin
      })
    } catch {
      throw new Error('配对链接无效，请重新生成')
    }
    let lastError: unknown
    for (const route of routes) {
      try {
        const response = await fetch(`${route}/companion-device/api/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ p: trimmed }),
        })
        const value = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) throw new Error(value.error || `配对失败（${response.status}）`)
        const result = value as PairResult
        const saved = { ...result, baseUrl: route }
        await storage.set(HOST_KEY, JSON.stringify(saved))
        return saved
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('所有候选地址都无法完成配对')
  }

  static async unpair(): Promise<void> {
    await storage.clear(HOST_KEY)
  }

  private async request<T>(path: string, method = 'GET', input?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/companion-device/api/${path}`, {
        method,
        headers: { authorization: this.credential, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: controller.signal,
      })
      const value = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new CompanionRequestError(response.status, value.error || `请求失败（${response.status}）`)
      return value as T
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  getState() {
    return this.request<WorkbenchView>('state')
  }

  createSession(input: { contextId: string; sessionId?: string; resume: boolean; kind: 'chat' | 'game' | 'task' | 'topic' | 'system'; label: string }) {
    return this.request('sessions', 'POST', input)
  }

  send(contextId: string, text: string) {
    return this.request<{ accepted: true; contextId: string; sessionId: string; messageId: string }>('messages', 'POST', { contextId, text })
  }

  cancel(contextId: string) {
    return this.request('messages/cancel', 'POST', { contextId })
  }

  history(contextId: string) {
    return this.request<{ contextId: string; sessionId: string; messages: ChatMessage[] }>(`messages/history?contextId=${encodeURIComponent(contextId)}&limit=100`)
  }

  getFeed(cursor?: string) {
    return this.request<FeedList>(`feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
  }

  getFeedThread(id: string) {
    return this.request<FeedThread>(`feed/${encodeURIComponent(id)}`)
  }

  createFeedPost(body: string, parentId?: string, mediaId?: string) {
    return this.request<FeedPost>(parentId ? `feed/${encodeURIComponent(parentId)}/replies` : 'feed', 'POST', { body, mediaId })
  }

  uploadImage({ mimeType, dataBase64 }: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string }) {
    return this.request<{ id: string }>('media', 'POST', { mimeType, dataBase64 }, 60_000)
  }

  mediaSource(mediaId: string): { uri: string; headers: Record<string, string> } {
    return { uri: `${this.baseUrl}/companion-device/api/media/${encodeURIComponent(mediaId)}`, headers: { authorization: this.credential } }
  }

  deleteFeedPost(id: string) {
    return this.request<FeedPost>(`feed/${encodeURIComponent(id)}`, 'DELETE')
  }

  synthesizeMessage(contextId: string, messageId: string, signal?: AbortSignal) {
    return this.request<TtsTask>(`messages/${encodeURIComponent(messageId)}/tts`, 'POST', { contextId }, 30_000, signal)
  }

  ttsTask(id: string, signal?: AbortSignal) {
    return this.request<TtsTask>(`tts/${encodeURIComponent(id)}`, 'GET', undefined, 10_000, signal)
  }

  audioSource(taskId: string): { uri: string; headers: Record<string, string> } {
    return { uri: `${this.baseUrl}/companion-device/api/tts/${encodeURIComponent(taskId)}/audio`, headers: { authorization: this.credential } }
  }

  subscribe(contextId: string, cursor: string, handlers: {
    event: (event: CompanionEvent) => void
    status: (status: 'connected' | 'reconnecting' | 'offline' | 'revoked') => void
  }): () => void {
    let disposed = false
    let revoked = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | undefined
    let lastFrameAt = Date.now()
    let generation = 0
    let retryAttempt = 0
    const base = this.baseUrl.replace(/^http/, 'ws')
    const reconnect = () => {
      if (disposed || revoked) return
      handlers.status('reconnecting')
      if (retry) clearTimeout(retry)
      const delay = Math.min(15_000, 1000 * 2 ** retryAttempt)
      retryAttempt = Math.min(retryAttempt + 1, 4)
      retry = setTimeout(connect, delay)
    }
    const watchdog = setInterval(() => {
      if (!disposed && !revoked && socket?.readyState === WebSocket.OPEN && Date.now() - lastFrameAt > 25_000) {
        handlers.status('offline')
        socket.close()
      }
    }, 5000)
    const connect = () => {
      if (disposed || revoked) return
      if (retry) clearTimeout(retry)
      retry = undefined
      const current = ++generation
      socket?.close()
      handlers.status('reconnecting')
      const CompanionSocket = WebSocket as unknown as new (url: string, protocols: string[], options: { headers: Record<string, string> }) => WebSocket
      const candidate = new CompanionSocket(`${base}/companion-device/api/events?contextId=${encodeURIComponent(contextId)}&cursor=${encodeURIComponent(cursor)}`, [], {
        headers: { authorization: this.credential },
      })
      socket = candidate
      candidate.onopen = () => {
        if (current !== generation || disposed || revoked) {
          candidate.close()
          return
        }
        retryAttempt = 0
        lastFrameAt = Date.now()
        handlers.status('connected')
      }
      candidate.onmessage = event => {
        if (current !== generation || disposed || revoked) return
        lastFrameAt = Date.now()
        try { handlers.event(JSON.parse(String(event.data)) as CompanionEvent) } catch { /* Ignore malformed frames. */ }
      }
      candidate.onclose = () => {
        if (current !== generation || disposed || revoked) return
        handlers.status('reconnecting')
        void this.request('health', 'GET', undefined, 10_000).then(() => {
          if (current === generation && !disposed && !revoked) reconnect()
        }).catch((error: unknown) => {
          if (current !== generation || disposed || revoked) return
          if (error instanceof CompanionRequestError && error.status === 401) {
            revoked = true
            if (retry) clearTimeout(retry)
            clearInterval(watchdog)
            handlers.status('revoked')
          } else reconnect()
        })
      }
    }
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state !== 'active' || disposed || revoked || socket?.readyState === WebSocket.OPEN) return
      if (retry) clearTimeout(retry)
      retryAttempt = 0
      connect()
    })
    connect()
    return () => {
      disposed = true
      generation++
      clearInterval(watchdog)
      appStateSubscription.remove()
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }
}

class CompanionRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
