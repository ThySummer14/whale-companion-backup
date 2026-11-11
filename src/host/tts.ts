import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import type { TaskRecord, TtsAsset, TtsTaskView } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import { EXPRESSIVE_TTS_MAX_CHARS, EXPRESSIVE_TTS_STYLES, type ExpressiveTtsStyle, type WorkbenchView } from '../protocol/api.ts'
import type { SessionService } from './session.ts'
import { DeviceAuthError } from './devices.ts'
import { GptSovitsProvider, type GptSovitsOptions } from './tts-provider.ts'

export interface TtsOptions {
  provider: 'piper' | 'gpt-sovits'
  pythonPath: string
  modelPath: string
  mediaDir: string
  timeoutMs: number
  gpt?: GptSovitsOptions
  expressive?: { pythonPath: string; modelDir: string; timeoutMs: number }
}

interface SpeechRequest {
  task: TaskRecord
  contextId: string
  messageId: string
  text: string
  style?: ExpressiveTtsStyle
}

const EXPRESSIVE_FILES = ['config.yaml', 'config.json', 'gpt.safetensors', 's2mel.safetensors',
  'bigvgan.safetensors', 'vq2emb.safetensors', 'tokenizer.model', 'feat1.pt', 'feat2.pt',
  'wav2vec2bert_stats.pt', 'speaker.npz']
const EXPRESSIVE_RATE = 22_050
const EXPRESSIVE_MAX_FRAMES = EXPRESSIVE_RATE * 180

export class TtsService {
  private readonly pending: SpeechRequest[] = []
  private readonly voice: string
  private readonly workerPath = fileURLToPath(new URL('./tts-worker.py', import.meta.url))
  private readonly gpt?: GptSovitsProvider
  private available = false
  private closing = false
  private draining = false
  private current?: SpeechRequest
  private cancelCurrent?: () => void
  private probing?: Promise<boolean>

  constructor(private readonly store: CompanionStore, private readonly sessions: SessionService, private readonly options: TtsOptions) {
    this.voice = options.provider === 'gpt-sovits' ? 'deepseek-whale-v5turbo' : basename(options.modelPath, '.onnx')
    if (options.provider === 'gpt-sovits') {
      if (!options.gpt) throw new Error('GPT-SoVITS provider configuration is required')
      this.gpt = new GptSovitsProvider(options.gpt)
    }
  }

  start(): void {
    mkdirSync(this.options.mediaDir, { recursive: true, mode: 0o700 })
    chmodSync(this.options.mediaDir, 0o700)
    if (this.gpt) {
      this.store.updateCapability('media.tts', 'unavailable', '正在连接本地 GPT-SoVITS 服务')
      void this.checkProvider()
    } else {
      this.available = existsSync(this.options.pythonPath) && existsSync(this.options.modelPath) && existsSync(`${this.options.modelPath}.json`)
      this.store.updateCapability('media.tts', this.available ? 'ready' : 'unavailable', this.available
        ? `本地 Piper · ${this.voice} · 点击助手消息合成`
        : '本地 Piper 或中文声线尚未安装')
    }
    for (const task of this.store.tasks().filter(task => task.capabilityId === 'media.tts' && ['accepted', 'running'].includes(task.status))) {
      this.store.transitionTask(task.id, 'failed', '语音服务已重启，请重新合成')
    }
  }

  private checkProvider(): Promise<boolean> {
    if (!this.gpt) return Promise.resolve(this.available)
    if (this.closing) return Promise.resolve(false)
    this.probing ??= this.gpt.health().then(available => {
      this.available = available
      if (!this.closing) {
        this.store.updateCapability('media.tts', available ? 'ready' : 'unavailable', available
          ? '本地 GPT-SoVITS v5 turbo · 大肥鱼声线'
          : '本地 GPT-SoVITS 服务未就绪')
      }
      return available
    }).catch(() => false).finally(() => { this.probing = undefined })
    return this.probing
  }

  private expressiveIdentity(): string | undefined {
    const config = this.options.expressive
    if (!config || this.closing) return
    const paths = [config.pythonPath, ...EXPRESSIVE_FILES.map(name => join(config.modelDir, name))]
    const hash = createHash('sha256')
    try {
      for (const path of paths) {
        const info = statSync(path)
        if (!info.isFile() || !info.size) return
        hash.update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}\0`)
      }
    } catch {
      return
    }
    return hash.digest('hex')
  }

  expressiveCapability(): WorkbenchView['expressiveTts'] {
    if (this.expressiveIdentity()) {
      return { version: 1, styles: EXPRESSIVE_TTS_STYLES, maxChars: EXPRESSIVE_TTS_MAX_CHARS }
    }
  }

  async synthesizeMessage(contextId: string, messageId: string, style?: ExpressiveTtsStyle): Promise<TtsTaskView> {
    if (!style && !this.available && !(await this.checkProvider())) throw new DeviceAuthError(503, 'tts-unavailable')
    if (this.closing) throw new DeviceAuthError(503, 'tts-stopping')
    const history = await this.sessions.history(contextId, 200)
    if (this.closing) throw new DeviceAuthError(503, 'tts-stopping')
    const message = history.messages.find(message => message.id === messageId)
    if (!message || message.role !== 'assistant' || !message.text.trim()) throw new DeviceAuthError(404, 'assistant-message-not-found')
    if (message.text.length > (style ? EXPRESSIVE_TTS_MAX_CHARS : 1500)) throw new DeviceAuthError(400, 'message-too-long-for-tts')
    const identity = style && this.expressiveIdentity()
    if (style && !identity) throw new DeviceAuthError(503, 'expressive-tts-unavailable')
    const keyParts = style ? ['indextts2:1', contextId, history.sessionId, messageId, message.text, style, identity] : [contextId, messageId, this.voice]
    const cacheKey = createHash('sha256').update(keyParts.join('\0')).digest('hex')
    const prefix = `tts-expression:${cacheKey}:`
    const cached = style ? this.store.latestTaskByExternalPrefix(prefix) : this.store.taskByExternalId(`tts:${cacheKey}`)
    if (cached) {
      if (cached.status === 'succeeded' && this.audioExists(cached.id)) return this.view(cached)
      if (cached.status === 'accepted' || cached.status === 'running') return this.view(cached)
    }
    if (this.pending.length + (this.current ? 1 : 0) >= 4) throw new DeviceAuthError(429, 'tts-queue-full')
    const task = this.store.createTask({
      externalId: style ? `${prefix}${randomUUID()}` : cached ? undefined : `tts:${cacheKey}`,
      capabilityId: 'media.tts',
      contextId,
      sessionId: history.sessionId,
      title: style ? '合成一条助手情绪语音' : '合成一条助手语音',
    })
    this.pending.push({ task, contextId, messageId, text: message.text, style })
    void this.drain()
    return this.view(task)
  }

  async synthesizeClip(contextId: string, messageId: string, text: string): Promise<TtsTaskView> {
    if (!this.available && !(await this.checkProvider())) throw new DeviceAuthError(503, 'tts-unavailable')
    if (this.closing) throw new DeviceAuthError(503, 'tts-stopping')
    const content = text.trim()
    if (!content || content.length > 240) throw new DeviceAuthError(400, 'invalid-realtime-segment')
    const cacheKey = createHash('sha256').update(`${contextId}\0${messageId}\0${content}\0${this.voice}`).digest('hex')
    const cached = this.store.taskByExternalId(`tts-segment:${cacheKey}`)
    if (cached) {
      if (cached.status === 'succeeded' && this.audioExists(cached.id)) return this.view(cached)
      if (cached.status === 'accepted' || cached.status === 'running') return this.view(cached)
    }
    if (this.pending.length + (this.current ? 1 : 0) >= 4) throw new DeviceAuthError(429, 'tts-queue-full')
    const task = this.store.createTask({
      externalId: cached ? undefined : `tts-segment:${cacheKey}`,
      capabilityId: 'media.tts', contextId,
      title: '合成一段实时语音',
    })
    this.pending.push({ task, contextId, messageId, text: content })
    void this.drain()
    return this.view(task)
  }

  get(taskId: string): TtsTaskView {
    const task = this.store.taskById(taskId)
    if (!task || task.capabilityId !== 'media.tts') throw new DeviceAuthError(404, 'tts-not-found')
    return this.view(task)
  }

  cancelExpressive(taskId: string): boolean {
    if (this.current?.task.id === taskId && this.current.style && this.get(taskId).status === 'running') {
      this.store.transitionTask(taskId, 'cancelled', '已取消情绪语音合成')
      this.cancelCurrent?.()
      return true
    }
    const index = this.pending.findIndex(request => request.task.id === taskId && request.style)
    if (index < 0) return false
    this.pending.splice(index, 1)
    this.store.transitionTask(taskId, 'cancelled', '已取消情绪语音合成')
    return true
  }

  async audio(taskId: string): Promise<TtsAsset> {
    this.get(taskId)
    const asset = this.store.ttsAssetByTask(taskId)
    if (!asset || dirnameSafe(asset.filePath, this.options.mediaDir) === false || !asset.filePath.endsWith('.wav')) throw new DeviceAuthError(404, 'audio-not-found')
    const info = await stat(asset.filePath).catch(() => undefined)
    if (!info?.isFile() || info.size !== asset.bytes) throw new DeviceAuthError(404, 'audio-not-found')
    return asset
  }

  private view(task: TaskRecord): TtsTaskView {
    const asset = this.store.ttsAssetByTask(task.id)
    return {
      ...task,
      ...(task.status === 'succeeded' && asset ? { audio: { id: asset.id, mimeType: asset.mimeType, bytes: asset.bytes, durationMs: asset.durationMs } } : {}),
    }
  }

  private audioExists(taskId: string): boolean {
    const asset = this.store.ttsAssetByTask(taskId)
    return asset !== undefined && dirnameSafe(asset.filePath, this.options.mediaDir) && existsSync(asset.filePath)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.closing && this.pending.length) {
        this.current = this.pending.shift()!
        await this.run(this.current)
      }
    } finally {
      this.draining = false
      this.current = undefined
    }
  }

  private async run(request: SpeechRequest): Promise<void> {
    const { task, contextId, messageId, text, style } = request
    if (this.store.taskById(task.id)?.status !== 'accepted') return
    this.store.transitionTask(task.id, 'running')
    const temporaryPath = join(this.options.mediaDir, `${task.id}.pending.wav`)
    const finalPath = join(this.options.mediaDir, `${task.id}.wav`)
    try {
      const result = await this.execute(text, temporaryPath, style)
      const info = await stat(finalPath)
      if (!info.isFile() || info.size !== result.bytes || info.size > 52_428_800) throw new Error('Invalid WAV output')
      if (style) {
        if (info.size > EXPRESSIVE_MAX_FRAMES * 2 + 1024 ||
          !validExpressiveWav(await readFile(finalPath), result.durationMs)) throw new Error('Invalid expressive WAV output')
        if (this.closing || this.store.taskById(task.id)?.status !== 'running') throw new Error('TTS cancelled')
      } else {
        const file = await open(finalPath, 'r')
        const header = Buffer.alloc(12)
        try { await file.read(header, 0, 12, 0) } finally { await file.close() }
        if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV output')
      }
      this.store.transitionTask(task.id, 'succeeded', undefined, () => this.store.createTtsAsset({
        id: randomUUID(),
        taskId: task.id,
        contextId,
        sourceMessageId: messageId,
        voice: style ? `indextts2-${style}` : this.voice,
        textHash: createHash('sha256').update(text).digest('hex'),
        filePath: finalPath,
        mimeType: 'audio/wav',
        bytes: result.bytes,
        durationMs: result.durationMs,
        createdAt: new Date().toISOString(),
      }))
    } catch {
      await rm(finalPath, { force: true }).catch(() => {})
      if (!style && this.gpt && !this.closing) {
        this.available = false
        this.store.updateCapability('media.tts', 'error', '本地 GPT-SoVITS 服务暂不可用')
      }
      const current = this.store.taskById(task.id)
      if (current?.status === 'running') {
        this.store.transitionTask(task.id, this.closing ? 'cancelled' : 'failed', this.closing ? '语音服务已停止' : '本地语音合成失败，请重试')
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private async execute(text: string, temporaryPath: string, style?: ExpressiveTtsStyle): Promise<{ durationMs: number; bytes: number }> {
    if (!style && this.gpt) {
      const controller = new AbortController()
      this.cancelCurrent = () => controller.abort()
      try {
        const result = await this.gpt.synthesize(text, temporaryPath, controller.signal)
        await rename(temporaryPath, finalPathFromTemporary(temporaryPath))
        const info = await stat(finalPathFromTemporary(temporaryPath))
        return { durationMs: result.durationMs, bytes: info.size }
      } finally {
        this.cancelCurrent = undefined
      }
    }
    const expressive = style ? this.options.expressive : undefined
    if (style && !expressive) throw new Error('Expressive TTS is unavailable')
    const worker = expressive
      ? join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'scripts', 'run-indextts2-tts.py')
      : this.workerPath
    const args = expressive
      ? ['--model-dir', expressive.modelDir, '--style', style!]
      : ['--model', this.options.modelPath]
    const child = spawn(expressive?.pythonPath ?? this.options.pythonPath, [worker, ...args, '--output', temporaryPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }, expressive?.timeoutMs ?? this.options.timeoutMs)
    const operation = new Promise<{ durationMs: number; bytes: number }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        clearTimeout(timeout)
        if (forceTimer) clearTimeout(forceTimer)
        this.cancelCurrent = undefined
        if (timedOut || cancelled || code !== 0) {
          reject(new Error(timedOut ? 'TTS timed out' : cancelled ? 'TTS cancelled' : `TTS exited ${code}: ${stderr.slice(-500)}`))
          return
        }
        try {
          const value = JSON.parse(stdout) as { durationMs?: unknown; bytes?: unknown }
          if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || typeof value.bytes !== 'number') throw new Error('Invalid worker result')
          resolve({ durationMs: value.durationMs, bytes: value.bytes })
        } catch (error) { reject(error) }
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-8192) })
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
      child.stdin.on('error', () => child.kill('SIGTERM'))
      child.stdin.end(JSON.stringify({ text }))
    })
    this.cancelCurrent = () => {
      cancelled = true
      child.kill('SIGTERM')
      if (!forceTimer) forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    try {
      const result = await operation
      await rename(temporaryPath, finalPathFromTemporary(temporaryPath))
      const info = await stat(finalPathFromTemporary(temporaryPath))
      return { durationMs: result.durationMs, bytes: style ? result.bytes : info.size }
    } finally {
      this.cancelCurrent = undefined
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    for (const request of this.pending.splice(0)) this.store.transitionTask(request.task.id, 'cancelled', '语音服务已停止')
    this.cancelCurrent?.()
    while (this.draining) await new Promise(resolve => setTimeout(resolve, 20))
    await this.probing
  }
}

function validExpressiveWav(wav: Buffer, durationMs: number): boolean {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) !== wav.length - 8) return false
  // The worker emits one canonical PCM header followed by its sample data.
  if (wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== EXPRESSIVE_RATE ||
    wav.readUInt32LE(28) !== EXPRESSIVE_RATE * 2 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data') return false
  const bytes = wav.readUInt32LE(40)
  if (bytes !== wav.length - 44 || bytes % 2 || bytes > EXPRESSIVE_MAX_FRAMES * 2 ||
    Math.round(bytes / 2 / EXPRESSIVE_RATE * 1000) !== durationMs) return false
  for (let index = 44; index < wav.length; index += 2) {
    if (Math.abs(wav.readInt16LE(index)) >= 327) return true
  }
  return false
}

function finalPathFromTemporary(path: string): string {
  return path.replace(/\.pending\.wav$/u, '.wav')
}

function dirnameSafe(filePath: string, directory: string): boolean {
  return filePath.startsWith(`${directory}/`) && !filePath.slice(directory.length + 1).includes('/')
}
